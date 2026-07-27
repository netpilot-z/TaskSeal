import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TaskSealService } from "../src/application/taskseal-service.ts";
import { CodexRunner } from "../src/runners/codex-runner.js";
import { FileEventJournal } from "../src/storage/event-journal.ts";

test("runner persists a completed Codex attempt through the service", async (t) => {
  const context = await createContext(t);
  const runner = new CodexRunner({
    service: context.service,
    projectRoot: context.directory,
    idFactory: () => "run-1",
    now: createClock(),
    clientFactory: () => ({
      async runTurn() {
        return {
          outcome: "completed",
          threadId: "thread-1",
          turnId: "turn-1",
          summary: "TaskSeal runner ready."
        };
      }
    })
  });

  const result = await runner.run({
    workItemId: "TS-1",
    cwd: context.directory,
    prompt: "Return a fixed result.",
    sandbox: "read-only"
  });
  const workItem = context.service.getWorkItem("TS-1");

  assert.equal(result.outcome, "completed");
  assert.equal(result.attemptId, "run-1");
  assert.equal(workItem.status, "reviewing");
  assert.equal(workItem.attempts[0].status, "completed");
  assert.equal(workItem.attempts[0].summary, "TaskSeal runner ready.");
  assert.equal((await context.journal.readAll()).length, 3);
});

test("runner persists a blocked attempt when Codex fails to start", async (t) => {
  const context = await createContext(t);
  const runner = new CodexRunner({
    service: context.service,
    projectRoot: context.directory,
    idFactory: () => "run-failed",
    now: createClock(),
    clientFactory: () => ({
      async runTurn() {
        const error = new Error("Codex executable unavailable.");
        error.code = "CODEX_NOT_AVAILABLE";
        throw error;
      }
    })
  });

  await assert.rejects(
    runner.run({
      workItemId: "TS-1",
      cwd: context.directory,
      prompt: "Run a task."
    }),
    (error) => error.code === "CODEX_NOT_AVAILABLE"
  );

  const workItem = context.service.getWorkItem("TS-1");
  assert.equal(workItem.status, "blocked");
  assert.equal(workItem.attempts[0].status, "failed");
  assert.equal(
    workItem.attempts[0].summary,
    "Codex executable unavailable."
  );
  assert.equal((await context.journal.readAll()).length, 3);
});

test("runner rejects missing work items and cwd outside the project", async (t) => {
  const context = await createContext(t);
  const runner = new CodexRunner({
    service: context.service,
    projectRoot: context.directory,
    clientFactory: () => {
      throw new Error("Client should not start.");
    }
  });

  await assert.rejects(
    runner.run({
      workItemId: "TS-404",
      cwd: context.directory,
      prompt: "Run a task."
    }),
    (error) => error.code === "WORK_ITEM_NOT_FOUND"
  );

  await assert.rejects(
    runner.run({
      workItemId: "TS-1",
      cwd: join(context.directory, ".."),
      prompt: "Run a task."
    }),
    (error) => error.code === "RUNNER_CWD_OUTSIDE_PROJECT"
  );
});

test("two concurrent runners cannot both reserve the same work item", async (t) => {
  const context = await createContext(t);
  const createRunner = (attemptId) =>
    new CodexRunner({
      service: context.service,
      projectRoot: context.directory,
      idFactory: () => attemptId,
      now: createClock(),
      clientFactory: () => ({
        async runTurn() {
          return {
            outcome: "completed",
            threadId: `thread-${attemptId}`,
            turnId: `turn-${attemptId}`
          };
        }
      })
    });
  const options = {
    workItemId: "TS-1",
    cwd: context.directory,
    prompt: "Run exactly once.",
    sandbox: "read-only"
  };

  const results = await Promise.allSettled([
    createRunner("run-a").run(options),
    createRunner("run-b").run(options)
  ]);

  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1
  );
  assert.equal(
    results.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason.code === "ATTEMPT_ALREADY_ACTIVE"
    ).length,
    1
  );
  assert.equal(context.service.getWorkItem("TS-1").attempts.length, 1);
});

async function createContext(t) {
  const directory = await mkdtemp(join(tmpdir(), "taskseal-runner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = new FileEventJournal({
    filePath: join(directory, ".taskseal", "events.jsonl")
  });
  const service = await TaskSealService.open({ journal });
  await service.append({
    eventId: "taskseal:TS-1:local-created",
    workItemId: "TS-1",
    type: "work_item.created",
    occurredAt: "2026-07-26T09:00:00.000Z",
    payload: {
      title: "Run the first Codex App Server attempt",
      requiredEvidence: ["tests"],
      externalLink: {
        provider: "taskseal",
        externalId: "TS-1",
        url: "http://127.0.0.1:4317/work-items/TS-1"
      }
    }
  });

  return {
    directory,
    journal,
    service
  };
}

function createClock() {
  const values = [
    new Date("2026-07-26T09:01:00.000Z"),
    new Date("2026-07-26T09:02:00.000Z")
  ];
  return () => values.shift() ?? values.at(-1);
}
