import assert from "node:assert/strict";
import {
  mkdtemp,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ControlledWriteCoordinator
} from "../src/application/controlled-write-coordinator.ts";
import type {
  ControlledWriteCoordinatorJournalPort
} from "../src/application/controlled-write-coordinator.ts";
import {
  transitionControlledWriteOperation
} from "../src/application/controlled-write-operation.ts";
import type {
  ControlledWriteOperation,
  ControlledWriteOperationStatus
} from "../src/application/controlled-write-operation.ts";
import {
  ProviderOperationJournal,
  ProviderOperationJournalError
} from "../src/application/provider-operation-journal.ts";
import type {
  ProviderOperationAppendInput,
  ProviderOperationAppendResult,
  ProviderOperationJournalCommandPort,
  ProviderOperationJournalFile,
  ProviderOperationJournalQueryPort,
  ProviderOperationJournalStoragePort
} from "../src/application/provider-operation-journal.ts";
import type {
  ProviderOperation
} from "../src/application/provider-operation.ts";
import type {
  LinearWriteTransportPort
} from "../src/application/linear-write-transport.ts";
import {
  FileProviderOperationJournalStorage
} from "../src/storage/provider-operation-journal.ts";
import {
  FakeLinearWriteGraphql
} from "../test-support/fake-linear-write-graphql.ts";
import {
  InjectedLinearWriteTransport
} from "../src/connectors/linear-write-transport.ts";

const CLIENT_REQUEST_ID =
  "11111111-1111-4111-8111-111111111111";
const SECOND_CLIENT_REQUEST_ID =
  "44444444-4444-4444-8444-444444444444";
const ORGANIZATION_ID =
  "33333333-3333-4333-8333-333333333333";
const TEAM_ID =
  "22222222-2222-4222-8222-222222222222";
const PREPARE_INPUT = {
  configuredTarget: {
    kind: "team",
    key: "linear:team-ref:taskseal/netpilot"
  },
  resolvedTarget: {
    organizationId: ORGANIZATION_ID,
    teamId: TEAM_ID
  },
  clientRequestId: CLIENT_REQUEST_ID,
  payload: {
    title: "Ship the controlled write coordinator",
    description: "Prove one permit and safe reconciliation."
  }
} as const;
const SECOND_PREPARE_INPUT = {
  ...PREPARE_INPUT,
  clientRequestId: SECOND_CLIENT_REQUEST_ID,
  payload: {
    title: "Ship a second controlled operation",
    description: "Prove distinct operations can run concurrently."
  }
} as const;

test("coordinator persists prepare, approval, one create, and an idempotent terminal result", async () => {
  const fake = new FakeLinearWriteGraphql();
  const harness = await createHarness(fake);

  const prepared =
    await harness.coordinator.prepare(
      PREPARE_INPUT
    );
  const preparedAgain =
    await harness.coordinator.prepare(
      PREPARE_INPUT
    );
  const approved =
    await harness.coordinator.approve(
      approvalInput(prepared)
    );
  const approvedAgain =
    await harness.coordinator.approve(
      approvalInput(prepared)
    );
  const created =
    await harness.coordinator.submit(
      operationInput(prepared)
    );
  const createdAgain =
    await harness.coordinator.submit(
      operationInput(prepared)
    );

  assert.equal(prepared.status, "approval_required");
  assert.equal(prepared.version, 1);
  assert.deepEqual(preparedAgain, prepared);
  assert.equal(approved.status, "approved");
  assert.equal(approved.version, 2);
  assert.deepEqual(approvedAgain, approved);
  assert.equal(created.status, "created");
  assert.equal(created.version, 4);
  assert.deepEqual(createdAgain, created);
  assert.equal(fake.externalWriteCount, 1);
  assert.equal(fake.requestCount, 1);
  assert.deepEqual(
    (
      await harness.coordinator.history(
        prepared.plan.operationKey
      )
    ).map((operation) => operation.status),
    [
      "approval_required",
      "approved",
      "submitting",
      "created"
    ]
  );
});

test("rejection is idempotent and always keeps transport at zero calls", async () => {
  const fake = new FakeLinearWriteGraphql();
  const harness = await createHarness(fake);
  const prepared =
    await harness.coordinator.prepare(
      PREPARE_INPUT
    );
  const rejected =
    await harness.coordinator.reject(
      approvalInput(prepared)
    );
  const rejectedAgain =
    await harness.coordinator.reject(
      approvalInput(prepared)
    );

  assert.equal(rejected.status, "rejected");
  assert.deepEqual(rejectedAgain, rejected);
  await assert.rejects(
    harness.coordinator.submit(
      operationInput(prepared)
    ),
    hasCode(
      "CONTROLLED_WRITE_COORDINATOR_STATE_INVALID"
    )
  );
  await assert.rejects(
    harness.coordinator.approve(
      approvalInput(prepared)
    ),
    hasCode(
      "CONTROLLED_WRITE_COORDINATOR_APPROVAL_CONFLICT"
    )
  );
  assert.equal(fake.requestCount, 0);
  assert.equal(fake.externalWriteCount, 0);
});

test("prepare and approval fail closed on payload, scope, plan, and actor conflicts", async () => {
  const fake = new FakeLinearWriteGraphql();
  const harness = await createHarness(fake);
  const prepared =
    await harness.coordinator.prepare(
      PREPARE_INPUT
    );

  await assert.rejects(
    harness.coordinator.prepare({
      ...PREPARE_INPUT,
      payload: {
        ...PREPARE_INPUT.payload,
        title: "A different payload"
      }
    }),
    hasCode(
      "CONTROLLED_WRITE_COORDINATOR_PLAN_CONFLICT"
    )
  );
  await assert.rejects(
    harness.coordinator.approve({
      ...approvalInput(prepared),
      planDigest: `sha256:${"f".repeat(64)}`
    }),
    hasCode(
      "CONTROLLED_WRITE_COORDINATOR_PLAN_CONFLICT"
    )
  );

  await harness.coordinator.approve(
    approvalInput(prepared)
  );
  await assert.rejects(
    harness.coordinator.approve({
      ...approvalInput(prepared),
      actor: {
        type: "human",
        id: "another-owner"
      }
    }),
    hasCode(
      "CONTROLLED_WRITE_COORDINATOR_APPROVAL_CONFLICT"
    )
  );
  assert.equal(fake.requestCount, 0);
});

