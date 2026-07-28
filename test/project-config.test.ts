import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  getGiteeCoordinates,
  getGitHubDeliveryCoordinates,
  getGitHubCoordinates,
  getLinearBootstrapCoordinates,
  getLinearCoordinates,
  getLinearReadyWorkCoordinates,
  readProjectConfiguration
} from "../src/config/project-config.ts";

test("project configuration exposes validated non-secret provider coordinates", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  await writeConfiguration(cwd, {
    project: "TaskSeal",
    github: {
      repository: "netpilot-z/TaskSeal",
      delivery: {
        enabled: true,
        mappingIndex:
          "config/github-delivery-map.json"
      }
    },
    gitee: { repository: "NetPilot-Z/TaskSeal" },
    linear: {
      workspace: "TaskSeal",
      team: "netpilot",
      project: "TaskSeal Delivery",
      backlogState: "Backlog",
      readyWork: {
        enabled: true,
        readyState: "Todo",
        completedState: "Done",
        dependencyIndex:
          "docs/tickets/0007-linear-bootstrap-map.json"
      }
    },
    mode: "persistent"
  });

  const configuration = await readProjectConfiguration({ cwd });

  assert.equal(configuration.project, "TaskSeal");
  assert.deepEqual(getGitHubCoordinates(configuration), {
    repository: "netpilot-z/TaskSeal"
  });
  assert.deepEqual(
    getGitHubDeliveryCoordinates(configuration),
    {
      repository: "netpilot-z/TaskSeal",
      enabled: true,
      mappingIndex:
        "config/github-delivery-map.json"
    }
  );
  assert.deepEqual(getGiteeCoordinates(configuration), {
    repository: "NetPilot-Z/TaskSeal"
  });
  assert.deepEqual(getLinearCoordinates(configuration), {
    workspace: "TaskSeal",
    team: "netpilot"
  });
  assert.deepEqual(
    getLinearBootstrapCoordinates(configuration),
    {
      workspace: "TaskSeal",
      team: "netpilot",
      project: "TaskSeal Delivery",
      backlogState: "Backlog"
    }
  );
  assert.deepEqual(
    getLinearReadyWorkCoordinates(configuration),
    {
      workspace: "TaskSeal",
      team: "netpilot",
      project: "TaskSeal Delivery",
      readyState: "Todo",
      completedState: "Done",
      dependencyIndex:
        "docs/tickets/0007-linear-bootstrap-map.json",
      enabled: true
    }
  );
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

  for (const linear of [
    {
      workspace: "TaskSeal",
      team: "netpilot"
    },
    {
      workspace: "TaskSeal",
      team: "netpilot",
      project: "TaskSeal"
    },
    {
      workspace: " TaskSeal",
      team: "netpilot",
      project: "TaskSeal",
      backlogState: "Backlog"
    },
    {
      workspace: "TaskSeal",
      team: "netpilot",
      project: "TaskSeal",
      backlogState: " "
    }
  ]) {
    assert.throws(
      () =>
        getLinearBootstrapCoordinates({
          project: "TaskSeal",
          linear
        }),
      hasCode("LINEAR_CONFIG_INVALID")
    );
  }

  for (const readyWork of [
    undefined,
    {
      enabled: true,
      readyState: "Todo",
      completedState: "Done",
      dependencyIndex: "../outside.json"
    },
    {
      enabled: true,
      readyState: "Todo",
      completedState: "Done",
      dependencyIndex:
        "docs\\dependencies.json"
    },
    {
      enabled: true,
      readyState: "Todo",
      completedState: "Done",
      dependencyIndex:
        "docs/base.json:dependencies.json"
    },
    {
      enabled: "yes",
      readyState: "Todo",
      completedState: "Done",
      dependencyIndex:
        "docs/tickets/0007-linear-bootstrap-map.json"
    },
    {
      enabled: true,
      readyState: "Todo",
      completedState: "Todo",
      dependencyIndex:
        "docs/tickets/0007-linear-bootstrap-map.json"
    }
  ]) {
    assert.throws(
      () =>
        getLinearReadyWorkCoordinates({
          project: "TaskSeal",
          linear: {
            workspace: "TaskSeal",
            team: "netpilot",
            project: "TaskSeal",
            readyWork
          }
        }),
      hasCode("LINEAR_CONFIG_INVALID")
    );
  }

  for (const delivery of [
    undefined,
    {
      enabled: true,
      mappingIndex: "../outside.json"
    },
    {
      enabled: true,
      mappingIndex:
        "config\\github-delivery-map.json"
    },
    {
      enabled: "yes",
      mappingIndex:
        "config/github-delivery-map.json"
    },
    {
      enabled: true,
      mappingIndex:
        "config/github-delivery-map.json",
      token: "must-not-be-configured"
    }
  ]) {
    assert.throws(
      () =>
        getGitHubDeliveryCoordinates({
          project: "TaskSeal",
          github: {
            repository:
              "netpilot-z/TaskSeal",
            delivery
          }
        }),
      hasCode("GITHUB_CONFIG_INVALID")
    );
  }

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
