import assert from "node:assert/strict";
import test from "node:test";

import {
  computeAcceptanceReviewRevision
} from "../src/domain/workflow.ts";
import {
  TaskSealService
} from "../src/application/taskseal-service.ts";
import type {
  CanonicalEvent
} from "../src/domain/workflow.ts";

const WORK_ITEM_ID = "TS-ACCEPT";
const DECISION_ID =
  "11111111-1111-4111-8111-111111111111";

test("service commits one revision-bound acceptance decision and replays an exact request idempotently", async () => {
  const journal = new MemoryJournal(
    completedReviewEvents()
  );
  const service = await TaskSealService.open({
    journal,
    clock: () =>
      new Date("2026-07-28T00:05:00.000Z")
  });
  const workItem =
    service.getWorkItem(WORK_ITEM_ID);
  assert.ok(workItem);
  const expectedReviewRevision =
    computeAcceptanceReviewRevision(workItem);
  const input = {
    workItemId: WORK_ITEM_ID,
    decisionId: DECISION_ID,
    decision: "accepted" as const,
    expectedReviewRevision,
    actor: "operator.jeffrey",
    reason:
      "The current revision passed every required check."
  };

  const committed =
    await service.decideAcceptance(input);
  const recordCount = journal.records.length;
  const retry =
    await service.decideAcceptance(input);

  assert.equal(committed.resolution, "committed");
  assert.equal(retry.resolution, "idempotent");
  assert.deepEqual(retry.decision, committed.decision);
  assert.equal(journal.records.length, recordCount);
  assert.equal(
    service.getWorkItem(WORK_ITEM_ID)
      ?.acceptanceHistory.length,
    1
  );
});

test("service rejects a stale review before appending and serializes concurrent decisions", async () => {
  const journal = new MemoryJournal(
    completedReviewEvents()
  );
  const service = await TaskSealService.open({
    journal,
    clock: () =>
      new Date("2026-07-28T00:05:00.000Z")
  });
  const originalCount = journal.records.length;

  await assert.rejects(
    service.decideAcceptance({
      workItemId: WORK_ITEM_ID,
      decisionId: DECISION_ID,
      decision: "accepted",
      expectedReviewRevision:
        `sha256:${"0".repeat(64)}`,
      actor: "operator.jeffrey",
      reason: "This browser view is stale."
    }),
    hasCode("ACCEPTANCE_REVIEW_STALE")
  );
  assert.equal(journal.records.length, originalCount);

  const workItem =
    service.getWorkItem(WORK_ITEM_ID);
  assert.ok(workItem);
  const expectedReviewRevision =
    computeAcceptanceReviewRevision(workItem);
  const results = await Promise.allSettled([
    service.decideAcceptance({
      workItemId: WORK_ITEM_ID,
      decisionId: DECISION_ID,
      decision: "accepted",
      expectedReviewRevision,
      actor: "operator.jeffrey",
      reason: "Accept this exact delivery."
    }),
    service.decideAcceptance({
      workItemId: WORK_ITEM_ID,
      decisionId:
        "22222222-2222-4222-8222-222222222222",
      decision: "rejected",
      expectedReviewRevision,
      actor: "operator.jeffrey",
      reason: "Reject this exact delivery."
    })
  ]);

  assert.equal(
    results.filter(
      (result) => result.status === "fulfilled"
    ).length,
    1
  );
  assert.equal(
    results.filter(
      (result) => result.status === "rejected"
    ).length,
    1
  );
  assert.equal(
    journal.records.length,
    originalCount + 1
  );
});

test("a decision id cannot be rebound to another payload or work item", async () => {
  const journal = new MemoryJournal(
    completedReviewEvents()
  );
  const service = await TaskSealService.open({
    journal,
    clock: () =>
      new Date("2026-07-28T00:05:00.000Z")
  });
  const workItem =
    service.getWorkItem(WORK_ITEM_ID);
  assert.ok(workItem);
  const expectedReviewRevision =
    computeAcceptanceReviewRevision(workItem);
  await service.decideAcceptance({
    workItemId: WORK_ITEM_ID,
    decisionId: DECISION_ID,
    decision: "accepted",
    expectedReviewRevision,
    actor: "operator.jeffrey",
    reason: "Accept this exact delivery."
  });
  const recordCount = journal.records.length;

  await assert.rejects(
    service.decideAcceptance({
      workItemId: WORK_ITEM_ID,
      decisionId: DECISION_ID,
      decision: "accepted",
      expectedReviewRevision,
      actor: "operator.jeffrey",
      reason: "A different reason must conflict."
    }),
    hasCode("ACCEPTANCE_DECISION_CONFLICT")
  );
  assert.equal(journal.records.length, recordCount);
});

class MemoryJournal {
  readonly records: unknown[];

  constructor(records: readonly unknown[]) {
    this.records = structuredClone([...records]);
  }

  async readAll(): Promise<unknown[]> {
    return structuredClone(this.records);
  }

  async append(
    event: CanonicalEvent
  ): Promise<void> {
    this.records.push(structuredClone(event));
  }
}

function completedReviewEvents(): CanonicalEvent[] {
  return [
    {
      eventId: "taskseal:work-item:created",
      workItemId: WORK_ITEM_ID,
      type: "work_item.created",
      occurredAt:
        "2026-07-28T00:00:00.000Z",
      payload: {
        title:
          "Review an exact delivery revision",
        requiredEvidence: ["tests"],
        externalLink: {
          provider: "taskseal",
          externalId: WORK_ITEM_ID,
          url:
            "http://127.0.0.1:4317/work-items/TS-ACCEPT"
        }
      }
    },
    {
      eventId: "taskseal:attempt-1:started",
      workItemId: WORK_ITEM_ID,
      type: "attempt.started",
      occurredAt:
        "2026-07-28T00:01:00.000Z",
      payload: {
        attemptId: "attempt-1",
        agentId: "codex"
      }
    },
    {
      eventId: "taskseal:attempt-1:finished",
      workItemId: WORK_ITEM_ID,
      type: "attempt.finished",
      occurredAt:
        "2026-07-28T00:02:00.000Z",
      payload: {
        attemptId: "attempt-1",
        outcome: "completed"
      }
    },
    {
      eventId: "taskseal:artifact-1:linked",
      workItemId: WORK_ITEM_ID,
      type: "artifact.linked",
      occurredAt:
        "2026-07-28T00:03:00.000Z",
      payload: {
        artifactId: "artifact-1",
        attemptId: "attempt-1",
        kind: "pull_request",
        revision: "head-1",
        url:
          "https://github.com/netpilot-z/TaskSeal/pull/1"
      }
    },
    {
      eventId: "taskseal:evidence-1:recorded",
      workItemId: WORK_ITEM_ID,
      type: "evidence.recorded",
      occurredAt:
        "2026-07-28T00:04:00.000Z",
      payload: {
        evidenceId: "evidence-1",
        attemptId: "attempt-1",
        artifactId: "artifact-1",
        revision: "head-1",
        criterionKey: "tests",
        outcome: "passed",
        url:
          "https://github.com/netpilot-z/TaskSeal/actions/runs/1"
      }
    }
  ];
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
