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
  applyConfigurationPlan,
  applyConfigurationDraftPlan,
  inspectConfiguration,
  previewConfigurationChange,
  previewConfigurationDraft,
  readConfigurationDraft
} from "../src/application/configuration-control.ts";

test("configuration change preview is read-only and apply is atomic and idempotent", async (t) => {
  const { cwd, userConfigurationPath } = await createProject(t);
  const context = {
    cwd,
    userConfigurationPath,
    environment: {}
  } as const;
  const before = await inspectConfiguration(context);

  const plan = await previewConfigurationChange(
    context,
    {
      operation: "set",
      key: "ui.locale",
      value: "zh-CN"
    },
    before.revision
  );

  assert.equal(plan.schemaVersion, "configuration-plan/v1");
  assert.equal(plan.target.scope, "user");
  assert.equal(plan.before.present, true);
  assert.equal(plan.before.value, "auto");
  assert.equal(plan.after.present, true);
  assert.equal(plan.after.value, "zh-CN");
  assert.equal(plan.restartRequired, false);
  assert.match(plan.planDigest, /^sha256:[0-9a-f]{64}$/);
  await assert.rejects(readFile(userConfigurationPath), hasFileCode("ENOENT"));

  const receipt = await applyConfigurationPlan(context, plan);
  const replay = await applyConfigurationPlan(context, plan);
  const persisted: unknown = JSON.parse(
    await readFile(userConfigurationPath, "utf8")
  );

  assert.equal(receipt.schemaVersion, "configuration-receipt/v1");
  assert.equal(receipt.applied, true);
  assert.equal(replay.applied, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(persisted, {
    ui: { locale: "zh-CN" }
  });
  assert.equal(
    readField(await inspectConfiguration(context), "ui.locale").value,
    "zh-CN"
  );
});

test("stale and tampered plans perform zero writes", async (t) => {
  const { cwd, userConfigurationPath } = await createProject(t);
  const context = {
    cwd,
    userConfigurationPath,
    environment: {}
  } as const;
  const before = await inspectConfiguration(context);
  const plan = await previewConfigurationChange(
    context,
    {
      operation: "set",
      key: "runtime.port",
      value: 4400
    },
    before.revision
  );
  await mkdir(join(cwd, ".taskseal"), { recursive: true });
  const localPath = join(cwd, ".taskseal", "config.local.json");
  await writeFile(
    localPath,
    `${JSON.stringify({ runtime: { port: 4500 } }, null, 2)}\n`
  );

  await assert.rejects(
    applyConfigurationPlan(context, plan),
    hasCode("CONFIG_REVISION_CONFLICT")
  );
  assert.equal(
    (JSON.parse(await readFile(localPath, "utf8")) as {
      runtime: { port: number };
    }).runtime.port,
    4500
  );

  const current = await inspectConfiguration(context);
  const freshPlan = await previewConfigurationChange(
    context,
    {
      operation: "set",
      key: "ui.locale",
      value: "en"
    },
    current.revision
  );
  const tampered = {
    ...freshPlan,
    change: {
      ...freshPlan.change,
      value: "zh-CN"
    }
  };

  await assert.rejects(
    applyConfigurationPlan(context, tampered),
    hasCode("CONFIG_PLAN_INVALID")
  );
  await assert.rejects(readFile(userConfigurationPath), hasFileCode("ENOENT"));
});

test("configuration writes reject forbidden fields and invalid values during preview", async (t) => {
  const { cwd, userConfigurationPath } = await createProject(t);
  const context = {
    cwd,
    userConfigurationPath,
    environment: {}
  } as const;
  const revision = (await inspectConfiguration(context)).revision;

  await assert.rejects(
    previewConfigurationChange(
      context,
      {
        operation: "set",
        key: "workspaceAccess",
        value: "workspace-write"
      },
      revision
    ),
    hasCode("CONFIG_FIELD_NOT_EDITABLE")
  );
  await assert.rejects(
    previewConfigurationChange(
      context,
      {
        operation: "set",
        key: "runtime.port",
        value: 70_000
      },
      revision
    ),
    hasCode("CONFIG_VALUE_INVALID")
  );
  await assert.rejects(
    previewConfigurationChange(
      context,
      {
        operation: "set",
        key: "github.repository",
        value: "not-a-repository"
      },
      revision
    ),
    hasCode("CONFIG_VALUE_INVALID")
  );
  await assert.rejects(readFile(userConfigurationPath), hasFileCode("ENOENT"));
  await assert.rejects(
    readFile(join(cwd, ".taskseal", "config.local.json")),
    hasFileCode("ENOENT")
  );
});

test("project field writes reuse provider validation and remove empty parent objects", async (t) => {
  const { cwd, userConfigurationPath } = await createProject(t);
  const context = {
    cwd,
    userConfigurationPath,
    environment: {}
  } as const;
  const projectPath = join(cwd, "config", "project.json");
  const initial = await inspectConfiguration(context);
  const setPlan = await previewConfigurationChange(
    context,
    {
      operation: "set",
      key: "github.repository",
      value: "netpilot-z/TaskSeal"
    },
    initial.revision
  );
  const setReceipt = await applyConfigurationPlan(context, setPlan);
  assert.equal(setReceipt.applied, true);
  assert.deepEqual(JSON.parse(await readFile(projectPath, "utf8")), {
    project: "TaskSeal",
    github: { repository: "netpilot-z/TaskSeal" }
  });

  const current = await inspectConfiguration(context);
  const unsetPlan = await previewConfigurationChange(
    context,
    {
      operation: "unset",
      key: "github.repository"
    },
    current.revision
  );
  await applyConfigurationPlan(context, unsetPlan);
  assert.deepEqual(JSON.parse(await readFile(projectPath, "utf8")), {
    project: "TaskSeal"
  });
});

test("two configuration writers based on one revision allow only one commit", async (t) => {
  const { cwd, userConfigurationPath } = await createProject(t);
  const context = {
    cwd,
    userConfigurationPath,
    environment: {}
  } as const;
  const revision = (await inspectConfiguration(context)).revision;
  const [first, second] = await Promise.all([
    previewConfigurationChange(
      context,
      { operation: "set", key: "runtime.port", value: 4401 },
      revision
    ),
    previewConfigurationChange(
      context,
      { operation: "set", key: "runtime.port", value: 4402 },
      revision
    )
  ]);

  const results = await Promise.allSettled([
    applyConfigurationPlan(context, first),
    applyConfigurationPlan(context, second)
  ]);

  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1
  );
  const port = readField(
    await inspectConfiguration(context),
    "runtime.port"
  ).value;
  assert.ok(port === 4401 || port === 4402);
});

