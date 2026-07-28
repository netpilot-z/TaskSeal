import assert from "node:assert/strict";
import {
  spawnSync
} from "node:child_process";
import {
  mkdtemp,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  fileURLToPath
} from "node:url";

import { ManagedAttemptRunner } from "../src/application/managed-attempt-runner.ts";
import {
  AttemptRunCoordinator
} from "../src/application/attempt-run-coordinator.ts";
import { TaskSealService } from "../src/application/taskseal-service.ts";
import type {
  CanonicalEvent
} from "../src/domain/workflow.ts";
import {
  RunnerExecutionError,
  parseRunnerExecutionOutput,
  parseRunnerManifest
} from "../src/runners/runner-contract.ts";
import {
  CodexAppServerRunnerAdapter
} from "../src/runners/codex-runner.ts";
import { FileEventJournal } from "../src/storage/event-journal.ts";
import { FakeRunnerAdapter } from "../test-support/fake-runner.ts";
import { registerRunnerAdapterContract } from "../test-support/runner-contract-kit.ts";

const timeoutChildPath = fileURLToPath(
  new URL(
    "../test-support/managed-runner-timeout-child.ts",
    import.meta.url
  )
);

registerRunnerAdapterContract({
  name: "deterministic fake runner",
  createAdapter(scenario) {
    return new FakeRunnerAdapter({
      behavior:
        scenario === "completed"
          ? (input) => ({
              schemaVersion: "1",
              attemptId: input.attemptId,
              outcome: "completed",
              summary: "Contract complete."
            })
          : (_input, { signal }) =>
              new Promise<never>((_resolve, reject) => {
                signal.addEventListener(
                  "abort",
                  () => reject(signal.reason),
                  { once: true }
                );
              })
    });
  }
});

test("manifest decoder rejects unknown fields and missing lifecycle capabilities", () => {
  assert.throws(
    () =>
      parseRunnerManifest({
        ...validManifest(),
        providerClient: "linear"
      }),
    hasCode("RUNNER_MANIFEST_INVALID")
  );

  assert.throws(
    () =>
      parseRunnerManifest({
        ...validManifest(),
        capabilities: {
          ...validManifest().capabilities,
          timeout: false
        }
      }),
    hasCode("RUNNER_CAPABILITY_MISSING")
  );
});

test("output decoder rejects cross-attempt, extra-field, accessor and undeclared handoff output", () => {
  const manifest = parseRunnerManifest(
    validManifest()
  );
  const invalidOutputs: unknown[] = [
    {
      schemaVersion: "1",
      attemptId: "another-attempt",
      outcome: "completed"
    },
    {
      schemaVersion: "1",
      attemptId: "attempt-1",
      outcome: "completed",
      domainEvent: {
        type: "evidence.recorded"
      }
    },
    {
      schemaVersion: "1",
      attemptId: "attempt-1",
      outcome: "completed",
      summary: "x".repeat(2_001)
    },
    {
      schemaVersion: "1",
      attemptId: "attempt-1",
      outcome: "completed",
      handoffClaims: [
        {
          kind: "artifact",
          artifactKind: "git-commit",
          revision: "abc123",
          locator: "https://example.test/artifact"
        }
      ]
    }
  ];
  const accessorOutput = {
    schemaVersion: "1",
    attemptId: "attempt-1",
    outcome: "completed"
  };
  Object.defineProperty(
    accessorOutput,
    "summary",
    {
      enumerable: true,
      get() {
        throw new Error(
          "Decoder must not invoke accessors."
        );
      }
    }
  );
  invalidOutputs.push(accessorOutput);

  for (const output of invalidOutputs) {
    assert.throws(
      () =>
        parseRunnerExecutionOutput(
          output,
          {
            manifest,
            expectedAttemptId: "attempt-1"
          }
        ),
      hasCode("RUNNER_OUTPUT_INVALID")
    );
  }

  assert.throws(
    () =>
      parseRunnerExecutionOutput(
        {
          schemaVersion: "1",
          attemptId: "attempt-1",
          outcome: "failed",
          handoffClaims: [
            {
              kind: "artifact",
              artifactKind: "git-commit",
              revision: "abc123",
              locator:
                "https://example.test/artifact"
            }
          ]
        },
        {
          manifest:
            parseRunnerManifest({
              ...validManifest(),
              capabilities: {
                ...validManifest()
                  .capabilities,
                handoffKinds: [
                  "artifact"
                ]
              }
            }),
          expectedAttemptId:
            "attempt-1"
        }
      ),
    hasCode("RUNNER_OUTPUT_INVALID")
  );
});

