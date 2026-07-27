import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";

import {
  createTaskSealServer
} from "../src/server.ts";
import type {
  TaskSealServer
} from "../src/server.ts";
import type {
  ProviderSyncProjection
} from "../src/application/provider-sync-projection.ts";

test("persistent GET /api/providers exposes only the no-store Provider sync v2 projection", async (t) => {
  const projection: ProviderSyncProjection = {
    schemaVersion: 2 as const,
    revision: `sha256:${"a".repeat(64)}`,
    observationRevision:
      `sha256:${"b".repeat(64)}`,
    operationRevision:
      `sha256:${"c".repeat(64)}`,
    providers: [
      {
        schemaVersion: 1,
        observationId:
          `sha256:${"d".repeat(64)}`,
        operation: "configuration",
        provider: "github",
        configuredTarget: {
          kind: "repository",
          key: "github:repository:netpilot-z/taskseal"
        },
        observedScope: null,
        status: "configured",
        startedAt: "2026-07-27T10:00:00.000Z",
        observedAt: "2026-07-27T10:00:00.000Z",
        sourceRevisions: [],
        snapshotDigest: null,
        mappingDigest: null,
        planDigest: null,
        missingEvidence: [],
        diagnosticCode: null,
        resolution: null
      }
    ],
    operations: [
      {
        schemaVersion: 1,
        provider: "linear",
        operationKey:
          `sha256:${"e".repeat(64)}`,
        configuredTarget: {
          kind: "team",
          key:
            "linear:team-ref:taskseal/netpilot"
        },
        version: 1,
        status: "approval_required",
        approval: null,
        diagnosticCode: null,
        createdAt:
          "2026-07-27T10:00:00.000Z",
        updatedAt:
          "2026-07-27T10:00:00.000Z"
      }
    ]
  };
  let calls = 0;
  const server = createTaskSealServer({
    service: createService(),
    providerStatus: {
      async list() {
        calls += 1;
        return projection;
      }
    },
    runWorkItem: async () => {}
  });
  const baseUrl = await listen(server, t);

  const response = await fetch(`${baseUrl}/api/providers`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), projection);
  assert.equal(calls, 1);

  const writeResponse = await fetch(
    `${baseUrl}/api/providers`,
    {
      method: "POST"
    }
  );
  assert.equal(writeResponse.status, 404);
  assert.equal(calls, 1);
});

test("Provider sync API returns a fixed safe 503 without leaking either source", async (t) => {
  const secret = "path-and-token-secret";
  const server = createTaskSealServer({
    service: createService(),
    providerStatus: {
      async list() {
        throw Object.assign(
          new Error(`Corrupt state at ${secret}`),
          {
            name: "ProviderSyncProjectionError",
            code:
              "PROVIDER_SYNC_PROJECTION_UNAVAILABLE",
            token: secret
          }
        );
      }
    },
    runWorkItem: async () => {}
  });
  const baseUrl = await listen(server, t);

  const response = await fetch(`${baseUrl}/api/providers`);
  const text = await response.text();

  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(text), {
    error:
      "PROVIDER_SYNC_PROJECTION_UNAVAILABLE",
    message:
      "TaskSeal provider status is unavailable and must be reopened."
  });
  assert.doesNotMatch(text, new RegExp(secret));
});

test("Provider sync API allowlists public projection error codes", async (t) => {
  const server = createTaskSealServer({
    service: createService(),
    providerStatus: {
      async list() {
        throw Object.assign(
          new Error("must remain private"),
          {
            name: "ProviderSyncProjectionError",
            code: "SECRET_API_KEY"
          }
        );
      }
    },
    runWorkItem: async () => {}
  });
  const baseUrl = await listen(server, t);

  const response = await fetch(`${baseUrl}/api/providers`);

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error:
      "PROVIDER_SYNC_PROJECTION_UNAVAILABLE",
    message:
      "TaskSeal provider status is unavailable and must be reopened."
  });
});

function createService() {
  return {
    snapshot() {
      return {
        generatedAt: "2026-07-27T10:00:00.000Z",
        summary: {
          total: 0,
          planned: 0,
          running: 0,
          reviewing: 0,
          blocked: 0,
          accepted: 0,
          activeAgents: 0
        },
        workItems: []
      };
    },
    getWorkItem() {
      return null;
    }
  };
}

async function listen(
  server: TaskSealServer,
  t: TestContext
): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  t.after(() => server.shutdown());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
