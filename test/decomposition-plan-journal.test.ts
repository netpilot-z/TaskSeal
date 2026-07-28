import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
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
  DecompositionPlanJournal,
  DecompositionPlanJournalError
} from "../src/application/decomposition-plan-journal.ts";
import {
  DecompositionPlanStoreError,
  FileDecompositionPlanStore
} from "../src/storage/decomposition-plan-store.ts";
import {
  digestCanonicalJson
} from "../src/lib/canonical-json.ts";
import { createDecompositionFixture } from "../test-support/decomposition-fixtures.ts";

test("approved decomposition plans persist, reopen, and retry idempotently", async (t) => {
  const context = await createContext(t);
  const fixture =
    createDecompositionFixture();
  const journal =
    await DecompositionPlanJournal.open({
      storage: context.storage
    });
  const first = await journal.approve({
    plan: fixture.preview.plan,
    expectedPlanDigest:
      fixture.preview.planDigest,
    approvedBy: "operator.jeffrey",
    approvedAt:
      "2026-07-28T13:00:00.000Z"
  });
  const retry = await journal.approve({
    plan: structuredClone(
      fixture.preview.plan
    ),
    expectedPlanDigest:
      fixture.preview.planDigest,
    approvedBy: "operator.jeffrey",
    approvedAt:
      "2026-07-28T13:01:00.000Z"
  });

  assert.equal(
    first.resolution,
    "committed"
  );
  assert.equal(
    retry.resolution,
    "idempotent"
  );
  assert.equal(
    retry.record.approvedAt,
    first.record.approvedAt
  );
  assert.equal(
    journal.list().length,
    1
  );

  const reopened =
    await DecompositionPlanJournal.open({
      storage:
        new FileDecompositionPlanStore({
          filePath: context.filePath
        })
    });
  assert.equal(
    reopened.get("plan-alpha")
      ?.planDigest,
    fixture.preview.planDigest
  );
});

test("approval attempt baselines persist as a versioned ownership generation", async () => {
  const fixture =
    createDecompositionFixture();
  const storage =
    new MemoryDecompositionStorage();
  const journal =
    await DecompositionPlanJournal.open({
      storage
    });
  const approval = {
    plan: fixture.preview.plan,
    expectedPlanDigest:
      fixture.preview.planDigest,
    approvedBy:
      "operator.jeffrey",
    approvedAt:
      "2026-07-28T13:00:00.000Z",
    attemptBaselines: [
      emptyAttemptBaseline("API"),
      emptyAttemptBaseline("QA"),
      emptyAttemptBaseline("ROOT")
    ]
  };

  const result =
    await journal.approve(
      approval
    );

  assert.equal(
    result.record.schemaVersion,
    "2"
  );
  assert.deepEqual(
    "attemptBaselines" in
      result.record
      ? result.record
          .attemptBaselines
          .map(
            (baseline) =>
              baseline.workItemId
          )
      : [],
    ["API", "QA", "ROOT"]
  );
  assert.equal(
    (
      storage.value as {
        schemaVersion: string;
      }
    ).schemaVersion,
    "3"
  );

  const reopened =
    await DecompositionPlanJournal.open({
      storage
    });
  assert.deepEqual(
    reopened.get("plan-alpha"),
    result.record
  );
});

