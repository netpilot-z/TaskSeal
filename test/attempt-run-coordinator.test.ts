import assert from "node:assert/strict";
import test from "node:test";

import {
  AttemptRunCoordinator,
  AttemptRunCoordinatorError
} from "../src/application/attempt-run-coordinator.ts";

test("coordinator bounds distinct work items and releases capacity only after settlement", async () => {
  const releases = new Map<string, () => void>();
  const calls: string[] = [];
  const coordinator = new AttemptRunCoordinator({
    maxConcurrentRuns: 2,
    now: createClock()
  });
  const execute = (workItemId: string) => () => {
    calls.push(workItemId);
    return new Promise<void>((resolve) => {
      releases.set(workItemId, resolve);
    });
  };

  const first = coordinator.start({
    workItemId: "TS-1",
    execute: execute("TS-1")
  });
  const second = coordinator.start({
    workItemId: "TS-2",
    execute: execute("TS-2")
  });

  assert.throws(
    () =>
      coordinator.start({
        workItemId: "TS-3",
        execute: execute("TS-3")
      }),
    hasCode("RUN_CAPACITY_REACHED")
  );
  assert.deepEqual(calls, ["TS-1", "TS-2"]);
  assert.deepEqual(coordinator.snapshot(), {
    maxConcurrentRuns: 2,
    activeCount: 2,
    availableSlots: 0,
    runs: [
      {
        workItemId: "TS-1",
        phase: "running",
        startedAt: "2026-07-28T09:00:00.000Z",
        cancelRequestedAt: null
      },
      {
        workItemId: "TS-2",
        phase: "running",
        startedAt: "2026-07-28T09:01:00.000Z",
        cancelRequestedAt: null
      }
    ]
  });

  releases.get("TS-1")?.();
  await first.execution;
  assert.equal(coordinator.snapshot().availableSlots, 1);

  const third = coordinator.start({
    workItemId: "TS-3",
    execute: execute("TS-3")
  });
  assert.deepEqual(calls, ["TS-1", "TS-2", "TS-3"]);

  releases.get("TS-2")?.();
  releases.get("TS-3")?.();
  await Promise.all([second.execution, third.execution]);
  assert.equal(coordinator.snapshot().activeCount, 0);
});

test("coordinator rejects a duplicate work item without invoking it", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let duplicateCalls = 0;
  const coordinator = new AttemptRunCoordinator({
    maxConcurrentRuns: 2
  });
  const first = coordinator.start({
    workItemId: "TS-1",
    execute: async () => gate
  });

  assert.throws(
    () =>
      coordinator.start({
        workItemId: "TS-1",
        execute: async () => {
          duplicateCalls += 1;
        }
      }),
    hasCode("ATTEMPT_ALREADY_ACTIVE")
  );
  assert.equal(duplicateCalls, 0);

  release();
  await first.execution;
});

test("cancel targets one run, remains visible while settling, and is idempotent", async () => {
  const aborted: string[] = [];
  let releaseCancelled = (): void => {};
  let releaseOther = (): void => {};
  const cancelledGate = new Promise<void>((resolve) => {
    releaseCancelled = resolve;
  });
  const otherGate = new Promise<void>((resolve) => {
    releaseOther = resolve;
  });
  const coordinator = new AttemptRunCoordinator({
    maxConcurrentRuns: 2,
    now: createClock()
  });
  const first = coordinator.start({
    workItemId: "TS-1",
    execute: ({ signal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted.push("TS-1");
            cancelledGate.then(resolve);
          },
          { once: true }
        );
      })
  });
  const second = coordinator.start({
    workItemId: "TS-2",
    execute: ({ signal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => aborted.push("TS-2"),
          { once: true }
        );
        otherGate.then(resolve);
      })
  });

  const cancelled = coordinator.cancel("TS-1");
  const repeated = coordinator.cancel("TS-1");

  assert.equal(cancelled.phase, "cancelling");
  assert.deepEqual(repeated, cancelled);
  assert.deepEqual(aborted, ["TS-1"]);
  assert.deepEqual(
    coordinator.snapshot().runs.map((run) => [
      run.workItemId,
      run.phase
    ]),
    [
      ["TS-1", "cancelling"],
      ["TS-2", "running"]
    ]
  );
  assert.throws(
    () =>
      coordinator.start({
        workItemId: "TS-1",
        execute: async () => {}
      }),
    hasCode("ATTEMPT_ALREADY_ACTIVE")
  );

  releaseCancelled();
  await first.execution;
  assert.equal(
    coordinator.snapshot().runs.some(
      (run) => run.workItemId === "TS-1"
    ),
    false
  );

  releaseOther();
  await second.execution;
});

