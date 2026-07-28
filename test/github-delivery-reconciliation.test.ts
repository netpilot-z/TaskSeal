import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubDeliveryReconciliationCoordinator
} from "../src/application/github-delivery-reconciliation.ts";
import type {
  GitHubDeliveryReadPort
} from "../src/application/github-delivery-reconciliation.ts";
import type {
  ImportPlan
} from "../src/application/import-plan.ts";
import type {
  GitHubDeliveryBinding,
  GitHubDeliveryIndex
} from "../src/connectors/github-delivery-index.ts";
import type {
  GitHubHeadCheckMatch,
  GitHubPullRequest,
  GitHubPullRequestReview
} from "../src/connectors/github-read-client.ts";
import {
  applyEvent,
  createWorkflow
} from "../src/domain/workflow.ts";
import type {
  CanonicalEvent,
  Workflow
} from "../src/domain/workflow.ts";

const LINEAR_ISSUE_ID =
  "4f3ce2c1-5415-403b-9129-698cac96d987";
const BINDING_DIGEST =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_SHA = "abc123";

const BINDING: GitHubDeliveryBinding =
  Object.freeze({
    linearIssueId: LINEAR_ISSUE_ID,
    workItemId: "TS-NP-6",
    headRepository:
      "netpilot-z/taskseal",
    branch:
      "feature/np-6-github-evidence",
    pullRequestNumber: 58,
    evidence: Object.freeze([
      Object.freeze({
        criterionKey: "review",
        source: Object.freeze({
          kind:
            "pull_request_review" as const,
          reviewerId: "9001"
        })
      }),
      Object.freeze({
        criterionKey: "tests",
        source: Object.freeze({
          kind: "check_run" as const,
          name: "test",
          appId: "15368"
        })
      })
    ]),
    bindingDigest: BINDING_DIGEST
  });

const PULL_REQUEST: GitHubPullRequest = {
  id: 601,
  number: 58,
  html_url:
    "https://github.com/netpilot-z/TaskSeal/pull/58",
  updated_at:
    "2026-07-28T10:03:00.000Z",
  head: {
    sha: HEAD_SHA,
    ref:
      "feature/np-6-github-evidence",
    repo: {
      full_name:
        "netpilot-z/TaskSeal"
    }
  }
};

const CHECK_MATCH: GitHubHeadCheckMatch = {
  selector: {
    name: "test",
    appId: "15368"
  },
  check: {
    id: 701,
    name: "test",
    status: "completed",
    conclusion: "success",
    head_sha: HEAD_SHA,
    details_url:
      "https://github.com/netpilot-z/TaskSeal/actions/runs/701",
    completed_at:
      "2026-07-28T10:04:00.000Z",
    app: {
      id: 15368
    }
  }
};

const REVIEW: GitHubPullRequestReview = {
  id: 801,
  html_url:
    "https://github.com/netpilot-z/TaskSeal/pull/58#pullrequestreview-801",
  state: "APPROVED",
  submitted_at:
    "2026-07-28T10:05:00.000Z",
  commit_id: HEAD_SHA,
  user: {
    id: 9001,
    login: "reviewer"
  }
};

test("reconciliation binds one mapped PR head and every explicit evidence selector", async () => {
  const fixture = createFixture();

  const preview =
    await fixture.coordinator.preview({
      workItemId: "TS-NP-6"
    });

  assert.equal(preview.kind, "plan");
  if (preview.kind !== "plan") {
    return;
  }

  assert.equal(
    preview.headRevision,
    HEAD_SHA
  );
  assert.deepEqual(
    preview.evidence,
    [
      {
        criterionKey: "review",
        state: "observed",
        outcome: "passed",
        sourceKind:
          "pull_request_review"
      },
      {
        criterionKey: "tests",
        state: "observed",
        outcome: "passed",
        sourceKind: "check_run"
      }
    ]
  );
  assert.deepEqual(
    preview.plan.events.map(
      (event) => [
        event.type,
        event.type ===
          "evidence.recorded"
          ? event.payload.criterionKey
          : event.payload.revision
      ]
    ),
    [
      ["artifact.linked", HEAD_SHA],
      ["evidence.recorded", "review"],
      ["evidence.recorded", "tests"]
    ]
  );
  assert.deepEqual(
    preview.writes,
    {
      github: 0,
      linear: 0
    }
  );
});

test("mapping and WorkItem ownership are validated before any GitHub read", async () => {
  const workflow =
    createRunningWorkflow({
      linearIssueId:
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    });
  const fixture = createFixture({
    workflow
  });

  await assert.rejects(
    fixture.coordinator.preview({
      workItemId: "TS-NP-6"
    }),
    hasCode(
      "GITHUB_DELIVERY_LINEAR_MAPPING_MISMATCH"
    )
  );
  assert.equal(fixture.calls.total, 0);
});

