#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  inspectGiteeHealthProvider,
  inspectGiteeProvider,
  inspectGitHubIssueProvider,
  inspectGitHubProvider,
  inspectLinearProvider
} from "./application/provider-inspection.ts";
import { createLinearTicketDryRun } from "./application/linear-ticket-dry-run.ts";
import {
  configuredTargetForProvider,
  fallbackConfiguredTarget,
  projectProviderConfiguration,
  ProviderObservationCoordinator
} from "./application/provider-observation-coordinator.ts";
import {
  projectProviderFailure,
  ProviderObservationReadModel
} from "./application/provider-observation.ts";
import {
  ProviderOperationJournal
} from "./application/provider-operation-journal.ts";
import {
  ProviderSyncProjectionQuery
} from "./application/provider-sync-projection.ts";
import {
  ObservedSnapshotImportFacade
} from "./application/observed-snapshot-import.ts";
import {
  DEFAULT_PROVIDER_INGRESS_REGISTRY
} from "./application/provider-ingress-registry.ts";
import {
  ManagedAttemptRunner
} from "./application/managed-attempt-runner.ts";
import {
  createLocalDecompositionControl
} from "./decomposition-runtime.ts";
import { TaskSealService } from "./application/taskseal-service.ts";
import {
  readProjectConfiguration
} from "./config/project-config.ts";
import type {
  ProjectConfiguration
} from "./config/project-config.ts";
import {
  isGiteeIssueReference
} from "./connectors/gitee-read-client.ts";
import { isLinearIssueReference } from "./connectors/linear.ts";
import { CodexAppServerClient } from "./runners/codex-app-server-client.ts";
import {
  CodexAppServerRunnerAdapter
} from "./runners/codex-runner.ts";
import { createTaskSealServer } from "./server.ts";
import { FileEventJournal } from "./storage/event-journal.ts";
import {
  FileProviderObservationStorage
} from "./storage/provider-observation-store.ts";
import {
  FileProviderOperationJournalStorage
} from "./storage/provider-operation-journal.ts";
import type {
  ManagedField,
  WorkItem,
  WorkItemCreatedEvent
} from "./domain/workflow.ts";
import type {
  CodexAppServerInvocation
} from "./runners/codex-app-server-client.ts";
import type {
  ManagedRunnerResult,
  ManagedRunnerRunOptions
} from "./application/managed-attempt-runner.ts";
import type {
  PersistentAcceptancePort,
  PersistentDecompositionControlPort,
  PersistentServicePort,
  RunWorkItemOptions
} from "./server.ts";
import type {
  ProviderObservationInput,
  ProviderObservationScope,
  ProviderObservationTarget,
  ProviderObservationQueryPort
} from "./application/provider-observation.ts";
import type {
  ProviderOperationJournalQueryPort
} from "./application/provider-operation-journal.ts";
import type {
  ProviderSyncQueryPort
} from "./application/provider-sync-projection.ts";
import type {
  SnapshotImportApplyPort
} from "./application/observed-snapshot-import.ts";
import type {
  ImportProvider
} from "./application/import-policy.ts";
import type {
  ProviderIngressRegistry
} from "./application/provider-ingress-registry.ts";
import type {
  ProviderName
} from "./lib/provider-snapshot.ts";
import {
  executeLocalLinearReadyWork
} from "./linear-ready-work-runtime.ts";
import type {
  LinearReadyWorkCommandOptions
} from "./linear-ready-work-runtime.ts";
import {
  executeLocalGitHubReconciliation
} from "./github-reconciliation-runtime.ts";
import type {
  GitHubReconciliationCommandOptions
} from "./github-reconciliation-runtime.ts";
import {
  createLocalLinearAcceptanceRuntime
} from "./linear-acceptance-runtime.ts";
import {
  checkTaskSealPluginManifestFile
} from "./application/plugin-manifest-check.ts";
import {
  PluginManifestError
} from "./sdk/plugin-manifest.ts";
import {
  TASKSEAL_PACKAGE_VERSION
} from "./sdk/version.ts";
import type {
  LocalLinearAcceptanceRuntime,
  LocalLinearAcceptanceServicePort
} from "./linear-acceptance-runtime.ts";
import type {
  CheckTaskSealPluginManifestFileOptions
} from "./application/plugin-manifest-check.ts";
import type {
  TaskSealPluginManifestV1
} from "./sdk/plugin-manifest.ts";

export type CliExitCode = 0 | 1 | 2;

export interface OutputPort {
  write(value: string): unknown;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string }
) => unknown | Promise<unknown>;

interface RunCliWorkItemOptions {
  cwd: string;
  workItemId: string;
  prompt: string | undefined;
  sandbox: "read-only" | "workspace-write";
}

interface CliRunResult {
  attemptId: string;
  outcome: "completed" | "failed" | "interrupted";
  sessionId?: string | undefined;
  executionId?: string | undefined;
  summary?: string | undefined;
}

type RunCliWorkItem = (
  options: RunCliWorkItemOptions
) => unknown | Promise<unknown>;

type InspectVersionOptions =
  | {
      snapshotVersion?: 1 | undefined;
      managedFields?: never;
    }
  | {
      snapshotVersion: 2;
      managedFields: ManagedField[];
    };

type GitHubIssueCommandOptions = {
  issueNumber: number;
  workItemId: string;
  requiredEvidence: string[];
} & InspectVersionOptions;

type GitHubIssueInspectOptions =
  GitHubIssueCommandOptions & { cwd: string };

type GitHubCommandOptions = {
  issueNumber: number;
  pullRequestNumber: number;
  checkName: string;
  workItemId: string;
  attemptId: string;
  criterionKey: string;
} & InspectVersionOptions;

type GitHubInspectOptions =
  GitHubCommandOptions & { cwd: string };

type LinearCommandOptions = {
  issueReference: string;
  workItemId: string;
  requiredEvidence: string[];
} & InspectVersionOptions;

type LinearInspectOptions =
  LinearCommandOptions & {
    cwd: string;
    configuration?: ProjectConfiguration | undefined;
  };

type GiteeCommandOptions = {
  issueReference: string;
  workItemId: string;
  requiredEvidence: string[];
  snapshotVersion: 2;
  managedFields: ManagedField[];
};

type GiteeInspectOptions =
  GiteeCommandOptions & { cwd: string };

interface GiteeHealthInspectOptions {
  cwd: string;
}

interface LinearDryRunOptions {
  cwd: string;
  source?: string | undefined;
}

type InspectGitHubIssue = (
  options: GitHubIssueInspectOptions
) => unknown | Promise<unknown>;
type InspectGitHub = (
  options: GitHubInspectOptions
) => unknown | Promise<unknown>;
type InspectLinear = (
  options: LinearInspectOptions
) => unknown | Promise<unknown>;
type InspectGitee = (
  options: GiteeInspectOptions
) => unknown | Promise<unknown>;
type InspectGiteeHealth = (
  options: GiteeHealthInspectOptions
) => unknown | Promise<unknown>;
type CreateLinearDryRun = (
  options: LinearDryRunOptions
) => unknown | Promise<unknown>;
type ExecuteLinearReadyWork = (
  options: LinearReadyWorkCommandOptions
) => unknown | Promise<unknown>;
type ExecuteGitHubReconciliation = (
  options:
    GitHubReconciliationCommandOptions
) => unknown | Promise<unknown>;
type ParsedLinearReadyWorkArguments =
  LinearReadyWorkCommandOptions extends
    infer Command
    ? Command extends { readonly cwd: string }
      ? Omit<Command, "cwd">
      : never
    : never;
type ParsedGitHubReconciliationArguments =
  GitHubReconciliationCommandOptions extends
    infer Command
    ? Command extends {
        readonly cwd: string;
      }
      ? Omit<Command, "cwd">
      : never
    : never;

