import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, {
  type TestContext
} from "node:test";

import {
  inspectConfiguration,
  resolveUserConfigurationPath
} from "../src/application/configuration-control.ts";

test("user configuration paths follow platform conventions without entering public views", () => {
  assert.equal(
    resolveUserConfigurationPath({
      platform: "win32",
      environment: { APPDATA: "R:/profile" },
      homeDirectory: "R:/home"
    }),
    join("R:/profile", "TaskSeal", "config.json")
  );
  assert.equal(
    resolveUserConfigurationPath({
      platform: "linux",
      environment: { XDG_CONFIG_HOME: "/profile" },
      homeDirectory: "/home/operator"
    }),
    join("/profile", "taskseal", "config.json")
  );
  assert.equal(
    resolveUserConfigurationPath({
      platform: "darwin",
      environment: {},
      homeDirectory: "/Users/operator"
    }),
    join(
      "/Users/operator",
      "Library",
      "Application Support",
      "TaskSeal",
      "config.json"
    )
  );
});

test("configuration inspection exposes a safe effective project view with source metadata", async (t) => {
  const raw = `${JSON.stringify({
    project: "TaskSeal",
    mode: "persistent"
  })}\n`;
  const cwd = await createProject(t, raw);

  const view = await inspectConfiguration({ cwd });

  assert.equal(view.schemaVersion, "configuration-view/v1");
  assert.match(view.runtimeRevision, /^sha256:[0-9a-f]{64}$/);
  assert.equal(view.ready, true);
  assert.deepEqual(view.capabilities, {
    github: "disabled",
    linear: "disabled",
    gitee: "disabled",
    feishu: "disabled"
  });
  assert.deepEqual(view.effective, {
    project: "TaskSeal",
    mode: "persistent"
  });
  assert.deepEqual(view.source, {
    path: "config/project.json",
    status: "loaded",
    revision: `sha256:${createHash("sha256").update(raw).digest("hex")}`
  });
  assert.deepEqual(view.fields, [
    {
      key: "project",
      value: "TaskSeal",
      source: "project",
      editableScopes: ["project"],
      sensitive: false,
      restartRequired: true
    },
    {
      key: "mode",
      value: "persistent",
      source: "project",
      editableScopes: ["project"],
      sensitive: false,
      restartRequired: true
    },
    {
      key: "ui.locale",
      value: "auto",
      source: "built-in",
      editableScopes: ["user"],
      sensitive: false,
      restartRequired: false
    },
    {
      key: "runtime.port",
      value: 7331,
      source: "built-in",
      editableScopes: ["local"],
      sensitive: false,
      restartRequired: true
    }
  ]);
  assert.deepEqual(view.diagnostics, []);
  assert.deepEqual(
    view.definitions
      .filter(({ key }) => key === "ui.locale" || key === "runtime.port")
      .map(({ key, valueType, editableScopes, restartRequired }) => ({
        key,
        valueType,
        editableScopes,
        restartRequired
      })),
    [
      {
        key: "ui.locale",
        valueType: "enum",
        editableScopes: ["user"],
        restartRequired: false
      },
      {
        key: "runtime.port",
        valueType: "number",
        editableScopes: ["local"],
        restartRequired: true
      }
    ]
  );
  assert.equal(view.definitions.some(({ key }) => /token|secret|cookie/i.test(key)), false);
  assert.doesNotMatch(
    JSON.stringify(view),
    new RegExp(escapeRegExp(cwd))
  );
});

test("presentation-only locale changes do not drift the active runtime revision", async (t) => {
  const cwd = await createProject(t, JSON.stringify({ project: "TaskSeal" }));
  const userDirectory = await createTemporaryDirectory(t);
  const userConfigurationPath = join(userDirectory, "config.json");
  await writeFile(userConfigurationPath, JSON.stringify({ ui: { locale: "en" } }));
  const english = await inspectConfiguration({
    cwd,
    userConfigurationPath,
    environment: {}
  });

  await writeFile(userConfigurationPath, JSON.stringify({ ui: { locale: "zh-CN" } }));
  const chinese = await inspectConfiguration({
    cwd,
    userConfigurationPath,
    environment: {}
  });

  assert.notEqual(english.revision, chinese.revision);
  assert.equal(english.runtimeRevision, chinese.runtimeRevision);
});

test("provider coordinates are operation-bound and do not require a process restart", async (t) => {
  const cwd = await createProject(t, JSON.stringify({ project: "TaskSeal" }));
  const before = await inspectConfiguration({ cwd, environment: {} });
  const control = await import("../src/application/configuration-control.ts");
  const plan = await control.previewConfigurationChange(
    { cwd, environment: {} },
    { operation: "set", key: "github.repository", value: "netpilot-z/TaskSeal" },
    before.revision
  );
  assert.equal(plan.restartRequired, false);
  await control.applyConfigurationPlan({ cwd, environment: {} }, plan);
  assert.equal(
    before.runtimeRevision,
    (await inspectConfiguration({ cwd, environment: {} })).runtimeRevision
  );
});

