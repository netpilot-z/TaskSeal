import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, {
  type TestContext
} from "node:test";

import {
  parseGitHubDeliveryIndex,
  readGitHubDeliveryIndex
} from "../src/connectors/github-delivery-index.ts";

const LINEAR_ID =
  "4f3ce2c1-5415-403b-9129-698cac96d987";

test("GitHub delivery index exposes explicit immutable bindings", () => {
  const index = parseGitHubDeliveryIndex(
    createIndexFixture()
  );

  assert.equal(
    index.target.repository,
    "netpilot-z/taskseal"
  );
  assert.equal(index.entries.length, 1);
  assert.deepEqual(index.byWorkItem("TS-NP-6"), {
    linearIssueId: LINEAR_ID,
    workItemId: "TS-NP-6",
    headRepository: "netpilot-z/taskseal",
    branch: "feature/np-6-github-evidence",
    pullRequestNumber: 58,
    evidence: [
      {
        criterionKey: "review",
        source: {
          kind: "pull_request_review",
          reviewerId: "9001"
        }
      },
      {
        criterionKey: "tests",
        source: {
          kind: "check_run",
          name: "tests",
          appId: "15368"
        }
      }
    ],
    bindingDigest:
      index.entries[0]?.bindingDigest
  });
  assert.match(
    index.entries[0]?.bindingDigest ?? "",
    /^sha256:[0-9a-f]{64}$/
  );
  assert.equal(index.byWorkItem("missing"), null);
});

test("GitHub delivery index accepts an empty repository bootstrap", () => {
  const fixture = createIndexFixture();
  fixture.entries = [];

  const index =
    parseGitHubDeliveryIndex(fixture);

  assert.deepEqual(index.entries, []);
});

test("GitHub delivery binding order uses locale-independent code units", () => {
  const fixture = createIndexFixture();
  const entry = fixture.entries[0];
  assert.ok(entry);
  entry.evidence = [
    {
      criterionKey: "ä",
      source: {
        kind: "check_run",
        name: "umlaut",
        appId: "15368"
      }
    },
    {
      criterionKey: "z",
      source: {
        kind: "check_run",
        name: "latin",
        appId: "15368"
      }
    }
  ];

  const index =
    parseGitHubDeliveryIndex(fixture);

  assert.deepEqual(
    index.entries[0]?.evidence.map(
      (binding) =>
        binding.criterionKey
    ),
    ["z", "ä"]
  );
});

test("GitHub delivery index rejects ambiguous identities and selectors", () => {
  const cases = [
    duplicateEntry("linearIssueId"),
    duplicateEntry("workItemId"),
    duplicateEntry("pullRequestNumber"),
    duplicateEntry("branch"),
    duplicateEvidence("criterion"),
    duplicateEvidence("source"),
    {
      ...createIndexFixture(),
      target: {
        repository:
          "https://github.com/netpilot-z/TaskSeal"
      }
    },
    {
      ...createIndexFixture(),
      unexpected: true
    }
  ];

  for (const value of cases) {
    assert.throws(
      () => parseGitHubDeliveryIndex(value),
      hasCode("GITHUB_DELIVERY_INDEX_INVALID")
    );
  }
});

test("GitHub delivery index bounds repository-relative reads", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  await mkdir(join(cwd, "config"), {
    recursive: true
  });
  await writeFile(
    join(cwd, "config", "delivery.json"),
    " ".repeat(600 * 1024)
  );

  await assert.rejects(
    readGitHubDeliveryIndex({
      workspaceRoot: cwd,
      repositoryPath: "config/delivery.json"
    }),
    hasCode(
      "GITHUB_DELIVERY_INDEX_LIMIT_EXCEEDED"
    )
  );

  for (const repositoryPath of [
    "../outside.json",
    "config\\delivery.json",
    "config/base.json:delivery.json",
    "config/CON/delivery.json",
    "config/trailing./delivery.json"
  ]) {
    await assert.rejects(
      readGitHubDeliveryIndex({
        workspaceRoot: cwd,
        repositoryPath
      }),
      hasCode(
        "GITHUB_DELIVERY_INDEX_INVALID"
      )
    );
  }
});

test("GitHub delivery index rejects a link escaping the workspace", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const outside =
    await createTemporaryDirectory(t);
  await writeFile(
    join(outside, "delivery.json"),
    JSON.stringify(createIndexFixture())
  );

  try {
    await symlink(
      outside,
      join(cwd, "redirected"),
      process.platform === "win32"
        ? "junction"
        : "dir"
    );
  } catch (error) {
    if (
      hasNodeErrorCode(error, "EPERM") ||
      hasNodeErrorCode(error, "EACCES")
    ) {
      t.skip("directory links are unavailable");
      return;
    }

    throw error;
  }

  await assert.rejects(
    readGitHubDeliveryIndex({
      workspaceRoot: cwd,
      repositoryPath:
        "redirected/delivery.json"
    }),
    hasCode(
      "GITHUB_DELIVERY_INDEX_INVALID"
    )
  );
});

function createIndexFixture() {
  return {
    schemaVersion: 1,
    provider: "github",
    target: {
      repository: "netpilot-z/TaskSeal"
    },
    entries: [
      {
        linearIssueId: LINEAR_ID,
        workItemId: "TS-NP-6",
        headRepository:
          "netpilot-z/TaskSeal",
        branch:
          "feature/np-6-github-evidence",
        pullRequestNumber: 58,
        evidence: [
          {
            criterionKey: "tests",
            source: {
              kind: "check_run",
              name: "tests",
              appId: "15368"
            }
          },
          {
            criterionKey: "review",
            source: {
              kind:
                "pull_request_review",
              reviewerId: "9001"
            }
          }
        ]
      }
    ]
  };
}

function duplicateEntry(
  field:
    | "linearIssueId"
    | "workItemId"
    | "pullRequestNumber"
    | "branch"
) {
  const fixture = createIndexFixture();
  const first = fixture.entries[0];
  assert.ok(first);
  const second = {
    ...structuredClone(first),
    linearIssueId:
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workItemId: "TS-NP-7",
    branch: "feature/np-7-acceptance",
    pullRequestNumber: 59
  };
  if (field === "linearIssueId") {
    second.linearIssueId =
      first.linearIssueId;
  } else if (field === "workItemId") {
    second.workItemId =
      first.workItemId;
  } else if (
    field === "pullRequestNumber"
  ) {
    second.pullRequestNumber =
      first.pullRequestNumber;
  } else {
    second.branch = first.branch;
  }
  fixture.entries.push(second);
  return fixture;
}

function duplicateEvidence(
  field: "criterion" | "source"
) {
  const fixture = createIndexFixture();
  const entry = fixture.entries[0];
  assert.ok(entry);
  const first = entry.evidence[0];
  assert.ok(first);
  const duplicate = structuredClone(first);
  if (field === "criterion") {
    duplicate.source = {
      kind: "check_run",
      name: "lint",
      appId: "15368"
    };
  } else {
    duplicate.criterionKey = "lint";
  }
  entry.evidence.push(duplicate);
  return fixture;
}

async function createTemporaryDirectory(
  t: TestContext
): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "taskseal-github-delivery-")
  );
  t.after(() =>
    rm(directory, {
      recursive: true,
      force: true
    })
  );
  return directory;
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}

function hasNodeErrorCode(
  error: unknown,
  code: string
): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === code
  );
}