type ProviderObservationCoordinatorFactory = (options: {
  cwd: string;
  clock: () => unknown;
}) => ProviderObservationCoordinator | Promise<ProviderObservationCoordinator>;

interface StartControlRoomOptions {
  cwd: string;
  output: OutputPort;
}

type StartControlRoom = (
  options: StartControlRoomOptions
) => unknown | Promise<unknown>;

type CheckPluginManifest = (
  options:
    CheckTaskSealPluginManifestFileOptions
) =>
  | TaskSealPluginManifestV1
  | Promise<TaskSealPluginManifestV1>;

export interface RunCliOptions {
  args?: string[] | undefined;
  cwd?: string | undefined;
  output?: OutputPort | undefined;
  now?: (() => Date) | undefined;
  commandRunner?: CommandRunner | undefined;
  nodeVersion?: unknown;
  startControlRoom?: StartControlRoom | undefined;
  runWorkItem?: RunCliWorkItem | undefined;
  inspectGitHubIssue?: InspectGitHubIssue | undefined;
  inspectGitHub?: InspectGitHub | undefined;
  inspectLinear?: InspectLinear | undefined;
  inspectGitee?: InspectGitee | undefined;
  inspectGiteeHealth?: InspectGiteeHealth | undefined;
  createLinearDryRun?: CreateLinearDryRun | undefined;
  executeLinearReadyWork?:
    | ExecuteLinearReadyWork
    | undefined;
  executeGitHubReconciliation?:
    | ExecuteGitHubReconciliation
    | undefined;
  providerObservationCoordinatorFactory?:
    | ProviderObservationCoordinatorFactory
    | undefined;
  checkPluginManifest?:
    | CheckPluginManifest
    | undefined;
}

interface RunLocalCodexWorkItemOptions {
  cwd: string;
  workItemId: string;
  prompt?: string | undefined;
  sandbox?:
    | "read-only"
    | "workspace-write"
    | undefined;
  commandRunner?: CommandRunner | undefined;
  runtimeFactory?:
    | ((
        options:
          CreateLocalCodexRuntimeOptions
      ) =>
        | LocalCodexRunRuntime
        | Promise<LocalCodexRunRuntime>)
    | undefined;
}

interface LocalCodexRunRuntime {
  service: {
    getWorkItem(
      workItemId: string
    ): {
      id: string;
      title: string;
    } | null;
  };
  runner: {
    run(
      options: ManagedRunnerRunOptions
    ): ManagedRunnerResult |
      Promise<ManagedRunnerResult>;
  };
  decomposition: {
    assertManualRunAllowed(
      workItemId: string
    ): void;
  };
}

interface CreateLocalCodexRuntimeOptions {
  cwd: string;
  commandRunner?: CommandRunner | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
}

interface InitializeProjectOptions {
  cwd: string;
  now?: (() => Date) | undefined;
}

interface InitializeProjectResult {
  created: boolean;
  workItemId: string;
}

interface CollectDiagnosticsOptions {
  cwd: string;
  commandRunner?: CommandRunner | undefined;
  nodeVersion?: unknown;
}

interface CodexDiagnostic {
  available: boolean;
  loggedIn: boolean;
  version: string | null;
}

interface Diagnostics {
  node: {
    ready: boolean;
    version: string;
  };
  project: {
    ready: boolean;
  };
  codex: CodexDiagnostic;
  ready: boolean;
}

interface ResolveCodexInvocationOptions {
  cwd: string;
  commandRunner?: CommandRunner | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  appExecutables?: readonly string[] | undefined;
}

interface SelectNewestCodexInvocationOptions {
  invocations: readonly CodexAppServerInvocation[];
  cwd: string;
  commandRunner: CommandRunner;
}

interface ParsedRunArguments {
  workItemId: string;
  prompt?: string | undefined;
  readOnly: boolean;
}

interface ParsedVersionedArguments {
  values: Record<string, string>;
  versionOptions: InspectVersionOptions;
}

interface ControlRoomRunnerPort {
  readonly manifest?: {
    readonly runnerId: string;
  } | undefined;
  run(
    options: ManagedRunnerRunOptions
  ): unknown | Promise<unknown>;
}

interface ControlRoomRuntime {
  service: PersistentServicePort;
  runner: ControlRoomRunnerPort;
  decomposition?:
    | PersistentDecompositionControlPort
    | null
    | undefined;
}

interface ControlRoomServerPort {
  listen(
    port: number,
    host: string,
    callback: () => void
  ): unknown;
  once(
    event: "error",
    listener: (error: unknown) => void
  ): unknown;
  once(event: "close", listener: () => void): unknown;
  close?(
    callback: (error?: Error | undefined) => void
  ): unknown;
  shutdown?(): unknown;
}

interface SignalSourcePort {
  exitCode?: string | number | null | undefined;
  once(
    event: "SIGINT" | "SIGTERM",
    listener: () => void
  ): unknown;
  removeListener(
    event: "SIGINT" | "SIGTERM",
    listener: () => void
  ): unknown;
}

interface StartPersistentControlRoomOptions {
  cwd: string;
  output: OutputPort;
  environment?: NodeJS.ProcessEnv | undefined;
  commandRunner?: CommandRunner | undefined;
  initialize?:
    | ((
        options: InitializeProjectOptions
      ) => unknown | Promise<unknown>)
    | undefined;
  runtimeFactory?:
    | ((
        options: CreateLocalCodexRuntimeOptions
      ) => ControlRoomRuntime | Promise<ControlRoomRuntime>)
    | undefined;
  providerObservationRuntimeFactory?:
    | ((
        options: {
          cwd: string;
          clock?: (() => unknown) | undefined;
        }
      ) =>
        | {
            readModel: ProviderObservationQueryPort;
          }
        | Promise<{
            readModel: ProviderObservationQueryPort;
          }>)
    | undefined;
  providerOperationQueryFactory?:
    | ((options: {
        cwd: string;
      }) =>
        | ProviderOperationJournalQueryPort
        | Promise<ProviderOperationJournalQueryPort>)
    | undefined;
  acceptanceRuntimeFactory?:
    | ((options: {
        cwd: string;
        environment:
          NodeJS.ProcessEnv;
        service:
          PersistentServicePort;
        providerOperations:
          ProviderOperationJournalQueryPort;
      }) =>
        | LocalLinearAcceptanceRuntime
        | Promise<LocalLinearAcceptanceRuntime>)
    | undefined;
  serverFactory?:
    | ((
        options: {
          service: PersistentServicePort;
          providerStatus: ProviderSyncQueryPort;
          acceptance:
            | PersistentAcceptancePort
            | null;
          acceptanceCapabilities:
            LocalLinearAcceptanceRuntime["capabilities"];
          operatorId: string | null;
          decomposition?:
            | PersistentDecompositionControlPort
            | null
            | undefined;
          maxConcurrentRuns: number;
          runWorkItem: (
            options: RunWorkItemOptions
          ) => unknown | Promise<unknown>;
        }
      ) => ControlRoomServerPort)
    | undefined;
  signalSource?: SignalSourcePort | undefined;
}

const processSignalSource: SignalSourcePort = {
  get exitCode() {
    return process.exitCode;
  },
  set exitCode(
    value: string | number | null | undefined
  ) {
    process.exitCode = value;
  },
  once(event, listener) {
    return process.once(event, listener);
  },
  removeListener(event, listener) {
    return process.removeListener(event, listener);
  }
};

