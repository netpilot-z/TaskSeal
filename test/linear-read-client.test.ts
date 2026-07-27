import assert from "node:assert/strict";
import test from "node:test";

import {
  readLinearIssue,
  readLinearIssueIdentity
} from "../src/connectors/linear-read-client.ts";
import type {
  LinearFetchLike,
  LinearFetchRequestOptions
} from "../src/connectors/linear-read-client.ts";

interface GraphqlRequestBody {
  query: string;
  variables: Record<string, unknown>;
}

interface LinearRequestCall {
  url: string;
  options: LinearFetchRequestOptions;
  body?: GraphqlRequestBody;
}

interface TestResponse {
  ok: boolean;
  status: number;
  headers: {
    get(name: string): string | null;
  };
  json(): Promise<unknown>;
}

const ORGANIZATION = {
  id: "organization-1",
  name: "TaskSeal",
  urlKey: "taskseal"
};

const TEAM = {
  id: "team-1",
  name: "netpilot",
  key: "NET"
};

const ISSUE = {
  id: "issue-1",
  identifier: "NET-7",
  title: "Prove the delivery evidence loop",
  description: "Validate the provider contract.",
  url: "https://linear.app/taskseal/issue/NET-7",
  createdAt: "2026-07-26T08:00:00.000Z",
  updatedAt: "2026-07-26T08:01:00.000Z",
  team: {
    id: "team-1",
    key: "NET"
  }
};

const ISSUE_UUID =
  "11111111-1111-4111-8111-111111111111";
const TEAM_UUID =
  "22222222-2222-4222-8222-222222222222";
const ORGANIZATION_UUID =
  "33333333-3333-4333-8333-333333333333";

test("Linear reads paginated scope then one issue with an API key", async () => {
  const calls: LinearRequestCall[] = [];
  const responses = [
    jsonResponse({
      data: {
        organization: ORGANIZATION,
        teams: {
          nodes: [],
          pageInfo: {
            hasNextPage: true,
            endCursor: "cursor-1"
          }
        }
      }
    }),
    jsonResponse({
      data: {
        organization: ORGANIZATION,
        teams: {
          nodes: [TEAM],
          pageInfo: {
            hasNextPage: false,
            endCursor: null
          }
        }
      }
    }),
    jsonResponse({
      data: {
        issue: ISSUE
      }
    })
  ];

  const result = await readLinearIssue({
    workspace: "TaskSeal",
    team: "netpilot",
    issueReference: "7",
    apiKey: "linear-api-key",
    fetchImpl: async (url, options) => {
      calls.push({
        url,
        options,
        body: parseGraphqlRequestBody(options.body)
      });
      return responses.shift();
    }
  });

  assert.deepEqual(result, {
    organization: ORGANIZATION,
    team: TEAM,
    issue: ISSUE
  });
  assert.equal(calls.length, 3);
  assert.equal(
    calls.every(
      (call) => call.url === "https://api.linear.app/graphql"
    ),
    true
  );
  assert.equal(calls.every((call) => call.options.method === "POST"), true);
  assert.equal(
    calls.every(
      (call) =>
        call.options.headers.Authorization === "linear-api-key" &&
        call.options.headers["Content-Type"] === "application/json"
    ),
    true
  );
  assert.equal(
    requireRequestBody(requireCall(calls, 0))
      .variables.after,
    null
  );
  assert.equal(
    requireRequestBody(requireCall(calls, 1))
      .variables.after,
    "cursor-1"
  );
  assert.equal(
    requireRequestBody(requireCall(calls, 2))
      .variables.id,
    "NET-7"
  );
  assert.equal(
    calls.every(
      (call) =>
        !/\bmutation\b/i.test(
          requireRequestBody(call).query
        )
    ),
    true
  );
});

test("Linear distinguishes OAuth and API key authentication", async () => {
  const accessToken = "linear-oauth-secret";
  const calls: LinearRequestCall[] = [];
  const responses = [
    scopeResponse(),
    jsonResponse({ data: { issue: ISSUE } })
  ];

  const result = await readLinearIssue({
    workspace: "TaskSeal",
    team: "NET",
    issueReference: "NET-7",
    accessToken,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    }
  });

  assert.equal(
    calls.every(
      ({ options }) =>
        options.headers.Authorization === `Bearer ${accessToken}`
    ),
    true
  );
  assert.doesNotMatch(JSON.stringify(result), new RegExp(accessToken));
});

