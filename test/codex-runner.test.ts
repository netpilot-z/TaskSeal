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

import { AttemptRunCoordinator } from "../src/application/attempt-run-coordinator.ts";
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

test("an operator cancellation is persisted as interrupted and retry creates a new attempt", async (t) => {
  const context = await createContext(t);
  const attemptIds = ["run-cancelled", "run-retry"];
  let attemptIndex = 0;
  let clientIndex = 0;
  let observeFirstClient = (): void => {};
  const firstClientStarted = new Promise<void>((resolve) => {
    observeFirstClient = resolve;
  });
  const runner = new CodexRunner({
    service: context.service,
    projectRoot: context.directory,
    idFactory: () => {
      const attemptId = attemptIds[attemptIndex];
      attemptIndex += 1;
      assert.ok(attemptId);
      return attemptId;
    },
    now: createAdvancingClock(),
    clientFactory: () => {
      const currentClient = clientIndex;
      clientIndex += 1;

      return {
        runTurn({ signal }) {
          if (currentClient > 0) {
            return Promise.resolve({
              outcome: "completed" as const,
              threadId: "thread-retry",
              turnId: "turn-retry",
              summary: "Retry completed."
            });
          }

          observeFirstClient();
          return new Promise<never>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () =>
                reject(
                  new TestCodedError(
                    "CODEX_INTERRUPTED",
                    "Operator cancelled the attempt."
                  )
                ),
              { once: true }
            );
          });
        }
      };
    }
  });
  const controller = new AbortController();
  const cancelledRun = runner.run({
    workItemId: "TS-1",
    cwd: context.directory,
    prompt: "Wait for cancellation.",
    signal: controller.signal
  });

  await firstClientStarted;
  controller.abort();
  const cancelled = await cancelledRun;

  const interrupted = context.service.getWorkItem("TS-1");
  assert.ok(interrupted);
  assert.equal(cancelled.outcome, "interrupted");
  assert.deepEqual(
    interrupted.attempts.map((attempt) => [
      attempt.id,
      attempt.status
    ]),
    [["run-cancelled", "interrupted"]]
  );

  const retry = await runner.run({
    workItemId: "TS-1",
    cwd: context.directory,
    prompt: "Retry after cancellation."
  });
  const completed = context.service.getWorkItem("TS-1");
  assert.ok(completed);

  assert.equal(retry.attemptId, "run-retry");
  assert.deepEqual(
    completed.attempts.map((attempt) => [
      attempt.id,
      attempt.status
    ]),
    [
      ["run-cancelled", "interrupted"],
      ["run-retry", "completed"]
    ]
  );
  assert.equal(completed.activeAttemptId, "run-retry");
});

test("an accepted cancellation overrides a client completion before terminalization", async (t) => {
  const context = await createContext(t);
  let observeClient = (): void => {};
  const clientStarted = new Promise<void>((resolve) => {
    observeClient = resolve;
  });
  let releaseClient = (): void => {};
  const clientGate = new Promise<void>((resolve) => {
    releaseClient = resolve;
  });
  const runner = new CodexRunner({
    service: context.service,
    projectRoot: context.directory,
    idFactory: () => "run-raced-cancel",
    clientFactory: () => ({
      async runTurn() {
        observeClient();
        await clientGate;
        return {
          outcome: "completed",
          summary: "Client ignored the abort."
        };
      }
    })
  });
  const coordinator = new AttemptRunCoordinator();
  const run = coordinator.start({
    workItemId: "TS-1",
    execute: ({ signal, terminalization }) =>
      runner.run({
        workItemId: "TS-1",
        cwd: context.directory,
        prompt: "Exercise the cancellation race.",
        signal,
        terminalization
      })
  });

  await clientStarted;
  coordinator.cancel("TS-1");
  releaseClient();
  const result = await run.execution;
  const workItem = context.service.getWorkItem("TS-1");

  assert.ok(workItem);
  assert.deepEqual(result, {
    attemptId: "run-raced-cancel",
    outcome: "interrupted",
    summary: "TaskSeal operator cancelled the active run."
  });
  assert.equal(
    workItem.attempts[0]?.status,
    "interrupted"
  );
});