test("same-instance concurrent submit consumes exactly one create permit", async () => {
  const fake = new FakeLinearWriteGraphql();
  const harness = await createHarness(fake);
  const prepared =
    await harness.coordinator.prepare(
      PREPARE_INPUT
    );
  await harness.coordinator.approve(
    approvalInput(prepared)
  );

  const [left, right] = await Promise.all([
    harness.coordinator.submit(
      operationInput(prepared)
    ),
    harness.coordinator.submit(
      operationInput(prepared)
    )
  ]);

  assert.equal(left.status, "created");
  assert.deepEqual(right, left);
  assert.equal(fake.externalWriteCount, 1);
  assert.equal(fake.requestCount, 1);
  assert.equal(
    (
      await harness.coordinator.history(
        prepared.plan.operationKey
      )
    ).length,
    4
  );
});

test("an older queue tail cannot detach a newer command for the same operation", async () => {
  let releaseTransport: (() => void) | undefined;
  let markEntered: (() => void) | undefined;
  const release = new Promise<void>((resolve) => {
    releaseTransport = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let requestCount = 0;
  const transport: LinearWriteTransportPort = {
    async createIssue(input) {
      requestCount += 1;
      markEntered?.();
      await release;
      return {
        kind: "created",
        issue: {
          id: input.clientRequestId,
          identifier: "NP-100"
        },
        observedTeamId: input.teamId
      };
    },
    async queryByClientUuid() {
      return { kind: "absent" };
    }
  };
  const journal =
    await ProviderOperationJournal.open({
      storage: new MemoryOperationStorage()
    });
  const coordinator =
    await ControlledWriteCoordinator.open({
      journal,
      transport,
      clock: monotonicClock()
    });
  const prepared = await coordinator.prepare(
    PREPARE_INPUT
  );

  const approval = coordinator.approve(
    approvalInput(prepared)
  );
  const firstSubmission = coordinator.submit(
    operationInput(prepared)
  );
  await entered;
  const secondSubmission = coordinator.submit(
    operationInput(prepared)
  );
  releaseTransport?.();

  const [, firstResult, secondResult] =
    await Promise.all([
      approval,
      firstSubmission,
      secondSubmission
    ]);
  assert.equal(firstResult.status, "created");
  assert.deepEqual(secondResult, firstResult);
  assert.equal(requestCount, 1);
});

test("different operations can enter the transport concurrently", async () => {
  let entered = 0;
  let releaseTransport: (() => void) | undefined;
  let markBothEntered: (() => void) | undefined;
  const release = new Promise<void>((resolve) => {
    releaseTransport = resolve;
  });
  const bothEntered = new Promise<void>((resolve) => {
    markBothEntered = resolve;
  });
  const transport: LinearWriteTransportPort = {
    async createIssue(input) {
      entered += 1;
      if (entered === 2) {
        markBothEntered?.();
      }
      await release;
      return {
        kind: "created",
        issue: {
          id: input.clientRequestId,
          identifier:
            input.clientRequestId ===
            CLIENT_REQUEST_ID
              ? "NP-101"
              : "NP-102"
        },
        observedTeamId: input.teamId
      };
    },
    async queryByClientUuid() {
      return { kind: "absent" };
    }
  };
  const journal =
    await ProviderOperationJournal.open({
      storage: new MemoryOperationStorage()
    });
  const coordinator =
    await ControlledWriteCoordinator.open({
      journal,
      transport,
      clock: monotonicClock()
    });
  const first = await coordinator.prepare(
    PREPARE_INPUT
  );
  const second = await coordinator.prepare(
    SECOND_PREPARE_INPUT
  );
  await coordinator.approve(
    approvalInput(first)
  );
  await coordinator.approve(
    approvalInput(second)
  );

  const submissions = Promise.all([
    coordinator.submit(operationInput(first)),
    coordinator.submit(operationInput(second))
  ]);
  await Promise.race([
    bothEntered,
    rejectAfter(
      1_000,
      "Distinct operations did not enter transport concurrently."
    )
  ]);
  assert.equal(entered, 2);
  releaseTransport?.();

  const results = await submissions;
  assert.deepEqual(
    results.map((operation) => operation.status),
    ["created", "created"]
  );
});

test("response loss becomes unknown and explicit UUID reconciliation converges to found", async () => {
  const fake = new FakeLinearWriteGraphql({
    createMode: "response_lost"
  });
  const harness = await createHarness(fake);
  const prepared =
    await harness.coordinator.prepare(
      PREPARE_INPUT
    );
  await harness.coordinator.approve(
    approvalInput(prepared)
  );

  const unknown =
    await harness.coordinator.submit(
      operationInput(prepared)
    );
  const repeatedSubmit =
    await harness.coordinator.submit(
      operationInput(prepared)
    );
  const reconciled =
    await harness.coordinator.reconcile(
      operationInput(prepared)
    );

  assert.equal(unknown.status, "outcome_unknown");
  assert.deepEqual(repeatedSubmit, unknown);
  assert.equal(reconciled.status, "reconciled");
  assert.equal(
    reconciled.reconciliation?.result,
    "found"
  );
  assert.equal(fake.externalWriteCount, 1);
  assert.equal(fake.requestCount, 2);
  assert.deepEqual(
    (
      await harness.coordinator.history(
        prepared.plan.operationKey
      )
    ).map((operation) => operation.status),
    [
      "approval_required",
      "approved",
      "submitting",
      "outcome_unknown",
      "reconciling",
      "reconciled"
    ]
  );
});

test("known not-dispatched create becomes terminal failed without an external write", async () => {
  const fake = new FakeLinearWriteGraphql({
    createMode: "not_dispatched"
  });
  const harness = await createHarness(fake);
  const prepared =
    await harness.coordinator.prepare(
      PREPARE_INPUT
    );
  await harness.coordinator.approve(
    approvalInput(prepared)
  );

  const failed =
    await harness.coordinator.submit(
      operationInput(prepared)
    );
  const repeated =
    await harness.coordinator.submit(
      operationInput(prepared)
    );

  assert.equal(failed.status, "failed");
  assert.equal(
    failed.diagnosticCode,
    "LINEAR_WRITE_NOT_DISPATCHED"
  );
  assert.deepEqual(repeated, failed);
  assert.equal(fake.requestCount, 1);
  assert.equal(fake.externalWriteCount, 0);
});

test("absent reconciliation stays fenced and only an explicit action queries again", async () => {
  const fake = new FakeLinearWriteGraphql({
    createMode: "timeout"
  });
  const harness = await createHarness(fake);
  const prepared =
    await harness.coordinator.prepare(
      PREPARE_INPUT
    );
  await harness.coordinator.approve(
    approvalInput(prepared)
  );
  await harness.coordinator.submit(
    operationInput(prepared)
  );

  const absent =
    await harness.coordinator.reconcile(
      operationInput(prepared)
    );
  assert.equal(
    absent.status,
    "reconciliation_absent"
  );
  assert.equal(fake.externalWriteCount, 1);
  assert.equal(fake.requestCount, 2);

  await Promise.resolve();
  assert.equal(fake.requestCount, 2);
  assert.deepEqual(
    await harness.coordinator.submit(
      operationInput(prepared)
    ),
    absent
  );
  assert.equal(fake.externalWriteCount, 1);

  const absentAgain =
    await harness.coordinator.reconcile(
      operationInput(prepared)
    );
  assert.equal(
    absentAgain.status,
    "reconciliation_absent"
  );
  assert.equal(absentAgain.version, 8);
  assert.equal(fake.requestCount, 3);
  assert.equal(fake.externalWriteCount, 1);
});

test("failed and ambiguous queries stay unknown with distinct safe diagnostics", async (t) => {
  for (const queryMode of [
    "http_error",
    "ambiguous"
  ] as const) {
    await t.test(queryMode, async () => {
      const fake = new FakeLinearWriteGraphql({
        createMode: "timeout",
        queryMode
      });
      const harness = await createHarness(fake);
      const prepared =
        await harness.coordinator.prepare(
          PREPARE_INPUT
        );
      await harness.coordinator.approve(
        approvalInput(prepared)
      );
      await harness.coordinator.submit(
        operationInput(prepared)
      );

      const result =
        await harness.coordinator.reconcile(
          operationInput(prepared)
        );
      assert.equal(
        result.status,
        "outcome_unknown"
      );
      assert.equal(
        result.reconciliation?.result,
        queryMode === "ambiguous"
          ? "ambiguous"
          : "failed"
      );
      assert.equal(
        result.diagnosticCode,
        queryMode === "ambiguous"
          ? "LINEAR_RECONCILIATION_AMBIGUOUS"
          : "LINEAR_RECONCILIATION_FAILED"
      );
      assert.equal(fake.externalWriteCount, 1);
      assert.equal(fake.requestCount, 2);
    });
  }
});

test("unknown journal outcome while persisting submitting never grants transport", async () => {
  const fake = new FakeLinearWriteGraphql();
  const storage = new MemoryOperationStorage();
  const delegate =
    await ProviderOperationJournal.open({
      storage
    });
  const journal = new FailOnceJournal({
    delegate,
    status: "submitting",
    mode: "commit_then_unknown"
  });
  const coordinator =
    await ControlledWriteCoordinator.open({
      journal,
      transport:
        new InjectedLinearWriteTransport(
          fake.exchange
        ),
      clock: monotonicClock()
    });
  const prepared = await coordinator.prepare(
    PREPARE_INPUT
  );
  await coordinator.approve(
    approvalInput(prepared)
  );

  await assert.rejects(
    coordinator.submit(
      operationInput(prepared)
    ),
    hasCode(
      "PROVIDER_OPERATION_JOURNAL_COMMIT_OUTCOME_UNKNOWN"
    )
  );
  assert.equal(fake.requestCount, 0);
  assert.equal(fake.externalWriteCount, 0);
  assert.equal(
    (await delegate.get(prepared.plan.operationKey))
      ?.status,
    "submitting"
  );

  const reopened =
    await ControlledWriteCoordinator.open({
      journal: delegate,
      transport:
        new InjectedLinearWriteTransport(
          fake.exchange
        ),
      clock: monotonicClock()
    });
  assert.equal(
    (
      await reopened.get(
        prepared.plan.operationKey
      )
    )?.status,
    "outcome_unknown"
  );
  assert.equal(fake.requestCount, 0);
});

test("an idempotent submitting append never grants transport ownership", async () => {
  const fake = new FakeLinearWriteGraphql();
  const storage = new MemoryOperationStorage();
  const delegate =
    await ProviderOperationJournal.open({
      storage
    });
  const journal = new FailOnceJournal({
    delegate,
    status: "submitting",
    mode: "commit_then_idempotent"
  });
  const coordinator =
    await ControlledWriteCoordinator.open({
      journal,
      transport:
        new InjectedLinearWriteTransport(
          fake.exchange
        ),
      clock: monotonicClock()
    });
  const prepared = await coordinator.prepare(
    PREPARE_INPUT
  );
  await coordinator.approve(
    approvalInput(prepared)
  );

  await assert.rejects(
    coordinator.submit(
      operationInput(prepared)
    ),
    hasCode(
      "CONTROLLED_WRITE_COORDINATOR_REOPEN_REQUIRED"
    )
  );
  assert.equal(fake.requestCount, 0);
  assert.equal(fake.externalWriteCount, 0);
  assert.equal(
    (await delegate.get(prepared.plan.operationKey))
      ?.status,
    "submitting"
  );
});

test("a known pre-commit submitting failure grants no permit and remains retryable", async () => {
  const fake = new FakeLinearWriteGraphql();
  const delegate =
    await ProviderOperationJournal.open({
      storage: new MemoryOperationStorage()
    });
  const coordinator =
    await ControlledWriteCoordinator.open({
      journal: new FailOnceJournal({
        delegate,
        status: "submitting",
        mode: "throw_before"
      }),
      transport:
        new InjectedLinearWriteTransport(
          fake.exchange
        ),
      clock: monotonicClock()
    });
  const prepared = await coordinator.prepare(
    PREPARE_INPUT
  );
  await coordinator.approve(
    approvalInput(prepared)
  );

  await assert.rejects(
    coordinator.submit(
      operationInput(prepared)
    ),
    hasCode(
      "PROVIDER_OPERATION_JOURNAL_WRITE_FAILED"
    )
  );
  assert.equal(fake.requestCount, 0);
  assert.equal(
    (
      await coordinator.get(
        prepared.plan.operationKey
      )
    )?.status,
    "approved"
  );

  const created = await coordinator.submit(
    operationInput(prepared)
  );
  assert.equal(created.status, "created");
  assert.equal(fake.requestCount, 1);
  assert.equal(fake.externalWriteCount, 1);
});

test("reconciliation calls require a newly committed begin transition", async (t) => {
  for (const scenario of [
    {
      mode: "throw_before",
      code:
        "PROVIDER_OPERATION_JOURNAL_WRITE_FAILED",
      fenced: false
    },
    {
      mode: "commit_then_idempotent",
      code:
        "CONTROLLED_WRITE_COORDINATOR_REOPEN_REQUIRED",
      fenced: true
    },
    {
      mode: "commit_then_unknown",
      code:
        "PROVIDER_OPERATION_JOURNAL_COMMIT_OUTCOME_UNKNOWN",
      fenced: true
    }
  ] as const) {
    await t.test(scenario.mode, async () => {
      const fake = new FakeLinearWriteGraphql({
        createMode: "timeout"
      });
      const delegate =
        await ProviderOperationJournal.open({
          storage:
            new MemoryOperationStorage()
        });
      const coordinator =
        await ControlledWriteCoordinator.open({
          journal: new FailOnceJournal({
            delegate,
            status: "reconciling",
            mode: scenario.mode
          }),
          transport:
            new InjectedLinearWriteTransport(
              fake.exchange
            ),
          clock: monotonicClock()
        });
      const prepared =
        await coordinator.prepare(
          PREPARE_INPUT
        );
      await coordinator.approve(
        approvalInput(prepared)
      );
      await coordinator.submit(
        operationInput(prepared)
      );
      const requestCountBefore =
        fake.requestCount;

      await assert.rejects(
        coordinator.reconcile(
          operationInput(prepared)
        ),
        hasCode(scenario.code)
      );
      assert.equal(
        fake.requestCount,
        requestCountBefore
      );

      if (scenario.fenced) {
        await assert.rejects(
          coordinator.get(
            prepared.plan.operationKey
          ),
          hasCode(
            "CONTROLLED_WRITE_COORDINATOR_REOPEN_REQUIRED"
          )
        );
        assert.equal(
          (
            await delegate.get(
              prepared.plan.operationKey
            )
          )?.status,
          "reconciling"
        );
      } else {
        assert.equal(
          (
            await coordinator.get(
              prepared.plan.operationKey
            )
          )?.status,
          "outcome_unknown"
        );
        const absent =
          await coordinator.reconcile(
            operationInput(prepared)
          );
        assert.equal(
          absent.status,
          "reconciliation_absent"
        );
        assert.equal(
          fake.requestCount,
          requestCountBefore + 1
        );
      }
    });
  }
});

test("a result persistence failure fences the instance and restart reconciles without a second create", async () => {
  const fake = new FakeLinearWriteGraphql();
  const storage = new MemoryOperationStorage();
  const delegate =
    await ProviderOperationJournal.open({
      storage
    });
  const journal = new FailOnceJournal({
    delegate,
    status: "created",
    mode: "throw_before"
  });
  const coordinator =
    await ControlledWriteCoordinator.open({
      journal,
      transport:
        new InjectedLinearWriteTransport(
          fake.exchange
        ),
      clock: monotonicClock()
    });
  const prepared = await coordinator.prepare(
    PREPARE_INPUT
  );
  await coordinator.approve(
    approvalInput(prepared)
  );

  await assert.rejects(
    coordinator.submit(
      operationInput(prepared)
    ),
    hasCode(
      "PROVIDER_OPERATION_JOURNAL_WRITE_FAILED"
    )
  );
  assert.equal(fake.externalWriteCount, 1);
  assert.equal(fake.requestCount, 1);
  await assert.rejects(
    coordinator.get(prepared.plan.operationKey),
    hasCode(
      "CONTROLLED_WRITE_COORDINATOR_REOPEN_REQUIRED"
    )
  );
  assert.equal(
    (await delegate.get(prepared.plan.operationKey))
      ?.status,
    "submitting"
  );

  const reopened =
    await ControlledWriteCoordinator.open({
      journal: delegate,
      transport:
        new InjectedLinearWriteTransport(
          fake.exchange
        ),
      clock: monotonicClock()
    });
  assert.equal(
    (
      await reopened.get(
        prepared.plan.operationKey
      )
    )?.status,
    "outcome_unknown"
  );
  const reconciled = await reopened.reconcile(
    operationInput(prepared)
  );
  assert.equal(reconciled.status, "reconciled");
  assert.equal(fake.externalWriteCount, 1);
  assert.equal(fake.requestCount, 2);
});

test("a reconciliation result persistence failure fences before any further query", async () => {
  const fake = new FakeLinearWriteGraphql({
    createMode: "timeout"
  });
  const delegate =
    await ProviderOperationJournal.open({
      storage: new MemoryOperationStorage()
    });
  const coordinator =
    await ControlledWriteCoordinator.open({
      journal: new FailOnceJournal({
        delegate,
        status: "reconciliation_absent",
        mode: "throw_before"
      }),
      transport:
        new InjectedLinearWriteTransport(
          fake.exchange
        ),
      clock: monotonicClock()
    });
  const prepared = await coordinator.prepare(
    PREPARE_INPUT
  );
  await coordinator.approve(
    approvalInput(prepared)
  );
  await coordinator.submit(
    operationInput(prepared)
  );

  await assert.rejects(
    coordinator.reconcile(
      operationInput(prepared)
    ),
    hasCode(
      "PROVIDER_OPERATION_JOURNAL_WRITE_FAILED"
    )
  );
  assert.equal(fake.requestCount, 2);
  assert.equal(
    (
      await delegate.get(
        prepared.plan.operationKey
      )
    )?.status,
    "reconciling"
  );
  await assert.rejects(
    coordinator.reconcile(
      operationInput(prepared)
    ),
    hasCode(
      "CONTROLLED_WRITE_COORDINATOR_REOPEN_REQUIRED"
    )
  );
  assert.equal(fake.requestCount, 2);

  await ControlledWriteCoordinator.open({
    journal: delegate,
    transport:
      new InjectedLinearWriteTransport(
        fake.exchange
      ),
    clock: monotonicClock(
      "2026-07-27T12:00:20.000Z"
    )
  });
  assert.equal(fake.requestCount, 2);
  assert.equal(
    (
      await delegate.get(
        prepared.plan.operationKey
      )
    )?.status,
    "outcome_unknown"
  );
});

test("file-backed restart converts leftover submitting and reconciling without transport calls", async () => {
  const workspace = await mkdtemp(
    join(tmpdir(), "taskseal-coordinator-")
  );

  try {
    const fake = new FakeLinearWriteGraphql();
    const firstJournal =
      await ProviderOperationJournal.open({
        storage:
          new FileProviderOperationJournalStorage({
            workspaceRoot: workspace
          })
      });
    const first =
      await ControlledWriteCoordinator.open({
        journal: firstJournal,
        transport:
          new InjectedLinearWriteTransport(
            fake.exchange
          ),
        clock: monotonicClock()
      });
    const prepared = await first.prepare(
      PREPARE_INPUT
    );
    const approved = await first.approve(
      approvalInput(prepared)
    );
    const submitting =
      transitionControlledWriteOperation(
        approved,
        {
          type: "begin_submission",
          occurredAt:
            "2026-07-27T12:00:10.000Z"
        }
      );
    await firstJournal.compareAndAppend({
      expectedVersion: approved.version,
      operationKey:
        approved.plan.operationKey,
      planDigest: approved.plan.planDigest,
      next: submitting
    });

    const secondJournal =
      await ProviderOperationJournal.open({
        storage:
          new FileProviderOperationJournalStorage({
            workspaceRoot: workspace
          })
      });
    const second =
      await ControlledWriteCoordinator.open({
        journal: secondJournal,
        transport:
          new InjectedLinearWriteTransport(
            fake.exchange
          ),
        clock: monotonicClock(
          "2026-07-27T12:00:20.000Z"
        )
      });
    assert.equal(
      (
        await second.get(
          prepared.plan.operationKey
        )
      )?.status,
      "outcome_unknown"
    );
    assert.equal(fake.requestCount, 0);

    const reconciling =
      transitionControlledWriteOperation(
        requireOperation(
          await second.get(
            prepared.plan.operationKey
          )
        ),
        {
          type: "begin_reconciliation",
          occurredAt:
            "2026-07-27T12:00:30.000Z"
        }
      );
    await secondJournal.compareAndAppend({
      expectedVersion:
        reconciling.version - 1,
      operationKey:
        reconciling.plan.operationKey,
      planDigest:
        reconciling.plan.planDigest,
      next: reconciling
    });

    const thirdJournal =
      await ProviderOperationJournal.open({
        storage:
          new FileProviderOperationJournalStorage({
            workspaceRoot: workspace
          })
      });
    const third =
      await ControlledWriteCoordinator.open({
        journal: thirdJournal,
        transport:
          new InjectedLinearWriteTransport(
            fake.exchange
          ),
        clock: monotonicClock(
          "2026-07-27T12:00:40.000Z"
        )
      });
    const recovered = requireOperation(
      await third.get(
        prepared.plan.operationKey
      )
    );
    assert.equal(
      recovered.status,
      "outcome_unknown"
    );
    assert.equal(
      recovered.reconciliation?.result,
      "failed"
    );
    assert.equal(fake.requestCount, 0);
  } finally {
    await rm(workspace, {
      recursive: true,
      force: true
    });
  }
});

test("batch recovery fails closed midway and a later reopen safely converges every operation", async () => {
  const fake = new FakeLinearWriteGraphql();
  const delegate =
    await ProviderOperationJournal.open({
      storage: new MemoryOperationStorage()
    });
  const first =
    await ControlledWriteCoordinator.open({
      journal: delegate,
      transport:
        new InjectedLinearWriteTransport(
          fake.exchange
        ),
      clock: monotonicClock()
    });
  const prepared = [
    await first.prepare(PREPARE_INPUT),
    await first.prepare(SECOND_PREPARE_INPUT)
  ];

  for (const operation of prepared) {
    const approved = await first.approve(
      approvalInput(operation)
    );
    const submitting =
      transitionControlledWriteOperation(
        approved,
        {
          type: "begin_submission",
          occurredAt:
            "2026-07-27T12:00:20.000Z"
        }
      );
    await delegate.compareAndAppend({
      expectedVersion: approved.version,
      operationKey:
        approved.plan.operationKey,
      planDigest: approved.plan.planDigest,
      next: submitting
    });
  }

  await assert.rejects(
    ControlledWriteCoordinator.open({
      journal: new FailNthRecoveryJournal({
        delegate,
        failureNumber: 2
      }),
      transport:
        new InjectedLinearWriteTransport(
          fake.exchange
        ),
      clock: monotonicClock(
        "2026-07-27T12:00:30.000Z"
      )
    }),
    hasCode(
      "PROVIDER_OPERATION_JOURNAL_WRITE_FAILED"
    )
  );
  assert.equal(fake.requestCount, 0);
  assert.deepEqual(
    (await delegate.listLatest())
      .map((operation) => operation.status)
      .sort(),
    ["outcome_unknown", "submitting"]
  );

  const reopened =
    await ControlledWriteCoordinator.open({
      journal: delegate,
      transport:
        new InjectedLinearWriteTransport(
          fake.exchange
        ),
      clock: monotonicClock(
        "2026-07-27T12:00:40.000Z"
      )
    });
  assert.deepEqual(
    (await delegate.listLatest())
      .map((operation) => operation.status)
      .sort(),
    ["outcome_unknown", "outcome_unknown"]
  );
  assert.equal(fake.requestCount, 0);
  assert.ok(reopened);
});

test("an arbitrary transport exception is persisted as a redacted unknown result", async () => {
  const sentinel = "SECRET_TRANSPORT_CAUSE";
  const transport: LinearWriteTransportPort = {
    async createIssue() {
      throw new Error(sentinel);
    },
    async queryByClientUuid() {
      throw new Error(sentinel);
    }
  };
  const storage = new MemoryOperationStorage();
  const journal =
    await ProviderOperationJournal.open({
      storage
    });
  const coordinator =
    await ControlledWriteCoordinator.open({
      journal,
      transport,
      clock: monotonicClock()
    });
  const prepared = await coordinator.prepare(
    PREPARE_INPUT
  );
  await coordinator.approve(
    approvalInput(prepared)
  );

  const unknown = await coordinator.submit(
    operationInput(prepared)
  );
  const queried = await coordinator.reconcile(
    operationInput(prepared)
  );

  assert.equal(unknown.status, "outcome_unknown");
  assert.equal(queried.status, "outcome_unknown");
  assert.equal(
    queried.reconciliation?.result,
    "failed"
  );
  assert.doesNotMatch(
    JSON.stringify({
      unknown,
      queried
    }),
    new RegExp(sentinel)
  );
});

test("malformed and mismatched transport results fail closed with safe classifications", async (t) => {
  for (const scenario of [
    {
      name: "malformed create",
      createResult: {
        kind: "created",
        issue: {
          id: CLIENT_REQUEST_ID,
          identifier: "NP-201"
        },
        observedTeamId: TEAM_ID,
        secret: "SECRET_PROVIDER_BODY"
      },
      expectedDiagnostic:
        "LINEAR_WRITE_OUTCOME_UNKNOWN"
    },
    {
      name: "mismatched create scope",
      createResult: {
        kind: "created",
        issue: {
          id: CLIENT_REQUEST_ID,
          identifier: "NP-202"
        },
        observedTeamId: ORGANIZATION_ID
      },
      expectedDiagnostic:
        "LINEAR_WRITE_OUTCOME_UNKNOWN"
    }
  ] as const) {
    await t.test(scenario.name, async () => {
      const transport: LinearWriteTransportPort = {
        async createIssue() {
          return scenario.createResult as never;
        },
        async queryByClientUuid() {
          return { kind: "absent" };
        }
      };
      const journal =
        await ProviderOperationJournal.open({
          storage:
            new MemoryOperationStorage()
        });
      const coordinator =
        await ControlledWriteCoordinator.open({
          journal,
          transport,
          clock: monotonicClock()
        });
      const prepared =
        await coordinator.prepare(
          PREPARE_INPUT
        );
      await coordinator.approve(
        approvalInput(prepared)
      );
      const result = await coordinator.submit(
        operationInput(prepared)
      );

      assert.equal(
        result.status,
        "outcome_unknown"
      );
      assert.equal(
        result.diagnosticCode,
        scenario.expectedDiagnostic
      );
      assert.doesNotMatch(
        JSON.stringify(result),
        /SECRET_PROVIDER_BODY/
      );
    });
  }

  for (const scenario of [
    {
      name: "malformed query",
      queryResult: {
        kind: "found",
        issue: {
          id: CLIENT_REQUEST_ID,
          identifier: "NP-203"
        },
        observedTeamId: TEAM_ID,
        secret: "SECRET_PROVIDER_BODY"
      },
      expectedResult: "failed",
      expectedDiagnostic:
        "LINEAR_RECONCILIATION_FAILED"
    },
    {
      name: "mismatched query identity",
      queryResult: {
        kind: "found",
        issue: {
          id: SECOND_CLIENT_REQUEST_ID,
          identifier: "NP-204"
        },
        observedTeamId: ORGANIZATION_ID
      },
      expectedResult: "ambiguous",
      expectedDiagnostic:
        "LINEAR_RECONCILIATION_AMBIGUOUS"
    }
  ] as const) {
    await t.test(scenario.name, async () => {
      const transport: LinearWriteTransportPort = {
        async createIssue() {
          return {
            kind: "outcome_unknown",
            diagnosticCode:
              "LINEAR_WRITE_OUTCOME_UNKNOWN"
          };
        },
        async queryByClientUuid() {
          return scenario.queryResult as never;
        }
      };
      const journal =
        await ProviderOperationJournal.open({
          storage:
            new MemoryOperationStorage()
        });
      const coordinator =
        await ControlledWriteCoordinator.open({
          journal,
          transport,
          clock: monotonicClock()
        });
      const prepared =
        await coordinator.prepare(
          PREPARE_INPUT
        );
      await coordinator.approve(
        approvalInput(prepared)
      );
      await coordinator.submit(
        operationInput(prepared)
      );
      const result =
        await coordinator.reconcile(
          operationInput(prepared)
        );

      assert.equal(
        result.status,
        "outcome_unknown"
      );
      assert.equal(
        result.reconciliation?.result,
        scenario.expectedResult
      );
      assert.equal(
        result.diagnosticCode,
        scenario.expectedDiagnostic
      );
      assert.doesNotMatch(
        JSON.stringify(result),
        /SECRET_PROVIDER_BODY/
      );
    });
  }
});

test("arbitrary journal failures are normalized without leaking their cause", async () => {
  const sentinel = "SECRET_JOURNAL_CAUSE";
  const fake = new FakeLinearWriteGraphql();
  const delegate =
    await ProviderOperationJournal.open({
      storage: new MemoryOperationStorage()
    });
  const journal: ControlledWriteCoordinatorJournalPort =
    {
      compareAndAppend: (input) =>
        delegate.compareAndAppend(input),
      async get() {
        throw new Error(sentinel);
      },
      history: (operationKey) =>
        delegate.history(operationKey),
      listLatest: () => delegate.listLatest()
    };
  const coordinator =
    await ControlledWriteCoordinator.open({
      journal,
      transport:
        new InjectedLinearWriteTransport(
          fake.exchange
        ),
      clock: monotonicClock()
    });

  await assert.rejects(
    coordinator.prepare(PREPARE_INPUT),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        "code" in error ? error.code : undefined,
        "CONTROLLED_WRITE_COORDINATOR_JOURNAL_FAILED"
      );
      assert.doesNotMatch(
        error.message,
        new RegExp(sentinel)
      );
      assert.ok(!("cause" in error));
      return true;
    }
  );
  assert.equal(fake.requestCount, 0);
});

