import assert from "node:assert/strict";
import test from "node:test";

import {
  FEISHU_RESPONSE_BYTE_LIMIT,
  FeishuReadClient
} from "../src/connectors/feishu-read-client.ts";
import type {
  FeishuFetchRequestOptions
} from "../src/connectors/feishu-read-client.ts";

interface RequestCall {
  readonly url: string;
  readonly options: FeishuFetchRequestOptions;
}

const SCOPE = {
  appToken: "base-token",
  tableId: "table-id",
  fieldMapping: {
    title: "Title",
    status: "Status",
    updatedAt: "Updated At"
  }
} as const;

const FIELDS = [
  {
    field_id: "field-key",
    field_name: "Task Key",
    type: 1,
    ui_type: "Text",
    is_primary: true
  },
  {
    field_id: "field-note",
    field_name: "Ignored Note",
    type: 1,
    ui_type: "Text",
    is_primary: false
  },
  {
    field_id: "field-updated",
    field_name: "Updated At",
    type: 5,
    ui_type: "DateTime",
    is_primary: false
  },
  {
    field_id: "field-status",
    field_name: "Status",
    type: 3,
    ui_type: "SingleSelect",
    is_primary: false
  },
  {
    field_id: "field-title",
    field_name: "Title",
    type: 1,
    ui_type: "Text",
    is_primary: false
  }
] as const;

const RECORD = {
  record_id: "record-target",
  fields: {
    "Task Key": "TS-001",
    Title: "Ship the read-only adapter",
    Status: "In Progress",
    "Updated At": 1_785_204_000_000,
    "Ignored Note": "must not survive normalization"
  }
} as const;

test("Feishu inspects one bounded table and normalizes one mapped record", async () => {
  const calls: RequestCall[] = [];
  const client = new FeishuReadClient({
    appId: "app-id",
    appSecret: "credential-secret",
    fetchImpl: createHappyFetch(calls)
  });

  const inspection = await client.inspectTable(SCOPE);
  const record = await client.readRecord({
    ...SCOPE,
    recordId: "record-target"
  });

  assert.deepEqual(inspection, {
    tableName: "TaskSeal Pilot",
    pageCount: 2,
    recordCount: 3,
    total: 3
  });
  assert.deepEqual(record, {
    recordId: "record-target",
    title: "Ship the read-only adapter",
    status: "In Progress",
    updatedAt: "2026-07-28T02:00:00.000Z"
  });
  assert.equal(
    JSON.stringify({ inspection, record }).includes(
      "must not survive normalization"
    ),
    false
  );

  const authCalls = calls.filter((call) =>
    call.url.endsWith(
      "/auth/v3/tenant_access_token/internal"
    )
  );
  assert.equal(authCalls.length, 1);
  assert.deepEqual(
    JSON.parse(requireBody(authCalls[0])),
    {
      app_id: "app-id",
      app_secret: "credential-secret"
    }
  );

  const providerCalls = calls.filter(
    (call) => !authCalls.includes(call)
  );
  assert.equal(
    providerCalls.every(
      (call) =>
        call.options.headers.Authorization ===
        "Bearer tenant-token"
    ),
    true
  );
  assert.deepEqual(
    providerCalls.map((call) => call.options.method),
    ["GET", "GET", "POST", "POST", "GET", "GET"]
  );
  assert.equal(
    providerCalls.every(
      (call) =>
        call.options.redirect === "error" &&
        call.options.signal instanceof AbortSignal
    ),
    true
  );
  assert.equal(
    providerCalls.filter(
      (call) => call.options.method === "POST"
    ).every(
      (call) =>
        new URL(call.url).pathname.endsWith(
          "/records/search"
        ) && requireBody(call) === "{}"
    ),
    true
  );
  assert.equal(
    new URL(providerCalls[2]?.url ?? "").searchParams.get(
      "page_size"
    ),
    "2"
  );
  assert.equal(
    new URL(providerCalls[3]?.url ?? "").searchParams.get(
      "page_token"
    ),
    "next-page=="
  );
});

test("Feishu coalesces tenant token requests and refreshes inside the safety window", async () => {
  let now = 1_000;
  let authCalls = 0;
  const client = new FeishuReadClient({
    appId: "app-id",
    appSecret: "credential-secret",
    now: () => now,
    fetchImpl: async (url: string) => {
      if (
        url.endsWith(
          "/auth/v3/tenant_access_token/internal"
        )
      ) {
        authCalls += 1;
        return textResponse({
          code: 0,
          msg: "ok",
          tenant_access_token: `tenant-token-${authCalls}`,
          expire: 7_200
        });
      }
      if (url.includes("/tables?")) {
        return tablesResponse();
      }
      if (url.includes("/fields?")) {
        return fieldsResponse();
      }
      return searchResponse([], false, undefined, 0);
    }
  });

  await Promise.all([
    client.inspectTable(SCOPE),
    client.inspectTable(SCOPE)
  ]);
  assert.equal(authCalls, 1);

  now += 5_500_000;
  await client.inspectTable(SCOPE);
  assert.equal(authCalls, 2);
});

