import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";

import {
  createLinearGraphqlHttpExchange,
  LINEAR_GRAPHQL_REQUEST_BYTE_LIMIT,
  LINEAR_GRAPHQL_RESPONSE_BYTE_LIMIT
} from "../src/connectors/linear-graphql-http-exchange.ts";

const REQUEST = Object.freeze({
  schemaVersion: 1,
  operation: "issue_by_id",
  body: JSON.stringify({
    operationName: "TaskSealQueryIssue",
    query: "query TaskSealQueryIssue { viewer { id } }",
    variables: {}
  })
} as const);

test("Linear HTTP exchange sends one fixed, bounded POST with API-key auth", async () => {
  const calls: Array<{
    url: string;
    options: Record<string, unknown>;
  }> = [];
  const exchange = createLinearGraphqlHttpExchange({
    apiKey: "linear-api-key",
    fetchImpl: async (
      url: string,
      options: Record<string, unknown>
    ) => {
      calls.push({ url, options });
      return streamResponse(
        200,
        JSON.stringify({ data: { viewer: { id: "v1" } } }),
        7
      );
    },
    timeoutMs: 1234
  });

  const result = await exchange(REQUEST);

  assert.deepEqual(result, {
    kind: "response",
    status: 200,
    body: JSON.stringify({
      data: { viewer: { id: "v1" } }
    })
  });
  assert.equal(calls.length, 1);
  const call = requireItem(calls, 0);
  assert.equal(
    call.url,
    "https://api.linear.app/graphql"
  );
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.redirect, "error");
  assert.equal(call.options.body, REQUEST.body);
  assert.deepEqual(call.options.headers, {
    Authorization: "linear-api-key",
    "Content-Type": "application/json"
  });
  assert.equal(
    call.options.signal instanceof AbortSignal,
    true
  );
});

test("Linear HTTP exchange uses Bearer only for OAuth access tokens", async () => {
  let authorization: unknown;
  const exchange = createLinearGraphqlHttpExchange({
    accessToken: "oauth-token",
    fetchImpl: async (
      _url: string,
      options: Record<string, unknown>
    ) => {
      const headers = options.headers;
      authorization =
        headers &&
        typeof headers === "object" &&
        "Authorization" in headers
          ? headers.Authorization
          : undefined;
      return streamResponse(200, "{\"data\":{}}");
    }
  });

  await exchange(REQUEST);
  assert.equal(authorization, "Bearer oauth-token");
});

test("Linear HTTP exchange accepts the native fetch Response shape", async () => {
  const exchange = createLinearGraphqlHttpExchange({
    apiKey: "linear-api-key",
    fetchImpl: async () =>
      new Response("{\"data\":{\"ok\":true}}", {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      })
  });

  assert.deepEqual(await exchange(REQUEST), {
    kind: "response",
    status: 200,
    body: "{\"data\":{\"ok\":true}}"
  });
});

test("Linear HTTP exchange proves only pre-fetch validation failures were not dispatched", async () => {
  let calls = 0;
  const exchange = createLinearGraphqlHttpExchange({
    apiKey: "linear-api-key",
    fetchImpl: async () => {
      calls += 1;
      return streamResponse(200, "{\"data\":{}}");
    }
  });

  assert.deepEqual(
    await exchange({
      ...REQUEST,
      schemaVersion: 2
    }),
    { kind: "not_dispatched" }
  );
  assert.equal(calls, 0);

  assert.deepEqual(
    await exchange({
      ...REQUEST,
      body: "x".repeat(
        LINEAR_GRAPHQL_REQUEST_BYTE_LIMIT + 1
      )
    }),
    { kind: "not_dispatched" }
  );
  assert.equal(calls, 0);
});

test("Linear HTTP exchange fences every post-dispatch uncertainty as response lost", async (t) => {
  const secret = "SECRET_LINEAR_PROVIDER_BODY";
  const cases = [
    {
      name: "fetch throws",
      fetchImpl: async () => {
        throw new Error(secret);
      }
    },
    {
      name: "response body is oversized",
      fetchImpl: async () =>
        streamResponse(
          200,
          "x".repeat(
            LINEAR_GRAPHQL_RESPONSE_BYTE_LIMIT + 1
          )
        )
    },
    {
      name: "response shape is invalid",
      fetchImpl: async () => ({ status: 200 })
    }
  ];

  for (const current of cases) {
    await t.test(current.name, async () => {
      const exchange = createLinearGraphqlHttpExchange({
        apiKey: "linear-api-key",
        fetchImpl: current.fetchImpl
      });
      const result = await exchange(REQUEST);
      assert.deepEqual(result, {
        kind: "response_lost"
      });
      assert.doesNotMatch(
        inspect(result, { depth: null }),
        new RegExp(secret)
      );
    });
  }
});

