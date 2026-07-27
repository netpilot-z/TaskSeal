import assert from "node:assert/strict";
import test from "node:test";

import {
  readGitHubDelivery,
  readGitHubIssue
} from "../src/connectors/github-read-client.ts";
import type {
  FetchLike,
  FetchRequestOptions
} from "../src/connectors/github-read-client.ts";

interface RequestCall {
  url: string;
  options: FetchRequestOptions;
}

interface TestResponse {
  ok: boolean;
  status: number;
  headers: {
    get(name: string): string | null;
  };
  json(): Promise<unknown>;
}

const ISSUE = {
  id: 501,
  number: 1,
  title: "Prove the delivery evidence loop",
  html_url: "https://github.com/netpilot-z/TaskSeal/issues/1",
  created_at: "2026-07-26T08:00:00.000Z",
  updated_at: "2026-07-26T08:00:00.000Z"
};

const PULL_REQUEST = {
  id: 1001,
  number: 1,
  html_url: "https://github.com/netpilot-z/TaskSeal/pull/1",
  updated_at: "2026-07-26T08:03:00.000Z",
  head: { sha: "abc123" }
};

const CHECK = {
  id: 2001,
  name: "tests",
  status: "completed",
  conclusion: "success",
  head_sha: "abc123",
  details_url: "https://github.com/netpilot-z/TaskSeal/actions/runs/1",
  completed_at: "2026-07-26T08:04:00.000Z"
};

test("GitHub issue inspection reads only the explicit issue", async () => {
  const calls: RequestCall[] = [];
  const token = "github-issue-secret";

  const result = await readGitHubIssue({
    repository: "netpilot-z/TaskSeal",
    issueNumber: 1,
    token,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(ISSUE);
    }
  });

  assert.deepEqual(result, ISSUE);
  assert.equal(calls.length, 1);
  const call = requireCall(calls, 0);
  assert.equal(
    call.url,
    "https://api.github.com/repos/netpilot-z/TaskSeal/issues/1"
  );
  assert.equal(call.options.method, "GET");
  assert.equal(
    call.options.headers.Accept,
    "application/vnd.github+json"
  );
  assert.equal(
    call.options.headers["X-GitHub-Api-Version"],
    "2026-03-10"
  );
  assert.equal(
    call.options.headers["User-Agent"],
    "TaskSeal"
  );
  assert.equal(
    call.options.headers.Authorization,
    `Bearer ${token}`
  );
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
});

test("GitHub issue inspection fails closed for a PR or missing issue", async (t) => {
  await t.test("an issue-shaped PR is rejected", async () => {
    await assert.rejects(
      readGitHubIssue({
        repository: "netpilot-z/TaskSeal",
        issueNumber: 1,
        fetchImpl: async () =>
          jsonResponse({ ...ISSUE, pull_request: { url: "ignored" } })
      }),
      hasCode("GITHUB_ISSUE_IS_PULL_REQUEST")
    );
  });

  await t.test("a missing issue has a safe error", async () => {
    await assert.rejects(
      readGitHubIssue({
        repository: "netpilot-z/TaskSeal",
        issueNumber: 99,
        fetchImpl: async () =>
          jsonResponse({ message: "not found" }, { status: 404 })
      }),
      hasCode("GITHUB_NOT_FOUND")
    );
  });
});

test("GitHub rejects primitive, null, and array JSON bodies", async (t) => {
  const invalidBodies: readonly unknown[] = [
    null,
    [],
    42,
    "invalid"
  ];

  for (const body of invalidBodies) {
    await t.test(
      `rejects ${describeValue(body)}`,
      async () => {
        await assert.rejects(
          readGitHubIssue({
            repository: "netpilot-z/TaskSeal",
            issueNumber: 1,
            fetchImpl: async () =>
              jsonResponse(body)
          }),
          hasCode("GITHUB_RESPONSE_INVALID")
        );
      }
    );
  }
});

