import assert from "node:assert/strict";
import test from "node:test";

import {
  createControlledTransitionOperation,
  transitionControlledTransitionOperation
} from "../src/application/controlled-transition-operation.ts";
import {
  createControlledWriteOperation
} from "../src/application/controlled-write-operation.ts";
import {
  ProviderOperationJournal
} from "../src/application/provider-operation-journal.ts";
import type {
  ProviderOperationJournalFile
} from "../src/application/provider-operation-journal.ts";

test("one provider operation journal replays legacy create and transition v3 histories", async () => {
  const storage = new MemoryStorage();
  const journal =
    await ProviderOperationJournal.open({
      storage
    });
  const create =
    createControlledWriteOperation({
      configuredTarget: {
        kind: "team",
        key:
          "linear:team-ref:netpilot-z/netpilot"
      },
      resolvedTarget: {
        organizationId:
          "7eb4877f-0fa0-429c-9cd2-76dfffa0f20b",
        teamId:
          "658d1189-f63d-4245-b761-0f4f2c389663"
      },
      clientRequestId:
        "33333333-3333-4333-8333-333333333333",
      payload: {
        title: "Legacy create",
        description: ""
      },
      preparedAt:
        "2026-07-28T00:00:00.000Z"
    });
  const transition =
    createControlledTransitionOperation(
      transitionInput()
    );

  await journal.compareAndAppend({
    expectedVersion: 0,
    operationKey:
      create.plan.operationKey,
    planDigest: create.plan.planDigest,
    next: create
  });
  await journal.compareAndAppend({
    expectedVersion: 0,
    operationKey:
      transition.plan.operationKey,
    planDigest:
      transition.plan.planDigest,
    next: transition
  });
  const approved =
    transitionControlledTransitionOperation(
      transition,
      {
        type: "approve",
        actor: {
          type: "human",
          id: "operator.jeffrey"
        },
        operationKey:
          transition.plan.operationKey,
        planDigest:
          transition.plan.planDigest,
        occurredAt:
          "2026-07-28T00:06:00.000Z"
      }
    );
  await journal.compareAndAppend({
    expectedVersion: 1,
    operationKey:
      approved.plan.operationKey,
    planDigest: approved.plan.planDigest,
    next: approved
  });

  const reopened =
    await ProviderOperationJournal.open({
      storage
    });
  const latest =
    await reopened.listLatest();
  assert.equal(latest.length, 2);
  assert.deepEqual(
    await reopened.history(
      transition.plan.operationKey
    ),
    [transition, approved]
  );
  assert.equal(
    (
      await reopened.get(
        transition.plan.operationKey
      )
    )?.schemaVersion,
    3
  );
});

class MemoryStorage {
  value: ProviderOperationJournalFile = {
    schemaVersion: 1,
    records: []
  };

  async load(): Promise<unknown> {
    return structuredClone(this.value);
  }

  async replace(
    value: ProviderOperationJournalFile
  ): Promise<void> {
    this.value = structuredClone(value);
  }
}

function transitionInput() {
  return {
    configuredTarget: {
      workspace: "netpilot-z",
      team: "netpilot",
      project: "TaskSeal",
      expectedState: "Todo",
      targetState: "Done"
    },
    resolvedTarget: {
      organizationId:
        "7eb4877f-0fa0-429c-9cd2-76dfffa0f20b",
      teamId:
        "658d1189-f63d-4245-b761-0f4f2c389663",
      projectId:
        "3e1b05e6-0a14-43d4-9fed-e1bee6ef0683",
      issueId:
        "70cbe548-5e6c-4d35-b019-a570058a8cf2",
      expectedStateId:
        "3d2677e2-2192-48c1-8fb9-e6da2dedf95f",
      expectedRevisionId:
        "2026-07-28T00:05:00.000Z",
      targetStateId:
        "2d716bbd-be75-4718-95c9-27f184d19e56"
    },
    sourceIntent: {
      workItemId: "TS-NP-7",
      decisionId:
        "11111111-1111-4111-8111-111111111111",
      reviewRevision:
        `sha256:${"1".repeat(64)}`,
      acceptanceDigest:
        `sha256:${"2".repeat(64)}`
    },
    preparedAt:
      "2026-07-28T00:05:30.000Z"
  };
}
