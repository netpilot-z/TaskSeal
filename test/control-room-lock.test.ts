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
  acquireControlRoomLock,
  readControlRoomInstance
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
        ),
      endpoint: {
        host: "127.0.0.1",
        port: 7331
      }
    });

  await assert.rejects(
    acquireControlRoomLock({
      cwd,
      processId: 202,
      isProcessRunning: (processId) => {
        assert.equal(processId, 101);
        return true;
      }
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

test("control room lock reclaims a valid lock whose owner process is gone", async (t) => {
  const cwd =
    await createTemporaryDirectory(t);
  await acquireControlRoomLock({
    cwd,
    processId: 101,
    nonce:
      "11111111-1111-4111-8111-111111111111",
    now: () =>
      new Date(
        "2026-08-03T12:00:00.000Z"
      ),
    endpoint: {
      host: "127.0.0.1",
      port: 7331
    }
  });

  const replacement =
    await acquireControlRoomLock({
      cwd,
      processId: 202,
      nonce:
        "22222222-2222-4222-8222-222222222222",
      now: () =>
        new Date(
          "2026-08-05T12:00:00.000Z"
        ),
      endpoint: {
        host: "127.0.0.1",
        port: 7331
      },
      isProcessRunning: () => false
    });

  assert.equal(
    replacement.instanceId,
    "22222222-2222-4222-8222-222222222222"
  );
  assert.deepEqual(
    await readControlRoomInstance({ cwd }),
    {
      schemaVersion:
        "control-room-instance/v1",
      instanceId:
        "22222222-2222-4222-8222-222222222222",
      processId: 202,
      acquiredAt:
        "2026-08-05T12:00:00.000Z",
      host: "127.0.0.1",
      port: 7331
    }
  );
  await replacement.release();
});

test("control room lock publishes a bounded loopback instance identity for handoff", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const lock = await acquireControlRoomLock({
    cwd,
    processId: 404,
    nonce: "44444444-4444-4444-8444-444444444444",
    endpoint: {
      host: "127.0.0.1",
      port: 7331
    },
    now: () => new Date("2026-08-03T12:00:00.000Z")
  });

  assert.deepEqual(await readControlRoomInstance({ cwd }), {
    schemaVersion: "control-room-instance/v1",
    instanceId: "44444444-4444-4444-8444-444444444444",
    processId: 404,
    acquiredAt: "2026-08-03T12:00:00.000Z",
    host: "127.0.0.1",
    port: 7331
  });
  assert.equal(lock.instanceId, "44444444-4444-4444-8444-444444444444");

  await lock.release();
  assert.equal(await readControlRoomInstance({ cwd }), null);
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
