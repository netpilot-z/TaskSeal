import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  createTaskSealServer
} from "../src/server.ts";
import type {
  PersistentServicePort
} from "../src/server.ts";
import {
  inspectConfiguration
} from "../src/application/configuration-control.ts";

test("running Control Room exposes identity-bound configuration change and draft endpoints", async (t) => {
  const cwd = await createProject(t);
  const view = await inspectConfiguration({ cwd, environment: {} });
  let currentView = view;
  const calls: unknown[] = [];
  const receipt = {
    schemaVersion: "configuration-receipt/v1" as const,
    planDigest: `sha256:${"a".repeat(64)}`,
    previousRevision: view.revision,
    revision: `sha256:${"b".repeat(64)}`,
    applied: true,
    replayed: false,
    restartRequired: true
  };
  const server = createTaskSealServer({
    service: createPersistentService(),
    providerStatus: { async list() { return emptyProviderStatus(); } },
    async runWorkItem() { return { outcome: "completed" }; },
    configuration: {
      instanceId: "77777777-7777-4777-8777-777777777777",
      activeRuntimeRevision: view.runtimeRevision,
      async inspect() { return currentView; },
      async readDraft(scope) {
        return {
          schemaVersion: "configuration-draft/v1" as const,
          revision: view.revision,
          target: {
            scope,
            path: "config/project.json" as const,
            revision: view.source.revision
          },
          document: { project: "TaskSeal" }
        };
      },
      async applyChange(change, expectedRevision) {
        calls.push({ change, expectedRevision });
        currentView = {
          ...view,
          revision: receipt.revision,
          runtimeRevision: receipt.revision
        };
        return receipt;
      },
      async applyDraft(scope, document, expectedRevision) {
        calls.push({ scope, document, expectedRevision });
        return receipt;
      }
    }
  });
  t.after(() => server.shutdown());
  const baseUrl = await listen(server);

  const configurationResponse = await fetch(`${baseUrl}/api/configuration`);
  assert.equal(configurationResponse.status, 200);
  const configuration = await configurationResponse.json() as {
    instanceId: string;
    csrfToken: string;
    configuration: unknown;
    runtime: {
      activeRevision: string;
      desiredRevision: string;
      restartRequired: boolean;
    };
  };
  assert.equal(
    configuration.instanceId,
    "77777777-7777-4777-8777-777777777777"
  );
  assert.deepEqual(configuration.configuration, view);
  assert.deepEqual(configuration.runtime, {
    activeRevision: view.runtimeRevision,
    desiredRevision: view.runtimeRevision,
    restartRequired: false
  });

  const change = {
    operation: "set" as const,
    key: "runtime.port",
    value: 7400
  };
  const applyResponse = await fetch(`${baseUrl}/api/configuration/change`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-taskseal-csrf-token": configuration.csrfToken
    },
    body: JSON.stringify({
      expectedRevision: view.revision,
      change
    })
  });

  assert.equal(applyResponse.status, 200);
  assert.deepEqual(await applyResponse.json(), receipt);
  assert.deepEqual(calls, [{ change, expectedRevision: view.revision }]);

  const changedConfigurationResponse = await fetch(`${baseUrl}/api/configuration`);
  const changedConfiguration = await changedConfigurationResponse.json() as {
    runtime: {
      activeRevision: string;
      desiredRevision: string;
      restartRequired: boolean;
    };
  };
  assert.deepEqual(changedConfiguration.runtime, {
    activeRevision: view.runtimeRevision,
    desiredRevision: receipt.revision,
    restartRequired: true
  });

  const connectionsResponse = await fetch(`${baseUrl}/api/connections`);
  const connections = await connectionsResponse.json() as {
    schemaVersion?: unknown;
    connections?: unknown[];
  };
  assert.equal(connectionsResponse.status, 200);
  assert.equal(connections.schemaVersion, "connections/v1");
  assert.equal(connections.connections?.length, 4);

  const catalogResponse = await fetch(
    `${baseUrl}/api/presentation/catalog?locale=zh-CN`
  );
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json() as {
    locale?: unknown;
    messages?: Record<string, unknown>;
  };
  assert.equal(catalog.locale, "zh-CN");
  assert.equal(catalog.messages?.["nav.settings"], "设置");

  const draftResponse = await fetch(
    `${baseUrl}/api/configuration/drafts/project`
  );
  assert.equal(draftResponse.status, 200);
  const draftEnvelope = await draftResponse.json() as {
    instanceId?: unknown;
    draft?: { document?: unknown };
  };
  assert.equal(
    draftEnvelope.instanceId,
    "77777777-7777-4777-8777-777777777777"
  );
  assert.deepEqual(draftEnvelope.draft?.document, { project: "TaskSeal" });

  const document = { project: "TaskSeal", mode: "persistent" };
  const draftApplyResponse = await fetch(
    `${baseUrl}/api/configuration/draft`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-taskseal-csrf-token": configuration.csrfToken
      },
      body: JSON.stringify({
        expectedRevision: view.revision,
        scope: "project",
        document
      })
    }
  );
  assert.equal(draftApplyResponse.status, 200);
  assert.deepEqual(calls[1], {
    scope: "project",
    document,
    expectedRevision: view.revision
  });
});

function createPersistentService(): PersistentServicePort {
  return {
    snapshot() {
      return {
        generatedAt: "2026-08-03T12:00:00.000Z",
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
  };
}

function emptyProviderStatus() {
  return {
    schemaVersion: 2 as const,
    revision: `sha256:${"c".repeat(64)}`,
    observationRevision: `sha256:${"d".repeat(64)}`,
    operationRevision: `sha256:${"e".repeat(64)}`,
    providers: [],
    operations: []
  };
}

async function createProject(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "taskseal-config-server-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({ project: "TaskSeal" })
  );
  return cwd;
}

async function listen(server: ReturnType<typeof createTaskSealServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