test("a cancellation arriving during a terminal append is rejected and cannot rewrite the chosen outcome", async (t) => {
  const context = await createContext(t);
  let observeAppend = (): void => {};
  const appendStarted = new Promise<void>((resolve) => {
    observeAppend = resolve;
  });
  let releaseAppend = (): void => {};
  const appendGate = new Promise<void>((resolve) => {
    releaseAppend = resolve;
  });
  const service = {
    getWorkItem: (workItemId: string) =>
      context.service.getWorkItem(workItemId),
    startAttemptIfIdle: (event: Parameters<
      TaskSealService["startAttemptIfIdle"]
    >[0]) =>
      context.service.startAttemptIfIdle(event),
    append: async (event: Parameters<
      TaskSealService["append"]
    >[0]) => {
      observeAppend();
      await appendGate;
      return context.service.append(event);
    }
  };
  const runner = new CodexRunner({
    service,
    projectRoot: context.directory,
    idFactory: () => "run-terminal-fence",
    clientFactory: () => ({
      async runTurn() {
        return {
          outcome: "completed",
          summary: "Terminal outcome selected."
        };
      }
    })
  });
  const coordinator = new AttemptRunCoordinator();
  const run = coordinator.start({
    workItemId: "TS-1",
    execute: ({ signal, terminalization }) =>
      runner.run({
        workItemId: "TS-1",
        cwd: context.directory,
        prompt: "Fence terminalization.",
        signal,
        terminalization
      })
  });

  await appendStarted;
  assert.throws(
    () => coordinator.cancel("TS-1"),
    hasCode("RUN_TERMINALIZING")
  );
  releaseAppend();
  const result = await run.execution;
  const workItem = context.service.getWorkItem("TS-1");

  assert.ok(workItem);
  assert.equal(
    (result as { outcome: string }).outcome,
    "completed"
  );
  assert.equal(
    workItem.attempts[0]?.status,
    "completed"
  );
});

test("a failed interrupted terminal append surfaces the persistence error", async (t) => {
  const context = await createContext(t);
  let observeClient = (): void => {};
  const clientStarted = new Promise<void>((resolve) => {
    observeClient = resolve;
  });
  const persistenceError = new TestCodedError(
    "JOURNAL_WRITE_FAILED",
    "Terminal append failed."
  );
  const runner = new CodexRunner({
    service: {
      getWorkItem: (workItemId) =>
        context.service.getWorkItem(workItemId),
      startAttemptIfIdle: (event) =>
        context.service.startAttemptIfIdle(event),
      append: async () => {
        throw persistenceError;
      }
    },
    projectRoot: context.directory,
    idFactory: () => "run-terminal-failed",
    clientFactory: () => ({
      runTurn({ signal }) {
        observeClient();
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                new TestCodedError(
                  "CODEX_INTERRUPTED",
                  "Operator cancelled the attempt."
                )
              ),
            { once: true }
          );
        });
      }
    })
  });
  const controller = new AbortController();
  const run = runner.run({
    workItemId: "TS-1",
    cwd: context.directory,
    prompt: "Fail the interrupted terminal append.",
    signal: controller.signal
  });

  await clientStarted;
  controller.abort();
  await assert.rejects(
    run,
    hasCode("JOURNAL_WRITE_FAILED")
  );
  assert.equal(
    context.service.getWorkItem("TS-1")
      ?.attempts[0]?.status,
    "running"
  );
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

function createAdvancingClock(): () => Date {
  let offset = 0;

  return () => {
    const value = new Date(
      Date.parse("2026-07-26T09:01:00.000Z") +
        offset * 60_000
    );
    offset += 1;
    return value;
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
