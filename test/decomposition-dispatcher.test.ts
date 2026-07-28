import assert from "node:assert/strict";
import test from "node:test";

import {
  AttemptRunCoordinator
} from "../src/application/attempt-run-coordinator.ts";
import {
  captureDecompositionAttemptBaseline
} from "../src/application/decomposition-attempt-baseline.ts";
import {
  assertDecompositionAcceptanceAllowed,
  DecompositionDispatcher,
  DecompositionDispatcherError
} from "../src/application/decomposition-dispatcher.ts";
import type {
  ApprovedDecompositionRecord,
  RetiredDecompositionRecord
} from "../src/application/decomposition-plan-journal.ts";
import {
  createDigitalEmployeeRegistry
} from "../src/application/decomposition-plan.ts";
import type {
  WorkItem
} from "../src/domain/workflow.ts";
import { createDecompositionFixture } from "../test-support/decomposition-fixtures.ts";

test("orchestration projection reports accepted-node progress, evidence facts, queue, and dependency blocking without percentages", () => {
  const context = createContext();
  const projection =
    context.dispatcher.project(
      "plan-alpha"
    );

  assert.deepEqual(
    projection.progress,
    {
      basis: "accepted-nodes",
      acceptedNodes: 0,
      totalNodes: 2,
      uncertainNodes: 2
    }
  );
  assert.equal(
    "percent" in projection.progress,
    false
  );
  assert.deepEqual(
    projection.queue,
    {
      durability: "ephemeral",
      limit: 8,
      queuedCount: 1,
      nodeIds: ["api"]
    }
  );
  assert.deepEqual(
    projection.topologicalOrder,
    ["api", "qa"]
  );
  assert.deepEqual(
    projection.dispatch,
    {
      maxParallelism: 2
    }
  );
  assert.deepEqual(
    projection.nodes.map((node) => ({
      nodeId: node.nodeId,
      phase: node.phase,
      owner: node.owner,
      actualAgentId:
        node.actualAgentId,
      blockers:
        node.blockingReasons
    })),
    [
      {
        nodeId: "api",
        phase: "ready",
        owner: {
          runnerId:
            "codex-app-server",
          profileRevision:
            context.record.plan.nodes[0]
              ?.owner.profileRevision,
          match: "matched"
        },
        actualAgentId: null,
        blockers: []
      },
      {
        nodeId: "qa",
        phase:
          "waiting_dependencies",
        owner: {
          runnerId:
            "codex-app-server",
          profileRevision:
            context.record.plan.nodes[1]
              ?.owner.profileRevision,
          match: "matched"
        },
        actualAgentId: null,
        blockers: [
          {
            code:
              "DEPENDENCY_NOT_ACCEPTED",
            relatedNodeIds: ["api"]
          }
        ]
      }
    ]
  );
});

test("dispatch uses stable DAG order, shared capacity, and exact approved runner input", async () => {
  const executions: Array<{
    workItemId: string;
    runnerId: string;
    instruction: string;
    workspaceAccess: string;
    timeoutMs: number;
  }> = [];
  const pending =
    Promise.withResolvers<void>();
  const context = createContext({
    maxConcurrentRuns: 1,
    execute(options) {
      executions.push({
        workItemId:
          options.workItemId,
        runnerId: options.runnerId,
        instruction:
          options.instruction,
        workspaceAccess:
          options.workspaceAccess,
        timeoutMs: options.timeoutMs
      });
      return pending.promise;
    }
  });

  const first =
    context.dispatcher.dispatchOnce({
      planId: "plan-alpha",
      expectedPlanDigest:
        context.record.planDigest
    });
  assert.deepEqual(
    first.startedNodeIds,
    ["api"]
  );
  assert.deepEqual(
    executions,
    [
      {
        workItemId: "API",
        runnerId:
          "codex-app-server",
        instruction:
          "Implement the bounded API.",
        workspaceAccess: "read-only",
        timeoutMs: 60_000
      }
    ]
  );
  assert.throws(
    () =>
      context.dispatcher.dispatchOnce({
        planId: "plan-alpha",
        expectedPlanDigest:
          context.record.planDigest
      }),
    hasCode(
      "DECOMPOSITION_NOT_DISPATCHABLE"
    )
  );
  assert.throws(
    () =>
      context.dispatcher
        .assertManualRunAllowed("API"),
    hasCode(
      "DECOMPOSITION_MANAGED_WORK_ITEM"
    )
  );

  pending.resolve();
  await context.coordinator.shutdown();
});

