import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TaskSealService } from "../src/application/taskseal-service.js";
import { FileEventJournal } from "../src/storage/event-journal.js";

test("service restores the same workflow from a reopened journal", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const filePath = join(directory, "events.jsonl");
  const first = await TaskSealService.open({
    journal: new FileEventJournal({ filePath })
  });

  await first.append(createWorkItemEvent());
  await first.append(createAttemptEvent());

  const reopened = await TaskSealService.open({
    journal: new FileEventJournal({ filePath })
  });

  assert.deepEqual(reopened.getWorkflow(), first.getWorkflow());
  assert.equal(reopened.snapshot().workItems[0].status, "running");
});

test("service does not append duplicate or conflicting event ids", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const journal = new FileEventJournal({
    filePath: join(directory, "events.jsonl")
  });
  const service = await TaskSealService.open({ journal });
  const event = createWorkItemEvent();

  await service.append(event);
  await service.append(event);

  await assert.rejects(
    service.append({
      ...event,
      payload: {
        ...event.payload,
        title: "Conflicting title"
      }
    }),
    (error) => error.code === "EVENT_ID_CONFLICT"
  );

  assert.equal((await journal.readAll()).length, 1);
  assert.equal(service.getWorkflow().workItems["TS-1"].title, event.payload.title);
});

test("service keeps memory unchanged when journal append fails", async () => {
  const journal = {
    async readAll() {
      return [];
    },
    async append() {
      throw new Error("disk unavailable");
    }
  };
  const service = await TaskSealService.open({ journal });

  await assert.rejects(
    service.append(createWorkItemEvent()),
    (error) => error.code === "JOURNAL_WRITE_FAILED"
  );

  assert.deepEqual(service.getWorkflow().workItems, {});
});

test("service recovers unfinished attempts as interrupted after restart", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const journal = new FileEventJournal({
    filePath: join(directory, "events.jsonl")
  });
  const service = await TaskSealService.open({ journal });

  await service.append(createWorkItemEvent());
  await service.append(createAttemptEvent());

  const recovered = await service.recoverRunningAttempts({
    occurredAt: "2026-07-26T08:02:00.000Z"
  });
  const recoveredAgain = await service.recoverRunningAttempts({
    occurredAt: "2026-07-26T08:03:00.000Z"
  });
  const workItem = service.getWorkItem("TS-1");

  assert.equal(recovered, 1);
  assert.equal(recoveredAgain, 0);
  assert.equal(workItem.status, "blocked");
  assert.equal(workItem.attempts[0].status, "interrupted");
  assert.match(workItem.attempts[0].summary, /restarted/);
  assert.equal((await journal.readAll()).length, 3);
});

test("service recovers matching attempt ids from different work items", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const journal = new FileEventJournal({
    filePath: join(directory, "events.jsonl")
  });
  const service = await TaskSealService.open({ journal });

  for (const workItemId of ["TS-1", "TS-2"]) {
    await service.append(createWorkItemEvent(workItemId));
    await service.append(createAttemptEvent(workItemId, "run-1"));
  }

  const recovered = await service.recoverRunningAttempts({
    occurredAt: "2026-07-26T08:02:00.000Z"
  });

  assert.equal(recovered, 2);
  assert.equal(service.getWorkItem("TS-1").status, "blocked");
  assert.equal(service.getWorkItem("TS-2").status, "blocked");
  assert.equal(
    service.getWorkItem("TS-1").attempts[0].status,
    "interrupted"
  );
  assert.equal(
    service.getWorkItem("TS-2").attempts[0].status,
    "interrupted"
  );
  assert.equal((await journal.readAll()).length, 6);
});

async function createTemporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "taskseal-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function createWorkItemEvent(workItemId = "TS-1") {
  return {
    eventId: `local:${workItemId}:created`,
    workItemId,
    type: "work_item.created",
    occurredAt: "2026-07-26T08:00:00.000Z",
    payload: {
      title: "Run a real Codex turn",
      requiredEvidence: ["tests"],
      externalLink: {
        provider: "taskseal",
        externalId: workItemId,
        url: `http://127.0.0.1/work-items/${workItemId}`
      }
    }
  };
}

function createAttemptEvent(
  workItemId = "TS-1",
  attemptId = "run-1"
) {
  return {
    eventId: `codex:${workItemId}:${attemptId}:started`,
    workItemId,
    type: "attempt.started",
    occurredAt: "2026-07-26T08:01:00.000Z",
    payload: {
      attemptId,
      agentId: "codex"
    }
  };
}
