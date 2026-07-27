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
import { TaskSealService } from "./application/taskseal-service.ts";
import {
  isGiteeIssueReference
} from "./connectors/gitee-read-client.ts";
import { isLinearIssueReference } from "./connectors/linear.ts";
import { CodexAppServerClient } from "./runners/codex-app-server-client.ts";
import { CodexRunner } from "./runners/codex-runner.ts";
import { createTaskSealServer } from "./server.ts";
import { FileEventJournal } from "./storage/event-journal.ts";
import type {
  ManagedField,
  WorkItem,
  WorkItemCreatedEvent
} from "./domain/workflow.ts";
import type {
  CodexAppServerInvocation,
  CodexSandbox
} from "./runners/codex-app-server-client.ts";
import type {
  CodexRunnerResult,
  CodexRunnerRunOptions
} from "./runners/codex-runner.ts";
import type {
  PersistentServicePort,
  RunWorkItemOptions
} from "./server.ts";

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
  threadId?: string | undefined;
  turnId?: string | undefined;
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
  LinearCommandOptions & { cwd: string };

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

interface StartControlRoomOptions {
  cwd: string;
  output: OutputPort;
}

type StartControlRoom = (
  options: StartControlRoomOptions
) => unknown | Promise<unknown>;

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
}

interface RunLocalCodexWorkItemOptions {
  cwd: string;
  workItemId: string;
  prompt?: string | undefined;
  sandbox?: CodexSandbox | undefined;
  commandRunner?: CommandRunner | undefined;
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
  run(
    options: CodexRunnerRunOptions
  ): unknown | Promise<unknown>;
}

interface ControlRoomRuntime {
  service: PersistentServicePort;
  runner: ControlRoomRunnerPort;
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
  serverFactory?:
    | ((
        options: {
          service: PersistentServicePort;
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
  taskseal run <work-item-id> [--prompt <text>] [--read-only]
  taskseal inspect github-issue --issue <number> --work-item <id> --criterion <key> [--snapshot-version 2 --title-management provider|none]
  taskseal inspect github --issue <number> --pr <number> --check <name> --work-item <id> --attempt <id> --criterion <key> [--snapshot-version 2 --title-management provider|none]
  taskseal inspect linear --issue <identifier-or-uuid> --work-item <id> --criterion <key> [--snapshot-version 2 --title-management provider|none]
  taskseal inspect gitee-health
  taskseal inspect gitee --issue <case-sensitive-reference> --work-item <id> --criterion <key> --snapshot-version 2 --title-management provider|none
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
  createLinearDryRun
}: RunCliOptions = {}): Promise<CliExitCode> {
  const command = args[0] ?? "start";

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
        const snapshot = await execute({ cwd, ...options });
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
        const snapshot = await execute({ cwd, ...options });
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
        const snapshot = await execute({ cwd, ...options });
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
        const health = await execute({ cwd });
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
        const snapshot = await execute({
          cwd,
          ...options
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

  output.write(USAGE);
  return 2;
}

export async function runLocalCodexWorkItem({
  cwd,
  workItemId,
  prompt,
  sandbox = "workspace-write",
  commandRunner = runCommand
}: RunLocalCodexWorkItemOptions): Promise<CodexRunnerResult> {
  const { service, runner } = await createLocalCodexRuntime({
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

  return runner.run({
    workItemId,
    cwd,
    prompt: prompt ?? createDefaultPrompt(workItem),
    sandbox,
    approvalPolicy: "never"
  });
}

export async function createLocalCodexRuntime({
  cwd,
  commandRunner = runCommand,
  environment = process.env
}: CreateLocalCodexRuntimeOptions): Promise<{
  service: TaskSealService;
  runner: CodexRunner;
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

  const runner = new CodexRunner({
    service,
    projectRoot: cwd,
    clientFactory: () =>
      new CodexAppServerClient({
        invocation,
        environment
      })
  });

  return {
    service,
    runner
  };
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

  const threadId = readOptionalResultString(
    value,
    "threadId"
  );
  const turnId = readOptionalResultString(
    value,
    "turnId"
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
    ...(threadId === undefined ? {} : { threadId }),
    ...(turnId === undefined ? {} : { turnId }),
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
    ...(result.threadId ? [`Codex thread: ${result.threadId}`] : []),
    ...(result.turnId ? [`Codex turn: ${result.turnId}`] : []),
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
  serverFactory = createTaskSealServer,
  signalSource = processSignalSource
}: StartPersistentControlRoomOptions): Promise<
  ControlRoomServerPort
> {
  const host = environment.HOST ?? "127.0.0.1";
  const port = Number(environment.PORT ?? 4317);

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
  const { service, runner } = await runtimeFactory({
    cwd,
    commandRunner,
    environment
  });
  const server = serverFactory({
    service,
    runWorkItem: (options) =>
      runner.run({
        ...options,
        cwd,
        approvalPolicy: "never"
      })
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

if (isMain) {
  process.exitCode = await runCli();
}
