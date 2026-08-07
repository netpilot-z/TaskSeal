import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  resolveCodexInvocation,
  runCli,
  runLocalCodexWorkItem,
  startPersistentControlRoom
} from "../src/cli.ts";
import type {
  CommandRunner,
  OutputPort
} from "../src/cli.ts";
import type { ManagedRunnerRunOptions } from "../src/application/managed-attempt-runner.ts";
import type { ConfigurationView } from "../src/application/configuration-control.ts";
import type {
  PersistentServicePort,
  PersistentTaskSealServerOptions
} from "../src/server.ts";
import { FileEventJournal } from "../src/storage/event-journal.ts";
import {
  digestCanonicalJson
} from "../src/lib/canonical-json.ts";

test("package entrypoints separate the source checkout scripts from the compiled install bin", async () => {
  const packageJson: unknown = JSON.parse(
    await readFile(
      new URL("../package.json", import.meta.url),
      "utf8"
    )
  );
  const packageLock: unknown = JSON.parse(
    await readFile(
      new URL("../package-lock.json", import.meta.url),
      "utf8"
    )
  );

  assert.equal(readJsonPath(packageJson, "private"), true);
  assert.deepEqual(readJsonPath(packageJson, "bin"), {
    taskseal: "dist/bin/taskseal.js"
  });
  assert.equal(
    readJsonPath(packageJson, "scripts", "start"),
    "node src/cli.ts start"
  );
  assert.equal(
    readJsonPath(packageJson, "scripts", "taskseal"),
    "node src/cli.ts"
  );
  assert.equal(
    readJsonPath(
      packageLock,
      "packages",
      "",
      "bin",
      "taskseal"
    ),
    "dist/bin/taskseal.js"
  );
});

test("the source-checkout CLI preserves its POSIX executable contract", async () => {
  const cli = await readFile(
    new URL("../src/cli.ts", import.meta.url)
  );

  assert.equal(
    cli.subarray(0, "#!/usr/bin/env node\n".length).toString(),
    "#!/usr/bin/env node\n"
  );
  assert.equal(cli.includes(Buffer.from("\r\n")), false);

  const repositoryRoot = fileURLToPath(
    new URL("../", import.meta.url)
  );
  const mode = spawnSync(
    "git",
    ["ls-files", "--stage", "src/cli.ts"],
    {
      cwd: repositoryRoot,
      encoding: "utf8"
    }
  );

  assert.equal(mode.status, 0, mode.stderr);
  assert.match(
    mode.stdout,
    /^100755 [0-9a-f]+ 0\tsrc\/cli\.ts\r?\n?$/
  );
});

test("the POSIX source-checkout CLI executes through its raw entrypoint", () => {
  if (process.platform === "win32") {
    return;
  }

  const repositoryRoot = fileURLToPath(
    new URL("../", import.meta.url)
  );
  const cliPath = fileURLToPath(
    new URL("../src/cli.ts", import.meta.url)
  );
  const result = spawnSync(
    cliPath,
    ["unknown"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false
    }
  );

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /Usage:/);
});

test("init creates project scaffolding without a WorkItem and remains idempotent", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const output = createOutput();

  assert.equal(
    await runCli({
      args: ["init"],
      cwd,
      output
    }),
    0
  );
  assert.equal(
    await runCli({
      args: ["init"],
      cwd,
      output
    }),
    0
  );

  const journal = new FileEventJournal({
    filePath: join(cwd, ".taskseal", "events.jsonl")
  });
  const events = await journal.readAll();
  const configuration: unknown =
    JSON.parse(
      await readFile(
        join(
          cwd,
          "config",
          "project.json"
        ),
        "utf8"
      )
    );

  assert.deepEqual(events, []);
  assert.equal(
    typeof readJsonPath(
      configuration,
      "project"
    ),
    "string"
  );
  assert.doesNotMatch(
    JSON.stringify(configuration),
    new RegExp(escapeRegExp(cwd))
  );
});

