import assert from "node:assert/strict";
import test from "node:test";

import {
  projectHomeSnapshot,
  type HomeProjectionInput
} from "../src/dashboard/home-projection.ts";

const now = "2026-08-07T12:00:00.000Z";

function input(
  workItems: HomeProjectionInput["dashboard"]["workItems"],
  overrides: Partial<HomeProjectionInput> = {}
): HomeProjectionInput {
  return {
    dashboard: {
      generatedAt: now,
      summary: {
        total: workItems.length,
        planned: workItems.filter((item) => item.status === "planned").length,
        running: workItems.filter((item) => item.status === "running").length,
        reviewing: workItems.filter((item) => item.status === "reviewing").length,
        blocked: workItems.filter((item) => item.status === "blocked").length,
        accepted: workItems.filter((item) => item.status === "accepted").length,
        activeAgents: workItems.filter((item) => item.activeAttempt?.status === "running").length
      },
      workItems
    },
    now,
    mode: "persistent",
    project: { key: "taskseal", name: "TaskSeal" },
    freshness: "fresh",
    runtime: {
      maxConcurrentRuns: 2,
      activeCount: 0,
      availableSlots: 2,
      runs: [],
      errors: {}
    },
    ...overrides
  };
}

function workItem(
  overrides: Partial<HomeProjectionInput["dashboard"]["workItems"][number]>
) {
  return {
    id: "TS-1",
    title: "Fix the delivery callback",
    status: "planned" as const,
    progress: {
      basis: "acceptance-and-current-evidence" as const,
      accepted: false,
      passedEvidence: 0,
      failedEvidence: 0,
      missingEvidence: 1,
      totalEvidence: 1,
      uncertainty: "incomplete" as const
    },
    requiredEvidence: ["tests"],
    activeAttempt: null,
    activeArtifact: null,
    currentEvidence: [],
    attempts: [],
    artifacts: [],
    evidence: [],
    acceptanceDecision: null,
    acceptanceReviewRevision: "review-1",
    acceptanceHistory: [],
    externalLinks: [],
    ...overrides
  };
}

test("home projection puts a live attempt in runningNow with elapsed time", () => {
  const snapshot = projectHomeSnapshot(
    input(
      [
        workItem({
          status: "running",
          activeAttempt: {
            id: "attempt-1",
            agentId: "codex",
            status: "running",
            startedAt: "2026-08-07T11:58:30.000Z"
          }
        })
      ],
      {
        runtime: {
          maxConcurrentRuns: 2,
          activeCount: 1,
          availableSlots: 1,
          runs: [
            {
              workItemId: "TS-1",
              phase: "running",
              startedAt: "2026-08-07T11:58:30.000Z",
              cancelRequestedAt: null
            }
          ],
          errors: {}
        }
      }
    )
  );

  assert.equal(snapshot.runningNow.length, 1);
  const running = snapshot.runningNow[0];
  assert.ok(running);
  assert.equal(running.name, "Fix the delivery callback");
  assert.equal(running.status.code, "running");
  assert.equal(running.elapsed?.elapsedMs, 90_000);
  assert.equal(running.elapsed?.mode, "live");
  assert.equal(snapshot.needsAttention.length, 0);
});

test("home projection distinguishes missing artifact from ready for acceptance", () => {
  const missingArtifact = projectHomeSnapshot(
    input([
      workItem({
        status: "reviewing",
        attempts: [
          {
            id: "attempt-1",
            agentId: "codex",
            status: "completed",
            startedAt: "2026-08-07T11:40:00.000Z",
            completedAt: "2026-08-07T11:45:00.000Z",
            summary: "done"
          }
        ]
      })
    ])
  );

  const missing = missingArtifact.needsAttention[0];
  assert.ok(missing);
  assert.equal(missing.status.code, "awaiting_artifact");
  assert.equal(missing.attention?.kind, "artifact_missing");
  assert.equal(missing.attention?.actionAvailable, true);

  const readyForAcceptance = projectHomeSnapshot(
    input([
      workItem({
        status: "reviewing",
        activeAttempt: {
          id: "attempt-1",
          agentId: "codex",
          status: "completed",
          startedAt: "2026-08-07T11:40:00.000Z",
          completedAt: "2026-08-07T11:45:00.000Z",
          summary: "done"
        },
        attempts: [
          {
            id: "attempt-1",
            agentId: "codex",
            status: "completed",
            startedAt: "2026-08-07T11:40:00.000Z",
            completedAt: "2026-08-07T11:45:00.000Z",
            summary: "done"
          }
        ],
        activeArtifact: {
          id: "artifact-1",
          attemptId: "attempt-1",
          kind: "pull_request",
          revision: "abc123",
          url: "https://github.com/example/repo/pull/1",
          linkedAt: "2026-08-07T11:46:00.000Z"
        },
        artifacts: [
          {
            id: "artifact-1",
            attemptId: "attempt-1",
            kind: "pull_request",
            revision: "abc123",
            url: "https://github.com/example/repo/pull/1",
            linkedAt: "2026-08-07T11:46:00.000Z"
          }
        ],
        currentEvidence: [
          {
            id: "evidence-1",
            attemptId: "attempt-1",
            artifactId: "artifact-1",
            revision: "abc123",
            criterionKey: "tests",
            outcome: "passed",
            url: "https://github.com/example/repo/actions/runs/1",
            recordedAt: "2026-08-07T11:50:00.000Z"
          }
        ],
        progress: {
          basis: "acceptance-and-current-evidence",
          accepted: false,
          passedEvidence: 1,
          failedEvidence: 0,
          missingEvidence: 0,
          totalEvidence: 1,
          uncertainty: "incomplete"
        }
      })
    ])
  );

  const ready = readyForAcceptance.needsAttention[0];
  assert.ok(ready);
  assert.equal(ready.status.code, "awaiting_acceptance");
  assert.equal(ready.attention?.kind, "ready_for_acceptance");
  assert.equal(ready.attention?.actionAvailable, true);
});

test("stale home snapshots freeze elapsed time and never claim a live run", () => {
  const snapshot = projectHomeSnapshot(
    input(
      [
        workItem({
          status: "running",
          activeAttempt: {
            id: "attempt-1",
            agentId: "codex",
            status: "running",
            startedAt: "2026-08-07T11:58:30.000Z"
          }
        })
      ],
      {
        freshness: "stale",
        runtime: undefined
      }
    )
  );

  const frozen = snapshot.runningNow[0];
  assert.ok(frozen);
  assert.equal(frozen.elapsed?.mode, "frozen");
  assert.equal(frozen.status.basis, "last_known");
  assert.equal(snapshot.freshness, "stale");
});