test("a project draft validates cross-field changes and commits once", async (t) => {
  const { cwd, userConfigurationPath } = await createProject(t);
  const context = {
    cwd,
    userConfigurationPath,
    environment: {}
  } as const;
  const draft = await readConfigurationDraft(context, "project");
  const document = {
    ...draft.document,
    linear: {
      workspace: "netpilot-z",
      team: "netpilot"
    }
  };

  const plan = await previewConfigurationDraft(
    context,
    {
      scope: "project",
      document
    },
    draft.revision
  );
  const receipt = await applyConfigurationDraftPlan(context, plan);
  const replay = await applyConfigurationDraftPlan(context, plan);

  assert.equal(plan.schemaVersion, "configuration-draft-plan/v1");
  assert.equal(plan.restartRequired, false);
  assert.equal(receipt.applied, true);
  assert.equal(replay.applied, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(
    JSON.parse(
      await readFile(join(cwd, "config", "project.json"), "utf8")
    ),
    document
  );
  assert.equal(
    (await inspectConfiguration(context)).capabilities.linear,
    "ready"
  );
});

test("invalid and stale configuration drafts never replace the formal source", async (t) => {
  const { cwd, userConfigurationPath } = await createProject(t);
  const context = {
    cwd,
    userConfigurationPath,
    environment: {}
  } as const;
  const projectPath = join(cwd, "config", "project.json");
  const draft = await readConfigurationDraft(context, "project");

  await assert.rejects(
    previewConfigurationDraft(
      context,
      {
        scope: "project",
        document: {
          ...draft.document,
          workspaceAccess: "workspace-write"
        }
      },
      draft.revision
    ),
    hasCode("CONFIG_VALUE_INVALID")
  );
  const plan = await previewConfigurationDraft(
    context,
    {
      scope: "project",
      document: {
        ...draft.document,
        mode: "persistent"
      }
    },
    draft.revision
  );
  await assert.rejects(
    applyConfigurationDraftPlan(context, {
      ...plan,
      document: {
        ...plan.document,
        mode: "tampered"
      }
    }),
    hasCode("CONFIG_PLAN_INVALID")
  );
  assert.deepEqual(JSON.parse(await readFile(projectPath, "utf8")), {
    project: "TaskSeal"
  });
  await writeFile(
    projectPath,
    `${JSON.stringify({ project: "TaskSeal", mode: "external" }, null, 2)}\n`
  );

  await assert.rejects(
    applyConfigurationDraftPlan(context, plan),
    hasCode("CONFIG_REVISION_CONFLICT")
  );
  assert.equal(
    (JSON.parse(await readFile(projectPath, "utf8")) as { mode: string }).mode,
    "external"
  );
});

async function createProject(t: TestContext): Promise<{
  cwd: string;
  userConfigurationPath: string;
}> {
  const cwd = await createTemporaryDirectory(t);
  const userDirectory = await createTemporaryDirectory(t);
  const userConfigurationPath = join(userDirectory, "config.json");
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(
    join(cwd, "config", "project.json"),
    `${JSON.stringify({ project: "TaskSeal" }, null, 2)}\n`
  );
  return { cwd, userConfigurationPath };
}

async function createTemporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taskseal-config-write-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function readField(
  view: Awaited<ReturnType<typeof inspectConfiguration>>,
  key: string
) {
  const field = view.fields.find((candidate) => candidate.key === key);
  assert.ok(field, `Expected configuration field ${key}.`);
  return field;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}

function hasFileCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}
