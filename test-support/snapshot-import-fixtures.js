import {
  previewSnapshotImport
} from "../src/application/snapshot-import.js";
import {
  createWorkflow
} from "../src/domain/workflow.js";
import {
  digestProviderFactContent
} from "../src/lib/provider-snapshot.js";

export function createGitHubIssueSnapshot({
  workItemId = "TS-1",
  title = "Apply a provider snapshot safely",
  managedFields = ["title"],
  revisionId = "2026-07-26T08:01:00.000Z",
  revisionOccurredAt = revisionId,
  capturedAt = "2026-07-26T08:01:01.000Z",
  externalId = "501",
  issueNumber = "1"
} = {}) {
  const sourceObject = {
    providerObjectKey: `github:issue:${externalId}`,
    provider: "github",
    objectType: "issue",
    externalId,
    url:
      `https://github.com/netpilot-z/TaskSeal/issues/${issueNumber}`
  };
  const candidateEvent = {
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
  const fact = {
    sourceObject,
    revision: {
      id: revisionId,
      occurredAt: revisionOccurredAt
    },
    observed: {
      title,
      createdAt: candidateEvent.occurredAt
    },
    candidateEvent
  };
  fact.revision.contentDigest =
    digestProviderFactContent(fact);

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
} = {}) {
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
} = {}) {
  return previewSnapshotImport({
    snapshot,
    workflow,
    importPolicy
  });
}

export function createActor() {
  return {
    type: "human",
    id: "operator"
  };
}