test("Codex and a second fake adapter produce the same managed Attempt lifecycle shape", async (t) => {
  const fakeContext = await createContext(t);
  const codexContext = await createContext(t);
  const fakeRunner = new ManagedAttemptRunner({
    service: fakeContext.service,
    projectRoot: fakeContext.directory,
    adapter: new FakeRunnerAdapter({
      runnerId: "second-fake-runner",
      behavior(input) {
        return {
          schemaVersion: "1",
          attemptId: input.attemptId,
          outcome: "completed",
          summary: "Equivalent result."
        };
      }
    }),
    idFactory: () => "equivalent-attempt",
    now: createClock()
  });
  const codexRunner = new ManagedAttemptRunner({
    service: codexContext.service,
    projectRoot: codexContext.directory,
    adapter: new CodexAppServerRunnerAdapter({
      clientFactory: () => ({
        async runTurn() {
          return {
            outcome: "completed",
            summary: "Equivalent result."
          };
        }
      })
    }),
    idFactory: () => "equivalent-attempt",
    now: createClock()
  });

  await Promise.all([
    fakeRunner.run({
      workItemId: "TS-1",
      cwd: fakeContext.directory,
      instruction: "Run the same lifecycle.",
      workspaceAccess: "read-only"
    }),
    codexRunner.run({
      workItemId: "TS-1",
      cwd: codexContext.directory,
      instruction: "Run the same lifecycle.",
      workspaceAccess: "read-only"
    })
  ]);
  const fakeEvents =
    await fakeContext.journal.readAll();
  const codexEvents =
    await codexContext.journal.readAll();

  assert.deepEqual(
    normalizeLifecycle(fakeEvents.slice(1)),
    normalizeLifecycle(codexEvents.slice(1))
  );
});

test("managed runner returns untrusted handoff claims without creating canonical delivery facts", async (t) => {
  const context = await createContext(t);
  const adapter = new FakeRunnerAdapter({
    handoffKinds: ["artifact", "evidence"],
    behavior(input) {
      return {
        schemaVersion: "1",
        attemptId: input.attemptId,
        outcome: "completed",
        summary: "Delivery claims are ready.",
        runtimeRefs: {
          sessionId: "fake-session",
          executionId: "fake-execution"
        },
        handoffClaims: [
          {
            kind: "artifact",
            artifactKind: "git-commit",
            revision: "abc123",
            locator:
              "https://example.test/artifacts/abc123"
          },
          {
            kind: "evidence",
            criterionKey: "tests",
            outcome: "passed",
            artifactRevision: "abc123",
            locator:
              "https://example.test/checks/1"
          }
        ]
      };
    }
  });
  const runner = new ManagedAttemptRunner({
    service: context.service,
    projectRoot: context.directory,
    adapter,
    idFactory: () => "fake-attempt",
    now: createClock()
  });

  const result = await runner.run({
    workItemId: "TS-1",
    cwd: context.directory,
    instruction: "Produce delivery claims.",
    workspaceAccess: "read-only"
  });
  const workItem = context.service.getWorkItem(
    "TS-1"
  );

  assert.ok(workItem);
  assert.equal(result.outcome, "completed");
  assert.equal(result.handoffClaims.length, 2);
  assert.equal(workItem.status, "reviewing");
  assert.equal(
    workItem.attempts[0]?.agentId,
    "fake-runner"
  );
  assert.deepEqual(workItem.artifacts, []);
  assert.deepEqual(workItem.evidence, []);
  assert.equal(workItem.acceptanceDecision, null);
  assert.deepEqual(
    Object.keys(adapter.inputs[0] ?? {}).sort(),
    [
      "attemptId",
      "deadlineAt",
      "instruction",
      "schemaVersion",
      "workItemId",
      "workspace"
    ]
  );
  assert.equal(
    Object.isFrozen(adapter.inputs[0]),
    true
  );
  assert.equal(
    Object.isFrozen(
      adapter.inputs[0]?.workspace
    ),
    true
  );
  assert.equal(
    Object.isFrozen(runner.manifest),
    true
  );
});

