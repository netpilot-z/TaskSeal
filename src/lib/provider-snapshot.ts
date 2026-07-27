import {
  digestCanonicalJson
} from "./canonical-json.ts";
import type {
  ArtifactLinkedEvent,
  EvidenceRecordedEvent,
  ManagedField,
  WorkItemCreatedEvent
} from "../domain/workflow.ts";

export type ProviderName = "github" | "linear";

export type ProviderObjectType =
  | "check"
  | "issue"
  | "pull_request";

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

export type ProviderFact =
  | ProviderIssueFact
  | ProviderPullRequestFact
  | ProviderCheckFact;

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
