#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  inspectGitHubIssueProvider,
  inspectGitHubProvider,
  inspectLinearProvider
} from "./application/provider-inspection.js";
import { createLinearTicketDryRun } from "./application/linear-ticket-dry-run.js";
import { TaskSealService } from "./application/taskseal-service.js";
import { isLinearIssueReference } from "./connectors/linear.js";
import { CodexAppServerClient } from "./runners/codex-app-server-client.js";
import { CodexRunner } from "./runners/codex-runner.js";
import { createTaskSealServer } from "./server.js";
import { FileEventJournal } from "./storage/event-journal.js";

const MINIMUM_NODE_VERSION = [24, 12, 0];
const MINIMUM_NODE_VERSION_LABEL = "24.12.0";
const USAGE = `Usage:
  taskseal init
  taskseal doctor
  taskseal start
  taskseal run <work-item-id> [--prompt <text>] [--read-only]
  taskseal inspect github-issue --issue <number> --work-item <id> --criterion <key>
  taskseal inspect github --issue <number> --pr <number> --check <name> --work-item <id> --attempt <id> --criterion <key>
  taskseal inspect linear --issue <identifier-or-uuid> --work-item <id> --criterion <key>
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
  createLinearDryRun
} = {}) {
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
      const execute =
        runWorkItem ??
        ((runOptions) =>
          runLocalCodexWorkItem({
            ...runOptions,
            commandRunner
          }));
      const result = await execute({
        cwd,
        workItemId: options.workItemId,
        prompt: options.prompt,
        sandbox: options.readOnly ? "read-only" : "workspace-write"
      });
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
}) {
  const { service, runner } = await createLocalCodexRuntime({
    cwd,
    commandRunner
  });
  const workItem = service.getWorkItem(workItemId);

  if (!workItem) {
    const error = new Error(
      `TaskSeal work item ${workItemId} does not exist. Run taskseal init first.`
    );
    error.code = "WORK_ITEM_NOT_FOUND";
    throw error;
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
}) {
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
    const error = new Error(
      "Codex executable was not found. Run taskseal doctor for details."
    );
    error.code = "CODEX_NOT_AVAILABLE";
    throw error;
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

export async function initializeProject({ cwd, now = () => new Date() }) {
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

  const event = {
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
}) {
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
  let codex;

  try {
    const codexInvocation = await resolveCodexInvocation({
      cwd,
      commandRunner
    });

    if (!codexInvocation) {
      throw new Error("Codex executable not found.");
    }

    const versionResult = await commandRunner(
      codexInvocation.command,
      [...codexInvocation.argsPrefix, "--version"],
      { cwd }
    );

    if (versionResult.exitCode !== 0) {
      codex = {
        available: false,
        loggedIn: false,
        version: null
      };
    } else {
      const loginResult = await commandRunner(
        codexInvocation.command,
        [...codexInvocation.argsPrefix, "login", "status"],
        { cwd }
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
}) {
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

  const candidates = [];

  try {
    const result = await commandRunner("where.exe", ["codex"], { cwd });

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

  const invocations = [];

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

async function discoverCodexAppExecutables(localAppData) {
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
  return usable.filter(Boolean);
}

async function selectNewestCodexInvocation({
  invocations,
  cwd,
  commandRunner
}) {
  let selected = null;

  for (const invocation of invocations) {
    try {
      const result = await commandRunner(
        invocation.command,
        [...invocation.argsPrefix, "--version"],
        { cwd }
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

function parseCodexVersion(value) {
  const match = /\b(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

function parseNodeVersion(value) {
  if (typeof value !== "string") {
    return null;
  }

  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

async function invocationForCandidate(candidate) {
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

async function inspectProjectConfiguration(cwd) {
  try {
    const content = await readFile(join(cwd, "config", "project.json"), "utf8");
    const configuration = JSON.parse(content);

    return {
      ready:
        typeof configuration.project === "string" &&
        configuration.project.length > 0
    };
  } catch {
    return { ready: false };
  }
}

function renderDiagnostics(diagnostics) {
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

function parseRunArguments(args) {
  const [workItemId, ...options] = args;

  if (
    typeof workItemId !== "string" ||
    workItemId.length === 0 ||
    workItemId.startsWith("--")
  ) {
    return null;
  }

  let prompt;
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
    prompt,
    readOnly
  };
}

function createDefaultPrompt(workItem) {
  return [
    `Work on TaskSeal work item ${workItem.id}: ${workItem.title}.`,
    "Stay inside the current project, report the result concisely, and do not access external issue trackers.",
    "Completing the turn is a delivery claim only; TaskSeal will require separate artifact and evidence before acceptance."
  ].join("\n");
}

function renderRunResult(result) {
  const lines = [
    `Attempt ${result.attemptId}: ${result.outcome}`,
    ...(result.threadId ? [`Codex thread: ${result.threadId}`] : []),
    ...(result.turnId ? [`Codex turn: ${result.turnId}`] : []),
    ...(result.summary ? [`Summary: ${result.summary}`] : [])
  ];
  return `${lines.join("\n")}\n`;
}

function renderRunError(error) {
  const code =
    typeof error?.code === "string" && error.code.length > 0
      ? ` [${error.code}]`
      : "";
  const message =
    typeof error?.message === "string" && error.message.length > 0
      ? error.message
      : "Unknown runner error.";
  return `TaskSeal run failed${code}: ${message.slice(0, 2_000)}\n`;
}

function parseGitHubInspectArguments(args) {
  const values = parseNamedArguments(args, [
    "--issue",
    "--pr",
    "--check",
    "--work-item",
    "--attempt",
    "--criterion"
  ]);

  if (!values) {
    return null;
  }

  const issueNumber = parsePositiveInteger(values["--issue"]);
  const pullRequestNumber = parsePositiveInteger(values["--pr"]);

  if (!issueNumber || !pullRequestNumber) {
    return null;
  }

  return {
    issueNumber,
    pullRequestNumber,
    checkName: values["--check"],
    workItemId: values["--work-item"],
    attemptId: values["--attempt"],
    criterionKey: values["--criterion"]
  };
}

function parseGitHubIssueInspectArguments(args) {
  const values = parseNamedArguments(args, [
    "--issue",
    "--work-item",
    "--criterion"
  ]);

  if (!values) {
    return null;
  }

  const issueNumber = parsePositiveInteger(values["--issue"]);

  if (!issueNumber) {
    return null;
  }

  return {
    issueNumber,
    workItemId: values["--work-item"],
    requiredEvidence: [values["--criterion"]]
  };
}

function parseLinearInspectArguments(args) {
  const values = parseNamedArguments(args, [
    "--issue",
    "--work-item",
    "--criterion"
  ]);

  if (!values) {
    return null;
  }

  if (!isLinearIssueReference(values["--issue"])) {
    return null;
  }

  return {
    issueReference: values["--issue"],
    workItemId: values["--work-item"],
    requiredEvidence: [values["--criterion"]]
  };
}

function parseNamedArguments(args, names) {
  if (args.length !== names.length * 2) {
    return null;
  }

  const allowed = new Set(names);
  const values = {};

  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];

    if (
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

function parsePositiveInteger(value) {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function parseLinearSyncArguments(args) {
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

function renderInspectError(error) {
  const code =
    typeof error?.code === "string" && error.code.length > 0
      ? ` [${error.code}]`
      : "";
  const message =
    typeof error?.message === "string" && error.message.length > 0
      ? error.message
      : "Unknown provider error.";
  return `TaskSeal inspect failed${code}: ${message.slice(0, 2_000)}\n`;
}

function renderSyncError(error) {
  const code =
    typeof error?.code === "string" && error.code.length > 0
      ? ` [${error.code}]`
      : "";
  const message =
    typeof error?.message === "string" && error.message.length > 0
      ? error.message
      : "Unknown synchronization planning error.";
  return `TaskSeal sync dry-run failed${code}: ${message.slice(0, 2_000)}\n`;
}

function formatDiagnostic(ready, label, failure) {
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
  signalSource = process
}) {
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

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  installShutdownHandlers({
    server,
    signalSource,
    output
  });
  output.write(`TaskSeal Control Room: http://${host}:${port}\n`);
  return server;
}

function installShutdownHandlers({ server, signalSource, output }) {
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
    Promise.resolve(
      typeof server.shutdown === "function"
        ? server.shutdown()
        : new Promise((resolve) => server.close(resolve))
    )
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

function renderSafeMessage(error) {
  return (
    typeof error?.message === "string" && error.message.length > 0
      ? error.message
      : "Unknown shutdown error."
  ).slice(0, 2_000);
}

function runCommand(command, args, { cwd }) {
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
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
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

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  process.exitCode = await runCli();
}
