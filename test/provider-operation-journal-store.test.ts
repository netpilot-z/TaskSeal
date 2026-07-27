import assert from "node:assert/strict";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { inspect } from "node:util";

import {
  createControlledWriteOperation,
  transitionControlledWriteOperation
} from "../src/application/controlled-write-operation.ts";
import type {
  ControlledWriteOperation
} from "../src/application/controlled-write-operation.ts";
import {
  PROVIDER_OPERATION_JOURNAL_BYTE_LIMIT,
  ProviderOperationJournal
} from "../src/application/provider-operation-journal.ts";
import {
  FileProviderOperationJournalStorage
} from "../src/storage/provider-operation-journal.ts";

test("file operation journal persists one bounded canonical snapshot and recovers on reopen", async (t) => {
  const context = await temporaryStore(t);
  const journal = await openJournal(context);
  const initial = operation();
  const approved = approve(initial);

  await append(journal, 0, initial);
  await append(journal, 1, approved);

  const content = await readFile(
    context.filePath,
    "utf8"
  );
  assert.equal(content.endsWith("\n"), true);
  assert.doesNotMatch(
    content,
    /authorization|rawResponse|Bearer SECRET/i
  );

  const reopened = await openJournal(context);
  assert.deepEqual(
    await reopened.history(initial.plan.operationKey),
    [initial, approved]
  );
});

test("file operation journal fails closed for corrupt and oversized state", async (t) => {
  const scenarios = [
    {
      name: "invalid JSON",
      content: "{"
    },
    {
      name: "extra envelope field",
      content: JSON.stringify({
        schemaVersion: 1,
        records: [],
        rawPayload: "forbidden"
      })
    },
    {
      name: "oversized file",
      content: " ".repeat(
        PROVIDER_OPERATION_JOURNAL_BYTE_LIMIT + 1
      )
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const context = await temporaryStore(t);
      await writeFile(
        context.filePath,
        scenario.content,
        "utf8"
      );

      await assert.rejects(
        openJournal(context),
        hasCode(
          "PROVIDER_OPERATION_JOURNAL_STORE_CORRUPT"
        )
      );
    });
  }
});

test("pre-rename failure preserves old state and post-rename failure requires reopen", async (t) => {
  const context = await temporaryStore(t);
  const baseline = await openJournal(context);
  const initial = operation();
  const approved = approve(initial);
  await append(baseline, 0, initial);
  const before = await readFile(context.filePath, "utf8");

  const preRename = await openJournal(context, {
    failureInjector(stage) {
      if (stage === "after-temporary-sync") {
        throw new Error("simulated pre-rename failure");
      }
    }
  });
  await assert.rejects(
    append(preRename, 1, approved),
    hasCode(
      "PROVIDER_OPERATION_JOURNAL_WRITE_FAILED"
    )
  );
  assert.equal(
    await readFile(context.filePath, "utf8"),
    before
  );
  await unlink(
    join(
      dirname(context.filePath),
      ".provider-operations.json.tmp"
    )
  );

  const postRename = await openJournal(context, {
    failureInjector(stage) {
      if (stage === "after-rename") {
        throw new Error("simulated unknown outcome");
      }
    }
  });
  await assert.rejects(
    append(postRename, 1, approved),
    hasCode(
      "PROVIDER_OPERATION_JOURNAL_COMMIT_OUTCOME_UNKNOWN"
    )
  );
  await assert.rejects(
    postRename.listLatest(),
    hasCode(
      "PROVIDER_OPERATION_JOURNAL_REOPEN_REQUIRED"
    )
  );

  const reopened = await openJournal(context);
  assert.deepEqual(
    await reopened.get(initial.plan.operationKey),
    approved
  );
});

test("operation journal storage rejects an escaping state directory symlink or Junction", async (t) => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "taskseal-operation-workspace-")
  );
  const outside = await mkdtemp(
    join(tmpdir(), "taskseal-operation-outside-")
  );
  t.after(() =>
    rm(workspaceRoot, { recursive: true, force: true })
  );
  t.after(() =>
    rm(outside, { recursive: true, force: true })
  );
  const stateDirectory = join(workspaceRoot, ".taskseal");
  await symlink(
    outside,
    stateDirectory,
    process.platform === "win32" ? "junction" : "dir"
  );
  const context = {
    workspaceRoot,
    filePath: join(
      stateDirectory,
      "provider-operations.json"
    )
  };

  await assert.rejects(
    openJournal(context),
    hasCode("PROVIDER_OPERATION_JOURNAL_READ_FAILED")
  );
  await assert.rejects(
    readFile(
      join(outside, "provider-operations.json"),
      "utf8"
    ),
    hasNodeCode("ENOENT")
  );
});

