import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

import { projectDashboard } from "./dashboard/projection.js";
import { replayDemoSteps } from "./demo/scenario.js";

const STATIC_FILES = new Map([
  [
    "/",
    {
      url: new URL("../public/index.html", import.meta.url),
      contentType: "text/html; charset=utf-8"
    }
  ],
  [
    "/app.js",
    {
      url: new URL("../public/app.js", import.meta.url),
      contentType: "text/javascript; charset=utf-8"
    }
  ],
  [
    "/dashboard-state.js",
    {
      url: new URL("../public/dashboard-state.js", import.meta.url),
      contentType: "text/javascript; charset=utf-8"
    }
  ],
  [
    "/styles.css",
    {
      url: new URL("../public/styles.css", import.meta.url),
      contentType: "text/css; charset=utf-8"
    }
  ]
]);

export function createTaskSealServer({
  steps,
  initialStep = 1,
  service,
  runWorkItem
}) {
  const persistent = service !== undefined;

  if (persistent && steps !== undefined) {
    throw new TypeError(
      "TaskSeal server cannot use demo and persistent state together."
    );
  }

  if (
    persistent &&
    (typeof service?.snapshot !== "function" ||
      typeof service?.getWorkItem !== "function" ||
      typeof runWorkItem !== "function")
  ) {
    throw new TypeError(
      "Persistent TaskSeal server requires a service and runWorkItem."
    );
  }

  if (!persistent && !Array.isArray(steps)) {
    throw new TypeError("Demo TaskSeal server requires steps.");
  }

  let currentStep = persistent
    ? 0
    : clampStep(initialStep, steps.length);
  const activeRuns = new Map();
  const lastErrors = new Map();
  const csrfToken = persistent
    ? randomBytes(32).toString("base64url")
    : null;
  let acceptingRuns = true;
  let shutdownPromise = null;

  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;

      if (request.method === "GET" && pathname === "/health") {
        return writeJson(response, 200, { status: "ok" });
      }

      if (request.method === "GET" && pathname === "/api/dashboard") {
        return writeJson(
          response,
          200,
          persistent
            ? buildPersistentSnapshot(
                service,
                activeRuns,
                lastErrors,
                csrfToken
              )
            : buildDemoSnapshot(steps, currentStep)
        );
      }

      const runMatch =
        persistent &&
        request.method === "POST" &&
        /^\/api\/work-items\/([^/]+)\/run$/.exec(pathname);

      if (runMatch) {
        if (!acceptingRuns) {
          throw new HttpError(
            503,
            "SERVER_SHUTTING_DOWN",
            "TaskSeal is shutting down and cannot accept new runs."
          );
        }

        validatePersistentWriteRequest(request, csrfToken);
        const workItemId = decodePathSegment(runMatch[1]);
        const workItem = service.getWorkItem(workItemId);

        if (!workItem) {
          throw new HttpError(
            404,
            "WORK_ITEM_NOT_FOUND",
            `TaskSeal work item ${workItemId} does not exist.`
          );
        }

        const body = await readJsonBody(request);
        validateRunBody(body);

        if (!acceptingRuns) {
          throw new HttpError(
            503,
            "SERVER_SHUTTING_DOWN",
            "TaskSeal is shutting down and cannot accept new runs."
          );
        }

        if (activeRuns.has(workItemId)) {
          throw new HttpError(
            409,
            "ATTEMPT_ALREADY_ACTIVE",
            `TaskSeal work item ${workItemId} already has an active run.`
          );
        }

        lastErrors.delete(workItemId);
        const controller = new AbortController();
        const entry = {
          controller,
          execution: null
        };
        activeRuns.set(workItemId, entry);
        let execution;

        try {
          execution = Promise.resolve(
            runWorkItem({
              workItemId,
              prompt: body.prompt,
              sandbox:
                body.readOnly === false
                  ? "workspace-write"
                  : "read-only",
              signal: controller.signal
            })
          );
        } catch (error) {
          activeRuns.delete(workItemId);
          throw error;
        }

        entry.execution = execution;
        execution
          .catch((error) => {
            lastErrors.set(workItemId, {
              code: error?.code ?? "RUNNER_FAILED",
              message: boundedMessage(error),
              recordedAt: new Date().toISOString()
            });
          })
          .finally(() => {
            if (activeRuns.get(workItemId) === entry) {
              activeRuns.delete(workItemId);
            }
          });

        return writeJson(
          response,
          202,
          buildPersistentSnapshot(
            service,
            activeRuns,
            lastErrors,
            csrfToken
          )
        );
      }

      if (
        !persistent &&
        request.method === "POST" &&
        pathname === "/api/demo/next"
      ) {
        const candidateStep = clampStep(currentStep + 1, steps.length);
        const snapshot = buildDemoSnapshot(steps, candidateStep);
        currentStep = candidateStep;
        return writeJson(response, 200, snapshot);
      }

      if (
        !persistent &&
        request.method === "POST" &&
        pathname === "/api/demo/run-all"
      ) {
        const candidateStep = steps.length;
        const snapshot = buildDemoSnapshot(steps, candidateStep);
        currentStep = candidateStep;
        return writeJson(response, 200, snapshot);
      }

      if (
        !persistent &&
        request.method === "POST" &&
        pathname === "/api/demo/reset"
      ) {
        const candidateStep = Math.min(1, steps.length);
        const snapshot = buildDemoSnapshot(steps, candidateStep);
        currentStep = candidateStep;
        return writeJson(response, 200, snapshot);
      }

      if (request.method === "GET" && STATIC_FILES.has(pathname)) {
        return writeStatic(response, STATIC_FILES.get(pathname));
      }

      return writeJson(response, 404, {
        error: "NOT_FOUND",
        message: "The requested resource does not exist."
      });
    } catch (error) {
      const statusCode =
        error.statusCode ??
        (error.name === "DomainError" ? 422 : 500);
      return writeJson(response, statusCode, {
        error: error.code ?? "INTERNAL_ERROR",
        message: boundedMessage(error)
      });
    }
  });

  server.shutdown = () => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      acceptingRuns = false;
      const closePromise = server.listening
        ? new Promise((resolve) => server.close(resolve))
        : Promise.resolve();
      const entries = [...activeRuns.values()];

      for (const entry of entries) {
        entry.controller.abort();
      }

      await Promise.allSettled(
        entries
          .map((entry) => entry.execution)
          .filter(Boolean)
      );

      server.closeAllConnections();
      await closePromise;
    })();

    return shutdownPromise;
  };

  return server;
}

