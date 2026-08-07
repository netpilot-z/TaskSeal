import { spawn } from "node:child_process";
import {
  access,
  readdir
} from "node:fs/promises";
import {
  dirname,
  join
} from "node:path";

import {
  inspectConfiguration,
  resolveUserConfigurationPath
} from "./configuration-control.ts";
import type {
  CodexAppServerInvocation
} from "../runners/codex-app-server-client.ts";

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string }
) => unknown | Promise<unknown>;

export interface RuntimeReadiness {
  readonly node: {
    readonly ready: boolean;
    readonly version: string;
    readonly failure: string;
  };
  readonly project: {
    readonly ready: boolean;
  };
  readonly capabilities: {
    readonly github:
      | "ready"
      | "disabled"
      | "invalid";
    readonly linear:
      | "ready"
      | "disabled"
      | "invalid";
    readonly gitee:
      | "ready"
      | "disabled"
      | "invalid";
    readonly feishu:
      | "ready"
      | "disabled"
      | "invalid";
  };
  readonly codex: {
    readonly available: boolean;
    readonly loggedIn: boolean;
    readonly version: string | null;
  };
  readonly ready: boolean;
}

export interface AssessRuntimeReadinessOptions {
  readonly cwd: string;
  readonly commandRunner?: CommandRunner | undefined;
  readonly nodeVersion?: unknown;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly userConfigurationPath?: string | null | undefined;
}

interface ResolveCodexInvocationOptions {
  readonly cwd: string;
  readonly commandRunner?: CommandRunner | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly appExecutables?: readonly string[] | undefined;
}

const MINIMUM_NODE_VERSION = [24, 12, 0];
const MINIMUM_NODE_VERSION_LABEL =
  "24.12.0";