test("operation journal storage reads remain bounded when the file grows after stat", async (t) => {
  const context = await temporaryStore(t);
  await writeFile(
    context.filePath,
    JSON.stringify({
      schemaVersion: 1,
      records: []
    }),
    "utf8"
  );
  let injected = false;
  const storage =
    new FileProviderOperationJournalStorage({
      workspaceRoot: context.workspaceRoot,
      async failureInjector(stage) {
        if (stage === "after-read-stat") {
          injected = true;
          await writeFile(
            context.filePath,
            " ".repeat(
              PROVIDER_OPERATION_JOURNAL_BYTE_LIMIT + 1
            ),
            "utf8"
          );
        }
      }
    });

  await assert.rejects(
    storage.load(),
    hasCode(
      "PROVIDER_OPERATION_JOURNAL_STORE_CORRUPT"
    )
  );
  assert.equal(injected, true);
});

test("operation journal reads stay bound to the validated target identity", async (t) => {
  const context = await temporaryStore(t);
  const outsidePath = join(
    context.workspaceRoot,
    "replacement.json"
  );
  const empty = JSON.stringify({
    schemaVersion: 1,
    records: []
  });
  await writeFile(context.filePath, empty, "utf8");
  await writeFile(outsidePath, empty, "utf8");
  let injected = false;
  const storage =
    new FileProviderOperationJournalStorage({
      workspaceRoot: context.workspaceRoot,
      async failureInjector(stage) {
        if (stage === "before-read-open") {
          injected = true;
          await unlink(context.filePath);
          await link(outsidePath, context.filePath);
        }
      }
    });

  await assert.rejects(
    storage.load(),
    hasCode(
      "PROVIDER_OPERATION_JOURNAL_STORE_CORRUPT"
    )
  );
  assert.equal(injected, true);
});

test("operation journal write failure never cleans through a swapped state directory", async (t) => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "taskseal-operation-cleanup-workspace-")
  );
  const outside = await mkdtemp(
    join(tmpdir(), "taskseal-operation-cleanup-outside-")
  );
  t.after(() =>
    rm(workspaceRoot, { recursive: true, force: true })
  );
  t.after(() =>
    rm(outside, { recursive: true, force: true })
  );
  const stateDirectory = join(workspaceRoot, ".taskseal");
  const retainedDirectory = join(
    workspaceRoot,
    ".taskseal-retained"
  );
  await mkdir(stateDirectory);
  const context = {
    workspaceRoot,
    filePath: join(
      stateDirectory,
      "provider-operations.json"
    )
  };
  let victimPath = "";
  const journal = await openJournal(context, {
    async failureInjector(stage) {
      if (stage !== "after-temporary-sync") {
        return;
      }
      const temporaryName = (
        await readdir(stateDirectory)
      ).find((name) => name.endsWith(".tmp"));
      assert.ok(temporaryName);
      await rename(stateDirectory, retainedDirectory);
      await symlink(
        outside,
        stateDirectory,
        process.platform === "win32"
          ? "junction"
          : "dir"
      );
      victimPath = join(outside, temporaryName);
      await writeFile(
        victimPath,
        "outside file must survive",
        "utf8"
      );
    }
  });

  await assert.rejects(
    append(journal, 0, operation()),
    hasCode(
      "PROVIDER_OPERATION_JOURNAL_WRITE_FAILED"
    )
  );
  assert.equal(
    await readFile(victimPath, "utf8"),
    "outside file must survive"
  );
});