test("a missing or pending criterion still imports the new artifact and cannot preserve old-head evidence", async () => {
  const fixture = createFixture({
    checkMatches: [
      {
        ...CHECK_MATCH,
        check: {
          ...CHECK_MATCH.check!,
          status: "in_progress",
          conclusion: null,
          completed_at: null
        }
      }
    ],
    reviews: [
      {
        ...REVIEW,
        commit_id: "old-head"
      }
    ]
  });

  const preview =
    await fixture.coordinator.preview({
      workItemId: "TS-NP-6"
    });

  assert.equal(preview.kind, "plan");
  if (preview.kind !== "plan") {
    return;
  }

  assert.deepEqual(
    preview.missingEvidence,
    ["review", "tests"]
  );
  assert.deepEqual(
    preview.plan.events.map(
      (event) => event.type
    ),
    ["artifact.linked"]
  );
});

test("the same mapped facts become an unchanged preview after their canonical events are represented", async () => {
  const firstFixture = createFixture();
  const first =
    await firstFixture.coordinator.preview({
      workItemId: "TS-NP-6"
    });
  assert.equal(first.kind, "plan");
  if (first.kind !== "plan") {
    return;
  }

  const represented =
    first.plan.events.reduce(
      (workflow, event) =>
        applyEvent(
          workflow,
          event as unknown as CanonicalEvent
        ),
      firstFixture.workflow
    );
  const secondFixture = createFixture({
    workflow: represented
  });
  const second =
    await secondFixture.coordinator.preview({
      workItemId: "TS-NP-6"
    });

  assert.equal(second.kind, "unchanged");
  assert.equal(second.headRevision, HEAD_SHA);
  assert.deepEqual(second.missingEvidence, []);
});

test("same-head PR metadata drift does not conflict with an existing artifact or duplicate unchanged evidence", async () => {
  const firstFixture = createFixture();
  const first =
    await firstFixture.coordinator.preview({
      workItemId: "TS-NP-6"
    });
  assert.equal(first.kind, "plan");
  if (first.kind !== "plan") {
    return;
  }
  const represented =
    first.plan.events.reduce(
      (workflow, event) =>
        applyEvent(
          workflow,
          event as unknown as CanonicalEvent
        ),
      firstFixture.workflow
    );
  const changedMetadata = {
    ...PULL_REQUEST,
    updated_at:
      "2026-07-28T10:09:00.000Z"
  };
  const secondFixture = createFixture({
    workflow: represented,
    pullRequests: [
      changedMetadata
    ]
  });
  const second =
    await secondFixture.coordinator.preview({
      workItemId: "TS-NP-6"
    });

  assert.equal(second.kind, "unchanged");
});

test("a PR mutation between fact collection and the final head fence fails closed", async () => {
  const fixture = createFixture({
    pullRequests: [
      PULL_REQUEST,
      {
        ...PULL_REQUEST,
        updated_at:
          "2026-07-28T10:06:00.000Z",
        head: {
          ...PULL_REQUEST.head,
          sha: "new-head"
        }
      }
    ]
  });

  await assert.rejects(
    fixture.coordinator.preview({
      workItemId: "TS-NP-6"
    }),
    hasCode(
      "GITHUB_DELIVERY_REVISION_RACE"
    )
  );
  assert.equal(fixture.calls.apply, 0);
});

test("apply rebuilds the remote plan and refuses a stale reviewed digest", async () => {
  const fixture = createFixture();
  const preview =
    await fixture.coordinator.preview({
      workItemId: "TS-NP-6"
    });
  assert.equal(preview.kind, "plan");

  await assert.rejects(
    fixture.coordinator.apply({
      workItemId: "TS-NP-6",
      expectedPlanDigest:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      actor: {
        type: "human",
        id: "local-operator"
      }
    }),
    hasCode(
      "GITHUB_DELIVERY_PLAN_STALE"
    )
  );
  assert.equal(fixture.calls.apply, 0);
});