const MINIMUM_NODE_VERSION = [24, 12, 0];
const MINIMUM_NODE_VERSION_LABEL = "24.12.0";
const USAGE = `Usage:
  taskseal init
  taskseal doctor
  taskseal start
  taskseal plugin check <manifest.json>
  taskseal run <work-item-id> [--prompt <text>] [--read-only]
  taskseal inspect github-issue --issue <number> --work-item <id> --criterion <key> [--snapshot-version 2 --title-management provider|none]
  taskseal inspect github --issue <number> --pr <number> --check <name> --work-item <id> --attempt <id> --criterion <key> [--snapshot-version 2 --title-management provider|none]
  taskseal inspect linear --issue <identifier-or-uuid> --work-item <id> --criterion <key> [--snapshot-version 2 --title-management provider|none]
  taskseal inspect gitee-health
  taskseal inspect gitee --issue <case-sensitive-reference> --work-item <id> --criterion <key> --snapshot-version 2 --title-management provider|none
  taskseal ready linear
  taskseal ready linear --mode preview --issue <uuid> --work-item <id> --criterion <key>
  taskseal ready linear --mode apply --issue <uuid> --work-item <id> --criterion <key> --expected-plan-digest <sha256>
  taskseal reconcile github --mode preview --work-item <id>
  taskseal reconcile github --mode apply --work-item <id> --expected-plan-digest <sha256>
  taskseal sync linear --dry-run [--source <repository-relative-path>]
`;

export async function runCli({
  args = process.argv.slice(2),
  cwd = process.cwd(),
  output = process.stdout,
  now = () => new Date(),
  commandRunner = runCommand,
  nodeVersion = process.versions.node,
  startControlRoom = startPersistentControlRoom,
  runWorkItem,
  inspectGitHubIssue,
  inspectGitHub,
  inspectLinear,
  inspectGitee,
  inspectGiteeHealth,
  createLinearDryRun,
  executeLinearReadyWork,
  executeGitHubReconciliation,
  providerObservationCoordinatorFactory,
  checkPluginManifest
}: RunCliOptions = {}): Promise<CliExitCode> {
  const command = args[0] ?? "start";

  if (
    command === "help" ||
    command === "--help"
  ) {
    output.write(USAGE);
    return 0;
  }

  if (command === "--version") {
    output.write(
      `${TASKSEAL_PACKAGE_VERSION}\n`
    );
    return 0;
  }

  if (command === "plugin") {
    if (
      args.length !== 3 ||
      args[1] !== "check"
    ) {
      output.write(USAGE);
      return 2;
    }

    try {
      const execute =
        checkPluginManifest ??
        checkTaskSealPluginManifestFile;
      const manifest =
        await execute({
          cwd,
          path: args[2]!,
          nodeVersion:
            typeof nodeVersion ===
            "string"
              ? nodeVersion
              : ""
        });
      output.write(
        `${JSON.stringify(manifest, null, 2)}\n`
      );
      return 0;
    } catch (error) {
      output.write(
        renderPluginManifestError(
          error
        )
      );
      return 1;
    }
  }

  if (command === "init") {
    const result = await initializeProject({ cwd, now });
    output.write(
      result.created
        ? `Initialized TaskSeal with ${result.workItemId}.\n`
        : `TaskSeal is already initialized with ${result.workItemId}.\n`
    );
    return 0;
  }

  if (command === "doctor") {
    const diagnostics = await collectDiagnostics({
      cwd,
      commandRunner,
      nodeVersion
    });
    output.write(renderDiagnostics(diagnostics));
    return diagnostics.ready ? 0 : 1;
  }

  if (command === "start") {
    await startControlRoom({ cwd, output });
    return 0;
  }

  if (command === "run") {
    const options = parseRunArguments(args.slice(1));

    if (!options) {
      output.write(USAGE);
      return 2;
    }

    try {
      const execute: RunCliWorkItem =
        runWorkItem ??
        ((runOptions) =>
          runLocalCodexWorkItem({
            ...runOptions,
            commandRunner
          }));
      const result = readCliRunResult(
        await execute({
          cwd,
          workItemId: options.workItemId,
          prompt: options.prompt,
          sandbox: options.readOnly
            ? "read-only"
            : "workspace-write"
        })
      );
      output.write(renderRunResult(result));
      return result.outcome === "completed" ? 0 : 1;
    } catch (error) {
      output.write(renderRunError(error));
      return 1;
    }
  }

  if (command === "inspect") {
    const provider = args[1];

    if (provider === "github-issue") {
      const options = parseGitHubIssueInspectArguments(args.slice(2));

      if (!options) {
        output.write(USAGE);
        return 2;
      }

      try {
        const execute =
          inspectGitHubIssue ?? inspectGitHubIssueProvider;
        const snapshot =
          await executeObservedProviderInspection({
            cwd,
            clock: now,
            provider: "github",
            kind: "snapshot",
            missingEvidence: options.requiredEvidence,
            coordinatorFactory:
              providerObservationCoordinatorFactory,
            execute: () => execute({ cwd, ...options })
          });
        output.write(`${JSON.stringify(snapshot, null, 2)}\n`);
        return 0;
      } catch (error) {
        output.write(renderInspectError(error));
        return 1;
      }
    }

    if (provider === "github") {
      const options = parseGitHubInspectArguments(args.slice(2));

      if (!options) {
        output.write(USAGE);
        return 2;
      }

      try {
        const execute = inspectGitHub ?? inspectGitHubProvider;
        const snapshot =
          await executeObservedProviderInspection({
            cwd,
            clock: now,
            provider: "github",
            kind: "snapshot",
            missingEvidence: [options.criterionKey],
            coordinatorFactory:
              providerObservationCoordinatorFactory,
            execute: () => execute({ cwd, ...options })
          });
        output.write(`${JSON.stringify(snapshot, null, 2)}\n`);
        return 0;
      } catch (error) {
        output.write(renderInspectError(error));
        return 1;
      }
    }

    if (provider === "linear") {
      const options = parseLinearInspectArguments(args.slice(2));

      if (!options) {
        output.write(USAGE);
        return 2;
      }

      try {
        const execute = inspectLinear ?? inspectLinearProvider;
        const snapshot =
          await executeObservedProviderInspection({
            cwd,
            clock: now,
            provider: "linear",
            kind: "snapshot",
            missingEvidence: options.requiredEvidence,
            coordinatorFactory:
              providerObservationCoordinatorFactory,
            execute: (configuration) =>
              execute({
                cwd,
                ...options,
                ...(configuration === null
                  ? {}
                  : { configuration })
              })
          });
        output.write(`${JSON.stringify(snapshot, null, 2)}\n`);
        return 0;
      } catch (error) {
        output.write(renderInspectError(error));
        return 1;
      }
    }

    if (provider === "gitee-health") {
      if (args.length !== 2) {
        output.write(USAGE);
        return 2;
      }

      try {
        const execute =
          inspectGiteeHealth ?? inspectGiteeHealthProvider;
        const health =
          await executeObservedProviderInspection({
            cwd,
            clock: now,
            provider: "gitee",
            kind: "health",
            coordinatorFactory:
              providerObservationCoordinatorFactory,
            execute: () => execute({ cwd })
          });
        output.write(`${JSON.stringify(health, null, 2)}\n`);
        return 0;
      } catch (error) {
        output.write(renderInspectError(error));
        return 1;
      }
    }

    if (provider === "gitee") {
      const options = parseGiteeInspectArguments(
        args.slice(2)
      );

      if (!options) {
        output.write(USAGE);
        return 2;
      }

      try {
        const execute =
          inspectGitee ?? inspectGiteeProvider;
        const snapshot =
          await executeObservedProviderInspection({
            cwd,
            clock: now,
            provider: "gitee",
            kind: "snapshot",
            missingEvidence: options.requiredEvidence,
            coordinatorFactory:
              providerObservationCoordinatorFactory,
            execute: () =>
              execute({
                cwd,
                ...options
              })
          });
        output.write(`${JSON.stringify(snapshot, null, 2)}\n`);
        return 0;
      } catch (error) {
        output.write(renderInspectError(error));
        return 1;
      }
    }

    output.write(USAGE);
    return 2;
  }

  if (command === "sync") {
    if (args[1] !== "linear") {
      output.write(USAGE);
      return 2;
    }

    const options = parseLinearSyncArguments(args.slice(2));

    if (!options) {
      output.write(USAGE);
      return 2;
    }

    try {
      const execute = createLinearDryRun ?? createLinearTicketDryRun;
      const plan = await execute({ cwd, ...options });
      output.write(`${JSON.stringify(plan, null, 2)}\n`);
      return 0;
    } catch (error) {
      output.write(renderSyncError(error));
      return 1;
    }
  }

  if (command === "ready") {
    if (args[1] !== "linear") {
      output.write(USAGE);
      return 2;
    }

    const options =
      parseLinearReadyWorkArguments(
        args.slice(2)
      );

    if (!options) {
      output.write(USAGE);
      return 2;
    }

    try {
      const execute =
        executeLinearReadyWork ??
        executeLocalLinearReadyWork;
      const result = await execute({
        cwd,
        ...options
      } as LinearReadyWorkCommandOptions);
      output.write(
        `${JSON.stringify(result, null, 2)}\n`
      );
      return 0;
    } catch (error) {
      output.write(
        renderLinearReadyWorkError(error)
      );
      return 1;
    }
  }

  if (command === "reconcile") {
    if (args[1] !== "github") {
      output.write(USAGE);
      return 2;
    }

    const options =
      parseGitHubReconciliationArguments(
        args.slice(2)
      );

    if (!options) {
      output.write(USAGE);
      return 2;
    }

    try {
      const execute =
        executeGitHubReconciliation ??
        executeLocalGitHubReconciliation;
      const result = await execute({
        cwd,
        ...options
      } as GitHubReconciliationCommandOptions);
      output.write(
        `${JSON.stringify(result, null, 2)}\n`
      );
      return 0;
    } catch (error) {
      output.write(
        renderGitHubReconciliationError(
          error
        )
      );
      return 1;
    }
  }

  output.write(USAGE);
  return 2;
}

