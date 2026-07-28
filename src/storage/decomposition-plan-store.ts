import {
  lstatSync,
  realpathSync,
  renameSync
} from "node:fs";
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
  canonicalizeJson
} from "../lib/canonical-json.ts";

const STORE_BYTE_LIMIT =
  2 * 1024 * 1024;

export type DecompositionPlanStoreFailureStage =
  | "beforeWrite"
  | "afterWrite"
  | "beforeReplace"
  | "afterReplace";

export interface DecompositionPlanStorage {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}

export interface FileDecompositionPlanStoreOptions {
  readonly filePath: string;
  readonly workspaceRoot?:
    string | undefined;
  readonly failureInjector?: (
    stage: DecompositionPlanStoreFailureStage
  ) => void | Promise<void>;
}

export class FileDecompositionPlanStore
  implements DecompositionPlanStorage
{
  readonly #workspaceRoot: string;
  readonly #filePath: string;
  readonly #failureInjector:
    | FileDecompositionPlanStoreOptions["failureInjector"];

  constructor({
    filePath,
    workspaceRoot,
    failureInjector
  }: FileDecompositionPlanStoreOptions) {
    if (
      typeof filePath !== "string" ||
      filePath.length === 0
    ) {
      throw new TypeError(
        "Decomposition plan store requires a file path."
      );
    }
    if (
      workspaceRoot !== undefined &&
      (
        typeof workspaceRoot !==
          "string" ||
        workspaceRoot.trim().length ===
          0
      )
    ) {
      throw new TypeError(
        "Decomposition plan store workspaceRoot must be a non-empty path."
      );
    }
    const normalizedFilePath =
      resolve(filePath);
    const normalizedWorkspaceRoot =
      resolve(
        workspaceRoot ??
          dirname(
            normalizedFilePath
          )
      );
    if (
      !isWithinPath(
        normalizedWorkspaceRoot,
        normalizedFilePath
      )
    ) {
      throw new TypeError(
        "Decomposition plan store file must stay inside its workspace root."
      );
    }
    if (
      failureInjector !== undefined &&
      typeof failureInjector !==
        "function"
    ) {
      throw new TypeError(
        "Decomposition plan store failureInjector must be a function."
      );
    }
    this.#workspaceRoot =
      normalizedWorkspaceRoot;
    this.#filePath =
      normalizedFilePath;
    this.#failureInjector =
      failureInjector;
  }

  async read(): Promise<unknown> {
    let handle:
      | FileHandle
      | undefined;
    try {
      const directory =
        await this.openSafeDirectory(
          false
        );
      if (directory === null) {
        return null;
      }
      const target =
        await lstatFileIfPresent(
          this.#filePath
        );
      if (target === null) {
        return null;
      }
      if (
        !target.isFile() ||
        target.isSymbolicLink() ||
        target.nlink !== 1n ||
        target.size >
          BigInt(
            STORE_BYTE_LIMIT
          )
      ) {
        throw storeError(
          "DECOMPOSITION_STORE_CORRUPT",
          "The decomposition plan store is not a single-link regular file."
        );
      }
      handle = await open(
        this.#filePath,
        "r"
      );
      const metadata =
        await handle.stat({
          bigint: true
        });
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1n ||
        metadata.dev !== target.dev ||
        metadata.ino !== target.ino
      ) {
        throw storeError(
          "DECOMPOSITION_STORE_CORRUPT",
          "The decomposition plan store identity changed while opening."
        );
      }
      await this.assertSameDirectory(
        directory
      );
      const bytes = await readBounded(
        handle
      );
      if (bytes.byteLength === 0) {
        throw storeError(
          "DECOMPOSITION_STORE_CORRUPT",
          "The decomposition plan store is empty."
        );
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", {
          fatal: true
        }).decode(bytes);
      } catch (error) {
        throw storeError(
          "DECOMPOSITION_STORE_CORRUPT",
          "The decomposition plan store is not valid UTF-8.",
          error
        );
      }
      try {
        return JSON.parse(text);
      } catch (error) {
        throw storeError(
          "DECOMPOSITION_STORE_CORRUPT",
          "The decomposition plan store contains invalid JSON.",
          error
        );
      }
    } catch (error) {
      if (
        error instanceof
        DecompositionPlanStoreError
      ) {
        throw error;
      }
      throw storeError(
        "DECOMPOSITION_STORE_READ_FAILED",
        "TaskSeal could not safely read the decomposition plan store.",
        error
      );
    } finally {
      await closeIgnoringErrors(handle);
    }
  }

  async write(value: unknown): Promise<void> {
    let serialized: string;
    try {
      serialized =
        canonicalizeJson(value, {
          maxDepth: 16
        });
    } catch (error) {
      throw storeError(
        "DECOMPOSITION_STORE_WRITE_FAILED",
        "TaskSeal could not serialize the decomposition plan store.",
        error
      );
    }
    if (
      Buffer.byteLength(
        serialized,
        "utf8"
      ) > STORE_BYTE_LIMIT
    ) {
      throw storeError(
        "DECOMPOSITION_STORE_WRITE_FAILED",
        "The decomposition plan store exceeds its byte limit."
      );
    }

    const directory = dirname(
      this.#filePath
    );
    const temporaryPath = join(
      directory,
      `.${basename(
        this.#filePath
      )}.tmp`
    );
    let handle:
      | FileHandle
      | undefined;
    let replaced = false;
    let temporaryIdentity:
      FileIdentity | undefined;

    try {
      const directoryIdentity =
        await this.openSafeDirectory(
          true
        );
      if (directoryIdentity === null) {
        throw new Error(
          "Decomposition plan directory was not created."
        );
      }
      await this.assertSameDirectory(
        directoryIdentity
      );
      handle =
        await this.openTemporary(
          directoryIdentity,
          temporaryPath
        );
      const temporaryMetadata =
        await handle.stat({
          bigint: true
        });
      if (
        !temporaryMetadata.isFile() ||
        temporaryMetadata.nlink !==
          1n
      ) {
        throw new Error(
          "Decomposition plan temporary file is invalid."
        );
      }
      temporaryIdentity = {
        device:
          temporaryMetadata.dev,
        inode:
          temporaryMetadata.ino
      };
      await this.inject(
        "beforeWrite"
      );
      await handle.writeFile(
        serialized,
        "utf8"
      );
      await this.inject("afterWrite");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.inject("beforeReplace");
      this.assertSameDirectorySync(
        directoryIdentity
      );
      assertFileIdentitySync(
        temporaryPath,
        temporaryIdentity
      );
      assertReplaceableTargetSync(
        this.#filePath
      );
      this.assertSameDirectorySync(
        directoryIdentity
      );
      renameSync(
        temporaryPath,
        this.#filePath
      );
      replaced = true;
      await this.assertSameDirectory(
        directoryIdentity
      );
      await this.assertTargetIdentity(
        directoryIdentity,
        temporaryIdentity
      );
      await syncDirectoryBestEffort(
        directory
      );
      await this.inject("afterReplace");
    } catch (error) {
      await closeIgnoringErrors(handle);
      handle = undefined;
      if (
        error instanceof
        DecompositionPlanStoreError
      ) {
        throw error;
      }
      throw storeError(
        replaced
          ? "DECOMPOSITION_STORE_COMMIT_OUTCOME_UNKNOWN"
          : "DECOMPOSITION_STORE_WRITE_FAILED",
        replaced
          ? "TaskSeal replaced the decomposition plan store but could not confirm the final outcome."
          : "TaskSeal could not replace the decomposition plan store.",
        error
      );
    } finally {
      await closeIgnoringErrors(handle);
    }
  }

  private async openSafeDirectory(
    create: boolean
  ): Promise<DirectoryIdentity | null> {
    const directory = dirname(
      this.#filePath
    );
    const canonicalRoot =
      await realpath(
        this.#workspaceRoot
      );

    if (create) {
      try {
        await mkdir(directory);
      } catch (error) {
        if (
          !hasErrorCode(
            error,
            "EEXIST"
          )
        ) {
          throw error;
        }
      }
    }
    const metadata =
      await lstatDirectoryIfPresent(
        directory
      );
    if (metadata === null) {
      return null;
    }
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink()
    ) {
      throw new Error(
        "Decomposition plan directory is redirected."
      );
    }
    const canonicalDirectory =
      await realpath(directory);
    if (
      !isWithinPath(
        canonicalRoot,
        canonicalDirectory
      )
    ) {
      throw new Error(
        "Decomposition plan directory escapes the workspace."
      );
    }
    return {
      canonicalPath:
        canonicalDirectory,
      device: metadata.dev,
      inode: metadata.ino
    };
  }

  private async assertSameDirectory(
    expected: DirectoryIdentity
  ): Promise<void> {
    const directory = dirname(
      this.#filePath
    );
    const metadata =
      await lstat(directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.dev !==
        expected.device ||
      metadata.ino !==
        expected.inode ||
      (await realpath(directory)) !==
        expected.canonicalPath
    ) {
      throw new Error(
        "Decomposition plan directory changed."
      );
    }
  }

  private assertSameDirectorySync(
    expected: DirectoryIdentity
  ): void {
    const directory = dirname(
      this.#filePath
    );
    const metadata =
      lstatSync(directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.dev !==
        expected.device ||
      metadata.ino !==
        expected.inode ||
      realpathSync(directory) !==
        expected.canonicalPath
    ) {
      throw new Error(
        "Decomposition plan directory changed."
      );
    }
  }

  private async openTemporary(
    directory:
      DirectoryIdentity,
    temporaryPath: string
  ): Promise<FileHandle> {
    let handle:
      | FileHandle
      | undefined;
    try {
      try {
        handle = await open(
          temporaryPath,
          "wx",
          0o600
        );
        await this.assertSameDirectory(
          directory
        );
        return handle;
      } catch (error) {
        await closeIgnoringErrors(
          handle
        );
        handle = undefined;
        if (
          !hasErrorCode(
            error,
            "EEXIST"
          )
        ) {
          throw error;
        }
      }
      const existing =
        readSingleLinkFileIdentitySync(
          temporaryPath
        );
      handle = await open(
        temporaryPath,
        "r+"
      );
      const metadata =
        await handle.stat({
          bigint: true
        });
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1n ||
        metadata.dev !==
          existing.device ||
        metadata.ino !==
          existing.inode
      ) {
        throw new Error(
          "Decomposition plan temporary identity changed."
        );
      }
      await this.assertSameDirectory(
        directory
      );
      await handle.chmod(0o600);
      await handle.truncate(0);
      return handle;
    } catch (error) {
      await closeIgnoringErrors(handle);
      throw error;
    }
  }

  private async assertTargetIdentity(
    directory:
      DirectoryIdentity,
    expected: FileIdentity
  ): Promise<void> {
    const target = lstatSync(
      this.#filePath,
      { bigint: true }
    );
    if (
      !target.isFile() ||
      target.isSymbolicLink() ||
      target.nlink !== 1n ||
      target.dev !== expected.device ||
      target.ino !== expected.inode
    ) {
      throw new Error(
        "Decomposition plan target identity changed."
      );
    }
    let handle:
      | FileHandle
      | undefined;
    try {
      handle = await open(
        this.#filePath,
        "r"
      );
      const metadata =
        await handle.stat({
          bigint: true
        });
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1n ||
        metadata.dev !==
          expected.device ||
        metadata.ino !==
          expected.inode
      ) {
        throw new Error(
          "Decomposition plan target identity changed."
        );
      }
      await this.assertSameDirectory(
        directory
      );
    } finally {
      await closeIgnoringErrors(handle);
    }
  }

  async inject(
    stage: DecompositionPlanStoreFailureStage
  ): Promise<void> {
    await this.#failureInjector?.(
      stage
    );
  }
}

