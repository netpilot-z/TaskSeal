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

test("AdapterManifest v1 declares environment credential references without values", () => {
  const adapter = createAdapter({
    credential: {
      mode: "environment",
      references: [
        {
          key: "app-id",
          environmentVariable:
            "TASKSEAL_FEISHU_APP_ID",
          secret: true
        },
        {
          key: "app-secret",
          environmentVariable:
            "TASKSEAL_FEISHU_APP_SECRET",
          secret: true
        }
      ]
    }
  });

  const normalized = normalizeProviderAdapterV1(adapter);

  assert.deepEqual(
    normalized.manifest.credential,
    adapter.manifest.credential
  );
  assert.doesNotMatch(
    JSON.stringify(normalized),
    /credential-value/
  );
});

test("AdapterManifest v1 rejects unsafe environment credential references", () => {
  const invalidCredentials = [
    {
      mode: "environment",
      references: []
    },
    {
      mode: "environment",
      references: [
        {
          key: "app-id",
          environmentVariable:
            "TASKSEAL_FEISHU_APP_ID",
          secret: false
        }
      ]
    },
    {
      mode: "environment",
      references: [
        {
          key: "app-id",
          environmentVariable:
            "taskseal_feishu_app_id",
          secret: true
        }
      ]
    },
    {
      mode: "environment",
      references: [
        {
          key: "app-id",
          environmentVariable:
            "TASKSEAL_FEISHU_APP_ID",
          secret: true,
          value: "credential-value"
        }
      ]
    },
    {
      mode: "environment",
      references: [
        {
          key: "app-id",
          environmentVariable:
            "TASKSEAL_FEISHU_APP_ID",
          secret: true
        },
        {
          key: "app-id",
          environmentVariable:
            "TASKSEAL_FEISHU_APP_SECRET",
          secret: true
        }
      ]
    },
    {
      mode: "environment",
      references: [
        {
          key: "app-id",
          environmentVariable:
            "TASKSEAL_FEISHU_APP_ID",
          secret: true
        },
        {
          key: "app-secret",
          environmentVariable:
            "TASKSEAL_FEISHU_APP_ID",
          secret: true
        }
      ]
    }
  ];

  for (const credential of invalidCredentials) {
    assert.throws(
      () =>
        normalizeProviderAdapterV1(
          createAdapter({ credential })
        ),
      hasCode("PROVIDER_ADAPTER_INVALID")
    );
  }

  const accessorReference = Object.defineProperty(
    {
      key: "app-secret",
      secret: true
    },
    "environmentVariable",
    {
      enumerable: true,
      get() {
        return "TASKSEAL_FEISHU_APP_SECRET";
      }
    }
  );

  assert.throws(
    () =>
      normalizeProviderAdapterV1(
        createAdapter({
          credential: {
            mode: "environment",
            references: [accessorReference]
          }
        })
      ),
    hasCode("PROVIDER_ADAPTER_INVALID")
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

function createAdapter({
  credential = {
    mode: "none"
  }
}: {
  credential?: unknown;
} = {}) {
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
      credential,
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