function buildDemoSnapshot(steps, currentStep) {
  const workflow = replayDemoSteps(steps, currentStep);

  return {
    ...projectDashboard(workflow),
    mode: "demo",
    capabilities: {
      demo: true,
      runAttempt: false
    },
    demo: {
      currentStep,
      totalSteps: steps.length,
      complete: currentStep === steps.length,
      timeline: steps.map((step, index) => ({
        number: index + 1,
        source: step.source,
        label: step.label,
        completed: index < currentStep,
        active: index === currentStep - 1
      }))
    }
  };
}

function buildPersistentSnapshot(
  service,
  activeRuns,
  lastErrors,
  csrfToken
) {
  return {
    ...service.snapshot(),
    mode: "persistent",
    capabilities: {
      demo: false,
      runAttempt: true
    },
    runtime: {
      activeWorkItemIds: [...activeRuns.keys()],
      errors: Object.fromEntries(lastErrors)
    },
    security: {
      csrfToken
    }
  };
}

function clampStep(value, maximum) {
  return Math.max(0, Math.min(value, maximum));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  let exceeded = false;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > 64 * 1024) {
      exceeded = true;
      continue;
    }

    chunks.push(chunk);
  }

  if (exceeded) {
    throw new HttpError(
      413,
      "REQUEST_TOO_LARGE",
      "TaskSeal run request exceeds 64 KiB."
    );
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(
      400,
      "INVALID_JSON",
      "TaskSeal run request must contain valid JSON."
    );
  }
}

function validatePersistentWriteRequest(request, csrfToken) {
  const contentType = request.headers["content-type"] ?? "";

  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new HttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "TaskSeal run requests require application/json."
    );
  }

  const host = request.headers.host;
  let hostname;

  try {
    hostname = new URL(`http://${host}`).hostname
      .replace(/^\[|\]$/g, "")
      .toLowerCase();
  } catch {
    throw new HttpError(
      403,
      "UNTRUSTED_HOST",
      "TaskSeal only accepts loopback requests."
    );
  }

  if (
    hostname !== "127.0.0.1" &&
    hostname !== "localhost" &&
    hostname !== "::1"
  ) {
    throw new HttpError(
      403,
      "UNTRUSTED_HOST",
      "TaskSeal only accepts loopback requests."
    );
  }

  const origin = request.headers.origin;

  if (origin && origin !== `http://${host}`) {
    throw new HttpError(
      403,
      "UNTRUSTED_ORIGIN",
      "TaskSeal rejected a cross-origin run request."
    );
  }

  const fetchSite = request.headers["sec-fetch-site"];

  if (
    fetchSite &&
    fetchSite !== "same-origin" &&
    fetchSite !== "none"
  ) {
    throw new HttpError(
      403,
      "UNTRUSTED_ORIGIN",
      "TaskSeal rejected a cross-site run request."
    );
  }

  const suppliedToken = request.headers["x-taskseal-csrf-token"];

  if (!secureTokenEquals(suppliedToken, csrfToken)) {
    throw new HttpError(
      403,
      "CSRF_TOKEN_INVALID",
      "TaskSeal run request is missing its session token."
    );
  }
}

function secureTokenEquals(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }

  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function validateRunBody(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof body.prompt !== "string" ||
    body.prompt.trim().length === 0
  ) {
    throw new HttpError(
      400,
      "INVALID_RUN_REQUEST",
      "TaskSeal run request requires a non-empty prompt."
    );
  }

  if (
    body.readOnly !== undefined &&
    typeof body.readOnly !== "boolean"
  ) {
    throw new HttpError(
      400,
      "INVALID_RUN_REQUEST",
      "TaskSeal readOnly must be a boolean."
    );
  }
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(
      400,
      "INVALID_PATH",
      "TaskSeal work item id is not valid URL encoding."
    );
  }
}

function boundedMessage(error) {
  const message =
    typeof error?.message === "string" && error.message.length > 0
      ? error.message
      : "TaskSeal request failed.";
  return message.slice(0, 2_000);
}

class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

async function writeStatic(response, file) {
  const content = await readFile(file.url);
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": file.contentType
  });
  response.end(content);
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}