test("an invalid clock before begin-submission produces zero transport calls", async () => {
  const fake = new FakeLinearWriteGraphql();
  const journal =
    await ProviderOperationJournal.open({
      storage: new MemoryOperationStorage()
    });
  const values: unknown[] = [
    new Date("2026-07-27T12:00:00.000Z"),
    new Date("2026-07-27T12:00:01.000Z"),
    "invalid-clock"
  ];
  const coordinator =
    await ControlledWriteCoordinator.open({
      journal,
      transport:
        new InjectedLinearWriteTransport(
          fake.exchange
        ),
      clock: () => values.shift()
    });
  const prepared = await coordinator.prepare(
    PREPARE_INPUT
  );
  await coordinator.approve(
    approvalInput(prepared)
  );

  await assert.rejects(
    coordinator.submit(
      operationInput(prepared)
    ),
    hasCode(
      "CONTROLLED_WRITE_COORDINATOR_CLOCK_INVALID"
    )
  );
  assert.equal(fake.requestCount, 0);
  assert.equal(fake.externalWriteCount, 0);
  assert.equal(
    (
      await coordinator.get(
        prepared.plan.operationKey
      )
    )?.status,
    "approved"
  );
});

test("clock regression is clamped and an invalid completion clock uses the persisted timestamp", async () => {
  const fake = new FakeLinearWriteGraphql();
  const journal =
    await ProviderOperationJournal.open({
      storage: new MemoryOperationStorage()
    });
  const timestamp =
    "2026-07-27T12:00:10.000Z";
  const values: unknown[] = [
    new Date(timestamp),
    new Date("2026-07-27T12:00:09.000Z"),
    new Date("2026-07-27T12:00:08.000Z"),
    "invalid-completion-clock"
  ];
  const coordinator =
    await ControlledWriteCoordinator.open({
      journal,
      transport:
        new InjectedLinearWriteTransport(
          fake.exchange
        ),
      clock: () => values.shift()
    });
  const prepared = await coordinator.prepare(
    PREPARE_INPUT
  );
  const approved = await coordinator.approve(
    approvalInput(prepared)
  );
  const created = await coordinator.submit(
    operationInput(prepared)
  );

  assert.equal(approved.updatedAt, timestamp);
  assert.equal(
    created.submission.startedAt,
    timestamp
  );
  assert.equal(
    created.submission.completedAt,
    timestamp
  );
  assert.equal(created.updatedAt, timestamp);
  assert.equal(created.status, "created");
  assert.equal(fake.requestCount, 1);
});