test("Feishu fails closed on field drift and never dispatches a record read", async () => {
  let recordCalls = 0;
  const client = new FeishuReadClient({
    appId: "app-id",
    appSecret: "credential-secret",
    fetchImpl: async (url: string) => {
      if (url.includes("/auth/")) {
        return tokenResponse();
      }
      if (url.includes("/fields?")) {
        return textResponse({
          code: 0,
          msg: "ok",
          data: {
            has_more: false,
            items: FIELDS.map((field) =>
              field.field_name === "Status"
                ? { ...field, type: 1 }
                : field
            )
          }
        });
      }
      if (url.includes("/records/")) {
        recordCalls += 1;
      }
      return textResponse({
        code: 0,
        msg: "ok",
        data: {}
      });
    }
  });

  await assert.rejects(
    client.readRecord({
      ...SCOPE,
      recordId: "record-target"
    }),
    hasCode("FEISHU_FIELD_MAPPING_INVALID")
  );
  assert.equal(recordCalls, 0);
});

test("Feishu bounds pagination and rejects repeated page tokens", async () => {
  let searchCalls = 0;
  const client = new FeishuReadClient({
    appId: "app-id",
    appSecret: "credential-secret",
    fetchImpl: async (url: string) => {
      if (url.includes("/auth/")) {
        return tokenResponse();
      }
      if (url.includes("/tables?")) {
        return tablesResponse();
      }
      if (url.includes("/fields?")) {
        return fieldsResponse();
      }
      searchCalls += 1;
      return searchResponse(
        [
          {
            record_id: `record-${searchCalls}`,
            fields: {}
          }
        ],
        true,
        "same-token",
        3
      );
    }
  });

  await assert.rejects(
    client.inspectTable(SCOPE),
    hasCode("FEISHU_PAGINATION_INVALID")
  );
  assert.equal(searchCalls, 2);
});

test("Feishu redacts credentials and provider messages from stable errors", async () => {
  const secret = "credential-secret";
  const client = new FeishuReadClient({
    appId: "app-id",
    appSecret: secret,
    fetchImpl: async () =>
      textResponse({
        code: 99,
        msg: `provider leaked ${secret}`
      })
  });

  let error: unknown;
  try {
    await client.inspectTable(SCOPE);
  } catch (caught) {
    error = caught;
  }

  assert.equal(readErrorCode(error), "FEISHU_AUTH_FAILED");
  assert.doesNotMatch(
    error instanceof Error ? error.message : String(error),
    new RegExp(secret)
  );

  const transportClient = new FeishuReadClient({
    appId: "app-id",
    appSecret: secret,
    fetchImpl: async () => {
      throw new Error(`transport leaked ${secret}`);
    }
  });

  await assert.rejects(
    transportClient.inspectTable(SCOPE),
    hasCode("FEISHU_REQUEST_FAILED")
  );
});

test("Feishu validates all caller input and bounded response bytes before use", async () => {
  let calls = 0;
  const client = new FeishuReadClient({
    appId: "app-id",
    appSecret: "credential-secret",
    fetchImpl: async () => {
      calls += 1;
      return tokenResponse();
    }
  });

  await assert.rejects(
    client.inspectTable({
      ...SCOPE,
      appToken: "../foreign"
    }),
    hasCode("FEISHU_INPUT_INVALID")
  );
  assert.equal(calls, 0);

  const oversized = new FeishuReadClient({
    appId: "app-id",
    appSecret: "credential-secret",
    fetchImpl: async () =>
      rawTextResponse("{}", {
        "content-length": String(
          FEISHU_RESPONSE_BYTE_LIMIT + 1
        )
      })
  });

  await assert.rejects(
    oversized.inspectTable(SCOPE),
    hasCode("FEISHU_RESPONSE_TOO_LARGE")
  );
});

