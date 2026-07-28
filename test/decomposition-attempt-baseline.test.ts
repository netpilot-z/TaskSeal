import assert from "node:assert/strict";
import test from "node:test";

import {
  captureDecompositionAttemptBaseline,
  resolveDecompositionAttemptWindow
} from "../src/application/decomposition-attempt-baseline.ts";
import type {
  WorkItem
} from "../src/domain/workflow.ts";

test("an approval baseline exposes only later attempts and detects prefix drift", () => {
  const workItem =
    createWorkItem([
      {
        id: "attempt-old",
        agentId: "runner-old",
        status: "interrupted",
        startedAt:
          "2026-07-28T12:00:00.000Z",
        completedAt:
          "2026-07-28T12:01:00.000Z",
        runtimeOutcome:
          "interrupted"
      }
    ]);
  const baseline =
    captureDecompositionAttemptBaseline(
      workItem
    );

  assert.deepEqual(
    resolveDecompositionAttemptWindow(
      baseline,
      workItem
    ),
    {
      matched: true,
      attempts: []
    }
  );

  const nextAttempt = {
    id: "attempt-current",
    agentId: "codex-app-server",
    status: "completed" as const,
    startedAt:
      "2026-07-28T13:00:00.000Z",
    completedAt:
      "2026-07-28T13:01:00.000Z",
    runtimeOutcome:
      "completed" as const
  };
  const advanced = {
    ...workItem,
    activeAttemptId:
      nextAttempt.id,
    attempts: [
      ...workItem.attempts,
      nextAttempt
    ]
  };
  assert.deepEqual(
    resolveDecompositionAttemptWindow(
      baseline,
      advanced
    ),
    {
      matched: true,
      attempts: [nextAttempt]
    }
  );

  const drifted = {
    ...advanced,
    attempts: [
      {
        ...workItem.attempts[0]!,
        id: "attempt-rewritten"
      },
      nextAttempt
    ]
  };
  assert.deepEqual(
    resolveDecompositionAttemptWindow(
      baseline,
      drifted
    ),
    {
      matched: false,
      attempts: []
    }
  );
});

function createWorkItem(
  attempts: WorkItem["attempts"]
): WorkItem {
  return {
    id: "API",
    title: "API",
    status: "blocked",
    requiredEvidence: ["tests"],
    activeAttemptId:
      attempts.at(-1)?.id ?? null,
    activeArtifact: null,
    attempts,
    artifacts: [],
    evidence: [],
    acceptanceDecision: null,
    acceptanceHistory: [],
    externalLinks: []
  };
}