test("Linear provenance reads one Issue by UUID with its Organization and Team identity", async () => {
  const calls: LinearRequestCall[] = [];
  const issue = {
    ...ISSUE,
    id: ISSUE_UUID,
    team: {
      id: TEAM_UUID,
      key: "NET"
    }
  };
  const result = await readLinearIssueIdentity({
    issueId: ISSUE_UUID,
    apiKey: "linear-api-key",
    fetchImpl: async (url, options) => {
      calls.push({
        url,
        options,
        body: parseGraphqlRequestBody(options.body)
      });
      return jsonResponse({
        data: {
          organization: {
            id: ORGANIZATION_UUID
          },
          issue
        }
      });
    }
  });

  assert.deepEqual(result, {
    organizationId: ORGANIZATION_UUID,
    issue
  });
  assert.equal(calls.length, 1);
  assert.equal(
    requireRequestBody(requireCall(calls, 0))
      .variables.id,
    ISSUE_UUID
  );
  assert.match(
    requireRequestBody(requireCall(calls, 0))
      .query,
    /organization\s*\{\s*id\s*\}/
  );
  assert.doesNotMatch(
    requireRequestBody(requireCall(calls, 0))
      .query,
    /\bmutation\b/i
  );
});

test("Linear fails closed for credentials, GraphQL errors, and scope drift", async (t) => {
  await t.test("credentials are required and cannot be mixed", async () => {
    let credentialFetchSentinelCalled = false;
    const fetchImpl = async () => {
      credentialFetchSentinelCalled = true;
    };

    await assert.rejects(
      readLinearIssue({
        workspace: "TaskSeal",
        team: "NET",
        issueReference: "NET-7",
        fetchImpl
      }),
      hasCode("LINEAR_AUTH_MISSING")
    );
    await assert.rejects(
      readLinearIssue({
        workspace: "TaskSeal",
        team: "NET",
        issueReference: "NET-7",
        apiKey: "api-key",
        accessToken: "access-token",
        fetchImpl
      }),
      hasCode("LINEAR_AUTH_CONFLICT")
    );
    await assert.rejects(
      readLinearIssue({
        workspace: "TaskSeal",
        team: "NET",
        issueReference: "NET-7",
        apiKey: "invalid\ncredential",
        fetchImpl
      }),
      hasCode("LINEAR_AUTH_INVALID")
    );
    await assert.rejects(
      readLinearIssue({
        workspace: "TaskSeal",
        team: "NET",
        issueReference: "not-valid",
        apiKey: "api-key",
        fetchImpl
      }),
      hasCode("LINEAR_ISSUE_REFERENCE_INVALID")
    );
    assert.equal(
      credentialFetchSentinelCalled,
      false
    );
  });

  await t.test("GraphQL errors are failures even with HTTP 200", async () => {
    const token = "must-not-leak";
    let error: unknown;

    try {
      await readLinearIssue({
        workspace: "TaskSeal",
        team: "NET",
        issueReference: "NET-7",
        apiKey: token,
        fetchImpl: createQueuedFetch([
          jsonResponse({
            errors: [
              {
                message: `limited ${token}`,
                extensions: { code: "RATELIMITED" }
              }
            ]
          })
        ])
      });
    } catch (caught) {
      error = caught;
    }

    if (!isCodedError(error)) {
      assert.fail("Expected a coded Linear error.");
    }

    assert.equal(error.code, "LINEAR_RATE_LIMITED");
    assert.doesNotMatch(
      error.message,
      new RegExp(token)
    );
  });

  await t.test("HTTP authentication and permission errors keep their status class", async () => {
    await assert.rejects(
      readLinearIssue({
        workspace: "TaskSeal",
        team: "NET",
        issueReference: "NET-7",
        apiKey: "api-key",
        fetchImpl: createQueuedFetch([
          jsonResponse(
            {
              errors: [
                {
                  message: "unauthorized",
                  extensions: { code: "AUTHENTICATION_ERROR" }
                }
              ]
            },
            { status: 401 }
          )
        ])
      }),
      hasCode("LINEAR_AUTH_FAILED")
    );

    await assert.rejects(
      readLinearIssue({
        workspace: "TaskSeal",
        team: "NET",
        issueReference: "NET-7",
        apiKey: "api-key",
        fetchImpl: createQueuedFetch([nonJsonResponse(403)])
      }),
      hasCode("LINEAR_FORBIDDEN")
    );

    await assert.rejects(
      readLinearIssue({
        workspace: "TaskSeal",
        team: "NET",
        issueReference: "NET-7",
        apiKey: "api-key",
        fetchImpl: createQueuedFetch([nonJsonResponse(429)])
      }),
      hasCode("LINEAR_RATE_LIMITED")
    );

    await assert.rejects(
      readLinearIssue({
        workspace: "TaskSeal",
        team: "NET",
        issueReference: "NET-7",
        apiKey: "api-key",
        fetchImpl: createQueuedFetch([
          jsonResponse(
            {
              errors: [
                {
                  message: "limited",
                  extensions: { code: "RATELIMITED" }
                }
              ]
            },
            { status: 400 }
          )
        ])
      }),
      hasCode("LINEAR_RATE_LIMITED")
    );
  });

  await t.test("workspace mismatch stops before issue lookup", async () => {
    const calls: LinearRequestCall[] = [];

    await assert.rejects(
      readLinearIssue({
        workspace: "TaskSeal",
        team: "netpilot",
        issueReference: "NET-7",
        apiKey: "api-key",
        fetchImpl: async (url, options) => {
          calls.push({ url, options });
          return scopeResponse({
            organization: {
              ...ORGANIZATION,
              name: "netpilot-z",
              urlKey: "netpilot-z"
            },
            teams: [
              {
                ...TEAM,
                name: "Netpilot-z"
              }
            ]
          });
        }
      }),
      hasCode("LINEAR_WORKSPACE_MISMATCH")
    );

    assert.equal(calls.length, 1);
  });

  await t.test("team references cannot resolve ambiguously", async () => {
    await assert.rejects(
      readLinearIssue({
        workspace: "TaskSeal",
        team: "NET",
        issueReference: "NET-7",
        apiKey: "api-key",
        fetchImpl: createQueuedFetch([
          scopeResponse({
            teams: [
              TEAM,
              {
                id: "team-2",
                name: "NET",
                key: "OTHER"
              }
            ]
          })
        ])
      }),
      hasCode("LINEAR_TEAM_AMBIGUOUS")
    );
  });

  await t.test("issue identifiers and returned team must match", async () => {
    const fetchImpl = createQueuedFetch([scopeResponse()]);

    await assert.rejects(
      readLinearIssue({
        workspace: "TaskSeal",
        team: "NET",
        issueReference: "OTHER-7",
        apiKey: "api-key",
        fetchImpl
      }),
      hasCode("LINEAR_ISSUE_TEAM_MISMATCH")
    );

    await assert.rejects(
      readLinearIssue({
        workspace: "TaskSeal",
        team: "NET",
        issueReference: "NET-7",
        apiKey: "api-key",
        fetchImpl: createQueuedFetch([
          scopeResponse(),
          jsonResponse({
            data: {
              issue: {
                ...ISSUE,
                team: { id: "team-2", key: "OTHER" }
              }
            }
          })
        ])
      }),
      hasCode("LINEAR_ISSUE_TEAM_MISMATCH")
    );

    await assert.rejects(
      readLinearIssue({
        workspace: "TaskSeal",
        team: "NET",
        issueReference: "NET-7",
        apiKey: "api-key",
        fetchImpl: createQueuedFetch([
          scopeResponse(),
          jsonResponse({
            data: {
              issue: {
                ...ISSUE,
                identifier: "OTHER-7"
              }
            }
          })
        ])
      }),
      hasCode("LINEAR_ISSUE_TEAM_MISMATCH")
    );

    await assert.rejects(
      readLinearIssue({
        workspace: "TaskSeal",
        team: "NET",
        issueReference: "NET-7",
        apiKey: "api-key",
        fetchImpl: createQueuedFetch([
          scopeResponse(),
          jsonResponse({
            data: {
              issue: {
                ...ISSUE,
                team: { id: "team-1", key: "OTHER" }
              }
            }
          })
        ])
      }),
      hasCode("LINEAR_ISSUE_TEAM_MISMATCH")
    );
  });
});

