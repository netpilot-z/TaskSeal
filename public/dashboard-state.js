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
