import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectionProbeError,
  probeConfiguration
} from "../src/application/connection-probe.ts";
import type { ConfigurationView } from "../src/application/configuration-control.ts";

function configuration(overrides: Record<string, unknown> = {}) {
  return {
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
        credential: { requirement: "optional", status: "present", bindings: ["env:GITHUB_TOKEN"] },
        setupUrl: "https://github.com/settings/tokens"
      },
      {
        id: "linear",
        configured: true,
        capability: "ready",
        credential: { requirement: "required", status: "missing", bindings: ["env:LINEAR_ACCESS_TOKEN"] },
        setupUrl: "https://linear.app/settings/api"
      }
    ],
    diagnostics: [],
    capabilities: { github: "ready", linear: "ready", gitee: "disabled", feishu: "disabled" },
    ready: true,
    ...overrides
  } as unknown as ConfigurationView;
}

test("explicit probe reports configuration and persisted observation without network I/O", () => {
  const result = probeConfiguration({
    provider: "github",
    expectedConfigurationRevision: `sha256:${"a".repeat(64)}`,
    configuration: configuration(),
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

  assert.equal(result.status, "observed");
  assert.equal(result.networkAttempted, false);
  assert.equal(result.observedAt, "2026-08-07T00:01:00.000Z");
  assert.doesNotMatch(JSON.stringify(result), /GITHUB_TOKEN|secret-value|token-value/i);
});

test("explicit probe refuses stale configuration revisions", () => {
  assert.throws(
    () => probeConfiguration({
      provider: "github",
      expectedConfigurationRevision: `sha256:${"f".repeat(64)}`,
      configuration: configuration(),
      providerSync: null
    }),
    (error: unknown) =>
      error instanceof ConnectionProbeError &&
      error.code === "CONNECTION_REVISION_CONFLICT"
  );
});

test("explicit probe distinguishes missing required credentials", () => {
  const result = probeConfiguration({
    provider: "linear",
    expectedConfigurationRevision: `sha256:${"a".repeat(64)}`,
    configuration: configuration(),
    providerSync: null
  });
  assert.equal(result.status, "credential-missing");
});
