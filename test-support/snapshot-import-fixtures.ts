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
  ProviderCheckFact,
  ProviderIssueFact,
  ProviderPullRequestFact,
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

export interface LinearIssueSnapshotFixture
  extends Omit<
    ProviderSnapshotV2,
    "provider" | "facts"
  > {
  provider: "linear";
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
  previewAllowed = true,
  applyAllowed = true,
  objectTypes = ["issue"]
}: {
  previewAllowed?: boolean | undefined;
  applyAllowed?: boolean | undefined;
  objectTypes?:
    | Array<"check" | "issue" | "pull_request">
    | undefined;
} = {}): NormalizedImportPolicy {
  return {
    schemaVersion: 2,
    allowedScopes: [
      {
        provider: "github",
        scopeRef: {
          kind: "repository",
          key: "github:repository:netpilot-z/taskseal"
        },
        objectTypes,
        capabilities: {
          "snapshot.import.preview": previewAllowed,
          "snapshot.import.apply": applyAllowed
        }
      }
    ]
  };
}

export function createGitHubDeliverySnapshot():
  ProviderSnapshotV2 {
  const pullRequestSource:
    ProviderPullRequestFact["sourceObject"] = {
      providerObjectKey: "github:pull_request:601",
      provider: "github",
      objectType: "pull_request",
      externalId: "601",
      url:
        "https://github.com/netpilot-z/TaskSeal/pull/2"
    };
  const pullRequestObserved:
    ProviderPullRequestFact["observed"] = {
      headRevision: "abc123"
    };
  const pullRequest:
    ProviderPullRequestFact = {
      sourceObject: pullRequestSource,
      revision: {
        id: "2026-07-26T08:03:00.000Z",
        occurredAt: "2026-07-26T08:03:00.000Z",
        contentDigest: digestProviderFactContent({
          sourceObject: pullRequestSource,
          observed: pullRequestObserved
        })
      },
      observed: pullRequestObserved,
      candidateEvent: {
        eventId:
          "github:pr-601:abc123:2026-07-26T08:03:00.000Z",
        workItemId: "TS-1",
        type: "artifact.linked",
        occurredAt: "2026-07-26T08:03:00.000Z",
        payload: {
          artifactId: "pr-601",
          attemptId: "run-1",
          kind: "pull_request",
          revision: "abc123",
          url: pullRequestSource.url
        }
      }
    };
  const checkSource:
    ProviderCheckFact["sourceObject"] = {
      providerObjectKey: "github:check:701",
      provider: "github",
      objectType: "check",
      externalId: "701",
      url:
        "https://github.com/netpilot-z/TaskSeal/actions/runs/7"
    };
  const checkObserved:
    ProviderCheckFact["observed"] = {
      headRevision: "abc123",
      outcome: "passed"
    };
  const check: ProviderCheckFact = {
    sourceObject: checkSource,
    revision: {
      id: "2026-07-26T08:04:00.000Z",
      occurredAt: "2026-07-26T08:04:00.000Z",
      contentDigest: digestProviderFactContent({
        sourceObject: checkSource,
        observed: checkObserved
      })
    },
    observed: checkObserved,
    candidateEvent: {
      eventId: "github:check-701:abc123",
      workItemId: "TS-1",
      type: "evidence.recorded",
      occurredAt: "2026-07-26T08:04:00.000Z",
      payload: {
        evidenceId: "check-701",
        attemptId: "run-1",
        artifactId: "pr-601",
        revision: "abc123",
        criterionKey: "tests",
        outcome: "passed",
        url: checkSource.url
      }
    }
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
      workItemId: "TS-1",
      requiredEvidence: ["tests"],
      managedFields: [],
      attemptId: "run-1",
      artifactId: "pr-601",
      artifactRevision: "abc123",
      criterionKey: "tests"
    },
    capturedAt: "2026-07-26T08:04:01.000Z",
    facts: [pullRequest, check]
  };
}

export function createLinearIssueSnapshot():
  LinearIssueSnapshotFixture {
  const externalId =
    "11111111-1111-4111-8111-111111111111";
  const title = "Import a Linear issue safely";
  const sourceObject:
    ProviderIssueFact["sourceObject"] = {
      providerObjectKey: `linear:issue:${externalId}`,
      provider: "linear",
      objectType: "issue",
      externalId,
      url:
        "https://linear.app/taskseal/issue/NET-7/example"
    };
  const observed: ProviderIssueFact["observed"] = {
    title,
    createdAt: "2026-07-26T08:00:00.000Z"
  };
  const candidateEvent:
    ProviderIssueFact["candidateEvent"] = {
      eventId: `linear:${externalId}:created`,
      workItemId: "TS-1",
      type: "work_item.created",
      occurredAt: observed.createdAt,
      payload: {
        title,
        requiredEvidence: ["tests"],
        externalLink: {
          provider: "linear",
          externalId,
          url: sourceObject.url
        }
      }
    };
  const fact: ProviderIssueFact = {
    sourceObject,
    revision: {
      id: "2026-07-26T08:01:00.000Z",
      occurredAt: "2026-07-26T08:01:00.000Z",
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
    provider: "linear",
    scope: {
      kind: "team",
      key:
        "linear:team:22222222-2222-4222-8222-222222222222",
      parentKey:
        "linear:organization:33333333-3333-4333-8333-333333333333"
    },
    mapping: {
      workItemId: "TS-1",
      requiredEvidence: ["tests"],
      managedFields: ["title"]
    },
    capturedAt: "2026-07-26T08:01:01.000Z",
    facts: [fact]
  };
}

export function createLinearImportPolicy():
  NormalizedImportPolicy {
  return {
    schemaVersion: 2,
    allowedScopes: [
      {
        provider: "linear",
        scopeRef: {
          kind: "team",
          key:
            "linear:team:22222222-2222-4222-8222-222222222222",
          parentKey:
            "linear:organization:33333333-3333-4333-8333-333333333333"
        },
        objectTypes: ["issue"],
        capabilities: {
          "snapshot.import.preview": true,
          "snapshot.import.apply": true
        }
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