test("retirement rejects active owned runs without committing", async () => {
  const pending =
    Promise.withResolvers<void>();
  let retirementCalls = 0;
  const context = createContext({
    execute: () => pending.promise,
    retire: () => {
      retirementCalls += 1;
      return {};
    }
  });

  context.dispatcher.dispatchOnce({
    planId: "plan-alpha",
    expectedPlanDigest:
      context.record.planDigest
  });

  await assert.rejects(
    context.dispatcher.retireOnce({
      planId: "plan-alpha",
      expectedPlanDigest:
        context.record.planDigest,
      reasonCode: "interrupted",
      note:
        "Execution was cancelled and reviewed."
    }),
    hasCode(
      "DECOMPOSITION_RETIREMENT_ACTIVE"
    )
  );
  assert.equal(retirementCalls, 0);

  pending.resolve();
  await context.coordinator.shutdown();
});

test("retirement rejects canonical running roots and nodes", async () => {
  for (const workItemId of [
    "ROOT",
    "API"
  ]) {
    const workItems =
      createWorkItems();
    workItems.set(
      workItemId,
      {
        ...workItems.get(
          workItemId
        )!,
        status: "running"
      }
    );
    let retirementCalls = 0;
    const context = createContext({
      workItems,
      retire: () => {
        retirementCalls += 1;
        return {};
      }
    });

    await assert.rejects(
      context.dispatcher.retireOnce({
        planId: "plan-alpha",
        expectedPlanDigest:
          context.record.planDigest,
        reasonCode:
          "operator_rollback",
        note:
          "This active plan cannot retire."
      }),
      hasCode(
        "DECOMPOSITION_RETIREMENT_ACTIVE"
      )
    );
    assert.equal(
      retirementCalls,
      0
    );
  }
});

test("retirement treats terminalizing attempts as active until settlement", async () => {
  const pending =
    Promise.withResolvers<void>();
  let beginTerminalization:
    (() => unknown) | null = null;
  let retirementCalls = 0;
  const context = createContext({
    execute: ({
      terminalization
    }) => {
      beginTerminalization = () =>
        terminalization.begin();
      return pending.promise;
    },
    retire: () => {
      retirementCalls += 1;
      return {};
    }
  });

  context.dispatcher.dispatchOnce({
    planId: "plan-alpha",
    expectedPlanDigest:
      context.record.planDigest
  });
  const begin =
    beginTerminalization as
      | (() => unknown)
      | null;
  assert.ok(begin);
  begin();
  assert.equal(
    context.coordinator
      .snapshot().runs[0]?.phase,
    "terminalizing"
  );

  await assert.rejects(
    context.dispatcher.retireOnce({
      planId: "plan-alpha",
      expectedPlanDigest:
        context.record.planDigest,
      reasonCode:
        "operator_rollback",
      note:
        "Wait for terminal persistence."
    }),
    hasCode(
      "DECOMPOSITION_RETIREMENT_ACTIVE"
    )
  );
  assert.equal(retirementCalls, 0);

  pending.resolve();
  await context.coordinator.shutdown();
});

test("retirement waits for a current-plan acceptance decision to settle", async () => {
  const pending =
    Promise.withResolvers<void>();
  const attempt = {
    id: "attempt-api",
    agentId:
      "codex-app-server",
    status: "completed" as const,
    startedAt:
      "2026-07-28T13:01:00.000Z",
    completedAt:
      "2026-07-28T13:02:00.000Z",
    runtimeOutcome:
      "completed" as const
  };
  const workItems =
    createWorkItems();
  workItems.set(
    "API",
    {
      ...workItems.get("API")!,
      status: "reviewing",
      activeAttemptId: attempt.id,
      attempts: [attempt]
    }
  );
  let retirementCalls = 0;
  const context = createContext({
    workItems,
    retire: () => {
      retirementCalls += 1;
      return {};
    }
  });

  const decision =
    context.dispatcher
      .decideAcceptanceOnce({
        workItemId: "API",
        decision: "accepted",
        decide: () =>
          pending.promise
      });

  await assert.rejects(
    context.dispatcher.retireOnce({
      planId: "plan-alpha",
      expectedPlanDigest:
        context.record.planDigest,
      reasonCode:
        "operator_rollback",
      note:
        "Wait for acceptance persistence."
    }),
    hasCode(
      "DECOMPOSITION_RETIREMENT_ACTIVE"
    )
  );
  assert.equal(retirementCalls, 0);

  pending.resolve();
  await decision;
});

