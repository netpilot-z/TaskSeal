import assert from "node:assert/strict";
import test from "node:test";

import {
  GITEE_RESPONSE_BYTE_LIMIT,
  readGiteeIssue,
  readGiteeRepository
} from "../src/connectors/gitee-read-client.ts";
import type {
  GiteeFetchRequestOptions
} from "../src/connectors/gitee-read-client.ts";

interface RequestCall {
  url: string;
  options: GiteeFetchRequestOptions;
}

const REPOSITORY = {
  id: 1_322_341,
  full_name: "oschina/git-osc",
  html_url: "https://gitee.com/oschina/git-osc.git"
};

const ISSUE = {
  id: 2_614,
  number: "I4",
  title: "Git push crashes",
  html_url: "https://gitee.com/oschina/git-osc/issues/I4",
  created_at: "2013-04-12T12:15:08+08:00",
  updated_at: "2022-07-22T05:01:31+08:00",
  state: "open",
  repository: {
    id: REPOSITORY.id,
    full_name: REPOSITORY.full_name
  }
};

test("Gitee repository health performs one anonymous bounded GET", async () => {
  const calls: RequestCall[] = [];
  const result = await readGiteeRepository({
    repository: "OSChina/Git-Osc",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return textResponse(REPOSITORY);
    }
  });

  assert.deepEqual(result, {
    repository: "oschina/git-osc"
  });
  assert.equal(calls.length, 1);
  const call = requireCall(calls, 0);
  assert.equal(
    call.url,
    "https://gitee.com/api/v5/repos/OSChina/Git-Osc"
  );
  assert.equal(call.options.method, "GET");
  assert.equal(call.options.redirect, "error");
  assert.equal(call.options.headers.Accept, "application/json");
  assert.equal(call.options.headers["User-Agent"], "TaskSeal");
  assert.equal("Authorization" in call.options.headers, false);
  assert.equal(new URL(call.url).search, "");
  assert.equal(call.options.signal instanceof AbortSignal, true);
});

test("Gitee Issue read preserves the case-sensitive reference and trims raw payload", async () => {
  const calls: RequestCall[] = [];
  const result = await readGiteeIssue({
    repository: "oschina/git-osc",
    issueReference: "I4",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return textResponse(ISSUE);
    }
  });

  assert.deepEqual(result, {
    id: ISSUE.id,
    number: "I4",
    title: ISSUE.title,
    htmlUrl: ISSUE.html_url,
    createdAt: ISSUE.created_at,
    updatedAt: ISSUE.updated_at,
    repository: "oschina/git-osc"
  });
  assert.equal(
    requireCall(calls, 0).url,
    "https://gitee.com/api/v5/repos/oschina/git-osc/issues/I4"
  );
  assert.equal("state" in result, false);
});

test("Gitee rejects primitive, null, array, invalid, and oversized bodies", async (t) => {
  const invalidBodies = [null, [], 42, "invalid"] as const;

  for (const body of invalidBodies) {
    await t.test(`rejects ${String(body)}`, async () => {
      await assert.rejects(
        readGiteeRepository({
          repository: "oschina/git-osc",
          fetchImpl: async () => textResponse(body)
        }),
        hasCode("GITEE_RESPONSE_INVALID")
      );
    });
  }

  await assert.rejects(
    readGiteeRepository({
      repository: "oschina/git-osc",
      fetchImpl: async () =>
        rawTextResponse("{not-json")
    }),
    hasCode("GITEE_RESPONSE_INVALID")
  );

  await assert.rejects(
    readGiteeRepository({
      repository: "oschina/git-osc",
      fetchImpl: async () =>
        rawTextResponse(
          JSON.stringify(REPOSITORY),
          {
            "content-length": String(
              GITEE_RESPONSE_BYTE_LIMIT + 1
            )
          }
        )
    }),
    hasCode("GITEE_RESPONSE_TOO_LARGE")
  );

  await assert.rejects(
    readGiteeRepository({
      repository: "oschina/git-osc",
      fetchImpl: async () =>
        rawTextResponse(
          `"${"x".repeat(GITEE_RESPONSE_BYTE_LIMIT)}"`
        )
    }),
    hasCode("GITEE_RESPONSE_TOO_LARGE")
  );
});

test("Gitee stops a streaming response as soon as the byte limit is exceeded", async () => {
  const chunks = [
    new Uint8Array(GITEE_RESPONSE_BYTE_LIMIT),
    new Uint8Array(1)
  ];
  let reads = 0;
  let cancellations = 0;

  await assert.rejects(
    readGiteeRepository({
      repository: "oschina/git-osc",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: {
          get() {
            return null;
          }
        },
        body: {
          getReader() {
            return {
              async read() {
                const value = chunks[reads];
                reads += 1;
                return value
                  ? { done: false, value }
                  : { done: true, value: undefined };
              },
              async cancel() {
                cancellations += 1;
              }
            };
          }
        }
      })
    }),
    hasCode("GITEE_RESPONSE_TOO_LARGE")
  );
  assert.equal(reads, 2);
  assert.equal(cancellations, 1);
});

