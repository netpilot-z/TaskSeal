import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  resolveCodexInvocation,
  runCli,
  startPersistentControlRoom
} from "../src/cli.js";
import { FileEventJournal } from "../src/storage/event-journal.ts";

test("init creates one local work item and remains idempotent", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const output = createOutput();
  const now = () => new Date("2026-07-26T09:00:00.000Z");

  assert.equal(await runCli({ args: ["init"], cwd, output, now }), 0);
  assert.equal(await runCli({ args: ["init"], cwd, output, now }), 0);

  const journal = new FileEventJournal({
    filePath: join(cwd, ".taskseal", "events.jsonl")
  });
  const events = await journal.readAll();

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "work_item.created");
  assert.equal(events[0].workItemId, "TS-1");
  assert.doesNotMatch(JSON.stringify(events), new RegExp(escapeRegExp(cwd)));
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
  const commands = [];
  const commandRunner = async (command, args) => {
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
  const commandRunner = async (command, args) => {
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
      const error = new Error("not found");
      error.code = "ENOENT";
      throw error;
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

test("persistent start wires one service and runner into the Control Room", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const output = createOutput();
  const calls = [];
  const service = { snapshot() {}, getWorkItem() {} };
  const runner = {
    async run(options) {
      calls.push(options);
      return { outcome: "completed" };
    }
  };
  let initialized = false;
  let shutDown = false;
  let serverOptions;
  const signalSource = new EventEmitter();
  class FakeServer extends EventEmitter {
    listen(port, host, callback) {
      calls.push({ port, host });
      callback();
    }

    async shutdown() {
      shutDown = true;
      this.emit("close");
    }
  }

  const server = await startPersistentControlRoom({
    cwd,
    output,
    environment: {
      HOST: "127.0.0.1",
      PORT: "0"
    },
    signalSource,
    initialize: async () => {
      initialized = true;
    },
    runtimeFactory: async () => ({ service, runner }),
    serverFactory: (options) => {
      serverOptions = options;
      return new FakeServer();
    }
  });

  assert.equal(initialized, true);
  assert.equal(server instanceof FakeServer, true);
  assert.equal(serverOptions.service, service);
  await serverOptions.runWorkItem({
    workItemId: "TS-1",
    prompt: "Run from the Control Room.",
    sandbox: "read-only"
  });
  assert.deepEqual(calls, [
    { port: 0, host: "127.0.0.1" },
    {
      workItemId: "TS-1",
      prompt: "Run from the Control Room.",
      sandbox: "read-only",
      cwd,
      approvalPolicy: "never"
    }
  ]);
  assert.match(output.text(), /http:\/\/127\.0\.0\.1:0/);

  signalSource.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutDown, true);
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

test("run delegates one work item to Codex with an explicit safety mode", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const output = createOutput();
  const calls = [];

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
        threadId: "thread-9",
        turnId: "turn-9",
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
  assert.match(output.text(), /Ready\./);
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

function createOutput() {
  const chunks = [];

  return {
    write(value) {
      chunks.push(String(value));
    },
    text() {
      return chunks.join("");
    }
  };
}

async function createTemporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "taskseal-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