test("retirement fences concurrent dispatch until the commit settles", async () => {
  const commit =
    Promise.withResolvers<unknown>();
  let executeCalls = 0;
  const context = createContext({
    execute: () => {
      executeCalls += 1;
    },
    retire: () => commit.promise
  });

  const retirement =
    context.dispatcher.retireOnce({
      planId: "plan-alpha",
      expectedPlanDigest:
        context.record.planDigest,
      reasonCode: "operator_rollback",
      note:
        "Operator selected the serial fallback."
    });

  assert.throws(
    () =>
      context.dispatcher.dispatchOnce({
        planId: "plan-alpha",
        expectedPlanDigest:
          context.record.planDigest
      }),
    hasCode("DECOMPOSITION_RETIRING")
  );
  assert.equal(executeCalls, 0);

  commit.resolve({});
  await retirement;
});

test("retirement fences a ready root from manual run until the commit settles", async () => {
  const commit =
    Promise.withResolvers<unknown>();
  const workItems =
    createWorkItems();
  for (const workItemId of [
    "API",
    "QA"
  ]) {
    acceptPlanWorkItem(
      workItems,
      workItemId
    );
  }
  const context = createContext({
    workItems,
    retire: () => commit.promise
  });

  assert.doesNotThrow(() =>
    context.dispatcher
      .assertManualRunAllowed(
        "ROOT"
      )
  );
  const retirement =
    context.dispatcher.retireOnce({
      planId: "plan-alpha",
      expectedPlanDigest:
        context.record.planDigest,
      reasonCode:
        "operator_rollback",
      note:
        "Operator selected the serial fallback."
    });

  assert.throws(
    () =>
      context.dispatcher
        .assertManualRunAllowed(
          "ROOT"
        ),
    hasCode(
      "DECOMPOSITION_RETIRING"
    )
  );

  commit.resolve({});
  await retirement;
});

test("approval claims ownership before its journal commit and fences manual run", async () => {
  const commit =
    Promise.withResolvers<unknown>();
  let approvalCalls = 0;
  const context = createContext({
    active: false,
    approve: () => {
      approvalCalls += 1;
      return commit.promise;
    }
  });
  const dispatcher =
    context.dispatcher as
      DecompositionDispatcher & {
        approveOnce(input: {
          plan: unknown;
          expectedPlanDigest:
            string;
          approvedBy: string;
          approvedAt: string;
        }): Promise<unknown>;
      };

  const approval =
    dispatcher.approveOnce({
      plan: context.record.plan,
      expectedPlanDigest:
        context.record.planDigest,
      approvedBy:
        "operator.jeffrey",
      approvedAt:
        "2026-07-28T13:00:00.000Z"
    });

  assert.throws(
    () =>
      dispatcher
        .assertManualRunAllowed(
          "API"
        ),
    hasCode(
      "DECOMPOSITION_APPROVING"
    )
  );
  assert.equal(approvalCalls, 1);

  commit.resolve({});
  await approval;
});

test("approval claim fences acceptance before the plan commit is visible", async () => {
  const commit =
    Promise.withResolvers<unknown>();
  let decisionCalls = 0;
  const context = createContext({
    active: false,
    approve: () =>
      commit.promise
  });

  const approval =
    context.dispatcher.approveOnce({
      plan: context.record.plan,
      expectedPlanDigest:
        context.record.planDigest,
      approvedBy:
        "operator.jeffrey",
      approvedAt:
        "2026-07-28T13:00:00.000Z"
    });

  await assert.rejects(
    context.dispatcher
      .decideAcceptanceOnce({
        workItemId: "API",
        decision: "accepted",
        decide: () => {
          decisionCalls += 1;
          return {};
        }
      }),
    hasCode(
      "DECOMPOSITION_APPROVING"
    )
  );
  assert.equal(decisionCalls, 0);

  commit.resolve({});
  await approval;
});

