import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import {
  createControlledWriteOperation,
  parseControlledWriteOperation,
  transitionControlledWriteOperation
} from "../src/application/controlled-write-operation.ts";
import type {
  ControlledWriteOperation
} from "../src/application/controlled-write-operation.ts";
import {
  normalizeProviderOperationJournalFile,
  ProviderOperationJournal,
  ProviderOperationJournalError
} from "../src/application/provider-operation-journal.ts";
import type {
  ProviderOperationJournalFile,
  ProviderOperationJournalStoragePort
} from "../src/application/provider-operation-journal.ts";

test("operation journal commits, replays, queries, and idempotently retries exact latest records", async () => {
  const storage = new MemoryOperationStorage();
  const journal =
    await ProviderOperationJournal.open({ storage });
  const initial = operation();

  assert.equal(await journal.get(initial.plan.operationKey), null);
  assert.deepEqual(await journal.history(initial.plan.operationKey), []);
  assert.deepEqual(await journal.listLatest(), []);

  assert.deepEqual(
    await journal.compareAndAppend({
      expectedVersion: 0,
      operationKey: initial.plan.operationKey,
      planDigest: initial.plan.planDigest,
      next: initial
    }),
    {
      resolution: "committed",
      operation: initial
    }
  );
  assert.equal(storage.replaceCount, 1);

  assert.deepEqual(
    await journal.compareAndAppend({
      expectedVersion: 0,
      operationKey: initial.plan.operationKey,
      planDigest: initial.plan.planDigest,
      next: structuredClone(initial)
    }),
    {
      resolution: "idempotent",
      operation: initial
    }
  );
  assert.equal(storage.replaceCount, 1);

  const approved = approve(initial);
  assert.equal(
    (
      await journal.compareAndAppend({
        expectedVersion: 1,
        operationKey: initial.plan.operationKey,
        planDigest: initial.plan.planDigest,
        next: approved
      })
    ).resolution,
    "committed"
  );

  const history = await journal.history(
    initial.plan.operationKey
  );
  assert.deepEqual(history, [initial, approved]);
  assert.equal(Object.isFrozen(history), true);
  assert.equal(Object.isFrozen(history[0]), true);
  assert.equal(Object.isFrozen(history[0]?.plan), true);
  assert.deepEqual(await journal.listLatest(), [approved]);
  assert.deepEqual(
    await journal.get(initial.plan.operationKey),
    approved
  );

  const reopened = await ProviderOperationJournal.open({
    storage
  });
  assert.deepEqual(
    await reopened.history(initial.plan.operationKey),
    [initial, approved]
  );
});

test("operation journal replays every version from v1 and canonicalizes interleaved operations", async () => {
  const first = reconciliationChain();
  const secondInitial = operation(
    "44444444-4444-4444-8444-444444444444"
  );
  const secondRejected = transitionControlledWriteOperation(
    secondInitial,
    approvalAction(secondInitial, "reject")
  );
  const storage = new MemoryOperationStorage({
    schemaVersion: 1,
    records: [
      secondRejected,
      first[4],
      first[0],
      secondInitial,
      first[2],
      first[1],
      first[3],
      first[6],
      first[5]
    ]
  });
  const journal =
    await ProviderOperationJournal.open({ storage });

  assert.deepEqual(
    await journal.history(first[0]!.plan.operationKey),
    first
  );
  assert.deepEqual(await journal.listLatest(), [
    first.at(-1),
    secondRejected
  ]);
});

test("operation journal rejects corrupt envelopes, missing history, gaps, duplicates, and adjacent tampering", async (t) => {
  const initial = operation();
  const approved = approve(initial);
  const submitting = beginSubmission(approved);
  const changedActor = parseControlledWriteOperation({
    ...structuredClone(submitting),
    approval: {
      ...structuredClone(submitting.approval),
      actor: {
        type: "human",
        id: "attacker"
      }
    }
  });
  const customRecords = [initial];
  Object.setPrototypeOf(customRecords, null);

  const scenarios: Array<{
    name: string;
    value: unknown;
  }> = [
    {
      name: "extra envelope field",
      value: {
        schemaVersion: 1,
        records: [],
        rawPayload: "forbidden"
      }
    },
    {
      name: "custom array prototype",
      value: {
        schemaVersion: 1,
        records: customRecords
      }
    },
    {
      name: "history missing v1",
      value: {
        schemaVersion: 1,
        records: [approved]
      }
    },
    {
      name: "version gap",
      value: {
        schemaVersion: 1,
        records: [initial, submitting]
      }
    },
    {
      name: "duplicate version",
      value: {
        schemaVersion: 1,
        records: [initial, structuredClone(initial)]
      }
    },
    {
      name: "adjacent actor tampering",
      value: {
        schemaVersion: 1,
        records: [initial, approved, changedActor]
      }
    },
    {
      name: "record limit",
      value: {
        schemaVersion: 1,
        records: Array.from({ length: 513 }, () => null)
      }
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      await assert.rejects(
        ProviderOperationJournal.open({
          storage: new MemoryOperationStorage(
            scenario.value,
            false
          )
        }),
        hasCode("PROVIDER_OPERATION_JOURNAL_STORE_CORRUPT")
      );
    });
  }
});

