import assert from "node:assert/strict";
import test from "node:test";

import { projectDashboard } from "../src/dashboard/projection.ts";
import {
  applyEvent,
  computeAcceptanceReviewRevision,
  createWorkflow
} from "../src/domain/workflow.ts";

test("dashboard projection does not present previous attempt evidence as current", () => {
  const workflow = [
    {
      eventId: "linear:TS-1:created",
      workItemId: "TS-1",
      type: "work_item.created",
      occurredAt: "2026-07-26T08:00:00.000Z",
      payload: {
        title: "Prove the delivery evidence loop",
        requiredEvidence: ["tests"],
        externalLink: {
          provider: "linear",
          externalId: "TS-1",
          url: "https://linear.app/example/issue/TS-1"
        }
      }
    },
    {
      eventId: "codex:run-1:started",
      workItemId: "TS-1",
      type: "attempt.started",
      occurredAt: "2026-07-26T08:01:00.000Z",
      payload: {
        attemptId: "run-1",
        agentId: "codex-product-engineer"
      }
    },
    {
      eventId: "github:pr-1:abc123",
      workItemId: "TS-1",
      type: "artifact.linked",
      occurredAt: "2026-07-26T08:03:00.000Z",
      payload: {
        artifactId: "pr-1",
        attemptId: "run-1",
        kind: "pull_request",
        revision: "abc123",
        url: "https://github.com/example/repo/pull/1"
      }
    },
    {
      eventId: "github:check-1:abc123",
      workItemId: "TS-1",
      type: "evidence.recorded",
      occurredAt: "2026-07-26T08:04:00.000Z",
      payload: {
        evidenceId: "check-1",
        attemptId: "run-1",
        artifactId: "pr-1",
        revision: "abc123",
        criterionKey: "tests",
        outcome: "passed",
        url: "https://github.com/example/repo/actions/runs/1"
      }
    },
    {
      eventId: "codex:run-2:started",
      workItemId: "TS-1",
      type: "attempt.started",
      occurredAt: "2026-07-26T08:06:00.000Z",
      payload: {
        attemptId: "run-2",
        agentId: "codex-product-engineer"
      }
    }
  ].reduce(applyEvent, createWorkflow());

  const dashboard = projectDashboard(workflow);
  const workItem = dashboard.workItems[0];

  assert.ok(workItem);
  assert.ok(workItem.activeAttempt);
  assert.equal(dashboard.summary.activeAgents, 1);
  assert.equal(workItem.activeAttempt.id, "run-2");
  assert.equal(workItem.activeArtifact, null);
  assert.deepEqual(workItem.currentEvidence, []);
  assert.equal(
    workItem.acceptanceReviewRevision,
    computeAcceptanceReviewRevision(
      workflow.workItems["TS-1"]!
    )
  );
  assert.deepEqual(
    workItem.acceptanceHistory,
    []
  );
  assert.deepEqual(
    workItem.progress,
    {
      basis:
        "acceptance-and-current-evidence",
      accepted: false,
      passedEvidence: 0,
      failedEvidence: 0,
      missingEvidence: 1,
      totalEvidence: 1,
      uncertainty: "incomplete"
    }
  );
  assert.equal(
    "percent" in workItem.progress,
    false
  );
});
