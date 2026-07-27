import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { TaskSealService } from "../src/application/taskseal-service.ts";
import type {
  AttemptStartedEvent,
  CanonicalEvent,
  WorkItem,
  WorkItemCreatedEvent
} from "../src/domain/workflow.ts";
import { FileEventJournal } from "../src/storage/event-journal.ts";

interface LegacyWorkItemCreatedTestEvent
  extends WorkItemCreatedEvent {
  legacyMetadata?: string;
}

interface OversizedLegacyCase {
  name: string;
  workItemId: string;
  mutate(event: LegacyWorkItemCreatedTestEvent): void;
}

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
  assert.equal(
    requireFirst(reopened.snapshot().workItems).status,
    "running"
  );
});

test("service reopens oversized legacy events accepted by the domain", async (t) => {
  const cases: OversizedLegacyCase[] = [
    {
      name: "extra-envelope-field",
      workItemId: "TS-extra",
      mutate(event) {
        event.legacyMetadata = "accepted-before";
      }
    },
    {
      name: "long-event-id",
      workItemId: "TS-long-id",
      mutate(event) {
        event.eventId = "e".repeat(513);
      }
    }
  ];

  for (const testCase of cases) {
    const directory = await createTemporaryDirectory(t);
    const filePath = join(
      directory,
      `${testCase.name}.jsonl`
    );
    const first = await TaskSealService.open({
      journal: new FileEventJournal({ filePath })
    });
    const event = createWorkItemEvent(
      testCase.workItemId
    );
    event.payload.title = "x".repeat(
      3 * 1024 * 1024
    );
    testCase.mutate(event);

    await first.append(event);

    const reopened = await TaskSealService.open({
      journal: new FileEventJournal({ filePath })
    });

    assert.equal(
      requireWorkItem(
        reopened.getWorkItem(testCase.workItemId)
      ).title,
      event.payload.title
    );
  }
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
    hasCode("EVENT_ID_CONFLICT")
  );

  assert.equal((await journal.readAll()).length, 1);
  const storedWorkflowItem =
    service.getWorkflow().workItems["TS-1"];
  assert.ok(storedWorkflowItem);
  assert.equal(
    storedWorkflowItem.title,
    event.payload.title
  );
});

test("service snapshots cannot mutate private workflow state", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const journal = new FileEventJournal({
    filePath: join(directory, "events.jsonl")
  });
  const service = await TaskSealService.open({ journal });

  await service.append(createWorkItemEvent());
  await service.append(createAttemptEvent());
  const snapshot = service.snapshot();
  const projectedWorkItem = requireFirst(
    snapshot.workItems
  );
  const projectedAttempt = requireFirst(
    projectedWorkItem.attempts
  );
  const projectedExternalLink = requireFirst(
    projectedWorkItem.externalLinks
  );

  projectedWorkItem.requiredEvidence.push("forged");
  Object.defineProperty(projectedAttempt, "status", {
    configurable: true,
    value: "succeeded",
    writable: true
  });
  projectedExternalLink.externalId = "forged";

  const stored = requireWorkItem(
    service.getWorkItem("TS-1")
  );
  assert.deepEqual(stored.requiredEvidence, ["tests"]);
  assert.equal(
    requireFirst(stored.attempts).status,
    "running"
  );
  assert.equal(
    requireFirst(stored.externalLinks).externalId,
    "TS-1"
  );
});

test("service keeps memory unchanged when journal append fails", async () => {
  const journal = {
    async readAll(): Promise<unknown[]> {
      return [];
    },
    async append(_event: CanonicalEvent): Promise<void> {
      throw new Error("disk unavailable");
    }
  };
  const service = await TaskSealService.open({ journal });

  await assert.rejects(
    service.append(createWorkItemEvent()),
    hasCode("JOURNAL_WRITE_FAILED")
  );

  assert.deepEqual(service.getWorkflow().workItems, {});
});

test("service rejects oversized events before changing memory or journal", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const filePath = join(directory, "events.jsonl");
  const journal = new FileEventJournal({ filePath });
  const service = await TaskSealService.open({ journal });
  const event = createWorkItemEvent();
  event.payload.title = "x".repeat(
    4 * 1024 * 1024
  );

  await assert.rejects(
    service.append(event),
    hasCode("JOURNAL_WRITE_FAILED")
  );

  assert.deepEqual(service.getWorkflow().workItems, {});
  assert.deepEqual(await journal.readAll(), []);
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
  const workItem = requireWorkItem(
    service.getWorkItem("TS-1")
  );
  const attempt = requireFirst(workItem.attempts);

  assert.equal(recovered, 1);
  assert.equal(recoveredAgain, 0);
  assert.equal(workItem.status, "blocked");
  assert.equal(attempt.status, "interrupted");

  if (typeof attempt.summary !== "string") {
    assert.fail("Recovered attempt requires a summary.");
  }

  assert.match(attempt.summary, /restarted/);
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
  const firstWorkItem = requireWorkItem(
    service.getWorkItem("TS-1")
  );
  const secondWorkItem = requireWorkItem(
    service.getWorkItem("TS-2")
  );
  assert.equal(firstWorkItem.status, "blocked");
  assert.equal(secondWorkItem.status, "blocked");
  assert.equal(
    requireFirst(firstWorkItem.attempts).status,
    "interrupted"
  );
  assert.equal(
    requireFirst(secondWorkItem.attempts).status,
    "interrupted"
  );
  assert.equal((await journal.readAll()).length, 6);
});

async function createTemporaryDirectory(
  t: TestContext
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taskseal-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function createWorkItemEvent(
  workItemId = "TS-1"
): LegacyWorkItemCreatedTestEvent {
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
): AttemptStartedEvent {
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

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error) =>
    isRecord(error) && error.code === code;
}

function requireWorkItem(
  workItem: WorkItem | null
): WorkItem {
  assert.ok(workItem);
  return workItem;
}

function requireFirst<T>(values: readonly T[]): T {
  const value = values[0];

  if (value === undefined) {
    assert.fail("Expected a non-empty array.");
  }

  return value;
}

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}
