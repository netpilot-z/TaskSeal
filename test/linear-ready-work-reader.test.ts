import assert from "node:assert/strict";
import test from "node:test";

import {
  listLinearReadyWorkIssues,
  readLinearReadyWorkIssueStates
} from "../src/connectors/linear-ready-work-reader.ts";
import type {
  LinearReadyWorkGraphqlRequest
} from "../src/connectors/linear-ready-work-reader.ts";

const ORGANIZATION_ID =
  "11111111-1111-4111-8111-111111111111";
const TEAM_ID =
  "22222222-2222-4222-8222-222222222222";
const PROJECT_ID =
  "33333333-3333-4333-8333-333333333333";
const READY_STATE_ID =
  "44444444-4444-4444-8444-444444444444";
const COMPLETED_STATE_ID =
  "55555555-5555-4555-8555-555555555555";
const ISSUE_ID =
  "66666666-6666-4666-8666-666666666666";
const SECOND_ISSUE_ID =
  "77777777-7777-4777-8777-777777777777";
const BLOCKER_ID =
  "88888888-8888-4888-8888-888888888888";

const SCOPE = Object.freeze({
  organizationId: ORGANIZATION_ID,
  teamId: TEAM_ID,
  teamKey: "NP",
  projectId: PROJECT_ID,
  readyStateId: READY_STATE_ID,
  completedStateId: COMPLETED_STATE_ID
});

test("ready-work reader uses exact server filters, paginates, and normalizes native blockers", async () => {
  const requests: LinearReadyWorkGraphqlRequest[] =
    [];
  const issues = await listLinearReadyWorkIssues({
    scope: SCOPE,
    exchange: async (
      request: LinearReadyWorkGraphqlRequest
    ) => {
      requests.push(request);
      const body = parseRequest(request);
      assert.equal(
        body.query.includes("mutation"),
        false
      );
      assert.deepEqual(
        {
          teamId: body.variables.teamId,
          projectId: body.variables.projectId,
          stateId: body.variables.stateId
        },
        {
          teamId: TEAM_ID,
          projectId: PROJECT_ID,
          stateId: READY_STATE_ID
        }
      );

      if (body.variables.after === null) {
        return response({
          organization: { id: ORGANIZATION_ID },
          issues: connection(
            [
              issueNode({
                id: ISSUE_ID,
                identifier: "NP-5",
                blockers: [BLOCKER_ID]
              })
            ],
            true,
            "next-page"
          )
        });
      }

      assert.equal(
        body.variables.after,
        "next-page"
      );
      return response({
        organization: { id: ORGANIZATION_ID },
        issues: connection([
          issueNode({
            id: SECOND_ISSUE_ID,
            identifier: "NP-6"
          })
        ])
      });
    }
  });

  assert.deepEqual(
    issues.map((issue) => ({
      id: issue.id,
      blockedByIssueIds:
        issue.blockedByIssueIds,
      dependencyCompleteness:
        issue.dependencyCompleteness
    })),
    [
      {
        id: ISSUE_ID,
        blockedByIssueIds: [BLOCKER_ID],
        dependencyCompleteness: "complete"
      },
      {
        id: SECOND_ISSUE_ID,
        blockedByIssueIds: [],
        dependencyCompleteness: "complete"
      }
    ]
  );
  assert.equal(
    issues.every((issue) =>
      Object.isFrozen(issue)
    ),
    true
  );
  assert.deepEqual(
    requests.map((request) => request.operation),
    ["list_ready_issues", "list_ready_issues"]
  );
});

