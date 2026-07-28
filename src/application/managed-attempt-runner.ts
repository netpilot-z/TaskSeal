import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve
} from "node:path";

import type {
  AttemptFinishedEvent,
  AttemptStartedEvent,
  AttemptTerminalOutcome,
  WorkItem
} from "../domain/workflow.ts";
import {
  parseRunnerExecutionInput,
  parseRunnerExecutionOutput,
  parseRunnerManifest,
  RunnerContractError,
  RunnerExecutionError
} from "../runners/runner-contract.ts";
import type {
  DigitalEmployeeAdapter,
  RunnerCapabilityManifest,
  RunnerExecutionInput,
  RunnerHandoffClaim,
  RunnerRuntimeReferences,
  RunnerWorkspaceAccess
} from "../runners/runner-contract.ts";
import type {
  AttemptRunTerminalization
} from "./attempt-run-coordinator.ts";

const DEFAULT_TIMEOUT_MS =
  10 * 60 * 1_000;
const MAX_TIMEOUT_MS =
  24 * 60 * 60 * 1_000;
const DEFAULT_CLEANUP_GRACE_MS = 5_000;
const MAX_CLEANUP_GRACE_MS = 60_000;

interface ManagedAttemptServicePort {
  getWorkItem(
    workItemId: string
  ): WorkItem | null;
  startAttemptIfIdle(
    event: AttemptStartedEvent
  ): Promise<unknown>;
  append(
    event: AttemptFinishedEvent
  ): Promise<unknown>;
}

export interface ManagedAttemptRunnerOptions {
  service: ManagedAttemptServicePort;
  projectRoot: string;
  adapter: DigitalEmployeeAdapter;
  idFactory?: (() => string) | undefined;
  now?: (() => Date) | undefined;
  defaultTimeoutMs?: number | undefined;
  cleanupGraceMs?: number | undefined;
  allowedWorkspaceAccess?:
    | readonly RunnerWorkspaceAccess[]
    | undefined;
}

export interface ManagedRunnerRunOptions {
  workItemId: string;
  cwd?: string | undefined;
  instruction: string;
  workspaceAccess?:
    | RunnerWorkspaceAccess
    | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  terminalization?:
    | AttemptRunTerminalization
    | undefined;
}

export interface ManagedRunnerResult {
  attemptId: string;
  outcome: AttemptTerminalOutcome;
  summary?: string | null | undefined;
  runtimeRefs?:
    | RunnerRuntimeReferences
    | undefined;
  handoffClaims:
    readonly RunnerHandoffClaim[];
}

interface ExecutionDeadline {
  signal: AbortSignal;
  timeout: Promise<never>;
  cancellation: Promise<void>;
  timeoutError: RunnerContractError;
  didExpire(): boolean;
  dispose(): void;
}

interface TerminalizationSelection {
  begin(): boolean;
}

export class ManagedAttemptRunner {
  readonly service: ManagedAttemptServicePort;
  readonly projectRoot: string;
  readonly adapter: DigitalEmployeeAdapter;
  readonly manifest: RunnerCapabilityManifest;
  readonly idFactory: () => string;
  readonly now: () => Date;
  readonly defaultTimeoutMs: number;
  readonly cleanupGraceMs: number;
  readonly allowedWorkspaceAccess:
    readonly RunnerWorkspaceAccess[];
  #cleanupFailure: unknown;

  constructor({
    service,
    projectRoot,
    adapter,
    idFactory = () => randomUUID(),
    now = () => new Date(),
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    cleanupGraceMs =
      DEFAULT_CLEANUP_GRACE_MS,
    allowedWorkspaceAccess = [
      "read-only"
    ]
  }: ManagedAttemptRunnerOptions) {
    if (
      !service ||
      typeof service.getWorkItem !==
        "function" ||
      typeof service.append !== "function" ||
      typeof service.startAttemptIfIdle !==
        "function"
    ) {
      throw new TypeError(
        "Managed runner requires a TaskSeal service."
      );
    }

    if (
      !adapter ||
      typeof adapter.execute !== "function"
    ) {
      throw new TypeError(
        "Managed runner requires a digital employee adapter."
      );
    }

    this.service = service;
    this.projectRoot = resolve(projectRoot);
    this.adapter = adapter;
    this.manifest = parseRunnerManifest(
      adapter.manifest
    );
    this.idFactory = idFactory;
    this.now = now;
    this.defaultTimeoutMs = readTimeoutMs(
      defaultTimeoutMs
    );
    this.cleanupGraceMs =
      readCleanupGraceMs(
        cleanupGraceMs
      );
    this.allowedWorkspaceAccess =
      readAllowedWorkspaceAccess(
        allowedWorkspaceAccess
      );
    this.#cleanupFailure = null;
  }