test("hostile Date methods cannot leak clock errors across the public boundary", async () => {
  const sentinel = "SECRET_CLOCK_CAUSE";
  const fake = new FakeLinearWriteGraphql();
  const journal =
    await ProviderOperationJournal.open({
      storage: new MemoryOperationStorage()
    });
  const hostileDate = new Proxy(
    new Date("2026-07-27T12:00:01.000Z"),
    {
      get(target, property, receiver) {
        if (property === "getTime") {
          return () => target.getTime();
        }
        if (property === "toISOString") {
          return () => {
            throw new Error(sentinel);
          };
        }
        return Reflect.get(
          target,
          property,
          receiver
        );
      }
    }
  );
  const values: unknown[] = [
    new Date("2026-07-27T12:00:00.000Z"),
    hostileDate
  ];
  const coordinator =
    await ControlledWriteCoordinator.open({
      journal,
      transport:
        new InjectedLinearWriteTransport(
          fake.exchange
        ),
      clock: () => values.shift()
    });
  const prepared = await coordinator.prepare(
    PREPARE_INPUT
  );

  await assert.rejects(
    coordinator.approve(
      approvalInput(prepared)
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        "code" in error ? error.code : undefined,
        "CONTROLLED_WRITE_COORDINATOR_CLOCK_INVALID"
      );
      assert.doesNotMatch(
        error.message,
        new RegExp(sentinel)
      );
      return true;
    }
  );
  assert.equal(
    (
      await coordinator.get(
        prepared.plan.operationKey
      )
    )?.status,
    "approval_required"
  );
  assert.equal(fake.requestCount, 0);
});

