import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import type { OutputPort } from "../src/cli.ts";

test("inspect github-issue parses one explicit issue mapping", async () => {
  const output = createOutput();
  const calls: unknown[] = [];

  const exitCode = await runCli({
    args: [
      "inspect",
      "github-issue",
      "--issue",
      "7",
      "--work-item",
      "TS-7",
      "--criterion",
      "tests"
    ],
    cwd: "project-root",
    output,
    inspectGitHubIssue: async (options) => {
      calls.push(options);
      return {
        schemaVersion: 1,
        mode: "read-only",
        provider: "github",
        events: []
      };
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    {
      cwd: "project-root",
      issueNumber: 7,
      workItemId: "TS-7",
      requiredEvidence: ["tests"]
    }
  ]);
  const rendered: unknown = JSON.parse(output.text());
  assert.equal(readJsonProperty(rendered, "provider"), "github");
});

test("inspect github-issue rejects invalid or delivery-chain arguments", async () => {
  const invalidArguments = [
    [
      "inspect",
      "github-issue",
      "--issue",
      "0",
      "--work-item",
      "TS-7",
      "--criterion",
      "tests"
    ],
    [
      "inspect",
      "github-issue",
      "--issue",
      "7",
      "--work-item",
      "TS-7"
    ],
    [
      "inspect",
      "github-issue",
      "--issue",
      "7",
      "--work-item",
      "TS-7",
      "--criterion",
      "tests",
      "--pr",
      "9"
    ]
  ];

  for (const args of invalidArguments) {
    const output = createOutput();
    let invoked = false;
    const exitCode = await runCli({
      args,
      output,
      inspectGitHubIssue: async () => {
        invoked = true;
      }
    });

    assert.equal(exitCode, 2);
    assert.equal(invoked, false);
    assert.match(output.text(), /Usage:/);
  }
});

test("inspect github parses explicit mappings and renders JSON", async () => {
  const output = createOutput();
  const calls: unknown[] = [];
  const snapshot = {
    schemaVersion: 1,
    mode: "read-only",
    provider: "github",
    events: []
  };

  const exitCode = await runCli({
    args: [
      "inspect",
      "github",
      "--issue",
      "7",
      "--pr",
      "9",
      "--check",
      "tests",
      "--work-item",
      "TS-7",
      "--attempt",
      "attempt-9",
      "--criterion",
      "tests"
    ],
    cwd: "project-root",
    output,
    inspectGitHub: async (options) => {
      calls.push(options);
      return snapshot;
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    {
      cwd: "project-root",
      issueNumber: 7,
      pullRequestNumber: 9,
      checkName: "tests",
      workItemId: "TS-7",
      attemptId: "attempt-9",
      criterionKey: "tests"
    }
  ]);
  const rendered: unknown = JSON.parse(output.text());
  assert.deepEqual(rendered, snapshot);
});

test("inspect linear parses one explicit issue mapping", async () => {
  const output = createOutput();
  const calls: unknown[] = [];

  const exitCode = await runCli({
    args: [
      "inspect",
      "linear",
      "--issue",
      "NET-7",
      "--work-item",
      "TS-7",
      "--criterion",
      "tests"
    ],
    cwd: "project-root",
    output,
    inspectLinear: async (options) => {
      calls.push(options);
      return {
        schemaVersion: 1,
        mode: "read-only",
        provider: "linear",
        events: []
      };
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    {
      cwd: "project-root",
      issueReference: "NET-7",
      workItemId: "TS-7",
      requiredEvidence: ["tests"]
    }
  ]);
  const rendered: unknown = JSON.parse(output.text());
  assert.equal(readJsonProperty(rendered, "provider"), "linear");
});

test("inspect gitee requires explicit v2 mapping and preserves Issue case", async () => {
  const output = createOutput();
  const calls: unknown[] = [];
  const exitCode = await runCli({
    args: [
      "inspect",
      "gitee",
      "--issue",
      "I4",
      "--work-item",
      "TS-GITEE-I4",
      "--criterion",
      "tests",
      "--snapshot-version",
      "2",
      "--title-management",
      "none"
    ],
    cwd: "project-root",
    output,
    inspectGitee: async (options) => {
      calls.push(options);
      return {
        schemaVersion: 2,
        mode: "read-only",
        provider: "gitee",
        facts: []
      };
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    {
      cwd: "project-root",
      issueReference: "I4",
      workItemId: "TS-GITEE-I4",
      requiredEvidence: ["tests"],
      snapshotVersion: 2,
      managedFields: []
    }
  ]);
  assert.equal(
    readJsonProperty(
      JSON.parse(output.text()),
      "provider"
    ),
    "gitee"
  );
});

test("inspect gitee-health accepts no provider arguments", async () => {
  const output = createOutput();
  const calls: unknown[] = [];
  const exitCode = await runCli({
    args: ["inspect", "gitee-health"],
    cwd: "project-root",
    output,
    inspectGiteeHealth: async (options) => {
      calls.push(options);
      return {
        provider: "gitee",
        status: "ready"
      };
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{ cwd: "project-root" }]);
});

test("inspect feishu-health and feishu expose only fixed-resource commands", async () => {
  const healthOutput = createOutput();
  const healthCalls: unknown[] = [];
  assert.equal(
    await runCli({
      args: ["inspect", "feishu-health"],
      cwd: "project-root",
      output: healthOutput,
      inspectFeishuHealth: async (options) => {
        healthCalls.push(options);
        return {
          provider: "feishu",
          status: "ready"
        };
      }
    }),
    0
  );
  assert.deepEqual(healthCalls, [
    { cwd: "project-root" }
  ]);

  const snapshotOutput = createOutput();
  const snapshotCalls: unknown[] = [];
  assert.equal(
    await runCli({
      args: [
        "inspect",
        "feishu",
        "--work-item",
        "NP-18",
        "--criterion",
        "tests",
        "--snapshot-version",
        "2",
        "--title-management",
        "none"
      ],
      cwd: "project-root",
      output: snapshotOutput,
      inspectFeishu: async (options) => {
        snapshotCalls.push(options);
        return {
          schemaVersion: 2,
          mode: "read-only",
          provider: "feishu",
          facts: []
        };
      }
    }),
    0
  );
  assert.deepEqual(snapshotCalls, [
    {
      cwd: "project-root",
      workItemId: "NP-18",
      requiredEvidence: ["tests"],
      snapshotVersion: 2,
      managedFields: []
    }
  ]);
  assert.equal(
    readJsonProperty(
      JSON.parse(snapshotOutput.text()),
      "provider"
    ),
    "feishu"
  );
});

test("inspect feishu rejects caller-selected resources and incomplete v2 mapping", async () => {
  const scenarios = [
    [
      "inspect",
      "feishu",
      "--work-item",
      "NP-18",
      "--criterion",
      "tests"
    ],
    [
      "inspect",
      "feishu",
      "--work-item",
      "NP-18",
      "--criterion",
      "tests",
      "--snapshot-version",
      "2",
      "--title-management",
      "none",
      "--record",
      "foreign-record"
    ],
    [
      "inspect",
      "feishu-health",
      "--table",
      "foreign-table"
    ]
  ];

  for (const args of scenarios) {
    let invoked = false;
    const output = createOutput();
    const exitCode = await runCli({
      args,
      output,
      inspectFeishu: async () => {
        invoked = true;
      },
      inspectFeishuHealth: async () => {
        invoked = true;
      }
    });
    assert.equal(exitCode, 2);
    assert.equal(invoked, false);
    assert.match(output.text(), /Usage:/);
  }
});

test("inspect gitee rejects v1, missing v2 controls, and unknown arguments", async () => {
  const scenarios = [
    [
      "inspect",
      "gitee",
      "--issue",
      "I4",
      "--work-item",
      "TS-1",
      "--criterion",
      "tests"
    ],
    [
      "inspect",
      "gitee",
      "--issue",
      "I4",
      "--work-item",
      "TS-1",
      "--criterion",
      "tests",
      "--snapshot-version",
      "1"
    ],
    [
      "inspect",
      "gitee",
      "--issue",
      "I4",
      "--work-item",
      "TS-1",
      "--criterion",
      "tests",
      "--snapshot-version",
      "2",
      "--title-management",
      "none",
      "--token",
      "secret"
    ],
    ["inspect", "gitee-health", "--repository", "foreign/repo"]
  ];

  for (const args of scenarios) {
    const output = createOutput();
    let invoked = false;
    const exitCode = await runCli({
      args,
      output,
      inspectGitee: async () => {
        invoked = true;
      },
      inspectGiteeHealth: async () => {
        invoked = true;
      }
    });

    assert.equal(exitCode, 2);
    assert.equal(invoked, false);
    assert.match(output.text(), /Usage:/);
  }
});

test("inspect rejects incomplete arguments and renders safe provider errors", async () => {
  const usageOutput = createOutput();
  let invoked = false;

  assert.equal(
    await runCli({
      args: ["inspect", "github", "--issue", "1"],
      output: usageOutput,
      inspectGitHub: async () => {
        invoked = true;
      }
    }),
    2
  );
  assert.equal(invoked, false);
  assert.match(usageOutput.text(), /taskseal inspect github/);

  const errorOutput = createOutput();
  const error = Object.assign(
    new Error("The configured workspace does not match."),
    { code: "LINEAR_WORKSPACE_MISMATCH" }
  );

  assert.equal(
    await runCli({
      args: [
        "inspect",
        "linear",
        "--issue",
        "NET-7",
        "--work-item",
        "TS-7",
        "--criterion",
        "tests"
      ],
      output: errorOutput,
      inspectLinear: async () => {
        throw error;
      }
    }),
    1
  );
  assert.match(errorOutput.text(), /\[LINEAR_WORKSPACE_MISMATCH\]/);
  assert.match(errorOutput.text(), /does not match/);
});

test("inspect linear rejects an invalid issue reference before execution", async () => {
  const output = createOutput();
  let invoked = false;

  const exitCode = await runCli({
    args: [
      "inspect",
      "linear",
      "--issue",
      "not-valid",
      "--work-item",
      "TS-7",
      "--criterion",
      "tests"
    ],
    output,
    inspectLinear: async () => {
      invoked = true;
    }
  });

  assert.equal(exitCode, 2);
  assert.equal(invoked, false);
  assert.match(output.text(), /Usage:/);
});

test("inspect v2 maps explicit title management for every provider command", async () => {
  const scenarios = [
    {
      args: [
        "inspect",
        "github-issue",
        "--issue",
        "7",
        "--work-item",
        "TS-7",
        "--criterion",
        "tests",
        "--snapshot-version",
        "2",
        "--title-management",
        "provider"
      ],
      dependency: "inspectGitHubIssue",
      expected: {
        cwd: "project-root",
        issueNumber: 7,
        workItemId: "TS-7",
        requiredEvidence: ["tests"],
        snapshotVersion: 2,
        managedFields: ["title"]
      }
    },
    {
      args: [
        "inspect",
        "github",
        "--issue",
        "7",
        "--pr",
        "9",
        "--check",
        "tests",
        "--work-item",
        "TS-7",
        "--attempt",
        "attempt-9",
        "--criterion",
        "tests",
        "--snapshot-version",
        "2",
        "--title-management",
        "none"
      ],
      dependency: "inspectGitHub",
      expected: {
        cwd: "project-root",
        issueNumber: 7,
        pullRequestNumber: 9,
        checkName: "tests",
        workItemId: "TS-7",
        attemptId: "attempt-9",
        criterionKey: "tests",
        snapshotVersion: 2,
        managedFields: []
      }
    },
    {
      args: [
        "inspect",
        "linear",
        "--issue",
        "NET-7",
        "--work-item",
        "TS-7",
        "--criterion",
        "tests",
        "--snapshot-version",
        "2",
        "--title-management",
        "provider"
      ],
      dependency: "inspectLinear",
      expected: {
        cwd: "project-root",
        issueReference: "NET-7",
        workItemId: "TS-7",
        requiredEvidence: ["tests"],
        snapshotVersion: 2,
        managedFields: ["title"]
      }
    }
  ];

  for (const scenario of scenarios) {
    const calls: unknown[] = [];
    const output = createOutput();
    const exitCode = await runCli({
      args: scenario.args,
      cwd: "project-root",
      output,
      [scenario.dependency]: async (options: unknown) => {
        calls.push(options);
        return {
          schemaVersion: 2,
          mode: "read-only",
          provider: "test",
          facts: []
        };
      }
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(calls, [scenario.expected]);
  }
});

test("inspect rejects incomplete or incompatible snapshot version options", async () => {
  const invalidSuffixes = [
    ["--snapshot-version", "2"],
    ["--title-management", "provider"],
    [
      "--snapshot-version",
      "1",
      "--title-management",
      "none"
    ],
    [
      "--snapshot-version",
      "2",
      "--title-management",
      "automatic"
    ],
    [
      "--snapshot-version",
      "3",
      "--title-management",
      "provider"
    ]
  ];
  const base = [
    "inspect",
    "github-issue",
    "--issue",
    "7",
    "--work-item",
    "TS-7",
    "--criterion",
    "tests"
  ];

  for (const suffix of invalidSuffixes) {
    const output = createOutput();
    let invoked = false;
    const exitCode = await runCli({
      args: [...base, ...suffix],
      output,
      inspectGitHubIssue: async () => {
        invoked = true;
      }
    });

    assert.equal(exitCode, 2);
    assert.equal(invoked, false);
    assert.match(output.text(), /Usage:/);
  }
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

function readJsonProperty(
  value: unknown,
  key: string
): unknown {
  if (!isRecord(value)) {
    throw new TypeError("Expected a JSON object.");
  }

  return value[key];
}

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
