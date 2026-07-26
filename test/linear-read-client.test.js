import assert from "node:assert/strict";
import test from "node:test";

import { readLinearIssue } from "../src/connectors/linear-read-client.js";

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

test("Linear reads paginated scope then one issue with an API key", async () => {
  const calls = [];
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
        body: JSON.parse(options.body)
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
  assert.equal(calls[0].body.variables.after, null);
  assert.equal(calls[1].body.variables.after, "cursor-1");
  assert.equal(calls[2].body.variables.id, "NET-7");
  assert.equal(
    calls.every((call) => !/\bmutation\b/i.test(call.body.query)),
    true
  );
});

test("Linear distinguishes OAuth and API key authentication", async () => {
  const accessToken = "linear-oauth-secret";
  const calls = [];
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

test("Linear fails closed for credentials, GraphQL errors, and scope drift", async (t) => {
  await t.test("credentials are required and cannot be mixed", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
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
        issueReference: "not-valid",
        apiKey: "api-key",
        fetchImpl
      }),
      hasCode("LINEAR_ISSUE_REFERENCE_INVALID")
    );
    assert.equal(called, false);
  });

  await t.test("GraphQL errors are failures even with HTTP 200", async () => {
    const token = "must-not-leak";
    let error;

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

    assert.equal(error.code, "LINEAR_RATE_LIMITED");
    assert.doesNotMatch(error.message, new RegExp(token));
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
    const calls = [];

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

function scopeResponse({
  organization = ORGANIZATION,
  teams = [TEAM]
} = {}) {
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

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get() {
        return null;
      }
    },
    async json() {
      return body;
    }
  };
}

function nonJsonResponse(status) {
  return {
    ok: false,
    status,
    headers: {
      get() {
        return null;
      }
    },
    async json() {
      throw new SyntaxError("not json");
    }
  };
}

function createQueuedFetch(responses) {
  return async () => responses.shift();
}

function hasCode(code) {
  return (error) => error?.code === code;
}
