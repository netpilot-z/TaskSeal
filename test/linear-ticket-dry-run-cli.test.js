import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/cli.js";

test("sync linear dry-run renders the local draft plan", async () => {
  const output = createOutput();
  const calls = [];
  const plan = {
    schemaVersion: 1,
    mode: "dry-run",
    provider: "linear",
    mutationReady: false,
    networkRequests: 0,
    externalWrites: 0,
    issueCount: 8,
    drafts: []
  };

  const exitCode = await runCli({
    args: [
      "sync",
      "linear",
      "--dry-run",
      "--source",
      "docs/tickets/0002-codex-runner-milestone.md"
    ],
    cwd: "project-root",
    output,
    createLinearDryRun: async (options) => {
      calls.push(options);
      return plan;
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    {
      cwd: "project-root",
      source: "docs/tickets/0002-codex-runner-milestone.md"
    }
  ]);
  assert.deepEqual(JSON.parse(output.text()), plan);
});

test("sync linear requires dry-run and never falls through to a write mode", async () => {
  for (const args of [
    ["sync", "linear"],
    ["sync", "linear", "--apply"],
    ["sync", "github", "--dry-run"],
    ["sync", "linear", "--dry-run", "--source"]
  ]) {
    const output = createOutput();
    let invoked = false;
    const exitCode = await runCli({
      args,
      output,
      createLinearDryRun: async () => {
        invoked = true;
      }
    });

    assert.equal(exitCode, 2);
    assert.equal(invoked, false);
    assert.match(output.text(), /taskseal sync linear --dry-run/);
  }
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
