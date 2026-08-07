import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  runCli
} from "../src/cli.ts";
import type {
  OutputPort
} from "../src/cli.ts";

test("help config returns focused command guidance without project access", async () => {
  const output = createOutput();

  assert.equal(
    await runCli({
      args: ["help", "config"],
      cwd: join(tmpdir(), "taskseal-help-does-not-need-a-project"),
      output,
      environment: {},
      userConfigurationPath: null
    }),
    0
  );

  assert.match(output.text(), /^Usage:\n  taskseal config list/m);
  assert.match(output.text(), /taskseal config template <github\|linear\|feishu\|gitee>/);
  assert.match(output.text(), /do(?:es)? not include credentials/i);
});

test("config template emits credential-free provider fragments without initialized configuration", async () => {
  for (const provider of ["github", "linear", "feishu", "gitee"] as const) {
    const output = createOutput();

    assert.equal(
      await runCli({
        args: ["config", "template", provider, "--json"],
        cwd: join(tmpdir(), `taskseal-template-${provider}-missing-project`),
        output,
        environment: {},
        userConfigurationPath: null
      }),
      0
    );

    const template: unknown = JSON.parse(output.text());
    assert.equal(
      readJsonPath(template, "schemaVersion"),
      "configuration-template/v1"
    );
    assert.equal(readJsonPath(template, "provider"), provider);
    assert.ok(
      Array.isArray(readJsonPath(template, "replaceBeforeUse"))
    );
    assert.equal(
      typeof readJsonPath(template, "fragment", provider),
      "object"
    );
    assert.doesNotMatch(
      output.text(),
      /(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*["':=]+\s*(?!env:|null|false|\[|\{)/i
    );
  }
});

test("config template rejects unknown providers with configuration help", async () => {
  const output = createOutput();

  assert.equal(
    await runCli({
      args: ["config", "template", "unknown"],
      cwd: join(tmpdir(), "taskseal-template-invalid-provider"),
      output,
      environment: {},
      userConfigurationPath: null
    }),
    2
  );
  assert.match(output.text(), /taskseal config template <github\|linear\|feishu\|gitee>/);
});

test("help rejects extra topics before any project access", async () => {
  const output = createOutput();

  assert.equal(
    await runCli({
      args: ["help", "config", "extra"],
      cwd: join(tmpdir(), "taskseal-help-extra-missing-project"),
      output,
      environment: {},
      userConfigurationPath: null
    }),
    2
  );
  assert.match(output.text(), /^Usage:/);
});

test("config list JSON is locale-independent and contains no local absolute paths", async (t) => {
  const { cwd, userConfigurationPath } = await createConfiguredProject(t);
  const english = createOutput();
  const chinese = createOutput();

  assert.equal(
    await runCli({
      args: ["config", "list", "--json", "--lang", "en"],
      cwd,
      output: english,
      environment: {},
      userConfigurationPath,
      detectedLocales: ["en-US"]
    }),
    0
  );
  assert.equal(
    await runCli({
      args: ["--lang", "zh-CN", "config", "list", "--json"],
      cwd,
      output: chinese,
      environment: {},
      userConfigurationPath,
      detectedLocales: ["zh-CN"]
    }),
    0
  );

  assert.equal(chinese.text(), english.text());
  assert.doesNotMatch(
    english.text(),
    new RegExp(escapeRegExp(cwd))
  );
  assert.doesNotMatch(
    english.text(),
    new RegExp(escapeRegExp(userConfigurationPath))
  );
  const value: unknown = JSON.parse(english.text());
  assert.equal(readJsonPath(value, "schemaVersion"), "configuration-view/v1");
});

test("config get uses the command locale while preserving stable field values", async (t) => {
  const { cwd, userConfigurationPath } = await createConfiguredProject(t);
  const english = createOutput();
  const chinese = createOutput();

  assert.equal(
    await runCli({
      args: ["config", "get", "ui.locale", "--lang", "en"],
      cwd,
      output: english,
      environment: {},
      userConfigurationPath
    }),
    0
  );
  assert.equal(
    await runCli({
      args: ["config", "get", "ui.locale", "--lang", "zh-CN"],
      cwd,
      output: chinese,
      environment: {},
      userConfigurationPath
    }),
    0
  );

  assert.equal(english.text(), "ui.locale = zh-CN (source: user)\n");
  assert.equal(chinese.text(), "ui.locale = zh-CN（来源：user）\n");
});

test("config validate reports invalid local configuration without network work", async (t) => {
  const { cwd, userConfigurationPath } = await createConfiguredProject(t);
  await writeFile(
    join(cwd, ".taskseal", "config.local.json"),
    JSON.stringify({
      runtime: { port: 70_000 }
    })
  );
  const output = createOutput();

  assert.equal(
    await runCli({
      args: ["config", "validate", "--json"],
      cwd,
      output,
      environment: {},
      userConfigurationPath
    }),
    1
  );

  const result: unknown = JSON.parse(output.text());
  assert.equal(readJsonPath(result, "valid"), false);
  assert.equal(
    readJsonPath(result, "diagnostics", "0", "code"),
    "LOCAL_CONFIG_INVALID"
  );
});

test("doctor honors the global Simplified Chinese presentation override", async (t) => {
  const { cwd, userConfigurationPath } = await createConfiguredProject(t);
  const output = createOutput();

  assert.equal(
    await runCli({
      args: ["doctor", "--lang", "zh-CN"],
      cwd,
      output,
      environment: {
        TASKSEAL_CODEX_BIN: "codex"
      },
      userConfigurationPath,
      nodeVersion: "24.12.0",
      commandRunner: async (_command, args) => ({
        exitCode: 0,
        stdout:
          args[0] === "--version"
            ? "codex-cli test\n"
            : "Logged in using ChatGPT\n",
        stderr: ""
      })
    }),
    0
  );

  assert.match(output.text(), /项目配置 — 已就绪/);
  assert.match(output.text(), /Codex 登录 — 已就绪/);
  assert.match(output.text(), /GitHub 集成 — 未启用/);
});

test("config set and unset use preview/apply and return stable receipts", async (t) => {
  const { cwd, userConfigurationPath } = await createConfiguredProject(t);
  const setOutput = createOutput();

  assert.equal(
    await runCli({
      args: [
        "config",
        "set",
        "ui.locale",
        "en",
        "--json",
        "--lang",
        "zh-CN"
      ],
      cwd,
      output: setOutput,
      environment: {},
      userConfigurationPath
    }),
    0
  );
  const setReceipt: unknown = JSON.parse(setOutput.text());
  assert.equal(readJsonPath(setReceipt, "applied"), true);
  assert.equal(
    readJsonPath(
      JSON.parse(await readFile(userConfigurationPath, "utf8")),
      "ui",
      "locale"
    ),
    "en"
  );

  const unsetOutput = createOutput();
  assert.equal(
    await runCli({
      args: ["config", "unset", "ui.locale", "--json"],
      cwd,
      output: unsetOutput,
      environment: {},
      userConfigurationPath
    }),
    0
  );
  assert.equal(
    readJsonPath(JSON.parse(unsetOutput.text()), "applied"),
    true
  );
  assert.deepEqual(
    JSON.parse(await readFile(userConfigurationPath, "utf8")),
    {}
  );
});

test("config set rejects forbidden persisted workspace access with a stable error", async (t) => {
  const { cwd, userConfigurationPath } = await createConfiguredProject(t);
  const output = createOutput();

  assert.equal(
    await runCli({
      args: [
        "config",
        "set",
        "workspaceAccess",
        "workspace-write",
        "--json"
      ],
      cwd,
      output,
      environment: {},
      userConfigurationPath
    }),
    1
  );
  assert.deepEqual(JSON.parse(output.text()), {
    schemaVersion: "configuration-error/v1",
    code: "CONFIG_FIELD_NOT_EDITABLE"
  });
});

test("config edit commits a validated multi-field draft and removes its temporary file", async (t) => {
  const { cwd, userConfigurationPath } = await createConfiguredProject(t);
  const output = createOutput();
  let temporaryPath = "";

  assert.equal(
    await runCli({
      args: ["config", "edit", "project", "--json"],
      cwd,
      output,
      environment: {},
      userConfigurationPath,
      configurationEditor: async ({ filePath, scope }) => {
        temporaryPath = filePath;
        assert.equal(scope, "project");
        const draft: unknown = JSON.parse(await readFile(filePath, "utf8"));
        await writeFile(
          filePath,
          `${JSON.stringify({
            ...(draft as Record<string, unknown>),
            linear: {
              workspace: "netpilot-z",
              team: "netpilot"
            }
          }, null, 2)}\n`
        );
        return 0;
      }
    }),
    0
  );

  assert.equal(readJsonPath(JSON.parse(output.text()), "applied"), true);
  assert.equal(
    readJsonPath(
      JSON.parse(
        await readFile(join(cwd, "config", "project.json"), "utf8")
      ),
      "linear",
      "team"
    ),
    "netpilot"
  );
  assert.notEqual(temporaryPath, "");
  await assert.rejects(readFile(temporaryPath), hasFileCode("ENOENT"));
});

test("config edit discards editor failures and invalid drafts without touching the source", async (t) => {
  const { cwd, userConfigurationPath } = await createConfiguredProject(t);
  const projectPath = join(cwd, "config", "project.json");
  const original = await readFile(projectPath, "utf8");
  const failedOutput = createOutput();

  assert.equal(
    await runCli({
      args: ["config", "edit", "project", "--json"],
      cwd,
      output: failedOutput,
      environment: {},
      userConfigurationPath,
      configurationEditor: async () => 7
    }),
    1
  );
  assert.equal(
    readJsonPath(JSON.parse(failedOutput.text()), "code"),
    "CONFIG_EDITOR_FAILED"
  );
  assert.equal(await readFile(projectPath, "utf8"), original);

  const invalidOutput = createOutput();
  assert.equal(
    await runCli({
      args: ["config", "edit", "project", "--json"],
      cwd,
      output: invalidOutput,
      environment: {},
      userConfigurationPath,
      configurationEditor: async ({ filePath }) => {
        await writeFile(
          filePath,
          JSON.stringify({
            project: "TaskSeal",
            workspaceAccess: "workspace-write"
          })
        );
        return 0;
      }
    }),
    1
  );
  assert.equal(
    readJsonPath(JSON.parse(invalidOutput.text()), "code"),
    "CONFIG_VALUE_INVALID"
  );
  assert.equal(await readFile(projectPath, "utf8"), original);
});

test("config commands fail closed instead of writing beside an unverifiable running instance", async (t) => {
  const { cwd, userConfigurationPath } = await createConfiguredProject(t);
  await writeFile(
    join(cwd, ".taskseal", "control-room.lock"),
    JSON.stringify({
      schemaVersion: 1,
      processId: 123,
      acquiredAt: "2026-08-03T12:00:00.000Z",
      nonce: "legacy-instance"
    })
  );
  const output = createOutput();

  assert.equal(
    await runCli({
      args: ["config", "set", "runtime.port", "7500", "--json"],
      cwd,
      output,
      environment: {},
      userConfigurationPath
    }),
    1
  );
  assert.deepEqual(JSON.parse(output.text()), {
    schemaVersion: "configuration-error/v1",
    code: "CONTROL_ROOM_HANDOFF_UNAVAILABLE"
  });
  assert.equal(
    readJsonPath(
      JSON.parse(
        await readFile(join(cwd, ".taskseal", "config.local.json"), "utf8")
      ),
      "runtime",
      "port"
    ),
    4400
  );
});

async function createConfiguredProject(t: TestContext): Promise<{
  cwd: string;
  userConfigurationPath: string;
}> {
  const cwd = await createTemporaryDirectory(t);
  const userDirectory = await createTemporaryDirectory(t);
  const userConfigurationPath = join(userDirectory, "config.json");
  await mkdir(join(cwd, "config"), { recursive: true });
  await mkdir(join(cwd, ".taskseal"), { recursive: true });
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({ project: "TaskSeal" })
  );
  await writeFile(
    join(cwd, ".taskseal", "config.local.json"),
    JSON.stringify({ runtime: { port: 4400 } })
  );
  await writeFile(
    userConfigurationPath,
    JSON.stringify({ ui: { locale: "zh-CN" } })
  );
  return { cwd, userConfigurationPath };
}

function createOutput(): OutputPort & { text(): string } {
  let value = "";
  return {
    write(chunk) {
      value += chunk;
    },
    text() {
      return value;
    }
  };
}

async function createTemporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taskseal-config-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function readJsonPath(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (
      typeof current !== "object" ||
      current === null ||
      !Object.hasOwn(current, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasFileCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}
