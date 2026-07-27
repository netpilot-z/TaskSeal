import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type {
  IncomingMessage,
  ServerResponse
} from "node:http";

import { projectDashboard } from "./dashboard/projection.ts";
import { replayDemoSteps } from "./demo/scenario.ts";
import type {
  ProviderObservationQueryPort
} from "./application/provider-observation.ts";
import type { DashboardProjection } from "./dashboard/projection.ts";
import type { DemoStep } from "./demo/scenario.ts";

interface StaticFile {
  url: URL;
  contentType: string;
}

interface PersistentWorkItemReference {
  id: string;
}

export interface PersistentServicePort {
  snapshot(): DashboardProjection;
  getWorkItem(
    workItemId: string
  ): PersistentWorkItemReference | null;
  getHealth?(): unknown;
}

export interface RunWorkItemOptions {
  workItemId: string;
  prompt: string;
  sandbox: "read-only" | "workspace-write";
  signal: AbortSignal;
}

export type RunWorkItem = (
  options: RunWorkItemOptions
) => unknown | Promise<unknown>;

export interface DemoTaskSealServerOptions {
  steps: readonly DemoStep[];
  initialStep?: number | undefined;
  service?: never;
  providerObservations?: never;
  runWorkItem?: never;
}

export interface PersistentTaskSealServerOptions {
  service: PersistentServicePort;
  providerObservations: ProviderObservationQueryPort;
  runWorkItem: RunWorkItem;
  steps?: never;
  initialStep?: never;
}

export type TaskSealServerOptions =
  | DemoTaskSealServerOptions
  | PersistentTaskSealServerOptions;

export type TaskSealServer =
  ReturnType<typeof createServer> & {
    shutdown(): Promise<void>;
  };

interface DemoRuntime {
  mode: "demo";
  steps: readonly DemoStep[];
  currentStep: number;
}

interface PersistentRuntime {
  mode: "persistent";
  service: PersistentServicePort;
  providerObservations: ProviderObservationQueryPort;
  runWorkItem: RunWorkItem;
  csrfToken: string;
}

type ServerRuntime = DemoRuntime | PersistentRuntime;

interface ActiveRun {
  controller: AbortController;
  execution: Promise<unknown> | null;
}

interface RuntimeError {
  code: string;
  message: string;
  recordedAt: string;
}

interface RunRequestBody {
  prompt: string;
  readOnly?: boolean | undefined;
}

interface ResponseFailure {
  statusCode: number;
  code: string;
  message: string;
}

interface FencedHealth {
  status: "fenced";
  code: string;
  planDigest: string | null;
}

interface DemoSnapshot extends DashboardProjection {
  mode: "demo";
  capabilities: {
    demo: true;
    runAttempt: false;
  };
  demo: {
    currentStep: number;
    totalSteps: number;
    complete: boolean;
    timeline: Array<{
      number: number;
      source: string;
      label: string;
      completed: boolean;
      active: boolean;
    }>;
  };
}

interface PersistentSnapshot extends DashboardProjection {
  mode: "persistent";
  capabilities: {
    demo: false;
    runAttempt: true;
  };
  runtime: {
    activeWorkItemIds: string[];
    errors: Record<string, RuntimeError>;
  };
  security: {
    csrfToken: string;
  };
}