  async run({
    workItemId,
    cwd = this.projectRoot,
    instruction,
    workspaceAccess = "read-only",
    timeoutMs = this.defaultTimeoutMs,
    signal,
    terminalization
  }: ManagedRunnerRunOptions): Promise<ManagedRunnerResult> {
    if (this.#cleanupFailure !== null) {
      throw new RunnerContractError(
        "RUNNER_CLEANUP_FENCED",
        "Runner host is fenced after an unconfirmed cleanup; recreate the runtime before dispatching more work.",
        {
          cause: this.#cleanupFailure
        }
      );
    }

    const workItem =
      this.service.getWorkItem(workItemId);

    if (!workItem) {
      throw new RunnerContractError(
        "WORK_ITEM_NOT_FOUND",
        `TaskSeal work item ${workItemId} does not exist.`
      );
    }

    const activeAttempt =
      workItem.attempts.find(
        (attempt) =>
          attempt.id ===
            workItem.activeAttemptId &&
          attempt.status === "running"
      );

    if (activeAttempt) {
      throw new RunnerContractError(
        "ATTEMPT_ALREADY_ACTIVE",
        `TaskSeal work item ${workItemId} already has an active attempt.`
      );
    }

    if (
      !this.allowedWorkspaceAccess.includes(
        workspaceAccess
      )
    ) {
      throw new RunnerContractError(
        "RUNNER_PERMISSION_DENIED",
        `Runner Host policy does not authorize ${workspaceAccess} workspace access.`
      );
    }

    if (
      !this.manifest.capabilities.workspaceAccess.includes(
        workspaceAccess
      )
    ) {
      throw new RunnerContractError(
        "RUNNER_CAPABILITY_MISSING",
        `Runner ${this.manifest.runnerId} does not support ${workspaceAccess} workspace access.`
      );
    }

    const boundedTimeoutMs =
      readTimeoutMs(timeoutMs);
    const runCwd =
      await resolvePathWithinProject(
        this.projectRoot,
        resolve(cwd)
      );
    const attemptId = this.idFactory();
    const startedAt =
      this.now().toISOString();
    const input =
      parseRunnerExecutionInput({
        schemaVersion: "1",
        attemptId,
        workItemId,
        instruction,
        workspace: {
          root: this.projectRoot,
          cwd: runCwd,
          access: workspaceAccess
        },
        deadlineAt: new Date(
          Date.parse(startedAt) +
            boundedTimeoutMs
        ).toISOString()
      });

    await this.service.startAttemptIfIdle({
      eventId: createRunnerEventId({
        runnerId:
          this.manifest.runnerId,
        attemptId,
        phase: "started"
      }),
      workItemId,
      type: "attempt.started",
      occurredAt: startedAt,
      payload: {
        attemptId,
        agentId:
          this.manifest.runnerId
      }
    });

    const terminalizationSelection =
      createTerminalizationSelection({
        signal,
        terminalization
      });
    const deadline =
      createExecutionDeadline({
        parentSignal: signal,
        timeoutMs: boundedTimeoutMs,
        onExpire: () => {
          terminalizationSelection.begin();
        }
      });

    try {
      let output;
      try {
        output =
          await executeAndDecode({
            adapter: this.adapter,
            manifest: this.manifest,
            input,
            deadline,
            beginTerminalization: () =>
              terminalizationSelection.begin(),
            cleanupGraceMs:
              this.cleanupGraceMs
          });
      } catch (caughtError) {
        const cancellationAccepted =
          terminalizationSelection.begin();
        const error = caughtError;
        const cleanupFailed =
          isCleanupFailure(error);
        if (cleanupFailed) {
          this.#cleanupFailure = error;
        }
        const outcome:
          AttemptTerminalOutcome =
          cancellationAccepted
            ? "interrupted"
            : "failed";
        const summary =
          cancellationAccepted
            ? boundedInterruptionMessage(
                signal
              )
            : safeFailureSummary(error);

        await this.service.append(
          createFinishedEvent({
            runnerId:
              this.manifest.runnerId,
            attemptId,
            workItemId,
            occurredAt:
              this.now().toISOString(),
            outcome,
            summary
          })
        );

        if (
          cancellationAccepted &&
          !cleanupFailed
        ) {
          return {
            attemptId,
            outcome,
            summary,
            handoffClaims: []
          };
        }

        throw error;
      }

      const cancellationAccepted =
        terminalizationSelection.begin();
      const terminalResult:
        ManagedRunnerResult =
        cancellationAccepted
          ? {
              attemptId,
              outcome: "interrupted",
              summary:
                boundedInterruptionMessage(
                  signal
                ),
              handoffClaims: []
            }
          : {
              attemptId,
              outcome: output.outcome,
              ...(output.summary ===
              undefined
                ? {}
                : {
                    summary:
                      output.summary
                  }),
              ...(output.runtimeRefs ===
              undefined
                ? {}
                : {
                    runtimeRefs:
                      output.runtimeRefs
                  }),
              handoffClaims: [
                ...(output.handoffClaims ??
                  [])
              ]
            };

      await this.service.append(
        createFinishedEvent({
          runnerId:
            this.manifest.runnerId,
          workItemId,
          occurredAt:
            this.now().toISOString(),
          ...terminalResult
        })
      );
      return terminalResult;
    } finally {
      deadline.dispose();
    }
  }
}

