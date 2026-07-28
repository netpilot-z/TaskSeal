import assert from "node:assert/strict";
import test from "node:test";

import {
  parseTaskSealPluginManifest,
  PluginManifestError,
  TASKSEAL_PLUGIN_API_VERSION,
  TASKSEAL_PROVIDER_CONTRACT_VERSION,
  TASKSEAL_RUNNER_CONTRACT_VERSION
} from "../src/sdk/plugin-manifest.ts";

test("plugin manifest v1 normalizes compatible Runner and Provider packages", () => {
  const runner =
    parseTaskSealPluginManifest(
      createManifest()
    );
  const provider =
    parseTaskSealPluginManifest(
      createManifest({
        pluginId:
          "example.memory-provider",
        pluginType: "provider",
        contractVersion:
          TASKSEAL_PROVIDER_CONTRACT_VERSION,
        entrypoint:
          "./dist/provider.mjs"
      })
    );

  assert.deepEqual(runner, {
    schemaVersion: 1,
    apiVersion:
      TASKSEAL_PLUGIN_API_VERSION,
    pluginId: "example.echo-runner",
    pluginVersion: "1.0.0",
    pluginType: "runner",
    contractVersion:
      TASKSEAL_RUNNER_CONTRACT_VERSION,
    minimumNodeVersion: "24.12.0",
    entrypoint: "./dist/runner.js"
  });
  assert.equal(
    Object.isFrozen(runner),
    true
  );
  assert.equal(
    provider.pluginType,
    "provider"
  );
});

test("plugin compatibility fails closed for unsupported API, contract, and Node versions", () => {
  assert.throws(
    () =>
      parseTaskSealPluginManifest(
        createManifest({
          apiVersion:
            "taskseal.plugin/v2"
        })
      ),
    hasCode(
      "PLUGIN_API_UNSUPPORTED"
    )
  );
  assert.throws(
    () =>
      parseTaskSealPluginManifest(
        createManifest({
          contractVersion:
            TASKSEAL_PROVIDER_CONTRACT_VERSION
        })
      ),
    hasCode(
      "PLUGIN_CONTRACT_UNSUPPORTED"
    )
  );
  assert.throws(
    () =>
      parseTaskSealPluginManifest(
        createManifest({
          minimumNodeVersion:
            "24.11.0"
        }),
        {
          nodeVersion:
            "24.15.0"
        }
      ),
    hasCode(
      "PLUGIN_NODE_UNSUPPORTED"
    )
  );
  assert.throws(
    () =>
      parseTaskSealPluginManifest(
        createManifest({
          minimumNodeVersion:
            "24.16.0"
        }),
        {
          nodeVersion:
            "24.15.0"
        }
      ),
    hasCode(
      "PLUGIN_NODE_UNSUPPORTED"
    )
  );
  assert.throws(
    () =>
      parseTaskSealPluginManifest(
        createManifest(),
        {
          nodeVersion: "25.0.0"
        }
      ),
    hasCode(
      "PLUGIN_NODE_UNSUPPORTED"
    )
  );
});

test("plugin manifest rejects traversal, unknown fields, malformed versions, and executable objects", () => {
  for (const override of [
    {
      entrypoint:
        "../runner.js"
    },
    {
      entrypoint:
        "./dist/../runner.js"
    },
    {
      entrypoint:
        "./dist/runner.ts"
    },
    {
      entrypoint:
        "./con.js"
    },
    {
      entrypoint:
        "./aux/index.js"
    },
    {
      entrypoint:
        "./folder./index.js"
    },
    {
      pluginVersion: "v1"
    },
    {
      minimumNodeVersion:
        "24"
    }
  ]) {
    assert.throws(
      () =>
        parseTaskSealPluginManifest(
          createManifest(override)
        ),
      hasCode(
        "PLUGIN_MANIFEST_INVALID"
      )
    );
  }

  assert.throws(
    () =>
      parseTaskSealPluginManifest({
        ...createManifest(),
        unexpected: true
      }),
    hasCode(
      "PLUGIN_MANIFEST_INVALID"
    )
  );

  let getterCalls = 0;
  const hostile = createManifest();
  Object.defineProperty(
    hostile,
    "pluginId",
    {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "hostile";
      }
    }
  );

  assert.throws(
    () =>
      parseTaskSealPluginManifest(
        hostile
      ),
    hasCode(
      "PLUGIN_MANIFEST_INVALID"
    )
  );
  assert.equal(getterCalls, 0);
});

function createManifest(
  override:
    Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    apiVersion:
      TASKSEAL_PLUGIN_API_VERSION,
    pluginId: "example.echo-runner",
    pluginVersion: "1.0.0",
    pluginType: "runner",
    contractVersion:
      TASKSEAL_RUNNER_CONTRACT_VERSION,
    minimumNodeVersion: "24.12.0",
    entrypoint: "./dist/runner.js",
    ...override
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