test("acceptance claim fences approval before an unmanaged decision settles", async () => {
  const decision =
    Promise.withResolvers<unknown>();
  let approvalCalls = 0;
  const context = createContext({
    active: false,
    approve: () => {
      approvalCalls += 1;
      return {};
    }
  });

  const acceptance =
    context.dispatcher
      .decideAcceptanceOnce({
        workItemId: "API",
        decision: "accepted",
        decide: () =>
          decision.promise
      });

  await assert.rejects(
    context.dispatcher
      .approveOnce({
        plan:
          context.record.plan,
        expectedPlanDigest:
          context.record.planDigest,
        approvedBy:
          "operator.jeffrey",
        approvedAt:
          "2026-07-28T13:00:00.000Z"
      }),
    hasCode(
      "DECOMPOSITION_APPROVING"
    )
  );
  assert.equal(approvalCalls, 0);

  decision.resolve({});
  await acceptance;
});

test("approval rejects a WorkItem already reserved by an ordinary run", async () => {
  const pending =
    Promise.withResolvers<void>();
  let approvalCalls = 0;
  const context = createContext({
    active: false,
    approve: () => {
      approvalCalls += 1;
      return {};
    }
  });
  context.coordinator.start({
    workItemId: "API",
    execute: () => pending.promise
  });
  const dispatcher =
    context.dispatcher as
      DecompositionDispatcher & {
        approveOnce(input: {
          plan: unknown;
          expectedPlanDigest:
            string;
          approvedBy: string;
          approvedAt: string;
        }): Promise<unknown>;
      };

  await assert.rejects(
    dispatcher.approveOnce({
      plan: context.record.plan,
      expectedPlanDigest:
        context.record.planDigest,
      approvedBy:
        "operator.jeffrey",
      approvedAt:
        "2026-07-28T13:00:00.000Z"
    }),
    hasCode(
      "DECOMPOSITION_APPROVAL_ACTIVE"
    )
  );
  assert.equal(approvalCalls, 0);

  pending.resolve();
  await context.coordinator.shutdown();
});

test("approval requires accepted WorkItems to be explicitly reopened", async () => {
  const workItems =
    createWorkItems();
  acceptPlanWorkItem(
    workItems,
    "API"
  );
  let approvalCalls = 0;
  const context = createContext({
    active: false,
    workItems,
    approve: () => {
      approvalCalls += 1;
      return {};
    }
  });

  await assert.rejects(
    context.dispatcher
      .approveOnce({
        plan:
          context.record.plan,
        expectedPlanDigest:
          context.record.planDigest,
        approvedBy:
          "operator.jeffrey",
        approvedAt:
          "2026-07-28T13:00:00.000Z"
      }),
    hasCode(
      "DECOMPOSITION_WORK_ITEM_REOPEN_REQUIRED"
    )
  );
  assert.equal(approvalCalls, 0);
});

test("retirement retries reach the lifecycle journal after active ownership is released", async () => {
  let calls = 0;
  let commitRetirement:
    ConstructorParameters<
      typeof DecompositionDispatcher
    >[0]["retire"] = () => ({});
  const context = createContext({
    retire: (input) =>
      commitRetirement?.(input)
  });
  const record:
    RetiredDecompositionRecord =
    Object.freeze({
      recordType:
        "decomposition.retired",
      schemaVersion: "1",
      planId: "plan-alpha",
      planDigest:
        context.record.planDigest,
      retiredBy:
        "operator.jeffrey",
      retiredAt:
        "2026-07-28T13:10:00.000Z",
      reasonCode:
        "operator_rollback",
      note:
        "Operator selected the serial fallback."
    });
  commitRetirement = () => {
    calls += 1;
    context.lifecycle.active = false;
    context.lifecycle.retirement =
      record;
    return {
      resolution:
        calls === 1
          ? "committed"
          : "idempotent",
      record
    };
  };
  const command = {
    planId: "plan-alpha",
    expectedPlanDigest:
      context.record.planDigest,
    reasonCode:
      "operator_rollback" as const,
    note:
      "Operator selected the serial fallback."
  };

  const first =
    await context.dispatcher.retireOnce(
      command
    );
  const retry =
    await context.dispatcher.retireOnce(
      command
    );

  assert.equal(calls, 2);
  assert.equal(
    (first as { resolution: string })
      .resolution,
    "committed"
  );
  assert.equal(
    (retry as { resolution: string })
      .resolution,
    "idempotent"
  );
});