test("a retired baseline generation can be replaced and reopened without losing lifecycle history", async () => {
  const fixture =
    createDecompositionFixture();
  const storage =
    new MemoryDecompositionStorage();
  const journal =
    await DecompositionPlanJournal.open({
      storage
    });
  const baselines = [
    emptyAttemptBaseline("API"),
    emptyAttemptBaseline("QA"),
    emptyAttemptBaseline("ROOT")
  ];
  await journal.approve({
    plan: fixture.preview.plan,
    expectedPlanDigest:
      fixture.preview.planDigest,
    approvedBy:
      "operator.jeffrey",
    approvedAt:
      "2026-07-28T13:00:00.000Z",
    attemptBaselines:
      baselines
  });
  await journal.retire({
    planId: "plan-alpha",
    expectedPlanDigest:
      fixture.preview.planDigest,
    retiredBy:
      "operator.jeffrey",
    retiredAt:
      "2026-07-28T13:05:00.000Z",
    reasonCode:
      "operator_rollback",
    note:
      "Replace the interrupted generation."
  });
  const replacementPlan = {
    ...structuredClone(
      fixture.preview.plan
    ),
    planId: "plan-beta"
  };
  const replacementDigest =
    digestCanonicalJson(
      replacementPlan,
      { maxDepth: 12 }
    );

  await journal.approve({
    plan: replacementPlan,
    expectedPlanDigest:
      replacementDigest,
    approvedBy:
      "operator.jeffrey",
    approvedAt:
      "2026-07-28T13:10:00.000Z",
    attemptBaselines:
      baselines
  });

  assert.equal(
    (
      storage.value as {
        schemaVersion: string;
      }
    ).schemaVersion,
    "3"
  );
  const reopened =
    await DecompositionPlanJournal.open({
      storage
    });
  assert.deepEqual(
    reopened.list().map(
      (record) =>
        record.plan.planId
    ),
    ["plan-beta"]
  );
  assert.equal(
    reopened.getRetirement(
      "plan-alpha"
    )?.planDigest,
    fixture.preview.planDigest
  );
  assert.equal(
    reopened.get("plan-beta")
      ?.schemaVersion,
    "2"
  );
});

test("approved plans with non-lexical topology persist and reopen without reordering", async (t) => {
  const context = await createContext(t);
  const fixture =
    createDecompositionFixture();
  const plan = {
    ...structuredClone(
      fixture.preview.plan
    ),
    nodes:
      fixture.preview.plan.nodes.map(
        (node) =>
          node.nodeId === "api"
            ? {
                ...structuredClone(
                  node
                ),
                nodeId:
                  "z-foundation"
              }
            : {
                ...structuredClone(
                  node
                ),
                nodeId:
                  "a-verification",
                dependsOn: [
                  "z-foundation"
                ]
              }
      ).toSorted(
        (left, right) =>
          left.nodeId.localeCompare(
            right.nodeId
          )
      ),
    topologicalOrder: [
      "z-foundation",
      "a-verification"
    ]
  };
  const planDigest =
    digestCanonicalJson(
      plan,
      { maxDepth: 12 }
    );
  const journal =
    await DecompositionPlanJournal.open({
      storage: context.storage
    });

  await journal.approve({
    plan,
    expectedPlanDigest:
      planDigest,
    approvedBy:
      "operator.jeffrey",
    approvedAt:
      "2026-07-28T13:00:00.000Z"
  });
  const reopened =
    await DecompositionPlanJournal.open({
      storage:
        new FileDecompositionPlanStore({
          filePath:
            context.filePath
        })
    });

  assert.deepEqual(
    reopened.get("plan-alpha")
      ?.plan.topologicalOrder,
    [
      "z-foundation",
      "a-verification"
    ]
  );
});

test("approval rejects stale digests, plan ID conflicts, overlapping work, and recursive roots before writing", async () => {
  const fixture =
    createDecompositionFixture();
  const storage =
    new MemoryDecompositionStorage();
  const journal =
    await DecompositionPlanJournal.open({
      storage
    });

  await assert.rejects(
    journal.approve({
      plan: fixture.preview.plan,
      expectedPlanDigest:
        "sha256:" + "0".repeat(64),
      approvedBy:
        "operator.jeffrey",
      approvedAt:
        "2026-07-28T13:00:00.000Z"
    }),
    hasCode(
      "DECOMPOSITION_APPROVAL_STALE"
    )
  );
  assert.equal(storage.writeCalls, 0);

  await journal.approve({
    plan: fixture.preview.plan,
    expectedPlanDigest:
      fixture.preview.planDigest,
    approvedBy: "operator.jeffrey",
    approvedAt:
      "2026-07-28T13:00:00.000Z"
  });
  const conflicting = {
    ...fixture.preview.plan,
    nodes:
      fixture.preview.plan.nodes.map(
        (node, index) =>
          index === 0
            ? {
                ...node,
                instruction:
                  "Changed after approval."
              }
            : node
      )
  };
  await assert.rejects(
    journal.approve({
      plan: conflicting,
      expectedPlanDigest:
        fixture.preview.planDigest,
      approvedBy:
        "operator.jeffrey",
      approvedAt:
        "2026-07-28T13:00:01.000Z"
    }),
    hasCode(
      "DECOMPOSITION_PLAN_CONFLICT"
    )
  );

  const overlap = {
    ...fixture.preview.plan,
    planId: "plan-overlap",
    rootWorkItemId: "OTHER-ROOT"
  };
  await assert.rejects(
    journal.approve({
      plan: overlap,
      expectedPlanDigest:
        digestCanonicalJson(
          overlap,
          { maxDepth: 12 }
        ),
      approvedBy:
        "operator.jeffrey",
      approvedAt:
        "2026-07-28T13:00:02.000Z"
    }),
    hasCode(
      "DECOMPOSITION_PLAN_CONFLICT"
    )
  );
  assert.equal(storage.writeCalls, 1);
});

