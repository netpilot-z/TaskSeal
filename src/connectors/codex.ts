import type {
  AttemptFinishedEvent,
  AttemptStartedEvent
} from "../domain/workflow.ts";

export function normalizeCodexRun(
  run: unknown
): AttemptStartedEvent | AttemptFinishedEvent {
  if (!isRecord(run)) {
    throw new TypeError("Codex run must be an object.");
  }

  const id = requireString(run.id, "id");
  const workItemId = requireString(run.workItemId, "workItemId");
  const status = requireString(run.status, "status");

  if (status === "started") {
    const agentId = requireString(run.agentId, "agentId");
    const startedAt = requireString(run.startedAt, "startedAt");

    return {
      eventId: `codex:${id}:${status}`,
      workItemId,
      type: "attempt.started",
      occurredAt: startedAt,
      payload: {
        attemptId: id,
        agentId
      }
    };
  }

  if (
    status !== "completed" &&
    status !== "failed" &&
    status !== "interrupted"
  ) {
    throw new TypeError(
      "Codex run status must be started, completed, failed, or interrupted."
    );
  }

  const completedAt = requireString(run.completedAt, "completedAt");
  const threadId = readOptionalString(run.threadId, "threadId");
  const turnId = readOptionalString(run.turnId, "turnId");
  const summary = readOptionalString(run.summary, "summary");

  return {
    eventId: `codex:${id}:${status}`,
    workItemId,
    type: "attempt.finished",
    occurredAt: completedAt,
    payload: {
      attemptId: id,
      outcome: status,
      ...(threadId === undefined ? {} : { threadId }),
      ...(turnId === undefined ? {} : { turnId }),
      ...(summary === undefined ? {} : { summary })
    }
  };
}

function readOptionalString(
  value: unknown,
  field: string
): string | undefined {
  return value === undefined ? undefined : requireString(value, field);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Codex run ${field} must be a non-empty string.`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}