test("accepted dependencies unlock their nodes while profile drift fails closed with zero execution", () => {
  const fixture =
    createDecompositionFixture();
  const workItems =
    createWorkItems();
  acceptPlanWorkItem(
    workItems,
    "API"
  );
  let executeCalls = 0;
  const context = createContext({
    workItems,
    execute() {
      executeCalls += 1;
    }
  });

  assert.deepEqual(
    context.dispatcher
      .project("plan-alpha")
      .queue.nodeIds,
    ["qa"]
  );

  const drifted =
    new DecompositionDispatcher({
      plans: {
        get: () => context.record,
        list: () => [context.record],
        getRetirement: () => null
      },
      registry: createDriftedRegistry(),
      getWorkItem: (workItemId) =>
        workItems.get(workItemId) ??
        null,
      attemptRuns:
        new AttemptRunCoordinator(),
      execute() {
        executeCalls += 1;
      },
      now: () =>
        new Date(
          "2026-07-28T13:10:00.000Z"
        )
    });
  const driftProjection =
    drifted.project("plan-alpha");

  assert.equal(
    driftProjection.nodes[1]?.phase,
    "blocked"
  );
  assert.deepEqual(
    driftProjection.nodes[1]
      ?.blockingReasons,
    [
      {
        code: "RUNNER_PROFILE_DRIFT",
        relatedNodeIds: []
      }
    ]
  );
  assert.throws(
    () =>
      drifted.dispatchOnce({
        planId: "plan-alpha",
        expectedPlanDigest:
          context.record.planDigest
      }),
    hasCode(
      "DECOMPOSITION_NOT_DISPATCHABLE"
    )
  );
  assert.equal(executeCalls, 0);
});

test("a replacement plan ignores attempts captured by its approval baseline", () => {
  const interrupted =
    createAttempt(
      "attempt-old",
      "interrupted",
      "2026-07-28T12:30:00.000Z"
    );
  const workItems =
    createWorkItems();
  workItems.set(
    "API",
    {
      ...workItems.get("API")!,
      status: "blocked",
      activeAttemptId:
        interrupted.id,
      attempts: [interrupted]
    }
  );
  const baselineWorkItems =
    structuredClone(workItems);
  const context = createContext({
    workItems,
    baselineWorkItems
  });

  const node =
    context.dispatcher
      .project("plan-alpha")
      .nodes[0];

  assert.equal(
    node?.phase,
    "ready"
  );
  assert.deepEqual(
    node?.retry,
    {
      attempts: 0,
      maxAttempts: 2,
      nextEligibleAt: null
    }
  );
  assert.deepEqual(
    node?.attemptTrace,
    []
  );
  assert.equal(
    node?.actualAgentId,
    null
  );
});

test("acceptance rejects attempts outside the plan baseline or from the wrong owner", () => {
  const oldAttempt = {
    id: "attempt-old",
    agentId:
      "codex-app-server",
    status: "completed" as const,
    startedAt:
      "2026-07-28T12:00:00.000Z",
    completedAt:
      "2026-07-28T12:05:00.000Z",
    runtimeOutcome:
      "completed" as const
  };
  const baselineWorkItems =
    createWorkItems();
  baselineWorkItems.set(
    "API",
    {
      ...baselineWorkItems.get(
        "API"
      )!,
      status: "reviewing",
      activeAttemptId:
        oldAttempt.id,
      attempts: [oldAttempt]
    }
  );
  const workItems =
    structuredClone(
      baselineWorkItems
    );
  const context = createContext({
    workItems,
    baselineWorkItems
  });

  assert.throws(
    () =>
      context.dispatcher
        .assertAcceptanceAllowed(
          "API",
          "accepted"
        ),
    hasCode(
      "DECOMPOSITION_ATTEMPT_OUTSIDE_PLAN"
    )
  );

  const wrongOwnerAttempt = {
    ...oldAttempt,
    id: "attempt-current",
    agentId: "runner-other",
    startedAt:
      "2026-07-28T13:00:00.000Z",
    completedAt:
      "2026-07-28T13:05:00.000Z"
  };
  workItems.set(
    "API",
    {
      ...workItems.get("API")!,
      activeAttemptId:
        wrongOwnerAttempt.id,
      attempts: [
        oldAttempt,
        wrongOwnerAttempt
      ]
    }
  );
  assert.throws(
    () =>
      context.dispatcher
        .assertAcceptanceAllowed(
          "API",
          "accepted"
        ),
    hasCode(
      "DECOMPOSITION_OWNER_EXECUTION_DRIFT"
    )
  );

  const correctAttempt = {
    ...wrongOwnerAttempt,
    id: "attempt-correct",
    agentId:
      "codex-app-server",
    startedAt:
      "2026-07-28T13:10:00.000Z",
    completedAt:
      "2026-07-28T13:15:00.000Z"
  };
  workItems.set(
    "API",
    {
      ...workItems.get("API")!,
      activeAttemptId:
        correctAttempt.id,
      attempts: [
        oldAttempt,
        wrongOwnerAttempt,
        correctAttempt
      ]
    }
  );
  assert.doesNotThrow(() =>
    context.dispatcher
      .assertAcceptanceAllowed(
        "API",
        "accepted"
      )
  );
});

