import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, {
  type TestContext
} from "node:test";

import {
  acquireControlRoomLock
} from "../src/application/control-room-lock.ts";

test("control room lock rejects a second writer and releases only its own lock", async (t) => {
  const cwd =
    await createTemporaryDirectory(t);
  const first =
    await acquireControlRoomLock({
      cwd,
      processId: 101,
      nonce:
        "11111111-1111-4111-8111-111111111111",
      now: () =>
        new Date(
          "2026-07-30T10:00:00.000Z"
        )
    });

  await assert.rejects(
    acquireControlRoomLock({
      cwd,
      processId: 202
    }),
    hasCode(
      "CONTROL_ROOM_ALREADY_RUNNING"
    )
  );
  const contents = await readFile(
    first.filePath,
    "utf8"
  );
  assert.doesNotMatch(
    contents,
    new RegExp(escapeRegExp(cwd))
  );

  await first.release();
  await assert.rejects(
    access(first.filePath)
  );

  const replacement =
    await acquireControlRoomLock({
      cwd,
      processId: 303
    });
  await replacement.release();
  await replacement.release();
});

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}

function escapeRegExp(
  value: string
): string {
  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

async function createTemporaryDirectory(
  t: TestContext
): Promise<string> {
  const directory =
    await mkdtemp(
      join(
        tmpdir(),
        "taskseal-lock-"
      )
    );
  t.after(() =>
    rm(directory, {
      recursive: true,
      force: true
    })
  );
  return directory;
}
