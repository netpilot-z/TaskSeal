import {
  digestCanonicalJson
} from "./canonical-json.ts";
import type {
  ArtifactLinkedEvent,
  EvidenceRecordedEvent,
  ManagedField,
  WorkItemCreatedEvent
} from "../domain/workflow.ts";

// Read-model membership does not grant import; that allowlist is ImportProvider.
export type ProviderName = "github" | "linear" | "gitee";

export type ProviderObjectType =
  | "check"
  | "issue"
  | "pull_request"
  | "pull_request_review";

export interface ProviderSourceObject {
  providerObjectKey: string;
  provider: ProviderName;
  objectType: ProviderObjectType;
  externalId: string;
  url: string;
}

export interface ProviderRevision {
  id: string;
  occurredAt: string;
  contentDigest: string;
}

export interface ProviderIssueObservation {
  title: string;
  createdAt: string;
}

export interface ProviderPullRequestObservation {
  headRevision: string;
}

export interface ProviderCheckObservation {
  headRevision: string;
  outcome: "passed" | "failed";
  name?: string;
  appId?: string;
  pullRequestRevisionId?: string;
}

export type ProviderPullRequestReviewState =
  | "approved"
  | "changes_requested"
  | "dismissed";

export interface ProviderPullRequestReviewObservation {
  headRevision: string;
  reviewerId: string;
  state: ProviderPullRequestReviewState;
  outcome: "passed" | "failed";
}

export interface ProviderIssueFact {
  sourceObject: ProviderSourceObject & {
    objectType: "issue";
  };
  revision: ProviderRevision;
  observed: ProviderIssueObservation;
  candidateEvent: WorkItemCreatedEvent;
}

export interface ProviderPullRequestFact {
  sourceObject: ProviderSourceObject & {
    provider: "github";
    objectType: "pull_request";
  };
  revision: ProviderRevision;
  observed: ProviderPullRequestObservation;
  candidateEvent: ArtifactLinkedEvent;
}

export interface ProviderCheckFact {
  sourceObject: ProviderSourceObject & {
    provider: "github";
    objectType: "check";
  };
  revision: ProviderRevision;
  observed: ProviderCheckObservation;
  candidateEvent: EvidenceRecordedEvent;
}

export interface ProviderPullRequestReviewFact {
  sourceObject: ProviderSourceObject & {
    provider: "github";
    objectType: "pull_request_review";
  };
  revision: ProviderRevision;
  observed:
    ProviderPullRequestReviewObservation;
  candidateEvent: EvidenceRecordedEvent;
}

export type ProviderFact =
  | ProviderIssueFact
  | ProviderPullRequestFact
  | ProviderCheckFact
  | ProviderPullRequestReviewFact;

export interface ProviderSnapshotScope {
  kind: "repository" | "team";
  key: string;
  parentKey?: string;
}

export interface ProviderSnapshotMapping {
  workItemId: string;
  requiredEvidence: string[];
  managedFields: ManagedField[];
  attemptId?: string;
  artifactId?: string;
  artifactRevision?: string;
  criterionKey?: string;
  deliveryBindingDigest?: string;
  pullRequestNumber?: number;
  evidenceBindings?: Array<{
    providerObjectKey: string;
    criterionKey: string;
    source:
      | {
          kind: "check_run";
          name: string;
          appId?: string;
        }
      | {
          kind:
            "pull_request_review";
          reviewerId: string;
        };
  }>;
}

export interface ProviderSnapshotV2 {
  schemaVersion: 2;
  mode: "read-only";
  provider: ProviderName;
  scope: ProviderSnapshotScope;
  mapping: ProviderSnapshotMapping;
  capturedAt: string;
  facts: ProviderFact[];
}

export function digestProviderFactContent(
  fact: {
    sourceObject: unknown;
    observed: unknown;
  }
): string {
  return digestCanonicalJson({
    sourceObject: fact.sourceObject,
    observed: fact.observed
  });
}

export function deriveGitHubDeliveryEventId({
  deliveryBindingDigest,
  workItemId,
  attemptId,
  artifactId,
  artifactRevision,
  sourceObjectKey,
  sourceRevisionId,
  criterionKey
}: {
  deliveryBindingDigest: string;
  workItemId: string;
  attemptId: string;
  artifactId: string;
  artifactRevision: string;
  sourceObjectKey: string;
  sourceRevisionId: string;
  criterionKey?: string | undefined;
}): string {
  const digest = digestCanonicalJson({
    schemaVersion: 1,
    kind:
      criterionKey === undefined
        ? "artifact"
        : "evidence",
    deliveryBindingDigest,
    workItemId,
    attemptId,
    artifactId,
    artifactRevision,
    sourceObjectKey,
    sourceRevisionId,
    ...(criterionKey === undefined
      ? {}
      : { criterionKey })
  });

  return `github:delivery:${digest.slice("sha256:".length)}`;
}

export function deriveGitHubCheckSourceRevision({
  completedAt,
  name,
  appId,
  pullRequestRevisionId
}: {
  completedAt: string;
  name: string;
  appId: string;
  pullRequestRevisionId: string;
}): string {
  return digestCanonicalJson({
    schemaVersion: 2,
    kind: "github_check_run",
    completedAt,
    name,
    appId,
    pullRequestRevisionId
  });
}

export function deriveGitHubReviewSourceRevision({
  pullRequestUpdatedAt,
  state
}: {
  pullRequestUpdatedAt: string;
  state: ProviderPullRequestReviewState;
}): string {
  return `${pullRequestUpdatedAt}:${state}`;
}
