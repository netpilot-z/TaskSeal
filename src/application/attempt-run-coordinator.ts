export type AttemptRunPhase =
  | "running"
  | "cancelling"
  | "terminalizing";

export interface AttemptRunTerminalizationDecision {
  readonly cancellationAccepted: boolean;
}

export interface AttemptRunTerminalization {
  begin(): AttemptRunTerminalizationDecision;
}

export interface AttemptRunExecutionContext {
  readonly signal: AbortSignal;
  readonly terminalization: AttemptRunTerminalization;
}

export interface AttemptRunView {
  readonly workItemId: string;
  readonly phase: AttemptRunPhase;
  readonly startedAt: string;
  readonly cancelRequestedAt: string | null;
}

export interface AttemptRunCoordinatorSnapshot {
  readonly maxConcurrentRuns: number;
  readonly activeCount: number;
  readonly availableSlots: number;
  readonly runs: AttemptRunView[];
}

export interface AttemptRunStartResult {
  readonly signal: AbortSignal;
  readonly execution: Promise<unknown>;
}

export interface AttemptRunCoordinatorOptions {
  readonly maxConcurrentRuns?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

interface ActiveAttemptRun {
  readonly workItemId: string;
  readonly controller: AbortController;
  readonly startedAt: string;
  phase: AttemptRunPhase;
  cancelRequestedAt: string | null;
  execution: Promise<unknown>;
}

type AttemptRunCoordinatorErrorCode =
  | "ATTEMPT_ALREADY_ACTIVE"
  | "RUN_CAPACITY_REACHED"
  | "RUN_CANCELLED"
  | "RUN_NOT_ACTIVE"
  | "RUN_TERMINALIZING"
  | "SERVER_SHUTTING_DOWN";

const MAX_CONCURRENT_RUNS_LIMIT = 8;

export class AttemptRunCoordinator {
  readonly maxConcurrentRuns: number;
  readonly now: () => Date;
  #activeRuns: Map<string, ActiveAttemptRun>;
  #acceptingRuns: boolean;
  #shutdownPromise: Promise<void> | null;

  constructor({
    maxConcurrentRuns = 1,
    now = () => new Date()
  }: AttemptRunCoordinatorOptions = {}) {
    if (
      !Number.isSafeInteger(maxConcurrentRuns) ||
      maxConcurrentRuns < 1 ||
      maxConcurrentRuns > MAX_CONCURRENT_RUNS_LIMIT
    ) {
      throw new TypeError(
        `TaskSeal maxConcurrentRuns must be between 1 and ${MAX_CONCURRENT_RUNS_LIMIT}.`
      );
    }

    if (typeof now !== "function") {
      throw new TypeError(
        "TaskSeal run coordinator requires a clock."
      );
    }

    this.maxConcurrentRuns = maxConcurrentRuns;
    this.now = now;
    this.#activeRuns = new Map();
    this.#acceptingRuns = true;
    this.#shutdownPromise = null;
  }

  start({
    workItemId,
    execute
  }: {
    workItemId: string;
    execute: (
      context: AttemptRunExecutionContext
    ) => unknown | Promise<unknown>;
  }): AttemptRunStartResult {
    if (!this.#acceptingRuns) {
      throw coordinatorError(
        "SERVER_SHUTTING_DOWN",
        "TaskSeal is shutting down and cannot accept new runs."
      );
    }

    if (
      typeof workItemId !== "string" ||
      workItemId.length === 0 ||
      typeof execute !== "function"
    ) {
      throw new TypeError(
        "TaskSeal run coordinator requires a work item and executor."
      );
    }

    if (this.#activeRuns.has(workItemId)) {
      throw coordinatorError(
        "ATTEMPT_ALREADY_ACTIVE",
        `TaskSeal work item ${workItemId} already has an active run.`
      );
    }

    if (
      this.#activeRuns.size >=
      this.maxConcurrentRuns
    ) {
      throw coordinatorError(
        "RUN_CAPACITY_REACHED",
        "TaskSeal has reached its active run capacity."
      );
    }

    const controller = new AbortController();
    const {
      promise: deferredExecution,
      resolve: resolveExecution,
      reject: rejectExecution
    } = Promise.withResolvers<unknown>();
    const entry: ActiveAttemptRun = {
      workItemId,
      controller,
      phase: "running",
      startedAt: this.now().toISOString(),
      cancelRequestedAt: null,
      execution: deferredExecution
    };
    entry.execution = deferredExecution.finally(() => {
      this.release(entry);
    });
    this.#activeRuns.set(workItemId, entry);

    try {
      const result = execute({
        signal: controller.signal,
        terminalization: {
          begin: () =>
            this.beginTerminalization(entry)
        }
      });
      void Promise.resolve(result).then(
        resolveExecution,
        rejectExecution
      );
    } catch (error) {
      rejectExecution(error);
    }

    return {
      signal: controller.signal,
      execution: entry.execution
    };
  }