async function executeAndDecode({
  adapter,
  manifest,
  input,
  deadline,
  beginTerminalization,
  cleanupGraceMs
}: {
  adapter: DigitalEmployeeAdapter;
  manifest: RunnerCapabilityManifest;
  input: RunnerExecutionInput;
  deadline: ExecutionDeadline;
  beginTerminalization: () => boolean;
  cleanupGraceMs: number;
}) {
  const execution = Promise.resolve().then(
    () =>
      adapter.execute(input, {
        signal: deadline.signal
      })
  );
  let rawOutput: unknown;

  try {
    const controlled =
      await Promise.race([
        execution.then((value) => ({
          kind: "output" as const,
          value
        })),
        deadline.timeout,
        deadline.cancellation.then(
          () => ({
            kind: "cancelled" as const
          })
        )
      ]);
    beginTerminalization();

    if (controlled.kind === "cancelled") {
      const settlement =
        await waitForExecutionSettlement(
          execution,
          cleanupGraceMs
        );
      if (
        settlement.status ===
        "timed-out"
      ) {
        throw new RunnerContractError(
          "RUNNER_PROCESS_CLEANUP_FAILED",
          "Runner process cleanup could not be confirmed within the bounded cleanup window."
        );
      }
      if (
        settlement.status ===
          "rejected" &&
        isCleanupFailure(
          settlement.reason
        )
      ) {
        throw settlement.reason;
      }

      throw new RunnerContractError(
        "RUNNER_CANCELLED",
        "Runner execution was cancelled."
      );
    }

    rawOutput = controlled.value;
  } catch (error) {
    beginTerminalization();
    if (
      isCleanupFailure(error) ||
      (error instanceof
        RunnerContractError &&
        error.code ===
          "RUNNER_CANCELLED")
    ) {
      throw error;
    }

    if (!deadline.didExpire()) {
      throw error;
    }

    const settlement =
      await waitForExecutionSettlement(
        execution,
        cleanupGraceMs
      );
    if (
      settlement.status === "timed-out"
    ) {
      throw new RunnerContractError(
        "RUNNER_PROCESS_CLEANUP_FAILED",
        "Runner process cleanup could not be confirmed within the bounded cleanup window."
      );
    }
    if (
      settlement.status === "rejected" &&
      isCleanupFailure(
        settlement.reason
      )
    ) {
      throw settlement.reason;
    }

    throw deadline.timeoutError;
  }

  return parseRunnerExecutionOutput(
    rawOutput,
    {
      manifest,
      expectedAttemptId: input.attemptId
    }
  );
}

