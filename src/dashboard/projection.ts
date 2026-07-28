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
import {
  computeAcceptanceReviewRevision
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
  progress: {
    basis:
      "acceptance-and-current-evidence";
    accepted: boolean;
    passedEvidence: number;
    failedEvidence: number;
    missingEvidence: number;
    totalEvidence: number;
    uncertainty:
      | "verified"
      | "incomplete";
  };
  requiredEvidence: string[];
  activeAttempt: Attempt | null;
  activeArtifact: Artifact | null;
  currentEvidence: Evidence[];
  attempts: Attempt[];
  artifacts: Artifact[];
  evidence: Evidence[];
  acceptanceDecision: AcceptanceDecision | null;
  acceptanceReviewRevision: string;
  acceptanceHistory: AcceptanceDecision[];
  externalLinks: ExternalLink[];
}

export interface DashboardProjection {
  generatedAt: string;
  summary: DashboardSummary;
  workItems: DashboardWorkItem[];
}

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
    progress:
      projectDeliveryProgress(
        workItem,
        currentEvidence
      ),
    requiredEvidence: workItem.requiredEvidence,
    activeAttempt,
    activeArtifact,
    currentEvidence,
    attempts: workItem.attempts,
    artifacts: workItem.artifacts,
    evidence: workItem.evidence,
    acceptanceDecision: workItem.acceptanceDecision,
    acceptanceReviewRevision:
      computeAcceptanceReviewRevision(
        workItem
      ),
    acceptanceHistory:
      workItem.acceptanceHistory,
    externalLinks: workItem.externalLinks
  };
}

function projectDeliveryProgress(
  workItem: WorkItem,
  currentEvidence: readonly Evidence[]
): DashboardWorkItem["progress"] {
  const latestByCriterion =
    new Map<string, Evidence>();

  for (const evidence of currentEvidence) {
    if (
      !workItem.requiredEvidence.includes(
        evidence.criterionKey
      )
    ) {
      continue;
    }
    const prior =
      latestByCriterion.get(
        evidence.criterionKey
      );
    if (
      prior === undefined ||
      Date.parse(evidence.recordedAt) >
        Date.parse(prior.recordedAt)
    ) {
      latestByCriterion.set(
        evidence.criterionKey,
        evidence
      );
    }
  }

  let passedEvidence = 0;
  let failedEvidence = 0;
  for (const evidence of latestByCriterion.values()) {
    if (evidence.outcome === "passed") {
      passedEvidence += 1;
    } else {
      failedEvidence += 1;
    }
  }
  const accepted =
    workItem.status === "accepted";

  return {
    basis:
      "acceptance-and-current-evidence",
    accepted,
    passedEvidence,
    failedEvidence,
    missingEvidence:
      workItem.requiredEvidence.length -
      latestByCriterion.size,
    totalEvidence:
      workItem.requiredEvidence.length,
    uncertainty: accepted
      ? "verified"
      : "incomplete"
  };
}
