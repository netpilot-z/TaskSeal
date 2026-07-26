import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeCodexRun } from "../src/connectors/codex.js";

test("a started Codex run is normalized into an attempt event", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../fixtures/codex/run.started.json", import.meta.url),
      "utf8"
    )
  );

  const event = normalizeCodexRun(fixture);

  assert.deepEqual(event, {
    eventId: "codex:run-1:started",
    workItemId: "TS-1",
    type: "attempt.started",
    occurredAt: "2026-07-26T08:01:00.000Z",
    payload: {
      attemptId: "run-1",
      agentId: "codex-product-engineer"
    }
  });
});

test("a completed Codex run is normalized into an explicit terminal event", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../fixtures/codex/run.completed.json", import.meta.url),
      "utf8"
    )
  );

  const event = normalizeCodexRun(fixture);

  assert.deepEqual(event, {
    eventId: "codex:run-1:completed",
    workItemId: "TS-1",
    type: "attempt.finished",
    occurredAt: "2026-07-26T08:02:00.000Z",
    payload: {
      attemptId: "run-1",
      outcome: "completed",
      threadId: "thread-1",
      turnId: "turn-1",
      summary: "Fixture agent completed the assigned turn."
    }
  });
});