interface Harness {
  coordinator: ControlledWriteCoordinator;
  journal: ProviderOperationJournal;
}

async function createHarness(
  fake: FakeLinearWriteGraphql
): Promise<Harness> {
  const journal =
    await ProviderOperationJournal.open({
      storage: new MemoryOperationStorage()
    });
  const coordinator =
    await ControlledWriteCoordinator.open({
      journal,
      transport:
        new InjectedLinearWriteTransport(
          fake.exchange
        ),
      clock: monotonicClock()
    });
  return {
    coordinator,
    journal
  };
}

function approvalInput(
  operation: ControlledWriteOperation
): {
  operationKey: string;
  planDigest: string;
  actor: {
    type: "human";
    id: string;
  };
} {
  return {
    operationKey: operation.plan.operationKey,
    planDigest: operation.plan.planDigest,
    actor: {
      type: "human",
      id: "owner"
    }
  };
}

function operationInput(
  operation: ControlledWriteOperation
): {
  operationKey: string;
  planDigest: string;
} {
  return {
    operationKey: operation.plan.operationKey,
    planDigest: operation.plan.planDigest
  };
}

function monotonicClock(
  start = "2026-07-27T12:00:00.000Z"
): () => Date {
  let current = Date.parse(start);
  return () => {
    const value = new Date(current);
    current += 1_000;
    return value;
  };
}

