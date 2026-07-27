import assert from "node:assert/strict";
import { request as createHttpRequest } from "node:http";
import test from "node:test";
import type { TestContext } from "node:test";

import { loadDemoSteps } from "../src/demo/scenario.ts";
import { createTaskSealServer } from "../src/server.ts";
import type {
  PersistentServicePort,
  RunWorkItemOptions,
  TaskSealServer
} from "../src/server.ts";

interface RunCallObservation {
  workItemId: string;
  prompt: string;
  sandbox: "read-only" | "workspace-write";
  hasAbortSignal: boolean;
}

interface RawHttpResponse {
  statusCode: number;
  body: string;
}

type TestWorkItemStatus =
  | "planned"
  | "running"
  | "reviewing";

test("the local API exposes the workflow and can run the demo to acceptance", async (t) => {
  const steps = await loadDemoSteps();
  const server = createTaskSealServer({ steps, initialStep: 1 });
  const baseUrl = await listen(server, t);

  const pageResponse = await fetch(baseUrl);
  const page = await pageResponse.text();

  assert.equal(pageResponse.status, 200);
  assert.match(page, /TaskSeal Control Room/);
  assert.match(page, /Provider operations/);

  const providerStateResponse = await fetch(
    `${baseUrl}/provider-state.js`
  );
  assert.equal(providerStateResponse.status, 200);
  assert.match(
    providerStateResponse.headers.get("content-type") ?? "",
    /text\/javascript/
  );
  assert.match(
    await providerStateResponse.text(),
    /createProviderPanelModel/
  );

  const initialResponse = await fetch(`${baseUrl}/api/dashboard`);
  const initial: unknown = await initialResponse.json();

  assert.equal(initialResponse.status, 200);
  assert.equal(
    readJsonPath(initial, "workItems", 0, "status"),
    "planned"
  );

  const runResponse = await fetch(`${baseUrl}/api/demo/run-all`, {
    method: "POST"
  });
  const completed: unknown = await runResponse.json();

  assert.equal(runResponse.status, 200);
  assert.equal(
    readJsonPath(completed, "workItems", 0, "status"),
    "accepted"
  );
  assert.equal(
    readJsonPath(completed, "demo", "currentStep"),
    steps.length
  );
});

test("a failed demo step does not commit partial server state", async (t) => {
  const steps = await loadDemoSteps();
  const firstStep = steps[0];
  const thirdStep = steps[2];
  assert.ok(firstStep);
  assert.ok(thirdStep);
  const invalidSteps = [firstStep, thirdStep];
  const server = createTaskSealServer({
    steps: invalidSteps,
    initialStep: 1
  });
  const baseUrl = await listen(server, t);
  const failedResponse = await fetch(`${baseUrl}/api/demo/next`, {
    method: "POST"
  });
  const dashboardResponse = await fetch(`${baseUrl}/api/dashboard`);
  const dashboard: unknown = await dashboardResponse.json();

  assert.equal(failedResponse.status, 422);
  assert.equal(dashboardResponse.status, 200);
  assert.equal(readJsonPath(dashboard, "demo", "currentStep"), 1);
  assert.equal(
    readJsonPath(dashboard, "workItems", 0, "status"),
    "planned"
  );
});