function createExecutionDeadline({
  parentSignal,
  timeoutMs,
  onExpire
}: {
  parentSignal: AbortSignal | undefined;
  timeoutMs: number;
  onExpire: () => void;
}): ExecutionDeadline {
  const controller =
    new AbortController();
  const timeoutError =
    new RunnerContractError(
      "RUNNER_TIMEOUT",
      "Runner exceeded its execution deadline."
    );
  let expired = false;
  let rejectTimeout:
    | ((reason?: unknown) => void)
    | undefined;
  const timeout =
    new Promise<never>(
      (_resolve, reject) => {
        rejectTimeout = reject;
      }
    );
  timeout.catch(() => undefined);
  let resolveCancellation:
    | (() => void)
    | undefined;
  const cancellation =
    new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
  const expire = () => {
    expired = true;
    onExpire();
    if (!controller.signal.aborted) {
      controller.abort(timeoutError);
    }
    rejectTimeout?.(timeoutError);
  };
  const timer = setTimeout(
    expire,
    timeoutMs
  );
  const forwardAbort = () => {
    resolveCancellation?.();
    if (!controller.signal.aborted) {
      controller.abort(
        parentSignal?.reason
      );
    }
  };

  if (parentSignal?.aborted) {
    forwardAbort();
  } else {
    parentSignal?.addEventListener(
      "abort",
      forwardAbort,
      { once: true }
    );
  }

  return {
    signal: controller.signal,
    timeout,
    cancellation,
    timeoutError,
    didExpire: () => expired,
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener(
        "abort",
        forwardAbort
      );
    }
  };
}

type ExecutionSettlement =
  | {
      status: "fulfilled";
      value: unknown;
    }
  | {
      status: "rejected";
      reason: unknown;
    }
  | {
      status: "timed-out";
    };

async function waitForExecutionSettlement(
  execution: Promise<unknown>,
  cleanupGraceMs: number
): Promise<ExecutionSettlement> {
  const settlement:
    Promise<ExecutionSettlement> =
    execution.then(
      (value): ExecutionSettlement => ({
        status: "fulfilled",
        value
      }),
      (reason): ExecutionSettlement => ({
        status: "rejected",
        reason
      })
    );

  return new Promise<ExecutionSettlement>(
    (resolveSettlement) => {
      let settled = false;
      const finish = (
        result: ExecutionSettlement
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolveSettlement(result);
      };
      const timer = setTimeout(
        () =>
          finish({
            status: "timed-out"
          }),
        cleanupGraceMs
      );
      settlement.then(finish);
    }
  );
}

function createFinishedEvent({
  runnerId,
  attemptId,
  workItemId,
  occurredAt,
  outcome,
  summary,
  runtimeRefs
}: {
  runnerId: string;
  attemptId: string;
  workItemId: string;
  occurredAt: string;
  outcome: AttemptTerminalOutcome;
  summary?: string | null | undefined;
  runtimeRefs?:
    | RunnerRuntimeReferences
    | undefined;
}): AttemptFinishedEvent {
  return {
    eventId: createRunnerEventId({
      runnerId,
      attemptId,
      phase: "finished"
    }),
    workItemId,
    type: "attempt.finished",
    occurredAt,
    payload: {
      attemptId,
      outcome,
      ...(runtimeRefs?.sessionId
        ? {
            threadId:
              runtimeRefs.sessionId
          }
        : {}),
      ...(runtimeRefs?.executionId
        ? {
            turnId:
              runtimeRefs.executionId
          }
        : {}),
      ...(summary
        ? {
            summary
          }
        : {})
    }
  };
}

function createRunnerEventId({
  runnerId,
  attemptId,
  phase
}: {
  runnerId: string;
  attemptId: string;
  phase: "started" | "finished";
}): string {
  return `runner:${runnerId}:${attemptId}:${phase}`;
}

async function resolvePathWithinProject(
  projectRoot: string,
  candidate: string
): Promise<string> {
  assertLexicalPathWithinProject(
    projectRoot,
    candidate
  );

  let canonicalProjectRoot: string;
  let canonicalCandidate: string;

  try {
    [
      canonicalProjectRoot,
      canonicalCandidate
    ] = await Promise.all([
      realpath(projectRoot),
      realpath(candidate)
    ]);
  } catch (error) {
    throw new RunnerContractError(
      "RUNNER_CWD_UNAVAILABLE",
      "Managed runner could not resolve its project root or cwd.",
      { cause: error }
    );
  }

  assertLexicalPathWithinProject(
    canonicalProjectRoot,
    canonicalCandidate
  );
  return canonicalCandidate;
}

