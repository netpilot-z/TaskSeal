import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileEventJournal } from "../src/storage/event-journal.js";

test("file journal appends canonical events and reads them back in order", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const journal = new FileEventJournal({
    filePath: join(directory, "events.jsonl")
  });
  const events = [createWorkItemEvent(), createAttemptEvent()];

  await journal.append(events[0]);
  await journal.append(events[1]);

  assert.deepEqual(await journal.readAll(), events);
});

test("file journal reports the corrupt line instead of ignoring it", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const filePath = join(directory, "events.jsonl");
  const journal = new FileEventJournal({ filePath });

  await journal.append(createWorkItemEvent());
  await appendFile(filePath, "{not-json}\n", "utf8");

  await assert.rejects(
    journal.readAll(),
    (error) =>
      error.code === "JOURNAL_CORRUPT" &&
      error.message.includes("line 2")
  );
});

async function createTemporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "taskseal-journal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function createWorkItemEvent() {
  return {
    eventId: "local:TS-1:created",
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
  };
}

function createAttemptEvent() {
  return {
    eventId: "codex:run-1:started",
    workItemId: "TS-1",
    type: "attempt.started",
    occurredAt: "2026-07-26T08:01:00.000Z",
    payload: {
      attemptId: "run-1",
      agentId: "codex"
    }
  };
}

