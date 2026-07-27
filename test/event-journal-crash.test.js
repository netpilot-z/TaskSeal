import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createImportBatchRecord
} from "../src/application/import-batch.js";
import {
  FileEventJournal
} from "../src/storage/event-journal.js";
import {
  createActor,
  createPreviewPlan
} from "../test-support/snapshot-import-fixtures.js";

const CHILD_PATH = fileURLToPath(
  new URL(
    "../test-support/atomic-journal-crash-child.js",
    import.meta.url
  )
);

test("process exit before replace preserves the old journal", async (t) => {
  const context = await createContext(t);

  const exit = await runCrashChild(
    context.filePath,
    "beforeReplace",
    context.record
  );

  assert.equal(exit.code, 91, exit.stderr);
  assert.equal(await readFile(context.filePath, "utf8"), "");
  assert.deepEqual(
    await new FileEventJournal({
      filePath: context.filePath
    }).readAll(),
    []
  );
});

test("process exit after replace exposes one complete batch", async (t) => {
  const context = await createContext(t);

  const exit = await runCrashChild(
    context.filePath,
    "afterReplace",
    context.record
  );

  assert.equal(exit.code, 91, exit.stderr);
  assert.deepEqual(
    await new FileEventJournal({
      filePath: context.filePath
    }).readAll(),
    [context.record]
  );
});

async function createContext(t) {
  const directory = await mkdtemp(
    join(tmpdir(), "taskseal-journal-crash-")
  );
  t.after(() =>
    rm(directory, {
      recursive: true,
      force: true
    })
  );
  const filePath = join(directory, "events.jsonl");
  await writeFile(filePath, "", "utf8");

  return {
    filePath,
    record: createImportBatchRecord({
      plan: createPreviewPlan(),
      actor: createActor(),
      appliedAt: "2026-07-26T08:05:00.000Z"
    })
  };
}

function runCrashChild(
  filePath,
  stage,
  record
) {
  const encodedRecord = Buffer.from(
    JSON.stringify(record),
    "utf8"
  ).toString("base64url");

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        CHILD_PATH,
        filePath,
        stage,
        encodedRecord
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