test("the root WorkItem is not runnable until every decomposition node is accepted", () => {
  const context = createContext();

  assert.throws(
    () =>
      context.dispatcher
        .assertManualRunAllowed(
          "ROOT"
        ),
    hasCode(
      "DECOMPOSITION_ROOT_NOT_READY"
    )
  );

  for (const workItemId of [
    "API",
    "QA"
  ]) {
    acceptPlanWorkItem(
      context.workItems,
      workItemId,
    );
  }

  assert.doesNotThrow(() =>
    context.dispatcher
      .assertManualRunAllowed(
        "ROOT"
      )
  );
});

test("root acceptance requires a completed Attempt after the plan baseline", () => {
  const oldRootAttempt = {
    id: "attempt-root-old",
    agentId:
      "codex-app-server",
    status: "completed" as const,
    startedAt:
      "2026-07-28T12:00:00.000Z",
    completedAt:
      "2026-07-28T12:05:00.000Z",
    runtimeOutcome:
      "completed" as const
  };
  const baselineWorkItems =
    createWorkItems();
  baselineWorkItems.set(
    "ROOT",
    {
      ...baselineWorkItems.get(
        "ROOT"
      )!,
      status: "reviewing",
      activeAttemptId:
        oldRootAttempt.id,
      attempts: [oldRootAttempt]
    }
  );
  const workItems =
    structuredClone(
      baselineWorkItems
    );
  acceptPlanWorkItem(
    workItems,
    "API"
  );
  acceptPlanWorkItem(
    workItems,
    "QA"
  );
  const context = createContext({
    workItems,
    baselineWorkItems
  });

  assert.throws(
    () =>
      context.dispatcher
        .assertAcceptanceAllowed(
          "ROOT",
          "accepted"
        ),
    hasCode(
      "DECOMPOSITION_ATTEMPT_OUTSIDE_PLAN"
    )
  );

  const currentRootAttempt = {
    ...oldRootAttempt,
    id: "attempt-root-current",
    startedAt:
      "2026-07-28T13:10:00.000Z",
    completedAt:
      "2026-07-28T13:15:00.000Z"
  };
  workItems.set(
    "ROOT",
    {
      ...workItems.get("ROOT")!,
      activeAttemptId:
        currentRootAttempt.id,
      attempts: [
        oldRootAttempt,
        currentRootAttempt
      ]
    }
  );
  assert.doesNotThrow(() =>
    context.dispatcher
      .assertAcceptanceAllowed(
        "ROOT",
        "accepted"
      )
  );
});

test("acceptance cannot bypass node dependencies or an incomplete root", () => {
  const context = createContext();
  const assertAllowed = (
    workItemId: string
  ) =>
    assertDecompositionAcceptanceAllowed(
      context.dispatcher.plans,
      (candidateId) =>
        context.workItems.get(
          candidateId
        ) ?? null,
      context.registry,
      workItemId,
      "rejected"
    );

  assert.doesNotThrow(() =>
    assertAllowed("API")
  );
  assert.throws(
    () => assertAllowed("QA"),
    hasCode(
      "DECOMPOSITION_DEPENDENCY_NOT_ACCEPTED"
    )
  );
  assert.throws(
    () => assertAllowed("ROOT"),
    hasCode(
      "DECOMPOSITION_ROOT_NOT_READY"
    )
  );

  acceptPlanWorkItem(
    context.workItems,
    "API"
  );
  assert.doesNotThrow(() =>
    assertAllowed("QA")
  );
});