  cancel(workItemId: string): AttemptRunView {
    const entry = this.#activeRuns.get(workItemId);

    if (!entry) {
      throw coordinatorError(
        "RUN_NOT_ACTIVE",
        `TaskSeal work item ${workItemId} does not have an active run.`
      );
    }

    if (
      entry.phase === "terminalizing" &&
      entry.cancelRequestedAt === null
    ) {
      throw coordinatorError(
        "RUN_TERMINALIZING",
        `TaskSeal work item ${workItemId} is committing its terminal outcome and can no longer be cancelled.`
      );
    }

    if (entry.phase === "running") {
      entry.phase = "cancelling";
      entry.cancelRequestedAt =
        this.now().toISOString();
      entry.controller.abort(
        coordinatorError(
          "RUN_CANCELLED",
          "TaskSeal operator cancelled the active run."
        )
      );
    }

    return projectRun(entry);
  }

  snapshot(): AttemptRunCoordinatorSnapshot {
    const runs = [...this.#activeRuns.values()]
      .map(projectRun)
      .sort(
        (left, right) =>
          Date.parse(left.startedAt) -
            Date.parse(right.startedAt) ||
          left.workItemId.localeCompare(right.workItemId)
      );

    return {
      maxConcurrentRuns: this.maxConcurrentRuns,
      activeCount: runs.length,
      availableSlots:
        this.maxConcurrentRuns - runs.length,
      runs
    };
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) {
      return this.#shutdownPromise;
    }

    this.#acceptingRuns = false;
    const entries = [...this.#activeRuns.values()];

    for (const entry of entries) {
      if (entry.phase === "running") {
        entry.phase = "cancelling";
        entry.cancelRequestedAt =
          this.now().toISOString();
        entry.controller.abort(
          coordinatorError(
            "SERVER_SHUTTING_DOWN",
            "TaskSeal interrupted the run during shutdown."
          )
        );
      }
    }

    this.#shutdownPromise = Promise.allSettled(
      entries.map((entry) => entry.execution)
    ).then(() => undefined);
    return this.#shutdownPromise;
  }

  private beginTerminalization(
    entry: ActiveAttemptRun
  ): AttemptRunTerminalizationDecision {
    if (
      this.#activeRuns.get(entry.workItemId) !==
      entry
    ) {
      throw coordinatorError(
        "RUN_NOT_ACTIVE",
        `TaskSeal work item ${entry.workItemId} does not have an active run.`
      );
    }

    entry.phase = "terminalizing";
    return {
      cancellationAccepted:
        entry.cancelRequestedAt !== null
    };
  }

  private release(entry: ActiveAttemptRun): void {
    if (
      this.#activeRuns.get(entry.workItemId) ===
      entry
    ) {
      this.#activeRuns.delete(entry.workItemId);
    }
  }
}

export class AttemptRunCoordinatorError extends Error {
  readonly code: AttemptRunCoordinatorErrorCode;

  constructor(
    code: AttemptRunCoordinatorErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AttemptRunCoordinatorError";
    this.code = code;
  }
}

function projectRun(
  entry: ActiveAttemptRun
): AttemptRunView {
  return {
    workItemId: entry.workItemId,
    phase: entry.phase,
    startedAt: entry.startedAt,
    cancelRequestedAt:
      entry.cancelRequestedAt
  };
}

function coordinatorError(
  code: AttemptRunCoordinatorErrorCode,
  message: string
): AttemptRunCoordinatorError {
  return new AttemptRunCoordinatorError(
    code,
    message
  );
}
