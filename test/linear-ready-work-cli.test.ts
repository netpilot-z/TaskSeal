import assert from "node:assert/strict";
import test from "node:test";

import {
  runCli
} from "../src/cli.ts";
import type {
  OutputPort
} from "../src/cli.ts";

test("ready linear lists, previews, and applies one explicit UUID selection", async () => {
  const cases = [
    {
      args: ["ready", "linear"],
      expected: {
        cwd: "project-root",
        mode: "list"
      }
    },
    {
      args: [
        "ready",
        "linear",
        "--mode",
        "preview",
        "--issue",
        "11111111-1111-4111-8111-111111111111",
        "--work-item",
        "TS-NP-5",
        "--criterion",
        "tests"
      ],
      expected: {
        cwd: "project-root",
        mode: "preview",
        issueId:
          "11111111-1111-4111-8111-111111111111",
        workItemId: "TS-NP-5",
        requiredEvidence: ["tests"]
      }
    },
    {
      args: [
        "ready",
        "linear",
        "--mode",
        "apply",
        "--issue",
        "11111111-1111-4111-8111-111111111111",
        "--work-item",
        "TS-NP-5",
        "--criterion",
        "tests",
        "--expected-plan-digest",
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      ],
      expected: {
        cwd: "project-root",
        mode: "apply",
        issueId:
          "11111111-1111-4111-8111-111111111111",
        workItemId: "TS-NP-5",
        requiredEvidence: ["tests"],
        expectedPlanDigest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    }
  ] as const;

  for (const testCase of cases) {
    const output = createOutput();
    const calls: unknown[] = [];
    const result = {
      schemaVersion: 1,
      mode: testCase.expected.mode
    };
    const exitCode = await runCli({
      args: [...testCase.args],
      cwd: "project-root",
      output,
      executeLinearReadyWork: async (
        options
      ) => {
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

test("ready linear rejects implicit selection and incomplete apply arguments", async () => {
  for (const args of [
    ["ready"],
    ["ready", "github"],
    [
      "ready",
      "linear",
      "--mode",
      "preview",
      "--issue",
      "NP-5",
      "--work-item",
      "TS-NP-5",
      "--criterion",
      "tests"
    ],
    [
      "ready",
      "linear",
      "--mode",
      "apply",
      "--issue",
      "11111111-1111-4111-8111-111111111111",
      "--work-item",
      "TS-NP-5",
      "--criterion",
      "tests"
    ]
  ]) {
    const output = createOutput();
    let invoked = false;
    const exitCode = await runCli({
      args,
      output,
      executeLinearReadyWork: async () => {
        invoked = true;
      }
    });

    assert.equal(exitCode, 2);
    assert.equal(invoked, false);
    assert.match(
      output.text(),
      /taskseal ready linear/
    );
  }
});

test("ready linear renders a fixed error without leaking provider details", async () => {
  const output = createOutput();
  const exitCode = await runCli({
    args: ["ready", "linear"],
    output,
    executeLinearReadyWork: async () => {
      const error = new Error(
        "LINEAR_API_KEY=secret-value"
      ) as Error & { code: string };
      error.code = "UNTRUSTED_SECRET_CODE";
      throw error;
    }
  });

  assert.equal(exitCode, 1);
  assert.equal(
    output.text(),
    "TaskSeal ready failed [LINEAR_READY_FAILED]: Linear ready-work request failed.\n"
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
