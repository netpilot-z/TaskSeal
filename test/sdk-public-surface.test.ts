import assert from "node:assert/strict";
import test from "node:test";

import * as pluginSdk from "../src/sdk/plugin-manifest.ts";
import * as providerSdk from "../src/sdk/provider-v1.ts";
import * as runnerSdk from "../src/sdk/runner-v1.ts";
import * as providerTesting from "../src/sdk/testing/provider-v1.ts";
import * as runnerTesting from "../src/sdk/testing/runner-v1.ts";

test("versioned SDK facades expose only stable authoring contracts", () => {
  assert.deepEqual(
    Object.keys(runnerSdk).sort(),
    [
      "RUNNER_CONTRACT_VERSION",
      "RunnerContractError",
      "RunnerExecutionError",
      "parseRunnerExecutionInput",
      "parseRunnerExecutionOutput",
      "parseRunnerManifest"
    ]
  );
  assert.deepEqual(
    Object.keys(providerSdk).sort(),
    [
      "ProviderAdapterError",
      "normalizeProviderAdapterV1"
    ]
  );
  assert.deepEqual(
    Object.keys(runnerTesting),
    ["registerRunnerAdapterContract"]
  );
  assert.deepEqual(
    Object.keys(providerTesting),
    ["registerProviderAdapterContract"]
  );
  assert.equal(
    pluginSdk.TASKSEAL_PLUGIN_API_VERSION,
    "taskseal.plugin/v1"
  );
});
