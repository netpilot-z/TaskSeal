import assert from "node:assert/strict";
import {
  mkdtemp,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, {
  type TestContext
} from "node:test";

import {
  GitHubDeliveryReconciliationCoordinator
} from "../src/application/github-delivery-reconciliation.ts";
import {
  LinearReadyWorkCoordinator
} from "../src/application/linear-ready-work.ts";
import {
  ManagedAttemptRunner
} from "../src/application/managed-attempt-runner.ts";
import {
  TaskSealService
} from "../src/application/taskseal-service.ts";
import type {
  GitHubDeliveryIndex
} from "../src/connectors/github-delivery-index.ts";
import {
  computeAcceptanceReviewRevision
} from "../src/domain/workflow.ts";
import {
  FileEventJournal
} from "../src/storage/event-journal.ts";
import {
  FakeRunnerAdapter
} from "../test-support/fake-runner.ts";

const ORGANIZATION_ID =
  "11111111-1111-4111-8111-111111111111";
const TEAM_ID =
  "22222222-2222-4222-8222-222222222222";
const PROJECT_ID =
  "33333333-3333-4333-8333-333333333333";
const READY_STATE_ID =
  "44444444-4444-4444-8444-444444444444";
const COMPLETED_STATE_ID =
  "55555555-5555-4555-8555-555555555555";
const LINEAR_ISSUE_ID =
  "66666666-6666-4666-8666-666666666666";
const WORK_ITEM_ID = "TS-NP-26";
const HEAD_REVISION = "abc123";

test("isolated delivery loop requires ready import, managed completion, delivery evidence, and human acceptance", async (t) => {
  const cwd =
    await createTemporaryDirectory(t);
  let serviceTime =
    "2026-07-30T09:05:00.000Z";
  const journal =
    new FileEventJournal({
      filePath: join(
        cwd,
        ".taskseal",
        "events.jsonl"
      )
    });
  const policy = createImportPolicy();
  const service =
    await TaskSealService.open({
      journal,
      importPolicyProvider:
        async () =>
          structuredClone(policy),
      providerFactProvenanceVerifier: {
        async verify(claims) {
          return claims.map(
            (claim) => ({
              schemaVersion: 1 as const,
              claimDigest:
                claim.claimDigest,
              outcome:
                "verified" as const
            })
          );
        }
      },
      clock: () =>
        new Date(serviceTime)
    });
  const ready =
    new LinearReadyWorkCoordinator({
      scope: {
        organizationId:
          ORGANIZATION_ID,
        teamId: TEAM_ID,
        teamKey: "NP",
        projectId: PROJECT_ID,
        readyStateId:
          READY_STATE_ID,
        completedStateId:
          COMPLETED_STATE_ID
      },
      reader: {
        async listIssues() {
          return [{
            id: LINEAR_ISSUE_ID,
            identifier: "NP-26",
            title:
              "Verify the local delivery loop",
            url:
              "https://linear.app/netpilot-z/issue/NP-26",
            createdAt:
              "2026-07-30T09:00:00.000Z",
            updatedAt:
              "2026-07-30T09:01:00.000Z",
            blockedByIssueIds: [],
            dependencyCompleteness:
              "complete" as const
          }];
        },
        async readIssueStates() {
          return [];
        }
      },
      dependencyIndex: {
        target: {
          organizationId:
            ORGANIZATION_ID,
          teamId: TEAM_ID,
          projectId: PROJECT_ID,
          stateId:
            READY_STATE_ID
        },
        dependenciesOf() {
          return {
            completeness:
              "complete" as const,
            issueIds: []
          };
        }
      },
      workflow: service,
      imports: service,
      importPolicy: policy,
      clock: () =>
        new Date(
          "2026-07-30T09:02:00.000Z"
        )
    });
  const readyPreview =
    await ready.previewSelection({
      issueId: LINEAR_ISSUE_ID,
      workItemId: WORK_ITEM_ID,
      requiredEvidence: [
        "review",
        "tests"
      ]
    });

  assert.equal(
    readyPreview.kind,
    "plan"
  );
  if (
    readyPreview.kind !== "plan"
  ) {
    return;
  }
  await ready.applySelection({
    issueId: LINEAR_ISSUE_ID,
    workItemId: WORK_ITEM_ID,
    requiredEvidence: [
      "review",
      "tests"
    ],
    expectedPlanDigest:
      readyPreview.plan.planDigest,
    actor: {
      type: "human",
      id: "local-operator"
    }
  });

  const runner =
    new ManagedAttemptRunner({
      service,
      projectRoot: cwd,
      adapter:
        new FakeRunnerAdapter({
          behavior(input) {
            return {
              schemaVersion: "1",
              attemptId:
                input.attemptId,
              outcome:
                "completed",
              summary:
                "Implementation completed."
            };
          }
        }),
      idFactory: () =>
        "attempt-26",
      now: sequenceClock([
        "2026-07-30T09:06:00.000Z",
        "2026-07-30T09:07:00.000Z"
      ])
    });
  const runResult =
    await runner.run({
      workItemId: WORK_ITEM_ID,
      instruction:
        "Implement the reviewed work.",
      workspaceAccess: "read-only"
    });

  assert.equal(
    runResult.outcome,
    "completed"
  );
  const afterRun =
    service.getWorkItem(
      WORK_ITEM_ID
    );
  assert.ok(afterRun);
  assert.deepEqual(
    afterRun.artifacts,
    []
  );
  assert.deepEqual(
    afterRun.evidence,
    []
  );
  serviceTime =
    "2026-07-30T09:08:00.000Z";
  await assert.rejects(
    service.decideAcceptance({
      workItemId: WORK_ITEM_ID,
      decisionId:
        "77777777-7777-4777-8777-777777777777",
      decision: "accepted",
      expectedReviewRevision:
        computeAcceptanceReviewRevision(
          afterRun
        ),
      actor: "operator.jeffrey",
      reason:
        "Agent completion alone must not be accepted."
    }),
    hasCode(
      "ACCEPTANCE_EVIDENCE_INCOMPLETE"
    )
  );

  const delivery =
    new GitHubDeliveryReconciliationCoordinator({
      repository:
        "netpilot-z/taskseal",
      index:
        createDeliveryIndex(),
      reader: {
        async readPullRequest() {
          return {
            id: 601,
            number: 58,
            html_url:
              "https://github.com/netpilot-z/TaskSeal/pull/58",
            updated_at:
              "2026-07-30T09:08:00.000Z",
            head: {
              sha: HEAD_REVISION,
              ref:
                "feature/np-26-delivery-loop",
              repo: {
                full_name:
                  "netpilot-z/TaskSeal"
              }
            }
          };
        },
        async readHeadChecks() {
          return [{
            selector: {
              name: "test",
              appId: "15368"
            },
            check: {
              id: 701,
              name: "test",
              status: "completed",
              conclusion: "success",
              head_sha:
                HEAD_REVISION,
              details_url:
                "https://github.com/netpilot-z/TaskSeal/actions/runs/701",
              completed_at:
                "2026-07-30T09:09:00.000Z",
              app: {
                id: 15368
              }
            }
          }];
        },
        async readReviews() {
          return [{
            id: 801,
            html_url:
              "https://github.com/netpilot-z/TaskSeal/pull/58#pullrequestreview-801",
            state: "APPROVED",
            submitted_at:
              "2026-07-30T09:10:00.000Z",
            commit_id:
              HEAD_REVISION,
            user: {
              id: 9001,
              login: "reviewer"
            }
          }];
        }
      },
      workflow: service,
      imports: service,
      importPolicy: policy,
      clock: () =>
        new Date(
          "2026-07-30T09:11:00.000Z"
        )
    });
  const deliveryPreview =
    await delivery.preview({
      workItemId: WORK_ITEM_ID
    });

  assert.equal(
    deliveryPreview.kind,
    "plan"
  );
  if (
    deliveryPreview.kind !==
    "plan"
  ) {
    return;
  }
  serviceTime =
    "2026-07-30T09:12:00.000Z";
  const deliveryApply =
    await delivery.apply({
      workItemId: WORK_ITEM_ID,
      expectedPlanDigest:
        deliveryPreview.plan
          .planDigest,
      actor: {
        type: "human",
        id: "local-operator"
      }
    });

  assert.deepEqual(
    deliveryApply.writes,
    {
      github: 0,
      linear: 0
    }
  );
  const reviewable =
    service.getWorkItem(
      WORK_ITEM_ID
    );
  assert.ok(reviewable);
  serviceTime =
    "2026-07-30T09:13:00.000Z";
  const acceptance =
    await service.decideAcceptance({
      workItemId: WORK_ITEM_ID,
      decisionId:
        "88888888-8888-4888-8888-888888888888",
      decision: "accepted",
      expectedReviewRevision:
        computeAcceptanceReviewRevision(
          reviewable
        ),
      actor: "operator.jeffrey",
      reason:
        "The reviewed artifact and all required evidence passed."
    });

  assert.equal(
    acceptance.resolution,
    "committed"
  );
  assert.equal(
    service.getWorkItem(
      WORK_ITEM_ID
    )?.status,
    "accepted"
  );
});

function createImportPolicy() {
  return {
    schemaVersion: 2,
    allowedScopes: [
      {
        provider: "linear",
        scopeRef: {
          kind: "team",
          key:
            `linear:team:${TEAM_ID}`,
          parentKey:
            `linear:organization:${ORGANIZATION_ID}`
        },
        objectTypes: ["issue"],
        capabilities: {
          "snapshot.import.preview": true,
          "snapshot.import.apply": true
        }
      },
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

function createDeliveryIndex():
  GitHubDeliveryIndex {
  const binding = {
    linearIssueId:
      LINEAR_ISSUE_ID,
    workItemId: WORK_ITEM_ID,
    headRepository:
      "netpilot-z/taskseal",
    branch:
      "feature/np-26-delivery-loop",
    pullRequestNumber: 58,
    evidence: [
      {
        criterionKey: "review",
        source: {
          kind:
            "pull_request_review" as const,
          reviewerId: "9001"
        }
      },
      {
        criterionKey: "tests",
        source: {
          kind:
            "check_run" as const,
          name: "test",
          appId: "15368"
        }
      }
    ],
    bindingDigest:
      `sha256:${"a".repeat(64)}`
  };

  return {
    target: {
      repository:
        "netpilot-z/taskseal"
    },
    entries: [binding],
    byWorkItem(workItemId) {
      return workItemId ===
        WORK_ITEM_ID
        ? structuredClone(binding)
        : null;
    }
  };
}

function sequenceClock(
  timestamps: readonly string[]
): () => Date {
  let index = 0;
  return () => {
    const timestamp =
      timestamps[
        Math.min(
          index,
          timestamps.length - 1
        )
      ];
    index += 1;
    assert.ok(timestamp);
    return new Date(timestamp);
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

async function createTemporaryDirectory(
  t: TestContext
): Promise<string> {
  const directory =
    await mkdtemp(
      join(
        tmpdir(),
        "taskseal-delivery-loop-"
      )
    );
  t.after(() =>
    rm(directory, {
      recursive: true,
      force: true
    })
  );
  return directory;
}
