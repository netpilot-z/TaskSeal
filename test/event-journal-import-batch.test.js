import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("file journal atomically appends a complete import batch", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const filePath = join(directory, "events.jsonl");
  const journal = new FileEventJournal({ filePath });
  const event = createLegacyEvent();
  const record = createBatchRecord();

  await journal.append(event);
  await journal.commitBatch(record);

  assert.deepEqual(await journal.readAll(), [
    event,
    record
  ]);
  assert.equal(
    (await readFile(filePath, "utf8")).endsWith("\n"),
    true
  );
  assert.deepEqual(
    (await readdir(directory)).sort(),
    ["events.jsonl"]
  );
});

test("pre-commit batch failures leave the journal byte-identical", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const filePath = join(directory, "events.jsonl");
  const original = `${JSON.stringify(createLegacyEvent())}`;
  await writeFile(filePath, original, "utf8");
  const journal = new FileEventJournal({
    filePath,
    failureInjector(stage, operation) {
      if (
        operation === "batch" &&
        stage === "beforeReplace"
      ) {
        throw new Error("replace unavailable");
      }
    }
  });

  await assert.rejects(
    journal.commitBatch(createBatchRecord()),
    hasCode("JOURNAL_WRITE_FAILED")
  );

  assert.equal(await readFile(filePath, "utf8"), original);
  assert.deepEqual(await journal.readAll(), [
    createLegacyEvent()
  ]);
  assert.deepEqual(
    (await readdir(directory)).sort(),
    ["events.jsonl"]
  );
});

test("post-commit outcome unknown exposes only the complete batch to a reopened journal", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const filePath = join(directory, "events.jsonl");
  const record = createBatchRecord();
  const journal = new FileEventJournal({
    filePath,
    failureInjector(stage, operation) {
      if (
        operation === "batch" &&
        stage === "afterReplace"
      ) {
        throw new Error("response lost");
      }
    }
  });

  await assert.rejects(
    journal.commitBatch(record),
    hasCode("JOURNAL_COMMIT_OUTCOME_UNKNOWN")
  );

  const reopened = new FileEventJournal({ filePath });
  assert.deepEqual(await reopened.readAll(), [record]);
});

test("ordinary append remains available when atomic batch replace is unsupported", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const filePath = join(directory, "events.jsonl");
  const journal = new FileEventJournal({
    filePath,
    atomicReplaceProbe: async () => false
  });
  const event = createLegacyEvent();

  await journal.append(event);

  assert.deepEqual(await journal.readAll(), [event]);
});

test("ordinary append reports an unknown outcome after writing starts", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const filePath = join(directory, "events.jsonl");
  const journal = new FileEventJournal({
    filePath,
    failureInjector(stage, operation) {
      if (
        operation === "event" &&
        stage === "afterWrite"
      ) {
        throw new Error("response lost");
      }
    }
  });

  await assert.rejects(
    journal.append(createLegacyEvent()),
    hasCode("JOURNAL_COMMIT_OUTCOME_UNKNOWN")
  );
  assert.deepEqual(
    await new FileEventJournal({ filePath }).readAll(),
    [createLegacyEvent()]
  );
});

test("an unsupported atomic replace probe keeps the journal read-only", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const filePath = join(directory, "events.jsonl");
  const journal = new FileEventJournal({
    filePath,
    atomicReplaceProbe: async () => false
  });

  await assert.rejects(
    journal.commitBatch(createBatchRecord()),
    hasCode("JOURNAL_ATOMIC_COMMIT_UNSUPPORTED")
  );
  await assert.rejects(
    readFile(filePath, "utf8"),
    (error) => error.code === "ENOENT"
  );
});

test("journal configuration stays bound to its constructor path", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const configuredPath = join(directory, "events.jsonl");
  const reassignedPath = join(directory, "other.jsonl");
  const record = createBatchRecord();
  const journal = new FileEventJournal({
    filePath: configuredPath,
    atomicReplaceProbe: async () => true
  });

  journal.filePath = reassignedPath;
  await journal.commitBatch(record);

  assert.deepEqual(
    await new FileEventJournal({
      filePath: configuredPath
    }).readAll(),
    [record]
  );
  await assert.rejects(
    readFile(reassignedPath, "utf8"),
    (error) => error.code === "ENOENT"
  );
});

function createBatchRecord() {
  return createImportBatchRecord({
    plan: createPreviewPlan(),
    actor: createActor(),
    appliedAt: "2026-07-26T08:05:00.000Z"
  });
}

function createLegacyEvent() {
  return {
    eventId: "local:seed:created",
    workItemId: "seed",
    type: "work_item.created",
    occurredAt: "2026-07-26T07:00:00.000Z",
    payload: {
      title: "Seed journal",
      requiredEvidence: ["tests"],
      externalLink: {
        provider: "taskseal",
        externalId: "seed",
        url: "http://127.0.0.1/work-items/seed"
      }
    }
  };
}

async function createTemporaryDirectory(t) {
  const directory = await mkdtemp(
    join(tmpdir(), "taskseal-import-journal-")
  );
  t.after(() =>
    rm(directory, {
      recursive: true,
      force: true
    })
  );
  return directory;
}

function hasCode(code) {
  return (error) => error?.code === code;
}
