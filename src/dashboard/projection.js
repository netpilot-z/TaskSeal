const PROGRESS_BY_STATUS = {
  planned: 20,
  running: 45,
  reviewing: 80,
  blocked: 65,
  accepted: 100
};

export function projectDashboard(workflow) {
  const workItems = Object.values(workflow.workItems)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(projectWorkItem);

  const summary = {
    total: workItems.length,
    planned: 0,
    running: 0,
    reviewing: 0,
    blocked: 0,
    accepted: 0,
    activeAgents: 0
  };

  for (const workItem of workItems) {
    summary[workItem.status] += 1;
    summary.activeAgents += workItem.attempts.filter(
      (attempt) => attempt.status === "running"
    ).length;
  }

  return {
    generatedAt: new Date().toISOString(),
    summary,
    workItems
  };
}

function projectWorkItem(workItem) {
  const activeAttempt =
    workItem.attempts.find(
      (attempt) => attempt.id === workItem.activeAttemptId
    ) ?? null;
  const activeArtifact = workItem.activeArtifact
    ? (workItem.artifacts.find(
        (artifact) =>
          artifact.id === workItem.activeArtifact.artifactId &&
          artifact.revision === workItem.activeArtifact.revision &&
          artifact.attemptId === workItem.activeAttemptId
      ) ?? null)
    : null;
  const currentEvidence = activeArtifact
    ? workItem.evidence
        .filter(
          (evidence) =>
            evidence.attemptId === workItem.activeAttemptId &&
            evidence.artifactId === activeArtifact.id &&
            evidence.revision === activeArtifact.revision
        )
        .toSorted(
          (left, right) =>
            Date.parse(left.recordedAt) - Date.parse(right.recordedAt) ||
            left.id.localeCompare(right.id)
        )
    : [];

  return {
    id: workItem.id,
    title: workItem.title,
    status: workItem.status,
    progress: PROGRESS_BY_STATUS[workItem.status],
    requiredEvidence: workItem.requiredEvidence,
    activeAttempt,
    activeArtifact,
    currentEvidence,
    attempts: workItem.attempts,
    artifacts: workItem.artifacts,
    evidence: workItem.evidence,
    acceptanceDecision: workItem.acceptanceDecision,
    externalLinks: workItem.externalLinks
  };
}