test("GitHub delivery reads only the explicit issue, PR, and paginated head check", async () => {
  const calls: RequestCall[] = [];
  const responses = [
    jsonResponse(ISSUE),
    jsonResponse(PULL_REQUEST),
    jsonResponse(
      { total_count: 1, check_runs: [] },
      {
        headers: {
          link: '<https://api.github.com/repositories/1/commits/abc123/check-runs?check_name=tests&filter=latest&per_page=100&page=2>; rel="next"'
        }
      }
    ),
    jsonResponse({ total_count: 1, check_runs: [CHECK] })
  ];
  const fetchImpl: FetchLike = async (
    url,
    options
  ) => {
    calls.push({ url, options });
    return responses.shift();
  };

  const result = await readGitHubDelivery({
    repository: "netpilot-z/TaskSeal",
    issueNumber: 1,
    pullRequestNumber: 1,
    checkName: "tests",
    fetchImpl
  });

  assert.deepEqual(result, {
    issue: ISSUE,
    pullRequest: PULL_REQUEST,
    check: CHECK
  });
  assert.equal(calls.length, 4);
  const issueCall = requireCall(calls, 0);
  const pullRequestCall = requireCall(calls, 1);
  const firstCheckCall = requireCall(calls, 2);
  const secondCheckCall = requireCall(calls, 3);
  assert.equal(
    issueCall.url,
    "https://api.github.com/repos/netpilot-z/TaskSeal/issues/1"
  );
  assert.equal(
    pullRequestCall.url,
    "https://api.github.com/repos/netpilot-z/TaskSeal/pulls/1"
  );
  assert.equal(
    firstCheckCall.url,
    "https://api.github.com/repos/netpilot-z/TaskSeal/commits/abc123/check-runs?check_name=tests&filter=latest&per_page=100"
  );
  assert.equal(
    secondCheckCall.url.includes("page=2"),
    true
  );

  for (const call of calls) {
    assert.equal(call.options.method, "GET");
    assert.equal(
      call.options.headers.Accept,
      "application/vnd.github+json"
    );
    assert.equal(
      call.options.headers["X-GitHub-Api-Version"],
      "2026-03-10"
    );
    assert.equal(call.options.headers["User-Agent"], "TaskSeal");
    assert.equal("Authorization" in call.options.headers, false);
  }
});

test("GitHub delivery uses a bearer token without returning it", async () => {
  const token = "github-secret-value";
  const calls: RequestCall[] = [];
  const responses = [
    jsonResponse(ISSUE),
    jsonResponse(PULL_REQUEST),
    jsonResponse({ total_count: 1, check_runs: [CHECK] })
  ];

  const result = await readGitHubDelivery({
    repository: "netpilot-z/TaskSeal",
    issueNumber: 1,
    pullRequestNumber: 1,
    checkName: "tests",
    token,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    }
  });

  assert.equal(
    calls.every(
      ({ options }) => options.headers.Authorization === `Bearer ${token}`
    ),
    true
  );
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
});

