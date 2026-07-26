import assert from "node:assert/strict";
import { request as createHttpRequest } from "node:http";
import test from "node:test";

import { loadDemoSteps } from "../src/demo/scenario.js";
import { createTaskSealServer } from "../src/server.js";

test("the local API exposes the workflow and can run the demo to acceptance", async (t) => {
  const steps = await loadDemoSteps();
  const server = createTaskSealServer({ steps, initialStep: 1 });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const pageResponse = await fetch(baseUrl);
  const page = await pageResponse.text();

  assert.equal(pageResponse.status, 200);
  assert.match(page, /TaskSeal Control Room/);

  const initialResponse = await fetch(`${baseUrl}/api/dashboard`);
  const initial = await initialResponse.json();

  assert.equal(initialResponse.status, 200);
  assert.equal(initial.workItems[0].status, "planned");

  const runResponse = await fetch(`${baseUrl}/api/demo/run-all`, {
    method: "POST"
  });
  const completed = await runResponse.json();

  assert.equal(runResponse.status, 200);
  assert.equal(completed.workItems[0].status, "accepted");
  assert.equal(completed.demo.currentStep, steps.length);
});

test("a failed demo step does not commit partial server state", async (t) => {
  const steps = await loadDemoSteps();
  const invalidSteps = [steps[0], steps[2]];
  const server = createTaskSealServer({
    steps: invalidSteps,
    initialStep: 1
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const failedResponse = await fetch(`${baseUrl}/api/demo/next`, {
    method: "POST"
  });
  const dashboardResponse = await fetch(`${baseUrl}/api/dashboard`);
  const dashboard = await dashboardResponse.json();

  assert.equal(failedResponse.status, 422);
  assert.equal(dashboardResponse.status, 200);
  assert.equal(dashboard.demo.currentStep, 1);
  assert.equal(dashboard.workItems[0].status, "planned");
});

test("persistent API exposes journal state and runs one work item asynchronously", async (t) => {
  let status = "planned";
  let releaseRun;
  const runGate = new Promise((resolve) => {
    releaseRun = resolve;
  });
  const calls = [];
  const service = createPersistentService(() => status);
  const server = createTaskSealServer({
    service,
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
  const initial = await initialResponse.json();

  assert.equal(initialResponse.status, 200);
  assert.equal(initial.mode, "persistent");
  assert.equal(initial.capabilities.runAttempt, true);
  assert.equal(initial.workItems[0].status, "planned");
  assert.equal(initial.demo, undefined);

  const runResponse = await fetch(`${baseUrl}/api/work-items/TS-1/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-taskseal-csrf-token": initial.security.csrfToken
    },
    body: JSON.stringify({
      prompt: "Inspect the local work item.",
      readOnly: true
    })
  });
  const accepted = await runResponse.json();

  assert.equal(runResponse.status, 202);
  assert.equal(accepted.runtime.activeWorkItemIds.includes("TS-1"), true);
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
        "x-taskseal-csrf-token": initial.security.csrfToken
      },
      body: JSON.stringify({ prompt: "Do not start twice." })
    }
  );
  assert.equal(duplicateResponse.status, 409);

  releaseRun();
  await waitFor(() => status === "reviewing");

  const completedResponse = await fetch(`${baseUrl}/api/dashboard`);
  const completed = await completedResponse.json();

  assert.equal(completed.workItems[0].status, "reviewing");
  assert.deepEqual(completed.runtime.activeWorkItemIds, []);
});

test("persistent run endpoint validates work item and request body", async (t) => {
  const service = createPersistentService(() => "planned");
  let invoked = false;
  const server = createTaskSealServer({
    service,
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
  const calls = [];
  const server = createTaskSealServer({
    service,
    runWorkItem: async (options) => {
      calls.push(options);
    }
  });
  const baseUrl = await listen(server, t);
  const dashboard = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const token = dashboard.security.csrfToken;

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

test("persistent run reservation is atomic and defaults to read-only", async (t) => {
  const service = createPersistentService(() => "planned");
  let releaseRun;
  const runGate = new Promise((resolve) => {
    releaseRun = resolve;
  });
  const calls = [];
  const server = createTaskSealServer({
    service,
    runWorkItem: async (options) => {
      calls.push(options);
      await runGate;
    }
  });
  const baseUrl = await listen(server, t);
  const dashboard = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const request = () =>
    fetch(`${baseUrl}/api/work-items/TS-1/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-taskseal-csrf-token": dashboard.security.csrfToken
      },
      body: JSON.stringify({ prompt: "Run once." })
    });

  const responses = await Promise.all([request(), request()]);
  const statuses = responses.map((response) => response.status).sort();

  assert.deepEqual(statuses, [202, 409]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sandbox, "read-only");
  assert.equal(calls[0].signal instanceof AbortSignal, true);

  releaseRun();
});

test("server shutdown aborts active runs before closing", async (t) => {
  const service = createPersistentService(() => "running");
  let aborted = false;
  const server = createTaskSealServer({
    service,
    runWorkItem: ({ signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            const error = new Error("Interrupted for shutdown.");
            error.code = "CODEX_INTERRUPTED";
            reject(error);
          },
          { once: true }
        );
      })
  });
  const baseUrl = await listen(server, t);
  const dashboard = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const runResponse = await fetch(
    `${baseUrl}/api/work-items/TS-1/run`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-taskseal-csrf-token": dashboard.security.csrfToken
      },
      body: JSON.stringify({ prompt: "Wait for shutdown." })
    }
  );

  assert.equal(runResponse.status, 202);
  await server.shutdown();
  assert.equal(aborted, true);
});

