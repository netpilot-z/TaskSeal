import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getGitHubCoordinates,
  getLinearCoordinates,
  readProjectConfiguration
} from "../src/config/project-config.js";

test("project configuration exposes validated non-secret provider coordinates", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  await writeConfiguration(cwd, {
    project: "TaskSeal",
    github: { repository: "netpilot-z/TaskSeal" },
    linear: { workspace: "TaskSeal", team: "netpilot" },
    mode: "persistent"
  });

  const configuration = await readProjectConfiguration({ cwd });

  assert.equal(configuration.project, "TaskSeal");
  assert.deepEqual(getGitHubCoordinates(configuration), {
    repository: "netpilot-z/TaskSeal"
  });
  assert.deepEqual(getLinearCoordinates(configuration), {
    workspace: "TaskSeal",
    team: "netpilot"
  });
  assert.doesNotMatch(JSON.stringify(configuration), new RegExp(escapeRegExp(cwd)));
});

test("project configuration reports invalid JSON and provider coordinates safely", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(join(cwd, "config", "project.json"), "{bad json");

  await assert.rejects(
    readProjectConfiguration({ cwd }),
    hasCode("PROJECT_CONFIG_INVALID")
  );

  await writeConfiguration(cwd, {
    project: "TaskSeal",
    github: { repository: "../private" },
    linear: { workspace: "TaskSeal" }
  });
  const configuration = await readProjectConfiguration({ cwd });

  assert.throws(
    () => getGitHubCoordinates(configuration),
    hasCode("GITHUB_CONFIG_INVALID")
  );
  assert.throws(
    () => getLinearCoordinates(configuration),
    hasCode("LINEAR_CONFIG_INVALID")
  );
});

async function writeConfiguration(cwd, value) {
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(
    join(cwd, "config", "project.json"),
    `${JSON.stringify(value)}\n`
  );
}

async function createTemporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "taskseal-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function hasCode(code) {
  return (error) => error?.code === code;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
