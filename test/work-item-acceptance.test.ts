import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEvent,
  computeAcceptanceReviewRevision,
  createWorkflow
} from "../src/domain/workflow.ts";
import type {
  Workflow,
  WorkItem
} from "../src/domain/workflow.ts";

const WORK_ITEM_ID = "TS-ACCEPT";
const DECISION_ID =
  "11111111-1111-4111-8111-111111111111";

test("v2 acceptance binds the current review and records an auditable history", () => {
  const reviewing = completedReview();
  const workItem = requireWorkItem(reviewing);
  const reviewRevision =
    computeAcceptanceReviewRevision(workItem);

  const accepted = applyEvent(reviewing, {
    eventId: `taskseal:acceptance:${DECISION_ID}`,
    workItemId: WORK_ITEM_ID,
    type: "acceptance.decided",
    occurredAt: "2026-07-28T00:05:00.000Z",
    payload: {
      decision: "accepted",
      actor: "operator.jeffrey",
      reason: "The current revision passed every required check.",
      decisionId: DECISION_ID,
      expectedReviewRevision: reviewRevision
    }
  });

  const result = requireWorkItem(accepted);
  assert.equal(result.status, "accepted");
  assert.deepEqual(result.acceptanceDecision, {
    decision: "accepted",
    actor: "operator.jeffrey",
    reason:
      "The current revision passed every required check.",
    decidedAt: "2026-07-28T00:05:00.000Z",
    basis: {
      decisionId: DECISION_ID,
      reviewRevision,
      attemptId: "attempt-1",
      artifactId: "artifact-1",
      artifactRevision: "head-1"
    }
  });
  assert.deepEqual(
    result.acceptanceHistory,
    [result.acceptanceDecision]
  );
  assert.notEqual(
    computeAcceptanceReviewRevision(result),
    reviewRevision
  );
});

test("v2 acceptance rejects stale revisions, unsafe actors, and unknown payload fields", () => {
  const reviewing = completedReview();
  const reviewRevision =
    computeAcceptanceReviewRevision(
      requireWorkItem(reviewing)
    );

  assert.throws(
    () =>
      decide(reviewing, {
        expectedReviewRevision:
          `sha256:${"0".repeat(64)}`
      }),
    hasCode("ACCEPTANCE_REVIEW_STALE")
  );
  assert.throws(
    () =>
      decide(reviewing, {
        actor: "Jeffrey@example.com"
      }),
    hasCode("ACCEPTANCE_DECISION_INVALID")
  );
  assert.throws(
    () =>
      applyEvent(reviewing, {
        eventId: `taskseal:acceptance:${DECISION_ID}`,
        workItemId: WORK_ITEM_ID,
        type: "acceptance.decided",
        occurredAt: "2026-07-28T00:05:00.000Z",
        payload: {
          decision: "accepted",
          actor: "operator.jeffrey",
          reason: "Reviewed.",
          decisionId: DECISION_ID,
          expectedReviewRevision: reviewRevision,
          ignored: true
        }
      }),
    hasCode("ACCEPTANCE_DECISION_INVALID")
  );
  assert.throws(
    () =>
      applyEvent(reviewing, {
        eventId: `taskseal:acceptance:${DECISION_ID}`,
        workItemId: WORK_ITEM_ID,
        type: "acceptance.decided",
        occurredAt: "2026-07-28T00:02:30.000Z",
        payload: {
          decision: "accepted",
          actor: "operator.jeffrey",
          reason: "Reviewed.",
          decisionId: DECISION_ID,
          expectedReviewRevision: reviewRevision
        }
      }),
    hasCode("ACCEPTANCE_DECISION_TIME_INVALID")
  );
});

test("a rejected terminal attempt remains in history after an explicit retry", () => {
  const blocked = failedReview();
  const revision =
    computeAcceptanceReviewRevision(
      requireWorkItem(blocked)
    );
  const rejected = applyEvent(blocked, {
    eventId: `taskseal:acceptance:${DECISION_ID}`,
    workItemId: WORK_ITEM_ID,
    type: "acceptance.decided",
    occurredAt: "2026-07-28T00:03:00.000Z",
    payload: {
      decision: "rejected",
      actor: "operator.jeffrey",
      reason: "The attempt failed and must be retried.",
      decisionId: DECISION_ID,
      expectedReviewRevision: revision
    }
  });
  const retried = applyEvent(rejected, {
    eventId: "taskseal:attempt-2:started",
    workItemId: WORK_ITEM_ID,
    type: "attempt.started",
    occurredAt: "2026-07-28T00:04:00.000Z",
    payload: {
      attemptId: "attempt-2",
      agentId: "codex"
    }
  });

  const result = requireWorkItem(retried);
  assert.equal(result.status, "running");
  assert.equal(result.acceptanceDecision, null);
  assert.equal(result.acceptanceHistory.length, 1);
  assert.equal(
    result.acceptanceHistory[0]?.reason,
    "The attempt failed and must be retried."
  );
  assert.equal(
    result.acceptanceHistory[0]?.basis?.attemptId,
    "attempt-1"
  );
});