class MemoryOperationStorage
  implements ProviderOperationJournalStoragePort
{
  #value: ProviderOperationJournalFile = {
    schemaVersion: 1,
    records: []
  };

  async load(): Promise<unknown> {
    return structuredClone(this.#value);
  }

  async replace(
    value: ProviderOperationJournalFile
  ): Promise<void> {
    this.#value = structuredClone(value);
  }
}

class FailOnceJournal
  implements
    ProviderOperationJournalCommandPort,
    ProviderOperationJournalQueryPort
{
  readonly #delegate: ProviderOperationJournal;
  readonly #status: ControlledWriteOperationStatus;
  readonly #mode:
    | "commit_then_unknown"
    | "commit_then_idempotent"
    | "throw_before";
  #failed = false;

  constructor({
    delegate,
    status,
    mode
  }: {
    delegate: ProviderOperationJournal;
    status: ControlledWriteOperationStatus;
    mode:
      | "commit_then_unknown"
      | "commit_then_idempotent"
      | "throw_before";
  }) {
    this.#delegate = delegate;
    this.#status = status;
    this.#mode = mode;
  }

  async compareAndAppend(
    input: ProviderOperationAppendInput
  ): Promise<ProviderOperationAppendResult> {
    if (
      !this.#failed &&
      input.next.status === this.#status
    ) {
      this.#failed = true;
      if (
        this.#mode === "commit_then_unknown"
      ) {
        await this.#delegate.compareAndAppend(
          input
        );
        throw new ProviderOperationJournalError(
          "PROVIDER_OPERATION_JOURNAL_COMMIT_OUTCOME_UNKNOWN",
          "Provider operation journal commit outcome is unknown."
        );
      }
      if (
        this.#mode ===
        "commit_then_idempotent"
      ) {
        const result =
          await this.#delegate.compareAndAppend(
            input
          );
        return {
          resolution: "idempotent",
          operation: result.operation
        };
      }
      throw new ProviderOperationJournalError(
        "PROVIDER_OPERATION_JOURNAL_WRITE_FAILED",
        "Provider operation journal could not be persisted."
      );
    }
    return this.#delegate.compareAndAppend(input);
  }

  get(
    operationKey: string
  ): Promise<ProviderOperation | null> {
    return this.#delegate.get(operationKey);
  }

  history(
    operationKey: string
  ): Promise<readonly ProviderOperation[]> {
    return this.#delegate.history(operationKey);
  }

  listLatest(): Promise<
    readonly ProviderOperation[]
  > {
    return this.#delegate.listLatest();
  }
}

