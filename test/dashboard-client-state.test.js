import assert from "node:assert/strict";
import test from "node:test";

import {
  AcceptanceTruthFence,
  createAccessibleOrchestrationState,
  createAccessibleSnapshotState,
  createAcceptanceControlState,
  createOrchestrationPanelModel,
  createRunControlState,
  DashboardRequestGate,
  normalizeRequiredAuditNote,
  PromptDraftStore,
  reconcileSelectedWorkItemId,
  semanticSnapshotKey,
  shouldResetAcceptanceReasonError,
  shouldPollDashboard
} from "../public/dashboard-state.js";

test("dashboard keeps polling until it identifies demo mode", () => {
  assert.equal(shouldPollDashboard(null, false), true);
  assert.equal(shouldPollDashboard("persistent", false), true);
  assert.equal(shouldPollDashboard("persistent", true), false);
  assert.equal(shouldPollDashboard("demo", false), false);
});

test("dashboard ignores an older response after a newer request starts", () => {
  const gate = new DashboardRequestGate();
  const older = gate.issue();
  const newer = gate.issue();

  assert.equal(gate.isLatest(older), false);
  assert.equal(gate.isLatest(newer), true);
});

test("dashboard and Provider request gates do not invalidate each other", () => {
  const dashboardGate = new DashboardRequestGate();
  const providerGate = new DashboardRequestGate();
  const dashboardSequence = dashboardGate.issue();
  const providerSequence = providerGate.issue();

  providerGate.issue();

  assert.equal(
    dashboardGate.isLatest(dashboardSequence),
    true
  );
  assert.equal(
    providerGate.isLatest(providerSequence),
    false
  );
});

test("semantic snapshot keys change only with rendered state", () => {
  const workItems = [{ id: "TS-1", status: "running" }];

  assert.equal(
    semanticSnapshotKey(workItems),
    semanticSnapshotKey([{ id: "TS-1", status: "running" }])
  );
  assert.notEqual(
    semanticSnapshotKey(workItems),
    semanticSnapshotKey([{ id: "TS-1", status: "reviewing" }])
  );
});

test("accessible snapshot state changes when evidence changes without a status change", () => {
  const baseSnapshot = {
    summary: {
      activeAgents: 0
    },
    demo: {
      currentStep: 4,
      totalSteps: 6,
      timeline: [
        {
          label: "Pull request linked",
          active: true
        }
      ]
    },
    workItems: [
      {
        id: "TS-1",
        status: "reviewing",
        requiredEvidence: ["tests"],
        activeArtifact: {
          kind: "pull_request",
          revision: "abc123"
        },
        currentEvidence: []
      }
    ]
  };
  const evidenceUpdatedSnapshot = {
    ...baseSnapshot,
    workItems: [
      {
        ...baseSnapshot.workItems[0],
        currentEvidence: [
          {
            criterionKey: "tests",
            outcome: "passed"
          }
        ]
      }
    ]
  };
  const demoUpdatedSnapshot = {
    ...baseSnapshot,
    demo: {
      ...baseSnapshot.demo,
      currentStep: 5,
      timeline: [
        {
          label: "Required tests passed",
          active: true
        }
      ]
    }
  };

  assert.notEqual(
    semanticSnapshotKey(createAccessibleSnapshotState(baseSnapshot)),
    semanticSnapshotKey(
      createAccessibleSnapshotState(evidenceUpdatedSnapshot)
    )
  );
  assert.notEqual(
    semanticSnapshotKey(createAccessibleSnapshotState(baseSnapshot)),
    semanticSnapshotKey(
      createAccessibleSnapshotState(demoUpdatedSnapshot)
    )
  );
});

test("retirement audit notes are normalized before native form validation", () => {
  assert.equal(
    normalizeRequiredAuditNote(
      "  Retire after review.  "
    ),
    "Retire after review."
  );
  assert.equal(
    normalizeRequiredAuditNote(
      " \r\n\t "
    ),
    null
  );
  assert.equal(
    normalizeRequiredAuditNote(null),
    null
  );
});