test("managed runner terminalizes malformed output as a safe failed attempt", async (t) => {
  const context = await createContext(t);
  const runner = new ManagedAttemptRunner({
    service: context.service,
    projectRoot: context.directory,
    adapter: new FakeRunnerAdapter({
      behavior(input) {
        return {
          schemaVersion: "1",
          attemptId: input.attemptId,
          outcome: "completed",
          acceptanceDecision: "accepted"
        };
      }
    }),
    idFactory: () => "malformed-attempt",
    now: createClock()
  });

  await assert.rejects(
    runner.run({
      workItemId: "TS-1",
      cwd: context.directory,
      instruction: "Return an invalid envelope.",
      workspaceAccess: "read-only"
    }),
    hasCode("RUNNER_OUTPUT_INVALID")
  );

  const workItem = context.service.getWorkItem(
    "TS-1"
  );
  assert.ok(workItem);
  assert.equal(workItem.status, "blocked");
  assert.equal(
    workItem.attempts[0]?.status,
    "failed"
  );
  assert.equal(
    workItem.attempts[0]?.summary,
    "Runner returned an invalid output envelope."
  );
});

test("managed runner never persists an unknown adapter error message", async (t) => {
  const context = await createContext(t);
  const runner = new ManagedAttemptRunner({
    service: context.service,
    projectRoot: context.directory,
    adapter: new FakeRunnerAdapter({
      behavior() {
        throw new Error(
          "LINEAR_API_KEY=do-not-persist"
        );
      }
    }),
    idFactory: () => "secret-error-attempt",
    now: createClock()
  });

  await assert.rejects(
    runner.run({
      workItemId: "TS-1",
      cwd: context.directory,
      instruction: "Fail without leaking.",
      workspaceAccess: "read-only"
    }),
    /LINEAR_API_KEY/
  );

  const attempt =
    context.service.getWorkItem("TS-1")
      ?.attempts[0];
  assert.equal(
    attempt?.summary,
    "Runner execution failed."
  );
  assert.equal(
    JSON.stringify(
      await context.journal.readAll()
    ).includes("do-not-persist"),
    false
  );
});

test("managed runner owns the deadline and maps timeout to a failed attempt", async (t) => {
  const context = await createContext(t);
  let observedAbortReason: unknown;
  const adapter = new FakeRunnerAdapter({
    behavior(_input, { signal }) {
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            observedAbortReason = signal.reason;
            reject(signal.reason);
          },
          { once: true }
        );
      });
    }
  });
  const runner = new ManagedAttemptRunner({
    service: context.service,
    projectRoot: context.directory,
    adapter,
    idFactory: () => "timeout-attempt",
    now: createClock()
  });

  await assert.rejects(
    runner.run({
      workItemId: "TS-1",
      cwd: context.directory,
      instruction: "Wait beyond the deadline.",
      workspaceAccess: "read-only",
      timeoutMs: 20
    }),
    hasCode("RUNNER_TIMEOUT")
  );

  assert.equal(
    isCodedError(observedAbortReason) &&
      observedAbortReason.code,
    "RUNNER_TIMEOUT"
  );
  const attempt =
    context.service.getWorkItem("TS-1")
      ?.attempts[0];
  assert.equal(attempt?.status, "failed");
  assert.equal(
    attempt?.summary,
    "Runner exceeded its execution deadline."
  );
});

test("a handle-free hanging adapter still reaches a bounded cleanup failure", () => {
  const result = spawnSync(
    process.execPath,
    [timeoutChildPath],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 5_000
    }
  );

  assert.equal(
    result.status,
    0,
    result.stderr
  );
  assert.deepEqual(
    JSON.parse(result.stdout),
    {
      code:
        "RUNNER_PROCESS_CLEANUP_FAILED",
      terminalAppends: 1
    }
  );
});

test("operator cancellation of a handle-free hanging adapter also reaches bounded cleanup", () => {
  const result = spawnSync(
    process.execPath,
    [timeoutChildPath, "cancel"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 5_000
    }
  );

  assert.equal(
    result.status,
    0,
    result.stderr
  );
  assert.deepEqual(
    JSON.parse(result.stdout),
    {
      code:
        "RUNNER_PROCESS_CLEANUP_FAILED",
      terminalAppends: 1
    }
  );
});

