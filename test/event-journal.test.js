import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  appendFile,
  mkdtemp,
  open,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { FileEventJournal } from "../src/storage/event-journal.js";

const READ_CHILD_PATH = fileURLToPath(
  new URL(
    "../test-support/journal-read-child.js",
    import.meta.url
  )
);

test("file journal appends canonical events and reads them back in order", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const journal = new FileEventJournal({
    filePath: join(directory, "events.jsonl")
  });
  const events = [createWorkItemEvent(), createAttemptEvent()];

  await journal.append(events[0]);
  await journal.append(events[1]);

  assert.deepEqual(await journal.readAll(), events);
});

test("file journal reports the corrupt line instead of ignoring it", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const filePath = join(directory, "events.jsonl");
  const journal = new FileEventJournal({ filePath });

  await journal.append(createWorkItemEvent());
  await appendFile(filePath, "{not-json}\n", "utf8");

  await assert.rejects(
    journal.readAll(),
    (error) =>
      error.code === "JOURNAL_CORRUPT" &&
      error.message.includes("line 2")
  );
});

test("file journal rejects oversized import batches before JSON parsing", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const filePath = join(directory, "events.jsonl");
  const journal = new FileEventJournal({ filePath });
  const oversizedMalformedRecord =
    `{"recordType":"import.batch","padding":"${"x".repeat(
      3 * 1024 * 1024
    )}`;
  await writeFile(
    filePath,
    oversizedMalformedRecord,
    "utf8"
  );

  await assert.rejects(
    journal.readAll(),
    (error) =>
      error.code === "JOURNAL_CORRUPT" &&
      error.message.includes("byte limit")
  );
});

test("import batch byte limits treat CRLF as a line terminator", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const exactPath = join(directory, "exact.jsonl");
  const oversizedPath = join(
    directory,
    "oversized.jsonl"
  );
  const byteLimit = 3 * 1024 * 1024;
  const prefix =
    '{"recordType":"import.batch","padding":"';
  const suffix = '"}';
  const paddingLength =
    byteLimit -
    Buffer.byteLength(`${prefix}${suffix}`, "utf8");
  const exact = `${prefix}${"x".repeat(
    paddingLength
  )}${suffix}`;
  const oversized = `${prefix}${"x".repeat(
    paddingLength + 1
  )}${suffix}`;
  await writeFile(exactPath, `${exact}\r\n`, "utf8");
  await writeFile(
    oversizedPath,
    `${oversized}\r\n`,
    "utf8"
  );

  assert.equal(
    (
      await new FileEventJournal({
        filePath: exactPath
      }).readAll()
    ).length,
    1
  );
  await assert.rejects(
    new FileEventJournal({
      filePath: oversizedPath
    }).readAll(),
    (error) =>
      error.code === "JOURNAL_CORRUPT" &&
      error.message.includes("byte limit")
  );
});

test("file journal keeps oversized legacy bare events replayable", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const filePath = join(directory, "events.jsonl");
  const journal = new FileEventJournal({ filePath });
  const event = createWorkItemEvent();
  event.payload.title = "x".repeat(
    3 * 1024 * 1024
  );
  await writeFile(
    filePath,
    `${JSON.stringify(event)}\n`,
    "utf8"
  );

  const records = await journal.readAll();

  assert.equal(records.length, 1);
  assert.equal(
    records[0].payload.title.length,
    event.payload.title.length
  );

  const appendPath = join(
    directory,
    "new-events.jsonl"
  );
  const appendJournal = new FileEventJournal({
    filePath: appendPath
  });
  await appendJournal.append(event);
  assert.equal(
    (await appendJournal.readAll())[0].payload.title
      .length,
    event.payload.title.length
  );
});

test("legacy bare event lines have an explicit compatibility limit", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const exactPath = join(directory, "exact-legacy.jsonl");
  const oversizedPath = join(
    directory,
    "oversized-legacy.jsonl"
  );
  const appendPath = join(
    directory,
    "appended-exact-legacy.jsonl"
  );
  const rejectedPath = join(
    directory,
    "rejected-oversized-legacy.jsonl"
  );
  const reservedPath = join(
    directory,
    "rejected-reserved-record.jsonl"
  );
  const byteLimit = 4 * 1024 * 1024;
  const event = {
    ...createWorkItemEvent(),
    legacyPadding: ""
  };
  const emptyRecord = JSON.stringify(event);
  const paddingLength =
    byteLimit -
    Buffer.byteLength(emptyRecord, "utf8");
  event.legacyPadding = "x".repeat(paddingLength);
  const exactRecord = JSON.stringify(event);

  assert.equal(
    Buffer.byteLength(exactRecord, "utf8"),
    byteLimit
  );
  await writeFile(exactPath, exactRecord, "utf8");
  await writeFile(
    oversizedPath,
    `${exactRecord.slice(0, -2)}x"}`,
    "utf8"
  );

  assert.equal(
    (
      await new FileEventJournal({
        filePath: exactPath
      }).readAll()
    ).length,
    1
  );
  await assert.rejects(
    new FileEventJournal({
      filePath: oversizedPath
    }).readAll(),
    (error) =>
      error.code === "JOURNAL_CORRUPT" &&
      error.message.includes(
        "journal record byte limit"
      )
  );

  const appendJournal = new FileEventJournal({
    filePath: appendPath
  });
  await appendJournal.append(event);
  assert.equal(
    (await appendJournal.readAll())[0]
      .legacyPadding.length,
    event.legacyPadding.length
  );

  const rejectedJournal = new FileEventJournal({
    filePath: rejectedPath
  });
  await assert.rejects(
    rejectedJournal.append({
      ...event,
      legacyPadding: `${event.legacyPadding}x`
    }),
    (error) =>
      error.code === "JOURNAL_WRITE_FAILED"
  );
  await assert.rejects(
    stat(rejectedPath),
    (error) => error.code === "ENOENT"
  );

  const reservedJournal = new FileEventJournal({
    filePath: reservedPath
  });
  await assert.rejects(
    reservedJournal.append({
      ...createWorkItemEvent(),
      recordType: "import.batch"
    }),
    (error) =>
      error.code === "JOURNAL_WRITE_FAILED"
  );
  await assert.rejects(
    stat(reservedPath),
    (error) => error.code === "ENOENT"
  );
});