test("demo init explicitly creates the sample WorkItem once", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const output = createOutput();
  const now = () =>
    new Date(
      "2026-07-26T09:00:00.000Z"
    );

  assert.equal(
    await runCli({
      args: ["demo", "init"],
      cwd,
      output,
      now
    }),
    0
  );
  assert.equal(
    await runCli({
      args: ["demo", "init"],
      cwd,
      output,
      now
    }),
    0
  );

  const journal =
    new FileEventJournal({
      filePath: join(
        cwd,
        ".taskseal",
        "events.jsonl"
      )
    });
  const events = await journal.readAll();

  assert.equal(events.length, 1);
  assert.equal(
    readJsonPath(
      events[0],
      "workItemId"
    ),
    "TS-1"
  );
});

test("doctor reports project and Codex readiness without command stderr", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const output = createOutput();
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({
      project: "TaskSeal",
      github: { repository: "netpilot-z/TaskSeal" },
      linear: { workspace: "TaskSeal", team: "netpilot" }
    })
  );
  const commands: string[] = [];
  const commandRunner: CommandRunner = async (
    command,
    args
  ) => {
    commands.push(command);

    if (command === "where.exe") {
      return {
        exitCode: 0,
        stdout: "codex-path.exe\n",
        stderr: ""
      };
    }

    if (args[0] === "--version") {
      return {
        exitCode: 0,
        stdout: "codex-cli 0.135.0\n",
        stderr: "private diagnostic"
      };
    }

    return {
      exitCode: 0,
      stdout: "Logged in using ChatGPT\n",
      stderr: "private diagnostic"
    };
  };

  const exitCode = await runCli({
    args: ["doctor"],
    cwd,
    output,
    commandRunner
  });

  assert.equal(exitCode, 0);
  assert.match(output.text(), /Node .*ready/);
  assert.match(output.text(), /Project configuration .*ready/);
  assert.match(output.text(), /Codex codex-cli 0\.135\.0/);
  assert.match(output.text(), /Codex login .*ready/);
  assert.doesNotMatch(output.text(), /private diagnostic/);
  const expectedCodexCommand =
    process.platform === "win32" ? "codex-path.exe" : "codex";
  assert.equal(commands.includes(expectedCodexCommand), true);
});

test("doctor enforces the Node 24.12.0 runtime minimum", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({ project: "TaskSeal" })
  );
  const commandRunner: CommandRunner = async (
    command,
    args
  ) => {
    if (command === "where.exe") {
      return {
        exitCode: 0,
        stdout: "codex-path.exe\n",
        stderr: ""
      };
    }

    if (args[0] === "--version") {
      return {
        exitCode: 0,
        stdout: "codex-cli 0.135.0\n",
        stderr: ""
      };
    }

    return {
      exitCode: 0,
      stdout: "Logged in using ChatGPT\n",
      stderr: ""
    };
  };
  const unsupportedOutput = createOutput();

  assert.equal(
    await runCli({
      args: ["doctor"],
      cwd,
      output: unsupportedOutput,
      commandRunner,
      nodeVersion: "24.11.9"
    }),
    1
  );
  assert.match(
    unsupportedOutput.text(),
    /Node v24\.11\.9 .*requires Node 24\.12\.0 or newer/
  );

  const supportedOutput = createOutput();

  assert.equal(
    await runCli({
      args: ["doctor"],
      cwd,
      output: supportedOutput,
      commandRunner,
      nodeVersion: "24.12.0"
    }),
    0
  );
  assert.match(supportedOutput.text(), /Node v24\.12\.0 .*ready/);
});

test("setup command delegates to the restricted SetupRuntime instead of operational start", async () => {
  const writes: string[] = [];
  let received: unknown = null;
  const exitCode = await runCli({
    args: ["setup"],
    cwd: process.cwd(),
    output: { write(value) { writes.push(value); } },
    startSetupRuntime: async (options) => {
      received = {
        cwd: options.cwd,
        environment: options.environment
      };
    }
  });
  assert.equal(exitCode, 0);
  assert.equal((received as { cwd: string }).cwd, process.cwd());
  assert.deepEqual(writes, []);
});

test("bare CLI enters SetupRuntime when the default operational start is not ready", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const output = createOutput();
  let setup = false;
  const exitCode = await runCli({
    args: [],
    cwd,
    output,
    environment: {},
    nodeVersion: "24.12.0",
    startControlRoom: startPersistentControlRoom,
    startSetupRuntime: async () => {
      setup = true;
    }
  });
  assert.equal(exitCode, 0);
  assert.equal(setup, true);
});

