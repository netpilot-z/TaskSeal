import assert from "node:assert/strict";
import {
  execFile
} from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import {
  tmpdir
} from "node:os";
import {
  join
} from "node:path";
import test from "node:test";
import {
  fileURLToPath
} from "node:url";
import {
  promisify
} from "node:util";

const execFileAsync =
  promisify(execFile);
const repositoryRoot =
  fileURLToPath(
    new URL("../", import.meta.url)
  );
const credentialPattern =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|lin_api_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b/;

test(
  "packed TaskSeal installs in isolation and exposes only the compiled CLI and versioned SDK",
  { timeout: 120_000 },
  async (t) => {
    for (const sentinel of [
      `ghp_${"A".repeat(32)}`,
      `github_pat_${"B".repeat(32)}`,
      `lin_api_${"C".repeat(32)}`,
      `sk-${"D".repeat(32)}`
    ]) {
      assert.match(
        sentinel,
        credentialPattern
      );
    }
    assert.doesNotMatch(
      "GITHUB_TOKEN",
      credentialPattern
    );

    const temporaryRoot =
      await mkdtemp(
        join(
          tmpdir(),
          "taskseal-package-"
        )
      );
    t.after(async () => {
      await rm(temporaryRoot, {
        recursive: true,
        force: true
      });
    });

    const packDirectory =
      join(
        temporaryRoot,
        "pack"
      );
    const consumerDirectory =
      join(
        temporaryRoot,
        "consumer"
      );
    await Promise.all([
      mkdir(packDirectory),
      mkdir(consumerDirectory)
    ]);

    const pack =
      await runNpm(
        [
          "pack",
          "--json",
          "--pack-destination",
          packDirectory
        ],
        repositoryRoot
      );
    const metadata =
      readPackMetadata(
        pack.stdout
      );
    const paths =
      metadata.files.map(
        (file) => file.path
      );

    assert.ok(
      metadata.entryCount > 0 &&
        metadata.entryCount < 200
    );
    assert.equal(
      metadata.entryCount,
      paths.length
    );
    assertPublishedContents(paths);

    const archivePath =
      join(
        packDirectory,
        metadata.filename
      );
    await writeFile(
      join(
        consumerDirectory,
        "package.json"
      ),
      JSON.stringify({
        private: true,
        type: "module"
      }),
      "utf8"
    );
    await runNpm(
      [
        "install",
        archivePath,
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund"
      ],
      consumerDirectory
    );

    const installedRoot =
      join(
        consumerDirectory,
        "node_modules",
        "taskseal"
      );
    const installedManifest =
      JSON.parse(
        await readFile(
          join(
            installedRoot,
            "package.json"
          ),
          "utf8"
        )
      ) as Record<
        string,
        unknown
      >;
    assert.equal(
      installedManifest.version,
      "0.0.0-experiment.3"
    );
    assert.equal(
      installedManifest.dependencies,
      undefined
    );
    assert.ok(
      installedManifest.scripts !==
        null &&
        typeof installedManifest.scripts ===
          "object" &&
        !Array.isArray(
          installedManifest.scripts
        )
    );
    const installedScripts =
      installedManifest.scripts as Record<
        string,
        unknown
      >;
    for (const lifecycle of [
      "preinstall",
      "install",
      "postinstall",
      "prepare"
    ]) {
      assert.equal(
        Object.hasOwn(
          installedScripts,
          lifecycle
        ),
        false,
        `Install lifecycle script is forbidden: ${lifecycle}`
      );
    }
    assert.deepEqual(
      installedManifest.bin,
      {
        taskseal:
          "dist/bin/taskseal.js"
      }
    );
    await assertNoLocalPathsOrSecrets({
      installedRoot,
      paths
    });

    const help =
      await runInstalledCli(
        ["--help"],
        consumerDirectory
      );
    assert.match(
      help.stdout,
      /^Usage:\r?\n/
    );
    const version =
      await runInstalledCli(
        ["--version"],
        consumerDirectory
      );
    assert.equal(
      version.stdout.trim(),
      "0.0.0-experiment.3"
    );

    const unsupportedNodePath =
      join(
        consumerDirectory,
        "unsupported-node.mjs"
      );
    await writeFile(
      unsupportedNodePath,
      `
Object.defineProperty(process.versions, "node", {
  value: "25.0.0"
});
await import("./node_modules/taskseal/dist/bin/taskseal.js");
`,
      "utf8"
    );
    await assert.rejects(
      runCommand(
        process.execPath,
        [unsupportedNodePath],
        consumerDirectory
      ),
      (error) => {
        assert.ok(
          error !== null &&
            typeof error ===
              "object"
        );
        const failure =
          error as {
            code?: unknown;
            stdout?: unknown;
            stderr?: unknown;
          };
        assert.equal(
          failure.code,
          1
        );
        assert.equal(
          failure.stdout,
          ""
        );
        assert.equal(
          failure.stderr,
          "TASKSEAL_NODE_UNSUPPORTED: TaskSeal requires Node.js >=24.12.0 <25.\n"
        );
        return true;
      }
    );

    const pluginCheck =
      await runInstalledCli(
        [
          "plugin",
          "check",
          join(
            installedRoot,
            "examples",
            "runner-echo",
            "taskseal.plugin.json"
          )
        ],
        consumerDirectory
      );
    assert.equal(
      (
        JSON.parse(
          pluginCheck.stdout
        ) as {
          pluginId?: unknown;
        }
      ).pluginId,
      "example.echo-runner"
    );

    const smokePath =
      join(
        consumerDirectory,
        "sdk-smoke.mjs"
      );
    await writeFile(
      smokePath,
      createSdkSmokeSource(),
      "utf8"
    );
    const sdkSmoke =
      await runCommand(
        process.execPath,
        [smokePath],
        consumerDirectory
      );
    assert.equal(
      sdkSmoke.stdout.trim(),
      "sdk-ok"
    );

    const typeScriptPath =
      join(
        consumerDirectory,
        "sdk-consumer.ts"
      );
    const typeScriptConfigPath =
      join(
        consumerDirectory,
        "tsconfig.json"
      );
    await Promise.all([
      writeFile(
        typeScriptPath,
        createTypeScriptConsumerSource(),
        "utf8"
      ),
      writeFile(
        typeScriptConfigPath,
        JSON.stringify({
          compilerOptions: {
            module: "nodenext",
            moduleResolution:
              "nodenext",
            noEmit: true,
            strict: true,
            target: "esnext"
          },
          files: [
            "sdk-consumer.ts"
          ]
        }),
        "utf8"
      )
    ]);
    await runCommand(
      process.execPath,
      [
        join(
          repositoryRoot,
          "node_modules",
          "typescript",
          "bin",
          "tsc"
        ),
        "--project",
        typeScriptConfigPath
      ],
      consumerDirectory
    );

    const exampleContracts =
      await runCommand(
        process.execPath,
        [
          "--test",
          join(
            installedRoot,
            "examples",
            "runner-echo",
            "contract.test.js"
          ),
          join(
            installedRoot,
            "examples",
            "provider-memory",
            "contract.test.js"
          )
        ],
        consumerDirectory
      );
    const contractOutput =
      `${exampleContracts.stdout}\n${exampleContracts.stderr}`;
    assert.match(
      contractOutput,
      /pass 5/
    );
    assert.doesNotMatch(
      contractOutput,
      /fail [1-9]/
    );
  }
);

