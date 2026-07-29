import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectFeishuHealthProvider,
  inspectFeishuProvider
} from "../src/application/provider-inspection.ts";
import {
  createFeishuTableScope
} from "../src/lib/feishu-identity.ts";
import type {
  ProjectConfiguration
} from "../src/config/project-config.ts";
import type {
  FeishuFetchRequestOptions
} from "../src/connectors/feishu-read-client.ts";

const ENVIRONMENT = {
  TASKSEAL_FEISHU_APP_ID: "app-id",
  TASKSEAL_FEISHU_APP_SECRET: "credential-secret",
  TASKSEAL_FEISHU_APP_TOKEN: "base-token",
  TASKSEAL_FEISHU_TABLE_ID: "table-id",
  TASKSEAL_FEISHU_RECORD_ID: "record-id",
  TASKSEAL_FEISHU_TITLE_FIELD: "Title",
  TASKSEAL_FEISHU_STATUS_FIELD: "Status",
  TASKSEAL_FEISHU_UPDATED_AT_FIELD: "Updated At"
} as const;

const CONFIGURATION: ProjectConfiguration = {
  project: "TaskSeal",
  feishu: {
    enabled: true,
    tableScopeKey: createFeishuTableScope({
      appToken:
        ENVIRONMENT.TASKSEAL_FEISHU_APP_TOKEN,
      tableId:
        ENVIRONMENT.TASKSEAL_FEISHU_TABLE_ID
    }).key
  }
};

test("Feishu inspection composes project config, environment credentials, Adapter and snapshot", async () => {
  const methods: string[] = [];
  const fetchImpl = createFetch(methods);
  const health = await inspectFeishuHealthProvider({
    cwd: "unused",
    configuration: CONFIGURATION,
    environment: ENVIRONMENT,
    fetchImpl,
    now: () =>
      new Date("2026-07-29T08:00:00.000Z")
  });
  const snapshot = await inspectFeishuProvider({
    cwd: "unused",
    configuration: CONFIGURATION,
    environment: ENVIRONMENT,
    fetchImpl,
    workItemId: "NP-18",
    requiredEvidence: ["tests"],
    snapshotVersion: 2,
    managedFields: [],
    now: () =>
      new Date("2026-07-29T08:01:00.000Z")
  });

  assert.equal(health.provider, "feishu");
  assert.equal(health.recordCount, 3);
  assert.equal(snapshot.provider, "feishu");
  assert.equal(snapshot.facts[0]?.observed.status, "Todo");
  assert.equal(snapshot.mapping.workItemId, "NP-18");
  assert.equal(
    JSON.stringify({ health, snapshot }).includes(
      ENVIRONMENT.TASKSEAL_FEISHU_RECORD_ID
    ),
    false
  );
  assert.equal(
    methods.every(
      (method) =>
        method === "GET" || method === "POST"
    ),
    true
  );
  assert.equal(methods.includes("PUT"), false);
  assert.equal(methods.includes("DELETE"), false);
});

test("Feishu inspection fails before fetch when credentials are absent", async () => {
  let calls = 0;
  await assert.rejects(
    inspectFeishuHealthProvider({
      cwd: "unused",
      configuration: CONFIGURATION,
      environment: {
        ...ENVIRONMENT,
        TASKSEAL_FEISHU_APP_SECRET: undefined
      },
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}");
      }
    }),
    hasCode("FEISHU_CONFIG_INVALID")
  );
  assert.equal(calls, 0);
});

function createFetch(methods: string[]) {
  return async (
    url: string,
    options: FeishuFetchRequestOptions
  ) => {
    methods.push(options.method);
    if (url.includes("/auth/")) {
      return response({
        code: 0,
        msg: "ok",
        tenant_access_token: "tenant-token",
        expire: 7_200
      });
    }
    if (url.includes("/tables?")) {
      return response({
        code: 0,
        msg: "ok",
        data: {
          has_more: false,
          total: 1,
          items: [
            {
              table_id: "table-id",
              name: "Work Items",
              revision: 1
            }
          ]
        }
      });
    }
    if (url.includes("/fields?")) {
      return response({
        code: 0,
        msg: "ok",
        data: {
          has_more: false,
          items: [
            {
              field_id: "title-field",
              field_name: "Title",
              type: 1
            },
            {
              field_id: "status-field",
              field_name: "Status",
              type: 3
            },
            {
              field_id: "updated-field",
              field_name: "Updated At",
              type: 5
            }
          ]
        }
      });
    }
    if (
      url.includes("/records/search") &&
      !url.includes("page_token")
    ) {
      return response({
        code: 0,
        msg: "ok",
        data: {
          has_more: true,
          page_token: "next==",
          total: 3,
          items: [
            { record_id: "record-1", fields: {} },
            { record_id: "record-2", fields: {} }
          ]
        }
      });
    }
    if (url.includes("/records/search")) {
      return response({
        code: 0,
        msg: "ok",
        data: {
          has_more: false,
          total: 3,
          items: [
            { record_id: "record-3", fields: {} }
          ]
        }
      });
    }
    return response({
      code: 0,
      msg: "ok",
      data: {
        record: {
          record_id: "record-id",
          fields: {
            Title: "Readonly token check",
            Status: "Todo",
            "Updated At": 1_785_204_000_000
          }
        }
      }
    });
  };
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}