test("integration test uses the same redacted configuration probe contract as the Web route", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({ project: "TaskSeal", github: { repository: "netpilot-z/TaskSeal" } })
  );
  const output = createOutput();
  const exitCode = await runCli({
    args: ["integration", "test", "github", "--json"],
    cwd,
    output,
    environment: {}
  });
  assert.equal(exitCode, 0);
  const result = JSON.parse(output.text()) as {
    schemaVersion: string;
    provider: string;
    networkAttempted: boolean;
    status: string;
  };
  assert.equal(result.schemaVersion, "connection-probe/v1");
  assert.equal(result.provider, "github");
  assert.equal(result.networkAttempted, false);
  assert.equal(result.status, "configuration-ready");
});

test("doctor rejects unverified Node major versions", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({ project: "TaskSeal" })
  );
  const output = createOutput();

  const exitCode = await runCli({
    args: ["doctor"],
    cwd,
    output,
    nodeVersion: "25.0.0",
    commandRunner: async (_command, args) => ({
      exitCode: 0,
      stdout:
        args[0] === "--version"
          ? "codex-cli 0.135.0\n"
          : "Logged in using ChatGPT\n",
      stderr: ""
    })
  });

  assert.equal(exitCode, 1);
  assert.match(
    output.text(),
    /Node v25\.0\.0 .*requires Node >=24\.12\.0 <25/
  );
});

test("doctor validates configured integration shapes", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({
      project: "TaskSeal",
      github: {
        repository: "not-a-repository"
      }
    })
  );
  const output = createOutput();

  const exitCode = await runCli({
    args: ["doctor"],
    cwd,
    output,
    commandRunner: async (_command, args) => ({
      exitCode: 0,
      stdout:
        args[0] === "--version"
          ? "codex-cli 0.135.0\n"
          : "Logged in using ChatGPT\n",
      stderr: ""
    })
  });

  assert.equal(exitCode, 1);
  assert.match(
    output.text(),
    /Project configuration .*missing or invalid/
  );
});

test("doctor rejects project configuration fields outside the public schema", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({
      project: "TaskSeal",
      localAbsolutePath: "private"
    })
  );

  const exitCode = await runCli({
    args: ["doctor"],
    cwd,
    output: createOutput(),
    commandRunner: async (_command, args) => ({
      exitCode: 0,
      stdout:
        args[0] === "--version"
          ? "codex-cli 0.135.0\n"
          : "Logged in using ChatGPT\n",
      stderr: ""
    })
  });

  assert.equal(exitCode, 1);
});

test("doctor rejects an invalid configured Linear capability", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({
      project: "TaskSeal",
      linear: {
        workspace: "netpilot-z",
        team: "netpilot",
        project: "TaskSeal",
        acceptance: {
          enabled: true
        }
      }
    })
  );

  const exitCode = await runCli({
    args: ["doctor"],
    cwd,
    output: createOutput(),
    commandRunner: async (_command, args) => ({
      exitCode: 0,
      stdout:
        args[0] === "--version"
          ? "codex-cli 0.135.0\n"
          : "Logged in using ChatGPT\n",
      stderr: ""
    })
  });

  assert.equal(exitCode, 1);
});

test("doctor fails clearly when Codex is unavailable", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const output = createOutput();
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({ project: "TaskSeal" })
  );

  const exitCode = await runCli({
    args: ["doctor"],
    cwd,
    output,
    commandRunner: async () => {
      throw Object.assign(
        new Error("not found"),
        { code: "ENOENT" }
      );
    }
  });

  assert.equal(exitCode, 1);
  assert.match(output.text(), /Codex binary .*not available/);
});