interface PackMetadata {
  readonly filename: string;
  readonly entryCount: number;
  readonly files:
    readonly {
      readonly path: string;
    }[];
}

function readPackMetadata(
  output: string
): PackMetadata {
  const arrayStart =
    output.lastIndexOf("\n[");
  const json =
    arrayStart === -1
      ? output.slice(
          output.indexOf("[")
        )
      : output.slice(
          arrayStart + 1
        );
  const parsed =
    JSON.parse(json) as unknown;
  assert.ok(
    Array.isArray(parsed) &&
      parsed.length === 1
  );
  const metadata =
    parsed[0] as Partial<
      PackMetadata
    >;
  assert.equal(
    typeof metadata.filename,
    "string"
  );
  assert.equal(
    typeof metadata.entryCount,
    "number"
  );
  assert.ok(
    Array.isArray(
      metadata.files
    )
  );
  return metadata as PackMetadata;
}

function assertPublishedContents(
  paths: readonly string[]
): void {
  const allowedRoots =
    new Set([
      "dist",
      "examples",
      "fixtures",
      "public",
      "schemas"
    ]);
  for (const path of paths) {
    const root =
      path.split("/")[0]!;
    assert.ok(
      path === "README.md" ||
        path === "package.json" ||
        allowedRoots.has(root),
      `Unexpected packed path: ${path}`
    );
    assert.doesNotMatch(
      path,
      /^(?:src|test|test-support|config|docs|scripts|verification|\.github|\.taskseal)(?:\/|$)/
    );
  }

  for (const required of [
    "dist/bin/taskseal.js",
    "dist/sdk/runner-v1.d.ts",
    "dist/sdk/provider-v1.d.ts",
    "dist/sdk/plugin-manifest.d.ts",
    "examples/runner-echo/contract.test.js",
    "examples/provider-memory/contract.test.js",
    "schemas/project-config.schema.json",
    "schemas/plugin-manifest.schema.json",
    "public/index.html"
  ]) {
    assert.ok(
      paths.includes(required),
      `Missing packed path: ${required}`
    );
  }
  assert.equal(
    paths.some(
      (path) =>
        path.endsWith(".ts") &&
        !path.endsWith(".d.ts")
    ),
    false
  );
}