test("compare-and-append binds expected version, operation key, and plan digest", async () => {
  const storage = new MemoryOperationStorage();
  const journal =
    await ProviderOperationJournal.open({ storage });
  const initial = operation();
  await appendInitial(journal, initial);
  const approved = approve(initial);

  await assert.rejects(
    journal.compareAndAppend({
      expectedVersion: 0,
      operationKey: initial.plan.operationKey,
      planDigest: initial.plan.planDigest,
      next: approved
    }),
    hasCode("PROVIDER_OPERATION_JOURNAL_VERSION_CONFLICT")
  );
  await assert.rejects(
    journal.compareAndAppend({
      expectedVersion: 1,
      operationKey: digest("a"),
      planDigest: initial.plan.planDigest,
      next: approved
    }),
    hasCode("PROVIDER_OPERATION_JOURNAL_INVALID")
  );
  await assert.rejects(
    journal.compareAndAppend({
      expectedVersion: 1,
      operationKey: initial.plan.operationKey,
      planDigest: digest("b"),
      next: approved
    }),
    hasCode("PROVIDER_OPERATION_JOURNAL_INVALID")
  );
  await assert.rejects(
    journal.compareAndAppend({
      expectedVersion: 1,
      operationKey: initial.plan.operationKey,
      planDigest: initial.plan.planDigest,
      next: {
        ...structuredClone(approved),
        extra: true
      } as unknown as ControlledWriteOperation
    }),
    hasCode("PROVIDER_OPERATION_JOURNAL_INVALID")
  );

  const changedPlan = operation(undefined, {
    payload: {
      title: "Changed content",
      description: "Same client UUID, different plan."
    }
  });
  await assert.rejects(
    journal.compareAndAppend({
      expectedVersion: 1,
      operationKey: changedPlan.plan.operationKey,
      planDigest: changedPlan.plan.planDigest,
      next: changedPlan
    }),
    hasCode("PROVIDER_OPERATION_JOURNAL_PLAN_CONFLICT")
  );

  await journal.compareAndAppend({
    expectedVersion: 1,
    operationKey: initial.plan.operationKey,
    planDigest: initial.plan.planDigest,
    next: approved
  });
  const submitting = beginSubmission(approved);
  await journal.compareAndAppend({
    expectedVersion: 2,
    operationKey: initial.plan.operationKey,
    planDigest: initial.plan.planDigest,
    next: submitting
  });

  await assert.rejects(
    journal.compareAndAppend({
      expectedVersion: 1,
      operationKey: initial.plan.operationKey,
      planDigest: initial.plan.planDigest,
      next: approved
    }),
    hasCode("PROVIDER_OPERATION_JOURNAL_VERSION_CONFLICT")
  );
});

test("same-instance concurrent appends issue only one committed submitting result", async () => {
  const storage = new MemoryOperationStorage();
  const journal =
    await ProviderOperationJournal.open({ storage });
  const initial = operation();
  const approved = approve(initial);
  const submitting = beginSubmission(approved);
  await appendInitial(journal, initial);
  await journal.compareAndAppend({
    expectedVersion: 1,
    operationKey: initial.plan.operationKey,
    planDigest: initial.plan.planDigest,
    next: approved
  });

  const results = await Promise.all([
    journal.compareAndAppend({
      expectedVersion: 2,
      operationKey: initial.plan.operationKey,
      planDigest: initial.plan.planDigest,
      next: submitting
    }),
    journal.compareAndAppend({
      expectedVersion: 2,
      operationKey: initial.plan.operationKey,
      planDigest: initial.plan.planDigest,
      next: structuredClone(submitting)
    })
  ]);

  assert.deepEqual(
    results.map((result) => result.resolution),
    ["committed", "idempotent"]
  );
  assert.equal(storage.replaceCount, 3);
});