test("Linear HTTP exchange rejects unsafe credential and timeout configuration without leaking values", () => {
  const secret = "SECRET_CONFLICTING_TOKEN";

  for (const options of [
    {},
    {
      apiKey: secret,
      accessToken: "oauth"
    },
    {
      apiKey: `${secret}\nsecond-line`
    },
    {
      apiKey: secret,
      timeoutMs: 0
    }
  ]) {
    assert.throws(
      () => createLinearGraphqlHttpExchange(options),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        String(error.code).startsWith(
          "LINEAR_HTTP_EXCHANGE_"
        ) &&
        !inspect(error, { depth: null }).includes(secret)
    );
  }
});

test("Linear HTTP exchange redacts adversarial option and post-dispatch response traps", async () => {
  const secret = "SECRET_EXCHANGE_TRAP";
  const hostile = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error(secret);
      }
    }
  );

  assert.throws(
    () => createLinearGraphqlHttpExchange(hostile),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code ===
        "LINEAR_HTTP_EXCHANGE_INPUT_INVALID" &&
      !inspect(error, { depth: null }).includes(secret)
  );

  const exchange = createLinearGraphqlHttpExchange({
    apiKey: "linear-api-key",
    fetchImpl: async () => hostile
  });

  const result = await exchange(REQUEST);
  assert.deepEqual(result, {
    kind: "response_lost"
  });
  assert.doesNotMatch(
    inspect(result, { depth: null }),
    new RegExp(secret)
  );
});

test("Linear HTTP exchange enforces its own timeout when injected fetch ignores AbortSignal", async () => {
  const exchange = createLinearGraphqlHttpExchange({
    apiKey: "linear-api-key",
    timeoutMs: 5,
    fetchImpl: async () =>
      new Promise<never>(() => {
        // Deliberately ignores the supplied AbortSignal.
      })
  });

  assert.deepEqual(await exchange(REQUEST), {
    kind: "response_lost"
  });
});

test("Linear HTTP exchange rejects empty chunks and enforces a monotonic streaming deadline", async (t) => {
  await t.test("empty chunk", async () => {
    const exchange =
      createLinearGraphqlHttpExchange({
        apiKey: "linear-api-key",
        fetchImpl: async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(
                  new Uint8Array(0)
                );
                controller.close();
              }
            })
          )
      });

    assert.deepEqual(await exchange(REQUEST), {
      kind: "response_lost"
    });
  });

  await t.test(
    "microtask-heavy non-empty stream",
    async () => {
      let pulls = 0;
      const exchange =
        createLinearGraphqlHttpExchange({
          apiKey: "linear-api-key",
          timeoutMs: 1,
          fetchImpl: async () =>
            new Response(
              new ReadableStream({
                pull(controller) {
                  pulls += 1;
                  controller.enqueue(
                    new Uint8Array([120])
                  );
                }
              })
            )
        });

      assert.deepEqual(await exchange(REQUEST), {
        kind: "response_lost"
      });
      assert.equal(
        pulls <
          LINEAR_GRAPHQL_RESPONSE_BYTE_LIMIT,
        true
      );
    }
  );
});

function streamResponse(
  status: number,
  text: string,
  chunkSize = text.length || 1
): unknown {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;

  return {
    status,
    body: {
      getReader() {
        return {
          async read() {
            if (offset >= bytes.byteLength) {
              return {
                done: true,
                value: undefined
              };
            }

            const value = bytes.slice(
              offset,
              offset + chunkSize
            );
            offset += value.byteLength;
            return {
              done: false,
              value
            };
          },
          async cancel() {
            offset = bytes.byteLength;
          }
        };
      }
    }
  };
}

function requireItem<T>(
  items: readonly T[],
  index: number
): T {
  const value = items[index];

  if (!value) {
    throw new Error(`Missing item ${index}.`);
  }

  return value;
}