test("retirement is CAS-bound, audited across reopen, and releases active ownership", async (t) => {
  const context = await createContext(t);
  const fixture =
    createDecompositionFixture();
  const journal =
    await DecompositionPlanJournal.open({
      storage: context.storage
    });
  await journal.approve({
    plan: fixture.preview.plan,
    expectedPlanDigest:
      fixture.preview.planDigest,
    approvedBy:
      "operator.jeffrey",
    approvedAt:
      "2026-07-28T13:00:00.000Z"
  });

  await assert.rejects(
    journal.retire({
      planId: "plan-alpha",
      expectedPlanDigest:
        `sha256:${"0".repeat(64)}`,
      retiredBy:
        "operator.jeffrey",
      retiredAt:
        "2026-07-28T13:05:00.000Z",
      reasonCode:
        "operator_rollback",
      note:
        "Return to reviewed single-item execution."
    }),
    hasCode(
      "DECOMPOSITION_RETIREMENT_STALE"
    )
  );
  const retired =
    await journal.retire({
      planId: "plan-alpha",
      expectedPlanDigest:
        fixture.preview.planDigest,
      retiredBy:
        "operator.jeffrey",
      retiredAt:
        "2026-07-28T13:05:00.000Z",
      reasonCode:
        "operator_rollback",
      note:
        "Return to reviewed single-item execution."
    });
  const retry =
    await journal.retire({
      planId: "plan-alpha",
      expectedPlanDigest:
        fixture.preview.planDigest,
      retiredBy:
        "operator.jeffrey",
      retiredAt:
        "2026-07-28T13:06:00.000Z",
      reasonCode:
        "operator_rollback",
      note:
        "Return to reviewed single-item execution."
    });
  const retryAfterClockRegression =
    await journal.retire({
      planId: "plan-alpha",
      expectedPlanDigest:
        fixture.preview.planDigest,
      retiredBy:
        "operator.jeffrey",
      retiredAt:
        "2026-07-28T12:00:00.000Z",
      reasonCode:
        "operator_rollback",
      note:
        "Return to reviewed single-item execution."
    });

  assert.equal(
    retired.resolution,
    "committed"
  );
  assert.equal(
    retry.resolution,
    "idempotent"
  );
  assert.equal(
    retryAfterClockRegression
      .resolution,
    "idempotent"
  );
  assert.equal(
    retryAfterClockRegression
      .record.retiredAt,
    retired.record.retiredAt
  );
  assert.equal(journal.get("plan-alpha"), null);
  assert.deepEqual(journal.list(), []);
  await assert.rejects(
    journal.approve({
      plan: fixture.preview.plan,
      expectedPlanDigest:
        fixture.preview.planDigest,
      approvedBy:
        "operator.jeffrey",
      approvedAt:
        "2026-07-28T13:06:30.000Z"
    }),
    hasCode(
      "DECOMPOSITION_PLAN_RETIRED"
    )
  );

  const reopened =
    await DecompositionPlanJournal.open({
      storage:
        new FileDecompositionPlanStore({
          filePath:
            context.filePath
        })
    });
  assert.equal(
    reopened.get("plan-alpha"),
    null
  );
  assert.equal(
    reopened.getRetirement(
      "plan-alpha"
    )?.reasonCode,
    "operator_rollback"
  );

  const replacement = {
    ...structuredClone(
      fixture.preview.plan
    ),
    planId: "plan-replacement"
  };
  const replacementDigest =
    digestCanonicalJson(
      replacement,
      { maxDepth: 12 }
    );
  await reopened.approve({
    plan: replacement,
    expectedPlanDigest:
      replacementDigest,
    approvedBy:
      "operator.jeffrey",
    approvedAt:
      "2026-07-28T13:07:00.000Z"
  });
  assert.equal(
    reopened.list().length,
    1
  );
});