test("a final pre-rename directory swap cannot return committed or mutate the replacement target", async (t) => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "taskseal-operation-race-workspace-")
  );
  const outside = await mkdtemp(
    join(tmpdir(), "taskseal-operation-race-outside-")
  );
  t.after(() =>
    rm(workspaceRoot, { recursive: true, force: true })
  );
  t.after(() =>
    rm(outside, { recursive: true, force: true })
  );
  const stateDirectory = join(workspaceRoot, ".taskseal");
  const retainedDirectory = join(
    workspaceRoot,
    ".taskseal-retained"
  );
  await mkdir(stateDirectory);
  const context = {
    workspaceRoot,
    filePath: join(
      stateDirectory,
      "provider-operations.json"
    )
  };
  const journal = await openJournal(context, {
    async failureInjector(stage) {
      if (stage !== "before-rename") {
        return;
      }
      await rename(stateDirectory, retainedDirectory);
      await symlink(
        outside,
        stateDirectory,
        process.platform === "win32"
          ? "junction"
          : "dir"
      );
      await writeFile(
        join(outside, ".provider-operations.json.tmp"),
        `${JSON.stringify({
          schemaVersion: 1,
          records: []
        })}\n`,
        "utf8"
      );
    }
  });

  await assert.rejects(
    append(journal, 0, operation()),
    hasCode(
      "PROVIDER_OPERATION_JOURNAL_WRITE_FAILED"
    )
  );
  await assert.rejects(
    journal.listLatest(),
    hasCode("PROVIDER_OPERATION_JOURNAL_READ_FAILED")
  );
  await assert.rejects(
    readFile(
      join(outside, "provider-operations.json"),
      "utf8"
    ),
    hasNodeCode("ENOENT")
  );
  assert.equal(
    (
      await readFile(
        join(
          outside,
          ".provider-operations.json.tmp"
        ),
        "utf8"
      )
    ).includes("\"records\":[]"),
    true
  );
});

test("a post-rename target swap returns outcome unknown and fences the instance", async (t) => {
  const context = await temporaryStore(t);
  const retainedTarget = join(
    context.workspaceRoot,
    "retained-provider-operations.json"
  );
  const journal = await openJournal(context, {
    async failureInjector(stage) {
      if (stage !== "after-rename-before-verify") {
        return;
      }
      await rename(context.filePath, retainedTarget);
      await writeFile(
        context.filePath,
        `${JSON.stringify({
          schemaVersion: 1,
          records: []
        })}\n`,
        "utf8"
      );
    }
  });

  await assert.rejects(
    append(journal, 0, operation()),
    hasCode(
      "PROVIDER_OPERATION_JOURNAL_COMMIT_OUTCOME_UNKNOWN"
    )
  );
  await assert.rejects(
    journal.listLatest(),
    hasCode(
      "PROVIDER_OPERATION_JOURNAL_REOPEN_REQUIRED"
    )
  );
  assert.match(
    await readFile(retainedTarget, "utf8"),
    /"status":"approval_required"/
  );
});

test("operation journal write failures retain one bounded temporary slot", async (t) => {
  const context = await temporaryStore(t);
  const journal = await openJournal(context, {
    failureInjector(stage) {
      if (stage === "after-temporary-sync") {
        throw new Error("simulated write failure");
      }
    }
  });
  const initial = operation();

  await assert.rejects(
    append(journal, 0, initial),
    hasCode(
      "PROVIDER_OPERATION_JOURNAL_WRITE_FAILED"
    )
  );
  await assert.rejects(
    append(journal, 0, initial),
    hasCode(
      "PROVIDER_OPERATION_JOURNAL_WRITE_FAILED"
    )
  );

  assert.equal(
    (await readdir(dirname(context.filePath))).filter(
      (name) => name.endsWith(".tmp")
    ).length,
    1
  );
});

test("operation journal storage errors do not expose raw causes", async (t) => {
  await t.test("read failure", async (t) => {
    const context = await temporaryStore(t);
    await writeFile(
      context.filePath,
      JSON.stringify({
        schemaVersion: 1,
        records: []
      }),
      "utf8"
    );
    const storage =
      new FileProviderOperationJournalStorage({
        workspaceRoot: context.workspaceRoot,
        failureInjector(stage) {
          if (stage === "before-read-open") {
            throw new Error(
              "Bearer SECRET_READ_SENTINEL"
            );
          }
        }
      });

    await assert.rejects(storage.load(), (error) => {
      const rendered = inspect(error, { depth: 10 });
      assert.equal(
        rendered.includes("SECRET_READ_SENTINEL"),
        false
      );
      assert.equal(
        rendered.includes(context.workspaceRoot),
        false
      );
      return hasCode(
        "PROVIDER_OPERATION_JOURNAL_READ_FAILED"
      )(error);
    });
  });

  await t.test("write failure", async (t) => {
    const context = await temporaryStore(t);
    const journal = await openJournal(context, {
      failureInjector(stage) {
        if (stage === "before-temporary-open") {
          throw new Error(
            "Bearer SECRET_WRITE_SENTINEL"
          );
        }
      }
    });

    await assert.rejects(
      append(journal, 0, operation()),
      (error) => {
        const rendered = inspect(error, { depth: 10 });
        assert.equal(
          rendered.includes("SECRET_WRITE_SENTINEL"),
          false
        );
        assert.equal(
          rendered.includes(context.workspaceRoot),
          false
        );
        return hasCode(
          "PROVIDER_OPERATION_JOURNAL_WRITE_FAILED"
        )(error);
      }
    );
  });
});