const STATIC_FILES = new Map<string, StaticFile>([
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
    "/provider-state.js",
    {
      url: new URL("../public/provider-state.js", import.meta.url),
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

export function createTaskSealServer(
  options: TaskSealServerOptions
): TaskSealServer {
  const runtime = createServerRuntime(options);
  const activeRuns = new Map<string, ActiveRun>();
  const lastErrors = new Map<string, RuntimeError>();
  let acceptingRuns = true;
  let shutdownPromise: Promise<void> | null = null;

  const server = createServer(async (request, response) => {
    try {
      const pathname = readRequestPathname(request.url);

      if (request.method === "GET" && pathname === "/health") {
        const health = readFencedHealth(runtime);

        if (health) {
          return writeJson(response, 503, health);
        }

        return writeJson(response, 200, {
          status: "ok"
        });
      }

      if (request.method === "GET" && pathname === "/api/dashboard") {
        return writeJson(
          response,
          200,
          runtime.mode === "persistent"
            ? buildPersistentSnapshot(
                runtime.service,
                activeRuns,
                lastErrors,
                runtime.csrfToken
              )
            : buildDemoSnapshot(
                runtime.steps,
                runtime.currentStep
              )
        );
      }

      if (
        runtime.mode === "persistent" &&
        request.method === "GET" &&
        pathname === "/api/providers"
      ) {
        return writeJson(
          response,
          200,
          await runtime.providerObservations.list()
        );
      }

      const runMatch =
        runtime.mode === "persistent" &&
        request.method === "POST" &&
        /^\/api\/work-items\/([^/]+)\/run$/.exec(pathname);

      if (runMatch && runtime.mode === "persistent") {
        if (!acceptingRuns) {
          throw new HttpError(
            503,
            "SERVER_SHUTTING_DOWN",
            "TaskSeal is shutting down and cannot accept new runs."
          );
        }

        validatePersistentWriteRequest(
          request,
          runtime.csrfToken
        );
        const workItemId = decodePathSegment(runMatch[1]);
        const workItem =
          runtime.service.getWorkItem(workItemId);

        if (!workItem) {
          throw new HttpError(
            404,
            "WORK_ITEM_NOT_FOUND",
            `TaskSeal work item ${workItemId} does not exist.`
          );
        }

        const body = validateRunBody(
          await readJsonBody(request)
        );

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
        const entry: ActiveRun = {
          controller,
          execution: null
        };
        activeRuns.set(workItemId, entry);
        let execution: Promise<unknown>;

        try {
          execution = Promise.resolve(
            runtime.runWorkItem({
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
              code: readSafeErrorCode(
                error,
                "RUNNER_FAILED"
              ),
              message: "TaskSeal run failed.",
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
            runtime.service,
            activeRuns,
            lastErrors,
            runtime.csrfToken
          )
        );
      }

      if (
        runtime.mode === "demo" &&
        request.method === "POST" &&
        pathname === "/api/demo/next"
      ) {
        const candidateStep = clampStep(
          runtime.currentStep + 1,
          runtime.steps.length
        );
        const snapshot = buildDemoSnapshot(
          runtime.steps,
          candidateStep
        );
        runtime.currentStep = candidateStep;
        return writeJson(response, 200, snapshot);
      }

      if (
        runtime.mode === "demo" &&
        request.method === "POST" &&
        pathname === "/api/demo/run-all"
      ) {
        const candidateStep = runtime.steps.length;
        const snapshot = buildDemoSnapshot(
          runtime.steps,
          candidateStep
        );
        runtime.currentStep = candidateStep;
        return writeJson(response, 200, snapshot);
      }

      if (
        runtime.mode === "demo" &&
        request.method === "POST" &&
        pathname === "/api/demo/reset"
      ) {
        const candidateStep = Math.min(
          1,
          runtime.steps.length
        );
        const snapshot = buildDemoSnapshot(
          runtime.steps,
          candidateStep
        );
        runtime.currentStep = candidateStep;
        return writeJson(response, 200, snapshot);
      }

      const staticFile = STATIC_FILES.get(pathname);

      if (request.method === "GET" && staticFile) {
        return writeStatic(response, staticFile);
      }

      return writeJson(response, 404, {
        error: "NOT_FOUND",
        message: "The requested resource does not exist."
      });
    } catch (error) {
      const failure = normalizeResponseError(error);
      return writeJson(response, failure.statusCode, {
        error: failure.code,
        message: failure.message
      });
    }
  });

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      acceptingRuns = false;
      const closePromise = server.listening
        ? new Promise<void>((resolve) =>
            server.close(() => resolve())
          )
        : Promise.resolve();
      const entries = [...activeRuns.values()];
      const executions: Promise<unknown>[] = [];

      for (const entry of entries) {
        entry.controller.abort();
        if (entry.execution) {
          executions.push(entry.execution);
        }
      }

      await Promise.allSettled(executions);

      server.closeAllConnections();
      await closePromise;
    })();

    return shutdownPromise;
  };

  return Object.assign(server, { shutdown });
}

function createServerRuntime(
  options: TaskSealServerOptions
): ServerRuntime {
  const service = options.service;
  const steps = options.steps;

  if (service !== undefined && steps !== undefined) {
    throw new TypeError(
      "TaskSeal server cannot use demo and persistent state together."
    );
  }

  if (service !== undefined) {
    if (
      typeof service.snapshot !== "function" ||
      typeof service.getWorkItem !== "function" ||
      !isRecord(options.providerObservations) ||
      typeof options.providerObservations.list !== "function" ||
      typeof options.runWorkItem !== "function"
    ) {
      throw new TypeError(
        "Persistent TaskSeal server requires a service and runWorkItem."
      );
    }

    return {
      mode: "persistent",
      service,
      providerObservations: options.providerObservations,
      runWorkItem: options.runWorkItem,
      csrfToken: randomBytes(32).toString("base64url")
    };
  }

  if (!Array.isArray(steps)) {
    throw new TypeError("Demo TaskSeal server requires steps.");
  }

  return {
    mode: "demo",
    steps,
    currentStep: clampStep(
      options.initialStep ?? 1,
      steps.length
    )
  };
}

function readRequestPathname(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(
      400,
      "INVALID_URL",
      "TaskSeal request URL is invalid."
    );
  }

  try {
    return new URL(value, "http://localhost").pathname;
  } catch {
    throw new HttpError(
      400,
      "INVALID_URL",
      "TaskSeal request URL is invalid."
    );
  }
}

function readFencedHealth(
  runtime: ServerRuntime
): FencedHealth | null {
  if (
    runtime.mode !== "persistent" ||
    typeof runtime.service.getHealth !== "function"
  ) {
    return null;
  }

  const health = runtime.service.getHealth();

  if (!isRecord(health) || health.status !== "fenced") {
    return null;
  }

  return {
    status: "fenced",
    code: readSafeErrorCode(health, "SERVICE_FENCED"),
    planDigest:
      typeof health.planDigest === "string"
        ? health.planDigest.slice(0, 256)
        : null
  };
}

function buildDemoSnapshot(
  steps: readonly DemoStep[],
  currentStep: number
): DemoSnapshot {
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
  service: PersistentServicePort,
  activeRuns: ReadonlyMap<string, ActiveRun>,
  lastErrors: ReadonlyMap<string, RuntimeError>,
  csrfToken: string
): PersistentSnapshot {
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

function clampStep(value: number, maximum: number): number {
  return Math.max(0, Math.min(value, maximum));
}

async function readJsonBody(
  request: IncomingMessage
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  let exceeded = false;
  const bodyStream: AsyncIterable<unknown> = request;

  for await (const rawChunk of bodyStream) {
    const chunk =
      typeof rawChunk === "string"
        ? Buffer.from(rawChunk)
        : Buffer.isBuffer(rawChunk)
          ? rawChunk
          : null;

    if (!chunk) {
      throw new HttpError(
        400,
        "INVALID_REQUEST_BODY",
        "TaskSeal run request body is invalid."
      );
    }

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
    const parsed: unknown = JSON.parse(
      Buffer.concat(chunks).toString("utf8")
    );
    return parsed;
  } catch {
    throw new HttpError(
      400,
      "INVALID_JSON",
      "TaskSeal run request must contain valid JSON."
    );
  }
}

function validatePersistentWriteRequest(
  request: IncomingMessage,
  csrfToken: string
): void {
  const contentType = request.headers["content-type"];

  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;|$)/i.test(contentType)
  ) {
    throw new HttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "TaskSeal run requests require application/json."
    );
  }

  const host = requireTrustedHost(request.headers.host);

  const origin = request.headers.origin;

  if (
    origin !== undefined &&
    (typeof origin !== "string" ||
      origin !== `http://${host}`)
  ) {
    throw new HttpError(
      403,
      "UNTRUSTED_ORIGIN",
      "TaskSeal rejected a cross-origin run request."
    );
  }

  const fetchSite = request.headers["sec-fetch-site"];

  if (
    fetchSite !== undefined &&
    (typeof fetchSite !== "string" ||
      (fetchSite !== "same-origin" &&
        fetchSite !== "none"))
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

function requireTrustedHost(value: unknown): string {
  if (typeof value !== "string") {
    throw untrustedHost();
  }

  const host = value.toLowerCase();
  const nameOrIpv4 =
    /^(?:localhost|127\.0\.0\.1)(?::([0-9]+))?$/.exec(
      host
    );
  const ipv6 = /^\[::1\](?::([0-9]+))?$/.exec(host);
  const match = nameOrIpv4 ?? ipv6;

  if (!match) {
    throw untrustedHost();
  }

  const portText = match[1];

  if (portText !== undefined) {
    const port = Number(portText);

    if (
      !Number.isSafeInteger(port) ||
      port < 0 ||
      port > 65_535
    ) {
      throw untrustedHost();
    }
  }

  return value;
}

function untrustedHost(): HttpError {
  return new HttpError(
    403,
    "UNTRUSTED_HOST",
    "TaskSeal only accepts loopback requests."
  );
}

function secureTokenEquals(left: unknown, right: unknown): boolean {
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

function validateRunBody(body: unknown): RunRequestBody {
  if (
    !isRecord(body) ||
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

  return {
    prompt: body.prompt,
    ...(body.readOnly === undefined
      ? {}
      : { readOnly: body.readOnly })
  };
}

function decodePathSegment(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(
      400,
      "INVALID_PATH",
      "TaskSeal work item id is not valid URL encoding."
    );
  }

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

function normalizeResponseError(
  error: unknown
): ResponseFailure {
  if (error instanceof HttpError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message
    };
  }

  if (
    isRecord(error) &&
    error.name === "TaskSealServiceError"
  ) {
    const code = readSafeErrorCode(
      error,
      "SERVICE_ERROR"
    );

    return {
      statusCode:
        code === "SERVICE_REOPEN_REQUIRED" ? 503 : 500,
      code,
      message:
        code === "SERVICE_REOPEN_REQUIRED"
          ? "TaskSeal service must be reopened before requests can continue."
          : "TaskSeal service request failed."
    };
  }

  if (
    isRecord(error) &&
    error.name === "ProviderObservationError"
  ) {
    return {
      statusCode: 503,
      code: readSafeErrorCode(
        error,
        "PROVIDER_OBSERVATION_READ_FAILED"
      ),
      message:
        "TaskSeal provider observations are unavailable and must be reopened."
    };
  }

  if (isRecord(error) && error.name === "DomainError") {
    return {
      statusCode: 422,
      code: readSafeErrorCode(error, "DOMAIN_ERROR"),
      message: "TaskSeal rejected the requested state transition."
    };
  }

  return {
    statusCode: 500,
    code: "INTERNAL_ERROR",
    message: "TaskSeal request failed."
  };
}

function readSafeErrorCode(
  error: unknown,
  fallback: string
): string {
  if (
    isRecord(error) &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
  ) {
    return error.code;
  }

  return fallback;
}

class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(
    statusCode: number,
    code: string,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

async function writeStatic(
  response: ServerResponse,
  file: StaticFile
): Promise<void> {
  const content = await readFile(file.url);
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": file.contentType
  });
  response.end(content);
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown
): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}
