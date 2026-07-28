import assert from "node:assert/strict";
import {
  readFile
} from "node:fs/promises";
import test from "node:test";

import {
  parseTaskSealPluginManifest
} from "../src/sdk/plugin-manifest.ts";

test("published schemas and examples use generic versioned authoring contracts", async () => {
  const [
    pluginSchema,
    projectSchema,
    runnerManifest,
    providerManifest
  ] = await Promise.all([
    readJson(
      "../schemas/plugin-manifest.schema.json"
    ),
    readJson(
      "../schemas/project-config.schema.json"
    ),
    readJson(
      "../examples/runner-echo/taskseal.plugin.json"
    ),
    readJson(
      "../examples/provider-memory/taskseal.plugin.json"
    )
  ]);

  assert.equal(
    readPath(
      pluginSchema,
      "properties",
      "apiVersion",
      "const"
    ),
    "taskseal.plugin/v1"
  );
  assert.equal(
    readPath(
      projectSchema,
      "additionalProperties"
    ),
    false
  );
  assert.equal(
    parseTaskSealPluginManifest(
      runnerManifest,
      {
        nodeVersion:
          "24.12.0"
      }
    ).pluginType,
    "runner"
  );
  assert.equal(
    parseTaskSealPluginManifest(
      providerManifest,
      {
        nodeVersion:
          "24.12.0"
      }
    ).pluginType,
    "provider"
  );

  const minimumNodePattern =
    new RegExp(
      String(
        readPath(
          pluginSchema,
          "properties",
          "minimumNodeVersion",
          "pattern"
        )
      )
    );
  assert.equal(
    minimumNodePattern.test(
      "24.12.0"
    ),
    true
  );
  assert.equal(
    minimumNodePattern.test(
      "24.99.1"
    ),
    true
  );
  assert.equal(
    minimumNodePattern.test(
      "24.11.0"
    ),
    false
  );
  assert.equal(
    minimumNodePattern.test(
      "18.0.0"
    ),
    false
  );

  const entrypointPattern =
    new RegExp(
      String(
        readPath(
          pluginSchema,
          "properties",
          "entrypoint",
          "pattern"
        )
      )
    );
  const reservedEntrypointPattern =
    new RegExp(
      String(
        readPath(
          pluginSchema,
          "properties",
          "entrypoint",
          "not",
          "pattern"
        )
      )
    );
  for (const entrypoint of [
    "./index.js",
    "./dist/runner.mjs"
  ]) {
    assert.equal(
      entrypointPattern.test(
        entrypoint
      ) &&
        !reservedEntrypointPattern.test(
          entrypoint
        ),
      true
    );
  }
  for (const entrypoint of [
    "./con.js",
    "./AUX/index.js",
    "./folder./index.js"
  ]) {
    assert.equal(
      entrypointPattern.test(
        entrypoint
      ) &&
        !reservedEntrypointPattern.test(
          entrypoint
        ),
      false
    );
  }

  const publishedText =
    JSON.stringify({
      pluginSchema,
      projectSchema,
      runnerManifest,
      providerManifest
    });
  assert.doesNotMatch(
    publishedText,
    /[A-Za-z]:\\|netpilot-z|TaskSeal\.git|LINEAR_API_KEY|token/i
  );
});

async function readJson(
  path: string
): Promise<unknown> {
  return JSON.parse(
    await readFile(
      new URL(path, import.meta.url),
      "utf8"
    )
  ) as unknown;
}

function readPath(
  value: unknown,
  ...segments: string[]
): unknown {
  let current = value;
  for (const segment of segments) {
    assert.ok(
      current !== null &&
        typeof current ===
          "object" &&
        !Array.isArray(current)
    );
    current = (
      current as Record<
        string,
        unknown
      >
    )[segment];
  }
  return current;
}
