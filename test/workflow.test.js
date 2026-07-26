import assert from "node:assert/strict";
import test from "node:test";

import { applyEvent, createWorkflow } from "../src/domain/workflow.js";

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

  assert.equal(next.workItems["TS-1"].status, "planned");
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

  assert.equal(running.workItems["TS-1"].status, "running");
  assert.equal(replayed.workItems["TS-1"].attempts.length, 1);
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
    (error) => error.code === "ACCEPTANCE_EVIDENCE_INCOMPLETE"
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

  assert.equal(accepted.workItems["TS-1"].status, "accepted");
  assert.equal(accepted.workItems["TS-1"].artifacts.length, 1);
  assert.equal(accepted.workItems["TS-1"].evidence.length, 1);
  assert.equal(accepted.workItems["TS-1"].acceptanceDecision.actor, "owner");
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
    (error) => error.code === "EVENT_ENVELOPE_INVALID"
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
    (error) => error.code === "EVENT_ID_CONFLICT"
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
    (error) => error.code === "WORK_ITEM_ALREADY_EXISTS"
  );
  assert.equal(running.workItems["TS-1"].status, "running");
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
    withStaleRevision.workItems["TS-1"].activeArtifact.revision,
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
    second.workItems["TS-1"].attempts.map((attempt) => attempt.status),
    ["superseded", "running"]
  );
  assert.equal(second.workItems["TS-1"].activeAttemptId, "run-2");
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

  assert.equal(completed.workItems["TS-1"].status, "reviewing");
  assert.equal(completed.workItems["TS-1"].attempts[0].status, "completed");
  assert.equal(completed.workItems["TS-1"].attempts[0].threadId, "thread-1");
  assert.equal(completed.workItems["TS-1"].attempts[0].turnId, "turn-1");
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
    (error) => error.code === "ACCEPTANCE_EVIDENCE_INCOMPLETE"
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
    (error) => error.code === "ATTEMPT_TERMINAL_CONFLICT"
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

    assert.equal(finished.workItems[`TS-${outcome}`].status, "blocked");
    assert.equal(
      finished.workItems[`TS-${outcome}`].attempts[0].status,
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

  assert.equal(withArtifact.workItems["TS-1"].status, "running");
  assert.equal(
    withArtifact.workItems["TS-1"].attempts[0].status,
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

  assert.equal(failed.workItems["TS-1"].status, "blocked");
  assert.equal(failed.workItems["TS-1"].attempts[0].status, "failed");
  assert.equal(
    failed.workItems["TS-1"].attempts[0].runtimeOutcome,
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

  assert.equal(withLateArtifact.workItems["TS-1"].status, "blocked");
  assert.equal(withLateArtifact.workItems["TS-1"].artifacts.length, 1);
  assert.equal(withEvidence.workItems["TS-1"].status, "blocked");

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
    (error) => error.code === "ACCEPTANCE_ATTEMPT_INCOMPLETE"
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

  assert.equal(withLateArtifact.workItems["TS-1"].status, "blocked");
  assert.deepEqual(
    withLateArtifact.workItems["TS-1"].acceptanceDecision,
    rejected.workItems["TS-1"].acceptanceDecision
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

  assert.equal(withLateEvidence.workItems["TS-1"].status, "blocked");
  assert.deepEqual(
    withLateEvidence.workItems["TS-1"].acceptanceDecision,
    rejected.workItems["TS-1"].acceptanceDecision
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
    (error) => error.code === "ACCEPTANCE_DECISION_INVALID"
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

  assert.equal(reviewing.workItems["TS-1"].status, "blocked");
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
    (error) => error.code === "ACCEPTANCE_EVIDENCE_INCOMPLETE"
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
    (error) => error.code === "EVENT_PAYLOAD_INVALID"
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
    (error) => error.code === "EVIDENCE_ORDER_AMBIGUOUS"
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
    (error) => error.code === "EVIDENCE_ORDER_AMBIGUOUS"
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

  assert.equal(withHistoricalArtifact.workItems["TS-1"].status, "accepted");
  assert.equal(
    withHistoricalArtifact.workItems["TS-1"].acceptanceDecision.decision,
    "accepted"
  );
  assert.equal(withHistoricalEvidence.workItems["TS-1"].status, "accepted");
  assert.equal(
    withHistoricalEvidence.workItems["TS-1"].acceptanceDecision.decision,
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

  assert.equal(withLateFailure.workItems["TS-1"].status, "accepted");
  assert.equal(
    withLateFailure.workItems["TS-1"].acceptanceDecision.decision,
    "accepted"
  );
  assert.equal(withLateFailure.workItems["TS-1"].evidence.length, 2);
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

  assert.equal(refreshed.workItems["TS-1"].status, "accepted");
  assert.equal(
    refreshed.workItems["TS-1"].acceptanceDecision.decision,
    "accepted"
  );
  assert.equal(
    refreshed.workItems["TS-1"].activeArtifact.linkedAt,
    "2026-07-26T08:03:00.000Z"
  );
  assert.equal(refreshed.workItems["TS-1"].artifacts.length, 1);
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
  const attempts = Object.fromEntries(
    withOlder.workItems["TS-1"].attempts.map((attempt) => [
      attempt.id,
      attempt
    ])
  );

  assert.equal(withOlder.workItems["TS-1"].activeAttemptId, "run-2");
  assert.equal(attempts["run-2"].status, "running");
  assert.equal(attempts["run-1"].status, "superseded");
  assert.equal(attempts["run-1"].completedAt, "2026-07-26T08:02:00.000Z");
});

function createAcceptedWorkflow() {
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
} = {}) {
  const events = [
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

  return events.reduce(applyEvent, createWorkflow());
}
