import {
  ManagedAttemptRunner
} from "../application/managed-attempt-runner.ts";
import type {
  ManagedAttemptRunnerOptions,
  ManagedRunnerResult
} from "../application/managed-attempt-runner.ts";
import type {
  AttemptRunTerminalization
} from "../application/attempt-run-coordinator.ts";
import type {
  AttemptTerminalOutcome
} from "../domain/workflow.ts";
import {
  parseRunnerManifest,
  RunnerContractError,
  RunnerExecutionError
} from "./runner-contract.ts";
import {
  CodexAppServerError
} from "./codex-app-server-client.ts";
import type {
  DigitalEmployeeAdapter,
  RunnerExecutionContext,
  RunnerExecutionInput
} from "./runner-contract.ts";
import type {
  CodexApprovalPolicy,
  CodexSandbox
} from "./codex-app-server-client.ts";

interface CodexRunnerClientResult {
  outcome: AttemptTerminalOutcome;
  threadId?: string | undefined;
  turnId?: string | undefined;
  summary?: string | null | undefined;
}

interface CodexRunnerClientPort {
  runTurn(options: {
    cwd: string;
    prompt: string;
    sandbox:
      | "read-only"
      | "workspace-write";
    approvalPolicy: "never";
    signal?: AbortSignal | undefined;
  }): unknown | Promise<unknown>;
}

export const CODEX_APP_SERVER_RUNNER_MANIFEST =
  parseRunnerManifest({
    schemaVersion: "1",
    runnerId: "codex-app-server",
    displayName: "Codex App Server",
    capabilities: {
      workspaceAccess: [
        "read-only",
        "workspace-write"
      ],
      cancellation: true,
      timeout: true,
      handoffKinds: []
    }
  });

export interface CodexAppServerRunnerAdapterOptions {
  clientFactory: () => CodexRunnerClientPort;
}

export class CodexAppServerRunnerAdapter
  implements DigitalEmployeeAdapter
{
  readonly manifest =
    CODEX_APP_SERVER_RUNNER_MANIFEST;
  readonly clientFactory:
    () => CodexRunnerClientPort;

  constructor({
    clientFactory
  }: CodexAppServerRunnerAdapterOptions) {
    if (
      typeof clientFactory !== "function"
    ) {
      throw new TypeError(
        "Codex runner adapter requires a clientFactory."
      );
    }
    this.clientFactory = clientFactory;
  }

  async execute(
    input: RunnerExecutionInput,
    { signal }: RunnerExecutionContext
  ): Promise<unknown> {
    try {
      const result = decodeCodexClientResult(
        await this.clientFactory().runTurn({
          cwd: input.workspace.cwd,
          prompt: input.instruction,
          sandbox:
            input.workspace.access,
          approvalPolicy: "never",
          signal
        })
      );

      return {
        schemaVersion: "1",
        attemptId: input.attemptId,
        outcome: result.outcome,
        ...(result.summary === undefined
          ? {}
          : {
              summary:
                result.summary
            }),
        ...(result.threadId === undefined &&
        result.turnId === undefined
          ? {}
          : {
              runtimeRefs: {
                ...(result.threadId ===
                undefined
                  ? {}
                  : {
                      sessionId:
                        result.threadId
                    }),
                ...(result.turnId ===
                undefined
                  ? {}
                  : {
                      executionId:
                        result.turnId
                    })
              }
            })
      };
    } catch (error) {
      if (error instanceof RunnerExecutionError) {
        throw error;
      }
      if (error instanceof CodexAppServerError) {
        const cleanupFailed =
          error.code ===
          "CODEX_PROCESS_CLEANUP_FAILED";
        throw new RunnerExecutionError(
          cleanupFailed
            ? "RUNNER_PROCESS_CLEANUP_FAILED"
            : error.code,
          cleanupFailed
            ? "Runner process cleanup could not be confirmed."
            : error.message.slice(0, 2_000),
          { cause: error }
        );
      }
      throw error;
    }
  }
}

export interface CodexRunnerOptions
  extends Omit<
    ManagedAttemptRunnerOptions,
    "adapter"
  > {
  clientFactory: () => CodexRunnerClientPort;
}

export interface CodexRunnerRunOptions {
  workItemId: string;
  cwd?: string | undefined;
  prompt: string;
  sandbox?: CodexSandbox | undefined;
  approvalPolicy?:
    | CodexApprovalPolicy
    | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  terminalization?:
    | AttemptRunTerminalization
    | undefined;
}

