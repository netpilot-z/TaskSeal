import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

import {
  createLocalProviderObservationRuntime,
  createLocalProviderOperationQuery,
  startPersistentControlRoom
} from "../src/cli.ts";
import {
  createControlledWriteOperation,
  transitionControlledWriteOperation
} from "../src/application/controlled-write-operation.ts";
import {
  ProviderSyncProjectionQuery
} from "../src/application/provider-sync-projection.ts";
import {
  ProviderOperationJournal
} from "../src/application/provider-operation-journal.ts";
import {
  digestCanonicalJson
} from "../src/lib/canonical-json.ts";
import {
  FileProviderOperationJournalStorage
} from "../src/storage/provider-operation-journal.ts";

test("file-backed Provider sync reopen projects submitting read-only without coordinator recovery", async (t) => {
  const cwd = await temporaryProject(t);
  const observations =
    await createLocalProviderObservationRuntime({
      cwd,
      clock: () =>
        new Date("2026-07-27T10:00:00.000Z")
    });
  const journal =
    await ProviderOperationJournal.open({
      storage:
        new FileProviderOperationJournalStorage({
          workspaceRoot: cwd
        })
    });
  const prepared =
    createControlledWriteOperation({
      configuredTarget: {
        kind: "team",
        key:
          "linear:team-ref:netpilot-z/netpilot"
      },
      resolvedTarget: {
        organizationId:
          "33333333-3333-4333-8333-333333333333",
        teamId:
          "22222222-2222-4222-8222-222222222222"
      },
      clientRequestId:
        "11111111-1111-4111-8111-111111111111",
      payload: {
        title: "SECRET_RUNTIME_TITLE",
        description:
          "SECRET_RUNTIME_DESCRIPTION"
      },
      preparedAt:
        "2026-07-27T10:00:01.000Z"
    });
  const approved =
    transitionControlledWriteOperation(
      prepared,
      {
        type: "approve",
        actor: {
          type: "human",
          id: "SECRET_RUNTIME_ACTOR"
        },
        operationKey:
          prepared.plan.operationKey,
        planDigest:
          prepared.plan.planDigest,
        occurredAt:
          "2026-07-27T10:00:02.000Z"
      }
    );
  const submitting =
    transitionControlledWriteOperation(
      approved,
      {
        type: "begin_submission",
        occurredAt:
          "2026-07-27T10:00:03.000Z"
      }
    );
  for (const [expectedVersion, operation] of [
    [0, prepared],
    [1, approved],
    [2, submitting]
  ] as const) {
    await journal.compareAndAppend({
      expectedVersion,
      operationKey:
        operation.plan.operationKey,
      planDigest:
        operation.plan.planDigest,
      next: operation
    });
  }

  const reopenedObservations =
    await createLocalProviderObservationRuntime({
      cwd,
      clock: () =>
        new Date("2026-07-27T11:00:00.000Z")
    });
  const reopenedOperations =
    await createLocalProviderOperationQuery({
      cwd
    });
  assert.equal(
    "compareAndAppend" in reopenedOperations,
    false
  );
  const projection =
    await new ProviderSyncProjectionQuery({
      observations:
        reopenedObservations.readModel,
      operations: reopenedOperations
    }).list();

  assert.equal(projection.schemaVersion, 2);
  assert.equal(
    projection.operations[0]?.status,
    "submitting"
  );
  assert.equal(
    (
      await reopenedOperations.listLatest()
    )[0]?.status,
    "submitting"
  );
  assert.doesNotMatch(
    JSON.stringify(projection),
    /SECRET_RUNTIME/
  );
});

test("a corrupt operation journal prevents persistent startup before runner or server creation", async (t) => {
  const cwd = await temporaryProject(t);
  await mkdir(join(cwd, ".taskseal"), {
    recursive: true
  });
  await writeFile(
    join(
      cwd,
      ".taskseal",
      "provider-operations.json"
    ),
    "{",
    "utf8"
  );
  let runtimeCreated = false;
  let serverCreated = false;

  await assert.rejects(
    startPersistentControlRoom({
      cwd,
      output: {
        write() {}
      },
      initialize: async () => {},
      assessReadiness:
        async () => ({
          node: {
            ready: true,
            version: "v24.12.0",
            failure: ""
          },
          project: {
            ready: true
          },
          capabilities: {
            github: "ready",
            linear: "ready",
            gitee: "disabled",
            feishu: "disabled"
          },
          codex: {
            available: true,
            loggedIn: true,
            version:
              "codex-cli test"
          },
          ready: true
        }),
      providerObservationRuntimeFactory:
        async () => ({
          readModel: {
            async list() {
              return {
                schemaVersion: 1,
                revision:
                  digestCanonicalJson([]),
                providers: []
              };
            }
          }
        }),
      runtimeFactory: async () => {
        runtimeCreated = true;
        throw new Error(
          "runtime must not be created"
        );
      },
      serverFactory: () => {
        serverCreated = true;
        throw new Error(
          "server must not be created"
        );
      },
      signalSource: new EventEmitter()
    }),
    hasCode(
      "PROVIDER_OPERATION_JOURNAL_STORE_CORRUPT"
    )
  );
  assert.equal(runtimeCreated, false);
  assert.equal(serverCreated, false);
});

async function temporaryProject(
  t: TestContext
): Promise<string> {
  const cwd = await mkdtemp(
    join(tmpdir(), "taskseal-provider-sync-")
  );
  t.after(() =>
    rm(cwd, {
      recursive: true,
      force: true
    })
  );
  await mkdir(join(cwd, "config"), {
    recursive: true
  });
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({
      project: "TaskSeal",
      github: {
        repository: "netpilot-z/TaskSeal"
      },
      linear: {
        workspace: "netpilot-z",
        team: "netpilot"
      },
      mode: "persistent"
    }),
    "utf8"
  );
  return cwd;
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}