test("persistent API exposes journal state and runs one work item asynchronously", async (t) => {
  let status: TestWorkItemStatus = "planned";
  let releaseRun = (): void => {};
  const runGate = new Promise<void>((resolve) => {
    releaseRun = () => resolve();
  });
  const calls: RunCallObservation[] = [];
  const service = createPersistentService(() => status);
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: async ({ signal, ...options }) => {
      calls.push({
        ...options,
        hasAbortSignal: signal instanceof AbortSignal
      });
      status = "running";
      await runGate;
      status = "reviewing";
    }
  });

  const baseUrl = await listen(server, t);
  const initialResponse = await fetch(`${baseUrl}/api/dashboard`);
  const initial: unknown = await initialResponse.json();
  const csrfToken = readJsonString(
    initial,
    "security",
    "csrfToken"
  );

  assert.equal(initialResponse.status, 200);
  assert.equal(readJsonPath(initial, "mode"), "persistent");
  assert.equal(
    readJsonPath(initial, "capabilities", "runAttempt"),
    true
  );
  assert.equal(
    readJsonPath(initial, "workItems", 0, "status"),
    "planned"
  );
  assert.equal(readJsonPath(initial, "demo"), undefined);

  const runResponse = await fetch(`${baseUrl}/api/work-items/TS-1/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-taskseal-csrf-token": csrfToken
    },
    body: JSON.stringify({
      prompt: "Inspect the local work item.",
      readOnly: true
    })
  });
  const accepted: unknown = await runResponse.json();

  assert.equal(runResponse.status, 202);
  assert.equal(
    readJsonStringArray(
      accepted,
      "runtime",
      "activeWorkItemIds"
    ).includes("TS-1"),
    true
  );
  assert.deepEqual(calls, [
    {
      workItemId: "TS-1",
      prompt: "Inspect the local work item.",
      sandbox: "read-only",
      hasAbortSignal: true
    }
  ]);

  const duplicateResponse = await fetch(
    `${baseUrl}/api/work-items/TS-1/run`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-taskseal-csrf-token": csrfToken
      },
      body: JSON.stringify({ prompt: "Do not start twice." })
    }
  );
  assert.equal(duplicateResponse.status, 409);

  releaseRun();
  await waitFor(() => status === "reviewing");

  const completedResponse = await fetch(`${baseUrl}/api/dashboard`);
  const completed: unknown = await completedResponse.json();

  assert.equal(
    readJsonPath(completed, "workItems", 0, "status"),
    "reviewing"
  );
  assert.deepEqual(
    readJsonStringArray(
      completed,
      "runtime",
      "activeWorkItemIds"
    ),
    []
  );
});

test("persistent health exposes a fenced service and requires reopen", async (t) => {
  const service = {
    ...createPersistentService(() => "planned"),
    getHealth() {
      return {
        status: "fenced",
        code: "IMPORT_COMMIT_OUTCOME_UNKNOWN",
        planDigest: `sha256:${"a".repeat(64)}`
      };
    }
  };
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: async () => {}
  });
  const baseUrl = await listen(server, t);

  const response = await fetch(`${baseUrl}/health`);

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    status: "fenced",
    code: "IMPORT_COMMIT_OUTCOME_UNKNOWN",
    planDigest: `sha256:${"a".repeat(64)}`
  });
});

test("persistent health keeps the established ok response while ready", async (t) => {
  const service = {
    ...createPersistentService(() => "planned"),
    getHealth() {
      return { status: "ready" };
    }
  };
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: async () => {}
  });
  const baseUrl = await listen(server, t);

  const response = await fetch(`${baseUrl}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok"
  });
});

test("persistent dashboard preserves a safe service reopen error", async (t) => {
  const service = {
    ...createPersistentService(() => "planned"),
    snapshot() {
      throw createServiceReopenError();
    }
  };
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: async () => {}
  });
  const baseUrl = await listen(server, t);

  const response = await fetch(`${baseUrl}/api/dashboard`);
  const body: unknown = await response.json();

  assert.deepEqual(body, {
    error: "SERVICE_REOPEN_REQUIRED",
    message: "TaskSeal service must be reopened before requests can continue."
  });
  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(body).includes("must-not-be-returned-secret"), false);
});

test("persistent run preserves a safe service reopen error", async (t) => {
  const service = {
    ...createPersistentService(() => "planned"),
    getWorkItem() {
      throw createServiceReopenError();
    }
  };
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: async () => {}
  });
  const baseUrl = await listen(server, t);
  const dashboard: unknown = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const csrfToken = readJsonString(
    dashboard,
    "security",
    "csrfToken"
  );

  const response = await fetch(
    `${baseUrl}/api/work-items/TS-1/run`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-taskseal-csrf-token": csrfToken
      },
      body: JSON.stringify({ prompt: "Do not expose the service error." })
    }
  );
  const body: unknown = await response.json();

  assert.deepEqual(body, {
    error: "SERVICE_REOPEN_REQUIRED",
    message: "TaskSeal service must be reopened before requests can continue."
  });
  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(body).includes("must-not-be-returned-secret"), false);
});

