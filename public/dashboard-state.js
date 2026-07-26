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

export function shouldPollDashboard(mode, busy = false) {
  return mode !== "demo" && !busy;
}

export function semanticSnapshotKey(value) {
  return JSON.stringify(value);
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