test("configuration inspection exposes provider access readiness without credential values", async (t) => {
  const cwd = await createProject(
    t,
    JSON.stringify({
      project: "TaskSeal",
      github: { repository: "netpilot-z/TaskSeal" },
      linear: {
        workspace: "netpilot-z",
        team: "netpilot"
      },
      feishu: {
        enabled: true,
        tableScopeKey: `feishu:table:sha256:${"a".repeat(64)}`
      }
    })
  );
  const view = await inspectConfiguration({
    cwd,
    environment: {
      GITHUB_TOKEN: "github-secret-value",
      LINEAR_ACCESS_TOKEN: "linear-secret-value",
      TASKSEAL_FEISHU_APP_ID: "feishu-app-id",
      TASKSEAL_FEISHU_APP_SECRET: "feishu-secret-value"
    }
  });

  assert.deepEqual(view.integrations, [
    {
      id: "github",
      configured: true,
      capability: "ready",
      credential: {
        requirement: "optional",
        status: "present",
        bindings: ["env:GITHUB_TOKEN"]
      },
      setupUrl: "https://github.com/settings/tokens?type=beta"
    },
    {
      id: "linear",
      configured: true,
      capability: "ready",
      credential: {
        requirement: "required",
        status: "present",
        bindings: ["env:LINEAR_ACCESS_TOKEN"]
      },
      setupUrl: "https://linear.app/settings/api"
    },
    {
      id: "feishu",
      configured: true,
      capability: "ready",
      credential: {
        requirement: "required",
        status: "present",
        bindings: [
          "env:TASKSEAL_FEISHU_APP_ID",
          "env:TASKSEAL_FEISHU_APP_SECRET"
        ]
      },
      setupUrl: "https://open.feishu.cn/app"
    },
    {
      id: "gitee",
      configured: false,
      capability: "disabled",
      credential: {
        requirement: "none",
        status: "not-configured",
        bindings: []
      },
      setupUrl: "https://gitee.com/profile/personal_access_tokens"
    }
  ]);
  assert.doesNotMatch(
    JSON.stringify(view),
    /github-secret-value|linear-secret-value|feishu-secret-value/
  );
});

test("configuration inspection resolves user, local, environment, and command sources by policy", async (t) => {
  const cwd = await createProject(
    t,
    JSON.stringify({
      project: "TaskSeal"
    })
  );
  const userDirectory = await createTemporaryDirectory(t);
  const userConfigurationPath = join(
    userDirectory,
    "config.json"
  );
  await writeFile(
    userConfigurationPath,
    JSON.stringify({
      ui: {
        locale: "zh-CN"
      }
    })
  );
  await mkdir(join(cwd, ".taskseal"), { recursive: true });
  await writeFile(
    join(cwd, ".taskseal", "config.local.json"),
    JSON.stringify({
      runtime: {
        port: 4400
      }
    })
  );

  const local = await inspectConfiguration({
    cwd,
    userConfigurationPath,
    environment: {}
  });
  const environment = await inspectConfiguration({
    cwd,
    userConfigurationPath,
    environment: { PORT: "4500" }
  });
  const command = await inspectConfiguration({
    cwd,
    userConfigurationPath,
    environment: { PORT: "4500" },
    command: { runtimePort: 4600 }
  });

  assert.deepEqual(readField(local, "ui.locale"), {
    key: "ui.locale",
    value: "zh-CN",
    source: "user",
    editableScopes: ["user"],
    sensitive: false,
    restartRequired: false
  });
  assert.equal(readField(local, "runtime.port").value, 4400);
  assert.equal(readField(local, "runtime.port").source, "local");
  assert.equal(readField(environment, "runtime.port").value, 4500);
  assert.equal(readField(environment, "runtime.port").source, "environment");
  assert.equal(readField(command, "runtime.port").value, 4600);
  assert.equal(readField(command, "runtime.port").source, "command");
  assert.equal(command.ready, true);
  assert.notEqual(local.revision, environment.revision);
  assert.notEqual(environment.revision, command.revision);
  assert.deepEqual(
    command.sources.map(({ scope, status }) => ({ scope, status })),
    [
      { scope: "user", status: "loaded" },
      { scope: "project", status: "loaded" },
      { scope: "local", status: "loaded" }
    ]
  );
});