test("Windows resolution prefers the newest usable Codex App binary", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const versions = new Map([
    ["codex-path.exe", "codex-cli 0.135.0"],
    ["codex-app-old.exe", "codex-cli 0.130.0-alpha.5"],
    ["codex-app-current.exe", "codex-cli 0.146.0-alpha.3.1"]
  ]);

  const invocation = await resolveCodexInvocation({
    cwd,
    platform: "win32",
    environment: {},
    appExecutables: [
      "codex-app-old.exe",
      "codex-app-current.exe"
    ],
    commandRunner: async (command, args) => {
      if (command === "where.exe") {
        return {
          exitCode: 0,
          stdout: "codex-path.exe\n",
          stderr: ""
        };
      }

      return {
        exitCode: versions.has(command) ? 0 : 1,
        stdout: `${versions.get(command) ?? ""}\n`,
        stderr: ""
      };
    }
  });

  assert.deepEqual(invocation, {
    command: "codex-app-current.exe",
    argsPrefix: []
  });
});

test("no command keeps the compatible start behavior", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const output = createOutput();
  let started = false;

  const exitCode = await runCli({
    args: [],
    cwd,
    output,
    startControlRoom: async () => {
      started = true;
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(started, true);
});

test("start renders a safe actionable port error without throwing a process stack", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const output = createOutput();

  const exitCode = await runCli({
    args: ["start"],
    cwd,
    output,
    startControlRoom: async () => {
      throw Object.assign(
        new Error("listen EACCES: permission denied 127.0.0.1:4317"),
        { code: "CONTROL_ROOM_PORT_UNAVAILABLE" }
      );
    }
  });

  assert.equal(exitCode, 1);
  assert.equal(
    output.text(),
    "TaskSeal could not open its Control Room port [CONTROL_ROOM_PORT_UNAVAILABLE]. Choose another port with `taskseal config set runtime.port <port>` or the PORT environment variable.\n"
  );
  assert.doesNotMatch(output.text(), /EACCES|node:net|at Server/);
});

test("start renders the actionable port error in Simplified Chinese", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const output = createOutput();

  assert.equal(
    await runCli({
      args: ["start", "--lang", "zh-CN"],
      cwd,
      output,
      environment: {},
      startControlRoom: async () => {
        throw Object.assign(new Error("raw bind failure"), {
          code: "CONTROL_ROOM_PORT_UNAVAILABLE"
        });
      }
    }),
    1
  );
  assert.equal(
    output.text(),
    "TaskSeal 无法打开 Control Room 端口 [CONTROL_ROOM_PORT_UNAVAILABLE]。请使用 `taskseal config set runtime.port <port>` 或 PORT 环境变量选择其他端口。\n"
  );
});

test("start explains that a verified Control Room lock means the service is already running", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const output = createOutput();

  assert.equal(
    await runCli({
      args: ["start", "--lang", "zh-CN"],
      cwd,
      output,
      environment: {},
      startControlRoom: async () => {
        throw Object.assign(new Error("already running"), {
          code: "CONTROL_ROOM_ALREADY_RUNNING",
          verified: true
        });
      }
    }),
    0
  );
  assert.equal(
    output.text(),
    "TaskSeal Control Room 已在运行，无需再次启动。请打开现有页面；如页面不可访问，请再次运行 `taskseal start` 以回收已停止实例留下的锁。\n"
  );
});

