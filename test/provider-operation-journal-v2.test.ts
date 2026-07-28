import assert from "node:assert/strict";
import test from "node:test";

import {
  createControlledWriteOperation,
  createControlledWriteOperationV2,
  transitionControlledWriteOperation
} from "../src/application/controlled-write-operation.ts";
import {
  normalizeProviderOperationJournalFile,
  ProviderOperationJournal
} from "../src/application/provider-operation-journal.ts";
import type {
  ProviderOperationJournalFile,
  ProviderOperationJournalStoragePort
} from "../src/application/provider-operation-journal.ts";

test("the v1 journal envelope replays independent v1 and v2 histories", async () => {
  const legacy = createControlledWriteOperation(
    v1Input(
      "11111111-1111-4111-8111-111111111111"
    )
  );
  const current = createControlledWriteOperationV2(
    v2Input(
      "22222222-2222-4222-8222-222222222222"
    )
  );
  const storage = new MemoryStorage({
    schemaVersion: 1,
    records: [current, legacy]
  });
  const journal = await ProviderOperationJournal.open({
    storage
  });

  const latest = await journal.listLatest();
  assert.equal(latest.length, 2);
  assert.deepEqual(
    new Set(
      latest.map(
        (operation) => operation.schemaVersion
      )
    ),
    new Set([1, 2])
  );
  assert.deepEqual(
    await journal.get(current.plan.operationKey),
    current
  );
  assert.deepEqual(
    await journal.history(legacy.plan.operationKey),
    [legacy]
  );
});

test("the journal rejects cross-version reuse of one client UUID", async () => {
  const clientRequestId =
    "33333333-3333-4333-8333-333333333333";
  const legacy = createControlledWriteOperation(
    v1Input(clientRequestId)
  );
  const current = createControlledWriteOperationV2(
    v2Input(clientRequestId)
  );
  const journal = await ProviderOperationJournal.open({
    storage: new MemoryStorage()
  });

  await journal.compareAndAppend({
    expectedVersion: 0,
    operationKey: legacy.plan.operationKey,
    planDigest: legacy.plan.planDigest,
    next: legacy
  });

  await assert.rejects(
    journal.compareAndAppend({
      expectedVersion: 0,
      operationKey: current.plan.operationKey,
      planDigest: current.plan.planDigest,
      next: current
    }),
    hasCode(
      "PROVIDER_OPERATION_JOURNAL_PLAN_CONFLICT"
    )
  );

  const approvedV2 =
    transitionControlledWriteOperation(current, {
      type: "approve",
      actor: {
        type: "human",
        id: "owner"
      },
      operationKey: current.plan.operationKey,
      planDigest: current.plan.planDigest,
      occurredAt: "2026-07-27T10:01:00.000Z"
    });
  assert.throws(
    () =>
      normalizeProviderOperationJournalFile({
        schemaVersion: 1,
        records: [legacy, approvedV2]
      }),
    hasCode("PROVIDER_OPERATION_JOURNAL_INVALID")
  );
});

class MemoryStorage
  implements ProviderOperationJournalStoragePort
{
  #value: ProviderOperationJournalFile;

  constructor(
    value: ProviderOperationJournalFile = {
      schemaVersion: 1,
      records: []
    }
  ) {
    this.#value = structuredClone(value);
  }

  async load(): Promise<unknown> {
    return structuredClone(this.#value);
  }

  async replace(
    value: ProviderOperationJournalFile
  ): Promise<void> {
    this.#value = structuredClone(value);
  }
}

function v1Input(clientRequestId: string) {
  return {
    configuredTarget: {
      kind: "team",
      key: "linear:team-ref:netpilot-z/netpilot"
    },
    resolvedTarget: {
      organizationId:
        "44444444-4444-4444-8444-444444444444",
      teamId:
        "55555555-5555-4555-8555-555555555555"
    },
    clientRequestId,
    payload: {
      title: "Legacy operation",
      description: "Keep v1 replayable."
    },
    preparedAt: "2026-07-27T10:00:00.000Z"
  };
}

function v2Input(clientRequestId: string) {
  return {
    configuredTarget: {
      kind: "project_state",
      key:
        "linear:project-state-ref:" +
        "netpilot-z/netpilot/TaskSeal/Backlog",
      workspace: "netpilot-z",
      team: "netpilot",
      project: "TaskSeal",
      state: "Backlog"
    },
    resolvedTarget: {
      organizationId:
        "44444444-4444-4444-8444-444444444444",
      teamId:
        "55555555-5555-4555-8555-555555555555",
      projectId:
        "66666666-6666-4666-8666-666666666666",
      stateId:
        "77777777-7777-4777-8777-777777777777",
      parentIssueId: null
    },
    clientRequestId,
    sourceIntent: {
      kind: "taskseal.linear-ticket-draft",
      source:
        "docs/tickets/0005-linear-productization-milestone.md",
      sourceTicket: "T15.2",
      idempotencyKey: digest("a"),
      draftPayloadDigest: digest("b")
    },
    payload: {
      title: "Current operation",
      description: "Bind placement and source."
    },
    preparedAt: "2026-07-27T10:00:00.000Z"
  };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}