test("Linear rejects malformed GraphQL data and pageInfo at runtime", async (t) => {
  const invalidEnvelopes: readonly unknown[] = [
    null,
    [],
    42,
    "invalid",
    { data: null }
  ];

  for (const body of invalidEnvelopes) {
    await t.test(
      `rejects ${describeValue(body)} data envelope`,
      async () => {
        await assert.rejects(
          readLinearIssue({
            workspace: "TaskSeal",
            team: "NET",
            issueReference: "NET-7",
            apiKey: "api-key",
            fetchImpl: async () =>
              jsonResponse(body)
          }),
          hasCode("LINEAR_RESPONSE_INVALID")
        );
      }
    );
  }

  const invalidPageInfoValues: readonly unknown[] = [
    null,
    [],
    {
      hasNextPage: "false",
      endCursor: null
    }
  ];

  for (const pageInfo of invalidPageInfoValues) {
    await t.test(
      `rejects ${describeValue(pageInfo)} pageInfo`,
      async () => {
        await assert.rejects(
          readLinearIssue({
            workspace: "TaskSeal",
            team: "NET",
            issueReference: "NET-7",
            apiKey: "api-key",
            fetchImpl: async () =>
              jsonResponse({
                data: {
                  organization: ORGANIZATION,
                  teams: {
                    nodes: [TEAM],
                    pageInfo
                  }
                }
              })
          }),
          hasCode("LINEAR_RESPONSE_INVALID")
        );
      }
    );
  }

  await t.test(
    "rejects a malformed errors member even when data is valid",
    async () => {
      await assert.rejects(
        readLinearIssue({
          workspace: "TaskSeal",
          team: "NET",
          issueReference: "NET-7",
          apiKey: "api-key",
          fetchImpl: async () =>
            jsonResponse({
              errors: "malformed",
              data: {
                organization: ORGANIZATION,
                teams: {
                  nodes: [TEAM],
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null
                  }
                }
              }
            })
        }),
        hasCode("LINEAR_RESPONSE_INVALID")
      );
    }
  );
});

