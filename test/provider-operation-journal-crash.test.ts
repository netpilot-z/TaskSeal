import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { TestContext } from "node:test";

import {
  createControlledWriteOperation
} from "../src/application/controlled-write-operation.ts";
import {
  ProviderOperationJournal
} from "../src/application/provider-operation-journal.ts";
import {
  FileProviderOperationJournalStorage
} from "../src/storage/provider-operation-journal.ts";

const CHILD_PATH = fileURLToPath(
  new URL(
    "../test-support/provider-operation-journal-crash-child.ts",
    import.meta.url
  )
);

test("process exit before operation journal rename preserves the old authority", async (t) => {
  const context = await createContext(t);
  const exit = await runCrashChild(
    context,
    "after-temporary-sync"
  );

  assert.equal(exit.code, 91, exit.stderr);
  const reopened = await openJournal(context);
  assert.deepEqual(await reopened.listLatest(), []);
  assert.deepEqual(
    await readdir(join(context.workspaceRoot, ".taskseal")),
    [".provider-operations.json.tmp"]
  );
  assert.equal(
    (
      await reopened.compareAndAppend({
        expectedVersion: 0,
        operationKey:
          context.operation.plan.operationKey,
        planDigest: context.operation.plan.planDigest,
        next: context.operation
      })
    ).resolution,
    "committed"
  );
  assert.deepEqual(
    await readdir(join(context.workspaceRoot, ".taskseal")),
    ["provider-operations.json"]
  );
});

test("process exit after operation journal rename exposes one complete record", async (t) => {
  const context = await createContext(t);
  const exit = await runCrashChild(
    context,
    "after-rename"
  );

  assert.equal(exit.code, 91, exit.stderr);
  const reopened = await openJournal(context);
  assert.deepEqual(
    await reopened.get(context.operation.plan.operationKey),
    context.operation
  );
});

interface CrashContext {
  workspaceRoot: string;
  filePath: string;
  operation: ReturnType<
    typeof createControlledWriteOperation
  >;
}

async function createContext(
  t: TestContext
): Promise<CrashContext> {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "taskseal-operation-crash-")
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
    ),
    operation: createControlledWriteOperation({
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
    })
  };
}

function openJournal(
  context: CrashContext
): Promise<ProviderOperationJournal> {
  return ProviderOperationJournal.open({
    storage: new FileProviderOperationJournalStorage({
      workspaceRoot: context.workspaceRoot
    })
  });
}

function runCrashChild(
  context: CrashContext,
  stage: "after-temporary-sync" | "after-rename"
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}> {
  const encodedOperation = Buffer.from(
    JSON.stringify(context.operation),
    "utf8"
  ).toString("base64url");

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        CHILD_PATH,
        context.workspaceRoot,
        stage,
        encodedOperation
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true
      }
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stderr });
    });
  });
}
