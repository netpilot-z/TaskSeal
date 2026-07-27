import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { TaskSealService } from "../src/application/taskseal-service.ts";
import { CodexRunner } from "../src/runners/codex-runner.ts";
import type { CodexRunnerRunOptions } from "../src/runners/codex-runner.ts";
import { FileEventJournal } from "../src/storage/event-journal.ts";

interface RunnerTestContext {
  directory: string;
  journal: FileEventJournal;
  service: TaskSealService;
}

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
  assert.ok(workItem);
  const attempt = workItem.attempts[0];
  assert.ok(attempt);

  assert.equal(result.outcome, "completed");
  assert.equal(result.attemptId, "run-1");
  assert.equal(workItem.status, "reviewing");
  assert.equal(attempt.status, "completed");
  assert.equal(attempt.summary, "TaskSeal runner ready.");
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
        throw new TestCodedError(
          "CODEX_NOT_AVAILABLE",
          "Codex executable unavailable."
        );
      }
    })
  });

  await assert.rejects(
    runner.run({
      workItemId: "TS-1",
      cwd: context.directory,
      prompt: "Run a task."
    }),
    hasCode("CODEX_NOT_AVAILABLE")
  );

  const workItem = context.service.getWorkItem("TS-1");
  assert.ok(workItem);
  const attempt = workItem.attempts[0];
  assert.ok(attempt);
  assert.equal(workItem.status, "blocked");
  assert.equal(attempt.status, "failed");
  assert.equal(
    attempt.summary,
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
    hasCode("WORK_ITEM_NOT_FOUND")
  );

  await assert.rejects(
    runner.run({
      workItemId: "TS-1",
      cwd: join(context.directory, ".."),
      prompt: "Run a task."
    }),
    hasCode("RUNNER_CWD_OUTSIDE_PROJECT")
  );
});

test("runner rejects a project-local link that resolves outside the project", async (t) => {
  const context = await createContext(t);
  const outsideDirectory = await mkdtemp(
    join(tmpdir(), "taskseal-runner-outside-")
  );
  t.after(() =>
    rm(outsideDirectory, {
      recursive: true,
      force: true
    })
  );
  const linkedDirectory = join(context.directory, "linked-cwd");
  await symlink(
    outsideDirectory,
    linkedDirectory,
    process.platform === "win32" ? "junction" : "dir"
  );
  const runner = new CodexRunner({
    service: context.service,
    projectRoot: context.directory,
    clientFactory: () => ({
      async runTurn() {
        return {
          outcome: "completed"
        };
      }
    })
  });

  await assert.rejects(
    runner.run({
      workItemId: "TS-1",
      cwd: linkedDirectory,
      prompt: "Reject a linked directory outside the project."
    }),
    hasCode("RUNNER_CWD_OUTSIDE_PROJECT")
  );
});

test("runner passes a canonical cwd to the client", async (t) => {
  const context = await createContext(t);
  const targetDirectory = join(context.directory, "actual-cwd");
  const linkedDirectory = join(context.directory, "linked-cwd");
  await mkdir(targetDirectory);
  await symlink(
    targetDirectory,
    linkedDirectory,
    process.platform === "win32" ? "junction" : "dir"
  );
  const receivedCwds: string[] = [];
  const runner = new CodexRunner({
    service: context.service,
    projectRoot: context.directory,
    clientFactory: () => ({
      async runTurn(options) {
        receivedCwds.push(options.cwd);
        return {
          outcome: "completed"
        };
      }
    })
  });

  await runner.run({
    workItemId: "TS-1",
    cwd: linkedDirectory,
    prompt: "Use the canonical project directory."
  });

  assert.deepEqual(receivedCwds, [await realpath(targetDirectory)]);
});

test("runner fails closed before reservation when cwd cannot be resolved", async (t) => {
  const context = await createContext(t);
  let clientStarted = false;
  const runner = new CodexRunner({
    service: context.service,
    projectRoot: context.directory,
    clientFactory: () => {
      clientStarted = true;
      return {
        async runTurn() {
          return {
            outcome: "completed"
          };
        }
      };
    }
  });

  await assert.rejects(
    runner.run({
      workItemId: "TS-1",
      cwd: join(context.directory, "missing-cwd"),
      prompt: "Do not start for an unresolved cwd."
    }),
    hasError(
      "RUNNER_CWD_UNAVAILABLE",
      "Codex runner could not resolve its project root or cwd."
    )
  );

  const workItem = context.service.getWorkItem("TS-1");
  assert.ok(workItem);
  assert.equal(clientStarted, false);
  assert.equal(workItem.status, "planned");
  assert.equal(workItem.attempts.length, 0);
  assert.equal((await context.journal.readAll()).length, 1);
});

test("two concurrent runners cannot both reserve the same work item", async (t) => {
  const context = await createContext(t);
  const createRunner = (attemptId: string) =>
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
  const options: CodexRunnerRunOptions = {
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
  const workItem = context.service.getWorkItem("TS-1");
  assert.ok(workItem);
  assert.equal(workItem.attempts.length, 1);
});

async function createContext(
  t: TestContext
): Promise<RunnerTestContext> {
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

function createClock(): () => Date {
  const startedAt = new Date("2026-07-26T09:01:00.000Z");
  const completedAt = new Date("2026-07-26T09:02:00.000Z");
  let firstCall = true;

  return () => {
    if (firstCall) {
      firstCall = false;
      return startedAt;
    }

    return completedAt;
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}

function hasError(
  code: string,
  message: string
): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code &&
    error.message === message;
}

class TestCodedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