export async function assessRuntimeReadiness({
  cwd,
  commandRunner = runCommand,
  nodeVersion = process.versions.node,
  environment = process.env,
  userConfigurationPath
}: AssessRuntimeReadinessOptions): Promise<RuntimeReadiness> {
  const parsedNodeVersion =
    parseNodeVersion(nodeVersion);
  const minimumReady =
    parsedNodeVersion !== null &&
    compareVersions(
      parsedNodeVersion,
      MINIMUM_NODE_VERSION
    ) >= 0;
  const supportedMajor =
    parsedNodeVersion !== null &&
    parsedNodeVersion[0] === 24;
  const node = {
    ready: minimumReady && supportedMajor,
    version:
      typeof nodeVersion === "string"
        ? nodeVersion.startsWith("v")
          ? nodeVersion
          : `v${nodeVersion}`
        : String(nodeVersion),
    failure:
      minimumReady && !supportedMajor
        ? "requires Node >=24.12.0 <25"
        : `requires Node ${MINIMUM_NODE_VERSION_LABEL} or newer`
  };
  const configurationView =
    await inspectConfiguration({
      cwd,
      environment,
      userConfigurationPath:
        userConfigurationPath === undefined
          ? resolveUserConfigurationPath({ environment })
          : userConfigurationPath
    });
  let codex:
    RuntimeReadiness["codex"];

  try {
    const codexInvocation =
      await resolveCodexInvocation({
        cwd,
        commandRunner,
        environment
      });

    if (!codexInvocation) {
      throw new Error(
        "Codex executable not found."
      );
    }

    const versionResult =
      readCommandResult(
        await commandRunner(
          codexInvocation.command,
          [
            ...codexInvocation.argsPrefix,
            "--version"
          ],
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
      const loginResult =
        readCommandResult(
          await commandRunner(
            codexInvocation.command,
            [
              ...codexInvocation.argsPrefix,
              "login",
              "status"
            ],
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
        version:
          versionResult.stdout.trim()
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
    project: {
      ready:
        configurationView.ready
    },
    capabilities:
      configurationView.capabilities,
    codex,
    ready:
      node.ready &&
      configurationView.ready &&
      codex.available &&
      codex.loggedIn
  };
}

export function renderRuntimeReadiness(
  readiness: RuntimeReadiness
): string {
  const lines = [
    formatDiagnostic(
      readiness.node.ready,
      `Node ${readiness.node.version}`,
      readiness.node.failure
    ),
    formatDiagnostic(
      readiness.project.ready,
      "Project configuration",
      "missing or invalid"
    ),
    readiness.codex.available
      ? `✓ Codex ${readiness.codex.version} — ready`
      : "× Codex binary — not available",
    formatDiagnostic(
      readiness.codex.loggedIn,
      "Codex login",
      "not ready"
    ),
    renderCapability(
      "GitHub integration",
      readiness.capabilities.github
    ),
    renderCapability(
      "Linear integration",
      readiness.capabilities.linear
    ),
    renderCapability(
      "Gitee integration",
      readiness.capabilities.gitee
    ),
    renderCapability(
      "Feishu integration",
      readiness.capabilities.feishu
    )
  ];

  return `${lines.join("\n")}\n`;
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
    typeof environment.TASKSEAL_CODEX_BIN ===
      "string" &&
    environment.TASKSEAL_CODEX_BIN.trim()
      .length > 0
  ) {
    return invocationForCandidate(
      environment.TASKSEAL_CODEX_BIN
    );
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
              value
                .toLowerCase()
                .endsWith(".cmd") ||
              value
                .toLowerCase()
                .endsWith(".exe")
          )
      );
    }
  } catch {
    // Codex App discovery can still provide a usable binary.
  }

  candidates.push(
    ...(appExecutables ??
      (await discoverCodexAppExecutables(
        environment.LOCALAPPDATA
      )))
  );

  const invocations:
    CodexAppServerInvocation[] = [];

  for (
    const candidate of [
      ...new Set(candidates)
    ]
  ) {
    const invocation =
      await invocationForCandidate(
        candidate
      );

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

export function runCommand(
  command: string,
  args: string[],
  { cwd }: { cwd: string }
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: [
        "ignore",
        "pipe",
        "pipe"
      ]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on(
      "data",
      (chunk: string) => {
        stdout += chunk;
      }
    );
    child.stderr.on(
      "data",
      (chunk: string) => {
        stderr += chunk;
      }
    );
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

async function discoverCodexAppExecutables(
  localAppData: unknown
): Promise<string[]> {
  if (
    typeof localAppData !== "string" ||
    localAppData.length === 0
  ) {
    return [];
  }

  const binDirectory = join(
    localAppData,
    "OpenAI",
    "Codex",
    "bin"
  );
  const candidates = [
    join(binDirectory, "codex.exe")
  ];

  try {
    const entries = await readdir(
      binDirectory,
      { withFileTypes: true }
    );
    candidates.push(
      ...entries
        .filter((entry) =>
          entry.isDirectory()
        )
        .map((entry) =>
          join(
            binDirectory,
            entry.name,
            "codex.exe"
          )
        )
    );
  } catch {
    return [];
  }

  const usable = await Promise.all(
    candidates.map(
      async (candidate) => {
        try {
          await access(candidate);
          return candidate;
        } catch {
          return null;
        }
      }
    )
  );
  return usable.filter(
    (
      candidate
    ): candidate is string =>
      candidate !== null
  );
}

async function selectNewestCodexInvocation({
  invocations,
  cwd,
  commandRunner
}: {
  readonly invocations:
    readonly CodexAppServerInvocation[];
  readonly cwd: string;
  readonly commandRunner: CommandRunner;
}): Promise<
  CodexAppServerInvocation | null
> {
  let selected: {
    invocation:
      CodexAppServerInvocation;
    version: number[];
  } | null = null;

  for (const invocation of invocations) {
    try {
      const result =
        readCommandResult(
          await commandRunner(
            invocation.command,
            [
              ...invocation.argsPrefix,
              "--version"
            ],
            { cwd }
          )
        );
      const version =
        parseCodexVersion(
          result.stdout
        );

      if (
        result.exitCode === 0 &&
        version &&
        (!selected ||
          compareVersions(
            version,
            selected.version
          ) > 0)
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

function invocationForCandidate(
  candidate: string
): Promise<
  CodexAppServerInvocation | null
> | CodexAppServerInvocation {
  if (
    !candidate
      .toLowerCase()
      .endsWith(".cmd")
  ) {
    return {
      command: candidate,
      argsPrefix: []
    };
  }

  return resolveCommandShim(candidate);
}

async function resolveCommandShim(
  candidate: string
): Promise<
  CodexAppServerInvocation | null
> {
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

function readCommandResult(
  value: unknown
): CommandResult {
  if (
    !isRecord(value) ||
    typeof value.exitCode !==
      "number" ||
    !Number.isInteger(
      value.exitCode
    ) ||
    typeof value.stdout !==
      "string" ||
    typeof value.stderr !==
      "string"
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
  return ready
    ? `✓ ${label} — ready`
    : `× ${label} — ${failure}`;
}

function renderCapability(
  label: string,
  status:
    | "ready"
    | "disabled"
    | "invalid"
): string {
  if (status === "ready") {
    return `✓ ${label} — ready`;
  }
  if (status === "disabled") {
    return `- ${label} — disabled`;
  }
  return `× ${label} — invalid`;
}

function parseCodexVersion(
  value: unknown
): number[] | null {
  if (typeof value !== "string") {
    return null;
  }

  const match =
    /\b(\d+)\.(\d+)\.(\d+)/.exec(
      value
    );
  return match
    ? match
        .slice(1)
        .map(Number)
    : null;
}

function parseNodeVersion(
  value: unknown
): number[] | null {
  if (typeof value !== "string") {
    return null;
  }

  const match =
    /^v?(\d+)\.(\d+)\.(\d+)$/.exec(
      value
    );
  return match
    ? match
        .slice(1)
        .map(Number)
    : null;
}

function compareVersions(
  left: readonly number[],
  right: readonly number[]
): number {
  for (
    let index = 0;
    index <
    Math.max(
      left.length,
      right.length
    );
    index += 1
  ) {
    const difference =
      (left[index] ?? 0) -
      (right[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function isRecord(
  value: unknown
): value is Record<
  string,
  unknown
> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}
