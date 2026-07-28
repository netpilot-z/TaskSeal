import assert from "node:assert/strict";
import test from "node:test";

import {
  runCli
} from "../src/cli.ts";
import type {
  OutputPort
} from "../src/cli.ts";

const PLAN_DIGEST =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("reconcile github previews and applies one explicit WorkItem binding", async () => {
  const cases = [
    {
      args: [
        "reconcile",
        "github",
        "--mode",
        "preview",
        "--work-item",
        "TS-NP-6"
      ],
      expected: {
        cwd: "project-root",
        mode: "preview",
        workItemId: "TS-NP-6"
      }
    },
    {
      args: [
        "reconcile",
        "github",
        "--mode",
        "apply",
        "--work-item",
        "TS-NP-6",
        "--expected-plan-digest",
        PLAN_DIGEST
      ],
      expected: {
        cwd: "project-root",
        mode: "apply",
        workItemId: "TS-NP-6",
        expectedPlanDigest:
          PLAN_DIGEST
      }
    }
  ] as const;

  for (const testCase of cases) {
    const output = createOutput();
    const calls: unknown[] = [];
    const result = {
      schemaVersion: 1,
      mode: testCase.expected.mode,
      githubWrites: 0
    };
    const exitCode = await runCli({
      args: [...testCase.args],
      cwd: "project-root",
      output,
      executeGitHubReconciliation:
        async (options) => {
          calls.push(options);
          return result;
        }
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(calls, [
      testCase.expected
    ]);
    assert.deepEqual(
      JSON.parse(output.text()),
      result
    );
  }
});

test("reconcile github rejects incomplete, duplicate, and unknown arguments before runtime", async () => {
  for (const args of [
    ["reconcile"],
    ["reconcile", "linear"],
    [
      "reconcile",
      "github",
      "--mode",
      "preview"
    ],
    [
      "reconcile",
      "github",
      "--mode",
      "apply",
      "--work-item",
      "TS-NP-6"
    ],
    [
      "reconcile",
      "github",
      "--mode",
      "preview",
      "--work-item",
      "TS-NP-6",
      "--work-item",
      "TS-NP-7"
    ],
    [
      "reconcile",
      "github",
      "--mode",
      "preview",
      "--work-item",
      "TS-NP-6",
      "--merge",
      "true"
    ]
  ]) {
    const output = createOutput();
    let invoked = false;
    const exitCode = await runCli({
      args,
      output,
      executeGitHubReconciliation:
        async () => {
          invoked = true;
        }
    });

    assert.equal(exitCode, 2);
    assert.equal(invoked, false);
    assert.match(
      output.text(),
      /taskseal reconcile github/
    );
  }
});

test("reconcile github renders one fixed error without leaking credentials or remote details", async () => {
  const output = createOutput();
  const exitCode = await runCli({
    args: [
      "reconcile",
      "github",
      "--mode",
      "preview",
      "--work-item",
      "TS-NP-6"
    ],
    output,
    executeGitHubReconciliation:
      async () => {
        const error = new Error(
          "GITHUB_TOKEN=secret-value"
        ) as Error & {
          code: string;
        };
        error.code =
          "UNTRUSTED_SECRET_CODE";
        throw error;
      }
  });

  assert.equal(exitCode, 1);
  assert.equal(
    output.text(),
    "TaskSeal reconcile failed [GITHUB_RECONCILE_FAILED]: GitHub delivery reconciliation failed.\n"
  );
  assert.doesNotMatch(
    output.text(),
    /secret|UNTRUSTED/i
  );
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