test("persistent run endpoint validates work item and request body", async (t) => {
  const service = createPersistentService(() => "planned");
  let invoked = false;
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: async () => {
      invoked = true;
    }
  });
  const baseUrl = await listen(server, t);
  const dashboard = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();

  const missingResponse = await fetch(
    `${baseUrl}/api/work-items/TS-404/run`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-taskseal-csrf-token": dashboard.security.csrfToken
      },
      body: JSON.stringify({ prompt: "Missing work." })
    }
  );
  const invalidResponse = await fetch(
    `${baseUrl}/api/work-items/TS-1/run`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-taskseal-csrf-token": dashboard.security.csrfToken
      },
      body: JSON.stringify({ prompt: "" })
    }
  );

  assert.equal(missingResponse.status, 404);
  assert.equal(invalidResponse.status, 400);
  assert.equal(invoked, false);
});

test("persistent run endpoint rejects cross-site and non-JSON requests", async (t) => {
  const service = createPersistentService(() => "planned");
  const calls: RunWorkItemOptions[] = [];
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: async (options) => {
      calls.push(options);
    }
  });
  const baseUrl = await listen(server, t);
  const dashboard: unknown = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const token = readJsonString(
    dashboard,
    "security",
    "csrfToken"
  );

  const textResponse = await fetch(`${baseUrl}/api/work-items/TS-1/run`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      "x-taskseal-csrf-token": token
    },
    body: JSON.stringify({ prompt: "Cross-site simple request." })
  });
  const originResponse = await fetch(
    `${baseUrl}/api/work-items/TS-1/run`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "origin": "https://attacker.invalid",
        "x-taskseal-csrf-token": token
      },
      body: JSON.stringify({ prompt: "Bad origin." })
    }
  );
  const tokenResponse = await fetch(
    `${baseUrl}/api/work-items/TS-1/run`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Missing token." })
    }
  );

  assert.equal(textResponse.status, 415);
  assert.equal(originResponse.status, 403);
  assert.equal(tokenResponse.status, 403);
  assert.equal(calls.length, 0);
});

test("persistent run endpoint fails closed on non-object JSON bodies", async (t) => {
  const service = createPersistentService(() => "planned");
  const calls: RunWorkItemOptions[] = [];
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: async (options) => {
      calls.push(options);
    }
  });
  const baseUrl = await listen(server, t);
  const dashboard: unknown = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const csrfToken = readJsonString(
    dashboard,
    "security",
    "csrfToken"
  );
  const bodies = ["null", "[]", "1", "\"prompt\""];

  const responses = await Promise.all(
    bodies.map((body) =>
      fetch(`${baseUrl}/api/work-items/TS-1/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-taskseal-csrf-token": csrfToken
        },
        body
      })
    )
  );

  assert.deepEqual(
    responses.map((response) => response.status),
    [400, 400, 400, 400]
  );
  assert.equal(calls.length, 0);
});

test("persistent run endpoint rejects missing and malformed Host headers", async (t) => {
  const service = createPersistentService(() => "planned");
  const calls: RunWorkItemOptions[] = [];
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: async (options) => {
      calls.push(options);
    }
  });
  const baseUrl = await listen(server, t);
  const dashboard: unknown = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const token = readJsonString(
    dashboard,
    "security",
    "csrfToken"
  );
  const endpoint = `${baseUrl}/api/work-items/TS-1/run`;

  const responses = await Promise.all([
    sendRawRunRequest(endpoint, token),
    sendRawRunRequest(endpoint, token, "localhost:")
  ]);

  assert.deepEqual(
    responses.map((response) => response.statusCode),
    [400, 403]
  );
  assert.equal(calls.length, 0);
});

test("persistent run reservation is atomic and defaults to read-only", async (t) => {
  const service = createPersistentService(() => "planned");
  let releaseRun = (): void => {};
  const runGate = new Promise<void>((resolve) => {
    releaseRun = () => resolve();
  });
  const calls: RunWorkItemOptions[] = [];
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: async (options) => {
      calls.push(options);
      await runGate;
    }
  });
  const baseUrl = await listen(server, t);
  const dashboard: unknown = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const csrfToken = readJsonString(
    dashboard,
    "security",
    "csrfToken"
  );
  const request = () =>
    fetch(`${baseUrl}/api/work-items/TS-1/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-taskseal-csrf-token": csrfToken
      },
      body: JSON.stringify({ prompt: "Run once." })
    });

  const responses = await Promise.all([request(), request()]);
  const statuses = responses.map((response) => response.status).sort();

  assert.deepEqual(statuses, [202, 409]);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.sandbox, "read-only");
  assert.equal(call.signal instanceof AbortSignal, true);

  releaseRun();
});