test("Feishu reads native Response bodies with the original receiver", async () => {
  let calls = 0;
  const client = new FeishuReadClient({
    appId: "app-id",
    appSecret: "credential-secret",
    fetchImpl: async () => {
      calls += 1;
      return new Response(
        JSON.stringify(
          calls === 1
            ? {
                code: 0,
                msg: "ok",
                tenant_access_token: "tenant-token",
                expire: 7_200
              }
            : {
                code: 99,
                msg: "provider error"
              }
        ),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }
  });

  await assert.rejects(
    client.inspectTable(SCOPE),
    hasCode("FEISHU_API_ERROR")
  );
  assert.equal(calls, 2);
});

test("Feishu owns its deadline when a custom fetch ignores AbortSignal", async () => {
  const client = new FeishuReadClient({
    appId: "app-id",
    appSecret: "credential-secret",
    timeoutMs: 10,
    fetchImpl: () => new Promise(() => {})
  });

  const result = await Promise.race([
    client.inspectTable(SCOPE).then(
      () => "resolved",
      (error: unknown) => readErrorCode(error)
    ),
    new Promise<string>((resolve) => {
      setTimeout(() => resolve("still-pending"), 50);
    })
  ]);

  assert.equal(result, "FEISHU_REQUEST_FAILED");
});

test("Feishu classifies malformed provider data separately from hostile caller input", async () => {
  let getterCalls = 0;
  let fetchCalls = 0;
  const fieldMapping = Object.defineProperty(
    {
      status: "Status",
      updatedAt: "Updated At"
    },
    "title",
    {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "Title";
      }
    }
  );
  const client = new FeishuReadClient({
    appId: "app-id",
    appSecret: "credential-secret",
    fetchImpl: async () => {
      fetchCalls += 1;
      return tokenResponse();
    }
  });

  await assert.rejects(
    client.inspectTable({
      ...SCOPE,
      fieldMapping
    }),
    hasCode("FEISHU_INPUT_INVALID")
  );
  assert.equal(getterCalls, 0);
  assert.equal(fetchCalls, 0);

  let responseCalls = 0;
  const malformed = new FeishuReadClient({
    appId: "app-id",
    appSecret: "credential-secret",
    fetchImpl: async () => {
      responseCalls += 1;
      return responseCalls === 1
        ? tokenResponse()
        : textResponse({
            code: 0,
            msg: "ok",
            data: []
          });
    }
  });

  await assert.rejects(
    malformed.inspectTable(SCOPE),
    hasCode("FEISHU_RESPONSE_INVALID")
  );
});

function createHappyFetch(
  calls: RequestCall[]
) {
  return async (
    url: string,
    options: FeishuFetchRequestOptions
  ) => {
    calls.push({ url, options });

    if (url.includes("/auth/")) {
      return tokenResponse();
    }
    if (url.includes("/tables?")) {
      return tablesResponse();
    }
    if (url.includes("/fields?")) {
      return fieldsResponse();
    }
    if (
      url.includes("/records/search") &&
      !url.includes("page_token")
    ) {
      return searchResponse(
        [
          { record_id: "record-1", fields: {} },
          { record_id: "record-2", fields: {} }
        ],
        true,
        "next-page==",
        3
      );
    }
    if (url.includes("/records/search")) {
      return searchResponse(
        [{ record_id: "record-3", fields: {} }],
        false,
        undefined,
        3
      );
    }
    if (url.includes("/records/")) {
      return textResponse({
        code: 0,
        msg: "ok",
        data: { record: RECORD }
      });
    }
    assert.fail(`Unexpected Feishu URL: ${url}`);
  };
}

function tokenResponse() {
  return textResponse({
    code: 0,
    msg: "ok",
    tenant_access_token: "tenant-token",
    expire: 7_200
  });
}

function tablesResponse() {
  return textResponse({
    code: 0,
    msg: "ok",
    data: {
      has_more: false,
      total: 1,
      items: [
        {
          table_id: SCOPE.tableId,
          name: "TaskSeal Pilot",
          revision: 1
        }
      ]
    }
  });
}

function fieldsResponse() {
  return textResponse({
    code: 0,
    msg: "ok",
    data: {
      has_more: false,
      items: FIELDS
    }
  });
}

function searchResponse(
  items: readonly unknown[],
  hasMore: boolean,
  pageToken: string | undefined,
  total: number
) {
  return textResponse({
    code: 0,
    msg: "ok",
    data: {
      has_more: hasMore,
      ...(pageToken === undefined
        ? {}
        : { page_token: pageToken }),
      total,
      items
    }
  });
}

function textResponse(
  body: unknown,
  headers: Record<string, string> = {},
  status = 200
) {
  return rawTextResponse(
    JSON.stringify(body),
    headers,
    status
  );
}

function rawTextResponse(
  body: string,
  headers: Record<string, string> = {},
  status = 200
) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([name, value]) => [
      name.toLowerCase(),
      value
    ])
  );

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string): string | null {
        return normalizedHeaders.get(name.toLowerCase()) ?? null;
      }
    },
    async text() {
      return body;
    }
  };
}

function requireBody(
  call: RequestCall | undefined
): string {
  if (call?.options.body === undefined) {
    assert.fail("Expected request body.");
  }
  return call.options.body;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => readErrorCode(error) === code;
}

function readErrorCode(error: unknown): unknown {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error
  )
    ? error.code
    : undefined;
}
