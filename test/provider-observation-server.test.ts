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
  ProviderObservationProjection
} from "../src/application/provider-observation.ts";

test("persistent GET /api/providers exposes only the no-store observation projection", async (t) => {
  const projection: ProviderObservationProjection = {
    schemaVersion: 1 as const,
    revision: `sha256:${"a".repeat(64)}`,
    providers: [
      {
        schemaVersion: 1,
        observationId: `sha256:${"b".repeat(64)}`,
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
    ]
  };
  let calls = 0;
  const server = createTaskSealServer({
    service: createService(),
    providerObservations: {
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

test("Provider observation API returns a fixed safe 503 for corrupt storage", async (t) => {
  const secret = "path-and-token-secret";
  const server = createTaskSealServer({
    service: createService(),
    providerObservations: {
      async list() {
        throw Object.assign(
          new Error(`Corrupt state at ${secret}`),
          {
            name: "ProviderObservationError",
            code: "PROVIDER_OBSERVATION_STORE_CORRUPT",
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
    error: "PROVIDER_OBSERVATION_STORE_CORRUPT",
    message:
      "TaskSeal provider observations are unavailable and must be reopened."
  });
  assert.doesNotMatch(text, new RegExp(secret));
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