test("server shutdown rejects a request stalled before run reservation", async (t) => {
  const calls = [];
  let observeAbort;
  let releaseFirst;
  const abortObserved = new Promise((resolve) => {
    observeAbort = resolve;
  });
  const firstRunGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const service = createPersistentService(
    () => "running",
    ["TS-1", "TS-2"]
  );
  const server = createTaskSealServer({
    service,
    runWorkItem: ({ workItemId, signal }) => {
      calls.push({
        workItemId,
        signal
      });

      return new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            observeAbort();
            firstRunGate.then(() => {
              const error = new Error("Interrupted for shutdown.");
              error.code = "CODEX_INTERRUPTED";
              reject(error);
            });
          },
          { once: true }
        );
      });
    }
  });
  const baseUrl = await listen(server, t);
  const dashboard = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const headers = {
    "content-type": "application/json",
    "x-taskseal-csrf-token": dashboard.security.csrfToken
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

  let stalledRequest;
  let markStalledRequestReady;
  const stalledRequestReady = new Promise((resolve) => {
    markStalledRequestReady = resolve;
  });
  const stalledResponse = new Promise((resolve, reject) => {
    stalledRequest = createHttpRequest(
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
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode,
            body
          })
        );
      }
    );
    stalledRequest.on("error", reject);
    stalledRequest.on("continue", () => {
      stalledRequest.write('{"prompt":"Finish after shutdown');
      markStalledRequestReady();
    });
    stalledRequest.flushHeaders();
  });

  await stalledRequestReady;
  await new Promise((resolve) => setImmediate(resolve));
  const shutdown = server.shutdown();
  await abortObserved;
  stalledRequest.end('."}');

  const rejected = await stalledResponse;
  assert.equal(rejected.statusCode, 503);
  assert.equal(JSON.parse(rejected.body).error, "SERVER_SHUTTING_DOWN");
  assert.deepEqual(
    calls.map((call) => call.workItemId),
    ["TS-1"]
  );
  assert.equal(calls[0].signal.aborted, true);

  releaseFirst();
  await shutdown;
});

async function listen(server, t) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function createPersistentService(
  readStatus,
  workItemIds = ["TS-1"]
) {
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

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.fail("Timed out waiting for the persistent run to settle.");
}