test("orchestration model preserves accepted-node truth, topology, blocking evidence, and bounded dispatch state", () => {
  const snapshot =
    createOrchestrationSnapshot();
  const model =
    createOrchestrationPanelModel(
      snapshot,
      false
    );

  assert.equal(model.visible, true);
  assert.equal(model.plans.length, 1);
  assert.deepEqual(
    model.plans[0].progress,
    {
      basis: "accepted-nodes",
      acceptedNodes: 0,
      totalNodes: 2,
      uncertainNodes: 2
    }
  );
  assert.equal(
    "percent" in model.plans[0].progress,
    false
  );
  assert.deepEqual(
    model.plans[0].nodes.map(
      (node) => node.nodeId
    ),
    ["api", "qa"]
  );
  assert.equal(
    model.plans[0].nodes[0].title,
    "Build API"
  );
  assert.deepEqual(
    model.plans[0].nodes[1]
      .blockingReasons,
    [
      {
        code:
          "DEPENDENCY_NOT_ACCEPTED",
        label:
          "Waiting for accepted dependencies",
        relatedNodeIds: ["api"]
      }
    ]
  );
  assert.equal(
    model.plans[0].queue.durability,
    "ephemeral"
  );
  assert.deepEqual(
    model.plans[0].dispatchControl,
    {
      enabled: true,
      label: "Dispatch 1 ready node",
      readyCount: 1
    }
  );
  assert.deepEqual(
    model.plans[0]
      .retirementControl,
    {
      enabled: true,
      label: "Retire plan",
      hasActiveOwnedWork: false
    }
  );

  const full =
    createOrchestrationPanelModel(
      {
        ...snapshot,
        runtime: {
          ...snapshot.runtime,
          capacity: {
            ...snapshot.runtime.capacity,
            availableSlots: 0
          }
        }
      },
      false
    );
  assert.deepEqual(
    full.plans[0].dispatchControl,
    {
      enabled: false,
      label: "Execution capacity full",
      readyCount: 1
    }
  );
});

test("retirement controls fail closed on active work and audit history remains factual", () => {
  const snapshot = {
    ...createOrchestrationSnapshot(),
    decompositionRetirements: [
      {
        planId: "plan-old",
        planDigest:
          `sha256:${"3".repeat(64)}`,
        retiredBy:
          "operator.test",
        retiredAt:
          "2026-07-28T00:10:00.000Z",
        reasonCode:
          "operator_rollback",
        note:
          "Returned to serial execution."
      }
    ]
  };
  const active =
    createOrchestrationPanelModel(
      {
        ...snapshot,
        runtime: {
          ...snapshot.runtime,
          activeWorkItemIds: [
            "ROOT-1"
          ]
        }
      }
    );
  assert.deepEqual(
    active.plans[0]
      .retirementControl,
    {
      enabled: false,
      label:
        "Wait for active work",
      hasActiveOwnedWork: true
    }
  );

  const retiring =
    createOrchestrationPanelModel(
      snapshot,
      true,
      {
        kind: "retire",
        planId: "plan-alpha"
      }
    );
  assert.equal(
    retiring.plans[0]
      .dispatchControl.label,
    "Busy"
  );
  assert.equal(
    retiring.plans[0]
      .retirementControl.label,
    "Retiring…"
  );
  assert.deepEqual(
    retiring.retirements,
    [
      {
        planId: "plan-old",
        planDigest:
          `sha256:${"3".repeat(64)}`,
        retiredBy:
          "operator.test",
        retiredAt:
          "2026-07-28T00:10:00.000Z",
        reasonCode:
          "operator_rollback",
        reasonLabel:
          "Operator rollback",
        note:
          "Returned to serial execution."
      }
    ]
  );
  assert.equal(
    "percent" in
      retiring.retirements[0],
    false
  );
});

