export class DashboardRequestGate {
  constructor() {
    this.latestIssued = 0;
  }

  issue() {
    this.latestIssued += 1;
    return this.latestIssued;
  }

  isLatest(sequence) {
    return sequence === this.latestIssued;
  }
}

export class AcceptanceTruthFence {
  constructor() {
    this.pendingBySource = {
      dashboard: new Map(),
      provider: new Map()
    };
  }

  begin({
    workItemId,
    dashboardAfter,
    providerAfter
  }) {
    if (
      typeof workItemId !== "string" ||
      workItemId.length === 0 ||
      !(
        dashboardAfter === null ||
        (
          Number.isSafeInteger(
            dashboardAfter
          ) &&
          dashboardAfter >= 1
        )
      ) ||
      !(
        providerAfter === null ||
        (
          Number.isSafeInteger(
            providerAfter
          ) &&
          providerAfter >= 1
        )
      ) ||
      (
        dashboardAfter === null &&
        providerAfter === null
      )
    ) {
      throw new TypeError(
        "Acceptance truth fence requires a scope and at least one positive request sequence."
      );
    }

    if (dashboardAfter !== null) {
      this.pendingBySource.dashboard.set(
        workItemId,
        dashboardAfter
      );
    }
    if (providerAfter !== null) {
      this.pendingBySource.provider.set(
        workItemId,
        providerAfter
      );
    }
  }

  confirm(source, sequence) {
    const pending =
      this.pendingBySource[source];
    if (
      !(pending instanceof Map) ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1
    ) {
      return false;
    }

    for (const [
      workItemId,
      minimumSequence
    ] of pending) {
      if (sequence >= minimumSequence) {
        pending.delete(workItemId);
      }
    }

    return pending.size === 0;
  }

  pendingFor(workItemId, source) {
    if (
      typeof workItemId !== "string" ||
      workItemId.length === 0
    ) {
      return false;
    }
    if (source === undefined) {
      return (
        this.pendingBySource.dashboard.has(
          workItemId
        ) ||
        this.pendingBySource.provider.has(
          workItemId
        )
      );
    }
    const pending =
      this.pendingBySource[source];
    return (
      pending instanceof Map &&
      pending.has(workItemId)
    );
  }
}

export class PromptDraftStore {
  constructor() {
    this.currentWorkItemId = null;
    this.drafts = new Map();
  }

  switchTo(workItem, currentValue) {
    if (this.currentWorkItemId) {
      this.drafts.set(
        this.currentWorkItemId,
        currentValue
      );
    }

    if (!workItem) {
      this.currentWorkItemId = null;
      return "";
    }

    const draft =
      this.drafts.get(workItem.id) ??
      createDefaultPrompt(workItem);
    this.drafts.set(workItem.id, draft);
    this.currentWorkItemId = workItem.id;
    return draft;
  }
}

export function shouldPollDashboard(mode, busy = false) {
  return mode !== "demo" && !busy;
}

export function semanticSnapshotKey(value) {
  return JSON.stringify(value);
}

export function reconcileSelectedWorkItemId(
  selectedWorkItemId,
  workItems
) {
  if (
    selectedWorkItemId &&
    workItems.some(
      (workItem) =>
        workItem.id === selectedWorkItemId
    )
  ) {
    return selectedWorkItemId;
  }

  return workItems[0]?.id ?? null;
}

export function shouldResetAcceptanceReasonError({
  previousWorkItemId,
  nextWorkItemId,
  previousReviewRevision,
  nextReviewRevision
}) {
  return (
    previousWorkItemId !==
      nextWorkItemId ||
    previousReviewRevision !==
      nextReviewRevision
  );
}