test("operation journal storage fixes its repository coordinate and rejects target redirects", async (t) => {
  const context = await temporaryStore(t);
  const gitDirectory = join(
    context.workspaceRoot,
    ".git"
  );
  const gitConfig = join(gitDirectory, "config");
  await mkdir(gitDirectory);
  await writeFile(gitConfig, "must survive", "utf8");
  const unsafeOptions: { workspaceRoot: string } = {
    workspaceRoot: context.workspaceRoot
  };
  Object.assign(unsafeOptions, {
    filePath: gitConfig
  });
  const fixedJournal = await ProviderOperationJournal.open({
    storage: new FileProviderOperationJournalStorage(
      unsafeOptions
    )
  });
  await append(fixedJournal, 0, operation());

  assert.equal(
    await readFile(gitConfig, "utf8"),
    "must survive"
  );
  assert.match(
    await readFile(context.filePath, "utf8"),
    /"schemaVersion":1/
  );
  await unlink(context.filePath);

  const target = join(
    context.workspaceRoot,
    "outside-target"
  );
  await mkdir(target);
  await symlink(
    target,
    context.filePath,
    process.platform === "win32" ? "junction" : "dir"
  );
  await assert.rejects(
    openJournal(context),
    hasCode(
      "PROVIDER_OPERATION_JOURNAL_STORE_CORRUPT"
    )
  );
  assert.equal((await lstat(target)).isDirectory(), true);
});

interface StoreContext {
  workspaceRoot: string;
  filePath: string;
}

interface StoreOptions {
  failureInjector?: (
    stage:
      | "after-read-stat"
      | "before-read-open"
      | "before-temporary-open"
      | "after-temporary-sync"
      | "before-rename"
      | "after-rename-before-verify"
      | "after-rename"
  ) => unknown | Promise<unknown>;
}

async function openJournal(
  context: StoreContext,
  options: StoreOptions = {}
): Promise<ProviderOperationJournal> {
  return ProviderOperationJournal.open({
    storage: new FileProviderOperationJournalStorage({
      workspaceRoot: context.workspaceRoot,
      ...options
    })
  });
}

async function temporaryStore(
  t: TestContext
): Promise<StoreContext> {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "taskseal-provider-operations-")
  );
  t.after(() =>
    rm(workspaceRoot, {
      recursive: true,
      force: true
    })
  );
  const stateDirectory = join(
    workspaceRoot,
    ".taskseal"
  );
  await mkdir(stateDirectory);
  return {
    workspaceRoot,
    filePath: join(
      stateDirectory,
      "provider-operations.json"
    )
  };
}

function operation(): ControlledWriteOperation {
  return createControlledWriteOperation({
    configuredTarget: {
      kind: "team",
      key: "linear:team-ref:netpilot-z/netpilot"
    },
    resolvedTarget: {
      organizationId:
        "11111111-1111-4111-8111-111111111111",
      teamId:
        "22222222-2222-4222-8222-222222222222"
    },
    clientRequestId:
      "33333333-3333-4333-8333-333333333333",
    payload: {
      title: "Create the delivery ticket",
      description: "Reviewed TaskSeal work."
    },
    preparedAt: "2026-07-27T10:00:00.000Z"
  });
}

function approve(
  initial: ControlledWriteOperation
): ControlledWriteOperation {
  return transitionControlledWriteOperation(initial, {
    type: "approve",
    actor: {
      type: "human",
      id: "owner"
    },
    operationKey: initial.plan.operationKey,
    planDigest: initial.plan.planDigest,
    occurredAt: "2026-07-27T10:01:00.000Z"
  });
}

function append(
  journal: ProviderOperationJournal,
  expectedVersion: number,
  next: ControlledWriteOperation
) {
  return journal.compareAndAppend({
    expectedVersion,
    operationKey: next.plan.operationKey,
    planDigest: next.plan.planDigest,
    next
  });
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}

function hasNodeCode(
  code: string
): (error: unknown) => boolean {
  return hasCode(code);
}
