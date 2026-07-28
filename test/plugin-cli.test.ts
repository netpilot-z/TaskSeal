import assert from "node:assert/strict";
import test from "node:test";

import {
  runCli
} from "../src/cli.ts";
import {
  PluginManifestError
} from "../src/sdk/plugin-manifest.ts";
import {
  TASKSEAL_PACKAGE_VERSION
} from "../src/sdk/version.ts";

test("CLI exposes standard help and version without starting the Control Room", async () => {
  for (const args of [
    ["--help"],
    ["help"]
  ]) {
    let output = "";
    let starts = 0;
    assert.equal(
      await runCli({
        args,
        output: {
          write(value) {
            output += value;
          }
        },
        startControlRoom: () => {
          starts += 1;
        }
      }),
      0
    );
    assert.match(
      output,
      /^Usage:\n/
    );
    assert.equal(starts, 0);
  }

  let versionOutput = "";
  assert.equal(
    await runCli({
      args: ["--version"],
      output: {
        write(value) {
          versionOutput += value;
        }
      }
    }),
    0
  );
  assert.equal(
    versionOutput,
    `${TASKSEAL_PACKAGE_VERSION}\n`
  );
});

test("CLI checks one static plugin manifest and emits normalized compatibility facts", async () => {
  let output = "";
  const calls: unknown[] = [];
  const result =
    await runCli({
      args: [
        "plugin",
        "check",
        "plugins/echo.json"
      ],
      cwd: "project",
      nodeVersion: "24.15.0",
      output: {
        write(value) {
          output += value;
        }
      },
      checkPluginManifest(
        options
      ) {
        calls.push(options);
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
            "./dist/runner.js"
        };
      }
    });

  assert.equal(result, 0);
  assert.deepEqual(calls, [
    {
      cwd: "project",
      path:
        "plugins/echo.json",
      nodeVersion: "24.15.0"
    }
  ]);
  assert.deepEqual(
    JSON.parse(output),
    {
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
        "./dist/runner.js"
    }
  );
});

test("CLI plugin check separates usage errors from safe compatibility diagnostics", async () => {
  let usage = "";
  assert.equal(
    await runCli({
      args: ["plugin", "check"],
      output: {
        write(value) {
          usage += value;
        }
      }
    }),
    2
  );
  assert.match(usage, /^Usage:\n/);

  let failure = "";
  assert.equal(
    await runCli({
      args: [
        "plugin",
        "check",
        "future.json"
      ],
      output: {
        write(value) {
          failure += value;
        }
      },
      checkPluginManifest() {
        throw new PluginManifestError(
          "PLUGIN_API_UNSUPPORTED",
          "The TaskSeal plugin API version is unsupported.",
          {
            cause:
              new Error(
                "secret raw manifest"
              )
          }
        );
      }
    }),
    1
  );
  assert.equal(
    failure,
    "PLUGIN_API_UNSUPPORTED: The TaskSeal plugin API version is unsupported.\n"
  );
  assert.doesNotMatch(
    failure,
    /secret raw manifest/
  );
});