test("managed decomposition nodes cannot use manual run while active nodes can still be cancelled", () => {
  const snapshot =
    createOrchestrationSnapshot();
  const idle = createRunControlState(
    snapshot,
    "TS-1"
  );

  assert.equal(idle.canRun, false);
  assert.match(
    idle.statusLabel,
    /Managed by decomposition plan-alpha/
  );
  const root =
    createRunControlState(
      snapshot,
      "ROOT-1"
    );
  assert.equal(root.canRun, false);
  assert.match(
    root.statusLabel,
    /Managed by decomposition plan-alpha/
  );

  const active = createRunControlState(
    {
      ...snapshot,
      runtime: {
        ...snapshot.runtime,
        activeWorkItemIds: ["TS-1"],
        runs: [
          {
            workItemId: "TS-1",
            phase: "running"
          }
        ]
      }
    },
    "TS-1"
  );
  assert.equal(active.canRun, false);
  assert.equal(active.canCancel, true);
});

test("accessible orchestration state changes with node facts but ignores generated time", () => {
  const snapshot =
    createOrchestrationSnapshot();
  const baseline = semanticSnapshotKey(
    createAccessibleOrchestrationState(
      snapshot
    )
  );
  const generatedOnly =
    semanticSnapshotKey(
      createAccessibleOrchestrationState({
        ...snapshot,
        generatedAt:
          "2030-01-01T00:00:00.000Z"
      })
    );
  const phaseChanged =
    semanticSnapshotKey(
      createAccessibleOrchestrationState({
        ...snapshot,
        orchestration: [
          {
            ...snapshot.orchestration[0],
            nodes:
              snapshot.orchestration[0]
                .nodes.map((node) =>
                  node.nodeId === "api"
                    ? {
                        ...node,
                        phase: "running"
                      }
                    : node
                )
          }
        ]
      })
    );

  assert.equal(
    baseline,
    generatedOnly
  );
  assert.notEqual(
    baseline,
    phaseChanged
  );

  const retirementChanged =
    semanticSnapshotKey(
      createAccessibleOrchestrationState({
        ...snapshot,
        decompositionRetirements: [
          {
            planId:
              "plan-alpha",
            planDigest:
              snapshot.orchestration[0]
                .planDigest,
            retiredBy:
              "operator.test",
            retiredAt:
              "2026-07-28T00:10:00.000Z",
            reasonCode:
              "operator_rollback",
            note:
              "Returned to serial execution."
          }
        ]
      })
    );
  assert.notEqual(
    baseline,
    retirementChanged
  );
});

test("work item selection survives polling and falls back only when the item disappears", () => {
  const initial = [
    { id: "TS-1", title: "First" },
    { id: "TS-2", title: "Second" }
  ];

  assert.equal(
    reconcileSelectedWorkItemId(null, initial),
    "TS-1"
  );
  assert.equal(
    reconcileSelectedWorkItemId("TS-2", [...initial].reverse()),
    "TS-2"
  );
  assert.equal(
    reconcileSelectedWorkItemId("TS-2", [initial[0]]),
    "TS-1"
  );
  assert.equal(
    reconcileSelectedWorkItemId("TS-2", []),
    null
  );
});

test("prompt drafts survive switching work items and temporary empty state", () => {
  const drafts = new PromptDraftStore();
  const first = {
    id: "TS-1",
    title: "First"
  };
  const second = {
    id: "TS-2",
    title: "Second"
  };
  const firstDefault = drafts.switchTo(
    first,
    ""
  );

  assert.match(firstDefault, /TS-1: First/);
  const secondDefault = drafts.switchTo(
    second,
    "Custom TS-1 assignment"
  );
  assert.match(secondDefault, /TS-2: Second/);
  assert.equal(
    drafts.switchTo(
      first,
      "Custom TS-2 assignment"
    ),
    "Custom TS-1 assignment"
  );
  assert.equal(
    drafts.switchTo(
      null,
      "Updated TS-1 assignment"
    ),
    ""
  );
  assert.equal(
    drafts.switchTo(first, ""),
    "Updated TS-1 assignment"
  );
});

test("run controls allow an unrelated item while bounded capacity remains", () => {
  const snapshot = createPersistentSnapshot({
    activeIds: ["TS-1"],
    availableSlots: 1,
    runs: [
      {
        workItemId: "TS-1",
        phase: "running",
        attemptId: "attempt-1"
      }
    ]
  });
  const control = createRunControlState(
    snapshot,
    "TS-2"
  );

  assert.equal(control.canRun, true);
  assert.equal(control.canCancel, false);
  assert.equal(control.runLabel, "Run Codex");
  assert.match(control.statusLabel, /TS-2/);
});

