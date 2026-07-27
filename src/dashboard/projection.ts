import type {
  AcceptanceDecision,
  Artifact,
  Attempt,
  Evidence,
  ExternalLink,
  Workflow,
  WorkItem,
  WorkItemStatus
} from "../domain/workflow.ts";

export interface DashboardSummary {
  total: number;
  planned: number;
  running: number;
  reviewing: number;
  blocked: number;
  accepted: number;
  activeAgents: number;
}

export interface DashboardWorkItem {
  id: string;
  title: string;
  status: WorkItemStatus;
  progress: number;
  requiredEvidence: string[];
  activeAttempt: Attempt | null;
  activeArtifact: Artifact | null;
  currentEvidence: Evidence[];
  attempts: Attempt[];
  artifacts: Artifact[];
  evidence: Evidence[];
  acceptanceDecision: AcceptanceDecision | null;
  externalLinks: ExternalLink[];
}

export interface DashboardProjection {
  generatedAt: string;
  summary: DashboardSummary;
  workItems: DashboardWorkItem[];
}

const PROGRESS_BY_STATUS: Readonly<Record<WorkItemStatus, number>> = {
  planned: 20,
  running: 45,
  reviewing: 80,
  blocked: 65,
  accepted: 100
};

export function projectDashboard(
  workflow: Workflow
): DashboardProjection {
  const workItems = Object.values(workflow.workItems)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(projectWorkItem);

  const summary: DashboardSummary = {
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

function projectWorkItem(
  workItem: WorkItem
): DashboardWorkItem {
  const activeAttempt =
    workItem.attempts.find(
      (attempt) => attempt.id === workItem.activeAttemptId
    ) ?? null;
  const activeArtifactRef = workItem.activeArtifact;
  const activeArtifact = activeArtifactRef
    ? (workItem.artifacts.find(
        (artifact) =>
          artifact.id === activeArtifactRef.artifactId &&
          artifact.revision === activeArtifactRef.revision &&
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
