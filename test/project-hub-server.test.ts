import assert from "node:assert/strict";
import test from "node:test";

import { createTaskSealServer } from "../src/server.ts";
import type { ProjectHubSnapshot } from "../src/dashboard/project-hub.ts";

test("project hub route accepts a read-only aggregate and does not open other project runtimes", async (t) => {
  const snapshot: ProjectHubSnapshot = {
    schemaVersion: "project-hub/v1",
    generatedAt: "2026-08-07T00:00:00.000Z",
    summary: { projects: 2, running: 1, needsAttention: 1, nextUp: 2 },
    projects: [
      {
        projectRef: "alpha",
        availability: "fresh",
        errorCode: null,
        snapshot: null
      },
      {
        projectRef: "beta",
        availability: "unavailable",
        errorCode: "PROJECT_UNAVAILABLE",
        snapshot: null
      }
    ]
  };
  let reads = 0;
  const server = createTaskSealServer({
    service: {
      snapshot() { return { generatedAt: "2026-08-07T00:00:00.000Z", summary: { total: 0, planned: 0, running: 0, reviewing: 0, blocked: 0, accepted: 0, activeAgents: 0 }, workItems: [] }; },
      getWorkItem() { return null; }
    },
    providerStatus: { async list() { return { schemaVersion: 2, revision: `sha256:${"a".repeat(64)}`, observationRevision: `sha256:${"b".repeat(64)}`, operationRevision: `sha256:${"c".repeat(64)}`, providers: [], operations: [] }; } },
    async runWorkItem() {},
    projectHub: {
      async read() { reads += 1; return snapshot; }
    }
  });
  t.after(() => server.shutdown());
  const baseUrl = await listen(server);

  const response = await fetch(`${baseUrl}/api/project-hub`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), snapshot);
  assert.equal(reads, 1);
});

test("status and work routes expose the shared project operations read model", async (t) => {
  const server = createTaskSealServer({
    service: {
      snapshot() {
        return {
          generatedAt: "2026-08-07T00:00:00.000Z",
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
      getWorkItem() { return null; }
    },
    providerStatus: {
      async list() {
        return {
          schemaVersion: 2,
          revision: `sha256:${"a".repeat(64)}`,
          observationRevision: `sha256:${"b".repeat(64)}`,
          operationRevision: `sha256:${"c".repeat(64)}`,
          providers: [],
          operations: []
        };
      }
    },
    async runWorkItem() {}
  });
  t.after(() => server.shutdown());
  const baseUrl = await listen(server);

  const status = await fetch(`${baseUrl}/api/status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).schemaVersion, "project-operations/v1");

  const work = await fetch(`${baseUrl}/api/work-items`);
  assert.equal(work.status, 200);
  assert.equal((await work.json()).schemaVersion, "work-items/v1");
});

async function listen(server: ReturnType<typeof createTaskSealServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