function renderPluginManifestError(
  error: unknown
): string {
  if (
    error instanceof
    PluginManifestError
  ) {
    return `${error.code}: ${error.message}\n`;
  }
  return "PLUGIN_MANIFEST_INVALID: The TaskSeal plugin manifest is invalid.\n";
}

async function executeObservedProviderInspection<T>({
  cwd,
  clock,
  provider,
  kind,
  missingEvidence = [],
  coordinatorFactory,
  execute
}: {
  cwd: string;
  clock: () => unknown;
  provider: ProviderName;
  kind: "health" | "snapshot";
  missingEvidence?: string[] | undefined;
  coordinatorFactory:
    | ProviderObservationCoordinatorFactory
    | undefined;
  execute: (
    configuration: ProjectConfiguration | null
  ) => T | Promise<T>;
}): Promise<T> {
  if (!coordinatorFactory) {
    return execute(null);
  }

  let coordinator: ProviderObservationCoordinator;
  try {
    coordinator = await coordinatorFactory({
      cwd,
      clock
    });
  } catch {
    return execute(null);
  }

  let configuredTarget = fallbackConfiguredTarget(provider);
  let configuration: ProjectConfiguration | null = null;
  try {
    configuration =
      await readProjectConfiguration({ cwd });
    configuredTarget = configuredTargetForProvider(
      configuration,
      provider
    );
  } catch {
    // The provider operation supplies the authoritative config error.
  }

  return coordinator.inspect({
    provider,
    configuredTarget,
    kind,
    missingEvidence,
    verifiedLinearScopeBinding:
      provider === "linear" && configuration !== null,
    execute: () => execute(configuration)
  });
}

export async function runLocalCodexWorkItem({
  cwd,
  workItemId,
  prompt,
  sandbox = "workspace-write",
  commandRunner = runCommand,
  runtimeFactory =
    createLocalCodexRuntime
}: RunLocalCodexWorkItemOptions): Promise<ManagedRunnerResult> {
  const {
    service,
    runner,
    decomposition
  } = await runtimeFactory({
      cwd,
      commandRunner
    });
  const workItem = service.getWorkItem(workItemId);

  if (!workItem) {
    throw Object.assign(
      new Error(
        `TaskSeal work item ${workItemId} does not exist. Run taskseal init first.`
      ),
      { code: "WORK_ITEM_NOT_FOUND" }
    );
  }
  decomposition.assertManualRunAllowed(
    workItemId
  );

  return runner.run({
    workItemId,
    cwd,
    instruction:
      prompt ?? createDefaultPrompt(workItem),
    workspaceAccess: sandbox
  });
}

export async function createLocalCodexRuntime({
  cwd,
  commandRunner = runCommand,
  environment = process.env
}: CreateLocalCodexRuntimeOptions): Promise<{
  service: TaskSealService;
  runner: ManagedAttemptRunner;
  decomposition:
    PersistentDecompositionControlPort;
}> {
  const journal = new FileEventJournal({
    filePath: join(cwd, ".taskseal", "events.jsonl")
  });
  const service = await TaskSealService.open({ journal });
  await service.recoverRunningAttempts();
  const invocation = await resolveCodexInvocation({
    cwd,
    commandRunner,
    environment
  });

  if (!invocation) {
    throw Object.assign(
      new Error(
        "Codex executable was not found. Run taskseal doctor for details."
      ),
      { code: "CODEX_NOT_AVAILABLE" }
    );
  }

  const runner = new ManagedAttemptRunner({
    service,
    projectRoot: cwd,
    allowedWorkspaceAccess: [
      "read-only",
      "workspace-write"
    ],
    adapter:
      new CodexAppServerRunnerAdapter({
        clientFactory: () =>
          new CodexAppServerClient({
            invocation,
            environment
          })
      })
  });
  const decomposition =
    await createLocalDecompositionControl({
      cwd,
      service,
      runner,
      environment
    });

  return {
    service,
    runner,
    decomposition
  };
}

export async function createLocalProviderObservationRuntime({
  cwd,
  clock = () => new Date(),
  providerIngressRegistry =
    DEFAULT_PROVIDER_INGRESS_REGISTRY
}: {
  cwd: string;
  clock?: (() => unknown) | undefined;
  providerIngressRegistry?:
    | ProviderIngressRegistry
    | undefined;
}): Promise<{
  readModel: ProviderObservationReadModel;
  coordinator: ProviderObservationCoordinator;
  createSnapshotImportFacade(options: {
    provider: ImportProvider;
    imports: SnapshotImportApplyPort;
  }): Promise<ObservedSnapshotImportFacade>;
}> {
  const storage = new FileProviderObservationStorage({
    workspaceRoot: cwd,
    filePath: join(
      cwd,
      ".taskseal",
      "provider-observations.json"
    )
  });
  const readModel =
    await ProviderObservationReadModel.open({ storage });
  const coordinator = new ProviderObservationCoordinator({
    observations: readModel,
    clock
  });
  const importTargets =
    new Map<ImportProvider, ProviderObservationTarget>();
  const createSnapshotImportFacade = async ({
    provider,
    imports
  }: {
    provider: ImportProvider;
    imports: SnapshotImportApplyPort;
  }): Promise<ObservedSnapshotImportFacade> => {
    const configuredTarget = importTargets.get(provider);
    if (!configuredTarget) {
      throw new TypeError(
        `Provider ${provider} is not configured for observed snapshot import.`
      );
    }

    let boundScope: ProviderObservationScope;
    if (
      provider === "github" &&
      configuredTarget.kind === "repository"
    ) {
      boundScope = {
        kind: "repository",
        key: configuredTarget.key,
        parentKey: null
      };
    } else {
      const observation = (
        await readModel.list()
      ).providers.find(
        (candidate) =>
          candidate.provider === provider &&
          candidate.configuredTarget.key ===
            configuredTarget.key &&
          candidate.status === "snapshot_ready" &&
          candidate.observedScope !== null
      );
      if (!observation?.observedScope) {
        throw new TypeError(
          `Provider ${provider} does not have a verified scope binding.`
        );
      }
      boundScope = observation.observedScope;
    }

    return new ObservedSnapshotImportFacade({
      provider,
      configuredTarget,
      boundScope,
      coordinator,
      imports,
      providerIngressRegistry
    });
  };
  let configuration;

  try {
    configuration =
      await readProjectConfiguration({ cwd });
  } catch {
    return {
      readModel,
      coordinator,
      createSnapshotImportFacade
    };
  }

  for (const provider of [
    "github",
    "linear",
    "gitee"
  ] as const) {
    if (configuration[provider] === undefined) {
      continue;
    }

    const observedAt =
      captureConfigurationSeedTimestamp(clock);
    let input: ProviderObservationInput;

    try {
      const configuredTarget =
        configuredTargetForProvider(
          configuration,
          provider
        );
      if (provider !== "gitee") {
        importTargets.set(provider, configuredTarget);
      }
      input = projectProviderConfiguration({
        provider,
        configuredTarget,
        observedAt
      });
    } catch (error) {
      input = projectProviderFailure({
        operation: "configuration",
        provider,
        configuredTarget:
          fallbackConfiguredTarget(provider),
        startedAt: observedAt,
        observedAt,
        error
      });
    }

    await readModel.ensure(input);
  }

  return {
    readModel,
    coordinator,
    createSnapshotImportFacade
  };
}