test("run controls enforce capacity and expose selected cancellation phase", () => {
  const full = createPersistentSnapshot({
    activeIds: ["TS-1"],
    availableSlots: 0,
    runs: [
      {
        workItemId: "TS-1",
        phase: "running",
        attemptId: "attempt-1"
      }
    ]
  });

  assert.deepEqual(
    createRunControlState(full, "TS-1"),
    {
      canRun: false,
      canCancel: true,
      runLabel: "Codex running…",
      cancelLabel: "Cancel selected",
      statusLabel:
        "TS-1 · attempt attempt-1 is running",
      selectedWorkItemId: "TS-1",
      selectedRunPhase: "running"
    }
  );
  assert.equal(
    createRunControlState(full, "TS-2").canRun,
    false
  );
  assert.match(
    createRunControlState(
      full,
      "TS-2"
    ).statusLabel,
    /capacity is full; retry/
  );

  const cancelling = {
    ...full,
    runtime: {
      ...full.runtime,
      runs: [
        {
          workItemId: "TS-1",
          phase: "cancelling",
          attemptId: "attempt-1"
        }
      ]
    }
  };
  const cancellingControl =
    createRunControlState(cancelling, "TS-1");

  assert.equal(cancellingControl.canCancel, false);
  assert.equal(
    cancellingControl.runLabel,
    "Cancelling…"
  );
  assert.match(
    cancellingControl.statusLabel,
    /cancellation requested/
  );

  const terminalizing = {
    ...full,
    runtime: {
      ...full.runtime,
      runs: [
        {
          workItemId: "TS-1",
          phase: "terminalizing",
          attemptId: "attempt-1",
          cancelRequestedAt: null
        }
      ]
    }
  };
  const terminalizingControl =
    createRunControlState(
      terminalizing,
      "TS-1"
    );

  assert.equal(
    terminalizingControl.canCancel,
    false
  );
  assert.equal(
    terminalizingControl.runLabel,
    "Saving outcome…"
  );
  assert.equal(
    terminalizingControl.cancelLabel,
    "Outcome locked"
  );
  assert.match(
    terminalizingControl.statusLabel,
    /cancellation is no longer available/
  );
});

test("a terminal attempt is presented as an auditable retry", () => {
  const snapshot = createPersistentSnapshot({
    activeIds: [],
    availableSlots: 1,
    runs: []
  });
  snapshot.workItems[1].attempts.push({
    id: "attempt-old",
    status: "interrupted",
    agentId: "codex-app-server",
    startedAt: "2026-07-28T09:00:00.000Z",
    completedAt: "2026-07-28T09:01:00.000Z"
  });

  const control = createRunControlState(
    snapshot,
    "TS-2"
  );

  assert.equal(control.canRun, true);
  assert.equal(control.runLabel, "Retry Codex");
  assert.match(control.statusLabel, /interrupted/);
});

test("acceptance reason errors survive polling but reset for a new review context", () => {
  const unchanged = {
    previousWorkItemId: "TS-7",
    nextWorkItemId: "TS-7",
    previousReviewRevision:
      `sha256:${"1".repeat(64)}`,
    nextReviewRevision:
      `sha256:${"1".repeat(64)}`
  };

  assert.equal(
    shouldResetAcceptanceReasonError(
      unchanged
    ),
    false
  );
  assert.equal(
    shouldResetAcceptanceReasonError({
      ...unchanged,
      nextWorkItemId: "TS-8"
    }),
    true
  );
  assert.equal(
    shouldResetAcceptanceReasonError({
      ...unchanged,
      nextReviewRevision:
        `sha256:${"2".repeat(64)}`
    }),
    true
  );
});

test("accepted work requires an explicit reopen instead of an ordinary retry", () => {
  const snapshot =
    createPersistentSnapshot({
      activeIds: [],
      availableSlots: 1,
      runs: []
    });
  snapshot.workItems[0].status =
    "accepted";
  snapshot.workItems[0].attempts.push({
    id: "attempt-accepted",
    status: "completed",
    agentId: "codex-app-server"
  });

  const control =
    createRunControlState(
      snapshot,
      "TS-1"
    );
  assert.equal(control.canRun, false);
  assert.equal(
    control.runLabel,
    "Accepted"
  );
  assert.match(
    control.statusLabel,
    /explicit reopen/
  );
});

