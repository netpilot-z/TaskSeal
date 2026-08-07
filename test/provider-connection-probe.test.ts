import assert from "node:assert/strict";
import test from "node:test";

import {
  createProviderConnectionProbe
} from "../src/application/provider-connection-probe.ts";
import type {
  ConfigurationView
} from "../src/application/configuration-control.ts";

function configuration(): ConfigurationView {
  return {
    schemaVersion: "configuration-view/v1",
    revision: "sha256:revision",
    runtimeRevision: "sha256:runtime",
    source: { path: "config/project.json", status: "loaded", revision: "sha256:source" },
    sources: [],
    effective: {
      project: "TaskSeal",
      github: { repository: "owner/repository" },
      linear: { workspace: "workspace", team: "team", project: "project" }
    },
    fields: [],
    definitions: [],
    integrations: [
      {
        id: "github",
        configured: true,
        capability: "ready",
        credential: { requirement: "optional", status: "not-required", bindings: [] },
        setupUrl: "https://github.com"
      },
      {
        id: "linear",
        configured: true,
        capability: "ready",
        credential: { requirement: "required", status: "present", bindings: ["env:LINEAR_API_KEY"] },
        setupUrl: "https://linear.app"
      },
      {
        id: "gitee",
        configured: false,
        capability: "disabled",
        credential: { requirement: "none", status: "not-configured", bindings: [] },
        setupUrl: "https://gitee.com"
      },
      {
        id: "feishu",
        configured: false,
        capability: "disabled",
        credential: { requirement: "required", status: "not-configured", bindings: [] },
        setupUrl: "https://open.feishu.cn"
      }
    ],
    diagnostics: [],
    capabilities: { github: "ready", linear: "ready", gitee: "disabled", feishu: "disabled" },
    ready: true
  };
}

test("provider connection probe verifies GitHub with one bounded read-only request", async () => {
  let calls = 0;
  const probe = createProviderConnectionProbe({
    cwd: ".",
    environment: { GITHUB_TOKEN: "token" },
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, "https://api.github.com/repos/owner/repository");
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      return { ok: true, status: 200 };
    }
  });
  const result = await probe.probe({
    provider: "github",
    expectedConfigurationRevision: "sha256:revision",
    configuration: configuration(),
    providerSync: null
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "connected");
  assert.equal(result.networkAttempted, true);
  assert.equal(result.basis, "configuration-and-network");
});

test("provider connection probe redacts an authorization failure into a stable status", async () => {
  const result = await createProviderConnectionProbe({
    cwd: ".",
    environment: { GITHUB_TOKEN: "token" },
    fetchImpl: async () => ({ ok: false, status: 401 })
  }).probe({
    provider: "github",
    expectedConfigurationRevision: "sha256:revision",
    configuration: configuration(),
    providerSync: null
  });
  assert.equal(result.status, "unauthorized");
  assert.equal(result.networkAttempted, true);
  assert.doesNotMatch(result.summary, /token/);
});