test("legacy v1 approval envelopes reopen and retirement upgrades the writer to v2", async () => {
  const fixture =
    createDecompositionFixture();
  const storage =
    new MemoryDecompositionStorage();
  storage.value = {
    schemaVersion: "1",
    revision: 1,
    records: [
      {
        recordType:
          "decomposition.approved",
        schemaVersion: "1",
        planDigest:
          fixture.preview.planDigest,
        approvedBy:
          "operator.jeffrey",
        approvedAt:
          "2026-07-28T13:00:00.000Z",
        plan:
          fixture.preview.plan
      }
    ]
  };
  const journal =
    await DecompositionPlanJournal.open({
      storage
    });

  assert.equal(
    journal.list().length,
    1
  );
  await journal.retire({
    planId: "plan-alpha",
    expectedPlanDigest:
      fixture.preview.planDigest,
    retiredBy:
      "operator.jeffrey",
    retiredAt:
      "2026-07-28T13:05:00.000Z",
    reasonCode:
      "operator_rollback",
    note:
      "Upgrade the lifecycle envelope."
  });
  assert.equal(
    (
      storage.value as {
        schemaVersion: string;
      }
    ).schemaVersion,
    "2"
  );
});

test("approval-only writes preserve the legacy v1 rollback boundary", async () => {
  const fixture =
    createDecompositionFixture();
  const storage =
    new MemoryDecompositionStorage();
  storage.value = {
    schemaVersion: "1",
    revision: 0,
    records: []
  };
  const journal =
    await DecompositionPlanJournal.open({
      storage
    });

  await journal.approve({
    plan: fixture.preview.plan,
    expectedPlanDigest:
      fixture.preview.planDigest,
    approvedBy:
      "operator.jeffrey",
    approvedAt:
      "2026-07-28T13:00:00.000Z"
  });

  assert.deepEqual(
    Object.keys(
      storage.value as object
    ).toSorted(),
    [
      "records",
      "revision",
      "schemaVersion"
    ]
  );
  assert.equal(
    (
      storage.value as {
        schemaVersion: string;
      }
    ).schemaVersion,
    "1"
  );
});

test("an uncertain plan commit fences the instance and reopen observes the committed record", async () => {
  const fixture =
    createDecompositionFixture();
  const storage =
    new MemoryDecompositionStorage({
      failAfterCommit: true
    });
  const journal =
    await DecompositionPlanJournal.open({
      storage
    });

  await assert.rejects(
    journal.approve({
      plan: fixture.preview.plan,
      expectedPlanDigest:
        fixture.preview.planDigest,
      approvedBy:
        "operator.jeffrey",
      approvedAt:
        "2026-07-28T13:00:00.000Z"
    }),
    hasCode(
      "DECOMPOSITION_COMMIT_OUTCOME_UNKNOWN"
    )
  );
  assert.equal(
    journal.getHealth().status,
    "fenced"
  );
  assert.throws(
    () => journal.list(),
    hasCode(
      "DECOMPOSITION_REOPEN_REQUIRED"
    )
  );

  storage.failAfterCommit = false;
  const reopened =
    await DecompositionPlanJournal.open({
      storage
    });
  assert.equal(
    reopened.get("plan-alpha")
      ?.approvedBy,
    "operator.jeffrey"
  );
});