test("acceptance truth fence waits for fresh dashboard and Provider responses", () => {
  const fence = new AcceptanceTruthFence();

  fence.begin({
    workItemId: "TS-7",
    dashboardAfter: 4,
    providerAfter: 7
  });
  fence.begin({
    workItemId: "TS-8",
    dashboardAfter: 5,
    providerAfter: null
  });
  assert.equal(
    fence.pendingFor(
      "TS-7",
      "dashboard"
    ),
    true
  );
  assert.equal(
    fence.confirm("dashboard", 3),
    false
  );
  assert.equal(
    fence.confirm("provider", 7),
    true
  );
  assert.equal(
    fence.pendingFor(
      "TS-7",
      "provider"
    ),
    false
  );
  assert.equal(
    fence.confirm("dashboard", 4),
    false
  );
  assert.equal(
    fence.pendingFor(
      "TS-7",
      "dashboard"
    ),
    false
  );
  assert.equal(
    fence.pendingFor(
      "TS-8",
      "dashboard"
    ),
    true
  );
  assert.equal(
    fence.confirm("dashboard", 5),
    true
  );
  assert.equal(
    fence.pendingFor("TS-8"),
    false
  );
});

test("acceptance controls bind the current review and exact transition decision", () => {
  const decisionId =
    "00000000-0000-4000-8000-000000000007";
  const snapshot = {
    mode: "persistent",
    capabilities: {
      decideAcceptance: true,
      linearTransition: true,
      reconcileLinearTransition: true
    },
    security: {
      operatorId: "operator.jeffrey"
    },
    workItems: [{
      id: "TS-7",
      status: "reviewing",
      acceptanceReviewRevision:
        `sha256:${"1".repeat(64)}`,
      acceptanceDecision: null,
      activeAttempt: {
        id: "attempt-7",
        status: "completed",
        runtimeOutcome: "completed"
      },
      activeArtifact: {
        id: "artifact-7",
        revision: "revision-7"
      },
      requiredEvidence: ["tests"],
      currentEvidence: [{
        criterionKey: "tests",
        outcome: "passed"
      }]
    }]
  };
  const pending =
    createAcceptanceControlState(
      snapshot,
      "TS-7",
      {
        phase: "ready",
        model: {
          operations: []
        }
      }
    );
  assert.equal(pending.canAccept, true);
  assert.equal(pending.canReject, true);
  assert.equal(
    pending.reviewRevision,
    `sha256:${"1".repeat(64)}`
  );
  assert.equal(
    pending.localLabel,
    "Awaiting human decision"
  );
  assert.equal(
    pending.linearLabel,
    "Not applicable"
  );
  assert.equal(
    pending.operatorId,
    "operator.jeffrey"
  );

  const awaitingFreshTruth =
    createAcceptanceControlState(
      snapshot,
      "TS-7",
      {
        phase: "ready",
        model: {
          operations: []
        }
      },
      false,
      {
        dashboard: true,
        provider: false
      }
    );
  assert.equal(
    awaitingFreshTruth.canAccept,
    false
  );
  assert.equal(
    awaitingFreshTruth.canReject,
    false
  );
  assert.equal(
    awaitingFreshTruth.dashboardTruthPending,
    true
  );

  const accepted = {
    ...snapshot,
    workItems: [{
      ...snapshot.workItems[0],
      status: "accepted",
      acceptanceDecision: {
        decision: "accepted",
        actor: "operator.jeffrey",
        reason: "Evidence reviewed.",
        decidedAt:
          "2026-07-28T00:00:00.000Z",
        basis: {
          decisionId
        }
      },
      acceptanceHistory: [
        {
          decision: "rejected",
          actor: "operator.alice",
          reason: "Needs a regression test.",
          decidedAt:
            "2026-07-27T23:00:00.000Z",
          basis: {
            decisionId:
              "00000000-0000-4000-8000-000000000005"
          }
        },
        {
          decision: "accepted",
          actor: "operator.jeffrey",
          reason: "Evidence reviewed.",
          decidedAt:
            "2026-07-28T00:00:00.000Z",
          basis: {
            decisionId
          }
        }
      ]
    }]
  };
  const reconciliable =
    createAcceptanceControlState(
      accepted,
      "TS-7",
      {
        phase: "ready",
        model: {
          operations: [
            {
              action:
                "work-item.transition",
              workItemId: "TS-7",
              acceptanceDecisionId:
                "00000000-0000-4000-8000-000000000006",
              status: "transitioned",
              operationKey:
                `sha256:${"2".repeat(64)}`
            },
            {
              action:
                "work-item.transition",
              workItemId: "TS-7",
              acceptanceDecisionId:
                decisionId,
              status:
                "outcome_unknown",
              operationKey:
                `sha256:${"3".repeat(64)}`
            }
          ]
        }
      }
    );
  assert.equal(
    reconciliable.localLabel,
    "Accepted locally"
  );
  assert.equal(
    reconciliable.linearLabel,
    "Transition outcome unknown"
  );
  assert.equal(
    reconciliable.operationKey,
    `sha256:${"3".repeat(64)}`
  );
  assert.equal(
    reconciliable.canReconcile,
    true
  );
  assert.deepEqual(
    reconciliable.currentDecision,
    accepted.workItems[0]
      .acceptanceDecision
  );
  assert.deepEqual(
    reconciliable.acceptanceHistory,
    accepted.workItems[0]
      .acceptanceHistory
  );

  const awaitingProviderTruth =
    createAcceptanceControlState(
      accepted,
      "TS-7",
      {
        phase: "ready",
        model: {
          operations:
            reconciliable
              .operationKey
              ? [{
                  action:
                    "work-item.transition",
                  workItemId: "TS-7",
                  acceptanceDecisionId:
                    decisionId,
                  status:
                    "outcome_unknown",
                  operationKey:
                    reconciliable
                      .operationKey
                }]
              : []
        }
      },
      false,
      {
        dashboard: false,
        provider: true
      }
    );
  assert.equal(
    awaitingProviderTruth.canReconcile,
    false
  );
  assert.equal(
    awaitingProviderTruth.providerTruthPending,
    true
  );
});