export function createRunControlState(
  snapshot,
  selectedWorkItemId,
  busy = false
) {
  const selectedWorkItem =
    snapshot.workItems.find(
      (workItem) =>
        workItem.id === selectedWorkItemId
    ) ?? null;
  const selectedRun =
    snapshot.runtime?.runs?.find(
      (run) =>
        run.workItemId === selectedWorkItemId
    ) ?? null;
  const activeIds =
    snapshot.runtime?.activeWorkItemIds ?? [];
  const selectedIsActive =
    selectedRun !== null ||
    activeIds.includes(selectedWorkItemId);
  const availableSlots =
    snapshot.runtime?.capacity?.availableSlots ??
    Math.max(0, 1 - activeIds.length);
  const lastAttempt =
    selectedWorkItem?.attempts?.at(-1) ?? null;
  const canRun = Boolean(
    snapshot.mode === "persistent" &&
      snapshot.capabilities?.runAttempt &&
      selectedWorkItem &&
      selectedWorkItem.status !==
        "accepted" &&
      !selectedIsActive &&
      availableSlots > 0 &&
      !busy
  );
  const canCancel = Boolean(
    snapshot.mode === "persistent" &&
      snapshot.capabilities?.cancelAttempt &&
      selectedWorkItem &&
      selectedRun?.phase === "running" &&
      !busy
  );
  const runLabel = busy
    ? "Dispatching…"
    : selectedRun?.phase === "cancelling"
      ? "Cancelling…"
      : selectedRun?.phase === "terminalizing"
        ? selectedRun.cancelRequestedAt
          ? "Finishing cancellation…"
          : "Saving outcome…"
        : selectedIsActive
          ? "Codex running…"
          : selectedWorkItem
                ?.status === "accepted"
            ? "Accepted"
          : lastAttempt
            ? "Retry Codex"
            : "Run Codex";

  return {
    canRun,
    canCancel,
    runLabel,
    cancelLabel:
      selectedRun?.phase === "cancelling" ||
      (selectedRun?.phase === "terminalizing" &&
        selectedRun.cancelRequestedAt)
        ? "Cancellation requested"
        : selectedRun?.phase === "terminalizing"
          ? "Outcome locked"
          : "Cancel selected",
    statusLabel: createRunStatusLabel({
      selectedWorkItem,
      selectedRun,
      selectedIsActive,
      lastAttempt,
      availableSlots
    }),
    selectedWorkItemId:
      selectedWorkItem?.id ?? null,
    selectedRunPhase:
      selectedRun?.phase ?? null
  };
}

export function createAcceptanceControlState(
  snapshot,
  selectedWorkItemId,
  providerState,
  busy = false,
  truthPending = {}
) {
  const dashboardTruthPending =
    truthPending.dashboard === true;
  const providerTruthPending =
    truthPending.provider === true;
  const workItem =
    snapshot.workItems.find(
      (candidate) =>
        candidate.id ===
        selectedWorkItemId
    ) ?? null;
  const decision =
    workItem?.acceptanceDecision ?? null;
  const activeAttempt =
    workItem?.activeAttempt ?? null;
  const terminalAttempt = Boolean(
    activeAttempt &&
      activeAttempt.status !== "running" &&
      activeAttempt.status !==
        "superseded"
  );
  const eligibleStatus =
    workItem?.status === "reviewing" ||
    workItem?.status === "blocked";
  const latestEvidence = new Map(
    (workItem?.currentEvidence ?? [])
      .map((evidence) => [
        evidence.criterionKey,
        evidence
      ])
  );
  const acceptGateReady = Boolean(
    terminalAttempt &&
      activeAttempt?.runtimeOutcome ===
        "completed" &&
      workItem?.activeArtifact &&
      (workItem.requiredEvidence ?? [])
        .every(
          (criterionKey) =>
            latestEvidence.get(
              criterionKey
            )?.outcome === "passed"
        )
  );
  const canDecide = Boolean(
    snapshot.mode === "persistent" &&
      snapshot.capabilities
        ?.decideAcceptance &&
      workItem &&
      eligibleStatus &&
      decision === null &&
      !busy &&
      !dashboardTruthPending
  );
  const matchingOperation =
    decision?.decision === "accepted" &&
    decision.basis?.decisionId
      ? (
          providerState?.model
            ?.operations ?? []
        ).find(
          (operation) =>
            operation.action ===
              "work-item.transition" &&
            operation.workItemId ===
              workItem.id &&
            operation
              .acceptanceDecisionId ===
              decision.basis
                .decisionId
        ) ?? null
      : null;
  const linear = projectLinearSyncState({
    snapshot,
    providerState,
    decision,
    matchingOperation
  });

  return {
    canAccept:
      canDecide && acceptGateReady,
    canReject:
      canDecide && terminalAttempt,
    reviewRevision:
      workItem
        ?.acceptanceReviewRevision ??
      null,
    operatorId:
      snapshot.security?.operatorId ??
      null,
    currentDecision: decision,
    acceptanceHistory:
      workItem?.acceptanceHistory ?? [],
    dashboardTruthPending,
    providerTruthPending,
    truthPending:
      dashboardTruthPending ||
      providerTruthPending,
    localLabel:
      decision === null
        ? "Awaiting human decision"
        : decision.decision ===
            "accepted"
          ? "Accepted locally"
          : "Rejected locally",
    linearLabel: linear.label,
    linearTone: linear.tone,
    linearStale:
      linear.stale ||
      providerTruthPending,
    operationKey:
      matchingOperation
        ?.operationKey ?? null,
    canReconcile: Boolean(
      !busy &&
        !dashboardTruthPending &&
        !providerTruthPending &&
        snapshot.capabilities
          ?.reconcileLinearTransition &&
        matchingOperation &&
        (
          matchingOperation.status ===
            "outcome_unknown" ||
          matchingOperation.status ===
            "reconciliation_absent"
        )
    )
  };
}

