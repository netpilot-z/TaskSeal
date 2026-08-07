import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  unlink
} from "node:fs/promises";
import { join } from "node:path";

export interface ControlRoomLock {
  readonly filePath: string;
  readonly instanceId?: string | undefined;
  release(): Promise<void>;
}

export interface ControlRoomInstance {
  readonly schemaVersion: "control-room-instance/v1";
  readonly instanceId: string;
  readonly processId: number;
  readonly acquiredAt: string;
  readonly host: "127.0.0.1" | "localhost" | "::1";
  readonly port: number;
}

export interface AcquireControlRoomLockOptions {
  readonly cwd: string;
  readonly processId?: number | undefined;
  readonly nonce?: string | undefined;
  readonly now?: (() => Date) | undefined;
  readonly isProcessRunning?: ((processId: number) => boolean) | undefined;
  readonly endpoint?: {
    readonly host: string;
    readonly port: number;
  } | undefined;
}

export async function acquireControlRoomLock({
  cwd,
  processId = process.pid,
  nonce = randomUUID(),
  now = () => new Date(),
  isProcessRunning = isRunningProcess,
  endpoint
}: AcquireControlRoomLockOptions): Promise<ControlRoomLock> {
  const owner = createOwnerRecord({
    processId,
    nonce,
    now,
    endpoint
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
  await assertSafeStateDirectory(stateDirectory);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(
        filePath,
        "wx",
        0o600
      );
      break;
    } catch (error) {
      if (
        !hasErrorCode(error, "EEXIST")
      ) {
        throw error;
      }
      if (
        attempt === 0 &&
        await reclaimStaleLock({
          cwd,
          filePath,
          isProcessRunning
        })
      ) {
        continue;
      }
      throw alreadyRunning();
    }
  }
  if (handle === undefined) {
    throw alreadyRunning();
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
    ...(endpoint === undefined
      ? {}
      : { instanceId: nonce }),
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

async function reclaimStaleLock({
  cwd,
  filePath,
  isProcessRunning
}: {
  readonly cwd: string;
  readonly filePath: string;
  readonly isProcessRunning: (processId: number) => boolean;
}): Promise<boolean> {
  try {
    const before = await readFile(filePath, "utf8");
    const instance = await readControlRoomInstance({ cwd });
    if (
      instance === null ||
      isProcessRunning(instance.processId) ||
      await readFile(filePath, "utf8") !== before
    ) {
      return false;
    }
    await unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

function isRunningProcess(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
}

function alreadyRunning(): ControlRoomLockError {
  return new ControlRoomLockError(
    "CONTROL_ROOM_ALREADY_RUNNING",
    "This TaskSeal workspace already has a Control Room lock. Confirm the existing process before removing a stale lock."
  );
}

export async function readControlRoomInstance({
  cwd
}: {
  readonly cwd: string;
}): Promise<ControlRoomInstance | null> {
  const stateDirectory = join(cwd, ".taskseal");
  const filePath = join(stateDirectory, "control-room.lock");
  try {
    await assertSafeStateDirectory(stateDirectory);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }
    throw unavailableInstance();
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }
    throw unavailableInstance();
  }

  try {
    const [opened, current] = await Promise.all([
      handle.stat(),
      lstat(filePath)
    ]);
    if (
      !opened.isFile() ||
      opened.size > 4096 ||
      opened.nlink !== 1 ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino
    ) {
      throw new TypeError("Unsafe Control Room instance record.");
    }
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        "schemaVersion",
        "processId",
        "acquiredAt",
        "nonce",
        "endpoint"
      ]) ||
      value.schemaVersion !== 2 ||
      !Number.isSafeInteger(value.processId) ||
      Number(value.processId) < 1 ||
      !isSafeNonce(value.nonce) ||
      typeof value.acquiredAt !== "string" ||
      !isCanonicalTimestamp(value.acquiredAt) ||
      !isRecord(value.endpoint) ||
      !hasExactKeys(value.endpoint, ["host", "port"]) ||
      !isLoopbackHost(value.endpoint.host) ||
      !isUsablePort(value.endpoint.port)
    ) {
      throw new TypeError("Invalid Control Room instance record.");
    }
    return Object.freeze({
      schemaVersion: "control-room-instance/v1",
      instanceId: value.nonce,
      processId: Number(value.processId),
      acquiredAt: value.acquiredAt,
      host: value.endpoint.host,
      port: value.endpoint.port
    });
  } catch {
    throw unavailableInstance();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function assertSafeStateDirectory(directory: string): Promise<void> {
  const status = await lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new ControlRoomLockError(
      "CONTROL_ROOM_LOCK_UNSAFE",
      "The Control Room state directory is not safe."
    );
  }
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
  now,
  endpoint
}: {
  readonly processId: number;
  readonly nonce: string;
  readonly now: () => Date;
  readonly endpoint?: {
    readonly host: string;
    readonly port: number;
  } | undefined;
}): string {
  const acquiredAt = now();
  if (
    !Number.isSafeInteger(processId) ||
    processId < 1 ||
    !isSafeNonce(nonce) ||
    !(acquiredAt instanceof Date) ||
    !Number.isFinite(
      acquiredAt.getTime()
    )
  ) {
    throw new TypeError(
      "Control Room lock owner metadata is invalid."
    );
  }

  if (
    endpoint !== undefined &&
    (!isLoopbackHost(endpoint.host) || !isUsablePort(endpoint.port))
  ) {
    throw new TypeError(
      "Control Room lock endpoint metadata is invalid."
    );
  }

  return `${JSON.stringify({
    schemaVersion: endpoint === undefined ? 1 : 2,
    processId,
    acquiredAt:
      acquiredAt.toISOString(),
    nonce,
    ...(endpoint === undefined ? {} : { endpoint })
  })}\n`;
}

function isSafeNonce(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 160 &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function isLoopbackHost(
  value: unknown
): value is ControlRoomInstance["host"] {
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function isUsablePort(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65_535;
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    keys.every((key) => expected.includes(key));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function unavailableInstance(): ControlRoomLockError {
  return new ControlRoomLockError(
    "CONTROL_ROOM_HANDOFF_UNAVAILABLE",
    "The running Control Room instance could not be verified."
  );
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