test("server shutdown aborts active runs before closing", async (t) => {
  const service = createPersistentService(() => "running");
  let aborted = false;
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: ({ signal }) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            const error = Object.assign(
              new Error("Interrupted for shutdown."),
              { code: "CODEX_INTERRUPTED" }
            );
            reject(error);
          },
          { once: true }
        );
      })
  });
  const baseUrl = await listen(server, t);
  const dashboard: unknown = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const csrfToken = readJsonString(
    dashboard,
    "security",
    "csrfToken"
  );
  const runResponse = await fetch(
    `${baseUrl}/api/work-items/TS-1/run`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-taskseal-csrf-token": csrfToken
      },
      body: JSON.stringify({ prompt: "Wait for shutdown." })
    }
  );

  assert.equal(runResponse.status, 202);
  await server.shutdown();
  assert.equal(aborted, true);
});

test("server shutdown rejects a request stalled before run reservation", async (t) => {
  const calls: Array<
    Pick<RunWorkItemOptions, "workItemId" | "signal">
  > = [];
  let observeAbort = (): void => {};
  let releaseFirst = (): void => {};
  const abortObserved = new Promise<void>((resolve) => {
    observeAbort = () => resolve();
  });
  const firstRunGate = new Promise<void>((resolve) => {
    releaseFirst = () => resolve();
  });
  const service = createPersistentService(
    () => "running",
    ["TS-1", "TS-2"]
  );
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: ({ workItemId, signal }) => {
      calls.push({
        workItemId,
        signal
      });

      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            observeAbort();
            firstRunGate.then(() => {
              const error = Object.assign(
                new Error("Interrupted for shutdown."),
                { code: "CODEX_INTERRUPTED" }
              );
              reject(error);
            });
          },
          { once: true }
        );
      });
    }
  });
  const baseUrl = await listen(server, t);
  const dashboard: unknown = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const csrfToken = readJsonString(
    dashboard,
    "security",
    "csrfToken"
  );
  const headers = {
    "content-type": "application/json",
    "x-taskseal-csrf-token": csrfToken
  };
  const firstResponse = await fetch(
    `${baseUrl}/api/work-items/TS-1/run`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "Hold the first run open." })
    }
  );

  assert.equal(firstResponse.status, 202);

  let markStalledRequestReady = (): void => {};
  const stalledRequestReady = new Promise<void>((resolve) => {
    markStalledRequestReady = () => resolve();
  });
  let resolveStalledResponse = (
    _response: RawHttpResponse
  ): void => {};
  let rejectStalledResponse = (_reason?: unknown): void => {};
  const stalledResponse = new Promise<RawHttpResponse>((resolve, reject) => {
    resolveStalledResponse = resolve;
    rejectStalledResponse = reject;
  });
  const stalledRequest = createHttpRequest(
    `${baseUrl}/api/work-items/TS-2/run`,
    {
      method: "POST",
      headers: {
        ...headers,
        expect: "100-continue"
      }
    },
    (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () =>
        resolveStalledResponse({
          statusCode: response.statusCode ?? 0,
          body
        })
      );
    }
  );
  stalledRequest.on("error", rejectStalledResponse);
  stalledRequest.on("continue", () => {
    stalledRequest.write('{"prompt":"Finish after shutdown');
    markStalledRequestReady();
  });
  stalledRequest.flushHeaders();

  await stalledRequestReady;
  await new Promise<void>((resolve) =>
    setImmediate(() => resolve())
  );
  const shutdown = server.shutdown();
  await abortObserved;
  stalledRequest.end('."}');

  const rejected = await stalledResponse;
  assert.equal(rejected.statusCode, 503);
  const rejection: unknown = JSON.parse(rejected.body);
  assert.equal(
    readJsonPath(rejection, "error"),
    "SERVER_SHUTTING_DOWN"
  );
  assert.deepEqual(
    calls.map((call) => call.workItemId),
    ["TS-1"]
  );
  const firstCall = calls[0];
  assert.ok(firstCall);
  assert.equal(firstCall.signal.aborted, true);

  releaseFirst();
  await shutdown;
});