export async function createLocalProviderOperationQuery({
  cwd
}: {
  cwd: string;
}): Promise<ProviderOperationJournalQueryPort> {
  const journal =
    await createLocalProviderOperationRuntime({
      cwd
    });
  return Object.freeze({
    get: journal.get.bind(journal),
    history: journal.history.bind(journal),
    listLatest:
      journal.listLatest.bind(journal)
  });
}

export async function createLocalProviderOperationRuntime({
  cwd
}: {
  cwd: string;
}): Promise<ProviderOperationJournal> {
  const journal =
    await ProviderOperationJournal.open({
    storage:
      new FileProviderOperationJournalStorage({
        workspaceRoot: cwd
      })
  });
  return journal;
}

function captureConfigurationSeedTimestamp(
  clock: () => unknown
): string {
  const value = clock();
  if (
    !(value instanceof Date) ||
    !Number.isFinite(value.getTime())
  ) {
    throw new TypeError(
      "Provider observation clock must return a valid Date."
    );
  }
  return new Date(value.getTime() - 1).toISOString();
}

export async function initializeProject({
  cwd,
  now = () => new Date()
}: InitializeProjectOptions): Promise<InitializeProjectResult> {
  const journal = new FileEventJournal({
    filePath: join(cwd, ".taskseal", "events.jsonl")
  });
  const service = await TaskSealService.open({ journal });
  const existing = service.getWorkItem("TS-1");

  if (existing) {
    return {
      created: false,
      workItemId: existing.id
    };
  }

  const event: WorkItemCreatedEvent = {
    eventId: "taskseal:TS-1:local-created",
    workItemId: "TS-1",
    type: "work_item.created",
    occurredAt: now().toISOString(),
    payload: {
      title: "Run the first Codex App Server attempt",
      requiredEvidence: ["tests"],
      externalLink: {
        provider: "taskseal",
        externalId: "TS-1",
        url: "http://127.0.0.1:4317/work-items/TS-1"
      }
    }
  };

  await service.append(event);

  return {
    created: true,
    workItemId: event.workItemId
  };
}

export async function collectDiagnostics({
  cwd,
  commandRunner = runCommand,
  nodeVersion = process.versions.node
}: CollectDiagnosticsOptions): Promise<Diagnostics> {
  const parsedNodeVersion = parseNodeVersion(nodeVersion);
  const node = {
    ready:
      parsedNodeVersion !== null &&
      compareVersions(
        parsedNodeVersion,
        MINIMUM_NODE_VERSION
      ) >= 0,
    version:
      typeof nodeVersion === "string"
        ? nodeVersion.startsWith("v")
          ? nodeVersion
          : `v${nodeVersion}`
        : String(nodeVersion)
  };
  const project = await inspectProjectConfiguration(cwd);
  let codex: CodexDiagnostic;

  try {
    const codexInvocation = await resolveCodexInvocation({
      cwd,
      commandRunner
    });

    if (!codexInvocation) {
      throw new Error("Codex executable not found.");
    }

    const versionResult = readCommandResult(
      await commandRunner(
        codexInvocation.command,
        [...codexInvocation.argsPrefix, "--version"],
        { cwd }
      )
    );

    if (versionResult.exitCode !== 0) {
      codex = {
        available: false,
        loggedIn: false,
        version: null
      };
    } else {
      const loginResult = readCommandResult(
        await commandRunner(
          codexInvocation.command,
          [...codexInvocation.argsPrefix, "login", "status"],
          { cwd }
        )
      );
      codex = {
        available: true,
        loggedIn:
          loginResult.exitCode === 0 &&
          /logged in/i.test(
            `${loginResult.stdout}\n${loginResult.stderr}`
          ),
        version: versionResult.stdout.trim()
      };
    }
  } catch {
    codex = {
      available: false,
      loggedIn: false,
      version: null
    };
  }

  return {
    node,
    project,
    codex,
    ready:
      node.ready &&
      project.ready &&
      codex.available &&
      codex.loggedIn
  };
}

export async function resolveCodexInvocation({
  cwd,
  commandRunner = runCommand,
  environment = process.env,
  platform = process.platform,
  appExecutables
}: ResolveCodexInvocationOptions): Promise<
  CodexAppServerInvocation | null
> {
  if (
    typeof environment.TASKSEAL_CODEX_BIN === "string" &&
    environment.TASKSEAL_CODEX_BIN.trim().length > 0
  ) {
    return invocationForCandidate(environment.TASKSEAL_CODEX_BIN);
  }

  if (platform !== "win32") {
    return {
      command: "codex",
      argsPrefix: []
    };
  }

  const candidates: string[] = [];

  try {
    const result = readCommandResult(
      await commandRunner(
        "where.exe",
        ["codex"],
        { cwd }
      )
    );

    if (result.exitCode === 0) {
      candidates.push(
        ...result.stdout
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(
            (value) =>
              value.toLowerCase().endsWith(".cmd") ||
              value.toLowerCase().endsWith(".exe")
          )
      );
    }
  } catch {
    // Codex App discovery below can still provide a usable binary.
  }

  candidates.push(
    ...(appExecutables ??
      (await discoverCodexAppExecutables(environment.LOCALAPPDATA)))
  );

  const invocations: CodexAppServerInvocation[] = [];

  for (const candidate of [...new Set(candidates)]) {
    const invocation = await invocationForCandidate(candidate);

    if (invocation) {
      invocations.push(invocation);
    }
  }

  return selectNewestCodexInvocation({
    invocations,
    cwd,
    commandRunner
  });
}

async function discoverCodexAppExecutables(
  localAppData: unknown
): Promise<string[]> {
  if (typeof localAppData !== "string" || localAppData.length === 0) {
    return [];
  }

  const binDirectory = join(localAppData, "OpenAI", "Codex", "bin");
  const candidates = [join(binDirectory, "codex.exe")];

  try {
    const entries = await readdir(binDirectory, { withFileTypes: true });
    candidates.push(
      ...entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(binDirectory, entry.name, "codex.exe"))
    );
  } catch {
    return [];
  }

  const usable = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        await access(candidate);
        return candidate;
      } catch {
        return null;
      }
    })
  );
  return usable.filter(
    (candidate): candidate is string =>
      candidate !== null
  );
}

async function selectNewestCodexInvocation({
  invocations,
  cwd,
  commandRunner
}: SelectNewestCodexInvocationOptions): Promise<
  CodexAppServerInvocation | null
