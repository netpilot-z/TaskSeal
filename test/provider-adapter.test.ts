import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeProviderAdapterV1
} from "../src/connectors/provider-adapter.ts";

test("AdapterManifest v1 binds every declared read capability to one port", () => {
  const adapter = createAdapter();
  const normalized = normalizeProviderAdapterV1(adapter);

  assert.deepEqual(normalized.manifest, adapter.manifest);
  assert.deepEqual(
    Reflect.ownKeys(normalized.ports),
    ["provider.health", "work-item.read"]
  );
  assert.equal(
    normalized.ports["provider.health"],
    adapter.ports["provider.health"]
  );
  assert.equal(
    normalized.ports["work-item.read"],
    adapter.ports["work-item.read"]
  );
});

test("AdapterManifest v1 rejects write surfaces and capability drift", () => {
  const mutations: Array<(adapter: Record<string, unknown>) => void> = [
    (adapter) => {
      const manifest = readRecord(adapter, "manifest");
      manifest.capabilities = [
        "provider.health",
        "work-item.read",
        "work-item.write"
      ];
    },
    (adapter) => {
      const manifest = readRecord(adapter, "manifest");
      manifest.capabilities = [
        "provider.health",
        "provider.health",
        "work-item.read"
      ];
    },
    (adapter) => {
      const ports = readRecord(adapter, "ports");
      ports.append = async () => undefined;
    },
    (adapter) => {
      const ports = readRecord(adapter, "ports");
      delete ports["work-item.read"];
    },
    (adapter) => {
      const manifest = readRecord(adapter, "manifest");
      manifest.method = "GET";
    },
    (adapter) => {
      const credential = readRecord(
        readRecord(adapter, "manifest"),
        "credential"
      );
      credential.reference = "GITEE_ACCESS_TOKEN";
    }
  ];

  for (const mutate of mutations) {
    const source = createAdapter();
    const adapter = {
      manifest: structuredClone(source.manifest),
      ports: { ...source.ports }
    } as unknown as Record<string, unknown>;
    mutate(adapter);

    assert.throws(
      () => normalizeProviderAdapterV1(adapter),
      hasCode("PROVIDER_ADAPTER_INVALID")
    );
  }
});

function createAdapter() {
  return {
    manifest: {
      schemaVersion: 1,
      apiVersion: "taskseal.provider/v1",
      providerId: "gitee",
      capabilities: [
        "provider.health",
        "work-item.read"
      ],
      configuration: {
        schemaVersion: 1,
        fields: [
          {
            key: "repository",
            type: "repository-coordinate",
            required: true,
            secret: false
          }
        ]
      },
      credential: {
        mode: "none"
      },
      scopes: [
        {
          kind: "repository",
          objectTypes: ["issue"]
        }
      ]
    },
    ports: {
      "provider.health": async () => ({ status: "ready" }),
      "work-item.read": async () => ({ schemaVersion: 2 })
    }
  };
}

function readRecord(
  value: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const property = value[key];

  if (
    property === null ||
    typeof property !== "object" ||
    Array.isArray(property)
  ) {
    throw new TypeError(`Expected ${key} to be an object.`);
  }

  return property as Record<string, unknown>;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}
