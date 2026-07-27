import assert from "node:assert/strict";
import test from "node:test";

import { applyEvent, createWorkflow } from "../src/domain/workflow.ts";
import type {
  AcceptanceDecision,
  ActiveArtifact,
  Attempt,
  Workflow,
  WorkItem
} from "../src/domain/workflow.ts";

test("a new work item starts in planned state", () => {
  const initial = createWorkflow();
  const next = applyEvent(initial, {
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
  });

  assert.equal(getWorkItem(next, "TS-1").status, "planned");
});

test("an agent attempt moves work to running and duplicate events are idempotent", () => {
  const created = applyEvent(createWorkflow(), {
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
  });
  const startedEvent = {
    eventId: "codex:run-1:started",
    workItemId: "TS-1",
    type: "attempt.started",
    occurredAt: "2026-07-26T08:01:00.000Z",
    payload: {
      attemptId: "run-1",
      agentId: "codex-product-engineer"
    }
  };

  const running = applyEvent(created, startedEvent);
  const replayed = applyEvent(running, startedEvent);

  assert.equal(getWorkItem(running, "TS-1").status, "running");
  assert.equal(getWorkItem(replayed, "TS-1").attempts.length, 1);
  assert.strictEqual(replayed, running);
});

test("acceptance is rejected when artifact or required evidence is missing", () => {
  const created = applyEvent(createWorkflow(), {
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
  });

  assert.throws(
    () =>
      applyEvent(created, {
        eventId: "taskseal:TS-1:accepted",
        workItemId: "TS-1",
        type: "acceptance.decided",
        occurredAt: "2026-07-26T08:05:00.000Z",
        payload: {
          decision: "accepted",
          actor: "owner",
          reason: "Looks good"
        }
      }),
    (error) =>
      hasErrorCode(error, "ACCEPTANCE_EVIDENCE_INCOMPLETE")
  );
});

test("a matching artifact and required evidence allow human acceptance", () => {
  const events = [
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
      eventId: "codex:run-1:completed",
      workItemId: "TS-1",
      type: "attempt.finished",
      occurredAt: "2026-07-26T08:02:00.000Z",
      payload: {
        attemptId: "run-1",
        outcome: "completed"
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
      eventId: "taskseal:TS-1:accepted",
      workItemId: "TS-1",
      type: "acceptance.decided",
      occurredAt: "2026-07-26T08:05:00.000Z",
      payload: {
        decision: "accepted",
        actor: "owner",
        reason: "Evidence verified"
      }
    }
  ];

  const accepted = events.reduce(applyEvent, createWorkflow());

  const acceptedWorkItem = getWorkItem(accepted, "TS-1");
  assert.equal(acceptedWorkItem.status, "accepted");
  assert.equal(acceptedWorkItem.artifacts.length, 1);
  assert.equal(acceptedWorkItem.evidence.length, 1);
  assert.equal(
    getAcceptanceDecision(acceptedWorkItem).actor,
    "owner"
  );
});

test("event ids are required and conflicting payloads are rejected", () => {
  const createdEvent = {
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
  };
  const created = applyEvent(createWorkflow(), createdEvent);

  assert.throws(
    () => applyEvent(createWorkflow(), { ...createdEvent, eventId: "" }),
    (error) => hasErrorCode(error, "EVENT_ENVELOPE_INVALID")
  );
  assert.throws(
    () =>
      applyEvent(created, {
        ...createdEvent,
        payload: {
          ...createdEvent.payload,
          title: "Conflicting title"
        }
      }),
    (error) => hasErrorCode(error, "EVENT_ID_CONFLICT")
  );
});

