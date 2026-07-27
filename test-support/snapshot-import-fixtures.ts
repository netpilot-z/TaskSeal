import {
  previewSnapshotImport
} from "../src/application/snapshot-import.ts";
import type {
  ImportActor
} from "../src/application/import-batch.ts";
import type {
  ImportPlan
} from "../src/application/import-plan.ts";
import type {
  NormalizedImportPolicy
} from "../src/application/import-policy.ts";
import {
  createWorkflow
} from "../src/domain/workflow.ts";
import type {
  ManagedField,
  Workflow
} from "../src/domain/workflow.ts";
import {
  digestProviderFactContent
} from "../src/lib/provider-snapshot.ts";
import type {
  ProviderIssueFact,
  ProviderSnapshotV2
} from "../src/lib/provider-snapshot.ts";

export interface GitHubIssueSnapshotOptions {
  workItemId?: string | undefined;
  title?: string | undefined;
  managedFields?: ManagedField[] | undefined;
  revisionId?: string | undefined;
  revisionOccurredAt?: string | undefined;
  capturedAt?: string | undefined;
  externalId?: string | undefined;
  issueNumber?: string | undefined;
}

export interface GitHubIssueSnapshotFixture
  extends Omit<
    ProviderSnapshotV2,
    "provider" | "facts"
  > {
  provider: "github";
  facts: [ProviderIssueFact];
}

export function createGitHubIssueSnapshot({
  workItemId = "TS-1",
  title = "Apply a provider snapshot safely",
  managedFields = ["title"],
  revisionId = "2026-07-26T08:01:00.000Z",
  revisionOccurredAt = revisionId,
  capturedAt = "2026-07-26T08:01:01.000Z",
  externalId = "501",
  issueNumber = "1"
}: GitHubIssueSnapshotOptions = {}):
  GitHubIssueSnapshotFixture {
  const sourceObject:
    ProviderIssueFact["sourceObject"] = {
      providerObjectKey: `github:issue:${externalId}`,
      provider: "github",
      objectType: "issue",
      externalId,
      url:
        `https://github.com/netpilot-z/TaskSeal/issues/` +
        issueNumber
    };
  const candidateEvent:
    ProviderIssueFact["candidateEvent"] = {
      eventId: `github:issue-${externalId}:created`,
      workItemId,
      type: "work_item.created",
      occurredAt: "2026-07-26T08:00:00.000Z",
      payload: {
        title,
        requiredEvidence: ["tests"],
        externalLink: {
          provider: "github",
          externalId,
          url: sourceObject.url
        }
      }
    };
  const observed: ProviderIssueFact["observed"] = {
    title,
    createdAt: candidateEvent.occurredAt
  };
  const fact: ProviderIssueFact = {
    sourceObject,
    revision: {
      id: revisionId,
      occurredAt: revisionOccurredAt,
      contentDigest: digestProviderFactContent({
        sourceObject,
        observed
      })
    },
    observed,
    candidateEvent
  };

  return {
    schemaVersion: 2,
    mode: "read-only",
    provider: "github",
    scope: {
      kind: "repository",
      key: "github:repository:netpilot-z/taskseal"
    },
    mapping: {
      workItemId,
      requiredEvidence: ["tests"],
      managedFields
    },
    capturedAt,
    facts: [fact]
  };
}

export function createImportPolicy({
  applyAllowed = true
}: {
  applyAllowed?: boolean | undefined;
} = {}): NormalizedImportPolicy {
  return {
    schemaVersion: 1,
    capabilities: {
      "snapshot.import.apply": applyAllowed
    },
    allowedScopes: [
      {
        provider: "github",
        scopeRef: {
          kind: "repository",
          key: "github:repository:netpilot-z/taskseal"
        },
        objectTypes: ["issue"]
      }
    ]
  };
}

export function createPreviewPlan({
  workflow = createWorkflow(),
  importPolicy = createImportPolicy(),
  snapshot = createGitHubIssueSnapshot()
}: {
  workflow?: Workflow | undefined;
  importPolicy?: unknown;
  snapshot?: unknown;
} = {}): ImportPlan {
  return previewSnapshotImport({
    snapshot,
    workflow,
    importPolicy
  });
}

export function createActor(): ImportActor {
  return {
    type: "human",
    id: "operator"
  };
}