test("acceptance controls expose decomposition dependency and root readiness gates", () => {
  const base =
    createOrchestrationSnapshot();
  const reviewable = (workItem) => ({
    ...workItem,
    status: "reviewing",
    acceptanceReviewRevision:
      `sha256:${"4".repeat(64)}`,
    activeAttempt: {
      id:
        `attempt-${workItem.id}`,
      status: "completed",
      runtimeOutcome:
        "completed"
    },
    activeArtifact: {
      id:
        `artifact-${workItem.id}`,
      revision: "revision-1"
    },
    currentEvidence: [
      {
        criterionKey: "tests",
        outcome: "passed"
      }
    ],
    acceptanceDecision: null,
    acceptanceHistory: []
  });
  const snapshot = {
    ...base,
    capabilities: {
      ...base.capabilities,
      decideAcceptance: true
    },
    security: {
      operatorId:
        "operator.test"
    },
    workItems:
      base.workItems.map(
        reviewable
      )
  };
  const providerState = {
    phase: "ready",
    model: {
      operations: []
    }
  };

  const dependent =
    createAcceptanceControlState(
      snapshot,
      "TS-2",
      providerState
    );
  assert.equal(
    dependent.canAccept,
    false
  );
  assert.equal(
    dependent.canReject,
    false
  );
  assert.match(
    dependent.localLabel,
    /dependencies/
  );

  const root =
    createAcceptanceControlState(
      snapshot,
      "ROOT-1",
      providerState
    );
  assert.equal(root.canAccept, false);
  assert.equal(root.canReject, false);
  assert.match(
    root.localLabel,
    /all decomposition nodes/
  );
});

