import {
  lstat,
  mkdir,
  open,
  realpath,
  rename
} from "node:fs/promises";
import type {
  FileHandle
} from "node:fs/promises";
import type { Stats } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve
} from "node:path";

import {
  normalizeProviderObservationFile,
  ProviderObservationError
} from "../application/provider-observation.ts";
import type {
  ProviderObservationFile,
  ProviderObservationStoragePort
} from "../application/provider-observation.ts";

export const PROVIDER_OBSERVATION_FILE_BYTE_LIMIT =
  256 * 1024;

export type ProviderObservationFailureStage =
  | "after-read-stat"
  | "before-read-open"
  | "before-temporary-open"
  | "after-temporary-sync"
  | "after-rename";

interface FileProviderObservationStorageOptions {
  workspaceRoot: string;
  filePath: string;
  failureInjector?:
    | ((
        stage: ProviderObservationFailureStage
      ) => unknown | Promise<unknown>)
    | undefined;
}

export class FileProviderObservationStorage
  implements ProviderObservationStoragePort
{
  readonly #workspaceRoot: string;
  readonly #filePath: string;
  readonly #failureInjector:
    | FileProviderObservationStorageOptions["failureInjector"];

  constructor({
    workspaceRoot,
    filePath,
    failureInjector
  }: FileProviderObservationStorageOptions) {
    if (
      typeof workspaceRoot !== "string" ||
      workspaceRoot.trim().length === 0 ||
      typeof filePath !== "string" ||
      filePath.trim().length === 0
    ) {
      throw new TypeError(
        "Provider observation storage requires a file path."
      );
    }

    const normalizedRoot = resolve(workspaceRoot);
    const normalizedFile = resolve(filePath);
    const directoryRelative = relative(
      normalizedRoot,
      dirname(normalizedFile)
    );
    if (
      directoryRelative.length === 0 ||
      directoryRelative.startsWith("..") ||
      isAbsolute(directoryRelative) ||
      directoryRelative.includes("/") ||
      directoryRelative.includes("\\")
    ) {
      throw new TypeError(
        "Provider observation storage file must be in one workspace state directory."
      );
    }

    this.#workspaceRoot = normalizedRoot;
    this.#filePath = normalizedFile;
    this.#failureInjector = failureInjector;
  }

  async load(): Promise<unknown> {
    let handle: FileHandle | undefined;

    try {
      const directory = await this.openSafeDirectory(false);
      if (directory === null) {
        return emptyStore();
      }

      const target = await lstatIfPresent(this.#filePath);
      if (target === null) {
        return emptyStore();
      }
      if (!target.isFile() || target.isSymbolicLink()) {
        throw corruptStore();
      }

      await this.inject("before-read-open");
      handle = await open(this.#filePath, "r");
      const metadata = await handle.stat();

      if (
        !metadata.isFile() ||
        metadata.dev !== target.dev ||
        metadata.ino !== target.ino ||
        metadata.size >
          PROVIDER_OBSERVATION_FILE_BYTE_LIMIT
      ) {
        throw corruptStore();
      }
      await this.assertSameDirectory(directory);

      await this.inject("after-read-stat");
      const content = await readBoundedUtf8(handle);

      try {
        return JSON.parse(content);
      } catch {
        throw corruptStore();
      }
    } catch (error) {
      if (error instanceof ProviderObservationError) {
        throw error;
      }

      throw new ProviderObservationError(
        "PROVIDER_OBSERVATION_READ_FAILED",
        "Provider observations could not be read.",
        { cause: error }
      );
    } finally {
      await closeIgnoringErrors(handle);
    }
  }

  async replace(value: ProviderObservationFile): Promise<void> {
    const normalized =
      normalizeProviderObservationFile(value);
    const content = `${JSON.stringify(normalized)}\n`;

    if (
      Buffer.byteLength(content, "utf8") >
      PROVIDER_OBSERVATION_FILE_BYTE_LIMIT
    ) {
      throw new ProviderObservationError(
        "PROVIDER_OBSERVATION_LIMIT_EXCEEDED",
        "Provider observation file limit was exceeded."
      );
    }

    const directory = dirname(this.#filePath);
    const temporaryPath = join(
      directory,
      `.${basename(this.#filePath)}.tmp`
    );
    let handle: FileHandle | undefined;
    let renamed = false;

    try {
      const directoryIdentity =
        await this.openSafeDirectory(true);
      if (directoryIdentity === null) {
        throw new Error(
          "Provider observation state directory was not created."
        );
      }
      await this.inject("before-temporary-open");
      await this.assertSameDirectory(directoryIdentity);
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.inject("after-temporary-sync");
      await this.assertSameDirectory(directoryIdentity);
      const existingTarget =
        await lstatIfPresent(this.#filePath);
      if (
        existingTarget !== null &&
        (!existingTarget.isFile() ||
          existingTarget.isSymbolicLink())
      ) {
        throw new Error(
          "Provider observation target is not a regular file."
        );
      }
      await rename(temporaryPath, this.#filePath);
      renamed = true;
      await syncDirectoryBestEffort(directory);
      await this.inject("after-rename");
    } catch (error) {
      await closeIgnoringErrors(handle);
      handle = undefined;

      if (renamed) {
        throw new ProviderObservationError(
          "PROVIDER_OBSERVATION_COMMIT_OUTCOME_UNKNOWN",
          "Provider observation commit outcome is unknown.",
          { cause: error }
        );
      }

      if (error instanceof ProviderObservationError) {
        throw error;
      }

      throw new ProviderObservationError(
        "PROVIDER_OBSERVATION_WRITE_FAILED",
        "Provider observation could not be persisted.",
        { cause: error }
      );
    } finally {
      await closeIgnoringErrors(handle);
      // A failed write retains the single 0600 temporary slot.
      // Path-based cleanup could follow a state-directory swap.
    }
  }

  private async inject(
    stage: ProviderObservationFailureStage
  ): Promise<void> {
    await this.#failureInjector?.(stage);
  }

  private async openSafeDirectory(
    create: boolean
  ): Promise<DirectoryIdentity | null> {
    const directory = dirname(this.#filePath);
    const canonicalRoot = await realpath(
      this.#workspaceRoot
    );

    if (create) {
      try {
        await mkdir(directory);
      } catch (error) {
        if (!hasNodeErrorCode(error, "EEXIST")) {
          throw error;
        }
      }
    }

    const metadata = await lstatIfPresent(directory);
    if (metadata === null) {
      return null;
    }
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink()
    ) {
      throw new Error(
        "Provider observation state directory is redirected."
      );
    }

    const canonicalDirectory = await realpath(directory);
    if (
      !isStrictDescendant(
        canonicalRoot,
        canonicalDirectory
      )
    ) {
      throw new Error(
        "Provider observation state directory escapes the workspace."
      );
    }

    return {
      canonicalPath: canonicalDirectory,
      device: metadata.dev,
      inode: metadata.ino
    };
  }

  private async assertSameDirectory(
    expected: DirectoryIdentity
  ): Promise<void> {
    const directory = dirname(this.#filePath);
    const metadata = await lstat(directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.dev !== expected.device ||
      metadata.ino !== expected.inode ||
      (await realpath(directory)) !== expected.canonicalPath
    ) {
      throw new Error(
        "Provider observation state directory changed during write."
      );
    }
  }
}

interface DirectoryIdentity {
  canonicalPath: string;
  device: number;
  inode: number;
}

function emptyStore(): ProviderObservationFile {
  return {
    schemaVersion: 1,
    observations: []
  };
}

async function readBoundedUtf8(
  handle: FileHandle
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  while (
    total <= PROVIDER_OBSERVATION_FILE_BYTE_LIMIT
  ) {
    const remaining =
      PROVIDER_OBSERVATION_FILE_BYTE_LIMIT + 1 - total;
    const buffer = Buffer.allocUnsafe(
      Math.min(64 * 1024, remaining)
    );
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.length,
      total
    );
    if (bytesRead === 0) {
      break;
    }
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }

  if (total > PROVIDER_OBSERVATION_FILE_BYTE_LIMIT) {
    throw corruptStore();
  }

  return Buffer.concat(chunks, total).toString("utf8");
}

async function lstatIfPresent(
  path: string
): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

function isStrictDescendant(
  parent: string,
  candidate: string
): boolean {
  const value = relative(parent, candidate);
  return (
    value.length > 0 &&
    !value.startsWith("..") &&
    !isAbsolute(value)
  );
}

function corruptStore(): ProviderObservationError {
  return new ProviderObservationError(
    "PROVIDER_OBSERVATION_STORE_CORRUPT",
    "Provider observation storage is corrupt."
  );
}

async function syncDirectoryBestEffort(
  directory: string
): Promise<void> {
  let handle: FileHandle | undefined;

  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Some platforms do not support syncing directory handles.
  } finally {
    await closeIgnoringErrors(handle);
  }
}

async function closeIgnoringErrors(
  handle: FileHandle | undefined
): Promise<void> {
  if (!handle) {
    return;
  }

  try {
    await handle.close();
  } catch {
    // The primary read or write error remains authoritative.
  }
}

function hasNodeErrorCode(
  error: unknown,
  code: string
): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}
