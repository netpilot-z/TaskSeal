import {
  lstatSync,
  realpathSync,
  renameSync
} from "node:fs";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath
} from "node:fs/promises";
import type {
  FileHandle
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve
} from "node:path";

import {
  normalizeProviderOperationJournalFile,
  PROVIDER_OPERATION_JOURNAL_BYTE_LIMIT,
  ProviderOperationJournalError
} from "../application/provider-operation-journal.ts";
import type {
  ProviderOperationJournalFile,
  ProviderOperationJournalStoragePort
} from "../application/provider-operation-journal.ts";

export type ProviderOperationJournalFailureStage =
  | "after-read-stat"
  | "before-read-open"
  | "before-temporary-open"
  | "after-temporary-sync"
  | "before-rename"
  | "after-rename-before-verify"
  | "after-rename";

interface FileProviderOperationJournalStorageOptions {
  workspaceRoot: string;
  failureInjector?:
    | ((stage: ProviderOperationJournalFailureStage) =>
        unknown | Promise<unknown>)
    | undefined;
}

export class FileProviderOperationJournalStorage
  implements ProviderOperationJournalStoragePort
{
  readonly #workspaceRoot: string;
  readonly #filePath: string;
  readonly #failureInjector:
    | FileProviderOperationJournalStorageOptions["failureInjector"];

  constructor({
    workspaceRoot,
    failureInjector
  }: FileProviderOperationJournalStorageOptions) {
    if (
      typeof workspaceRoot !== "string" ||
      workspaceRoot.trim().length === 0
    ) {
      throw new TypeError(
        "Provider operation journal storage requires a workspace root."
      );
    }

    const normalizedRoot = resolve(workspaceRoot);
    const normalizedFile = join(
      normalizedRoot,
      ".taskseal",
      "provider-operations.json"
    );

    this.#workspaceRoot = normalizedRoot;
    this.#filePath = normalizedFile;
    this.#failureInjector = failureInjector;
  }

  async load(): Promise<unknown> {
    let handle: FileHandle | undefined;

    try {
      const directory = await this.openSafeDirectory(false);
      if (directory === null) {
        return emptyJournal();
      }

      const target = await lstatIfPresent(this.#filePath);
      if (target === null) {
        return emptyJournal();
      }
      if (!target.isFile() || target.isSymbolicLink()) {
        throw corruptJournal();
      }

      await this.inject("before-read-open");
      handle = await open(this.#filePath, "r");
      const metadata = await handle.stat();

      if (
        !metadata.isFile() ||
        metadata.dev !== target.dev ||
        metadata.ino !== target.ino ||
        metadata.size >
          PROVIDER_OPERATION_JOURNAL_BYTE_LIMIT
      ) {
        throw corruptJournal();
      }
      await this.assertSameDirectory(directory);

      await this.inject("after-read-stat");
      const content = await readBoundedUtf8(handle);
      try {
        return JSON.parse(content);
      } catch {
        throw corruptJournal();
      }
    } catch (error) {
      if (error instanceof ProviderOperationJournalError) {
        throw error;
      }
      throw new ProviderOperationJournalError(
        "PROVIDER_OPERATION_JOURNAL_READ_FAILED",
        "Provider operation journal could not be read."
      );
    } finally {
      await closeIgnoringErrors(handle);
    }
  }

  async replace(
    value: ProviderOperationJournalFile
  ): Promise<void> {
    const normalized =
      normalizeProviderOperationJournalFile(value);
    const content = `${JSON.stringify(normalized)}\n`;

    if (
      Buffer.byteLength(content, "utf8") >
      PROVIDER_OPERATION_JOURNAL_BYTE_LIMIT
    ) {
      throw new ProviderOperationJournalError(
        "PROVIDER_OPERATION_JOURNAL_LIMIT_EXCEEDED",
        "Provider operation journal limit was exceeded."
      );
    }

    const directory = dirname(this.#filePath);
    const temporaryPath = join(
      directory,
      `.${basename(this.#filePath)}.tmp`
    );
    let handle: FileHandle | undefined;
    let renamed = false;
    let temporaryIdentity: FileIdentity | undefined;

    try {
      const directoryIdentity =
        await this.openSafeDirectory(true);
      if (directoryIdentity === null) {
        throw new Error(
          "Provider operation journal directory was not created."
        );
      }
      await this.inject("before-temporary-open");
      await this.assertSameDirectory(directoryIdentity);
      handle = await this.openTemporary(
        directoryIdentity,
        temporaryPath
      );
      await handle.writeFile(content, "utf8");
      await handle.sync();
      const temporaryMetadata = await handle.stat({
        bigint: true
      });
      if (
        !temporaryMetadata.isFile() ||
        temporaryMetadata.nlink !== 1n
      ) {
        throw new Error(
          "Provider operation journal temporary file is invalid."
        );
      }
      temporaryIdentity = {
        device: temporaryMetadata.dev,
        inode: temporaryMetadata.ino
      };
      await handle.close();
      handle = undefined;
      await this.inject("after-temporary-sync");
      await this.inject("before-rename");
      this.assertSameDirectorySync(directoryIdentity);
      assertFileIdentitySync(
        temporaryPath,
        temporaryIdentity
      );
      assertReplaceableTargetSync(this.#filePath);
      this.assertSameDirectorySync(directoryIdentity);
      renameSync(temporaryPath, this.#filePath);
      renamed = true;
      if (this.#failureInjector !== undefined) {
        await this.inject("after-rename-before-verify");
      }
      await this.assertSameDirectory(directoryIdentity);
      await this.assertTargetIdentity(
        directoryIdentity,
        temporaryIdentity
      );
      await syncDirectoryBestEffort(directory);
      await this.inject("after-rename");
    } catch (error) {
      await closeIgnoringErrors(handle);
      handle = undefined;

      if (renamed) {
        throw new ProviderOperationJournalError(
          "PROVIDER_OPERATION_JOURNAL_COMMIT_OUTCOME_UNKNOWN",
          "Provider operation journal commit outcome is unknown."
        );
      }
      if (error instanceof ProviderOperationJournalError) {
        throw error;
      }
      throw new ProviderOperationJournalError(
        "PROVIDER_OPERATION_JOURNAL_WRITE_FAILED",
        "Provider operation journal could not be persisted."
      );
    } finally {
      await closeIgnoringErrors(handle);
      // A failed write keeps one bounded 0600 temporary slot.
      // Path cleanup could follow a swapped state directory.
    }
  }

  private async inject(
    stage: ProviderOperationJournalFailureStage
  ): Promise<void> {
    await this.#failureInjector?.(stage);
  }

  private async openTemporary(
    directory: DirectoryIdentity,
    temporaryPath: string
  ): Promise<FileHandle> {
    let handle: FileHandle | undefined;

    try {
      try {
        handle = await open(temporaryPath, "wx", 0o600);
        await this.assertSameDirectory(directory);
        return handle;
      } catch (error) {
        await closeIgnoringErrors(handle);
        handle = undefined;
        if (!hasNodeErrorCode(error, "EEXIST")) {
          throw error;
        }
      }

      const existing =
        readSingleLinkFileIdentitySync(temporaryPath);
      handle = await open(temporaryPath, "r+");
      const metadata = await handle.stat({
        bigint: true
      });
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1n ||
        metadata.dev !== existing.device ||
        metadata.ino !== existing.inode
      ) {
        throw new Error(
          "Provider operation journal temporary identity changed."
        );
      }
      await this.assertSameDirectory(directory);
      await handle.chmod(0o600);
      await handle.truncate(0);
      return handle;
    } catch (error) {
      await closeIgnoringErrors(handle);
      throw error;
    }
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
        "Provider operation journal directory is redirected."
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
        "Provider operation journal directory escapes the workspace."
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
        "Provider operation journal directory changed."
      );
    }
  }

  private assertSameDirectorySync(
    expected: DirectoryIdentity
  ): void {
    const directory = dirname(this.#filePath);
    const metadata = lstatSync(directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.dev !== expected.device ||
      metadata.ino !== expected.inode ||
      realpathSync(directory) !== expected.canonicalPath
    ) {
      throw new Error(
        "Provider operation journal directory changed."
      );
    }
  }

  private async assertTargetIdentity(
    directory: DirectoryIdentity,
    expected: FileIdentity
  ): Promise<void> {
    const target = lstatSync(this.#filePath, {
      bigint: true
    });
    if (
      !target.isFile() ||
      target.isSymbolicLink() ||
      target.nlink !== 1n ||
      target.dev !== expected.device ||
      target.ino !== expected.inode
    ) {
      throw new Error(
        "Provider operation journal target identity changed."
      );
    }

    let handle: FileHandle | undefined;
    try {
      handle = await open(this.#filePath, "r");
      const metadata = await handle.stat({
        bigint: true
      });
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1n ||
        metadata.dev !== expected.device ||
        metadata.ino !== expected.inode
      ) {
        throw new Error(
          "Provider operation journal target identity changed."
        );
      }
      await this.assertSameDirectory(directory);
    } finally {
      await closeIgnoringErrors(handle);
    }
  }
}

interface DirectoryIdentity {
  canonicalPath: string;
  device: number;
  inode: number;
}

interface FileIdentity {
  device: bigint;
  inode: bigint;
}

function emptyJournal(): ProviderOperationJournalFile {
  return {
    schemaVersion: 1,
    records: []
  };
}

async function readBoundedUtf8(
  handle: FileHandle
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  while (total <= PROVIDER_OPERATION_JOURNAL_BYTE_LIMIT) {
    const remaining =
      PROVIDER_OPERATION_JOURNAL_BYTE_LIMIT + 1 - total;
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

  if (total > PROVIDER_OPERATION_JOURNAL_BYTE_LIMIT) {
    throw corruptJournal();
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

function corruptJournal(): ProviderOperationJournalError {
  return new ProviderOperationJournalError(
    "PROVIDER_OPERATION_JOURNAL_STORE_CORRUPT",
    "Provider operation journal storage is corrupt."
  );
}

function assertFileIdentitySync(
  path: string,
  expected: FileIdentity
): void {
  const metadata = readSingleLinkFileIdentitySync(path);
  if (
    metadata.device !== expected.device ||
    metadata.inode !== expected.inode
  ) {
    throw new Error(
      "Provider operation journal temporary identity changed."
    );
  }
}

function readSingleLinkFileIdentitySync(
  path: string
): FileIdentity {
  const metadata = lstatSync(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n
  ) {
    throw new Error(
      "Provider operation journal temporary file is invalid."
    );
  }
  return {
    device: metadata.dev,
    inode: metadata.ino
  };
}

function assertReplaceableTargetSync(path: string): void {
  try {
    const target = lstatSync(path);
    if (!target.isFile() || target.isSymbolicLink()) {
      throw new Error(
        "Provider operation journal target is not a regular file."
      );
    }
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}

async function syncDirectoryBestEffort(
  directory: string
): Promise<void> {
  let handle: FileHandle | undefined;

  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Some platforms do not support directory handle sync.
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