> {
  let selected: {
    invocation: CodexAppServerInvocation;
    version: number[];
  } | null = null;

  for (const invocation of invocations) {
    try {
      const result = readCommandResult(
        await commandRunner(
          invocation.command,
          [...invocation.argsPrefix, "--version"],
          { cwd }
        )
      );
      const version = parseCodexVersion(result.stdout);

      if (
        result.exitCode === 0 &&
        version &&
        (!selected || compareVersions(version, selected.version) > 0)
      ) {
        selected = {
          invocation,
          version
        };
      }
    } catch {
      // Ignore inaccessible or incomplete installations.
    }
  }

  return selected?.invocation ?? null;
}

function parseCodexVersion(value: unknown): number[] | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = /\b(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

function parseNodeVersion(value: unknown): number[] | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(
  left: readonly number[],
  right: readonly number[]
): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

async function invocationForCandidate(
  candidate: string
): Promise<CodexAppServerInvocation | null> {
  if (!candidate.toLowerCase().endsWith(".cmd")) {
    return {
      command: candidate,
      argsPrefix: []
    };
  }

  const codexScript = join(
    dirname(candidate),
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js"
  );

  try {
    await access(codexScript);
    return {
      command: process.execPath,
      argsPrefix: [codexScript]
    };
  } catch {
    return null;
  }
}

async function inspectProjectConfiguration(
  cwd: string
): Promise<{ ready: boolean }> {
  try {
    const content = await readFile(join(cwd, "config", "project.json"), "utf8");
    const configuration: unknown = JSON.parse(content);

    return {
      ready:
        isRecord(configuration) &&
        typeof configuration.project === "string" &&
        configuration.project.length > 0
    };
  } catch {
    return { ready: false };
  }
}

function renderDiagnostics(
  diagnostics: Diagnostics
): string {
  const lines = [
    formatDiagnostic(
      diagnostics.node.ready,
      `Node ${diagnostics.node.version}`,
      `requires Node ${MINIMUM_NODE_VERSION_LABEL} or newer`
    ),
    formatDiagnostic(
      diagnostics.project.ready,
      "Project configuration",
      "missing or invalid"
    ),
    diagnostics.codex.available
      ? `✓ Codex ${diagnostics.codex.version} — ready`
      : "× Codex binary — not available",
    formatDiagnostic(
      diagnostics.codex.loggedIn,
      "Codex login",
      "not ready"
    )
  ];

  return `${lines.join("\n")}\n`;
}

function parseRunArguments(
  args: readonly string[]
): ParsedRunArguments | null {
  const [workItemId, ...options] = args;

  if (
    typeof workItemId !== "string" ||
    workItemId.length === 0 ||
    workItemId.startsWith("--")
  ) {
    return null;
  }

  let prompt: string | undefined;
  let readOnly = false;

  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];

    if (option === "--read-only" && !readOnly) {
      readOnly = true;
      continue;
    }

    if (option === "--prompt" && prompt === undefined) {
      prompt = options[index + 1];

      if (typeof prompt !== "string" || prompt.trim().length === 0) {
        return null;
      }

      index += 1;
      continue;
    }

    return null;
  }

  return {
    workItemId,
    ...(prompt === undefined ? {} : { prompt }),
    readOnly
  };
}

function createDefaultPrompt(
  workItem: Pick<WorkItem, "id" | "title">
): string {
  return [
    `Work on TaskSeal work item ${workItem.id}: ${workItem.title}.`,
    "Stay inside the current project, report the result concisely, and do not access external issue trackers.",
    "Completing the turn is a delivery claim only; TaskSeal will require separate artifact and evidence before acceptance."
  ].join("\n");
}

function readCliRunResult(value: unknown): CliRunResult {
  if (
    !isRecord(value) ||
    typeof value.attemptId !== "string" ||
    !["completed", "failed", "interrupted"].includes(
      typeof value.outcome === "string"
        ? value.outcome
        : ""
    )
  ) {
    throw new TypeError(
      "TaskSeal runner returned an invalid result."
    );
  }

  const runtimeRefs = value.runtimeRefs;
  if (
    runtimeRefs !== undefined &&
    !isRecord(runtimeRefs)
  ) {
    throw new TypeError(
      "TaskSeal runner returned an invalid result."
    );
  }
  const sessionId =
    runtimeRefs === undefined
      ? readOptionalResultString(
          value,
          "threadId"
        )
      : readOptionalResultString(
          runtimeRefs,
          "sessionId"
        );
  const executionId =
    runtimeRefs === undefined
      ? readOptionalResultString(
          value,
          "turnId"
        )
      : readOptionalResultString(
          runtimeRefs,
          "executionId"
        );
  const summary = readOptionalResultString(
    value,
    "summary",
    true
  );
  const outcome = value.outcome;

  if (
    outcome !== "completed" &&
    outcome !== "failed" &&
    outcome !== "interrupted"
  ) {
    throw new TypeError(
      "TaskSeal runner returned an invalid result."
    );
  }

  return {
    attemptId: value.attemptId,
    outcome,
    ...(sessionId === undefined
      ? {}
      : { sessionId }),
    ...(executionId === undefined
      ? {}
      : { executionId }),
    ...(summary === undefined ? {} : { summary })
  };
}

function readOptionalResultString(
  value: Record<string, unknown>,
  key: string,
  allowNull = false
): string | undefined {
  const candidate = value[key];

  if (
    candidate === undefined ||
    (allowNull && candidate === null)
  ) {
    return undefined;
  }

  if (typeof candidate !== "string") {
    throw new TypeError(
      "TaskSeal runner returned an invalid result."
    );
  }

  return candidate;
}

function renderRunResult(result: CliRunResult): string {
  const lines = [
    `Attempt ${result.attemptId}: ${result.outcome}`,
    ...(result.sessionId
      ? [
          `Runner session: ${result.sessionId}`
        ]
      : []),
    ...(result.executionId
      ? [
          `Runner execution: ${result.executionId}`
        ]
      : []),
    ...(result.summary ? [`Summary: ${result.summary}`] : [])
  ];
  return `${lines.join("\n")}\n`;
}

function renderRunError(error: unknown): string {
  const code = renderErrorCode(error);
  const message = readErrorMessage(
    error,
    "Unknown runner error."
  );
  return `TaskSeal run failed${code}: ${message.slice(0, 2_000)}\n`;
}

function parseGitHubInspectArguments(
  args: readonly string[]
): GitHubCommandOptions | null {
  const parsed = parseVersionedInspectArguments(args, [
    "--issue",
    "--pr",
    "--check",
    "--work-item",
    "--attempt",
    "--criterion"
  ]);

  if (!parsed) {
    return null;
  }

  const { values, versionOptions } = parsed;
  const issueNumber = parsePositiveInteger(
    readNamedArgument(values, "--issue")
  );
  const pullRequestNumber = parsePositiveInteger(
    readNamedArgument(values, "--pr")
  );

  if (!issueNumber || !pullRequestNumber) {
    return null;
  }

  return {
    issueNumber,
    pullRequestNumber,
    checkName: readNamedArgument(values, "--check"),
    workItemId: readNamedArgument(values, "--work-item"),
    attemptId: readNamedArgument(values, "--attempt"),
    criterionKey: readNamedArgument(values, "--criterion"),
    ...versionOptions
  };
}

function parseGitHubIssueInspectArguments(
  args: readonly string[]
): GitHubIssueCommandOptions | null {
  const parsed = parseVersionedInspectArguments(args, [
    "--issue",
    "--work-item",
    "--criterion"
  ]);

  if (!parsed) {
    return null;
  }

  const { values, versionOptions } = parsed;
  const issueNumber = parsePositiveInteger(
    readNamedArgument(values, "--issue")
  );

  if (!issueNumber) {
    return null;
  }

  return {
    issueNumber,
    workItemId: readNamedArgument(values, "--work-item"),
    requiredEvidence: [
      readNamedArgument(values, "--criterion")
    ],
    ...versionOptions
  };
}