test("a later create revision cannot overwrite an existing work item", () => {
  const createdEvent = {
    eventId: "linear:issue-1:2026-07-26T08:00:00.000Z",
    workItemId: "TS-1",
    type: "work_item.created",
    occurredAt: "2026-07-26T08:00:00.000Z",
    payload: {
      title: "Original title",
      requiredEvidence: ["tests"],
      externalLink: {
        provider: "linear",
        externalId: "issue-1",
        url: "https://linear.app/example/issue/TS-1"
      }
    }
  };
  const created = applyEvent(createWorkflow(), createdEvent);
  const running = applyEvent(created, {
    eventId: "codex:run-1:started",
    workItemId: "TS-1",
    type: "attempt.started",
    occurredAt: "2026-07-26T08:01:00.000Z",
    payload: {
      attemptId: "run-1",
      agentId: "codex-product-engineer"
    }
  });

  assert.throws(
    () =>
      applyEvent(running, {
        ...createdEvent,
        eventId: "linear:issue-1:2026-07-26T08:02:00.000Z",
        occurredAt: "2026-07-26T08:02:00.000Z",
        payload: {
          ...createdEvent.payload,
          title: "Updated title"
        }
      }),
    (error) => hasErrorCode(error, "WORK_ITEM_ALREADY_EXISTS")
  );
  assert.equal(getWorkItem(running, "TS-1").status, "running");
});

test("a stale artifact revision cannot replace the current revision", () => {
  const running = [
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
    }
  ].reduce(applyEvent, createWorkflow());
  const withCurrentRevision = applyEvent(running, {
    eventId: "github:pr-1:new-sha",
    workItemId: "TS-1",
    type: "artifact.linked",
    occurredAt: "2026-07-26T08:03:00.000Z",
    payload: {
      artifactId: "pr-1",
      attemptId: "run-1",
      kind: "pull_request",
      revision: "new-sha",
      url: "https://github.com/example/repo/pull/1"
    }
  });
  const withStaleRevision = applyEvent(withCurrentRevision, {
    eventId: "github:pr-1:old-sha",
    workItemId: "TS-1",
    type: "artifact.linked",
    occurredAt: "2026-07-26T08:02:00.000Z",
    payload: {
      artifactId: "pr-1",
      attemptId: "run-1",
      kind: "pull_request",
      revision: "old-sha",
      url: "https://github.com/example/repo/pull/1"
    }
  });

  assert.equal(
    getActiveArtifact(
      getWorkItem(withStaleRevision, "TS-1")
    ).revision,
    "new-sha"
  );
});

test("starting a new attempt supersedes the previous running attempt", () => {
  const created = applyEvent(createWorkflow(), {
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
  });
  const first = applyEvent(created, {
    eventId: "codex:run-1:started",
    workItemId: "TS-1",
    type: "attempt.started",
    occurredAt: "2026-07-26T08:01:00.000Z",
    payload: {
      attemptId: "run-1",
      agentId: "codex-product-engineer"
    }
  });
  const second = applyEvent(first, {
    eventId: "codex:run-2:started",
    workItemId: "TS-1",
    type: "attempt.started",
    occurredAt: "2026-07-26T08:06:00.000Z",
    payload: {
      attemptId: "run-2",
      agentId: "codex-product-engineer"
    }
  });

  assert.deepEqual(
    getWorkItem(second, "TS-1").attempts.map(
      (attempt) => attempt.status
    ),
    ["superseded", "running"]
  );
  assert.equal(getWorkItem(second, "TS-1").activeAttemptId, "run-2");
});