test("competing successors serialize so only one can commit", async () => {
  const storage = new MemoryOperationStorage();
  const journal =
    await ProviderOperationJournal.open({ storage });
  const initial = operation();
  await appendInitial(journal, initial);
  const approved = approve(initial);
  const rejected = transitionControlledWriteOperation(
    initial,
    approvalAction(initial, "reject")
  );

  const results = await Promise.allSettled([
    journal.compareAndAppend({
      expectedVersion: 1,
      operationKey: initial.plan.operationKey,
      planDigest: initial.plan.planDigest,
      next: approved
    }),
    journal.compareAndAppend({
      expectedVersion: 1,
      operationKey: initial.plan.operationKey,
      planDigest: initial.plan.planDigest,
      next: rejected
    })
  ]);

  assert.equal(results[0]?.status, "fulfilled");
  assert.equal(results[1]?.status, "rejected");
  assert.equal(
    results[1]?.status === "rejected" &&
      hasCode(
        "PROVIDER_OPERATION_JOURNAL_VERSION_CONFLICT"
      )(results[1].reason),
    true
  );
  assert.deepEqual(
    await journal.get(initial.plan.operationKey),
    approved
  );
});

test("queries reload another instance's atomic replacement", async () => {
  const storage = new MemoryOperationStorage();
  const first = await ProviderOperationJournal.open({
    storage
  });
  const second = await ProviderOperationJournal.open({
    storage
  });
  const initial = operation();

  assert.equal(
    await first.get(initial.plan.operationKey),
    null
  );
  await appendInitial(second, initial);
  assert.deepEqual(
    await first.get(initial.plan.operationKey),
    initial
  );
});

test("opening a leftover submitting record is read-only and never grants a new commit", async () => {
  const initial = operation();
  const approved = approve(initial);
  const submitting = beginSubmission(approved);
  const storage = new MemoryOperationStorage({
    schemaVersion: 1,
    records: [initial, approved, submitting]
  });
  const journal =
    await ProviderOperationJournal.open({ storage });

  assert.deepEqual(await journal.listLatest(), [submitting]);
  assert.equal(storage.replaceCount, 0);
  assert.deepEqual(
    await journal.get(initial.plan.operationKey),
    submitting
  );
});

test("record capacity fails closed without evicting existing operation history", async () => {
  const records = Array.from(
    { length: 512 },
    (_, index) =>
      operation(
        `00000000-0000-4000-8000-${(index + 1)
          .toString(16)
          .padStart(12, "0")}`
      )
  );
  const storage = new MemoryOperationStorage({
    schemaVersion: 1,
    records
  });
  const journal =
    await ProviderOperationJournal.open({ storage });
  const overflow = operation(
    "00000000-0000-4000-8000-000000000201"
  );

  await assert.rejects(
    appendInitial(journal, overflow),
    hasCode(
      "PROVIDER_OPERATION_JOURNAL_LIMIT_EXCEEDED"
    )
  );
  assert.equal(storage.replaceCount, 0);
  assert.equal((await journal.listLatest()).length, 512);
});

test("unknown replace outcome fences the instance until reopen", async () => {
  const initial = operation();
  const storage = new MemoryOperationStorage();
  storage.afterReplace = () => {
    throw new ProviderOperationJournalError(
      "PROVIDER_OPERATION_JOURNAL_COMMIT_OUTCOME_UNKNOWN",
      "Provider operation journal commit outcome is unknown."
    );
  };
  const journal =
    await ProviderOperationJournal.open({ storage });

  await assert.rejects(
    appendInitial(journal, initial),
    hasCode(
      "PROVIDER_OPERATION_JOURNAL_COMMIT_OUTCOME_UNKNOWN"
    )
  );
  await assert.rejects(
    journal.get(initial.plan.operationKey),
    hasCode("PROVIDER_OPERATION_JOURNAL_REOPEN_REQUIRED")
  );
  await assert.rejects(
    appendInitial(journal, initial),
    hasCode("PROVIDER_OPERATION_JOURNAL_REOPEN_REQUIRED")
  );

  storage.afterReplace = undefined;
  const reopened = await ProviderOperationJournal.open({
    storage
  });
  assert.deepEqual(
    await reopened.get(initial.plan.operationKey),
    initial
  );
});

