#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  inspectFeishuHealthProvider,
  inspectFeishuProvider,
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
  probeConfiguration
} from "./application/connection-probe.ts";
import type {
  ConnectionProbeProvider
} from "./application/connection-probe.ts";
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
  acquireControlRoomLock,
  readControlRoomInstance
} from "./application/control-room-lock.ts";
import {
  collectProjectWorkItems,
  createProjectOperationsQuery
} from "./application/project-operations-query.ts";
import type {
  ProjectOperationsView
} from "./application/project-operations-query.ts";
import type {
  AcquireControlRoomLockOptions,
  ControlRoomLock
} from "./application/control-room-lock.ts";
import {
  initializeDemo,
  initializeProject
} from "./application/project-initialization.ts";
import {
  assessRuntimeReadiness,
  renderRuntimeReadiness,
  resolveCodexInvocation,
  runCommand
} from "./application/runtime-readiness.ts";
import {
  DEFAULT_CONTROL_ROOM_PORT,
  inspectConfiguration,
  resolveUserConfigurationPath
} from "./application/configuration-control.ts";
import {
  editConfigurationDraft,
  launchConfigurationEditor
} from "./application/configuration-editor.ts";
import {
  createLocalConfigurationAuthority,
  resolveConfigurationAuthority
} from "./application/configuration-authority.ts";
import type {
  ConfigurationChangeInput,
  ConfigurationFieldView,
  InspectConfigurationOptions,
  ConfigurationView
} from "./application/configuration-control.ts";
import type {
  ConfigurationEditor
} from "./application/configuration-editor.ts";
import type {
  ConfigurationAuthority
} from "./application/configuration-authority.ts";
import {
  createPresentation,
  resolveLocale
} from "./presentation/i18n.ts";
import type {
  LocalizedPresentation,
  SupportedLocale
} from "./presentation/i18n.ts";
import type {
  AssessRuntimeReadinessOptions,
  CommandRunner,
  RuntimeReadiness
} from "./application/runtime-readiness.ts";
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
import {
  projectHomeSnapshot
} from "./dashboard/home-projection.ts";
import { FileEventJournal } from "./storage/event-journal.ts";
import {
  FileProviderObservationStorage
} from "./storage/provider-observation-store.ts";
import {
  FileProviderOperationJournalStorage
} from "./storage/provider-operation-journal.ts";
import type {
  ManagedField,
  WorkItem
} from "./domain/workflow.ts";
import type {
  ManagedRunnerResult,
  ManagedRunnerRunOptions
} from "./application/managed-attempt-runner.ts";
import type {
  PersistentAcceptancePort,
  PersistentConfigurationPort,
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

export {
  assessRuntimeReadiness as collectDiagnostics,
  resolveCodexInvocation
};
export type {
  CommandResult,
  CommandRunner
} from "./application/runtime-readiness.ts";

export type CliExitCode = 0 | 1 | 2;

export interface OutputPort {
  write(value: string): unknown;
}

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

type FeishuCommandOptions = {
  workItemId: string;
  requiredEvidence: string[];
  snapshotVersion: 2;
  managedFields: ManagedField[];
};

type FeishuInspectOptions =
  FeishuCommandOptions & {
    cwd: string;
    configuration?: ProjectConfiguration | undefined;
  };

interface FeishuHealthInspectOptions {
  cwd: string;
  configuration?: ProjectConfiguration | undefined;
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
type InspectFeishu = (
  options: FeishuInspectOptions
) => unknown | Promise<unknown>;
type InspectFeishuHealth = (
  options: FeishuHealthInspectOptions
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
  environment?: NodeJS.ProcessEnv | undefined;
}

type StartControlRoom = (
  options: StartControlRoomOptions
) => unknown | Promise<unknown>;

type StartSetupRuntime = (
  options: StartSetupRuntimeOptions
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
  environment?: NodeJS.ProcessEnv | undefined;
  userConfigurationPath?: string | null | undefined;
  detectedLocales?: readonly string[] | undefined;
  startControlRoom?: StartControlRoom | undefined;
  startSetupRuntime?: StartSetupRuntime | undefined;
  runWorkItem?: RunCliWorkItem | undefined;
  inspectGitHubIssue?: InspectGitHubIssue | undefined;
  inspectGitHub?: InspectGitHub | undefined;
  inspectLinear?: InspectLinear | undefined;
  inspectGitee?: InspectGitee | undefined;
  inspectGiteeHealth?: InspectGiteeHealth | undefined;
  inspectFeishu?: InspectFeishu | undefined;
  inspectFeishuHealth?: InspectFeishuHealth | undefined;
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
  configurationEditor?: ConfigurationEditor | undefined;
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

interface ParsedRunArguments {
  workItemId: string;
  prompt?: string | undefined;
  workspaceAccess:
    | "read-only"
    | "workspace-write";
}

interface ParsedGlobalArguments {
  readonly args: string[];
  readonly language:
    | "auto"
    | SupportedLocale
    | undefined;
}

interface ParsedStatusArguments {
  readonly json: boolean;
  readonly watch: boolean;
}

type ParsedWorkCommand =
  | { readonly action: "list"; readonly json: boolean }
  | { readonly action: "show"; readonly workItemId: string; readonly json: boolean };

type ParsedConfigurationCommand =
  | {
      readonly action: "list" | "validate";
      readonly json: boolean;
    }
  | {
      readonly action: "template";
      readonly provider: ProviderTemplateName;
      readonly json: boolean;
    }
  | {
      readonly action: "get";
      readonly field: string;
      readonly json: boolean;
    }
  | {
      readonly action: "set";
      readonly field: string;
      readonly value: string;
      readonly json: boolean;
    }
  | {
      readonly action: "unset";
      readonly field: string;
      readonly json: boolean;
    }
  | {
      readonly action: "edit";
      readonly scope: "user" | "project" | "local";
      readonly json: boolean;
    };

type ProviderTemplateName =
  | "github"
  | "linear"
  | "feishu"
  | "gitee";

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
  assessReadiness?:
    | ((
        options: AssessRuntimeReadinessOptions
      ) => Promise<RuntimeReadiness>)
    | undefined;
  initialize?:
    | ((
        options: {
          readonly cwd: string;
        }
      ) => unknown | Promise<unknown>)
    | undefined;
  acquireLock?:
    | ((
        options:
          AcquireControlRoomLockOptions
      ) =>
        | ControlRoomLock
        | Promise<ControlRoomLock>)
    | undefined;
  resolveAuthority?:
    | typeof resolveConfigurationAuthority
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
          configuration?: PersistentConfigurationPort | null | undefined;
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

interface StartSetupRuntimeOptions {
  cwd: string;
  output: OutputPort;
  environment?: NodeJS.ProcessEnv | undefined;
  commandRunner?: CommandRunner | undefined;
  assessReadiness?:
    ((options: AssessRuntimeReadinessOptions) => Promise<RuntimeReadiness>) |
    undefined;
  configurationAuthorityFactory?:
    ((context: InspectConfigurationOptions) => ConfigurationAuthority) |
    undefined;
  serverFactory?: typeof createTaskSealServer | undefined;
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

const USAGE = `Usage:
  taskseal help [command]
  taskseal init
  taskseal demo init
  taskseal setup
  taskseal integration test <github|linear|gitee|feishu> [--json]
  taskseal doctor
  taskseal status [--watch] [--json]
  taskseal config list [--json] [--lang auto|en|zh-CN]
  taskseal config get <field> [--json] [--lang auto|en|zh-CN]
  taskseal config validate [--json] [--lang auto|en|zh-CN]
  taskseal config set <field> <value> [--json] [--lang auto|en|zh-CN]
  taskseal config unset <field> [--json] [--lang auto|en|zh-CN]
  taskseal config edit <user|project|local> [--json] [--lang auto|en|zh-CN]
  taskseal config template <github|linear|feishu|gitee> [--json]
  taskseal start
  taskseal work list [--json]
  taskseal work show <work-item> [--json]
  taskseal plugin check <manifest.json>
  taskseal run <work-item-id> [--prompt <text>] [--read-only|--workspace-write]
  taskseal inspect github-issue --issue <number> --work-item <id> --criterion <key> [--snapshot-version 2 --title-management provider|none]
  taskseal inspect github --issue <number> --pr <number> --check <name> --work-item <id> --attempt <id> --criterion <key> [--snapshot-version 2 --title-management provider|none]
  taskseal inspect linear --issue <identifier-or-uuid> --work-item <id> --criterion <key> [--snapshot-version 2 --title-management provider|none]
  taskseal inspect gitee-health
  taskseal inspect gitee --issue <case-sensitive-reference> --work-item <id> --criterion <key> --snapshot-version 2 --title-management provider|none
  taskseal inspect feishu-health
  taskseal inspect feishu --work-item <id> --criterion <key> --snapshot-version 2 --title-management provider|none
  taskseal ready linear
  taskseal ready linear --mode preview --issue <uuid> --work-item <id> --criterion <key>
  taskseal ready linear --mode apply --issue <uuid> --work-item <id> --criterion <key> --expected-plan-digest <sha256>
  taskseal reconcile github --mode preview --work-item <id>
  taskseal reconcile github --mode apply --work-item <id> --expected-plan-digest <sha256>
  taskseal sync linear --dry-run [--source <repository-relative-path>]
`;

const CONFIGURATION_HELP_NOTE = `
Provider templates are safe configuration fragments for config/project.json.
They do not read the current project and do not include credentials.
`;

const HELP_TOPICS = new Set([
  "init",
  "demo",
  "setup",
  "integration",
  "doctor",
  "status",
  "config",
  "start",
  "work",
  "plugin",
  "run",
  "inspect",
  "ready",
  "reconcile",
  "sync"
]);

const PROVIDER_CONFIGURATION_TEMPLATES: Record<
  ProviderTemplateName,
  Record<string, unknown>
> = {
  github: {
    github: {
      repository: "owner/repository",
      delivery: {
        enabled: false,
        mappingIndex: "config/github-delivery-map.json"
      }
    }
  },
  linear: {
    linear: {
      workspace: "workspace-key",
      team: "team-key",
      project: "Project Name",
      backlogState: "Backlog",
      readyWork: {
        enabled: false,
        readyState: "Todo",
        completedState: "Done",
        dependencyIndex: "config/linear-dependency-map.json"
      },
      acceptance: {
        enabled: false
      }
    }
  },
  feishu: {
    feishu: {
      enabled: true,
      tableScopeKey: `feishu:table:sha256:${"0".repeat(64)}`
    }
  },
  gitee: {
    gitee: {
      repository: "owner/repository"
    }
  }
};

const PROVIDER_TEMPLATE_PLACEHOLDERS: Record<
  ProviderTemplateName,
  readonly string[]
> = {
  github: ["github.repository"],
  linear: [
    "linear.workspace",
    "linear.team",
    "linear.project"
  ],
  feishu: ["feishu.tableScopeKey"],
  gitee: ["gitee.repository"]
};

export async function runCli({
  args = process.argv.slice(2),
  cwd = process.cwd(),
  output = process.stdout,
  now = () => new Date(),
  commandRunner = runCommand,
  nodeVersion = process.versions.node,
  environment = process.env,
  userConfigurationPath = null,
  detectedLocales = ["en"],
  startControlRoom = startPersistentControlRoom,
  startSetupRuntime: startSetupRuntimeOverride,
  runWorkItem,
  inspectGitHubIssue,
  inspectGitHub,
  inspectLinear,
  inspectGitee,
  inspectGiteeHealth,
  inspectFeishu,
  inspectFeishuHealth,
  createLinearDryRun,
  executeLinearReadyWork,
  executeGitHubReconciliation,
  providerObservationCoordinatorFactory,
  checkPluginManifest,
  configurationEditor
}: RunCliOptions = {}): Promise<CliExitCode> {
  const globalArguments = parseGlobalArguments(args);
  if (globalArguments === null) {
    output.write(USAGE);
    return 2;
  }
  args = globalArguments.args;
  const command = args[0] ?? "start";

  if (
    command === "help" ||
    command === "--help"
  ) {
    if (command === "--help" || args.length === 1) {
      output.write(USAGE);
      return 0;
    }
    if (args.length !== 2) {
      output.write(USAGE);
      return 2;
    }
    const topic = args[1];
    const help =
      typeof topic === "string"
        ? renderCommandHelp(topic)
        : null;
    output.write(help ?? USAGE);
    return help === null ? 2 : 0;
  }

  if (
    args.length === 2 &&
    (args[1] === "--help" || args[1] === "-h")
  ) {
    const help = renderCommandHelp(command);
    output.write(help ?? USAGE);
    return help === null ? 2 : 0;
  }

  if (command === "--version") {
    output.write(
      `${TASKSEAL_PACKAGE_VERSION}\n`
    );
    return 0;
  }

  if (command === "config") {
    const configurationCommand =
      parseConfigurationCommand(args.slice(1));
    if (configurationCommand === null) {
      output.write(renderCommandHelp("config")!);
      return 2;
    }

    if (configurationCommand.action === "template") {
      output.write(renderProviderConfigurationTemplate(
        configurationCommand.provider,
        configurationCommand.json
      ));
      return 0;
    }

    const context = {
      cwd,
      userConfigurationPath:
        userConfigurationPath === undefined
          ? resolveUserConfigurationPath({ environment })
          : userConfigurationPath,
      environment
    } as const;
    try {
      const authority = await resolveConfigurationAuthority(context);
      const view = await authority.inspect();
      const presentation = createPresentation(
        resolveLocale({
          command: globalArguments.language,
          user: readConfigurationLocale(view),
          detected: detectedLocales
        })
      );
      return runConfigurationCommand({
        command: configurationCommand,
        view,
        output,
        presentation,
        context,
        authority,
        editor:
          configurationEditor ??
          ((request) => launchConfigurationEditor({
            ...request,
            environment
          }))
      });
    } catch (error) {
      const code = readConfigurationErrorCode(error);
      if (configurationCommand.json) {
        output.write(`${JSON.stringify({
          schemaVersion: "configuration-error/v1",
          code
        }, null, 2)}\n`);
      } else {
        const presentation = createPresentation(
          resolveLocale({
            command: globalArguments.language,
            detected: detectedLocales
          })
        );
        output.write(`${presentation.message("config.write.failed", {
          code
        })}\n`);
      }
      return 1;
    }
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
    const result =
      await initializeProject({ cwd });
    output.write(
      result.configurationCreated
        ? `Initialized TaskSeal project ${result.project}.\n`
        : `TaskSeal project ${result.project} is already initialized.\n`
    );
    return 0;
  }

  if (
    command === "demo" &&
    args.length === 2 &&
    args[1] === "init"
  ) {
    const result =
      await initializeDemo({
        cwd,
        now
      });
    output.write(
      result.workItemCreated
        ? `Initialized TaskSeal demo with ${result.workItemId}.\n`
        : `TaskSeal demo is already initialized with ${result.workItemId}.\n`
    );
    return 0;
  }

  if (command === "setup") {
    if (args.length !== 1) {
      output.write(USAGE);
      return 2;
    }
    try {
      await (startSetupRuntimeOverride ?? startSetupRuntime)({
        cwd,
        output,
        environment,
        commandRunner
      });
      return 0;
    } catch (error) {
      output.write(renderSetupError(error));
      return 1;
    }
  }

  if (command === "integration") {
    const parsed = parseIntegrationTestArguments(args.slice(1));
    if (!parsed) {
      output.write(USAGE);
      return 2;
    }
    try {
      const configuration = await inspectConfiguration({
        cwd,
        environment,
        userConfigurationPath:
          userConfigurationPath === undefined
            ? resolveUserConfigurationPath({ environment })
            : userConfigurationPath
      });
      const result = probeConfiguration({
        provider: parsed.provider,
        expectedConfigurationRevision: configuration.revision,
        configuration,
        providerSync: null
      });
      output.write(parsed.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : renderIntegrationProbe(result));
      return 0;
    } catch (error) {
      output.write(
        `TaskSeal integration test failed${renderErrorCode(error)}: ${readErrorMessage(
          error,
          "Unable to inspect the selected provider."
        ).slice(0, 2_000)}\n`
      );
      return 1;
    }
  }

  if (command === "status") {
    const parsed = parseStatusArguments(args.slice(1));
    if (parsed === null) {
      output.write(USAGE);
      return 2;
    }
    try {
      const operations = await readProjectOperations({
        cwd,
        environment,
        now
      });
      output.write(parsed.json
        ? `${JSON.stringify({
            ...operations,
            watch: parsed.watch
          }, null, 2)}\n`
        : renderProjectOperationsStatus(operations, parsed.watch));
      return 0;
    } catch (error) {
      output.write(
        `TaskSeal status failed${renderErrorCode(error)}: ${readErrorMessage(
          error,
          "Unable to read project operations."
        ).slice(0, 2_000)}\n`
      );
      return 1;
    }
  }

  if (command === "work") {
    const parsed = parseWorkCommand(args.slice(1));
    if (parsed === null) {
      output.write(USAGE);
      return 2;
    }
    try {
      const operations = await readProjectOperations({
        cwd,
        environment,
        now,
        workItemId:
          parsed.action === "show"
            ? parsed.workItemId
            : undefined
      });
      if (parsed.action === "show" && operations.selected?.workItem === null) {
        output.write(
          `TaskSeal work item ${parsed.workItemId} does not exist.\n`
        );
        return 1;
      }
      output.write(parsed.json
        ? `${JSON.stringify({
            schemaVersion: parsed.action === "show"
              ? "work-item/v1"
              : "work-items/v1",
            generatedAt: operations.generatedAt,
            runtime: operations.runtime,
            ...(parsed.action === "show"
              ? {
                  projectRef: operations.selected?.projectRef ?? "current",
                  workItem: operations.selected?.workItem ?? null
                }
              : {
                  workItems: listProjectWorkItems(operations)
                })
          }, null, 2)}\n`
        : parsed.action === "show"
          ? renderWorkItem(operations)
          : renderWorkItemList(operations));
      return 0;
    } catch (error) {
      output.write(
        `TaskSeal work query failed${renderErrorCode(error)}: ${readErrorMessage(
          error,
          "Unable to read work items."
        ).slice(0, 2_000)}\n`
      );
      return 1;
    }
  }

  if (command === "doctor") {
    const resolvedUserConfigurationPath =
      userConfigurationPath === undefined
        ? resolveUserConfigurationPath({ environment })
        : userConfigurationPath;
    const diagnostics = await assessRuntimeReadiness({
      cwd,
      commandRunner,
      nodeVersion,
      environment,
      userConfigurationPath: resolvedUserConfigurationPath
    });
    const configurationView = await inspectConfiguration({
      cwd,
      environment,
      userConfigurationPath: resolvedUserConfigurationPath
    });
    const presentation = createPresentation(
      resolveLocale({
        command: globalArguments.language,
        user: readConfigurationLocale(configurationView),
        detected: detectedLocales
      })
    );
    output.write(
      presentation.locale === "en"
        ? renderRuntimeReadiness(diagnostics)
        : renderLocalizedRuntimeReadiness(
            diagnostics,
            presentation
          )
    );
    return diagnostics.ready ? 0 : 1;
  }

  if (command === "start") {
    try {
      if (
        args.length === 0 &&
        startControlRoom === startPersistentControlRoom
      ) {
        const readiness = await assessRuntimeReadiness({
          cwd,
          commandRunner,
          nodeVersion,
          environment,
          userConfigurationPath:
            userConfigurationPath === undefined
              ? resolveUserConfigurationPath({ environment })
              : userConfigurationPath
        });
        if (!readiness.ready) {
          await (startSetupRuntimeOverride ?? startSetupRuntime)({
            cwd,
            output,
            environment,
            commandRunner
          });
          return 0;
        }
      }
      await startControlRoom({ cwd, output, environment });
      return 0;
    } catch (error) {
      let presentation = createPresentation(
        resolveLocale({
          command: globalArguments.language,
          detected: detectedLocales
        })
      );
      try {
        const configurationView = await inspectConfiguration({
          cwd,
          environment,
          userConfigurationPath:
            userConfigurationPath === undefined
              ? resolveUserConfigurationPath({ environment })
              : userConfigurationPath
        });
        presentation = createPresentation(
          resolveLocale({
            command: globalArguments.language,
            user: readConfigurationLocale(configurationView),
            detected: detectedLocales
          })
        );
      } catch {
        // The start error remains authoritative and safely renderable.
      }
      output.write(renderStartError(error, presentation));
      return isRecord(error) &&
        error.code === "CONTROL_ROOM_ALREADY_RUNNING" &&
        error.verified === true
        ? 0
        : 1;
    }
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
          sandbox: options.workspaceAccess
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

    if (provider === "feishu-health") {
      if (args.length !== 2) {
        output.write(USAGE);
        return 2;
      }

      try {
        const execute =
          inspectFeishuHealth ??
          inspectFeishuHealthProvider;
        const health =
          await executeObservedProviderInspection({
            cwd,
            clock: now,
            provider: "feishu",
            kind: "health",
            coordinatorFactory:
              providerObservationCoordinatorFactory,
            execute: (configuration) =>
              execute({
                cwd,
                ...(configuration === null
                  ? {}
                  : { configuration })
              })
          });
        output.write(
          `${JSON.stringify(health, null, 2)}\n`
        );
        return 0;
      } catch (error) {
        output.write(renderInspectError(error));
        return 1;
      }
    }

    if (provider === "feishu") {
      const options = parseFeishuInspectArguments(
        args.slice(2)
      );
      if (!options) {
        output.write(USAGE);
        return 2;
      }

      try {
        const execute =
          inspectFeishu ?? inspectFeishuProvider;
        const snapshot =
          await executeObservedProviderInspection({
            cwd,
            clock: now,
            provider: "feishu",
            kind: "snapshot",
            missingEvidence:
              options.requiredEvidence,
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
        output.write(
          `${JSON.stringify(snapshot, null, 2)}\n`
        );
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
    "gitee",
    "feishu"
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
      if (
        provider === "github" ||
        provider === "linear"
      ) {
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

function parseGlobalArguments(
  input: readonly string[]
): ParsedGlobalArguments | null {
  const args: string[] = [];
  let language:
    | ParsedGlobalArguments["language"];

  for (let index = 0; index < input.length; index += 1) {
    const argument = input[index]!;
    if (argument !== "--lang") {
      args.push(argument);
      continue;
    }

    const value = input[index + 1];
    if (
      language !== undefined ||
      (value !== "auto" && value !== "en" && value !== "zh-CN")
    ) {
      return null;
    }
    language = value;
    index += 1;
  }

  return { args, language };
}

function renderCommandHelp(topic: string): string | null {
  if (!HELP_TOPICS.has(topic)) {
    return null;
  }
  const commandPrefix = `  taskseal ${topic}`;
  const commandLines = USAGE
    .split("\n")
    .filter((line) => line.startsWith(commandPrefix));
  const note = topic === "config"
    ? CONFIGURATION_HELP_NOTE
    : "\nRun `taskseal help` to see all commands.\n";
  return `Usage:\n${commandLines.join("\n")}\n${note}`;
}

function renderProviderConfigurationTemplate(
  provider: ProviderTemplateName,
  json: boolean
): string {
  const fragment = PROVIDER_CONFIGURATION_TEMPLATES[provider];
  if (json) {
    return `${JSON.stringify({
      schemaVersion: "configuration-template/v1",
      provider,
      credentialPolicy: "not-included",
      replaceBeforeUse: PROVIDER_TEMPLATE_PLACEHOLDERS[provider],
      fragment
    }, null, 2)}\n`;
  }
  return [
    `# ${provider} provider configuration template`,
    "# Merge this fragment into config/project.json.",
    `# Replace before use: ${PROVIDER_TEMPLATE_PLACEHOLDERS[provider].join(", ")}.`,
    "# Credentials are not included; keep them in supported environment bindings.",
    JSON.stringify(fragment, null, 2),
    ""
  ].join("\n");
}

function parseConfigurationCommand(
  input: readonly string[]
): ParsedConfigurationCommand | null {
  const jsonCount = input.filter((value) => value === "--json").length;
  if (jsonCount > 1) {
    return null;
  }
  const args = input.filter((value) => value !== "--json");
  const json = jsonCount === 1;

  if (
    args.length === 1 &&
    (args[0] === "list" || args[0] === "validate")
  ) {
    return { action: args[0], json };
  }
  if (
    args.length === 2 &&
    args[0] === "template" &&
    (args[1] === "github" ||
      args[1] === "linear" ||
      args[1] === "feishu" ||
      args[1] === "gitee")
  ) {
    return {
      action: "template",
      provider: args[1],
      json
    };
  }
  if (
    args.length === 2 &&
    (args[0] === "get" || args[0] === "unset") &&
    typeof args[1] === "string" &&
    /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(args[1])
  ) {
    return { action: args[0], field: args[1], json };
  }
  if (
    args.length === 2 &&
    args[0] === "edit" &&
    (args[1] === "user" ||
      args[1] === "project" ||
      args[1] === "local")
  ) {
    return { action: "edit", scope: args[1], json };
  }
  if (
    args.length === 3 &&
    args[0] === "set" &&
    typeof args[1] === "string" &&
    typeof args[2] === "string" &&
    /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(args[1])
  ) {
    return {
      action: "set",
      field: args[1],
      value: args[2],
      json
    };
  }
  return null;
}

async function runConfigurationCommand({
  command,
  view,
  output,
  presentation,
  context,
  authority,
  editor
}: {
  readonly command: ParsedConfigurationCommand;
  readonly view: ConfigurationView;
  readonly output: OutputPort;
  readonly presentation: LocalizedPresentation;
  readonly context: InspectConfigurationOptions;
  readonly authority: ConfigurationAuthority;
  readonly editor: ConfigurationEditor;
}): Promise<CliExitCode> {
  if (command.action === "list") {
    if (command.json) {
      output.write(`${JSON.stringify(view, null, 2)}\n`);
      return 0;
    }
    const lines = [
      presentation.message(
        view.ready ? "config.list.ready" : "config.list.invalid"
      ),
      ...view.fields.map((field) =>
        renderConfigurationField(field, presentation)
      ),
      ...view.diagnostics.map((diagnostic) =>
        presentation.message(diagnostic.messageKey)
      )
    ];
    output.write(`${lines.join("\n")}\n`);
    return 0;
  }

  if (command.action === "get") {
    const field = view.fields.find(
      (candidate) => candidate.key === command.field
    );
    if (field === undefined) {
      if (command.json) {
        output.write(`${JSON.stringify({
          schemaVersion: "configuration-field/v1",
          field: command.field,
          found: false,
          code: "CONFIG_FIELD_NOT_FOUND"
        }, null, 2)}\n`);
      } else {
        output.write(`${presentation.message("config.field.notFound", {
          field: command.field
        })}\n`);
      }
      return 1;
    }
    if (command.json) {
      output.write(`${JSON.stringify({
        schemaVersion: "configuration-field/v1",
        found: true,
        field
      }, null, 2)}\n`);
    } else {
      output.write(`${renderConfigurationField(field, presentation)}\n`);
    }
    return 0;
  }

  if (command.action === "edit") {
    try {
      const receipt = await editConfigurationDraft({
        context,
        scope: command.scope,
        editor,
        authority
      });
      if (command.json) {
        output.write(`${JSON.stringify(receipt, null, 2)}\n`);
      } else {
        const lines = [
          presentation.message(
            receipt.replayed
              ? "config.edit.replayed"
              : "config.edit.applied",
            {
              scope: presentation.message(
                `config.scope.${command.scope}`
              )
            }
          ),
          ...(receipt.restartRequired
            ? [presentation.message("config.write.restartRequired")]
            : [])
        ];
        output.write(`${lines.join("\n")}\n`);
      }
      return 0;
    } catch (error) {
      const code = readConfigurationErrorCode(error);
      if (command.json) {
        output.write(`${JSON.stringify({
          schemaVersion: "configuration-error/v1",
          code
        }, null, 2)}\n`);
      } else {
        output.write(`${presentation.message("config.write.failed", {
          code
        })}\n`);
      }
      return 1;
    }
  }

  if (
    command.action === "set" ||
    command.action === "unset"
  ) {
    const change: ConfigurationChangeInput =
      command.action === "set"
        ? {
            operation: "set",
            key: command.field,
            value: parseConfigurationCliValue(
              command.field,
              command.value
            )
          }
        : {
            operation: "unset",
            key: command.field
          };
    try {
      const receipt = await authority.applyChange(
        change,
        view.revision
      );
      if (command.json) {
        output.write(`${JSON.stringify(receipt, null, 2)}\n`);
      } else {
        const lines = [
          presentation.message(
            receipt.replayed
              ? "config.write.replayed"
              : command.action === "set"
                ? "config.write.set"
                : "config.write.unset",
            { field: command.field }
          ),
          ...(receipt.restartRequired
            ? [presentation.message("config.write.restartRequired")]
            : [])
        ];
        output.write(`${lines.join("\n")}\n`);
      }
      return 0;
    } catch (error) {
      const code = readConfigurationErrorCode(error);
      if (command.json) {
        output.write(`${JSON.stringify({
          schemaVersion: "configuration-error/v1",
          code
        }, null, 2)}\n`);
      } else {
        output.write(`${presentation.message("config.write.failed", {
          code
        })}\n`);
      }
      return 1;
    }
  }

  const validation = {
    schemaVersion: "configuration-validation/v1",
    valid: view.ready,
    revision: view.revision,
    diagnostics: view.diagnostics
  } as const;
  if (command.json) {
    output.write(`${JSON.stringify(validation, null, 2)}\n`);
  } else {
    const lines = [
      presentation.message(
        view.ready
          ? "config.validation.ready"
          : "config.validation.invalid"
      ),
      ...view.diagnostics.map((diagnostic) =>
        presentation.message(diagnostic.messageKey)
      )
    ];
    output.write(`${lines.join("\n")}\n`);
  }
  return view.ready ? 0 : 1;
}

function parseConfigurationCliValue(
  key: string,
  value: string
): string | number | boolean {
  if (key === "runtime.port") {
    return /^\d+$/.test(value)
      ? Number(value)
      : value;
  }
  if (
    key.endsWith(".enabled") &&
    (value === "true" || value === "false")
  ) {
    return value === "true";
  }
  return value;
}

function readConfigurationErrorCode(error: unknown): string {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    (/^CONFIG_[A-Z_]+$/.test(error.code) ||
      error.code === "CONTROL_ROOM_HANDOFF_UNAVAILABLE")
    ? error.code
    : "CONFIG_WRITE_FAILED";
}

function renderConfigurationField(
  field: ConfigurationFieldView,
  presentation: LocalizedPresentation
): string {
  return presentation.message("config.field.value", {
    field: field.key,
    value: String(field.value),
    source: field.source
  });
}

function readConfigurationLocale(
  view: ConfigurationView
): unknown {
  return view.fields.find((field) => field.key === "ui.locale")?.value;
}

function renderLocalizedRuntimeReadiness(
  readiness: RuntimeReadiness,
  presentation: LocalizedPresentation
): string {
  const capabilityNames = {
    github: presentation.message("doctor.integration.github"),
    linear: presentation.message("doctor.integration.linear"),
    gitee: presentation.message("doctor.integration.gitee"),
    feishu: presentation.message("doctor.integration.feishu")
  } as const;
  const lines = [
    presentation.message(
      readiness.node.ready
        ? "doctor.node.ready"
        : "doctor.node.invalid",
      {
        version: readiness.node.version,
        failure: readiness.node.failure
      }
    ),
    presentation.message(
      readiness.project.ready
        ? "doctor.project.ready"
        : "doctor.project.invalid"
    ),
    presentation.message(
      readiness.codex.available
        ? "doctor.codex.ready"
        : "doctor.codex.invalid",
      { version: readiness.codex.version ?? "" }
    ),
    presentation.message(
      readiness.codex.loggedIn
        ? "doctor.login.ready"
        : "doctor.login.invalid"
    ),
    ...(
      Object.keys(capabilityNames) as Array<keyof typeof capabilityNames>
    ).map((provider) =>
      presentation.message(
        `doctor.capability.${readiness.capabilities[provider]}` as
          | "doctor.capability.ready"
          | "doctor.capability.disabled"
          | "doctor.capability.invalid",
        { name: capabilityNames[provider] }
      )
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
  let workspaceWrite = false;

  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];

    if (option === "--read-only" && !readOnly) {
      readOnly = true;
      continue;
    }

    if (
      option === "--workspace-write" &&
      !workspaceWrite
    ) {
      workspaceWrite = true;
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

  if (readOnly && workspaceWrite) {
    return null;
  }

  return {
    workItemId,
    ...(prompt === undefined ? {} : { prompt }),
    workspaceAccess: workspaceWrite
      ? "workspace-write"
      : "read-only"
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

function parseFeishuInspectArguments(
  args: readonly string[]
): FeishuCommandOptions | null {
  const parsed = parseVersionedInspectArguments(args, [
    "--work-item",
    "--criterion"
  ]);
  if (
    !parsed ||
    parsed.versionOptions.snapshotVersion !== 2
  ) {
    return null;
  }

  return {
    workItemId: readNamedArgument(
      parsed.values,
      "--work-item"
    ),
    requiredEvidence: [
      readNamedArgument(
        parsed.values,
        "--criterion"
      )
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

function renderStartError(
  error: unknown,
  presentation: LocalizedPresentation
): string {
  if (
    isRecord(error) &&
    error.code === "CONTROL_ROOM_PORT_UNAVAILABLE"
  ) {
    return `${presentation.message("start.portUnavailable")}\n`;
  }
  if (
    isRecord(error) &&
    error.code === "CONTROL_ROOM_ALREADY_RUNNING"
  ) {
    return `${presentation.message("start.alreadyRunning")}\n`;
  }
  return `${presentation.message("start.failed", {
    code: renderErrorCode(error)
  })}\n`;
}

function renderSetupError(error: unknown): string {
  const code = renderErrorCode(error);
  if (
    isRecord(error) &&
    error.code === "SETUP_PORT_UNAVAILABLE"
  ) {
    return `TaskSeal SetupRuntime could not bind its loopback port${code}.\n`;
  }
  return `TaskSeal SetupRuntime failed${code}: ${readErrorMessage(
    error,
    "Unknown setup error."
  ).slice(0, 2_000)}\n`;
}

function parseIntegrationTestArguments(
  args: readonly string[]
): { provider: ConnectionProbeProvider; json: boolean } | null {
  const json = args.filter((value) => value === "--json").length;
  const values = args.filter((value) => value !== "--json");
  if (
    json > 1 ||
    values.length !== 2 ||
    values[0] !== "test"
  ) {
    return null;
  }
  const provider = values[1];
  if (
    provider !== "github" &&
    provider !== "linear" &&
    provider !== "gitee" &&
    provider !== "feishu"
  ) {
    return null;
  }
  return { provider, json: json === 1 };
}

function renderIntegrationProbe(result: {
  readonly provider: string;
  readonly status: string;
  readonly networkAttempted: boolean;
  readonly summary: string;
}): string {
  return [
    `Provider: ${result.provider}`,
    `Status: ${result.status}`,
    `Network: ${result.networkAttempted ? "attempted" : "not attempted"}`,
    result.summary,
    ""
  ].join("\n");
}

async function readProjectOperations({
  cwd,
  environment = process.env,
  now = () => new Date(),
  workItemId
}: {
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => Date) | undefined;
  readonly workItemId?: string | undefined;
}): Promise<ProjectOperationsView> {
  const instance = await readControlRoomInstance({ cwd }).catch(() => null);
  if (instance !== null) {
    try {
      const response = await fetch(
        `http://${instance.host}:${instance.port}/api/status`,
        { signal: AbortSignal.timeout(1_500) }
      );
      if (response.ok) {
        const value: unknown = await response.json();
        if (isProjectOperationsView(value)) {
          if (workItemId === undefined) {
            return value;
          }
          const projectRef = value.selected?.projectRef ??
            value.projectHub.projects[0]?.projectRef;
          if (projectRef === undefined) {
            return value;
          }
          const project = value.projectHub.projects.find(
            (candidate) => candidate.projectRef === projectRef
          );
          const workItem = project === undefined
            ? null
            : collectProjectWorkItems(project)
                .find((candidate) => candidate.ref.workItemId === workItemId) ?? null;
          return {
            ...value,
            selected: {
              projectRef,
              workItem
            }
          };
        }
      }
    } catch {
      // A stale or fenced instance falls back to the durable journal below.
    }
  }

  let projectName = "Current project";
  try {
    const configuration = await inspectConfiguration({
      cwd,
      environment,
      userConfigurationPath: resolveUserConfigurationPath({ environment })
    });
    projectName = configuration.effective?.project ?? projectName;
  } catch {
    // An unconfigured workspace still has a useful empty operations view.
  }
  const service = await TaskSealService.open({
    journal: new FileEventJournal({
      filePath: join(cwd, ".taskseal", "events.jsonl")
    })
  });
  const home = projectHomeSnapshot({
    dashboard: service.snapshot(),
    mode: "persistent",
    project: {
      key: "current",
      name: projectName
    },
    freshness: "stale",
    runtime: {
      maxConcurrentRuns: 0,
      activeCount: 0,
      availableSlots: 0,
      runs: [],
      errors: {}
    },
    now: now()
  });
  return createProjectOperationsQuery({
    sources: [{
      projectRef: "current",
      runtime: "offline",
      async read() {
        return home;
      }
    }],
    now
  }).snapshot({ workItemId });
}

function isProjectOperationsView(value: unknown): value is ProjectOperationsView {
  return isRecord(value) &&
    value.schemaVersion === "project-operations/v1" &&
    isRecord(value.runtime) &&
    (value.runtime.mode === "live" || value.runtime.mode === "offline") &&
    isRecord(value.projectHub) &&
    value.projectHub.schemaVersion === "project-hub/v1";
}

function parseStatusArguments(
  args: readonly string[]
): ParsedStatusArguments | null {
  const jsonCount = args.filter((value) => value === "--json").length;
  const watchCount = args.filter((value) => value === "--watch").length;
  if (jsonCount > 1 || watchCount > 1) {
    return null;
  }
  const values = args.filter(
    (value) => value !== "--json" && value !== "--watch"
  );
  return values.length === 0
    ? { json: jsonCount === 1, watch: watchCount === 1 }
    : null;
}

function parseWorkCommand(
  args: readonly string[]
): ParsedWorkCommand | null {
  const jsonCount = args.filter((value) => value === "--json").length;
  if (jsonCount > 1) {
    return null;
  }
  const values = args.filter((value) => value !== "--json");
  if (values.length === 1 && values[0] === "list") {
    return { action: "list", json: jsonCount === 1 };
  }
  if (
    values.length === 2 &&
    values[0] === "show" &&
    typeof values[1] === "string" &&
    values[1].length > 0 &&
    !values[1].startsWith("-")
  ) {
    return {
      action: "show",
      workItemId: values[1],
      json: jsonCount === 1
    };
  }
  return null;
}

function listProjectWorkItems(
  operations: ProjectOperationsView
): readonly {
  readonly projectRef: string;
  readonly workItem: ReturnType<typeof collectProjectWorkItems>[number];
}[] {
  return operations.projectHub.projects.flatMap((project) =>
    collectProjectWorkItems(project).map((workItem) => ({
      projectRef: project.projectRef,
      workItem
    }))
  );
}

function renderProjectOperationsStatus(
  operations: ProjectOperationsView,
  watch: boolean
): string {
  const lines = [
    `Runtime: ${operations.runtime.mode} (${operations.runtime.freshness})`,
    `Projects: ${operations.projectHub.summary.projects}`,
    `Running now: ${operations.projectHub.summary.running}`,
    `Needs attention: ${operations.projectHub.summary.needsAttention}`,
    `Next up: ${operations.projectHub.summary.nextUp}`
  ];
  for (const project of operations.projectHub.projects) {
    lines.push(`\n[${project.projectRef}] ${project.snapshot?.project.name ?? "Unavailable"}`);
    if (project.snapshot === null) {
      lines.push("  unavailable");
      continue;
    }
    for (const task of project.snapshot.runningNow) {
      lines.push(`  RUNNING  ${task.ref.workItemId}  ${task.name}${formatElapsed(task)}`);
    }
    for (const task of project.snapshot.needsAttention) {
      lines.push(`  ATTENTION ${task.ref.workItemId}  ${task.name} → ${task.attention?.nextAction ?? "review"}`);
    }
    for (const task of project.snapshot.nextUp) {
      lines.push(`  NEXT     ${task.ref.workItemId}  ${task.name}`);
    }
  }
  if (watch) {
    lines.push("\nWatch: bounded snapshot (run again to refresh).");
  }
  return `${lines.join("\n")}\n`;
}

function renderWorkItemList(operations: ProjectOperationsView): string {
  const items = listProjectWorkItems(operations);
  if (items.length === 0) {
    return "No WorkItems found.\n";
  }
  return `${items.map(({ projectRef, workItem }) =>
    `${projectRef}  ${workItem.ref.workItemId}  ${workItem.status.code}  ${workItem.name}`
  ).join("\n")}\n`;
}

function renderWorkItem(operations: ProjectOperationsView): string {
  const task = operations.selected?.workItem;
  if (!task) {
    return "WorkItem not found.\n";
  }
  return [
    `${task.ref.workItemId}  ${task.name}`,
    `Status: ${task.status.code}`,
    `Elapsed: ${formatElapsed(task).trim() || "-"}`,
    `Evidence: ${task.deliveryGate.passed}/${task.deliveryGate.total} passed, ${task.deliveryGate.missing} missing, ${task.deliveryGate.failed} failed`,
    `Next: ${task.attention?.nextAction ?? task.nextStep?.code ?? "-"}`,
    ""
  ].join("\n");
}

function formatElapsed(
  task: ReturnType<typeof collectProjectWorkItems>[number]
): string {
  if (!task.elapsed) {
    return "";
  }
  const minutes = Math.floor(task.elapsed.elapsedMs / 60_000);
  const seconds = Math.floor(task.elapsed.elapsedMs / 1_000) % 60;
  return `  (${minutes}m ${seconds}s)`;
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

export async function startSetupRuntime({
  cwd,
  output,
  environment = process.env,
  commandRunner = runCommand,
  assessReadiness = assessRuntimeReadiness,
  configurationAuthorityFactory = createLocalConfigurationAuthority,
  serverFactory = createTaskSealServer,
  signalSource = processSignalSource
}: StartSetupRuntimeOptions): Promise<ControlRoomServerPort> {
  const host = environment.HOST ?? "127.0.0.1";
  const environmentPort =
    environment.PORT === undefined
      ? null
      : Number(environment.PORT);
  if (
    typeof host !== "string" ||
    !["127.0.0.1", "localhost", "::1"].includes(host.toLowerCase()) ||
    (environmentPort !== null &&
      (!Number.isInteger(environmentPort) ||
        environmentPort < 0 ||
        environmentPort > 65_535))
  ) {
    throw new TypeError(
      "TaskSeal SetupRuntime requires a loopback HOST and valid PORT."
    );
  }

  const userConfigurationPath =
    resolveUserConfigurationPath({ environment });
  const configurationView = await inspectConfiguration({
    cwd,
    environment,
    userConfigurationPath
  });
  const configuredPort = configurationView.fields.find(
    (field) => field.key === "runtime.port"
  )?.value;
  const port = environmentPort ??
    (typeof configuredPort === "number"
      ? configuredPort
      : DEFAULT_CONTROL_ROOM_PORT);
  const configuration = configurationAuthorityFactory({
    cwd,
    environment,
    userConfigurationPath
  });
  const server = serverFactory({
    setup: true,
    configuration,
    readiness: () => assessReadiness({
      cwd,
      commandRunner,
      environment,
      userConfigurationPath
    })
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", (error) => reject(error));
      server.listen(port, host, () => resolve());
    });
  } catch (error) {
    if (
      isRecord(error) &&
      (error.code === "EACCES" || error.code === "EADDRINUSE")
    ) {
      throw Object.assign(
        new Error("The SetupRuntime loopback port is unavailable."),
        { code: "SETUP_PORT_UNAVAILABLE" }
      );
    }
    throw error;
  }

  installShutdownHandlers({
    server,
    signalSource,
    output,
    releaseLock: async () => {}
  });
  output.write(`TaskSeal SetupRuntime: http://${host}:${port}/setup\n`);
  return server;
}

export async function startPersistentControlRoom({
  cwd,
  output,
  environment = process.env,
  commandRunner = runCommand,
  assessReadiness = assessRuntimeReadiness,
  initialize = initializeProject,
  acquireLock =
    acquireControlRoomLock,
  resolveAuthority =
    resolveConfigurationAuthority,
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
  const environmentPort =
    environment.PORT === undefined
      ? null
      : Number(environment.PORT);
  const maxConcurrentRuns =
    readMaxConcurrentRuns(
      environment.TASKSEAL_MAX_CONCURRENT_RUNS
    );

  if (
    typeof host !== "string" ||
    !["127.0.0.1", "localhost", "::1"].includes(host.toLowerCase()) ||
    (environmentPort !== null &&
      (!Number.isInteger(environmentPort) ||
        environmentPort < 0 ||
        environmentPort > 65_535))
  ) {
    throw new TypeError(
      "TaskSeal HOST must be loopback and PORT must be valid."
    );
  }

  const configurationView =
    environmentPort === null
      ? await inspectConfiguration({
          cwd,
          environment,
          userConfigurationPath:
            resolveUserConfigurationPath({ environment })
        })
      : null;
  const configuredPort =
    configurationView?.fields.find(
      (field) => field.key === "runtime.port"
    )?.value;
  const port = environmentPort ??
    (typeof configuredPort === "number"
      ? configuredPort
      : DEFAULT_CONTROL_ROOM_PORT);

  const readiness =
    await assessReadiness({
      cwd,
      commandRunner,
      environment
    });
  if (!readiness.ready) {
    throw Object.assign(
      new Error(
        "TaskSeal runtime is not ready. Run taskseal doctor for details."
      ),
      { code: "TASKSEAL_NOT_READY" }
    );
  }

  await initialize({ cwd });
  let lock: ControlRoomLock;
  try {
    lock = await acquireLock({
      cwd,
      ...(port === 0
        ? {}
        : { endpoint: { host: host.toLowerCase(), port } })
    });
  } catch (error) {
    let verifiedRunningInstance = false;
    if (
      isRecord(error) &&
      error.code === "CONTROL_ROOM_ALREADY_RUNNING"
    ) {
      try {
        const authority = await resolveAuthority({
          cwd,
          environment,
          userConfigurationPath:
            resolveUserConfigurationPath({ environment })
        });
        if (authority.kind === "running-instance") {
          await authority.inspect();
          verifiedRunningInstance = true;
        }
      } catch {
        // An unverified lock remains a hard startup failure.
      }
    }
    if (verifiedRunningInstance) {
      throw Object.assign(
        error instanceof Error
          ? error
          : new Error("The TaskSeal Control Room is already running."),
        { verified: true }
      );
    }
    throw error;
  }
  try {
    const {
      readModel:
        providerObservations
    } =
      await providerObservationRuntimeFactory({
        cwd
      });
    const providerOperations =
      await providerOperationQueryFactory({
        cwd
      });
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
        observations:
          providerObservations,
        operations:
          acceptanceRuntime
            .providerOperations
      });
    const localConfigurationAuthority =
      createLocalConfigurationAuthority({
        cwd,
        environment,
        userConfigurationPath:
          resolveUserConfigurationPath({ environment })
      });
    const activeConfigurationView =
      configurationView ??
      await localConfigurationAuthority.inspect();
    const configuration: PersistentConfigurationPort | null =
      lock.instanceId === undefined
        ? null
        : {
            instanceId: lock.instanceId,
            activeRuntimeRevision:
              activeConfigurationView.runtimeRevision,
            inspect: localConfigurationAuthority.inspect,
            readDraft: localConfigurationAuthority.readDraft,
            applyChange: localConfigurationAuthority.applyChange,
            applyDraft: localConfigurationAuthority.applyDraft
          };
    const server = serverFactory({
      service,
      providerStatus,
      configuration,
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
          instruction:
            options.prompt,
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

    try {
      await new Promise<void>(
        (resolve, reject) => {
          server.once(
            "error",
            (error) => reject(error)
          );
          server.listen(
            port,
            host,
            () => resolve()
          );
        }
      );
    } catch (error) {
      if (
        isRecord(error) &&
        (error.code === "EACCES" || error.code === "EADDRINUSE")
      ) {
        throw Object.assign(
          new Error("The Control Room port is unavailable."),
          { code: "CONTROL_ROOM_PORT_UNAVAILABLE" }
        );
      }
      throw error;
    }

    installShutdownHandlers({
      server,
      signalSource,
      output,
      releaseLock: () =>
        lock.release()
    });
    output.write(
      `TaskSeal Control Room: http://${host}:${port}\n`
    );
    return server;
  } catch (error) {
    await lock.release();
    throw error;
  }
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
  output,
  releaseLock
}: {
  server: ControlRoomServerPort;
  signalSource: SignalSourcePort;
  output: OutputPort;
  releaseLock: () => Promise<void>;
}): void {
  let shuttingDown = false;
  let release:
    Promise<void> | undefined;

  const releaseOnce = () => {
    release ??= releaseLock();
    return release;
  };
  const reportFailure = (
    error: unknown
  ) => {
    output.write(
      `TaskSeal shutdown failed: ${renderSafeMessage(error)}\n`
    );
    signalSource.exitCode = 1;
  };

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
      .then(releaseOnce)
      .catch(reportFailure)
      .finally(cleanup);
  };

  signalSource.once("SIGINT", handleSignal);
  signalSource.once("SIGTERM", handleSignal);
  server.once("close", () => {
    cleanup();
    releaseOnce().catch(
      reportFailure
    );
  });
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
  const environment = process.env;
  return runCli({
    environment,
    userConfigurationPath:
      resolveUserConfigurationPath({ environment }),
    detectedLocales: [
      Intl.DateTimeFormat().resolvedOptions().locale
    ],
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