function assertLexicalPathWithinProject(
  projectRoot: string,
  candidate: string
): void {
  const pathFromRoot = relative(
    projectRoot,
    candidate
  );

  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(
      `..${
        process.platform === "win32"
          ? "\\"
          : "/"
      }`
    ) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new RunnerContractError(
      "RUNNER_CWD_OUTSIDE_PROJECT",
      "Managed runner cwd must stay inside the TaskSeal project root."
    );
  }
}

function readTimeoutMs(
  value: number
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TIMEOUT_MS
  ) {
    throw new RunnerContractError(
      "RUNNER_INPUT_INVALID",
      "Runner timeoutMs must be an integer between 1 and 86400000."
    );
  }
  return value;
}

function readCleanupGraceMs(
  value: number
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_CLEANUP_GRACE_MS
  ) {
    throw new RunnerContractError(
      "RUNNER_INPUT_INVALID",
      "Runner cleanupGraceMs must be an integer between 1 and 60000."
    );
  }
  return value;
}

function readAllowedWorkspaceAccess(
  value: readonly RunnerWorkspaceAccess[]
): readonly RunnerWorkspaceAccess[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !==
      Array.prototype ||
    value.length === 0 ||
    value.length > 2
  ) {
    throw new RunnerContractError(
      "RUNNER_INPUT_INVALID",
      "Runner Host allowedWorkspaceAccess must contain one or two workspace access values."
    );
  }

  const result:
    RunnerWorkspaceAccess[] = [];
  for (const access of value) {
    if (
      (access !== "read-only" &&
        access !== "workspace-write") ||
      result.includes(access)
    ) {
      throw new RunnerContractError(
        "RUNNER_INPUT_INVALID",
        "Runner Host allowedWorkspaceAccess contains unsupported or duplicate values."
      );
    }
    result.push(access);
  }
  return Object.freeze(result);
}

function beginTerminalization({
  signal,
  terminalization
}: {
  signal: AbortSignal | undefined;
  terminalization:
    | AttemptRunTerminalization
    | undefined;
}): boolean {
  const decision =
    terminalization?.begin();
  return (
    decision?.cancellationAccepted ===
      true ||
    signal?.aborted === true
  );
}

function createTerminalizationSelection({
  signal,
  terminalization
}: {
  signal: AbortSignal | undefined;
  terminalization:
    | AttemptRunTerminalization
    | undefined;
}): TerminalizationSelection {
  let cancellationAccepted:
    | boolean
    | undefined;

  return {
    begin() {
      if (
        cancellationAccepted ===
        undefined
      ) {
        cancellationAccepted =
          beginTerminalization({
            signal,
            terminalization
          });
      }
      return cancellationAccepted;
    }
  };
}

function boundedInterruptionMessage(
  signal: AbortSignal | undefined
): string {
  const reason = signal?.reason;
  if (
    reason instanceof Error &&
    reason.message.length > 0
  ) {
    return reason.message.slice(0, 2_000);
  }
  if (
    typeof reason === "string" &&
    reason.length > 0
  ) {
    return reason.slice(0, 2_000);
  }

  return "Runner execution was interrupted.";
}

function safeFailureSummary(
  error: unknown
): string {
  if (error instanceof RunnerExecutionError) {
    return error.publicSummary;
  }

  if (
    error instanceof RunnerContractError &&
    error.code === "RUNNER_TIMEOUT"
  ) {
    return "Runner exceeded its execution deadline.";
  }

  if (
    error instanceof RunnerContractError &&
    error.code ===
      "RUNNER_OUTPUT_INVALID"
  ) {
    return "Runner returned an invalid output envelope.";
  }

  if (
    error instanceof RunnerContractError &&
    error.code ===
      "RUNNER_PROCESS_CLEANUP_FAILED"
  ) {
    return "Runner process cleanup could not be confirmed.";
  }

  return "Runner execution failed.";
}

function isCleanupFailure(
  error: unknown
): error is
  | RunnerContractError
  | RunnerExecutionError {
  return (
    (error instanceof
      RunnerContractError ||
      error instanceof
        RunnerExecutionError) &&
    error.code ===
      "RUNNER_PROCESS_CLEANUP_FAILED"
  );
}