test("retry is derived from canonical failed attempts, bounded by policy, delayed by backoff, and never automatic for interruption", () => {
  const workItems =
    createWorkItems();
  const failed = createAttempt(
    "attempt-1",
    "failed",
    "2026-07-28T13:00:00.000Z"
  );
  workItems.set(
    "API",
    {
      ...workItems.get("API")!,
      status: "blocked",
      activeAttemptId: failed.id,
      attempts: [failed]
    }
  );
  const context = createContext({
    workItems,
    now: () =>
      new Date(
        "2026-07-28T13:00:01.000Z"
      )
  });

  assert.equal(
    context.dispatcher
      .project("plan-alpha")
      .nodes[0]?.phase,
    "ready"
  );

  const exhausted = createAttempt(
    "attempt-2",
    "failed",
    "2026-07-28T13:00:02.000Z"
  );
  workItems.set(
    "API",
    {
      ...workItems.get("API")!,
      activeAttemptId: exhausted.id,
      attempts: [failed, exhausted]
    }
  );
  assert.deepEqual(
    context.dispatcher
      .project("plan-alpha")
      .nodes[0]?.blockingReasons,
    [
      {
        code: "RETRY_EXHAUSTED",
        relatedNodeIds: []
      }
    ]
  );

  const interrupted = createAttempt(
    "attempt-interrupted",
    "interrupted",
    "2026-07-28T13:00:03.000Z"
  );
  workItems.set(
    "API",
    {
      ...workItems.get("API")!,
      activeAttemptId:
        interrupted.id,
      attempts: [interrupted]
    }
  );
  assert.deepEqual(
    context.dispatcher
      .project("plan-alpha")
      .nodes[0]?.blockingReasons,
    [
      {
        code:
          "INTERRUPTED_REQUIRES_REVIEW",
        relatedNodeIds: []
      }
    ]
  );
});

test("blocked current evidence always exposes an evidence failure reason", () => {
  const workItems =
    createWorkItems();
  const attempt = {
    id: "attempt-evidence",
    agentId:
      "codex-app-server",
    status: "completed" as const,
    startedAt:
      "2026-07-28T13:00:00.000Z",
    completedAt:
      "2026-07-28T13:01:00.000Z",
    runtimeOutcome:
      "completed" as const
  };
  const artifact = {
    id: "artifact-evidence",
    attemptId: attempt.id,
    kind: "pull_request",
    revision: "revision-1",
    url:
      "https://example.test/pull/1",
    linkedAt:
      "2026-07-28T13:01:30.000Z"
  };
  workItems.set(
    "API",
    {
      ...workItems.get("API")!,
      status: "blocked",
      activeAttemptId: attempt.id,
      activeArtifact: {
        artifactId: artifact.id,
        revision: artifact.revision,
        linkedAt: artifact.linkedAt
      },
      attempts: [attempt],
      artifacts: [artifact],
      evidence: [
        {
          id: "evidence-failed",
          attemptId: attempt.id,
          artifactId:
            artifact.id,
          revision:
            artifact.revision,
          criterionKey:
            "contract",
          outcome: "failed",
          url:
            "https://example.test/check/1",
          recordedAt:
            "2026-07-28T13:02:00.000Z"
        }
      ]
    }
  );
  const context = createContext({
    workItems
  });

  assert.deepEqual(
    context.dispatcher
      .project("plan-alpha")
      .nodes[0]?.blockingReasons,
    [
      {
        code: "EVIDENCE_FAILED",
        relatedNodeIds: []
      }
    ]
  );
});

