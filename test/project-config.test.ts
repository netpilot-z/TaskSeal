import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  getGiteeCoordinates,
  getGitHubCoordinates,
  getLinearCoordinates,
  readProjectConfiguration
} from "../src/config/project-config.ts";

test("project configuration exposes validated non-secret provider coordinates", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  await writeConfiguration(cwd, {
    project: "TaskSeal",
    github: { repository: "netpilot-z/TaskSeal" },
    gitee: { repository: "NetPilot-Z/TaskSeal" },
    linear: { workspace: "TaskSeal", team: "netpilot" },
    mode: "persistent"
  });

  const configuration = await readProjectConfiguration({ cwd });

  assert.equal(configuration.project, "TaskSeal");
  assert.deepEqual(getGitHubCoordinates(configuration), {
    repository: "netpilot-z/TaskSeal"
  });
  assert.deepEqual(getGiteeCoordinates(configuration), {
    repository: "NetPilot-Z/TaskSeal"
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

  for (const gitee of [
    { repository: "../private" },
    { repository: "owner/repository", token: "must-not-be-configured" },
    { repository: "https://gitee.com/owner/repository" }
  ]) {
    assert.throws(
      () =>
        getGiteeCoordinates({
          project: "TaskSeal",
          gitee
        }),
      hasCode("GITEE_CONFIG_INVALID")
    );
  }
});

async function writeConfiguration(
  cwd: string,
  value: unknown
): Promise<void> {
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(
    join(cwd, "config", "project.json"),
    `${JSON.stringify(value)}\n`
  );
}

async function createTemporaryDirectory(
  t: TestContext
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taskseal-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