test("deadline waits for adapter cleanup and propagates an unconfirmed cleanup", async (t) => {
  const context = await createContext(t);
  let cleanupSettled = false;
  const runner = new ManagedAttemptRunner({
    service: context.service,
    projectRoot: context.directory,
    adapter: new FakeRunnerAdapter({
      behavior(_input, { signal }) {
        return new Promise<never>(
          (_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                setTimeout(() => {
                  cleanupSettled = true;
                  reject(
                    new RunnerExecutionError(
                      "RUNNER_PROCESS_CLEANUP_FAILED",
                      "Runner process cleanup could not be confirmed."
                    )
                  );
                }, 40);
              },
              { once: true }
            );
          }
        );
      }
    }),
    idFactory: () =>
      "delayed-cleanup-attempt",
    now: createClock(),
    cleanupGraceMs: 200
  });

  await assert.rejects(
    runner.run({
      workItemId: "TS-1",
      cwd: context.directory,
      instruction:
        "Wait for bounded cleanup.",
      workspaceAccess: "read-only",
      timeoutMs: 10
    }),
    hasCode(
      "RUNNER_PROCESS_CLEANUP_FAILED"
    )
  );

  assert.equal(cleanupSettled, true);
  assert.equal(
    context.service.getWorkItem("TS-1")
      ?.attempts[0]?.status,
    "failed"
  );
  await assert.rejects(
    runner.run({
      workItemId: "TS-1",
      cwd: context.directory,
      instruction:
        "A fenced host must not dispatch.",
      workspaceAccess: "read-only"
    }),
    hasCode("RUNNER_CLEANUP_FENCED")
  );
  assert.equal(
    context.service.getWorkItem("TS-1")
      ?.attempts.length,
    1
  );
});

test("attempt coordinator retains capacity until deadline cleanup settles", async (t) => {
  const context = await createContext(t);
  let observeAbort = (): void => {};
  const abortObserved =
    new Promise<void>((resolve) => {
      observeAbort = resolve;
    });
  let finishCleanup = (): void => {};
  const cleanupGate =
    new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
  const runner = new ManagedAttemptRunner({
    service: context.service,
    projectRoot: context.directory,
    adapter: new FakeRunnerAdapter({
      behavior(_input, { signal }) {
        return new Promise<never>(
          (_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                observeAbort();
                cleanupGate.then(() =>
                  reject(
                    new Error(
                      "Expected timeout interruption."
                    )
                  )
                );
              },
              { once: true }
            );
          }
        );
      }
    }),
    idFactory: () =>
      "capacity-cleanup-attempt",
    now: createClock(),
    cleanupGraceMs: 200
  });
  const coordinator =
    new AttemptRunCoordinator({
      maxConcurrentRuns: 1
    });
  const first = coordinator.start({
    workItemId: "TS-1",
    execute: ({
      signal,
      terminalization
    }) =>
      runner.run({
        workItemId: "TS-1",
        cwd: context.directory,
        instruction:
          "Hold capacity through cleanup.",
        workspaceAccess: "read-only",
        timeoutMs: 10,
        signal,
        terminalization
      })
  });

  await abortObserved;
  assert.throws(
    () =>
      coordinator.start({
        workItemId: "TS-2",
        execute: async () => undefined
      }),
    hasCode("RUN_CAPACITY_REACHED")
  );
  finishCleanup();
  await assert.rejects(
    first.execution,
    hasCode("RUNNER_TIMEOUT")
  );
  assert.equal(
    coordinator.snapshot().activeCount,
    0
  );
});