test("Gitee fails closed for scope, number, and URL drift", async (t) => {
  const issueMutations: Array<{
    name: string;
    value: unknown;
    code: string;
  }> = [
    {
      name: "repository move",
      value: {
        ...ISSUE,
        repository: { full_name: "foreign/repository" }
      },
      code: "GITEE_SCOPE_MISMATCH"
    },
    {
      name: "number case drift",
      value: { ...ISSUE, number: "i4" },
      code: "GITEE_ISSUE_REFERENCE_MISMATCH"
    },
    {
      name: "foreign host",
      value: {
        ...ISSUE,
        html_url: "https://example.test/oschina/git-osc/issues/I4"
      },
      code: "GITEE_ISSUE_URL_INVALID"
    },
    {
      name: "query-bearing URL",
      value: {
        ...ISSUE,
        html_url:
          "https://gitee.com/oschina/git-osc/issues/I4?access_token=secret"
      },
      code: "GITEE_ISSUE_URL_INVALID"
    },
    {
      name: "path drift",
      value: {
        ...ISSUE,
        html_url:
          "https://gitee.com/oschina/other/issues/I4"
      },
      code: "GITEE_ISSUE_URL_INVALID"
    }
  ];

  for (const scenario of issueMutations) {
    await t.test(scenario.name, async () => {
      await assert.rejects(
        readGiteeIssue({
          repository: "oschina/git-osc",
          issueReference: "I4",
          fetchImpl: async () =>
            textResponse(scenario.value)
        }),
        hasCode(scenario.code)
      );
    });
  }

  await assert.rejects(
    readGiteeRepository({
      repository: "oschina/git-osc",
      fetchImpl: async () =>
        textResponse({
          ...REPOSITORY,
          full_name: "foreign/repository"
        })
    }),
    hasCode("GITEE_SCOPE_MISMATCH")
  );
});

test("Gitee classifies HTTP and transport errors without echoing response content", async () => {
  const statuses = new Map([
    [401, "GITEE_AUTH_REQUIRED"],
    [403, "GITEE_FORBIDDEN"],
    [404, "GITEE_NOT_FOUND"],
    [429, "GITEE_RATE_LIMITED"],
    [503, "GITEE_HTTP_ERROR"]
  ]);
  const secret = "must-not-leak";

  for (const [status, code] of statuses) {
    let error: unknown;
    try {
      await readGiteeIssue({
        repository: "oschina/git-osc",
        issueReference: "I4",
        fetchImpl: async () =>
          rawTextResponse(
            `{"message":"${secret}"}`,
            {},
            status
          )
      });
    } catch (caught) {
      error = caught;
    }

    assert.equal(readErrorCode(error), code);
    assert.doesNotMatch(readErrorMessage(error), new RegExp(secret));
  }

  let transportError: unknown;
  try {
    await readGiteeRepository({
      repository: "oschina/git-osc",
      fetchImpl: async () => {
        throw new Error(`transport ${secret}`);
      }
    });
  } catch (caught) {
    transportError = caught;
  }

  assert.equal(
    readErrorCode(transportError),
    "GITEE_REQUEST_FAILED"
  );
  assert.doesNotMatch(
    readErrorMessage(transportError),
    new RegExp(secret)
  );
});

test("Gitee cancels a non-success response body without reading it", async () => {
  let reads = 0;
  let cancellations = 0;

  await assert.rejects(
    readGiteeRepository({
      repository: "oschina/git-osc",
      fetchImpl: async () => ({
        ok: false,
        status: 404,
        headers: {
          get() {
            return null;
          }
        },
        body: {
          getReader() {
            return {
              async read() {
                reads += 1;
                return {
                  done: false,
                  value: new Uint8Array([1])
                };
              },
              async cancel() {
                cancellations += 1;
              }
            };
          }
        }
      })
    }),
    hasCode("GITEE_NOT_FOUND")
  );
  assert.equal(reads, 0);
  assert.equal(cancellations, 1);
});

test("Gitee HTTP classification does not wait for a hanging body cancellation", async () => {
  let cancellations = 0;

  const result = await Promise.race([
    readGiteeRepository({
      repository: "oschina/git-osc",
      timeoutMs: 10,
      fetchImpl: async () => ({
        ok: false,
        status: 404,
        headers: {
          get() {
            return null;
          }
        },
        body: {
          cancel() {
            cancellations += 1;
            return new Promise(() => {});
          }
        }
      })
    }).then(
      () => "resolved",
      (error: unknown) => readErrorCode(error)
    ),
    new Promise<string>((resolve) => {
      setTimeout(() => resolve("still-pending"), 50);
    })
  ]);

  assert.equal(result, "GITEE_NOT_FOUND");
  assert.equal(cancellations, 1);
});

test("Gitee validates inputs before invoking fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return textResponse(ISSUE);
  };

  await assert.rejects(
    readGiteeIssue({
      repository: "oschina/git-osc",
      issueReference: "I4?access_token=secret",
      fetchImpl
    }),
    hasCode("GITEE_ISSUE_REFERENCE_INVALID")
  );
  await assert.rejects(
    readGiteeRepository({
      repository: "../private",
      fetchImpl
    }),
    hasCode("GITEE_REPOSITORY_INVALID")
  );
  await assert.rejects(
    readGiteeRepository({
      repository: "oschina/git-osc",
      timeoutMs: 0,
      fetchImpl
    }),
    hasCode("GITEE_TIMEOUT_INVALID")
  );
  assert.equal(calls, 0);
});

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

function requireCall(
  calls: readonly RequestCall[],
  index: number
): RequestCall {
  const call = calls[index];
  if (!call) {
    assert.fail(`Missing call ${index}.`);
  }
  return call;
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

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