function parseLinearInspectArguments(
  args: readonly string[]
): LinearCommandOptions | null {
  const parsed = parseVersionedInspectArguments(args, [
    "--issue",
    "--work-item",
    "--criterion"
  ]);

  if (!parsed) {
    return null;
  }

  const { values, versionOptions } = parsed;
  const issueReference = readNamedArgument(
    values,
    "--issue"
  );

  if (!isLinearIssueReference(issueReference)) {
    return null;
  }

  return {
    issueReference,
    workItemId: readNamedArgument(values, "--work-item"),
    requiredEvidence: [
      readNamedArgument(values, "--criterion")
    ],
    ...versionOptions
  };
}

function parseGiteeInspectArguments(
  args: readonly string[]
): GiteeCommandOptions | null {
  const parsed = parseVersionedInspectArguments(args, [
    "--issue",
    "--work-item",
    "--criterion"
  ]);

  if (
    !parsed ||
    parsed.versionOptions.snapshotVersion !== 2
  ) {
    return null;
  }

  const issueReference = readNamedArgument(
    parsed.values,
    "--issue"
  );

  if (!isGiteeIssueReference(issueReference)) {
    return null;
  }

  return {
    issueReference,
    workItemId: readNamedArgument(
      parsed.values,
      "--work-item"
    ),
    requiredEvidence: [
      readNamedArgument(parsed.values, "--criterion")
    ],
    snapshotVersion: 2,
    managedFields: [
      ...parsed.versionOptions.managedFields
    ]
  };
}

function parseVersionedInspectArguments(
  args: readonly string[],
  names: readonly string[]
): ParsedVersionedArguments | null {
  const optionalNames: string[] = [
    "--snapshot-version",
    "--title-management"
  ];
  const values = parseNamedArguments(
    args,
    names,
    optionalNames
  );

  if (!values) {
    return null;
  }

  const hasVersion = Object.hasOwn(
    values,
    "--snapshot-version"
  );
  const hasTitleManagement = Object.hasOwn(
    values,
    "--title-management"
  );

  if (!hasVersion && !hasTitleManagement) {
    return {
      values,
      versionOptions: {}
    };
  }

  if (
    hasVersion &&
    !hasTitleManagement &&
    values["--snapshot-version"] === "1"
  ) {
    return {
      values,
      versionOptions: {
        snapshotVersion: 1
      }
    };
  }

  const titleManagement =
    values["--title-management"];

  if (
    !hasVersion ||
    !hasTitleManagement ||
    values["--snapshot-version"] !== "2" ||
    (titleManagement !== "provider" &&
      titleManagement !== "none")
  ) {
    return null;
  }

  return {
    values,
    versionOptions: {
      snapshotVersion: 2,
      managedFields:
        titleManagement === "provider" ? ["title"] : []
    }
  };
}

function parseNamedArguments(
  args: readonly string[],
  names: readonly string[],
  optionalNames: readonly string[] = []
): Record<string, string> | null {
  if (
    args.length < names.length * 2 ||
    args.length > (names.length + optionalNames.length) * 2 ||
    args.length % 2 !== 0
  ) {
    return null;
  }

  const allowed = new Set([...names, ...optionalNames]);
  const values: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];

    if (
      typeof name !== "string" ||
      !allowed.has(name) ||
      Object.hasOwn(values, name) ||
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value.startsWith("--")
    ) {
      return null;
    }

    values[name] = value;
  }

  return names.every((name) => Object.hasOwn(values, name))
    ? values
    : null;
}

function readNamedArgument(
  values: Readonly<Record<string, string>>,
  name: string
): string {
  const value = values[name];

  if (typeof value !== "string") {
    throw new TypeError(
      `TaskSeal internal argument ${name} is missing.`
    );
  }

  return value;
}

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }

  if (!/^\d+$/.test(value)) {
    return null;
  }

  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function parseLinearSyncArguments(
  args: readonly string[]
): Omit<LinearDryRunOptions, "cwd"> | null {
  if (args[0] !== "--dry-run") {
    return null;
  }

  if (args.length === 1) {
    return {};
  }

  if (
    args.length === 3 &&
    args[1] === "--source" &&
    typeof args[2] === "string" &&
    args[2].trim().length > 0 &&
    !args[2].startsWith("--")
  ) {
    return { source: args[2] };
  }

  return null;
}

function parseLinearReadyWorkArguments(
  args: readonly string[]
): ParsedLinearReadyWorkArguments | null {
  if (args.length === 0) {
    return { mode: "list" };
  }

  const previewValues =
    parseNamedArguments(args, [
      "--mode",
      "--issue",
      "--work-item",
      "--criterion"
    ]);

  if (
    previewValues !== null &&
    previewValues["--mode"] ===
      "preview"
  ) {
    const issueId =
      previewValues["--issue"];

    if (!isReadyWorkUuid(issueId)) {
      return null;
    }

    return {
      mode: "preview",
      issueId: issueId.toLowerCase(),
      workItemId: readNamedArgument(
        previewValues,
        "--work-item"
      ),
      requiredEvidence: [
        readNamedArgument(
          previewValues,
          "--criterion"
        )
      ]
    };
  }

  const applyValues = parseNamedArguments(
    args,
    [
      "--mode",
      "--issue",
      "--work-item",
      "--criterion",
      "--expected-plan-digest"
    ]
  );

  if (
    applyValues === null ||
    applyValues["--mode"] !== "apply"
  ) {
    return null;
  }

  const issueId = applyValues["--issue"];
  const expectedPlanDigest =
    applyValues[
      "--expected-plan-digest"
    ];

  if (
    !isReadyWorkUuid(issueId) ||
    typeof expectedPlanDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(
      expectedPlanDigest
    )
  ) {
    return null;
  }

  return {
    mode: "apply",
    issueId: issueId.toLowerCase(),
    workItemId: readNamedArgument(
      applyValues,
      "--work-item"
    ),
    requiredEvidence: [
      readNamedArgument(
        applyValues,
        "--criterion"
      )
    ],
    expectedPlanDigest
  };
}

function parseGitHubReconciliationArguments(
  args: readonly string[]
): ParsedGitHubReconciliationArguments | null {
  const previewValues =
    parseNamedArguments(args, [
      "--mode",
      "--work-item"
    ]);

  if (
    previewValues !== null &&
    previewValues["--mode"] ===
      "preview"
  ) {
    return {
      mode: "preview",
      workItemId: readNamedArgument(
        previewValues,
        "--work-item"
      )
    };
  }

  const applyValues =
    parseNamedArguments(args, [
      "--mode",
      "--work-item",
      "--expected-plan-digest"
    ]);
  const expectedPlanDigest =
    applyValues?.[
      "--expected-plan-digest"
    ];

  if (
    applyValues === null ||
    applyValues["--mode"] !== "apply" ||
    typeof expectedPlanDigest !==
      "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(
      expectedPlanDigest
    )
  ) {
    return null;
  }

  return {
    mode: "apply",
    workItemId: readNamedArgument(
      applyValues,
      "--work-item"
    ),
    expectedPlanDigest
  };
}

function isReadyWorkUuid(
  value: unknown
): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}

function renderInspectError(error: unknown): string {
  const code = renderErrorCode(error);
  const message = readErrorMessage(
    error,
    "Unknown provider error."
  );
  return `TaskSeal inspect failed${code}: ${message.slice(0, 2_000)}\n`;
}

function renderSyncError(error: unknown): string {
  const code = renderErrorCode(error);
  const message = readErrorMessage(
    error,
    "Unknown synchronization planning error."
  );
  return `TaskSeal sync dry-run failed${code}: ${message.slice(0, 2_000)}\n`;
}

function renderLinearReadyWorkError(
  _error: unknown
): string {
  return "TaskSeal ready failed [LINEAR_READY_FAILED]: Linear ready-work request failed.\n";
}

