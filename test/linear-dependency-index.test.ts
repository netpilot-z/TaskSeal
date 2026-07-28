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
import test from "node:test";
import type {
  TestContext
} from "node:test";

import {
  parseLinearDependencyIndex,
  readLinearDependencyIndex
} from "../src/connectors/linear-dependency-index.ts";

const T16_ID =
  "11111111-1111-4111-8111-111111111111";
const T17_ID =
  "22222222-2222-4222-8222-222222222222";
const RELATION_ID =
  "33333333-3333-4333-8333-333333333333";

test("bootstrap dependency index exposes complete UUID edges and fails closed on unmapped prerequisites", async () => {
  const index = await readLinearDependencyIndex({
    workspaceRoot: process.cwd(),
    repositoryPath:
      "docs/tickets/0007-linear-bootstrap-map.json"
  });

  assert.deepEqual(
    index.dependenciesOf(
      "fb80f73d-3857-445a-843b-da1d13b1999c"
    ),
    {
      completeness: "complete",
      issueIds: [
        "cc57a0f0-ce3b-4e26-98b0-cd01219eac4a"
      ]
    }
  );
  assert.deepEqual(
    index.dependenciesOf(
      "cc57a0f0-ce3b-4e26-98b0-cd01219eac4a"
    ),
    {
      completeness: "unknown",
      issueIds: []
    }
  );
  assert.deepEqual(
    index.dependenciesOf(
      "d417850c-add8-4f90-9793-e9530e37ec60"
    ),
    {
      completeness: "complete",
      issueIds: []
    }
  );
});

test("dependency index validates stable relation endpoints and coverage", () => {
  const index = parseLinearDependencyIndex(
    createIndexFixture()
  );

  assert.deepEqual(
    index.target,
    {
      organizationId:
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      teamId:
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      projectId:
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      stateId:
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    }
  );
  assert.deepEqual(
    index.dependenciesOf(T17_ID),
    {
      completeness: "complete",
      issueIds: [T16_ID]
    }
  );
  assert.deepEqual(
    index.dependenciesOf(
      "44444444-4444-4444-8444-444444444444"
    ),
    {
      completeness: "unindexed",
      issueIds: []
    }
  );

  const mismatched = createIndexFixture();
  const relation = mismatched.relations[0];
  assert.ok(relation);
  mismatched.relations[0] = {
    ...relation,
    issueId: T17_ID
  };
  assert.throws(
    () =>
      parseLinearDependencyIndex(mismatched),
    hasCode(
      "LINEAR_DEPENDENCY_INDEX_INVALID"
    )
  );

  const missingTarget =
    createIndexFixture();
  Reflect.deleteProperty(
    missingTarget,
    "target"
  );
  assert.throws(
    () =>
      parseLinearDependencyIndex(
        missingTarget
      ),
    hasCode(
      "LINEAR_DEPENDENCY_INDEX_INVALID"
    )
  );

  const duplicateRelationId =
    createIndexFixture();
  duplicateRelationId.entries.push({
    sourceTicket: "T18",
    dependsOnTickets: ["T16"],
    linearIssue: {
      id:
        "44444444-4444-4444-8444-444444444444"
    }
  });
  duplicateRelationId.relations.push({
    clientRequestId: RELATION_ID,
    type: "blocks",
    blockingTicket: "T16",
    blockedTicket: "T18",
    issueId: T16_ID,
    relatedIssueId:
      "44444444-4444-4444-8444-444444444444"
  });
  assert.throws(
    () =>
      parseLinearDependencyIndex(
        duplicateRelationId
      ),
    hasCode(
      "LINEAR_DEPENDENCY_INDEX_INVALID"
    )
  );
});

test("dependency index rejects files beyond the bounded read limit", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  await mkdir(join(cwd, "docs"), {
    recursive: true
  });
  await writeFile(
    join(cwd, "docs", "dependencies.json"),
    " ".repeat(600 * 1024)
  );

  await assert.rejects(
    readLinearDependencyIndex({
      workspaceRoot: cwd,
      repositoryPath:
        "docs/dependencies.json"
    }),
    hasCode(
      "LINEAR_DEPENDENCY_INDEX_LIMIT_EXCEEDED"
    )
  );
});

test("dependency index rejects a directory link that escapes the workspace", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const outside =
    await createTemporaryDirectory(t);
  await writeFile(
    join(outside, "dependencies.json"),
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
      t.skip(
        "directory links are unavailable"
      );
      return;
    }

    throw error;
  }

  await assert.rejects(
    readLinearDependencyIndex({
      workspaceRoot: cwd,
      repositoryPath:
        "redirected/dependencies.json"
    }),
    hasCode(
      "LINEAR_DEPENDENCY_INDEX_INVALID"
    )
  );
});

test("dependency index rejects alternate streams and non-portable path identities", async (t) => {
  const cwd = await createTemporaryDirectory(t);

  for (const repositoryPath of [
    "docs/base.json:dependencies.json",
    "docs\\dependencies.json",
    "docs/CON/dependencies.json",
    "docs/trailing./dependencies.json"
  ]) {
    await assert.rejects(
      readLinearDependencyIndex({
        workspaceRoot: cwd,
        repositoryPath
      }),
      hasCode(
        "LINEAR_DEPENDENCY_INDEX_INVALID"
      )
    );
  }
});

function createIndexFixture() {
  return {
    schemaVersion: 1,
    provider: "linear",
    target: {
      organizationId:
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      teamId:
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      projectId:
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      stateId:
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    },
    entries: [
      {
        sourceTicket: "T16",
        dependsOnTickets: [],
        linearIssue: {
          id: T16_ID
        }
      },
      {
        sourceTicket: "T17",
        dependsOnTickets: ["T16"],
        linearIssue: {
          id: T17_ID
        }
      }
    ],
    relations: [
      {
        clientRequestId: RELATION_ID,
        type: "blocks",
        blockingTicket: "T16",
        blockedTicket: "T17",
        issueId: T16_ID,
        relatedIssueId: T17_ID
      }
    ]
  };
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}

async function createTemporaryDirectory(
  t: TestContext
): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "taskseal-dependency-index-")
  );
  t.after(() =>
    rm(directory, {
      recursive: true,
      force: true
    })
  );
  return directory;
}

function hasNodeErrorCode(
  error: unknown,
  code: string
): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}
