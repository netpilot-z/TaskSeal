import type { ImportActor } from "../src/application/import-batch.ts";
import type { ImportPlan } from "../src/application/import-plan.ts";
import type { Workflow } from "../src/domain/workflow.ts";

export interface GitHubIssueSnapshotOptions {
  workItemId?: string;
  title?: string;
  managedFields?: string[];
  revisionId?: string;
  revisionOccurredAt?: string;
  capturedAt?: string;
  externalId?: string;
  issueNumber?: string;
}

export function createGitHubIssueSnapshot(
  options?: GitHubIssueSnapshotOptions
): unknown;

export function createImportPolicy(options?: {
  applyAllowed?: boolean;
}): unknown;

export function createPreviewPlan(options?: {
  workflow?: Workflow;
  importPolicy?: unknown;
  snapshot?: unknown;
}): ImportPlan;

export function createActor(): ImportActor;
