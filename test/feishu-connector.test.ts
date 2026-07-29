import assert from "node:assert/strict";
import test from "node:test";

import {
  FEISHU_ADAPTER_MANIFEST,
  createFeishuAdapter
} from "../src/connectors/feishu.ts";
import type {
  FeishuReadClientPort
} from "../src/connectors/feishu.ts";
import {
  normalizeProviderAdapterV1
} from "../src/connectors/provider-adapter.ts";
import {
  DEFAULT_PROVIDER_INGRESS_REGISTRY
} from "../src/application/provider-ingress-registry.ts";

const RESOURCE = {
  appToken: "base-token",
  tableId: "table-id",
  recordId: "record-id",
  fieldMapping: {
    title: "Title",
    status: "Status",
    updatedAt: "Updated At"
  }
} as const;

test("Feishu manifest exposes only bounded health and record read", () => {
  assert.deepEqual(
    FEISHU_ADAPTER_MANIFEST.capabilities,
    ["provider.health", "work-item.read"]
  );
  assert.deepEqual(
    FEISHU_ADAPTER_MANIFEST.credential,
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
            "TASKSEAL_FEISHU_APP_SECRET",
          secret: true
        }
      ]
    }
  );
  assert.deepEqual(FEISHU_ADAPTER_MANIFEST.scopes, [
    {
      kind: "table",
      objectTypes: ["record"]
    }
  ]);

  const adapter = createFeishuAdapter({
    client: createClient()
  });
  assert.deepEqual(
    Object.keys(adapter.ports).sort(),
    ["provider.health", "work-item.read"]
  );
  assert.doesNotThrow(() =>
    normalizeProviderAdapterV1(adapter)
  );
});

test("Feishu adapter returns opaque table health and a display-only record snapshot", async () => {
  const calls: unknown[] = [];
  const adapter = createFeishuAdapter({
    client: createClient(calls),
    now: () => new Date("2026-07-29T08:00:00.000Z")
  });

  const health = await adapter.ports["provider.health"](
    RESOURCE
  );
  const snapshot = await adapter.ports["work-item.read"]({
    ...RESOURCE,
    mapping: {
      workItemId: "NP-18",
      requiredEvidence: ["tests"],
      managedFields: []
    }
  });

  assert.equal(health.provider, "feishu");
  assert.equal(health.status, "ready");
  assert.equal(health.checkedAt, "2026-07-29T08:00:00.000Z");
  assert.equal(health.scope.kind, "table");
  assert.match(
    health.scope.key,
    /^feishu:table:sha256:[0-9a-f]{64}$/
  );
  assert.match(
    health.scope.parentKey,
    /^feishu:base:sha256:[0-9a-f]{64}$/
  );
  assert.equal(health.tableName, "Work Items");
  assert.equal(health.recordCount, 3);

  assert.equal(snapshot.provider, "feishu");
  assert.equal(snapshot.scope.key, health.scope.key);
  assert.deepEqual(snapshot.mapping, {
    workItemId: "NP-18",
    requiredEvidence: ["tests"],
    managedFields: []
  });
  assert.equal(snapshot.facts.length, 1);
  const fact = snapshot.facts[0];
  assert.equal(fact?.sourceObject.objectType, "record");
  assert.match(
    fact?.sourceObject.providerObjectKey ?? "",
    /^feishu:record:sha256:[0-9a-f]{64}$/
  );
  assert.deepEqual(fact?.observed, {
    title: "Readonly token check",
    status: "Todo",
    updatedAt: "2026-07-28T02:00:00.000Z"
  });
  assert.equal(
    fact?.candidateEvent.type,
    "work_item.created"
  );
  assert.equal(
    fact?.candidateEvent.workItemId,
    "NP-18"
  );
  assert.deepEqual(calls, [
    {
      operation: "inspect",
      input: {
        appToken: RESOURCE.appToken,
        tableId: RESOURCE.tableId,
        fieldMapping: RESOURCE.fieldMapping
      }
    },
    {
      operation: "record",
      input: RESOURCE
    }
  ]);

  const rendered = JSON.stringify({ health, snapshot });
  for (const rawIdentifier of [
    RESOURCE.appToken,
    RESOURCE.tableId,
    RESOURCE.recordId
  ]) {
    assert.doesNotMatch(
      rendered,
      new RegExp(rawIdentifier)
    );
  }
});

test("Feishu adapter validates mapping before reading the provider", async () => {
  const calls: unknown[] = [];
  const adapter = createFeishuAdapter({
    client: createClient(calls)
  });

  await assert.rejects(
    adapter.ports["work-item.read"]({
      ...RESOURCE,
      mapping: {
        workItemId: "NP-18",
        requiredEvidence: [],
        managedFields: []
      }
    }),
    hasCode("FEISHU_MAPPING_INVALID")
  );
  assert.equal(calls.length, 0);
});

test("Feishu adapter rejects accessors and hostile proxies before provider I/O", async () => {
  const calls: unknown[] = [];
  const adapter = createFeishuAdapter({
    client: createClient(calls)
  });
  let getterCalls = 0;
  const accessorRequest = {
    ...RESOURCE,
    get mapping() {
      getterCalls += 1;
      return {
        workItemId: "NP-18",
        requiredEvidence: ["tests"],
        managedFields: []
      };
    }
  };

  await assert.rejects(
    adapter.ports["work-item.read"](
      accessorRequest as never
    ),
    hasCode("FEISHU_RESOURCE_INVALID")
  );
  assert.equal(getterCalls, 0);

  const evidenceWithAccessor = ["tests"];
  Object.defineProperty(evidenceWithAccessor, "0", {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return "tests";
    }
  });
  await assert.rejects(
    adapter.ports["work-item.read"]({
      ...RESOURCE,
      mapping: {
        workItemId: "NP-18",
        requiredEvidence: evidenceWithAccessor,
        managedFields: []
      }
    }),
    hasCode("FEISHU_MAPPING_INVALID")
  );
  assert.equal(getterCalls, 0);

  const hostileRequest = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("hostile ownKeys");
      }
    }
  );
  await assert.rejects(
    adapter.ports["work-item.read"](
      hostileRequest as never
    ),
    hasCode("FEISHU_RESOURCE_INVALID")
  );
  assert.equal(calls.length, 0);
});

test("Feishu read visibility does not grant snapshot import", () => {
  assert.throws(
    () =>
      DEFAULT_PROVIDER_INGRESS_REGISTRY.bind({
        provider: "feishu",
        scopeRef: {
          kind: "table",
          key:
            "feishu:table:sha256:" +
            "a".repeat(64)
        },
        requiredObjectTypes: ["record"]
      }),
    hasCode("PROVIDER_INGRESS_FORBIDDEN")
  );
});

function createClient(
  calls: unknown[] = []
): FeishuReadClientPort {
  return {
    async inspectTable(input) {
      calls.push({
        operation: "inspect",
        input
      });
      return {
        tableName: "Work Items",
        pageCount: 2,
        recordCount: 3,
        total: 3
      };
    },
    async readRecord(input) {
      calls.push({
        operation: "record",
        input
      });
      return {
        recordId: "record-id",
        title: "Readonly token check",
        status: "Todo",
        updatedAt: "2026-07-28T02:00:00.000Z"
      };
    }
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}