function createContext({
  workItems = createWorkItems(),
  baselineWorkItems =
    createWorkItems(),
  maxConcurrentRuns = 2,
  execute = () => undefined,
  approve,
  retire,
  active = true,
  now = () =>
    new Date(
      "2026-07-28T13:10:00.000Z"
    )
}: {
  workItems?: Map<string, WorkItem>;
  baselineWorkItems?:
    Map<string, WorkItem>;
  maxConcurrentRuns?: number;
  execute?: ConstructorParameters<
    typeof DecompositionDispatcher
  >[0]["execute"];
  approve?: (
    input: unknown
  ) => unknown | Promise<unknown>;
  retire?: ConstructorParameters<
    typeof DecompositionDispatcher
  >[0]["retire"];
  active?: boolean;
  now?: () => Date;
} = {}) {
  const fixture =
    createDecompositionFixture();
  const record: ApprovedDecompositionRecord =
    Object.freeze({
      recordType:
        "decomposition.approved",
      schemaVersion: "2",
      planDigest:
        fixture.preview.planDigest,
      approvedBy:
        "operator.jeffrey",
      approvedAt:
        "2026-07-28T13:00:00.000Z",
      plan: fixture.preview.plan,
      attemptBaselines:
        Object.freeze(
          [
            "API",
            "QA",
            "ROOT"
          ].map((workItemId) => {
            const workItem =
              baselineWorkItems.get(
                workItemId
              );
            assert.ok(workItem);
            return captureDecompositionAttemptBaseline(
              workItem
            );
          })
        )
    });
  const coordinator =
    new AttemptRunCoordinator({
      maxConcurrentRuns
    });
  const lifecycle: {
    active: boolean;
    retirement:
      RetiredDecompositionRecord | null;
  } = {
    active,
    retirement: null
  };
  const dispatcher =
    new DecompositionDispatcher({
      plans: {
        get: (planId) =>
          lifecycle.active &&
          planId ===
          record.plan.planId
            ? record
            : null,
        list: () =>
          lifecycle.active
            ? [record]
            : [],
        getRetirement: (planId) =>
          planId ===
          lifecycle.retirement?.planId
            ? lifecycle.retirement
            : null
      },
      registry: fixture.registry,
      getWorkItem: (workItemId) =>
        workItems.get(workItemId) ??
        null,
      attemptRuns: coordinator,
      execute,
      approve,
      retire,
      now
    });

  return {
    ...fixture,
    workItems,
    record,
    coordinator,
    lifecycle,
    dispatcher
  };
}

function createWorkItems():
  Map<string, WorkItem> {
  return new Map([
    ["ROOT", createWorkItem("ROOT", [
      "tests"
    ])],
    ["API", createWorkItem("API", [
      "contract",
      "tests"
    ])],
    ["QA", createWorkItem("QA", [
      "tests"
    ])]
  ]);
}

function createWorkItem(
  id: string,
  requiredEvidence: string[]
): WorkItem {
  return {
    id,
    title: id,
    status: "planned",
    requiredEvidence,
    activeAttemptId: null,
    activeArtifact: null,
    attempts: [],
    artifacts: [],
    evidence: [],
    acceptanceDecision: null,
    acceptanceHistory: [],
    externalLinks: []
  };
}

function createAttempt(
  id: string,
  outcome:
    | "failed"
    | "interrupted",
  completedAt: string
) {
  return {
    id,
    agentId: "codex-app-server",
    status: outcome,
    startedAt:
      "2026-07-28T12:59:00.000Z",
    completedAt,
    runtimeOutcome: outcome
  } as const;
}

function acceptPlanWorkItem(
  workItems:
    Map<string, WorkItem>,
  workItemId: string
): void {
  const current =
    workItems.get(workItemId);
  assert.ok(current);
  const attempt = {
    id:
      `attempt-${workItemId.toLowerCase()}`,
    agentId:
      "codex-app-server",
    status: "completed" as const,
    startedAt:
      "2026-07-28T13:01:00.000Z",
    completedAt:
      "2026-07-28T13:02:00.000Z",
    runtimeOutcome:
      "completed" as const
  };
  workItems.set(
    workItemId,
    {
      ...current,
      status: "accepted",
      activeAttemptId: attempt.id,
      attempts: [attempt],
      acceptanceDecision: {
        decision: "accepted",
        actor: "operator",
        reason: "Verified.",
        decidedAt:
          "2026-07-28T13:05:00.000Z",
        basis: {
          decisionId:
            `decision-${workItemId.toLowerCase()}`,
          reviewRevision:
            `sha256:${"1".repeat(64)}`,
          attemptId:
            attempt.id,
          artifactId: null,
          artifactRevision: null
        }
      }
    }
  );
}

function createDriftedRegistry() {
  const fixture =
    createDecompositionFixture();
  const profile =
    fixture.registry.get(
      "codex-app-server"
    );
  assert.ok(profile);
  return createDigitalEmployeeRegistry([
    {
      manifest: profile.manifest,
      allowedWorkspaceAccess:
        profile.allowedWorkspaceAccess,
      skillTags: [
        ...profile.skillTags,
        "drifted"
      ]
    }
  ]);
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof
      DecompositionDispatcherError &&
    error.code === code;
}
