import assert from "node:assert/strict";
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
  assessRuntimeReadiness,
  renderRuntimeReadiness
} from "../src/application/runtime-readiness.ts";

test("runtime readiness reports unconfigured integrations as disabled", async (t) => {
  const cwd = await createProject(t, {
    project: "TaskSeal"
  });

  const readiness =
    await assessRuntimeReadiness({
      cwd,
      nodeVersion: "24.12.0",
      commandRunner:
        readyCodexCommand
    });

  assert.equal(readiness.ready, true);
  assert.deepEqual(
    readiness.capabilities,
    {
      github: "disabled",
      linear: "disabled",
      gitee: "disabled",
      feishu: "disabled"
    }
  );
  const output =
    renderRuntimeReadiness(
      readiness
    );
  assert.match(
    output,
    /GitHub integration — disabled/
  );
  assert.match(
    output,
    /Linear integration — disabled/
  );
});

test("runtime readiness validates every configured integration capability", async (t) => {
  const invalidConfigurations = [
    {
      project: "TaskSeal",
      github: "not-an-object"
    },
    {
      project: "TaskSeal",
      github: {
        repository:
          "netpilot-z/TaskSeal",
        delivery: {
          enabled: true,
          mappingIndex: "../outside.json"
        }
      }
    },
    {
      project: "TaskSeal",
      github: {
        repository:
          "netpilot-z/TaskSeal",
        unexpected: true
      }
    },
    {
      project: "TaskSeal",
      gitee: {
        repository: "invalid"
      }
    },
    {
      project: "TaskSeal",
      feishu: {
        enabled: false,
        tableScopeKey: "plain-text"
      }
    },
    {
      project: "TaskSeal",
      linear: {
        workspace: "netpilot-z",
        team: "netpilot",
        project: "TaskSeal",
        readyWork: {
          enabled: true
        }
      }
    },
    {
      project: "TaskSeal",
      linear: {
        workspace: "netpilot-z",
        team: "netpilot",
        unexpected: true
      }
    }
  ];

  for (
    const configuration of
    invalidConfigurations
  ) {
    const cwd = await createProject(
      t,
      configuration
    );
    const readiness =
      await assessRuntimeReadiness({
        cwd,
        nodeVersion: "24.12.0",
        commandRunner:
          readyCodexCommand
      });

    assert.equal(
      readiness.ready,
      false,
      JSON.stringify(configuration)
    );
  }
});

test("runtime readiness isolates one invalid integration from other capability states", async (t) => {
  const cwd =
    await createProject(t, {
      project: "TaskSeal",
      github: {
        repository:
          "not-a-repository"
      },
      linear: {
        workspace:
          "netpilot-z",
        team: "netpilot"
      }
    });

  const readiness =
    await assessRuntimeReadiness({
      cwd,
      nodeVersion: "24.12.0",
      commandRunner:
        readyCodexCommand
    });

  assert.equal(
    readiness.project.ready,
    false
  );
  assert.deepEqual(
    readiness.capabilities,
    {
      github: "invalid",
      linear: "ready",
      gitee: "disabled",
      feishu: "disabled"
    }
  );
});

async function createProject(
  t: TestContext,
  configuration: unknown
): Promise<string> {
  const cwd = await mkdtemp(
    join(
      tmpdir(),
      "taskseal-readiness-"
    )
  );
  t.after(() =>
    rm(cwd, {
      recursive: true,
      force: true
    })
  );
  await mkdir(
    join(cwd, "config"),
    { recursive: true }
  );
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify(configuration)
  );
  return cwd;
}

async function readyCodexCommand(
  command: string,
  args: string[]
) {
  if (command === "where.exe") {
    return {
      exitCode: 0,
      stdout: "codex-path.exe\n",
      stderr: ""
    };
  }
  return {
    exitCode: 0,
    stdout:
      args[0] === "--version"
        ? "codex-cli 0.135.0\n"
        : "Logged in using ChatGPT\n",
    stderr: ""
  };
}