test("a completed attempt moves to review but cannot bypass evidence acceptance", () => {
  const running = [
    {
      eventId: "linear:TS-1:created",
      workItemId: "TS-1",
      type: "work_item.created",
      occurredAt: "2026-07-26T08:00:00.000Z",
      payload: {
        title: "Run a real Codex turn",
        requiredEvidence: ["tests"],
        externalLink: {
          provider: "taskseal",
          externalId: "TS-1",
          url: "http://127.0.0.1/work-items/TS-1"
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
        agentId: "codex"
      }
    }
  ].reduce(applyEvent, createWorkflow());
  const completed = applyEvent(running, {
    eventId: "codex:run-1:finished",
    workItemId: "TS-1",
    type: "attempt.finished",
    occurredAt: "2026-07-26T08:02:00.000Z",
    payload: {
      attemptId: "run-1",
      outcome: "completed",
      threadId: "thread-1",
      turnId: "turn-1",
      summary: "Turn completed without delivery evidence."
    }
  });

  const completedWorkItem = getWorkItem(completed, "TS-1");
  const completedAttempt = getAttempt(completedWorkItem, 0);
  assert.equal(completedWorkItem.status, "reviewing");
  assert.equal(completedAttempt.status, "completed");
  assert.equal(completedAttempt.threadId, "thread-1");
  assert.equal(completedAttempt.turnId, "turn-1");
  assert.throws(
    () =>
      applyEvent(completed, {
        eventId: "taskseal:TS-1:accepted-without-evidence",
        workItemId: "TS-1",
        type: "acceptance.decided",
        occurredAt: "2026-07-26T08:03:00.000Z",
        payload: {
          decision: "accepted",
          actor: "owner",
          reason: "Agent said it completed"
        }
      }),
    (error) =>
      hasErrorCode(error, "ACCEPTANCE_EVIDENCE_INCOMPLETE")
  );
});

test("an attempt terminal outcome cannot be rewritten by a later event", () => {
  const running = [
    {
      eventId: "local:TS-1:created",
      workItemId: "TS-1",
      type: "work_item.created",
      occurredAt: "2026-07-26T08:00:00.000Z",
      payload: {
        title: "Keep terminal history immutable",
        requiredEvidence: ["tests"],
        externalLink: {
          provider: "taskseal",
          externalId: "TS-1",
          url: "http://127.0.0.1/work-items/TS-1"
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
        agentId: "codex"
      }
    }
  ].reduce(applyEvent, createWorkflow());
  const completed = applyEvent(running, {
    eventId: "codex:run-1:completed",
    workItemId: "TS-1",
    type: "attempt.finished",
    occurredAt: "2026-07-26T08:02:00.000Z",
    payload: {
      attemptId: "run-1",
      outcome: "completed",
      summary: "First terminal fact"
    }
  });

  assert.throws(
    () =>
      applyEvent(completed, {
        eventId: "codex:run-1:failed-late",
        workItemId: "TS-1",
        type: "attempt.finished",
        occurredAt: "2026-07-26T08:03:00.000Z",
        payload: {
          attemptId: "run-1",
          outcome: "failed",
          summary: "Conflicting terminal fact"
        }
      }),
    (error) => hasErrorCode(error, "ATTEMPT_TERMINAL_CONFLICT")
  );
});

test("failed and interrupted attempts block the work item", () => {
  for (const outcome of ["failed", "interrupted"]) {
    const running = [
      {
        eventId: `local:TS-${outcome}:created`,
        workItemId: `TS-${outcome}`,
        type: "work_item.created",
        occurredAt: "2026-07-26T08:00:00.000Z",
        payload: {
          title: `Handle a ${outcome} Codex turn`,
          requiredEvidence: ["tests"],
          externalLink: {
            provider: "taskseal",
            externalId: `TS-${outcome}`,
            url: `http://127.0.0.1/work-items/TS-${outcome}`
          }
        }
      },
      {
        eventId: `codex:run-${outcome}:started`,
        workItemId: `TS-${outcome}`,
        type: "attempt.started",
        occurredAt: "2026-07-26T08:01:00.000Z",
        payload: {
          attemptId: `run-${outcome}`,
          agentId: "codex"
        }
      }
    ].reduce(applyEvent, createWorkflow());
    const finished = applyEvent(running, {
      eventId: `codex:run-${outcome}:finished`,
      workItemId: `TS-${outcome}`,
      type: "attempt.finished",
      occurredAt: "2026-07-26T08:02:00.000Z",
      payload: {
        attemptId: `run-${outcome}`,
        outcome,
        summary: `Codex turn ${outcome}.`
      }
    });

    const finishedWorkItem = getWorkItem(
      finished,
      `TS-${outcome}`
    );
    assert.equal(finishedWorkItem.status, "blocked");
    assert.equal(
      getAttempt(finishedWorkItem, 0).status,
      outcome
    );
  }
});

test("an artifact does not complete an attempt before its failed terminal event", () => {
  const withArtifact = [
    {
      eventId: "local:TS-1:created",
      workItemId: "TS-1",
      type: "work_item.created",
      occurredAt: "2026-07-26T08:00:00.000Z",
      payload: {
        title: "Keep artifact and runtime facts independent",
        requiredEvidence: ["tests"],
        externalLink: {
          provider: "taskseal",
          externalId: "TS-1",
          url: "http://127.0.0.1/work-items/TS-1"
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
        agentId: "codex"
      }
    },
    {
      eventId: "github:pr-1:abc123",
      workItemId: "TS-1",
      type: "artifact.linked",
      occurredAt: "2026-07-26T08:02:00.000Z",
      payload: {
        artifactId: "pr-1",
        attemptId: "run-1",
        kind: "pull_request",
        revision: "abc123",
        url: "https://github.com/example/repo/pull/1"
      }
    }
  ].reduce(applyEvent, createWorkflow());

  const withArtifactWorkItem = getWorkItem(withArtifact, "TS-1");
  assert.equal(withArtifactWorkItem.status, "running");
  assert.equal(
    getAttempt(withArtifactWorkItem, 0).status,
    "running"
  );

  const failed = applyEvent(withArtifact, {
    eventId: "codex:run-1:failed",
    workItemId: "TS-1",
    type: "attempt.finished",
    occurredAt: "2026-07-26T08:03:00.000Z",
    payload: {
      attemptId: "run-1",
      outcome: "failed",
      summary: "Codex failed after linking a partial artifact."
    }
  });

  const failedWorkItem = getWorkItem(failed, "TS-1");
  const failedAttempt = getAttempt(failedWorkItem, 0);
  assert.equal(failedWorkItem.status, "blocked");
  assert.equal(failedAttempt.status, "failed");
  assert.equal(
    failedAttempt.runtimeOutcome,
    "failed"
  );
});

test("a late artifact cannot reopen a failed attempt for acceptance", () => {
  const failed = [
    {
      eventId: "local:TS-1:created",
      workItemId: "TS-1",
      type: "work_item.created",
      occurredAt: "2026-07-26T08:00:00.000Z",
      payload: {
        title: "Keep a failed terminal state authoritative",
        requiredEvidence: ["tests"],
        externalLink: {
          provider: "taskseal",
          externalId: "TS-1",
          url: "http://127.0.0.1/work-items/TS-1"
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
        agentId: "codex"
      }
    },
    {
      eventId: "codex:run-1:failed",
      workItemId: "TS-1",
      type: "attempt.finished",
      occurredAt: "2026-07-26T08:03:00.000Z",
      payload: {
        attemptId: "run-1",
        outcome: "failed",
        summary: "The attempt failed after producing partial work."
      }
    }
  ].reduce(applyEvent, createWorkflow());
  const withLateArtifact = applyEvent(failed, {
    eventId: "github:pr-1:abc123",
    workItemId: "TS-1",
    type: "artifact.linked",
    occurredAt: "2026-07-26T08:02:00.000Z",
    payload: {
      artifactId: "pr-1",
      attemptId: "run-1",
      kind: "pull_request",
      revision: "abc123",
      url: "https://github.com/example/repo/pull/1"
    }
  });
  const withEvidence = applyEvent(withLateArtifact, {
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
  });

  assert.equal(
    getWorkItem(withLateArtifact, "TS-1").status,
    "blocked"
  );
  assert.equal(
    getWorkItem(withLateArtifact, "TS-1").artifacts.length,
    1
  );
  assert.equal(getWorkItem(withEvidence, "TS-1").status, "blocked");

  assert.throws(
    () =>
      applyEvent(withEvidence, {
        eventId: "taskseal:TS-1:accepted",
        workItemId: "TS-1",
        type: "acceptance.decided",
        occurredAt: "2026-07-26T08:05:00.000Z",
        payload: {
          decision: "accepted",
          actor: "owner",
          reason: "The late evidence passed"
        }
      }),
    (error) =>
      hasErrorCode(error, "ACCEPTANCE_ATTEMPT_INCOMPLETE")
  );
});

test("a late artifact preserves a newer rejected decision", () => {
  const rejected = createFailedRejectedWorkflow();
  const withLateArtifact = applyEvent(rejected, {
    eventId: "github:pr-1:abc123",
    workItemId: "TS-1",
    type: "artifact.linked",
    occurredAt: "2026-07-26T08:02:00.000Z",
    payload: {
      artifactId: "pr-1",
      attemptId: "run-1",
      kind: "pull_request",
      revision: "abc123",
      url: "https://github.com/example/repo/pull/1"
    }
  });

  assert.equal(
    getWorkItem(withLateArtifact, "TS-1").status,
    "blocked"
  );
  assert.deepEqual(
    getWorkItem(withLateArtifact, "TS-1").acceptanceDecision,
    getWorkItem(rejected, "TS-1").acceptanceDecision
  );
});

test("late evidence preserves a newer rejected decision", () => {
  const rejected = createFailedRejectedWorkflow({
    includeArtifact: true
  });
  const withLateEvidence = applyEvent(rejected, {
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
  });

  assert.equal(
    getWorkItem(withLateEvidence, "TS-1").status,
    "blocked"
  );
  assert.deepEqual(
    getWorkItem(withLateEvidence, "TS-1").acceptanceDecision,
    getWorkItem(rejected, "TS-1").acceptanceDecision
  );
});

test("acceptance decisions require a valid decision and accountable actor", () => {
  const created = applyEvent(createWorkflow(), {
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
  });

  assert.throws(
    () =>
      applyEvent(created, {
        eventId: "taskseal:TS-1:typo",
        workItemId: "TS-1",
        type: "acceptance.decided",
        occurredAt: "2026-07-26T08:05:00.000Z",
        payload: {
          decision: "acceptd",
          actor: "owner",
          reason: "Typo"
        }
      }),
    (error) =>
      hasErrorCode(error, "ACCEPTANCE_DECISION_INVALID")
  );
});

test("late stale evidence cannot override a newer failed result", () => {
  const reviewing = [
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
      eventId: "codex:run-1:completed",
      workItemId: "TS-1",
      type: "attempt.finished",
      occurredAt: "2026-07-26T08:02:00.000Z",
      payload: {
        attemptId: "run-1",
        outcome: "completed"
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
      eventId: "github:check-new:abc123",
      workItemId: "TS-1",
      type: "evidence.recorded",
      occurredAt: "2026-07-26T08:05:00.000Z",
      payload: {
        evidenceId: "check-new",
        attemptId: "run-1",
        artifactId: "pr-1",
        revision: "abc123",
        criterionKey: "tests",
        outcome: "failed",
        url: "https://github.com/example/repo/actions/runs/2"
      }
    },
    {
      eventId: "github:check-old:abc123",
      workItemId: "TS-1",
      type: "evidence.recorded",
      occurredAt: "2026-07-26T08:04:00.000Z",
      payload: {
        evidenceId: "check-old",
        attemptId: "run-1",
        artifactId: "pr-1",
        revision: "abc123",
        criterionKey: "tests",
        outcome: "passed",
        url: "https://github.com/example/repo/actions/runs/1"
      }
    }
  ].reduce(applyEvent, createWorkflow());

  assert.equal(getWorkItem(reviewing, "TS-1").status, "blocked");
  assert.throws(
    () =>
      applyEvent(reviewing, {
        eventId: "taskseal:TS-1:accepted",
        workItemId: "TS-1",
        type: "acceptance.decided",
        occurredAt: "2026-07-26T08:06:00.000Z",
        payload: {
          decision: "accepted",
          actor: "owner",
          reason: "Should not pass"
        }
      }),
    (error) =>
      hasErrorCode(error, "ACCEPTANCE_EVIDENCE_INCOMPLETE")
  );
});

test("artifact and evidence events require explicit revision fields", () => {
  const running = [
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
    }
  ].reduce(applyEvent, createWorkflow());

  assert.throws(
    () =>
      applyEvent(running, {
        eventId: "github:pr-1:missing-revision",
        workItemId: "TS-1",
        type: "artifact.linked",
        occurredAt: "2026-07-26T08:03:00.000Z",
        payload: {
          artifactId: "pr-1",
          attemptId: "run-1",
          kind: "pull_request",
          url: "https://github.com/example/repo/pull/1"
        }
      }),
    (error) => hasErrorCode(error, "EVENT_PAYLOAD_INVALID")
  );
});

test("conflicting evidence at the same provider timestamp is rejected", () => {
  const reviewing = [
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
      eventId: "github:check-failed:abc123",
      workItemId: "TS-1",
      type: "evidence.recorded",
      occurredAt: "2026-07-26T08:04:00.000Z",
      payload: {
        evidenceId: "check-failed",
        attemptId: "run-1",
        artifactId: "pr-1",
        revision: "abc123",
        criterionKey: "tests",
        outcome: "failed",
        url: "https://github.com/example/repo/actions/runs/1"
      }
    }
  ].reduce(applyEvent, createWorkflow());

  assert.throws(
    () =>
      applyEvent(reviewing, {
        eventId: "github:check-passed:abc123",
        workItemId: "TS-1",
        type: "evidence.recorded",
        occurredAt: "2026-07-26T08:04:00.000Z",
        payload: {
          evidenceId: "check-passed",
          attemptId: "run-1",
          artifactId: "pr-1",
          revision: "abc123",
          criterionKey: "tests",
          outcome: "passed",
          url: "https://github.com/example/repo/actions/runs/2"
        }
      }),
    (error) =>
      hasErrorCode(error, "EVIDENCE_ORDER_AMBIGUOUS")
  );
});

test("equivalent timestamps with different offsets still reject conflicting evidence", () => {
  const accepted = createAcceptedWorkflow();

  assert.throws(
    () =>
      applyEvent(accepted, {
        eventId: "github:check-offset:abc123",
        workItemId: "TS-1",
        type: "evidence.recorded",
        occurredAt: "2026-07-26T03:04:00.000-05:00",
        payload: {
          evidenceId: "check-offset",
          attemptId: "run-1",
          artifactId: "pr-1",
          revision: "abc123",
          criterionKey: "tests",
          outcome: "failed",
          url: "https://github.com/example/repo/actions/runs/2"
        }
      }),
    (error) =>
      hasErrorCode(error, "EVIDENCE_ORDER_AMBIGUOUS")
  );
});

test("late historical artifact and evidence do not revoke an accepted decision", () => {
  const accepted = createAcceptedWorkflow();
  const withHistoricalArtifact = applyEvent(accepted, {
    eventId: "github:pr-1:old-sha",
    workItemId: "TS-1",
    type: "artifact.linked",
    occurredAt: "2026-07-26T08:02:00.000Z",
    payload: {
      artifactId: "pr-1",
      attemptId: "run-1",
      kind: "pull_request",
      revision: "old-sha",
      url: "https://github.com/example/repo/pull/1"
    }
  });
  const withHistoricalEvidence = applyEvent(withHistoricalArtifact, {
    eventId: "github:check-old:old-sha",
    workItemId: "TS-1",
    type: "evidence.recorded",
    occurredAt: "2026-07-26T08:02:30.000Z",
    payload: {
      evidenceId: "check-old",
      attemptId: "run-1",
      artifactId: "pr-1",
      revision: "old-sha",
      criterionKey: "tests",
      outcome: "failed",
      url: "https://github.com/example/repo/actions/runs/0"
    }
  });

  const historicalArtifactWorkItem = getWorkItem(
    withHistoricalArtifact,
    "TS-1"
  );
  const historicalEvidenceWorkItem = getWorkItem(
    withHistoricalEvidence,
    "TS-1"
  );
  assert.equal(historicalArtifactWorkItem.status, "accepted");
  assert.equal(
    getAcceptanceDecision(historicalArtifactWorkItem).decision,
    "accepted"
  );
  assert.equal(historicalEvidenceWorkItem.status, "accepted");
  assert.equal(
    getAcceptanceDecision(historicalEvidenceWorkItem).decision,
    "accepted"
  );
});

test("late evidence for the current revision does not revoke a newer accepted result", () => {
  const accepted = createAcceptedWorkflow();
  const withLateFailure = applyEvent(accepted, {
    eventId: "github:check-late:abc123",
    workItemId: "TS-1",
    type: "evidence.recorded",
    occurredAt: "2026-07-26T08:03:30.000Z",
    payload: {
      evidenceId: "check-late",
      attemptId: "run-1",
      artifactId: "pr-1",
      revision: "abc123",
      criterionKey: "tests",
      outcome: "failed",
      url: "https://github.com/example/repo/actions/runs/0"
    }
  });

  const withLateFailureWorkItem = getWorkItem(
    withLateFailure,
    "TS-1"
  );
  assert.equal(withLateFailureWorkItem.status, "accepted");
  assert.equal(
    getAcceptanceDecision(withLateFailureWorkItem).decision,
    "accepted"
  );
  assert.equal(withLateFailureWorkItem.evidence.length, 2);
});

test("a metadata refresh for the accepted artifact revision preserves acceptance", () => {
  const accepted = createAcceptedWorkflow();
  const refreshed = applyEvent(accepted, {
    eventId: "github:pr-1:abc123:refreshed",
    workItemId: "TS-1",
    type: "artifact.linked",
    occurredAt: "2026-07-26T08:10:00.000Z",
    payload: {
      artifactId: "pr-1",
      attemptId: "run-1",
      kind: "pull_request",
      revision: "abc123",
      url: "https://github.com/example/repo/pull/1"
    }
  });

  const refreshedWorkItem = getWorkItem(refreshed, "TS-1");
  assert.equal(refreshedWorkItem.status, "accepted");
  assert.equal(
    getAcceptanceDecision(refreshedWorkItem).decision,
    "accepted"
  );
  assert.equal(
    getActiveArtifact(refreshedWorkItem).linkedAt,
    "2026-07-26T08:03:00.000Z"
  );
  assert.equal(refreshedWorkItem.artifacts.length, 1);
});

test("a late older attempt cannot replace the active attempt", () => {
  const created = applyEvent(createWorkflow(), {
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
  });
  const newer = applyEvent(created, {
    eventId: "codex:run-2:started",
    workItemId: "TS-1",
    type: "attempt.started",
    occurredAt: "2026-07-26T08:02:00.000Z",
    payload: {
      attemptId: "run-2",
      agentId: "codex-product-engineer"
    }
  });
  const withOlder = applyEvent(newer, {
    eventId: "codex:run-1:started",
    workItemId: "TS-1",
    type: "attempt.started",
    occurredAt: "2026-07-26T08:01:00.000Z",
    payload: {
      attemptId: "run-1",
      agentId: "codex-product-engineer"
    }
  });
  const withOlderWorkItem = getWorkItem(withOlder, "TS-1");
  const newerAttempt = getAttemptById(withOlderWorkItem, "run-2");
  const olderAttempt = getAttemptById(withOlderWorkItem, "run-1");

  assert.equal(
    withOlderWorkItem.activeAttemptId,
    "run-2"
  );
  assert.equal(newerAttempt.status, "running");
  assert.equal(olderAttempt.status, "superseded");
  assert.equal(olderAttempt.completedAt, "2026-07-26T08:02:00.000Z");
});

function createAcceptedWorkflow(): Workflow {
  return [
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
      eventId: "codex:run-1:completed",
      workItemId: "TS-1",
      type: "attempt.finished",
      occurredAt: "2026-07-26T08:02:00.000Z",
      payload: {
        attemptId: "run-1",
        outcome: "completed"
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
      eventId: "taskseal:TS-1:accepted",
      workItemId: "TS-1",
      type: "acceptance.decided",
      occurredAt: "2026-07-26T08:05:00.000Z",
      payload: {
        decision: "accepted",
        actor: "owner",
        reason: "Evidence verified"
      }
    }
  ].reduce(applyEvent, createWorkflow());
}

function createFailedRejectedWorkflow({
  includeArtifact = false
}: {
  includeArtifact?: boolean;
} = {}): Workflow {
  const events: unknown[] = [
    {
      eventId: "local:TS-1:created",
      workItemId: "TS-1",
      type: "work_item.created",
      occurredAt: "2026-07-26T08:00:00.000Z",
      payload: {
        title: "Preserve an accountable rejection",
        requiredEvidence: ["tests"],
        externalLink: {
          provider: "taskseal",
          externalId: "TS-1",
          url: "http://127.0.0.1/work-items/TS-1"
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
        agentId: "codex"
      }
    }
  ];

  if (includeArtifact) {
    events.push({
      eventId: "github:pr-1:abc123",
      workItemId: "TS-1",
      type: "artifact.linked",
      occurredAt: "2026-07-26T08:02:00.000Z",
      payload: {
        artifactId: "pr-1",
        attemptId: "run-1",
        kind: "pull_request",
        revision: "abc123",
        url: "https://github.com/example/repo/pull/1"
      }
    });
  }

  events.push(
    {
      eventId: "codex:run-1:failed",
      workItemId: "TS-1",
      type: "attempt.finished",
      occurredAt: "2026-07-26T08:03:00.000Z",
      payload: {
        attemptId: "run-1",
        outcome: "failed",
        summary: "The active attempt failed."
      }
    },
    {
      eventId: "taskseal:TS-1:rejected",
      workItemId: "TS-1",
      type: "acceptance.decided",
      occurredAt: "2026-07-26T08:05:00.000Z",
      payload: {
        decision: "rejected",
        actor: "owner",
        reason: "The failed attempt is not acceptable."
      }
    }
  );

  return events.reduce<Workflow>(
    (workflow, event) => applyEvent(workflow, event),
    createWorkflow()
  );
}

function getWorkItem(
  workflow: Workflow,
  workItemId: string
): WorkItem {
  const workItem = workflow.workItems[workItemId];
  assert.ok(workItem);
  return workItem;
}

function getAttempt(
  workItem: WorkItem,
  index: number
): Attempt {
  const attempt = workItem.attempts[index];
  assert.ok(attempt);
  return attempt;
}

function getAttemptById(
  workItem: WorkItem,
  attemptId: string
): Attempt {
  const attempt = workItem.attempts.find(
    (item) => item.id === attemptId
  );
  assert.ok(attempt);
  return attempt;
}

function getAcceptanceDecision(
  workItem: WorkItem
): AcceptanceDecision {
  assert.ok(workItem.acceptanceDecision);
  return workItem.acceptanceDecision;
}

function getActiveArtifact(
  workItem: WorkItem
): ActiveArtifact {
  assert.ok(workItem.activeArtifact);
  return workItem.activeArtifact;
}

function hasErrorCode(
  error: unknown,
  code: string
): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === code
  );
}