test("configuration inspection rejects unsafe persisted overrides without exposing their values", async (t) => {
  const cwd = await createProject(
    t,
    JSON.stringify({
      project: "TaskSeal"
    })
  );
  const userDirectory = await createTemporaryDirectory(t);
  const userConfigurationPath = join(userDirectory, "config.json");
  const unsafeValue = "workspace-write-must-not-persist";
  await writeFile(
    userConfigurationPath,
    JSON.stringify({
      ui: {
        locale: "zh-CN"
      },
      workspaceAccess: unsafeValue
    })
  );
  await mkdir(join(cwd, ".taskseal"), { recursive: true });
  await writeFile(
    join(cwd, ".taskseal", "config.local.json"),
    JSON.stringify({
      runtime: {
        port: 4400
      },
      workspaceAccess: unsafeValue
    })
  );

  const view = await inspectConfiguration({
    cwd,
    userConfigurationPath,
    environment: {}
  });

  assert.equal(view.ready, false);
  assert.deepEqual(
    view.diagnostics.map(({ code, field, messageKey }) => ({
      code,
      field,
      messageKey
    })),
    [
      {
        code: "USER_CONFIG_INVALID",
        field: "ui",
        messageKey: "config.user.invalid"
      },
      {
        code: "LOCAL_CONFIG_INVALID",
        field: "runtime",
        messageKey: "config.local.invalid"
      }
    ]
  );
  assert.doesNotMatch(JSON.stringify(view), new RegExp(unsafeValue));
  assert.doesNotMatch(
    JSON.stringify(view),
    new RegExp(escapeRegExp(userConfigurationPath))
  );
});

test("configuration inspection isolates invalid provider capability and redacts unsupported values", async (t) => {
  const secret = "must-never-leave-the-source";
  const cwd = await createProject(
    t,
    JSON.stringify({
      project: "TaskSeal",
      github: {
        repository: "netpilot-z/TaskSeal",
        token: secret
      },
      linear: {
        workspace: "netpilot-z",
        team: "netpilot"
      }
    })
  );

  const view = await inspectConfiguration({ cwd });

  assert.equal(view.ready, false);
  assert.equal(view.effective, null);
  assert.deepEqual(view.capabilities, {
    github: "invalid",
    linear: "ready",
    gitee: "disabled",
    feishu: "disabled"
  });
  assert.deepEqual(view.diagnostics, [
    {
      code: "GITHUB_CONFIG_INVALID",
      field: "github",
      messageKey: "config.github.invalid"
    }
  ]);
  assert.deepEqual(
    view.fields.map((field) => field.key),
    [
      "project",
      "github.repository",
      "linear.workspace",
      "linear.team",
      "ui.locale",
      "runtime.port"
    ]
  );
  assert.doesNotMatch(JSON.stringify(view), new RegExp(secret));
  assert.doesNotMatch(
    JSON.stringify(view),
    new RegExp(escapeRegExp(cwd))
  );
});

test("configuration inspection reports missing and invalid project sources without throwing", async (t) => {
  const cwd = await createTemporaryDirectory(t);

  const missing = await inspectConfiguration({ cwd });

  assert.equal(missing.ready, false);
  assert.equal(missing.effective, null);
  assert.deepEqual(missing.source, {
    path: "config/project.json",
    status: "missing",
    revision: null
  });
  assert.deepEqual(
    missing.fields.map(({ key, value, source }) => ({ key, value, source })),
    [
      { key: "ui.locale", value: "auto", source: "built-in" },
      { key: "runtime.port", value: 7331, source: "built-in" }
    ]
  );
  assert.deepEqual(missing.capabilities, {
    github: "invalid",
    linear: "invalid",
    gitee: "invalid",
    feishu: "invalid"
  });
  assert.deepEqual(missing.diagnostics, [
    {
      code: "PROJECT_CONFIG_INVALID",
      field: "project",
      messageKey: "config.project.invalid"
    }
  ]);

  const invalidRaw = "{invalid-json";
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(
    join(cwd, "config", "project.json"),
    invalidRaw
  );

  const invalid = await inspectConfiguration({ cwd });

  assert.equal(invalid.source.status, "invalid");
  assert.equal(
    invalid.source.revision,
    `sha256:${createHash("sha256").update(invalidRaw).digest("hex")}`
  );
  assert.equal(invalid.effective, null);
  assert.doesNotMatch(JSON.stringify(invalid), /invalid-json/);
});

async function createProject(
  t: TestContext,
  raw: string
): Promise<string> {
  const cwd = await createTemporaryDirectory(t);
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(join(cwd, "config", "project.json"), raw);
  return cwd;
}

async function createTemporaryDirectory(
  t: TestContext
): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "taskseal-configuration-control-")
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readField(
  view: Awaited<ReturnType<typeof inspectConfiguration>>,
  key: string
) {
  const field = view.fields.find((candidate) => candidate.key === key);
  assert.ok(field, `Expected configuration field ${key}.`);
  return field;
}