test("deadline locks failed terminalization before adapter cleanup can receive a late cancellation", async (t) => {
  const context = await createContext(t);
  let observeAbort = (): void => {};
  const abortObserved =
    new Promise<void>((resolve) => {
      observeAbort = resolve;
    });
  let finishCleanup = (): void => {};
  const cleanupGate =
    new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
  const runner = new ManagedAttemptRunner({
    service: context.service,
    projectRoot: context.directory,
    adapter: new FakeRunnerAdapter({
      behavior(_input, { signal }) {
        return new Promise<never>(
          (_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                observeAbort();
                cleanupGate.then(() =>
                  reject(
                    new Error(
                      "Expected timeout interruption."
                    )
                  )
                );
              },
              { once: true }
            );
          }
        );
      }
    }),
    idFactory: () =>
      "timeout-terminalization-attempt",
    now: createClock(),
    cleanupGraceMs: 200
  });
  const coordinator =
    new AttemptRunCoordinator();
  const active = coordinator.start({
    workItemId: "TS-1",
    execute: ({
      signal,
      terminalization
    }) =>
      runner.run({
        workItemId: "TS-1",
        cwd: context.directory,
        instruction:
          "Keep timeout authoritative during cleanup.",
        workspaceAccess: "read-only",
        timeoutMs: 10,
        signal,
        terminalization
      })
  });

  await abortObserved;
  assert.throws(
    () => coordinator.cancel("TS-1"),
    hasCode("RUN_TERMINALIZING")
  );
  finishCleanup();
  await assert.rejects(
    active.execution,
    hasCode("RUNNER_TIMEOUT")
  );
  assert.equal(
    context.service.getWorkItem("TS-1")
      ?.attempts[0]?.status,
    "failed"
  );
});

test("operator cancellation persists interrupted but still propagates and fences a cleanup failure", async (t) => {
  const context = await createContext(t);
  let observeExecution = (): void => {};
  const executionStarted =
    new Promise<void>((resolve) => {
      observeExecution = resolve;
    });
  const runner = new ManagedAttemptRunner({
    service: context.service,
    projectRoot: context.directory,
    adapter: new FakeRunnerAdapter({
      behavior(_input, { signal }) {
        observeExecution();
        return new Promise<never>(
          (_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () =>
                reject(
                  new RunnerExecutionError(
                    "RUNNER_PROCESS_CLEANUP_FAILED",
                    "Runner process cleanup could not be confirmed."
                  )
                ),
              { once: true }
            );
          }
        );
      }
    }),
    idFactory: () =>
      "cancel-cleanup-attempt",
    now: createClock()
  });
  const controller =
    new AbortController();
  const execution = runner.run({
    workItemId: "TS-1",
    cwd: context.directory,
    instruction:
      "Cancel and surface cleanup failure.",
    workspaceAccess: "read-only",
    signal: controller.signal
  });

  await executionStarted;
  controller.abort(
    new Error("Operator cancelled.")
  );
  await assert.rejects(
    execution,
    hasCode(
      "RUNNER_PROCESS_CLEANUP_FAILED"
    )
  );

  assert.equal(
    context.service.getWorkItem("TS-1")
      ?.attempts[0]?.status,
    "interrupted"
  );
  await assert.rejects(
    runner.run({
      workItemId: "TS-1",
      cwd: context.directory,
      instruction:
        "Do not dispatch after cleanup failure.",
      workspaceAccess: "read-only"
    }),
    hasCode("RUNNER_CLEANUP_FENCED")
  );
});

test("managed runner never retries or reselects a terminal fact when its append fails", async (t) => {
  const context = await createContext(t);
  const persistenceError = Object.assign(
    new Error("Terminal append failed."),
    { code: "JOURNAL_WRITE_FAILED" }
  );
  let appendCalls = 0;
  let terminalizationCalls = 0;
  const runner = new ManagedAttemptRunner({
    service: {
      getWorkItem: (workItemId) =>
        context.service.getWorkItem(
          workItemId
        ),
      startAttemptIfIdle: (event) =>
        context.service.startAttemptIfIdle(
          event
        ),
      append: async () => {
        appendCalls += 1;
        throw persistenceError;
      }
    },
    projectRoot: context.directory,
    adapter: new FakeRunnerAdapter({
      behavior(input) {
        return {
          schemaVersion: "1",
          attemptId: input.attemptId,
          outcome: "completed"
        };
      }
    }),
    idFactory: () =>
      "terminal-append-attempt",
    now: createClock()
  });

  await assert.rejects(
    runner.run({
      workItemId: "TS-1",
      cwd: context.directory,
      instruction:
        "Commit exactly one terminal fact.",
      workspaceAccess: "read-only",
      terminalization: {
        begin() {
          terminalizationCalls += 1;
          return {
            cancellationAccepted:
              false
          };
        }
      }
    }),
    hasCode("JOURNAL_WRITE_FAILED")
  );

  assert.equal(appendCalls, 1);
  assert.equal(terminalizationCalls, 1);
  assert.equal(
    context.service.getWorkItem("TS-1")
      ?.attempts[0]?.status,
    "running"
  );
});