function createPersistentSnapshot({
  activeIds,
  availableSlots,
  runs
}) {
  return {
    mode: "persistent",
    capabilities: {
      runAttempt: true,
      cancelAttempt: true
    },
    runtime: {
      activeWorkItemIds: activeIds,
      capacity: {
        maxConcurrentRuns: 2,
        activeCount: activeIds.length,
        availableSlots
      },
      runs
    },
    workItems: [
      {
        id: "TS-1",
        title: "First",
        attempts: []
      },
      {
        id: "TS-2",
        title: "Second",
        attempts: []
      }
    ]
  };
}

function createOrchestrationSnapshot() {
  return {
    mode: "persistent",
    generatedAt:
      "2026-07-28T00:00:00.000Z",
    summary: {
      activeAgents: 0
    },
    capabilities: {
      runAttempt: true,
      cancelAttempt: true,
      dispatchDecomposition: true,
      retireDecomposition: true
    },
    runtime: {
      activeWorkItemIds: [],
      capacity: {
        maxConcurrentRuns: 2,
        activeCount: 0,
        availableSlots: 2
      },
      runs: []
    },
    workItems: [
      {
        id: "ROOT-1",
        title: "Deliver product",
        status: "planned",
        attempts: [],
        requiredEvidence: ["tests"],
        currentEvidence: [],
        activeArtifact: null,
        acceptanceDecision: null
      },
      {
        id: "TS-1",
        title: "Build API",
        status: "planned",
        attempts: [],
        requiredEvidence: ["tests"],
        currentEvidence: [],
        activeArtifact: null,
        acceptanceDecision: null
      },
      {
        id: "TS-2",
        title: "Verify API",
        status: "planned",
        attempts: [],
        requiredEvidence: ["tests"],
        currentEvidence: [],
        activeArtifact: null,
        acceptanceDecision: null
      }
    ],
    decompositionRetirements: [],
    orchestration: [
      {
        planId: "plan-alpha",
        planDigest:
          `sha256:${"1".repeat(64)}`,
        rootWorkItemId: "ROOT-1",
        approvedBy: "operator.test",
        approvedAt:
          "2026-07-28T00:00:00.000Z",
        progress: {
          basis: "accepted-nodes",
          acceptedNodes: 0,
          totalNodes: 2,
          uncertainNodes: 2
        },
        countsByPhase: {
          unknown: 0,
          waiting_dependencies: 1,
          ready: 1,
          running: 0,
          awaiting_artifact: 0,
          awaiting_evidence: 0,
          awaiting_acceptance: 0,
          retry_backoff: 0,
          blocked: 0,
          accepted: 0
        },
        queue: {
          durability: "ephemeral",
          limit: 8,
          queuedCount: 1,
          nodeIds: ["api"]
        },
        topologicalOrder: [
          "api",
          "qa"
        ],
        dispatch: {
          maxParallelism: 2
        },
        activeNodeIds: [],
        nodes: [
          {
            nodeId: "qa",
            workItemId: "TS-2",
            phase:
              "waiting_dependencies",
            dependsOn: ["api"],
            owner: {
              runnerId:
                "codex-app-server",
              profileRevision:
                `sha256:${"2".repeat(64)}`,
              match: "matched"
            },
            actualAgentId: null,
            blockingReasons: [
              {
                code:
                  "DEPENDENCY_NOT_ACCEPTED",
                relatedNodeIds: ["api"]
              }
            ],
            retry: {
              attempts: 0,
              maxAttempts: 2,
              nextEligibleAt: null
            },
            evidence: {
              passed: 0,
              failed: 0,
              missing: 1,
              total: 1
            },
            attemptTrace: []
          },
          {
            nodeId: "api",
            workItemId: "TS-1",
            phase: "ready",
            dependsOn: [],
            owner: {
              runnerId:
                "codex-app-server",
              profileRevision:
                `sha256:${"2".repeat(64)}`,
              match: "matched"
            },
            actualAgentId: null,
            blockingReasons: [],
            retry: {
              attempts: 0,
              maxAttempts: 2,
              nextEligibleAt: null
            },
            evidence: {
              passed: 0,
              failed: 0,
              missing: 1,
              total: 1
            },
            attemptTrace: []
          }
        ]
      }
    ]
  };
}