test("a review basis accepts one decision and an accepted work item cannot be implicitly rerun", () => {
  const reviewing = completedReview();
  const accepted = decide(reviewing);

  assert.throws(
    () =>
      decide(accepted, {
        decisionId:
          "22222222-2222-4222-8222-222222222222",
        decision: "rejected",
        expectedReviewRevision:
          computeAcceptanceReviewRevision(
            requireWorkItem(accepted)
          )
      }),
    hasCode("ACCEPTANCE_ALREADY_DECIDED")
  );
  assert.throws(
    () =>
      applyEvent(accepted, {
        eventId: "taskseal:attempt-2:started",
        workItemId: WORK_ITEM_ID,
        type: "attempt.started",
        occurredAt: "2026-07-28T00:06:00.000Z",
        payload: {
          attemptId: "attempt-2",
          agentId: "codex"
        }
      }),
    hasCode("ACCEPTED_WORK_ITEM_IMMUTABLE")
  );
});

function decide(
  workflow: Workflow,
  overrides: Partial<{
    decisionId: string;
    decision: "accepted" | "rejected";
    actor: string;
    reason: string;
    expectedReviewRevision: string;
  }> = {}
): Workflow {
  return applyEvent(workflow, {
    eventId:
      `taskseal:acceptance:${overrides.decisionId ?? DECISION_ID}`,
    workItemId: WORK_ITEM_ID,
    type: "acceptance.decided",
    occurredAt: "2026-07-28T00:05:00.000Z",
    payload: {
      decision: overrides.decision ?? "accepted",
      actor: overrides.actor ?? "operator.jeffrey",
      reason:
        overrides.reason ??
        "The current revision passed every required check.",
      decisionId:
        overrides.decisionId ?? DECISION_ID,
      expectedReviewRevision:
        overrides.expectedReviewRevision ??
        computeAcceptanceReviewRevision(
          requireWorkItem(workflow)
        )
    }
  });
}

function completedReview(): Workflow {
  let workflow = baseWorkflow();
  workflow = applyEvent(workflow, {
    eventId: "taskseal:attempt-1:finished",
    workItemId: WORK_ITEM_ID,
    type: "attempt.finished",
    occurredAt: "2026-07-28T00:02:00.000Z",
    payload: {
      attemptId: "attempt-1",
      outcome: "completed"
    }
  });
  workflow = applyEvent(workflow, {
    eventId: "taskseal:artifact-1:linked",
    workItemId: WORK_ITEM_ID,
    type: "artifact.linked",
    occurredAt: "2026-07-28T00:03:00.000Z",
    payload: {
      artifactId: "artifact-1",
      attemptId: "attempt-1",
      kind: "pull_request",
      revision: "head-1",
      url: "https://github.com/netpilot-z/TaskSeal/pull/1"
    }
  });
  return applyEvent(workflow, {
    eventId: "taskseal:evidence-1:recorded",
    workItemId: WORK_ITEM_ID,
    type: "evidence.recorded",
    occurredAt: "2026-07-28T00:04:00.000Z",
    payload: {
      evidenceId: "evidence-1",
      attemptId: "attempt-1",
      artifactId: "artifact-1",
      revision: "head-1",
      criterionKey: "tests",
      outcome: "passed",
      url: "https://github.com/netpilot-z/TaskSeal/actions/runs/1"
    }
  });
}

function failedReview(): Workflow {
  return applyEvent(baseWorkflow(), {
    eventId: "taskseal:attempt-1:finished",
    workItemId: WORK_ITEM_ID,
    type: "attempt.finished",
    occurredAt: "2026-07-28T00:02:00.000Z",
    payload: {
      attemptId: "attempt-1",
      outcome: "failed"
    }
  });
}

function baseWorkflow(): Workflow {
  let workflow = createWorkflow();
  workflow = applyEvent(workflow, {
    eventId: "taskseal:work-item:created",
    workItemId: WORK_ITEM_ID,
    type: "work_item.created",
    occurredAt: "2026-07-28T00:00:00.000Z",
    payload: {
      title: "Review an exact delivery revision",
      requiredEvidence: ["tests"],
      externalLink: {
        provider: "taskseal",
        externalId: WORK_ITEM_ID,
        url: "http://127.0.0.1:4317/work-items/TS-ACCEPT"
      }
    }
  });
  return applyEvent(workflow, {
    eventId: "taskseal:attempt-1:started",
    workItemId: WORK_ITEM_ID,
    type: "attempt.started",
    occurredAt: "2026-07-28T00:01:00.000Z",
    payload: {
      attemptId: "attempt-1",
      agentId: "codex"
    }
  });
}

function requireWorkItem(workflow: Workflow): WorkItem {
  const workItem = workflow.workItems[WORK_ITEM_ID];
  assert.ok(workItem);
  return workItem;
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error: unknown) =>
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code;
}