async function listen(
  server: TaskSealServer,
  t: TestContext
): Promise<string> {
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        if (!server.listening) {
          resolve();
          return;
        }

        server.close(() => resolve());
      })
  );
  const address = server.address();

  if (!address || typeof address === "string") {
    assert.fail("Expected TaskSeal to listen on a TCP port.");
  }

  return `http://127.0.0.1:${address.port}`;
}

function sendRawRunRequest(
  url: string,
  token: string,
  host?: string
): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    const headers = {
      "content-type": "application/json",
      "x-taskseal-csrf-token": token,
      ...(host === undefined ? {} : { host })
    };
    const request = createHttpRequest(
      url,
      {
        method: "POST",
        setHost: host !== undefined,
        headers
      },
      (response) => {
        response.resume();
        response.once("end", () =>
          resolve({
            statusCode: response.statusCode ?? 0
          })
        );
      }
    );
    request.once("error", reject);
    request.end(JSON.stringify({ prompt: "Do not start." }));
  });
}

function createPersistentService(
  readStatus: () => TestWorkItemStatus,
  workItemIds: readonly string[] = ["TS-1"]
): PersistentServicePort {
  return {
    getWorkItem(workItemId) {
      return workItemIds.includes(workItemId)
        ? { id: workItemId }
        : null;
    },
    snapshot() {
      const status = readStatus();
      return {
        generatedAt: new Date().toISOString(),
        summary: {
          total: workItemIds.length,
          planned:
            status === "planned" ? workItemIds.length : 0,
          running:
            status === "running" ? workItemIds.length : 0,
          reviewing:
            status === "reviewing" ? workItemIds.length : 0,
          blocked: 0,
          accepted: 0,
          activeAgents:
            status === "running" ? workItemIds.length : 0
        },
        workItems: workItemIds.map((workItemId) => ({
            id: workItemId,
            title: "Persistent work",
            status,
            progress: 20,
            requiredEvidence: ["tests"],
            activeAttempt: null,
            activeArtifact: null,
            currentEvidence: [],
            attempts: [],
            artifacts: [],
            evidence: [],
            acceptanceDecision: null,
            externalLinks: []
          }))
      };
    }
  };
}

function createProviderStatus() {
  return {
    async list() {
      return {
        schemaVersion: 2 as const,
        revision:
          `sha256:${"0".repeat(64)}`,
        observationRevision:
          `sha256:${"1".repeat(64)}`,
        operationRevision:
          `sha256:${"2".repeat(64)}`,
        providers: [],
        operations: []
      };
    }
  };
}

async function waitFor(
  predicate: () => boolean
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise<void>((resolve) =>
      setTimeout(() => resolve(), 10)
    );
  }

  assert.fail("Timed out waiting for the persistent run to settle.");
}

function readJsonPath(
  value: unknown,
  ...path: Array<string | number>
): unknown {
  let current = value;

  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) {
        throw new TypeError("Expected a JSON array.");
      }

      const values: readonly unknown[] = current;
      current = values[segment];
      continue;
    }

    if (!isRecord(current)) {
      throw new TypeError("Expected a JSON object.");
    }

    current = current[segment];
  }

  return current;
}

function readJsonString(
  value: unknown,
  ...path: Array<string | number>
): string {
  const candidate = readJsonPath(value, ...path);

  if (typeof candidate !== "string") {
    throw new TypeError("Expected a JSON string.");
  }

  return candidate;
}

function readJsonStringArray(
  value: unknown,
  ...path: Array<string | number>
): string[] {
  const candidate = readJsonPath(value, ...path);

  if (!Array.isArray(candidate)) {
    throw new TypeError("Expected a JSON array.");
  }

  const values: string[] = [];

  for (const item of candidate) {
    if (typeof item !== "string") {
      throw new TypeError("Expected a JSON string array.");
    }

    values.push(item);
  }

  return values;
}

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function createServiceReopenError(): Error & {
  code: string;
} {
  return Object.assign(
    new Error("must-not-be-returned-secret"),
    {
      name: "TaskSealServiceError",
      code: "SERVICE_REOPEN_REQUIRED"
    }
  );
}