class FailNthRecoveryJournal
  implements
    ProviderOperationJournalCommandPort,
    ProviderOperationJournalQueryPort
{
  readonly #delegate: ProviderOperationJournal;
  readonly #failureNumber: number;
  #recoveryAppendCount = 0;

  constructor({
    delegate,
    failureNumber
  }: {
    delegate: ProviderOperationJournal;
    failureNumber: number;
  }) {
    this.#delegate = delegate;
    this.#failureNumber = failureNumber;
  }

  compareAndAppend(
    input: ProviderOperationAppendInput
  ): Promise<ProviderOperationAppendResult> {
    if (
      input.next.status === "outcome_unknown"
    ) {
      this.#recoveryAppendCount += 1;
      if (
        this.#recoveryAppendCount ===
        this.#failureNumber
      ) {
        throw new ProviderOperationJournalError(
          "PROVIDER_OPERATION_JOURNAL_WRITE_FAILED",
          "Provider operation journal could not be persisted."
        );
      }
    }
    return this.#delegate.compareAndAppend(input);
  }

  get(
    operationKey: string
  ): Promise<ProviderOperation | null> {
    return this.#delegate.get(operationKey);
  }

  history(
    operationKey: string
  ): Promise<readonly ProviderOperation[]> {
    return this.#delegate.history(operationKey);
  }

  listLatest(): Promise<
    readonly ProviderOperation[]
  > {
    return this.#delegate.listLatest();
  }
}

function requireOperation(
  operation: ControlledWriteOperation | null
): ControlledWriteOperation {
  assert.ok(operation);
  return operation;
}

function rejectAfter(
  delay: number,
  message: string
): Promise<never> {
  return new Promise((_, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(message)),
      delay
    );
    timeout.unref();
  });
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof Error &&
    "code" in error &&
    error.code === code &&
    !("cause" in error);
}