test("persistent start wires one service and runner into the Control Room", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  await mkdir(join(cwd, ".taskseal"), { recursive: true });
  await writeFile(
    join(cwd, ".taskseal", "config.local.json"),
    JSON.stringify({ runtime: { port: 4400 } })
  );
  const output = createOutput();
  const calls: unknown[] = [];
  const service: PersistentServicePort = {
    snapshot() {
      return {
        generatedAt: "2026-07-26T09:00:00.000Z",
        summary: {
          total: 0,
          planned: 0,
          running: 0,
          reviewing: 0,
          blocked: 0,
          accepted: 0,
          activeAgents: 0
        },
        workItems: []
      };
    },
    getWorkItem(workItemId: string) {
      return { id: workItemId };
    }
  };
  const runner = {
    manifest: {
      runnerId: "codex-app-server"
    },
    async run(options: ManagedRunnerRunOptions) {
      calls.push(options);
      return { outcome: "completed" };
    }
  };
  const decomposition = {
    capabilities: {
      preview: true,
      approve: true,
      dispatch: true,
      retire: true
    },
    preview() {
      return {};
    },
    async approve() {
      return {};
    },
    async retire() {
      return {};
    },
    listRetirements() {
      return [];
    },
    assertManualRunAllowed() {},
    assertAcceptanceAllowed() {},
    createDispatcher() {
      throw new Error("not called");
    }
  } as PersistentTaskSealServerOptions["decomposition"];
  const providerObservations = {
    async list() {
      return {
        schemaVersion: 1 as const,
        revision:
          digestCanonicalJson([]),
        providers: []
      };
    }
  };
  const providerOperations = {
    async get() {
      return null;
    },
    async history() {
      return [];
    },
    async listLatest() {
      return [];
    }
  };
  const acceptance = {
    async decide() {
      throw new Error("not called");
    },
    async reconcile() {
      return {
        status: "disabled" as const
      };
    }
  };
  let acceptanceService:
    PersistentServicePort | null = null;
  let initialized = false;
  let shutDown = false;
  let serverOptions:
    | PersistentTaskSealServerOptions
    | undefined;
  const signalSource = new EventEmitter();
  class FakeServer extends EventEmitter {
    listen(
      port: number,
      host: string,
      callback: () => void
    ): void {
      calls.push({ port, host });
      callback();
    }

    async shutdown(): Promise<void> {
      shutDown = true;
      this.emit("close");
    }
  }

  const server = await startPersistentControlRoom({
    cwd,
    output,
    environment: {
      HOST: "127.0.0.1",
      TASKSEAL_MAX_CONCURRENT_RUNS: "2"
    },
    assessReadiness: async () => ({
      node: {
        ready: true,
        version: "v24.12.0",
        failure: ""
      },
      project: { ready: true },
      capabilities: {
        github: "disabled",
        linear: "disabled",
        gitee: "disabled",
        feishu: "disabled"
      },
      codex: {
        available: true,
        loggedIn: true,
        version: "codex-cli test"
      },
      ready: true
    }),
    signalSource,
    initialize: async () => {
      initialized = true;
    },
    runtimeFactory: async () => ({
      service,
      runner,
      decomposition
    }),
    providerObservationRuntimeFactory: async () => ({
      readModel: providerObservations
    }),
    providerOperationQueryFactory: async () =>
      providerOperations,
    acceptanceRuntimeFactory:
      async ({
        service:
          acceptanceRuntimeService,
        providerOperations:
          acceptanceProviderOperations
      }) => {
        acceptanceService =
          acceptanceRuntimeService;
        assert.equal(
          acceptanceProviderOperations,
          providerOperations
        );
        return {
          acceptance,
          providerOperations,
          capabilities: {
            decideAcceptance: true,
            linearTransition: false,
            reconcileLinearTransition:
              false
          },
          operatorId:
            "operator.jeffrey"
        };
      },
    serverFactory: (options) => {
      serverOptions = options;
      return new FakeServer();
    }
  });

  assert.equal(initialized, true);
  assert.equal(server instanceof FakeServer, true);
  assert.ok(serverOptions);
  assert.equal(serverOptions.service, service);
  assert.equal(
    serverOptions.decomposition,
    decomposition
  );
  assert.equal(acceptanceService, service);
  assert.equal(
    serverOptions.acceptance,
    acceptance
  );
  assert.deepEqual(
    serverOptions.acceptanceCapabilities,
    {
      decideAcceptance: true,
      linearTransition: false,
      reconcileLinearTransition: false
    }
  );
  assert.equal(
    serverOptions.operatorId,
    "operator.jeffrey"
  );
  assert.equal(serverOptions.maxConcurrentRuns, 2);
  assert.ok(serverOptions.configuration);
  assert.match(
    serverOptions.configuration.instanceId,
    /^[0-9a-f-]{36}$/
  );
  assert.equal(
    (
      await serverOptions.configuration.inspect()
    ).fields.find(
      (field) => field.key === "runtime.port"
    )?.value,
    4400
  );
  const providerProjection =
    await serverOptions.providerStatus.list();
  assert.equal(
    providerProjection.schemaVersion,
    2
  );
  assert.deepEqual(
    providerProjection.providers,
    []
  );
  assert.deepEqual(
    providerProjection.operations,
    []
  );
  const signal = new AbortController().signal;
  const terminalization = {
    begin: () => ({
      cancellationAccepted: false
    })
  };
  const runControlRoomWorkItem =
    serverOptions.runWorkItem;
  await runControlRoomWorkItem({
    workItemId: "TS-1",
    runnerId: "codex-app-server",
    prompt: "Run from the Control Room.",
    sandbox: "read-only",
    timeoutMs: 120_000,
    signal,
    terminalization
  });
  await assert.rejects(
    async () =>
      runControlRoomWorkItem({
        workItemId: "TS-2",
        runnerId: "unknown-runner",
        prompt: "Do not run.",
        sandbox: "read-only",
        timeoutMs: 120_000,
        signal,
        terminalization
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code ===
        "RUNNER_NOT_AVAILABLE"
  );
  assert.deepEqual(calls, [
    { port: 4400, host: "127.0.0.1" },
    {
      workItemId: "TS-1",
      instruction:
        "Run from the Control Room.",
      workspaceAccess: "read-only",
      timeoutMs: 120_000,
      signal,
      terminalization,
      cwd
    }
  ]);
  assert.match(output.text(), /http:\/\/127\.0\.0\.1:4400/);

  signalSource.emit("SIGTERM");
  await new Promise<void>((resolve) =>
    setImmediate(() => resolve())
  );
  assert.equal(shutDown, true);
});

test("persistent start maps a Windows-exclusive port bind failure and releases its lock", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  let releases = 0;
  const providerOperations = {
    async get() { return null; },
    async history() { return []; },
    async listLatest() { return []; }
  };
  class PortFailureServer extends EventEmitter {
    listen(): void {
      this.emit("error", Object.assign(
        new Error("listen EACCES: permission denied 127.0.0.1:4317"),
        {
          code: "EACCES",
          address: "127.0.0.1",
          port: 4317
        }
      ));
    }
  }

  await assert.rejects(
    startPersistentControlRoom({
      cwd,
      output: createOutput(),
      environment: { HOST: "127.0.0.1", PORT: "4317" },
      assessReadiness: async () => ({
        node: {
          ready: true,
          version: "v24.12.0",
          failure: ""
        },
        project: { ready: true },
        capabilities: {
          github: "disabled",
          linear: "disabled",
          gitee: "disabled",
          feishu: "disabled"
        },
        codex: {
          available: true,
          loggedIn: true,
          version: "codex-cli test"
        },
        ready: true
      }),
      initialize: async () => {},
      acquireLock: async () => ({
        filePath: join(cwd, ".taskseal", "control-room.lock"),
        async release() { releases += 1; }
      }),
      providerObservationRuntimeFactory: async () => ({
        readModel: {
          async list() {
            return {
              schemaVersion: 1 as const,
              revision: digestCanonicalJson([]),
              providers: []
            };
          }
        }
      }),
      providerOperationQueryFactory: async () => providerOperations,
      acceptanceRuntimeFactory: async () => ({
        acceptance: null,
        providerOperations,
        capabilities: {
          decideAcceptance: false,
          linearTransition: false,
          reconcileLinearTransition: false
        },
        operatorId: null
      }),
      runtimeFactory: async () => ({
        service: {
          snapshot() { return {}; },
          getWorkItem() { return null; }
        } as unknown as PersistentServicePort,
        runner: {
          async run() { return { outcome: "completed" }; }
        }
      }),
      serverFactory: () => new PortFailureServer(),
      signalSource: new EventEmitter()
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CONTROL_ROOM_PORT_UNAVAILABLE" &&
      !/EACCES|127\.0\.0\.1|4317/.test(error.message)
  );
  assert.equal(releases, 1);
});

test("persistent start refuses non-loopback binding", async (t) => {
  const cwd = await createTemporaryDirectory(t);

  await assert.rejects(
    startPersistentControlRoom({
      cwd,
      output: createOutput(),
      environment: {
        HOST: "0.0.0.0",
        PORT: "4317"
      },
      signalSource: new EventEmitter()
    }),
    /loopback/
  );
});

test("persistent start rejects an invalid bounded concurrency setting before initialization", async (t) => {
  const cwd = await createTemporaryDirectory(t);

  for (const value of ["0", "-1", "1.5", "9", "many"]) {
    let initialized = false;

    await assert.rejects(
      startPersistentControlRoom({
        cwd,
        output: createOutput(),
        environment: {
          HOST: "127.0.0.1",
          PORT: "0",
          TASKSEAL_MAX_CONCURRENT_RUNS: value
        },
        initialize: async () => {
          initialized = true;
        },
        signalSource: new EventEmitter()
      }),
      /between 1 and 8/
    );
    assert.equal(initialized, false);
  }
});

test("persistent start rejects the same invalid project configuration as doctor before initialization", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({
      project: "TaskSeal",
      github: {
        repository: "not-a-repository"
      }
    })
  );
  let initialized = false;

  await assert.rejects(
    startPersistentControlRoom({
      cwd,
      output: createOutput(),
      environment: {
        HOST: "127.0.0.1",
        PORT: "0"
      },
      commandRunner: async (command, args) => ({
        exitCode: 0,
        stdout:
          command === "where.exe"
            ? "codex-path.exe\n"
            : args[0] === "--version"
              ? "codex-cli 0.135.0\n"
              : "Logged in using ChatGPT\n",
        stderr: ""
      }),
      initialize: async () => {
        initialized = true;
      },
      signalSource: new EventEmitter()
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "TASKSEAL_NOT_READY"
  );
  assert.equal(initialized, false);
});

test("persistent start rejects an existing Control Room lock before opening runtime journals", async (t) => {
  const cwd =
    await createTemporaryDirectory(t);
  let initialized = false;
  let runtimeCalls = 0;

  await assert.rejects(
    startPersistentControlRoom({
      cwd,
      output: createOutput(),
      environment: {
        HOST: "127.0.0.1",
        PORT: "0"
      },
      assessReadiness:
        async () => ({
          node: {
            ready: true,
            version: "v24.12.0",
            failure: ""
          },
          project: {
            ready: true
          },
          capabilities: {
            github: "disabled",
            linear: "disabled",
            gitee: "disabled",
            feishu: "disabled"
          },
          codex: {
            available: true,
            loggedIn: true,
            version:
              "codex-cli test"
          },
          ready: true
        }),
      initialize: async () => {
        initialized = true;
      },
      acquireLock: async () => {
        throw Object.assign(
          new Error(
            "already running"
          ),
          {
            code:
              "CONTROL_ROOM_ALREADY_RUNNING"
          }
        );
      },
      resolveAuthority: async () => ({
        kind: "running-instance",
        inspect: async () =>
          ({} as ConfigurationView),
        readDraft: async () => {
          throw new Error("not used");
        },
        applyChange: async () => {
          throw new Error("not used");
        },
        applyDraft: async () => {
          throw new Error("not used");
        }
      }),
      runtimeFactory: async () => {
        runtimeCalls += 1;
        throw new Error(
          "runtime must stay closed"
        );
      },
      signalSource:
        new EventEmitter()
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code ===
        "CONTROL_ROOM_ALREADY_RUNNING" &&
      "verified" in error &&
      error.verified === true
  );

  assert.equal(initialized, true);
  assert.equal(runtimeCalls, 0);
});

test("run delegates one work item to Codex with an explicit safety mode", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const output = createOutput();
  const calls: unknown[] = [];

  const exitCode = await runCli({
    args: [
      "run",
      "TS-9",
      "--read-only",
      "--prompt",
      "Return a short status."
    ],
    cwd,
    output,
    runWorkItem: async (options) => {
      calls.push(options);
      return {
        attemptId: "attempt-9",
        outcome: "completed",
        runtimeRefs: {
          sessionId: "thread-9",
          executionId: "turn-9"
        },
        summary: "Ready."
      };
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    {
      cwd,
      workItemId: "TS-9",
      prompt: "Return a short status.",
      sandbox: "read-only"
    }
  ]);
  assert.match(output.text(), /attempt-9/);
  assert.match(output.text(), /completed/);
  assert.match(
    output.text(),
    /Runner session: thread-9/
  );
  assert.match(
    output.text(),
    /Runner execution: turn-9/
  );
  assert.match(output.text(), /Ready\./);
});

test("run defaults to read-only workspace access", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const calls: unknown[] = [];

  const exitCode = await runCli({
    args: ["run", "TS-9"],
    cwd,
    output: createOutput(),
    runWorkItem: async (options) => {
      calls.push(options);
      return {
        attemptId: "attempt-9",
        outcome: "completed"
      };
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    {
      cwd,
      workItemId: "TS-9",
      prompt: undefined,
      sandbox: "read-only"
    }
  ]);
});

test("run grants workspace write only through an explicit flag", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const calls: unknown[] = [];

  const exitCode = await runCli({
    args: ["run", "TS-9", "--workspace-write"],
    cwd,
    output: createOutput(),
    runWorkItem: async (options) => {
      calls.push(options);
      return {
        attemptId: "attempt-9",
        outcome: "completed"
      };
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    {
      cwd,
      workItemId: "TS-9",
      prompt: undefined,
      sandbox: "workspace-write"
    }
  ]);
});

test("run rejects conflicting workspace access flags before invoking the Runner", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  let invoked = false;

  const exitCode = await runCli({
    args: [
      "run",
      "TS-9",
      "--read-only",
      "--workspace-write"
    ],
    cwd,
    output: createOutput(),
    runWorkItem: async () => {
      invoked = true;
    }
  });

  assert.equal(exitCode, 2);
  assert.equal(invoked, false);
});

test("run returns a failing exit code for non-completed turns", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const output = createOutput();

  const exitCode = await runCli({
    args: ["run", "TS-1"],
    cwd,
    output,
    runWorkItem: async () => ({
      attemptId: "attempt-1",
      outcome: "failed",
      summary: "Codex could not complete the turn."
    })
  });

  assert.equal(exitCode, 1);
  assert.match(output.text(), /failed/);
});

test("local CLI run refuses a WorkItem managed by an approved decomposition", async () => {
  let runnerInvoked = false;

  await assert.rejects(
    runLocalCodexWorkItem({
      cwd: ".",
      workItemId: "TS-1",
      prompt: "Do not bypass the DAG.",
      runtimeFactory:
        async () => ({
          service: {
            getWorkItem() {
              return {
                id: "TS-1",
                title:
                  "Managed work"
              };
            }
          },
          runner: {
            async run() {
              runnerInvoked = true;
              return {
                attemptId:
                  "attempt-unexpected",
                outcome:
                  "completed",
                handoffClaims: []
              };
            }
          },
          decomposition: {
            assertManualRunAllowed() {
              throw Object.assign(
                new Error(
                  "Managed WorkItems must use DAG dispatch."
                ),
                {
                  code:
                    "DECOMPOSITION_MANAGED_WORK_ITEM"
                }
              );
            }
          }
        })
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code ===
        "DECOMPOSITION_MANAGED_WORK_ITEM"
  );
  assert.equal(
    runnerInvoked,
    false
  );
});

test("run rejects incomplete or unknown arguments before starting Codex", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const output = createOutput();
  let invoked = false;

  const exitCode = await runCli({
    args: ["run", "--prompt"],
    cwd,
    output,
    runWorkItem: async () => {
      invoked = true;
    }
  });

  assert.equal(exitCode, 2);
  assert.equal(invoked, false);
  assert.match(output.text(), /Usage:/);
});

test("unknown commands return a usage error", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const output = createOutput();

  const exitCode = await runCli({
    args: ["unknown"],
    cwd,
    output
  });

  assert.equal(exitCode, 2);
  assert.match(output.text(), /Usage:/);
});

function createOutput(): OutputPort & {
  text(): string;
} {
  const chunks: string[] = [];

  return {
    write(value: string) {
      chunks.push(String(value));
    },
    text() {
      return chunks.join("");
    }
  };
}

async function createTemporaryDirectory(
  t: TestContext
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taskseal-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readJsonPath(
  value: unknown,
  ...path: string[]
): unknown {
  let current = value;

  for (const segment of path) {
    if (!isRecord(current)) {
      throw new TypeError("Expected a JSON object.");
    }

    current = current[segment];
  }

  return current;
}

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