function createFixture({
  workflow = createRunningWorkflow(),
  pullRequests = [PULL_REQUEST],
  checkMatches = [CHECK_MATCH],
  reviews = [REVIEW]
}: {
  workflow?: Workflow;
  pullRequests?:
    readonly GitHubPullRequest[];
  checkMatches?:
    readonly GitHubHeadCheckMatch[];
  reviews?:
    readonly GitHubPullRequestReview[];
} = {}) {
  const calls = {
    pullRequest: 0,
    checks: 0,
    reviews: 0,
    apply: 0,
    get total() {
      return (
        this.pullRequest +
        this.checks +
        this.reviews
      );
    }
  };
  let pullRequestIndex = 0;
  const reader: GitHubDeliveryReadPort = {
    async readPullRequest(options) {
      calls.pullRequest += 1;
      assert.equal(
        options.repository,
        "netpilot-z/taskseal"
      );
      const value =
        pullRequests[
          Math.min(
            pullRequestIndex,
            pullRequests.length - 1
          )
        ];
      pullRequestIndex += 1;
      assert.ok(value);
      return structuredClone(value);
    },
    async readHeadChecks(options) {
      calls.checks += 1;
      assert.equal(
        options.headSha,
        HEAD_SHA
      );
      return structuredClone(
        checkMatches
      );
    },
    async readReviews(options) {
      calls.reviews += 1;
      assert.equal(
        options.pullRequestNumber,
        58
      );
      return structuredClone(reviews);
    }
  };
  const index: GitHubDeliveryIndex = {
    target: {
      repository:
        "netpilot-z/taskseal"
    },
    entries: [BINDING],
    byWorkItem(workItemId) {
      return workItemId ===
        BINDING.workItemId
        ? structuredClone(BINDING)
        : null;
    }
  };
  const coordinator =
    new GitHubDeliveryReconciliationCoordinator({
      repository:
        "netpilot-z/taskseal",
      index,
      reader,
      workflow: {
        getWorkflow: () =>
          structuredClone(workflow)
      },
      imports: {
        getImportReceiptContext() {
          return null;
        },
        async applySnapshotImport({
          plan
        }) {
          calls.apply += 1;
          const normalizedPlan =
            plan as ImportPlan;
          return {
            resolution:
              "committed" as const,
            receipt: {
              batchId: "batch-1",
              planDigest:
                normalizedPlan.planDigest,
              snapshotDigest:
                normalizedPlan.snapshotDigest,
              mappingDigest:
                normalizedPlan.mappingDigest,
              policyDigest:
                normalizedPlan.policyDigest,
              baseWorkflowDigest:
                normalizedPlan.baseWorkflowDigest,
              eventIds:
                normalizedPlan.events.map(
                  (event) =>
                    event.eventId
                ),
              appliedAt:
                "2026-07-28T10:07:00.000Z",
              actor: {
                type:
                  "human" as const,
                id:
                  "local-operator"
              },
              outcome:
                "applied" as const,
              skippedCodes: [],
              warningCodes: []
            }
          };
        }
      },
      importPolicy: createPolicy(),
      clock: () =>
        new Date(
          "2026-07-28T10:06:00.000Z"
        )
    });

  return {
    coordinator,
    workflow,
    calls
  };
}

function createRunningWorkflow({
  linearIssueId = LINEAR_ISSUE_ID
}: {
  linearIssueId?: string;
} = {}): Workflow {
  const created = applyEvent(
    createWorkflow(),
    {
      eventId:
        "taskseal:TS-NP-6:created",
      workItemId: "TS-NP-6",
      type: "work_item.created",
      occurredAt:
        "2026-07-28T09:00:00.000Z",
      payload: {
        title:
          "Collect GitHub delivery evidence",
        requiredEvidence: [
          "review",
          "tests"
        ],
        externalLink: {
          providerObjectKey:
            `linear:issue:${linearIssueId}`,
          provider: "linear",
          objectType: "issue",
          externalId: linearIssueId,
          scopeRef: {
            kind: "team",
            key:
              "linear:team:658d1189-f63d-4245-b761-0f4f2c389663",
            parentKey:
              "linear:organization:7eb4877f-0fa0-429c-9cd2-76dfffa0f20b"
          },
          url:
            "https://linear.app/netpilot/issue/NP-6",
          managedFields: [],
          lastObservation: {
            revisionId:
              "2026-07-28T09:00:00.000Z",
            occurredAt:
              "2026-07-28T09:00:00.000Z",
            contentDigest:
              "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            title:
              "Collect GitHub delivery evidence",
            url:
              "https://linear.app/netpilot/issue/NP-6"
          }
        }
      }
    }
  );

  return applyEvent(created, {
    eventId:
      "taskseal:TS-NP-6:attempt-1:started",
    workItemId: "TS-NP-6",
    type: "attempt.started",
    occurredAt:
      "2026-07-28T09:01:00.000Z",
    payload: {
      attemptId: "attempt-1",
      agentId: "codex"
    }
  });
}

function createPolicy() {
  return {
    schemaVersion: 2,
    allowedScopes: [
      {
        provider: "github",
        scopeRef: {
          kind: "repository",
          key:
            "github:repository:netpilot-z/taskseal"
        },
        objectTypes: [
          "pull_request",
          "check",
          "pull_request_review"
        ],
        capabilities: {
          "snapshot.import.preview": true,
          "snapshot.import.apply": true
        }
      }
    ]
  };
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}
