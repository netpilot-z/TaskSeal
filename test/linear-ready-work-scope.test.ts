import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveLinearReadyWorkScope
} from "../src/connectors/linear-bootstrap-scope.ts";
import type {
  LinearBootstrapGraphqlRequest
} from "../src/connectors/linear-bootstrap-scope.ts";

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

const CONFIGURED_TARGET = {
  workspace: "netpilot-z",
  team: "netpilot",
  project: "TaskSeal",
  readyState: "Todo",
  completedState: "Done"
} as const;

test("Linear ready scope resolves exact project, Todo, and Done identities", async () => {
  const result = await resolveLinearReadyWorkScope({
    configuredTarget: CONFIGURED_TARGET,
    exchange: createExchange()
  });

  assert.deepEqual(result, {
    organizationId: ORGANIZATION_ID,
    teamId: TEAM_ID,
    teamKey: "NP",
    projectId: PROJECT_ID,
    readyStateId: READY_STATE_ID,
    completedStateId: COMPLETED_STATE_ID
  });
  assert.equal(Object.isFrozen(result), true);
});

test("Linear ready scope rejects wrong state semantics and duplicate state identities", async (t) => {
  await t.test("Todo must be unstarted", async () => {
    await assert.rejects(
      resolveLinearReadyWorkScope({
        configuredTarget: CONFIGURED_TARGET,
        exchange: createExchange({
          readyType: "started"
        })
      }),
      hasCode("LINEAR_READY_STATE_TYPE_INVALID")
    );
  });

  await t.test("Done must be completed", async () => {
    await assert.rejects(
      resolveLinearReadyWorkScope({
        configuredTarget: CONFIGURED_TARGET,
        exchange: createExchange({
          completedType: "canceled"
        })
      }),
      hasCode(
        "LINEAR_READY_COMPLETED_STATE_TYPE_INVALID"
      )
    );
  });

  await t.test("same state id cannot change identity", async () => {
    await assert.rejects(
      resolveLinearReadyWorkScope({
        configuredTarget: CONFIGURED_TARGET,
        exchange: createExchange({
          completedStateId: READY_STATE_ID
        })
      }),
      hasCode("LINEAR_BOOTSTRAP_RESPONSE_INVALID")
    );
  });
});

function createExchange({
  readyType = "unstarted",
  completedType = "completed",
  completedStateId = COMPLETED_STATE_ID
}: {
  readyType?: string;
  completedType?: string;
  completedStateId?: string;
} = {}) {
  return async (
    request: LinearBootstrapGraphqlRequest
  ): Promise<unknown> => {
    if (request.operation === "resolve_scope") {
      return response({
        organization: {
          id: ORGANIZATION_ID,
          name: "NetPilot",
          urlKey: "netpilot-z"
        },
        teams: connection([{
          id: TEAM_ID,
          name: "netpilot",
          key: "NP"
        }])
      });
    }

    if (request.operation === "resolve_projects") {
      return response({
        projects: connection([{
          id: PROJECT_ID,
          name: "TaskSeal"
        }])
      });
    }

    if (
      request.operation === "resolve_project_teams"
    ) {
      return response({
        project: {
          id: PROJECT_ID,
          teams: connection([{ id: TEAM_ID }])
        }
      });
    }

    return response({
      team: {
        id: TEAM_ID,
        states: connection([
          {
            id: READY_STATE_ID,
            name: "Todo",
            type: readyType
          },
          {
            id: completedStateId,
            name: "Done",
            type: completedType
          }
        ])
      }
    });
  };
}

function response(data: unknown): unknown {
  return {
    kind: "response",
    status: 200,
    body: JSON.stringify({ data })
  };
}

function connection(
  nodes: readonly unknown[]
): unknown {
  return {
    nodes,
    pageInfo: {
      hasNextPage: false,
      endCursor: null
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