test("oversized unrecognized records fail under a heap smaller than the journal line", async (t) => {
  const directory = await createTemporaryDirectory(t);

  for (const [name, prefix] of [
    [
      "batch",
      '{"recordType":"import.batch","padding":"'
    ],
    ["unclassified", '{"padding":"']
  ]) {
    const filePath = join(
      directory,
      `${name}.jsonl`
    );
    const handle = await open(filePath, "w");
    await handle.writeFile(prefix, "utf8");
    await handle.truncate(64 * 1024 * 1024);
    await handle.close();

    const result = await runReadChild(filePath);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      "JOURNAL_CORRUPT"
    );
    assert.doesNotMatch(
      result.stderr,
      /heap out of memory/i
    );
  }

  const oversizedCases = [
    {
      name: "disguised-event",
      prefix:
        '{"eventId":"","workItemId":"","type":"not.real","occurredAt":"bad","payload":{"padding":"',
      suffix: '"}}'
    },
    {
      name: "invalid-overflow-escape",
      prefix: '{"payload":{"padding":"',
      suffix:
        `"},"eventId":"${"a".repeat(
          513
        )}\\u12","workItemId":"TS-1","type":"work_item.created","occurredAt":"2026-07-26T08:00:00.000Z"}`
    },
    {
      name: "double-colon",
      prefix: '{"payload":{"padding":"',
      suffix:
        '"},"eventId"::"e","workItemId":"TS-1","type":"work_item.created","occurredAt":"2026-07-26T08:00:00.000Z"}'
    },
    {
      name: "canonical-invalid-payload",
      prefix: '{"payload":{"padding":"',
      suffix:
        '"},"eventId":"e","workItemId":"TS-1","type":"work_item.created","occurredAt":"2026-07-26T08:00:00.000Z"}'
    },
    {
      name: "valid-legacy-event",
      prefix:
        '{"eventId":"e","workItemId":"TS-1","type":"work_item.created","occurredAt":"2026-07-26T08:00:00.000Z","payload":{"title":"',
      suffix:
        '","requiredEvidence":["tests"],"externalLink":{"provider":"taskseal","externalId":"TS-1","url":"http://127.0.0.1/work-items/TS-1"}}}'
    }
  ];

  for (const testCase of oversizedCases) {
    const filePath = join(
      directory,
      `${testCase.name}.jsonl`
    );
    await writeOversizedRecord(
      filePath,
      testCase.prefix,
      testCase.suffix
    );
    const result = await runReadChild(filePath);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      "JOURNAL_CORRUPT"
    );
    assert.doesNotMatch(
      result.stderr,
      /heap out of memory/i
    );
  }
});

async function createTemporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "taskseal-journal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function createWorkItemEvent() {
  return {
    eventId: "local:TS-1:created",
    workItemId: "TS-1",
    type: "work_item.created",
    occurredAt: "2026-07-26T08:00:00.000Z",
    payload: {
      title: "Run a real Codex turn",
      requiredEvidence: ["tests"],
      externalLink: {
        provider: "taskseal",
        externalId: "TS-1",
        url: "http://127.0.0.1/work-items/TS-1"
      }
    }
  };
}

function createAttemptEvent() {
  return {
    eventId: "codex:run-1:started",
    workItemId: "TS-1",
    type: "attempt.started",
    occurredAt: "2026-07-26T08:01:00.000Z",
    payload: {
      attemptId: "run-1",
      agentId: "codex"
    }
  };
}

async function writeOversizedRecord(
  filePath,
  prefix,
  suffix
) {
  const handle = await open(filePath, "w");

  try {
    await handle.writeFile(prefix, "utf8");
    const chunk = "x".repeat(1024 * 1024);

    for (let index = 0; index < 5; index += 1) {
      await handle.writeFile(chunk, "utf8");
    }

    await handle.writeFile(suffix, "utf8");
  } finally {
    await handle.close();
  }
}

function runReadChild(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--max-old-space-size=24",
        READ_CHILD_PATH,
        filePath
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        code,
        signal,
        stdout,
        stderr
      });
    });
  });
}