test("ready-work reader fails closed on scope drift, repeated cursors, and relation overflow", async (t) => {
  await t.test("project drift", async () => {
    await assert.rejects(
      listLinearReadyWorkIssues({
        scope: SCOPE,
        exchange: async () =>
          response({
            organization: {
              id: ORGANIZATION_ID
            },
            issues: connection([
              issueNode({
                projectId:
                  "99999999-9999-4999-8999-999999999999"
              })
            ])
          })
      }),
      hasCode("LINEAR_READY_SCOPE_MISMATCH")
    );
  });

  await t.test("repeated issue cursor", async () => {
    await assert.rejects(
      listLinearReadyWorkIssues({
        scope: SCOPE,
        exchange: async () =>
          response({
            organization: {
              id: ORGANIZATION_ID
            },
            issues: connection(
              [],
              true,
              "same"
            )
          })
      }),
      hasCode(
        "LINEAR_READY_PAGINATION_INVALID"
      )
    );
  });

  await t.test(
    "unbounded nested relations become unknown",
    async () => {
      const issues =
        await listLinearReadyWorkIssues({
          scope: SCOPE,
          exchange: async () =>
            response({
              organization: {
                id: ORGANIZATION_ID
              },
              issues: connection([
                issueNode({
                  relationsHaveNextPage: true
                })
              ])
            })
        });

      assert.equal(
        issues[0]?.dependencyCompleteness,
        "unknown"
      );
    }
  );
});

test("ready-work reader re-reads dependency states by stable UUID and rejects foreign scope", async () => {
  const states =
    await readLinearReadyWorkIssueStates({
      scope: SCOPE,
      issueIds: [BLOCKER_ID],
      exchange: async (
        request: LinearReadyWorkGraphqlRequest
      ) => {
        const body = parseRequest(request);
        assert.equal(
          request.operation,
          "read_dependency_states"
        );
        assert.deepEqual(
          body.variables.issueIds,
          [BLOCKER_ID]
        );
        return response({
          organization: {
            id: ORGANIZATION_ID
          },
          issues: connection([
            {
              id: BLOCKER_ID,
              team: { id: TEAM_ID },
              project: { id: PROJECT_ID },
              state: {
                id: COMPLETED_STATE_ID,
                name: "Done",
                type: "completed"
              }
            }
          ])
        });
      }
    });

  assert.deepEqual(states, [{
    issueId: BLOCKER_ID,
    stateId: COMPLETED_STATE_ID,
    stateType: "completed"
  }]);

  await assert.rejects(
    readLinearReadyWorkIssueStates({
      scope: SCOPE,
      issueIds: [BLOCKER_ID],
      exchange: async () =>
        response({
          organization: {
            id: ORGANIZATION_ID
          },
          issues: connection([
            {
              id: BLOCKER_ID,
              team: {
                id:
                  "99999999-9999-4999-8999-999999999999"
              },
              project: { id: PROJECT_ID },
              state: {
                id: COMPLETED_STATE_ID,
                name: "Done",
                type: "completed"
              }
            }
          ])
        })
    }),
    hasCode("LINEAR_READY_SCOPE_MISMATCH")
  );
});

function issueNode({
  id = ISSUE_ID,
  identifier = "NP-5",
  projectId = PROJECT_ID,
  blockers = [],
  relationsHaveNextPage = false
}: {
  id?: string;
  identifier?: string;
  projectId?: string;
  blockers?: readonly string[];
  relationsHaveNextPage?: boolean;
} = {}): unknown {
  return {
    id,
    identifier,
    title: `Title ${identifier}`,
    url:
      `https://linear.app/netpilot-z/issue/${identifier}/example`,
    createdAt: "2026-07-28T01:00:00.000Z",
    updatedAt: "2026-07-28T02:00:00.000Z",
    team: {
      id: TEAM_ID,
      key: "NP"
    },
    project: { id: projectId },
    state: {
      id: READY_STATE_ID,
      name: "Todo",
      type: "unstarted"
    },
    inverseRelations: connection(
      blockers.map((blockerId, index) => ({
        id: `aaaaaaaa-aaaa-4aaa-8aa${index}-aaaaaaaaaaa${index}`,
        type: "blocks",
        issue: { id: blockerId },
        relatedIssue: { id }
      })),
      relationsHaveNextPage,
      relationsHaveNextPage
        ? "relation-next"
        : null
    )
  };
}

function parseRequest(
  request: LinearReadyWorkGraphqlRequest
): {
  query: string;
  variables: Record<string, unknown>;
} {
  return JSON.parse(request.body);
}

function response(data: unknown): unknown {
  return {
    kind: "response",
    status: 200,
    body: JSON.stringify({ data })
  };
}

function connection(
  nodes: readonly unknown[],
  hasNextPage = false,
  endCursor: string | null = null
): unknown {
  return {
    nodes,
    pageInfo: {
      hasNextPage,
      endCursor
    }
  };
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}
