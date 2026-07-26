export function normalizeCodexRun(run) {
  requireString(run.id, "id");
  requireString(run.workItemId, "workItemId");
  requireString(run.status, "status");

  if (run.status === "started") {
    requireString(run.agentId, "agentId");
    requireString(run.startedAt, "startedAt");

    return {
      eventId: `codex:${run.id}:${run.status}`,
      workItemId: run.workItemId,
      type: "attempt.started",
      occurredAt: run.startedAt,
      payload: {
        attemptId: run.id,
        agentId: run.agentId
      }
    };
  }

  if (
    run.status !== "completed" &&
    run.status !== "failed" &&
    run.status !== "interrupted"
  ) {
    throw new TypeError(
      "Codex run status must be started, completed, failed, or interrupted."
    );
  }

  requireString(run.completedAt, "completedAt");
  const payload = {
    attemptId: run.id,
    outcome: run.status
  };

  for (const field of ["threadId", "turnId", "summary"]) {
    if (run[field] === undefined) {
      continue;
    }

    requireString(run[field], field);
    payload[field] = run[field];
  }

  return {
    eventId: `codex:${run.id}:${run.status}`,
    workItemId: run.workItemId,
    type: "attempt.finished",
    occurredAt: run.completedAt,
    payload
  };
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Codex run ${field} must be a non-empty string.`);
  }
}