test("application journal errors redact arbitrary storage failures", async () => {
  const sentinel =
    "Bearer SECRET_APPLICATION_STORAGE_SENTINEL";
  const storage: ProviderOperationJournalStoragePort = {
    async load() {
      throw new Error(sentinel);
    },
    async replace() {
      throw new Error(sentinel);
    }
  };

  await assert.rejects(
    ProviderOperationJournal.open({ storage }),
    (error) => {
      assert.equal(
        inspect(error, { depth: 10 }).includes(sentinel),
        false
      );
      return hasCode(
        "PROVIDER_OPERATION_JOURNAL_READ_FAILED"
      )(error);
    }
  );
});

test("normalizer returns a canonical immutable file", () => {
  const chain = reconciliationChain();
  const normalized =
    normalizeProviderOperationJournalFile({
      schemaVersion: 1,
      records: [...chain].reverse()
    });

  assert.deepEqual(normalized.records, chain);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.records), true);
  assert.equal(Object.isFrozen(normalized.records[0]), true);
});

class MemoryOperationStorage
  implements ProviderOperationJournalStoragePort
{
  value: unknown;
  replaceCount = 0;
  afterReplace: (() => void) | undefined;
  readonly cloneValues: boolean;

  constructor(
    value: unknown = {
      schemaVersion: 1,
      records: []
    },
    cloneValues = true
  ) {
    this.cloneValues = cloneValues;
    this.value = cloneValues
      ? structuredClone(value)
      : value;
  }

  async load(): Promise<unknown> {
    return this.cloneValues
      ? structuredClone(this.value)
      : this.value;
  }

  async replace(
    value: ProviderOperationJournalFile
  ): Promise<void> {
    this.value = structuredClone(value);
    this.replaceCount += 1;
    this.afterReplace?.();
  }
}

async function appendInitial(
  journal: ProviderOperationJournal,
  initial: ControlledWriteOperation
) {
  return journal.compareAndAppend({
    expectedVersion: 0,
    operationKey: initial.plan.operationKey,
    planDigest: initial.plan.planDigest,
    next: initial
  });
}

function reconciliationChain(): ControlledWriteOperation[] {
  const initial = operation();
  const approved = approve(initial);
  const submitting = beginSubmission(approved);
  const unknown = transitionControlledWriteOperation(
    submitting,
    {
      type: "submission_outcome_unknown",
      occurredAt: "2026-07-27T10:03:00.000Z",
      diagnosticCode: "LINEAR_WRITE_OUTCOME_UNKNOWN"
    }
  );
  const reconciling = transitionControlledWriteOperation(
    unknown,
    {
      type: "begin_reconciliation",
      occurredAt: "2026-07-27T10:04:00.000Z"
    }
  );
  const absent = transitionControlledWriteOperation(
    reconciling,
    {
      type: "reconciliation_absent",
      occurredAt: "2026-07-27T10:05:00.000Z"
    }
  );
  const retrying = transitionControlledWriteOperation(
    absent,
    {
      type: "begin_reconciliation",
      occurredAt: "2026-07-27T10:06:00.000Z"
    }
  );

  return [
    initial,
    approved,
    submitting,
    unknown,
    reconciling,
    absent,
    retrying
  ];
}

function approve(
  value: ControlledWriteOperation
): ControlledWriteOperation {
  return transitionControlledWriteOperation(
    value,
    approvalAction(value, "approve")
  );
}

function beginSubmission(
  value: ControlledWriteOperation
): ControlledWriteOperation {
  return transitionControlledWriteOperation(value, {
    type: "begin_submission",
    occurredAt: "2026-07-27T10:02:00.000Z"
  });
}

function approvalAction(
  value: ControlledWriteOperation,
  type: "approve" | "reject"
) {
  return {
    type,
    actor: {
      type: "human" as const,
      id: "owner"
    },
    operationKey: value.plan.operationKey,
    planDigest: value.plan.planDigest,
    occurredAt: "2026-07-27T10:01:00.000Z"
  };
}

function operation(
  clientRequestId =
    "33333333-3333-4333-8333-333333333333",
  overrides: Record<string, unknown> = {}
): ControlledWriteOperation {
  return createControlledWriteOperation({
    configuredTarget: {
      kind: "team",
      key: "linear:team-ref:netpilot-z/netpilot"
    },
    resolvedTarget: {
      organizationId:
        "11111111-1111-4111-8111-111111111111",
      teamId:
        "22222222-2222-4222-8222-222222222222"
    },
    clientRequestId,
    payload: {
      title: "Create the delivery ticket",
      description: "Reviewed TaskSeal work."
    },
    preparedAt: "2026-07-27T10:00:00.000Z",
    ...overrides
  });
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
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