test("GitHub delivery fails closed for provider and association errors", async (t) => {
  await t.test("an issue-shaped PR is rejected", async () => {
    await assert.rejects(
      readGitHubDelivery({
        repository: "netpilot-z/TaskSeal",
        issueNumber: 1,
        pullRequestNumber: 1,
        checkName: "tests",
        fetchImpl: createQueuedFetch([
          jsonResponse({ ...ISSUE, pull_request: { url: "ignored" } })
        ])
      }),
      hasCode("GITHUB_ISSUE_IS_PULL_REQUEST")
    );
  });

  await t.test("a missing resource has a safe error", async () => {
    const token = "must-not-leak";
    let error: unknown;

    try {
      await readGitHubDelivery({
        repository: "netpilot-z/TaskSeal",
        issueNumber: 99,
        pullRequestNumber: 99,
        checkName: "tests",
        token,
        fetchImpl: createQueuedFetch([
          jsonResponse({ message: `bad ${token}` }, { status: 404 })
        ])
      });
    } catch (caught) {
      error = caught;
    }

    if (!isCodedError(error)) {
      assert.fail("Expected a coded GitHub error.");
    }

    assert.equal(error.code, "GITHUB_NOT_FOUND");
    assert.doesNotMatch(
      error.message,
      new RegExp(token)
    );
  });

  await t.test("a foreign pagination URL is rejected", async () => {
    await assert.rejects(
      readGitHubDelivery({
        repository: "netpilot-z/TaskSeal",
        issueNumber: 1,
        pullRequestNumber: 1,
        checkName: "tests",
        fetchImpl: createQueuedFetch([
          jsonResponse(ISSUE),
          jsonResponse(PULL_REQUEST),
          jsonResponse(
            { total_count: 0, check_runs: [] },
            {
              headers: {
                link: '<https://example.test/steal>; rel="next"'
              }
            }
          )
        ])
      }),
      hasCode("GITHUB_PAGINATION_ORIGIN_INVALID")
    );
  });

  await t.test("ambiguous checks are not guessed", async () => {
    await assert.rejects(
      readGitHubDelivery({
        repository: "netpilot-z/TaskSeal",
        issueNumber: 1,
        pullRequestNumber: 1,
        checkName: "tests",
        fetchImpl: createQueuedFetch([
          jsonResponse(ISSUE),
          jsonResponse(PULL_REQUEST),
          jsonResponse({
            total_count: 2,
            check_runs: [CHECK, { ...CHECK, id: 2002 }]
          })
        ])
      }),
      hasCode("GITHUB_CHECK_AMBIGUOUS")
    );
  });

  await t.test("check evidence must match the PR revision", async () => {
    await assert.rejects(
      readGitHubDelivery({
        repository: "netpilot-z/TaskSeal",
        issueNumber: 1,
        pullRequestNumber: 1,
        checkName: "tests",
        fetchImpl: createQueuedFetch([
          jsonResponse(ISSUE),
          jsonResponse(PULL_REQUEST),
          jsonResponse({
            total_count: 1,
            check_runs: [{ ...CHECK, head_sha: "different" }]
          })
        ])
      }),
      hasCode("GITHUB_CHECK_REVISION_MISMATCH")
    );
  });

  await t.test("an unfinished check keeps the incomplete error contract", async () => {
    await assert.rejects(
      readGitHubDelivery({
        repository: "netpilot-z/TaskSeal",
        issueNumber: 1,
        pullRequestNumber: 1,
        checkName: "tests",
        fetchImpl: createQueuedFetch([
          jsonResponse(ISSUE),
          jsonResponse(PULL_REQUEST),
          jsonResponse({
            total_count: 1,
            check_runs: [
              {
                ...CHECK,
                status: "in_progress",
                conclusion: null,
                completed_at: null
              }
            ]
          })
        ])
      }),
      hasCode("GITHUB_CHECK_INCOMPLETE")
    );
  });

  await t.test("a completed check requires a scalar conclusion", async () => {
    await assert.rejects(
      readGitHubDelivery({
        repository: "netpilot-z/TaskSeal",
        issueNumber: 1,
        pullRequestNumber: 1,
        checkName: "tests",
        fetchImpl: createQueuedFetch([
          jsonResponse(ISSUE),
          jsonResponse(PULL_REQUEST),
          jsonResponse({
            total_count: 1,
            check_runs: [
              {
                ...CHECK,
                conclusion: {
                  unsafe: true
                }
              }
            ]
          })
        ])
      }),
      hasCode("GITHUB_RESPONSE_INVALID")
    );
  });
});

function jsonResponse(
  body: unknown,
  {
    status = 200,
    headers = {}
  }: {
    status?: number;
    headers?: Record<string, string>;
  } = {}
): TestResponse {
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
    async json() {
      return body;
    }
  };
}

function createQueuedFetch(
  responses: unknown[]
): FetchLike {
  return async () => responses.shift();
}

function requireCall(
  calls: readonly RequestCall[],
  index: number
): RequestCall {
  const call = calls[index];

  if (!call) {
    assert.fail(`Missing request call ${index}.`);
  }

  return call;
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error) =>
    isCodedError(error) && error.code === code;
}

function isCodedError(
  value: unknown
): value is Error & {
  code: string;
} {
  return (
    value instanceof Error &&
    "code" in value &&
    typeof value.code === "string"
  );
}

function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value;
}
