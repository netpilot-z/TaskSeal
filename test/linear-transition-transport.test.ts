import assert from "node:assert/strict";
import test from "node:test";

import {
  InjectedLinearTransitionTransport
} from "../src/connectors/linear-transition-transport.ts";
import type {
  LinearTransitionGraphqlExchange,
  LinearTransitionGraphqlRequest
} from "../src/application/linear-transition-transport.ts";

const ISSUE_ID =
  "70cbe548-5e6c-4d35-b019-a570058a8cf2";
const DONE_STATE_ID =
  "2d716bbd-be75-4718-95c9-27f184d19e56";

test("transition transport reads one exact Linear issue with bounded white-listed facts", async () => {
  const requests: LinearTransitionGraphqlRequest[] = [];
  const transport =
    new InjectedLinearTransitionTransport({
      exchange: exchangeWith(
        issueResponse(),
        requests
      )
    });

  const result = await transport.readIssue({
    issueId: ISSUE_ID
  });

  assert.deepEqual(result, {
    kind: "found",
    issue: {
      id: ISSUE_ID,
      identifier: "NP-7",
      revisionId:
        "2026-07-28T00:05:00.000Z",
      stateType: "started",
      placement: {
        organizationId:
          "7eb4877f-0fa0-429c-9cd2-76dfffa0f20b",
        teamId:
          "658d1189-f63d-4245-b761-0f4f2c389663",
        projectId:
          "3e1b05e6-0a14-43d4-9fed-e1bee6ef0683",
        stateId:
          "3d2677e2-2192-48c1-8fb9-e6da2dedf95f"
      }
    }
  });
  assert.equal(
    requests[0]?.operation,
    "read_transition_issue"
  );
  const body = JSON.parse(
    requests[0]?.body ?? ""
  );
  assert.deepEqual(body.variables, {
    id: ISSUE_ID
  });
  assert.doesNotMatch(
    requests[0]?.body ?? "",
    /title|description|comment/i
  );
});

test("transition transport updates only stateId and requires a matching success payload", async () => {
  const requests: LinearTransitionGraphqlRequest[] = [];
  const transport =
    new InjectedLinearTransitionTransport({
      exchange: exchangeWith(
        updateResponse(),
        requests
      )
    });

  const result =
    await transport.updateIssueState({
      issueId: ISSUE_ID,
      stateId: DONE_STATE_ID
    });

  assert.deepEqual(result, {
    kind: "dispatched"
  });
  assert.equal(
    requests[0]?.operation,
    "update_transition_state"
  );
  const body = JSON.parse(
    requests[0]?.body ?? ""
  );
  assert.deepEqual(body.variables, {
    id: ISSUE_ID,
    input: {
      stateId: DONE_STATE_ID
    }
  });
});

test("transition transport classifies missing, not-dispatched, response-lost, and malformed responses safely", async () => {
  const missing =
    new InjectedLinearTransitionTransport({
      exchange: async () => ({
        kind: "response",
        status: 200,
        body: JSON.stringify({
          data: {
            issue: null
          }
        })
      })
    });
  assert.deepEqual(
    await missing.readIssue({
      issueId: ISSUE_ID
    }),
    { kind: "missing" }
  );

  for (const [exchangeResult, expected] of [
    [
      { kind: "not_dispatched" },
      {
        kind: "not_dispatched",
        diagnosticCode:
          "LINEAR_WRITE_NOT_DISPATCHED"
      }
    ],
    [
      { kind: "response_lost" },
      {
        kind: "outcome_unknown",
        diagnosticCode:
          "LINEAR_WRITE_OUTCOME_UNKNOWN"
      }
    ],
    [
      {
        kind: "response",
        status: 200,
        body: JSON.stringify({
          data: {
            issueUpdate: {
              success: true,
              issue: {
                id:
                  "99999999-9999-4999-8999-999999999999"
              }
            }
          }
        })
      },
      {
        kind: "outcome_unknown",
        diagnosticCode:
          "LINEAR_WRITE_OUTCOME_UNKNOWN"
      }
    ]
  ] as const) {
    const transport =
      new InjectedLinearTransitionTransport({
        exchange: async () =>
          exchangeResult
      });
    assert.deepEqual(
      await transport.updateIssueState({
        issueId: ISSUE_ID,
        stateId: DONE_STATE_ID
      }),
      expected
    );
  }

  const malformed =
    new InjectedLinearTransitionTransport({
      exchange: async () => ({
        kind: "response",
        status: 200,
        body: JSON.stringify({
          data: {
            issue: {
              id: ISSUE_ID
            }
          }
        })
      })
    });
  assert.deepEqual(
    await malformed.readIssue({
      issueId: ISSUE_ID
    }),
    {
      kind: "failed",
      diagnosticCode:
        "LINEAR_RECONCILIATION_FAILED"
    }
  );
});

function exchangeWith(
  result: Awaited<
    ReturnType<LinearTransitionGraphqlExchange>
  >,
  requests: LinearTransitionGraphqlRequest[]
): LinearTransitionGraphqlExchange {
  return async (request) => {
    requests.push(
      structuredClone(
        request as LinearTransitionGraphqlRequest
      )
    );
    return result;
  };
}

function issueResponse() {
  return {
    kind: "response" as const,
    status: 200,
    body: JSON.stringify({
      data: {
        issue: {
          id: ISSUE_ID,
          identifier: "NP-7",
          updatedAt:
            "2026-07-28T00:05:00.000Z",
          team: {
            id:
              "658d1189-f63d-4245-b761-0f4f2c389663",
            organization: {
              id:
                "7eb4877f-0fa0-429c-9cd2-76dfffa0f20b"
            }
          },
          project: {
            id:
              "3e1b05e6-0a14-43d4-9fed-e1bee6ef0683"
          },
          state: {
            id:
              "3d2677e2-2192-48c1-8fb9-e6da2dedf95f",
            type: "started"
          }
        }
      }
    })
  };
}

function updateResponse() {
  return {
    kind: "response" as const,
    status: 200,
    body: JSON.stringify({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            id: ISSUE_ID
          }
        }
      }
    })
  };
}