test("an uncertain retirement commit fences lifecycle reads until reopen", async () => {
  const fixture =
    createDecompositionFixture();
  const storage =
    new MemoryDecompositionStorage();
  const journal =
    await DecompositionPlanJournal.open({
      storage
    });
  await journal.approve({
    plan: fixture.preview.plan,
    expectedPlanDigest:
      fixture.preview.planDigest,
    approvedBy:
      "operator.jeffrey",
    approvedAt:
      "2026-07-28T13:00:00.000Z"
  });
  storage.failAfterCommit = true;

  await assert.rejects(
    journal.retire({
      planId: "plan-alpha",
      expectedPlanDigest:
        fixture.preview.planDigest,
      retiredBy:
        "operator.jeffrey",
      retiredAt:
        "2026-07-28T13:05:00.000Z",
      reasonCode:
        "operator_rollback",
      note:
        "The persisted outcome requires reopen."
    }),
    hasCode(
      "DECOMPOSITION_COMMIT_OUTCOME_UNKNOWN"
    )
  );
  assert.deepEqual(
    journal.getHealth(),
    {
      status: "fenced",
      code:
        "DECOMPOSITION_COMMIT_OUTCOME_UNKNOWN"
    }
  );
  assert.throws(
    () => journal.list(),
    hasCode(
      "DECOMPOSITION_REOPEN_REQUIRED"
    )
  );
  assert.throws(
    () =>
      journal.listRetirements(),
    hasCode(
      "DECOMPOSITION_REOPEN_REQUIRED"
    )
  );

  storage.failAfterCommit = false;
  const reopened =
    await DecompositionPlanJournal.open({
      storage
    });
  assert.deepEqual(
    reopened.list(),
    []
  );
  assert.equal(
    reopened.getRetirement(
      "plan-alpha"
    )?.reasonCode,
    "operator_rollback"
  );
});

test("file plan storage uses atomic replacement and classifies failures around replace", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "taskseal-plan-store-")
  );
  t.after(() =>
    rm(directory, {
      recursive: true,
      force: true
    })
  );
  const filePath = join(
    directory,
    "decomposition-plans.json"
  );
  const initial = {
    schemaVersion: "1",
    revision: 0,
    records: []
  };
  const beforeReplace =
    new FileDecompositionPlanStore({
      filePath,
      failureInjector(stage) {
        if (stage === "beforeReplace") {
          throw new Error(
            "Injected before replace."
          );
        }
      }
    });
  await assert.rejects(
    beforeReplace.write(initial),
    (error: unknown) =>
      error instanceof
        DecompositionPlanStoreError &&
      error.code ===
        "DECOMPOSITION_STORE_WRITE_FAILED"
  );
  await assert.rejects(
    readFile(filePath, "utf8"),
    hasSystemCode("ENOENT")
  );

  const afterReplace =
    new FileDecompositionPlanStore({
      filePath,
      failureInjector(stage) {
        if (stage === "afterReplace") {
          throw new Error(
            "Injected after replace."
          );
        }
      }
    });
  await assert.rejects(
    afterReplace.write(initial),
    (error: unknown) =>
      error instanceof
        DecompositionPlanStoreError &&
      error.code ===
        "DECOMPOSITION_STORE_COMMIT_OUTCOME_UNKNOWN"
  );
  assert.deepEqual(
    await new FileDecompositionPlanStore({
      filePath
    }).read(),
    initial
  );
});

test("file plan storage rejects redirected state directories and multi-link targets", async (t) => {
  const workspace =
    await mkdtemp(
      join(
        tmpdir(),
        "taskseal-plan-root-"
      )
    );
  const outside =
    await mkdtemp(
      join(
        tmpdir(),
        "taskseal-plan-outside-"
      )
    );
  t.after(async () => {
    await rm(workspace, {
      recursive: true,
      force: true
    });
    await rm(outside, {
      recursive: true,
      force: true
    });
  });
  const stateDirectory = join(
    workspace,
    ".taskseal"
  );
  await symlink(
    outside,
    stateDirectory,
    process.platform === "win32"
      ? "junction"
      : "dir"
  );
  const redirected =
    new FileDecompositionPlanStore({
      workspaceRoot: workspace,
      filePath: join(
        stateDirectory,
        "decomposition-plans.json"
      )
    });

  await assert.rejects(
    redirected.read(),
    hasStoreCode(
      "DECOMPOSITION_STORE_READ_FAILED"
    )
  );
  await assert.rejects(
    redirected.write({
      schemaVersion: "1"
    }),
    hasStoreCode(
      "DECOMPOSITION_STORE_WRITE_FAILED"
    )
  );
  await assert.rejects(
    readFile(
      join(
        outside,
        "decomposition-plans.json"
      )
    ),
    hasSystemCode("ENOENT")
  );

  await rm(stateDirectory, {
    force: true
  });
  await mkdir(stateDirectory);
  const sourcePath = join(
    workspace,
    "source.json"
  );
  const targetPath = join(
    stateDirectory,
    "decomposition-plans.json"
  );
  await writeFile(
    sourcePath,
    "{}",
    "utf8"
  );
  await link(
    sourcePath,
    targetPath
  );
  const linked =
    new FileDecompositionPlanStore({
      workspaceRoot: workspace,
      filePath: targetPath
    });

  await assert.rejects(
    linked.read(),
    hasStoreCode(
      "DECOMPOSITION_STORE_CORRUPT"
    )
  );
  await assert.rejects(
    linked.write({
      schemaVersion: "1"
    }),
    hasStoreCode(
      "DECOMPOSITION_STORE_WRITE_FAILED"
    )
  );
  assert.equal(
    await readFile(
      sourcePath,
      "utf8"
    ),
    "{}"
  );
});