test("terminalization fences a late cancellation before the terminal write settles", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const terminalizationRef: {
    begin?: () => {
      readonly cancellationAccepted: boolean;
    };
  } = {};
  const coordinator = new AttemptRunCoordinator();
  const run = coordinator.start({
    workItemId: "TS-1",
    execute: ({ terminalization }) => {
      terminalizationRef.begin = () =>
        terminalization.begin();
      return gate;
    }
  });

  assert.ok(terminalizationRef.begin);
  assert.deepEqual(terminalizationRef.begin(), {
    cancellationAccepted: false
  });
  assert.equal(
    coordinator.snapshot().runs[0]?.phase,
    "terminalizing"
  );
  assert.throws(
    () => coordinator.cancel("TS-1"),
    hasCode("RUN_TERMINALIZING")
  );

  release();
  await run.execution;
});

test("terminalization preserves an already accepted cancellation", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const terminalizationRef: {
    begin?: () => {
      readonly cancellationAccepted: boolean;
    };
  } = {};
  const coordinator = new AttemptRunCoordinator();
  const run = coordinator.start({
    workItemId: "TS-1",
    execute: ({ terminalization }) => {
      terminalizationRef.begin = () =>
        terminalization.begin();
      return gate;
    }
  });

  coordinator.cancel("TS-1");
  assert.ok(terminalizationRef.begin);
  assert.deepEqual(terminalizationRef.begin(), {
    cancellationAccepted: true
  });
  assert.equal(
    coordinator.cancel("TS-1").phase,
    "terminalizing"
  );

  release();
  await run.execution;
});

test("cancel rejects an inactive work item and shutdown fences new work", async () => {
  const coordinator = new AttemptRunCoordinator();

  assert.throws(
    () => coordinator.cancel("TS-404"),
    hasCode("RUN_NOT_ACTIVE")
  );

  await coordinator.shutdown();

  assert.throws(
    () =>
      coordinator.start({
        workItemId: "TS-1",
        execute: async () => {}
      }),
    hasCode("SERVER_SHUTTING_DOWN")
  );
});

test("shutdown waits when an executor re-enters it synchronously", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const shutdownRef: {
    promise?: Promise<void>;
  } = {};
  let shutdownSettled = false;
  const coordinator = new AttemptRunCoordinator();
  const run = coordinator.start({
    workItemId: "TS-1",
    execute: () => {
      shutdownRef.promise =
        coordinator.shutdown();
      void shutdownRef.promise.then(() => {
        shutdownSettled = true;
      });
      return gate;
    }
  });

  assert.ok(shutdownRef.promise);
  const settledBeforeExecutor = await Promise.race([
    shutdownRef.promise.then(() => true),
    new Promise<false>((resolve) =>
      setImmediate(() => resolve(false))
    )
  ]);
  assert.equal(settledBeforeExecutor, false);
  assert.equal(shutdownSettled, false);
  assert.equal(
    coordinator.snapshot().activeCount,
    1
  );

  release();
  await run.execution;
  await shutdownRef.promise;
  assert.equal(shutdownSettled, true);
  assert.equal(
    coordinator.snapshot().activeCount,
    0
  );
});

test("shutdown aborts all runs and waits for their terminal work", async () => {
  const terminalWrites: string[] = [];
  const coordinator = new AttemptRunCoordinator({
    maxConcurrentRuns: 2
  });
  const start = (workItemId: string) =>
    coordinator.start({
      workItemId,
      execute: ({ signal }) =>
        new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              setImmediate(() => {
                terminalWrites.push(workItemId);
                resolve();
              });
            },
            { once: true }
          );
        })
    });

  start("TS-1");
  start("TS-2");
  await coordinator.shutdown();

  assert.deepEqual(terminalWrites.sort(), ["TS-1", "TS-2"]);
  assert.equal(coordinator.snapshot().activeCount, 0);
});

test("coordinator validates its concurrency boundary", () => {
  for (const maxConcurrentRuns of [
    0,
    -1,
    1.5,
    9,
    Number.NaN
  ]) {
    assert.throws(
      () =>
        new AttemptRunCoordinator({
          maxConcurrentRuns
        }),
      /between 1 and 8/
    );
  }
});

function createClock(): () => Date {
  const values = [
    "2026-07-28T09:00:00.000Z",
    "2026-07-28T09:01:00.000Z",
    "2026-07-28T09:02:00.000Z",
    "2026-07-28T09:03:00.000Z"
  ];
  let index = 0;

  return () => {
    const value = values[index] ?? values.at(-1);
    index += 1;
    assert.ok(value);
    return new Date(value);
  };
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error) =>
    error instanceof AttemptRunCoordinatorError &&
    error.code === code;
}