function projectLinearSyncState({
  snapshot,
  providerState,
  decision,
  matchingOperation
}) {
  if (
    decision?.decision !== "accepted"
  ) {
    return {
      label: "Not applicable",
      tone: "neutral",
      stale: false
    };
  }
  if (
    !snapshot.capabilities
      ?.linearTransition
  ) {
    return {
      label: "Disabled",
      tone: "neutral",
      stale: false
    };
  }
  if (!matchingOperation) {
    return {
      label:
        providerState?.phase ===
          "error" &&
        !providerState?.model
          ? "Unavailable"
          : "Not synchronized",
      tone: "danger",
      stale:
        providerState?.phase ===
        "stale"
    };
  }
  const labels = {
    approval_required:
      "Approval required",
    approved: "Approved; pending write",
    rejected:
      "Transition approval rejected",
    submitting: "Transitioning…",
    transitioned:
      "Done transition confirmed",
    outcome_unknown:
      "Transition outcome unknown",
    reconciling: "Reconciling…",
    reconciliation_absent:
      "Done not observed",
    reconciled:
      "Done observed by reconciliation",
    sync_failed:
      "Transition failed"
  };
  const ready =
    matchingOperation.status ===
      "transitioned" ||
    matchingOperation.status ===
      "reconciled";
  return {
    label:
      labels[
        matchingOperation.status
      ] ?? "Transition state unavailable",
    tone: ready
      ? "ready"
      : matchingOperation.status ===
            "submitting" ||
          matchingOperation.status ===
            "reconciling"
        ? "active"
        : "danger",
    stale:
      providerState?.phase === "stale"
  };
}

export function createAccessibleSnapshotState(snapshot) {
  const activeDemoStep =
    snapshot.demo?.timeline?.find((step) => step.active) ?? null;

  return {
    activeAgents: snapshot.summary.activeAgents,
    demo: snapshot.demo
      ? {
          currentStep: snapshot.demo.currentStep,
          totalSteps: snapshot.demo.totalSteps,
          activeLabel: activeDemoStep?.label ?? null
        }
      : null,
    workItems: snapshot.workItems.map((workItem) => ({
      id: workItem.id,
      status: workItem.status,
      acceptanceReviewRevision:
        workItem
          .acceptanceReviewRevision ??
        null,
      acceptanceDecision:
        workItem.acceptanceDecision
          ? {
              decision:
                workItem
                  .acceptanceDecision
                  .decision,
              decidedAt:
                workItem
                  .acceptanceDecision
                  .decidedAt,
              decisionId:
                workItem
                  .acceptanceDecision
                  .basis?.decisionId ??
                null
            }
          : null,
      artifact: workItem.activeArtifact
        ? {
            kind: workItem.activeArtifact.kind,
            revision: workItem.activeArtifact.revision
          }
        : null,
      evidence: workItem.requiredEvidence.map((criterionKey) => {
        const latest = workItem.currentEvidence
          .filter(
            (evidence) => evidence.criterionKey === criterionKey
          )
          .at(-1);

        return {
          criterionKey,
          outcome: latest?.outcome ?? "missing"
        };
      })
    }))
  };
}

function createRunStatusLabel({
  selectedWorkItem,
  selectedRun,
  selectedIsActive,
  lastAttempt,
  availableSlots
}) {
  if (!selectedWorkItem) {
    return "No work item selected";
  }

  if (
    selectedWorkItem.status ===
    "accepted"
  ) {
    return `${selectedWorkItem.id} · accepted; explicit reopen is required before another run`;
  }

  if (selectedRun?.phase === "cancelling") {
    return `${selectedWorkItem.id} · cancellation requested${
      selectedRun.attemptId
        ? ` for attempt ${selectedRun.attemptId}`
        : ""
    }`;
  }

  if (selectedRun?.phase === "terminalizing") {
    return selectedRun.cancelRequestedAt
      ? `${selectedWorkItem.id} · saving the interrupted terminal outcome`
      : `${selectedWorkItem.id} · saving the terminal outcome; cancellation is no longer available`;
  }

  if (selectedIsActive) {
    return `${selectedWorkItem.id} · attempt ${
      selectedRun?.attemptId ?? "pending"
    } is running`;
  }

  if (availableSlots < 1) {
    return `${selectedWorkItem.id} · execution capacity is full; retry after a run settles`;
  }

  if (lastAttempt) {
    return `${selectedWorkItem.id} · latest attempt ${lastAttempt.id} is ${lastAttempt.status}`;
  }

  return `${selectedWorkItem.id} · ready to run`;
}

function createDefaultPrompt(workItem) {
  return [
    `Work on TaskSeal work item ${workItem.id}: ${workItem.title}.`,
    "Stay inside this project and report a concise result.",
    "Do not access or modify external issue trackers."
  ].join("\n");
}