function scopeResponse({
  organization = ORGANIZATION,
  teams = [TEAM]
}: {
  organization?: unknown;
  teams?: unknown[];
} = {}): TestResponse {
  return jsonResponse({
    data: {
      organization,
      teams: {
        nodes: teams,
        pageInfo: {
          hasNextPage: false,
          endCursor: null
        }
      }
    }
  });
}

function jsonResponse(
  body: unknown,
  {
    status = 200
  }: {
    status?: number;
  } = {}
): TestResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(): null {
        return null;
      }
    },
    async json() {
      return body;
    }
  };
}

function nonJsonResponse(
  status: number
): TestResponse {
  return {
    ok: false,
    status,
    headers: {
      get(): null {
        return null;
      }
    },
    async json() {
      throw new SyntaxError("not json");
    }
  };
}

function createQueuedFetch(
  responses: unknown[]
): LinearFetchLike {
  return async () => responses.shift();
}

function requireCall(
  calls: readonly LinearRequestCall[],
  index: number
): LinearRequestCall {
  const call = calls[index];

  if (!call) {
    assert.fail(`Missing request call ${index}.`);
  }

  return call;
}

function requireRequestBody(
  call: LinearRequestCall
): GraphqlRequestBody {
  if (!call.body) {
    assert.fail("Expected a GraphQL request body.");
  }

  return call.body;
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error) =>
    isCodedError(error) && error.code === code;
}

function parseGraphqlRequestBody(
  body: string
): GraphqlRequestBody {
  const parsed: unknown = JSON.parse(body);

  if (
    !isRecord(parsed) ||
    typeof parsed.query !== "string" ||
    !isRecord(parsed.variables)
  ) {
    assert.fail("Expected a GraphQL request body.");
  }

  return {
    query: parsed.query,
    variables: parsed.variables
  };
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

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value === "object"
    ? "invalid object"
    : typeof value;
}
