import assert from "node:assert/strict";
import test from "node:test";

import { projectConnections } from "../src/application/connection-projection.ts";
import type { ConfigurationView } from "../src/application/configuration-control.ts";

test("connection projection preserves credential redaction and separates observation from configuration", () => {
  const configuration = {
    schemaVersion: "configuration-view/v1",
    revision: `sha256:${"a".repeat(64)}`,
    runtimeRevision: `sha256:${"b".repeat(64)}`,
    source: { path: "config/project.json", status: "loaded", revision: null },
    sources: [],
    effective: { project: "TaskSeal" },
    fields: [],
    definitions: [],
    integrations: [
      {
        id: "github",
        configured: true,
        capability: "ready",
        credential: {
          requirement: "optional",
          status: "present",
          bindings: ["env:GITHUB_TOKEN"]
        },
        setupUrl: "https://github.com/settings/tokens"
      },
      {
        id: "linear",
        configured: true,
        capability: "ready",
        credential: {
          requirement: "required",
          status: "missing",
          bindings: ["env:LINEAR_ACCESS_TOKEN"]
        },
        setupUrl: "https://linear.app/settings/api"
      }
    ],
    diagnostics: [],
    capabilities: { github: "ready", linear: "ready", gitee: "disabled", feishu: "disabled" },
    ready: true
  } as unknown as ConfigurationView;

  const result = projectConnections({
    configuration,
    providerSync: {
      schemaVersion: 2,
      revision: `sha256:${"c".repeat(64)}`,
      observationRevision: `sha256:${"d".repeat(64)}`,
      operationRevision: `sha256:${"e".repeat(64)}`,
      operations: [],
      providers: [{
        schemaVersion: 1,
        observationId: "obs-1",
        operation: "inspection",
        provider: "github",
        configuredTarget: { kind: "repository", key: "netpilot-z/TaskSeal" },
        observedScope: { kind: "repository", key: "netpilot-z/TaskSeal", parentKey: null },
        status: "snapshot_ready",
        startedAt: "2026-08-07T00:00:00.000Z",
        observedAt: "2026-08-07T00:01:00.000Z",
        sourceRevisions: [],
        snapshotDigest: null,
        mappingDigest: null,
        planDigest: null,
        missingEvidence: [],
        diagnosticCode: null,
        resolution: null
      }]
    },
    now: new Date("2026-08-07T00:02:00.000Z")
  });

  assert.equal(result.schemaVersion, "connections/v1");
  assert.equal(result.connections[0]?.connectivity.status, "observed");
  assert.equal(result.connections[1]?.connectivity.status, "not-probed");
  assert.equal(result.connections[0]?.activation, "next-operation");
  assert.deepEqual(result.connections[0]?.credential.bindings, ["env:GITHUB_TOKEN"]);
  assert.doesNotMatch(JSON.stringify(result), /secret-value|token-value/i);
});