test("file plan storage detects a final state-directory swap before replace", async (t) => {
  const workspace =
    await mkdtemp(
      join(
        tmpdir(),
        "taskseal-plan-swap-"
      )
    );
  const outside =
    await mkdtemp(
      join(
        tmpdir(),
        "taskseal-plan-swap-outside-"
      )
    );
  t.after(async () => {
    await rm(workspace, {
      recursive: true,
      force: true
    });
    await rm(outside, {
      recursive: true,
      force: true
    });
  });
  const stateDirectory = join(
    workspace,
    ".taskseal"
  );
  const originalDirectory = join(
    workspace,
    ".taskseal-original"
  );
  const filePath = join(
    stateDirectory,
    "decomposition-plans.json"
  );
  const storage =
    new FileDecompositionPlanStore({
      workspaceRoot: workspace,
      filePath,
      async failureInjector(
        stage
      ) {
        if (
          stage ===
          "beforeReplace"
        ) {
          await rename(
            stateDirectory,
            originalDirectory
          );
          await symlink(
            outside,
            stateDirectory,
            process.platform ===
              "win32"
              ? "junction"
              : "dir"
          );
        }
      }
    });

  await assert.rejects(
    storage.write({
      schemaVersion: "1"
    }),
    hasStoreCode(
      "DECOMPOSITION_STORE_WRITE_FAILED"
    )
  );
  await assert.rejects(
    readFile(
      join(
        outside,
        "decomposition-plans.json"
      )
    ),
    hasSystemCode("ENOENT")
  );
});

async function createContext(
  t: TestContext
) {
  const directory = await mkdtemp(
    join(tmpdir(), "taskseal-plans-")
  );
  t.after(() =>
    rm(directory, {
      recursive: true,
      force: true
    })
  );
  const filePath = join(
    directory,
    "decomposition-plans.json"
  );
  return {
    filePath,
    storage:
      new FileDecompositionPlanStore({
        filePath
      })
  };
}

class MemoryDecompositionStorage {
  value: unknown = null;
  writeCalls = 0;
  failAfterCommit: boolean;

  constructor({
    failAfterCommit = false
  }: {
    failAfterCommit?: boolean;
  } = {}) {
    this.failAfterCommit =
      failAfterCommit;
  }

  async read() {
    return structuredClone(this.value);
  }

  async write(value: unknown) {
    this.writeCalls += 1;
    this.value = structuredClone(value);
    if (this.failAfterCommit) {
      throw new DecompositionPlanStoreError(
        "DECOMPOSITION_STORE_COMMIT_OUTCOME_UNKNOWN",
        "Injected unknown outcome."
      );
    }
  }
}

function emptyAttemptBaseline(
  workItemId: string
) {
  return {
    workItemId,
    attemptCount: 0,
    attemptIdsDigest:
      digestCanonicalJson(
        {
          schemaVersion: "1",
          scope:
            "taskseal.decomposition.attempt-baseline",
          workItemId,
          attemptIds: []
        },
        { maxDepth: 4 }
      )
  };
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof
      DecompositionPlanJournalError &&
    error.code === code;
}

function hasSystemCode(code: string) {
  return (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}

function hasStoreCode(code: string) {
  return (error: unknown) =>
    error instanceof
      DecompositionPlanStoreError &&
    error.code === code;
}