test("managed runner rejects a requested workspace capability before reserving an attempt", async (t) => {
  const context = await createContext(t);
  const runner = new ManagedAttemptRunner({
    service: context.service,
    projectRoot: context.directory,
    adapter: new FakeRunnerAdapter({
      workspaceAccess: ["read-only"],
      behavior() {
        throw new Error("must not execute");
      }
    }),
    allowedWorkspaceAccess: [
      "read-only",
      "workspace-write"
    ]
  });

  await assert.rejects(
    runner.run({
      workItemId: "TS-1",
      cwd: context.directory,
      instruction: "Request write access.",
      workspaceAccess: "workspace-write"
    }),
    hasCode("RUNNER_CAPABILITY_MISSING")
  );
  assert.equal(
    context.service.getWorkItem("TS-1")
      ?.attempts.length,
    0
  );
});

test("manifest capability cannot grant workspace permission absent from Host policy", async (t) => {
  const context = await createContext(t);
  let executions = 0;
  const runner = new ManagedAttemptRunner({
    service: context.service,
    projectRoot: context.directory,
    adapter: new FakeRunnerAdapter({
      workspaceAccess: [
        "read-only",
        "workspace-write"
      ],
      behavior() {
        executions += 1;
        throw new Error("must not execute");
      }
    })
  });

  await assert.rejects(
    runner.run({
      workItemId: "TS-1",
      cwd: context.directory,
      instruction:
        "Do not confuse capability with permission.",
      workspaceAccess:
        "workspace-write"
    }),
    hasCode("RUNNER_PERMISSION_DENIED")
  );
  assert.equal(executions, 0);
  assert.equal(
    context.service.getWorkItem("TS-1")
      ?.attempts.length,
    0
  );
});

interface RunnerTestContext {
  directory: string;
  journal: FileEventJournal;
  service: TaskSealService;
}

async function createContext(
  t: TestContext
): Promise<RunnerTestContext> {
  const directory = await mkdtemp(
    join(tmpdir(), "taskseal-contract-")
  );
  t.after(() =>
    rm(directory, {
      recursive: true,
      force: true
    })
  );
  const journal = new FileEventJournal({
    filePath: join(
      directory,
      ".taskseal",
      "events.jsonl"
    )
  });
  const service = await TaskSealService.open({
    journal
  });
  await service.append({
    eventId: "taskseal:TS-1:local-created",
    workItemId: "TS-1",
    type: "work_item.created",
    occurredAt: "2026-07-28T09:00:00.000Z",
    payload: {
      title: "Verify the stable runner contract",
      requiredEvidence: ["tests"],
      externalLink: {
        provider: "taskseal",
        externalId: "TS-1",
        url:
          "http://127.0.0.1:4317/work-items/TS-1"
      }
    }
  });

  return {
    directory,
    journal,
    service
  };
}

function validManifest() {
  return {
    schemaVersion: "1",
    runnerId: "fake-runner",
    displayName: "Fake runner",
    capabilities: {
      workspaceAccess: [
        "read-only",
        "workspace-write"
      ],
      cancellation: true,
      timeout: true,
      handoffKinds: []
    }
  };
}

function createClock(): () => Date {
  const values = [
    "2026-07-28T09:01:00.000Z",
    "2026-07-28T09:02:00.000Z"
  ];
  let index = 0;

  return () => {
    const value =
      values[index] ??
      values[values.length - 1];
    index += 1;
    assert.ok(value);
    return new Date(value);
  };
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error: unknown) =>
    isCodedError(error) &&
    error.code === code;
}

function isCodedError(
  value: unknown
): value is Error & { code: string } {
  return (
    value instanceof Error &&
    "code" in value &&
    typeof value.code === "string"
  );
}

function normalizeLifecycle(
  events: unknown[]
): unknown[] {
  return events.map((candidate) => {
    const event =
      candidate as CanonicalEvent;
    if (event.type === "attempt.started") {
      return {
        type: event.type,
        workItemId: event.workItemId,
        occurredAt: event.occurredAt,
        payload: {
          attemptId:
            event.payload.attemptId
        }
      };
    }

    if (event.type === "attempt.finished") {
      return {
        type: event.type,
        workItemId: event.workItemId,
        occurredAt: event.occurredAt,
        payload: event.payload
      };
    }

    return event;
  });
}