function renderGitHubReconciliationError(
  _error: unknown
): string {
  return "TaskSeal reconcile failed [GITHUB_RECONCILE_FAILED]: GitHub delivery reconciliation failed.\n";
}

function renderErrorCode(error: unknown): string {
  return isRecord(error) &&
    typeof error.code === "string" &&
    error.code.length > 0
    ? ` [${error.code}]`
    : "";
}

function readErrorMessage(
  error: unknown,
  fallback: string
): string {
  return isRecord(error) &&
    typeof error.message === "string" &&
    error.message.length > 0
    ? error.message
    : fallback;
}

function readCommandResult(value: unknown): CommandResult {
  if (
    !isRecord(value) ||
    typeof value.exitCode !== "number" ||
    !Number.isInteger(value.exitCode) ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string"
  ) {
    throw new TypeError(
      "TaskSeal command runner returned an invalid result."
    );
  }

  return {
    exitCode: value.exitCode,
    stdout: value.stdout,
    stderr: value.stderr
  };
}

function formatDiagnostic(
  ready: boolean,
  label: string,
  failure: string
): string {
  return ready ? `✓ ${label} — ready` : `× ${label} — ${failure}`;
}

export async function startPersistentControlRoom({
  cwd,
  output,
  environment = process.env,
  commandRunner = runCommand,
  initialize = initializeProject,
  runtimeFactory = createLocalCodexRuntime,
  providerObservationRuntimeFactory =
    createLocalProviderObservationRuntime,
  providerOperationQueryFactory =
    createLocalProviderOperationRuntime,
  acceptanceRuntimeFactory,
  serverFactory = createTaskSealServer,
  signalSource = processSignalSource
}: StartPersistentControlRoomOptions): Promise<
  ControlRoomServerPort
> {
  const host = environment.HOST ?? "127.0.0.1";
  const port = Number(environment.PORT ?? 4317);
  const maxConcurrentRuns =
    readMaxConcurrentRuns(
      environment.TASKSEAL_MAX_CONCURRENT_RUNS
    );

  if (
    typeof host !== "string" ||
    !["127.0.0.1", "localhost", "::1"].includes(host.toLowerCase()) ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65_535
  ) {
    throw new TypeError(
      "TaskSeal HOST must be loopback and PORT must be valid."
    );
  }

  await initialize({ cwd });
  const { readModel: providerObservations } =
    await providerObservationRuntimeFactory({ cwd });
  const providerOperations =
    await providerOperationQueryFactory({ cwd });
  const {
    service,
    runner,
    decomposition = null
  } = await runtimeFactory({
    cwd,
    commandRunner,
    environment
  });
  const acceptanceRuntime =
    acceptanceRuntimeFactory !== undefined
      ? await acceptanceRuntimeFactory({
          cwd,
          environment,
          service,
          providerOperations
        })
      : providerOperationQueryFactory ===
          createLocalProviderOperationRuntime
        ? await createControlRoomAcceptanceRuntime({
            cwd,
            environment,
            service,
            providerOperations
          })
        : disabledAcceptanceRuntime(
            providerOperations
          );
  const providerStatus =
    new ProviderSyncProjectionQuery({
      observations: providerObservations,
      operations:
        acceptanceRuntime
          .providerOperations
    });
  const server = serverFactory({
    service,
    providerStatus,
    acceptance:
      acceptanceRuntime.acceptance,
    acceptanceCapabilities:
      acceptanceRuntime.capabilities,
    operatorId:
      acceptanceRuntime.operatorId,
    decomposition,
    maxConcurrentRuns,
    runWorkItem: (options) => {
      if (
        options.runnerId !==
          undefined &&
        runner.manifest?.runnerId !==
          options.runnerId
      ) {
        throw Object.assign(
          new Error(
            "The approved decomposition runner is not available."
          ),
          {
            code:
              "RUNNER_NOT_AVAILABLE"
          }
        );
      }
      return runner.run({
        workItemId:
          options.workItemId,
        cwd,
        instruction: options.prompt,
        workspaceAccess:
          options.sandbox,
        timeoutMs:
          options.timeoutMs,
        signal: options.signal,
        terminalization:
          options.terminalization
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => reject(error));
    server.listen(port, host, () => resolve());
  });

  installShutdownHandlers({
    server,
    signalSource,
    output
  });
  output.write(`TaskSeal Control Room: http://${host}:${port}\n`);
  return server;
}

async function createControlRoomAcceptanceRuntime({
  cwd,
  environment,
  service,
  providerOperations
}: {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  service: PersistentServicePort;
  providerOperations:
    ProviderOperationJournalQueryPort;
}): Promise<LocalLinearAcceptanceRuntime> {
  if (
    !(
      providerOperations instanceof
      ProviderOperationJournal
    ) ||
    typeof Reflect.get(
      service,
      "decideAcceptance"
    ) !== "function"
  ) {
    throw new TypeError(
      "TaskSeal local acceptance requires the command-capable Provider operation journal."
    );
  }
  return createLocalLinearAcceptanceRuntime({
    cwd,
    environment,
    service:
      service as unknown as
        LocalLinearAcceptanceServicePort,
    providerOperationJournal:
      providerOperations
  });
}

function disabledAcceptanceRuntime(
  providerOperations:
    ProviderOperationJournalQueryPort
): LocalLinearAcceptanceRuntime {
  return Object.freeze({
    acceptance: null,
    providerOperations,
    capabilities: Object.freeze({
      decideAcceptance: false,
      linearTransition: false,
      reconcileLinearTransition: false
    }),
    operatorId: null
  });
}

function readMaxConcurrentRuns(
  value: string | undefined
): number {
  if (value === undefined) {
    return 1;
  }

  if (!/^[1-8]$/.test(value)) {
    throw new TypeError(
      "TaskSeal max concurrent runs must be between 1 and 8."
    );
  }

  return Number(value);
}

function installShutdownHandlers({
  server,
  signalSource,
  output
}: {
  server: ControlRoomServerPort;
  signalSource: SignalSourcePort;
  output: OutputPort;
}): void {
  let shuttingDown = false;

  const cleanup = () => {
    signalSource.removeListener("SIGINT", handleSignal);
    signalSource.removeListener("SIGTERM", handleSignal);
  };
  const handleSignal = () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    shutdownServer(server)
      .catch((error) => {
        output.write(
          `TaskSeal shutdown failed: ${renderSafeMessage(error)}\n`
        );
        signalSource.exitCode = 1;
      })
      .finally(cleanup);
  };

  signalSource.once("SIGINT", handleSignal);
  signalSource.once("SIGTERM", handleSignal);
  server.once("close", cleanup);
}

async function shutdownServer(
  server: ControlRoomServerPort
): Promise<void> {
  if (typeof server.shutdown === "function") {
    await server.shutdown();
    return;
  }

  if (typeof server.close !== "function") {
    throw new TypeError(
      "TaskSeal server does not support shutdown."
    );
  }

  await new Promise<void>((resolve, reject) => {
    server.close?.((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function renderSafeMessage(error: unknown): string {
  return readErrorMessage(
    error,
    "Unknown shutdown error."
  ).slice(0, 2_000);
}

function runCommand(
  command: string,
  args: string[],
  { cwd }: { cwd: string }
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout,
        stderr
      });
    });
  });
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

const invokedPath = process.argv[1];
const isMain =
  typeof invokedPath === "string" &&
  import.meta.url === pathToFileURL(invokedPath).href;

export async function runTaskSealCli(): Promise<CliExitCode> {
  return runCli({
    providerObservationCoordinatorFactory: async ({
      cwd,
      clock
    }) =>
      (
        await createLocalProviderObservationRuntime({
          cwd,
          clock
        })
      ).coordinator
  });
}

if (isMain) {
  process.exitCode =
    await runTaskSealCli();
}
