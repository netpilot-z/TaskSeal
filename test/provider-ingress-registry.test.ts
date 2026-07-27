import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PROVIDER_INGRESS_REGISTRY,
  authorizeProviderIngress,
  createProviderIngressRegistry
} from "../src/application/provider-ingress-registry.ts";

test("the built-in ingress registry explicitly binds supported import targets", () => {
  assert.deepEqual(
    authorizeProviderIngress({
      registry: DEFAULT_PROVIDER_INGRESS_REGISTRY,
      provider: "github",
      scopeRef: {
        kind: "repository",
        key: "github:repository:netpilot-z/taskseal"
      },
      requiredObjectTypes: ["issue", "check"]
    }),
    {
      schemaVersion: 1,
      capability: "snapshot.import",
      provider: "github",
      scopeKind: "repository",
      requiredObjectTypes: ["check", "issue"]
    }
  );

  assert.deepEqual(
    authorizeProviderIngress({
      registry: DEFAULT_PROVIDER_INGRESS_REGISTRY,
      provider: "gitee",
      scopeRef: {
        kind: "repository",
        key: "gitee:repository:oschina/git-osc"
      },
      requiredObjectTypes: ["issue"]
    }),
    {
      schemaVersion: 1,
      capability: "snapshot.import",
      provider: "gitee",
      scopeKind: "repository",
      requiredObjectTypes: ["issue"]
    }
  );
});

test("registry authorization fails closed for unknown, revoked, or unsupported targets", () => {
  const revoked = createProviderIngressRegistry([]);
  const cases = [
    {
      registry: DEFAULT_PROVIDER_INGRESS_REGISTRY,
      provider: "unknown",
      scopeRef: {
        kind: "repository",
        key: "unknown:repository:owner/repo"
      },
      requiredObjectTypes: ["issue"]
    },
    {
      registry: revoked,
      provider: "github",
      scopeRef: {
        kind: "repository",
        key: "github:repository:netpilot-z/taskseal"
      },
      requiredObjectTypes: ["issue"]
    },
    {
      registry: DEFAULT_PROVIDER_INGRESS_REGISTRY,
      provider: "linear",
      scopeRef: {
        kind: "repository",
        key: "linear:repository:netpilot-z/taskseal"
      },
      requiredObjectTypes: ["issue"]
    },
    {
      registry: DEFAULT_PROVIDER_INGRESS_REGISTRY,
      provider: "gitee",
      scopeRef: {
        kind: "repository",
        key: "gitee:repository:oschina/git-osc"
      },
      requiredObjectTypes: ["pull_request"]
    }
  ];

  for (const input of cases) {
    assert.throws(
      () => authorizeProviderIngress(input),
      hasCode("PROVIDER_INGRESS_FORBIDDEN")
    );
  }
});

test("registry definitions are strict, deterministic, and do not infer import from read manifests", () => {
  const registration = {
    schemaVersion: 1,
    provider: "example",
    capability: "snapshot.import",
    validator() {
      return true;
    },
    scopes: [
      {
        kind: "repository",
        objectTypes: ["issue"]
      }
    ]
  };
  const registry = createProviderIngressRegistry([
    registration
  ]);

  assert.deepEqual(
    authorizeProviderIngress({
      registry,
      provider: "example",
      scopeRef: {
        kind: "repository",
        key: "example:repository:owner/repo"
      },
      requiredObjectTypes: ["issue"]
    }),
    {
      schemaVersion: 1,
      capability: "snapshot.import",
      provider: "example",
      scopeKind: "repository",
      requiredObjectTypes: ["issue"]
    }
  );

  for (const definitions of [
    [registration, { ...registration }],
    [{
      ...registration,
      capabilities: ["work-item.read"]
    }],
    [{
      ...registration,
      scopes: [{
        kind: "repository",
        objectTypes: ["issue", "issue"]
      }]
    }]
  ]) {
    assert.throws(
      () => createProviderIngressRegistry(definitions),
      hasCode("PROVIDER_INGRESS_REGISTRY_INVALID")
    );
  }
});

test("arbitrary registry failures are normalized without leaking their cause", () => {
  const secret = "SECRET_REGISTRY_DETAIL";
  const registry = {
    bind() {
      throw new Error(secret);
    }
  };

  assert.throws(
    () =>
      authorizeProviderIngress({
        registry,
        provider: "github",
        scopeRef: {
          kind: "repository",
          key: "github:repository:netpilot-z/taskseal"
        },
        requiredObjectTypes: ["issue"]
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "PROVIDER_INGRESS_FORBIDDEN" &&
      !error.message.includes(secret) &&
      !("cause" in error)
  );
});

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}
