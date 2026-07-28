import assert from "node:assert/strict";
import {
  execFileSync,
  spawnSync
} from "node:child_process";
import {
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkTaskSealPluginManifestFile
} from "../src/application/plugin-manifest-check.ts";
import {
  PluginManifestError
} from "../src/sdk/plugin-manifest.ts";

test("plugin manifest file check reads one bounded JSON manifest without executing its entrypoint", async (t) => {
  const directory =
    await createTemporaryDirectory(t);
  const manifestPath =
    join(
      directory,
      "taskseal.plugin.json"
    );
  await writeFile(
    manifestPath,
    JSON.stringify(
      createManifest()
    ),
    "utf8"
  );

  const manifest =
    await checkTaskSealPluginManifestFile({
      cwd: directory,
      path:
        "taskseal.plugin.json",
      nodeVersion: "24.15.0"
    });

  assert.equal(
    manifest.pluginId,
    "example.echo-runner"
  );
  assert.equal(
    manifest.entrypoint,
    "./malicious-entry.js"
  );

  const boundaryPath =
    join(
      directory,
      "boundary.json"
    );
  const boundaryJson =
    JSON.stringify(
      createManifest()
    );
  await writeFile(
    boundaryPath,
    boundaryJson.padEnd(
      64 * 1024,
      " "
    ),
    "utf8"
  );
  assert.equal(
    (
      await checkTaskSealPluginManifestFile({
        cwd: directory,
        path:
          "boundary.json",
        nodeVersion:
          "24.15.0"
      })
    ).pluginId,
    "example.echo-runner"
  );
});

test("plugin manifest file check fails safely for missing, oversized, and malformed files", async (t) => {
  const directory =
    await createTemporaryDirectory(t);

  await assert.rejects(
    checkTaskSealPluginManifestFile({
      cwd: directory,
      path: "missing.json"
    }),
    hasCode(
      "PLUGIN_MANIFEST_INVALID"
    )
  );

  await writeFile(
    join(directory, "oversized.json"),
    " ".repeat(65 * 1024),
    "utf8"
  );
  await assert.rejects(
    checkTaskSealPluginManifestFile({
      cwd: directory,
      path: "oversized.json"
    }),
    hasCode(
      "PLUGIN_MANIFEST_INVALID"
    )
  );

  await writeFile(
    join(directory, "malformed.json"),
    "{",
    "utf8"
  );
  await assert.rejects(
    checkTaskSealPluginManifestFile({
      cwd: directory,
      path: "malformed.json"
    }),
    hasCode(
      "PLUGIN_MANIFEST_INVALID"
    )
  );
});

test(
  "plugin manifest file check rejects a POSIX FIFO without waiting for a writer",
  {
    skip:
      process.platform ===
      "win32"
  },
  async (t) => {
    const directory =
      await createTemporaryDirectory(
        t
      );
    const fifoPath =
      join(
        directory,
        "manifest.json"
      );
    execFileSync(
      "mkfifo",
      [fifoPath]
    );

    const moduleUrl =
      new URL(
        "../src/application/plugin-manifest-check.ts",
        import.meta.url
      ).href;
    const result =
      spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
import { checkTaskSealPluginManifestFile } from ${JSON.stringify(moduleUrl)};
try {
  await checkTaskSealPluginManifestFile({
    cwd: ${JSON.stringify(directory)},
    path: "manifest.json"
  });
  process.exitCode = 2;
} catch (error) {
  process.stdout.write(error?.code ?? "unknown");
}
`
        ],
        {
          encoding: "utf8",
          timeout: 2_000,
          windowsHide: true
        }
      );

    assert.equal(
      result.error,
      undefined
    );
    assert.equal(
      result.status,
      0,
      result.stderr
    );
    assert.equal(
      result.stdout,
      "PLUGIN_MANIFEST_INVALID"
    );
  }
);

function createManifest() {
  return {
    schemaVersion: 1,
    apiVersion:
      "taskseal.plugin/v1",
    pluginId:
      "example.echo-runner",
    pluginVersion: "1.0.0",
    pluginType: "runner",
    contractVersion:
      "taskseal.runner/v1",
    minimumNodeVersion:
      "24.12.0",
    entrypoint:
      "./malicious-entry.js"
  };
}

function hasCode(
  code: string
): (
  error: unknown
) => boolean {
  return (error) =>
    error instanceof
      PluginManifestError &&
    error.code === code;
}

async function createTemporaryDirectory(
  t: test.TestContext
): Promise<string> {
  const directory =
    await mkdtemp(
      join(
        tmpdir(),
        "taskseal-plugin-check-"
      )
    );
  t.after(async () => {
    await rm(directory, {
      recursive: true,
      force: true
    });
  });
  return directory;
}