async function assertNoLocalPathsOrSecrets({
  installedRoot,
  paths
}: {
  installedRoot: string;
  paths: readonly string[];
}): Promise<void> {
  const forbidden =
    [
      /\b[A-Za-z]:\\(?:Users|Code)\\/,
      /\/(?:Users|home)\/[^/\s]+\/[^/\s]+/,
      credentialPattern
    ];

  for (const path of paths) {
    const content =
      await readFile(
        join(
          installedRoot,
          ...path.split("/")
        ),
        "utf8"
      );
    for (const pattern of forbidden) {
      assert.doesNotMatch(
        content,
        pattern,
        `Packed file contains a local path or credential-shaped value: ${path}`
      );
    }
  }
}

async function runInstalledCli(
  args: readonly string[],
  cwd: string
): Promise<{
  stdout: string;
  stderr: string;
}> {
  return runNpm(
    [
      "exec",
      "--offline",
      "--",
      "taskseal",
      ...args
    ],
    cwd
  );
}

async function runNpm(
  args: readonly string[],
  cwd: string
): Promise<{
  stdout: string;
  stderr: string;
}> {
  const npmEntry =
    process.env.npm_execpath;
  assert.ok(
    npmEntry,
    "Package smoke must run through an npm script."
  );
  return runCommand(
    process.execPath,
    [npmEntry, ...args],
    cwd
  );
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string
): Promise<{
  stdout: string;
  stderr: string;
}> {
  return execFileAsync(
    command,
    [...args],
    {
      cwd,
      encoding: "utf8",
      maxBuffer:
        20 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
      env: {
        ...process.env,
        NODE_TEST_CONTEXT:
          undefined,
        NPM_CONFIG_AUDIT:
          "false",
        NPM_CONFIG_FUND:
          "false",
        NPM_CONFIG_UPDATE_NOTIFIER:
          "false"
      }
    }
  );
}

function createSdkSmokeSource():
  string {
  return `
import { RUNNER_CONTRACT_VERSION } from "taskseal/runner/v1";
import { normalizeProviderAdapterV1 } from "taskseal/provider/v1";
import { TASKSEAL_PLUGIN_API_VERSION } from "taskseal/plugin/v1";
import { registerRunnerAdapterContract } from "taskseal/testing/runner/v1";
import { registerProviderAdapterContract } from "taskseal/testing/provider/v1";
import projectSchema from "taskseal/schemas/project-config" with { type: "json" };
import pluginSchema from "taskseal/schemas/plugin-manifest" with { type: "json" };

if (
  RUNNER_CONTRACT_VERSION !== "1" ||
  typeof normalizeProviderAdapterV1 !== "function" ||
  TASKSEAL_PLUGIN_API_VERSION !== "taskseal.plugin/v1" ||
  typeof registerRunnerAdapterContract !== "function" ||
  typeof registerProviderAdapterContract !== "function" ||
  projectSchema.title !== "TaskSeal Project Configuration" ||
  pluginSchema.title !== "TaskSeal Plugin Manifest v1"
) {
  throw new Error("Public SDK surface mismatch.");
}

try {
  await import("taskseal/dist/application/taskseal-service.js");
  throw new Error("Internal package path was exported.");
} catch (error) {
  if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
    throw error;
  }
}

process.stdout.write("sdk-ok\\n");
`;
}

function createTypeScriptConsumerSource():
  string {
  return `
import {
  parseRunnerManifest,
  type DigitalEmployeeAdapter
} from "taskseal/runner/v1";
import {
  normalizeProviderAdapterV1,
  type ProviderAdapterV1
} from "taskseal/provider/v1";
import {
  parseTaskSealPluginManifest
} from "taskseal/plugin/v1";
import type {
  RunnerAdapterContractFactory
} from "taskseal/testing/runner/v1";
import type {
  ProviderAdapterContractFactory
} from "taskseal/testing/provider/v1";

declare const runner: DigitalEmployeeAdapter;
declare const provider: ProviderAdapterV1<
  { id: string },
  { status: string },
  { id: string },
  { title: string }
>;
declare const runnerContract: RunnerAdapterContractFactory;
declare const providerContract: ProviderAdapterContractFactory;

parseRunnerManifest(runner.manifest);
normalizeProviderAdapterV1(provider);
parseTaskSealPluginManifest({
  schemaVersion: 1,
  apiVersion: "taskseal.plugin/v1",
  pluginId: "consumer.runner",
  pluginVersion: "1.0.0",
  pluginType: "runner",
  contractVersion: "taskseal.runner/v1",
  minimumNodeVersion: "24.12.0",
  entrypoint: "./index.js"
});
void runnerContract;
void providerContract;
`;
}
