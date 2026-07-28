import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveLinearAcceptanceScope
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
const EXPECTED_STATE_ID =
  "44444444-4444-4444-8444-444444444444";
const TARGET_STATE_ID =
  "55555555-5555-4555-8555-555555555555";
const CONFIGURED_TARGET = {
  workspace: "netpilot-z",
  team: "netpilot",
  project: "TaskSeal",
  expectedState: "In Progress",
  targetState: "Done"
};

test("Linear acceptance scope resolves a started source and completed target", async () => {
  const result =
    await resolveLinearAcceptanceScope({
      configuredTarget:
        CONFIGURED_TARGET,
      exchange: createExchange()
    });

  assert.deepEqual(result, {
    organizationId: ORGANIZATION_ID,
    teamId: TEAM_ID,
    teamKey: "NP",
    projectId: PROJECT_ID,
    expectedStateId:
      EXPECTED_STATE_ID,
    targetStateId:
      TARGET_STATE_ID
  });
  assert.equal(Object.isFrozen(result), true);
});

test("Linear acceptance scope rejects terminal source or non-completed target", async () => {
  await assert.rejects(
    resolveLinearAcceptanceScope({
      configuredTarget:
        CONFIGURED_TARGET,
      exchange: createExchange({
        expectedType: "completed"
      })
    }),
    hasCode(
      "LINEAR_ACCEPTANCE_EXPECTED_STATE_TYPE_INVALID"
    )
  );
  await assert.rejects(
    resolveLinearAcceptanceScope({
      configuredTarget:
        CONFIGURED_TARGET,
      exchange: createExchange({
        targetType: "started"
      })
    }),
    hasCode(
      "LINEAR_ACCEPTANCE_TARGET_STATE_TYPE_INVALID"
    )
  );
});

function createExchange({
  expectedType = "started",
  targetType = "completed"
}: {
  expectedType?: string;
  targetType?: string;
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
      request.operation ===
      "resolve_project_teams"
    ) {
      return response({
        project: {
          id: PROJECT_ID,
          teams: connection([
            { id: TEAM_ID }
          ])
        }
      });
    }
    return response({
      team: {
        id: TEAM_ID,
        states: connection([
          {
            id: EXPECTED_STATE_ID,
            name: "In Progress",
            type: expectedType
          },
          {
            id: TARGET_STATE_ID,
            name: "Done",
            type: targetType
          }
        ])
      }
    });
  };
}

function response(data: unknown) {
  return {
    kind: "response",
    status: 200,
    body: JSON.stringify({ data })
  };
}

function connection(nodes: unknown[]) {
  return {
    nodes,
    pageInfo: {
      hasNextPage: false,
      endCursor: null
    }
  };
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}