export interface CodexRunnerResult
  extends CodexRunnerClientResult {
  attemptId: string;
}

export class CodexRunner {
  readonly managed: ManagedAttemptRunner;

  constructor({
    clientFactory,
    allowedWorkspaceAccess = [
      "read-only",
      "workspace-write"
    ],
    ...options
  }: CodexRunnerOptions) {
    this.managed =
      new ManagedAttemptRunner({
        ...options,
        allowedWorkspaceAccess,
        adapter:
          new CodexAppServerRunnerAdapter({
            clientFactory
          })
      });
  }

  async run({
    workItemId,
    cwd,
    prompt,
    sandbox = "workspace-write",
    approvalPolicy = "never",
    timeoutMs,
    signal,
    terminalization
  }: CodexRunnerRunOptions): Promise<CodexRunnerResult> {
    if (
      sandbox !== "read-only" &&
      sandbox !== "workspace-write"
    ) {
      throw new RunnerContractError(
        "RUNNER_CAPABILITY_MISSING",
        "Codex managed runner does not expose danger-full-access."
      );
    }

    if (approvalPolicy !== "never") {
      throw new RunnerContractError(
        "RUNNER_CAPABILITY_MISSING",
        "Codex managed runner fixes approval policy to never."
      );
    }

    const result =
      await this.managed.run({
        workItemId,
        ...(cwd === undefined
          ? {}
          : { cwd }),
        instruction: prompt,
        workspaceAccess: sandbox,
        ...(timeoutMs === undefined
          ? {}
          : { timeoutMs }),
        ...(signal === undefined
          ? {}
          : { signal }),
        ...(terminalization === undefined
          ? {}
          : {
              terminalization
            })
      });

    return toCodexRunnerResult(result);
  }
}

export {
  RunnerContractError as CodexRunnerError
};

function toCodexRunnerResult(
  result: ManagedRunnerResult
): CodexRunnerResult {
  return {
    attemptId: result.attemptId,
    outcome: result.outcome,
    ...(result.runtimeRefs?.sessionId
      ? {
          threadId:
            result.runtimeRefs.sessionId
        }
      : {}),
    ...(result.runtimeRefs?.executionId
      ? {
          turnId:
            result.runtimeRefs.executionId
        }
      : {}),
    ...(result.summary === undefined
      ? {}
      : {
          summary: result.summary
        })
  };
}

function decodeCodexClientResult(
  value: unknown
): CodexRunnerClientResult {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !==
      Object.prototype
  ) {
    throw invalidCodexResult();
  }

  const keys = Reflect.ownKeys(value);
  const allowedKeys = [
    "outcome",
    "threadId",
    "turnId",
    "summary"
  ];
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !allowedKeys.includes(key)
    ) ||
    !keys.includes("outcome")
  ) {
    throw invalidCodexResult();
  }

  const descriptors =
    Object.getOwnPropertyDescriptors(value);
  const readValue = (
    key: string
  ): unknown => {
    const descriptor =
      descriptors[key];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalidCodexResult();
    }
    return descriptor.value;
  };
  const outcome = readValue("outcome");
  const threadId = keys.includes("threadId")
    ? readValue("threadId")
    : undefined;
  const turnId = keys.includes("turnId")
    ? readValue("turnId")
    : undefined;
  const summary = keys.includes("summary")
    ? readValue("summary")
    : undefined;

  if (
    outcome !== "completed" &&
    outcome !== "failed" &&
    outcome !== "interrupted"
  ) {
    throw invalidCodexResult();
  }
  if (
    threadId !== undefined &&
    (typeof threadId !== "string" ||
      threadId.length === 0 ||
      threadId.length > 512)
  ) {
    throw invalidCodexResult();
  }
  if (
    turnId !== undefined &&
    (typeof turnId !== "string" ||
      turnId.length === 0 ||
      turnId.length > 512)
  ) {
    throw invalidCodexResult();
  }
  if (
    summary !== undefined &&
    summary !== null &&
    (typeof summary !== "string" ||
      summary.length === 0 ||
      summary.length > 2_000)
  ) {
    throw invalidCodexResult();
  }

  return {
    outcome,
    ...(threadId === undefined
      ? {}
      : { threadId }),
    ...(turnId === undefined
      ? {}
      : { turnId }),
    ...(summary === undefined
      ? {}
      : { summary })
  };
}

function invalidCodexResult(): RunnerExecutionError {
  return new RunnerExecutionError(
    "CODEX_PROTOCOL_ERROR",
    "Codex App Server returned an invalid run result."
  );
}
