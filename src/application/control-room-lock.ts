import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  unlink
} from "node:fs/promises";
import { join } from "node:path";

export interface ControlRoomLock {
  readonly filePath: string;
  release(): Promise<void>;
}

export interface AcquireControlRoomLockOptions {
  readonly cwd: string;
  readonly processId?: number | undefined;
  readonly nonce?: string | undefined;
  readonly now?: (() => Date) | undefined;
}

export async function acquireControlRoomLock({
  cwd,
  processId = process.pid,
  nonce = randomUUID(),
  now = () => new Date()
}: AcquireControlRoomLockOptions): Promise<ControlRoomLock> {
  const owner = createOwnerRecord({
    processId,
    nonce,
    now
  });
  const stateDirectory = join(
    cwd,
    ".taskseal"
  );
  const filePath = join(
    stateDirectory,
    "control-room.lock"
  );
  await mkdir(stateDirectory, {
    recursive: true
  });

  let handle;
  try {
    handle = await open(
      filePath,
      "wx",
      0o600
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new ControlRoomLockError(
        "CONTROL_ROOM_ALREADY_RUNNING",
        "This TaskSeal workspace already has a Control Room lock. Confirm the existing process before removing a stale lock."
      );
    }
    throw error;
  }

  try {
    await handle.writeFile(owner, {
      encoding: "utf8"
    });
  } catch (error) {
    await handle.close().catch(
      () => undefined
    );
    await unlink(filePath).catch(
      () => undefined
    );
    throw error;
  }
  await handle.close();

  let release:
    Promise<void> | undefined;
  return Object.freeze({
    filePath,
    release() {
      release ??=
        releaseOwnedLock({
          filePath,
          owner
        });
      return release;
    }
  });
}

async function releaseOwnedLock({
  filePath,
  owner
}: {
  readonly filePath: string;
  readonly owner: string;
}): Promise<void> {
  let current: string;
  try {
    current = await readFile(
      filePath,
      "utf8"
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }

  if (current !== owner) {
    throw new ControlRoomLockError(
      "CONTROL_ROOM_LOCK_OWNERSHIP_LOST",
      "The Control Room lock changed ownership and was not removed."
    );
  }

  await unlink(filePath);
}

function createOwnerRecord({
  processId,
  nonce,
  now
}: {
  readonly processId: number;
  readonly nonce: string;
  readonly now: () => Date;
}): string {
  const acquiredAt = now();
  if (
    !Number.isSafeInteger(processId) ||
    processId < 1 ||
    typeof nonce !== "string" ||
    nonce.length < 1 ||
    nonce.length > 160 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(
      nonce
    ) ||
    !(acquiredAt instanceof Date) ||
    !Number.isFinite(
      acquiredAt.getTime()
    )
  ) {
    throw new TypeError(
      "Control Room lock owner metadata is invalid."
    );
  }

  return `${JSON.stringify({
    schemaVersion: 1,
    processId,
    acquiredAt:
      acquiredAt.toISOString(),
    nonce
  })}\n`;
}

export class ControlRoomLockError
  extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string
  ) {
    super(message);
    this.name =
      "ControlRoomLockError";
    this.code = code;
  }
}