async function readBounded(
  handle: FileHandle
): Promise<Uint8Array> {
  const buffer = Buffer.allocUnsafe(
    STORE_BYTE_LIMIT + 1
  );
  let offset = 0;

  while (offset < buffer.length) {
    const { bytesRead } =
      await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset
      );
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  if (offset > STORE_BYTE_LIMIT) {
    throw storeError(
      "DECOMPOSITION_STORE_CORRUPT",
      "The decomposition plan store exceeds its byte limit."
    );
  }
  return buffer.subarray(0, offset);
}

async function closeIgnoringErrors(
  handle:
    | FileHandle
    | undefined
): Promise<void> {
  try {
    await handle?.close();
  } catch {
    // Preserve the primary storage result.
  }
}

async function lstatDirectoryIfPresent(
  path: string
) {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      hasErrorCode(
        error,
        "ENOENT"
      )
    ) {
      return null;
    }
    throw error;
  }
}

async function lstatFileIfPresent(
  path: string
) {
  try {
    return await lstat(path, {
      bigint: true
    });
  } catch (error) {
    if (
      hasErrorCode(
        error,
        "ENOENT"
      )
    ) {
      return null;
    }
    throw error;
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

function isWithinPath(
  parent: string,
  candidate: string
): boolean {
  const value = relative(
    parent,
    candidate
  );
  return (
    value === "" ||
    (
      !value.startsWith("..") &&
      !isAbsolute(value)
    )
  );
}

function assertFileIdentitySync(
  path: string,
  expected: FileIdentity
): void {
  const metadata =
    readSingleLinkFileIdentitySync(
      path
    );
  if (
    metadata.device !==
      expected.device ||
    metadata.inode !==
      expected.inode
  ) {
    throw new Error(
      "Decomposition plan temporary identity changed."
    );
  }
}

function readSingleLinkFileIdentitySync(
  path: string
): FileIdentity {
  const metadata = lstatSync(
    path,
    { bigint: true }
  );
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n
  ) {
    throw new Error(
      "Decomposition plan temporary file is invalid."
    );
  }
  return {
    device: metadata.dev,
    inode: metadata.ino
  };
}

function assertReplaceableTargetSync(
  path: string
): void {
  try {
    const target = lstatSync(
      path,
      { bigint: true }
    );
    if (
      !target.isFile() ||
      target.isSymbolicLink() ||
      target.nlink !== 1n
    ) {
      throw new Error(
        "Decomposition plan target is not a single-link regular file."
      );
    }
  } catch (error) {
    if (
      hasErrorCode(
        error,
        "ENOENT"
      )
    ) {
      return;
    }
    throw error;
  }
}

async function syncDirectoryBestEffort(
  directory: string
): Promise<void> {
  let handle:
    | FileHandle
    | undefined;
  try {
    handle = await open(
      directory,
      "r"
    );
    await handle.sync();
  } catch {
    // Some platforms do not support directory handle sync.
  } finally {
    await closeIgnoringErrors(
      handle
    );
  }
}

function hasErrorCode(
  error: unknown,
  code: string
): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function storeError(
  code: string,
  message: string,
  cause?: unknown
): DecompositionPlanStoreError {
  return new DecompositionPlanStoreError(
    code,
    message,
    cause === undefined
      ? undefined
      : { cause }
  );
}

export class DecompositionPlanStoreError extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name =
      "DecompositionPlanStoreError";
    this.code = code;
  }
}
