import {
  constants as fileSystemConstants
} from "node:fs";
import {
  open
} from "node:fs/promises";
import {
  resolve
} from "node:path";
import {
  TextDecoder
} from "node:util";

import {
  parseTaskSealPluginManifest,
  PluginManifestError
} from "../sdk/plugin-manifest.ts";
import type {
  TaskSealPluginManifestV1
} from "../sdk/plugin-manifest.ts";

const MAX_MANIFEST_BYTES =
  64 * 1024;

export interface CheckTaskSealPluginManifestFileOptions {
  readonly cwd: string;
  readonly path: string;
  readonly nodeVersion?:
    string | undefined;
}

export async function checkTaskSealPluginManifestFile({
  cwd,
  path,
  nodeVersion
}: CheckTaskSealPluginManifestFileOptions): Promise<TaskSealPluginManifestV1> {
  try {
    const source =
      await readBoundedManifestFile(
        resolve(cwd, path)
      );
    const value =
      JSON.parse(source) as unknown;
    return parseTaskSealPluginManifest(
      value,
      nodeVersion === undefined
        ? {}
        : { nodeVersion }
    );
  } catch (error) {
    if (
      error instanceof
      PluginManifestError
    ) {
      throw error;
    }
    throw new PluginManifestError(
      "PLUGIN_MANIFEST_INVALID",
      "The TaskSeal plugin manifest is invalid.",
      { cause: error }
    );
  }
}

async function readBoundedManifestFile(
  path: string
): Promise<string> {
  const handle =
    await open(
      path,
      createNonBlockingReadFlags()
    );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size >
        MAX_MANIFEST_BYTES
    ) {
      throw new Error(
        "Plugin manifest file is not a bounded regular file."
      );
    }

    const bytes =
      Buffer.alloc(
        MAX_MANIFEST_BYTES + 1
      );
    let bytesRead = 0;
    while (
      bytesRead <
      bytes.length
    ) {
      const chunk =
        await handle.read(
          bytes,
          bytesRead,
          bytes.length -
            bytesRead,
          bytesRead
        );
      if (
        chunk.bytesRead === 0
      ) {
        break;
      }
      bytesRead +=
        chunk.bytesRead;
    }
    if (
      bytesRead >
        MAX_MANIFEST_BYTES
    ) {
      throw new Error(
        "Plugin manifest exceeds the byte limit."
      );
    }
    return new TextDecoder(
      "utf-8",
      { fatal: true }
    ).decode(
      bytes.subarray(0, bytesRead)
    );
  } finally {
    await handle.close();
  }
}

function createNonBlockingReadFlags():
  number {
  return (
    fileSystemConstants.O_RDONLY |
    (
      typeof fileSystemConstants.O_NONBLOCK ===
      "number"
        ? fileSystemConstants.O_NONBLOCK
        : 0
    ) |
    (
      typeof fileSystemConstants.O_NOFOLLOW ===
      "number"
        ? fileSystemConstants.O_NOFOLLOW
        : 0
    )
  );
}
