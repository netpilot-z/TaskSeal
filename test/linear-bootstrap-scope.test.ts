import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveLinearBootstrapScope
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
const STATE_ID =
  "44444444-4444-4444-8444-444444444444";

const CONFIGURED_TARGET = {
  workspace: "netpilot-z",
  team: "netpilot",
  project: "TaskSeal",
  backlogState: "Backlog"
} as const;

test("Linear bootstrap scope resolves exact paginated organization, team, project, and backlog state", async () => {
  const requests: LinearBootstrapGraphqlRequest[] = [];
  const result = await resolveLinearBootstrapScope({
    configuredTarget: CONFIGURED_TARGET,
    exchange: async (
      request: LinearBootstrapGraphqlRequest
    ) => {
      requests.push(request);
      const body = parseRequest(request);

      if (request.operation === "resolve_scope") {
        if (body.variables.after === null) {
          return response({
            organization: {
              id: ORGANIZATION_ID,
              name: "NetPilot",
              urlKey: "netpilot-z"
            },
            teams: connection(
              [{
                id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                name: "Other",
                key: "OTHER"
              }],
              true,
              "team-next"
            )
          });
        }

        assert.equal(body.variables.after, "team-next");
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

      if (request.operation === "resolve_project_teams") {
        assert.equal(
          body.variables.projectId,
          PROJECT_ID
        );
        return response({
          project: {
            id: PROJECT_ID,
            teams: connection([{ id: TEAM_ID }])
          }
        });
      }

      assert.equal(
        request.operation,
        "resolve_team_states"
      );
      assert.equal(body.variables.teamId, TEAM_ID);
      return response({
        team: {
          id: TEAM_ID,
          states: connection([
            {
              id: STATE_ID,
              name: "Backlog",
              type: "backlog"
            },
            {
              id: "55555555-5555-4555-8555-555555555555",
              name: "Todo",
              type: "unstarted"
            }
          ])
        }
      });
    }
  });

  assert.deepEqual(result, {
    organizationId: ORGANIZATION_ID,
    teamId: TEAM_ID,
    teamKey: "NP",
    projectId: PROJECT_ID,
    stateId: STATE_ID
  });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(
    requests.map((request) => request.operation),
    [
      "resolve_scope",
      "resolve_scope",
      "resolve_projects",
      "resolve_project_teams",
      "resolve_team_states"
    ]
  );
  assert.equal(
    requests.every((request) => Object.isFrozen(request)),
    true
  );
});

test("Linear bootstrap scope rejects a project outside the configured team", async () => {
  await assert.rejects(
    resolveLinearBootstrapScope({
      configuredTarget: CONFIGURED_TARGET,
      exchange: createHappyExchange({
        projectTeamIds: [
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        ]
      })
    }),
    hasCode("LINEAR_BOOTSTRAP_PROJECT_TEAM_MISMATCH")
  );
});

test("Linear bootstrap scope rejects workspace, team, and paginated identity drift", async (t) => {
  await t.test("workspace mismatch", async () => {
    await assert.rejects(
      resolveLinearBootstrapScope({
        configuredTarget: {
          ...CONFIGURED_TARGET,
          workspace: "foreign-workspace"
        },
        exchange: createHappyExchange()
      }),
      hasCode(
        "LINEAR_BOOTSTRAP_WORKSPACE_MISMATCH"
      )
    );
  });

  await t.test("team missing", async () => {
    await assert.rejects(
      resolveLinearBootstrapScope({
        configuredTarget: {
          ...CONFIGURED_TARGET,
          team: "foreign-team"
        },
        exchange: createHappyExchange()
      }),
      hasCode("LINEAR_BOOTSTRAP_TEAM_NOT_FOUND")
    );
  });

  await t.test("repeated cursor", async () => {
    await assert.rejects(
      resolveLinearBootstrapScope({
        configuredTarget: CONFIGURED_TARGET,
        exchange: async (
          request: LinearBootstrapGraphqlRequest
        ) => {
          assert.equal(
            request.operation,
            "resolve_scope"
          );
          return response({
            organization: {
              id: ORGANIZATION_ID,
              name: "NetPilot",
              urlKey: "netpilot-z"
            },
            teams: connection(
              [],
              true,
              "same-cursor"
            )
          });
        }
      }),
      hasCode(
        "LINEAR_BOOTSTRAP_PAGINATION_INVALID"
      )
    );
  });

  await t.test(
    "same team id changes identity across pages",
    async () => {
      let page = 0;
      await assert.rejects(
        resolveLinearBootstrapScope({
          configuredTarget: CONFIGURED_TARGET,
          exchange: async (
            request: LinearBootstrapGraphqlRequest
          ) => {
            assert.equal(
              request.operation,
              "resolve_scope"
            );
            page += 1;
            return response({
              organization: {
                id: ORGANIZATION_ID,
                name: "NetPilot",
                urlKey: "netpilot-z"
              },
              teams: connection(
                [{
                  id: TEAM_ID,
                  name:
                    page === 1
                      ? "netpilot"
                      : "renamed-team",
                  key: "NP"
                }],
                page === 1,
                page === 1 ? "next-page" : null
              )
            });
          }
        }),
        hasCode(
          "LINEAR_BOOTSTRAP_RESPONSE_INVALID"
        )
      );
    }
  );
});

test("Linear bootstrap scope requires one backlog-typed bootstrap state", async (t) => {
  await t.test("wrong semantic type", async () => {
    await assert.rejects(
      resolveLinearBootstrapScope({
        configuredTarget: CONFIGURED_TARGET,
        exchange: createHappyExchange({
          states: [{
            id: STATE_ID,
            name: "Backlog",
            type: "started"
          }]
        })
      }),
      hasCode("LINEAR_BOOTSTRAP_STATE_TYPE_INVALID")
    );
  });

  await t.test("ambiguous name", async () => {
    await assert.rejects(
      resolveLinearBootstrapScope({
        configuredTarget: CONFIGURED_TARGET,
        exchange: createHappyExchange({
          states: [
            {
              id: STATE_ID,
              name: "Backlog",
              type: "backlog"
            },
            {
              id: "55555555-5555-4555-8555-555555555555",
              name: "backlog",
              type: "backlog"
            }
          ]
        })
      }),
      hasCode("LINEAR_BOOTSTRAP_STATE_AMBIGUOUS")
    );
  });

  await t.test("state team identity drift", async () => {
    await assert.rejects(
      resolveLinearBootstrapScope({
        configuredTarget: CONFIGURED_TARGET,
        exchange: async (
          request: LinearBootstrapGraphqlRequest
        ) => {
          if (
            request.operation !==
            "resolve_team_states"
          ) {
            return createHappyExchange()(request);
          }

          return response({
            team: {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              states: connection([])
            }
          });
        }
      }),
      hasCode(
        "LINEAR_BOOTSTRAP_RESPONSE_INVALID"
      )
    );
  });
});

test("Linear bootstrap scope fails closed on ambiguous projects and unsafe exchange responses", async (t) => {
  await t.test("ambiguous project", async () => {
    await assert.rejects(
      resolveLinearBootstrapScope({
        configuredTarget: CONFIGURED_TARGET,
        exchange: createHappyExchange({
          projects: [
            {
              id: PROJECT_ID,
              name: "TaskSeal"
            },
            {
              id: "66666666-6666-4666-8666-666666666666",
              name: "taskseal"
            }
          ]
        })
      }),
      hasCode("LINEAR_BOOTSTRAP_PROJECT_AMBIGUOUS")
    );
  });

  for (const unsafe of [
    { kind: "not_dispatched" },
    { kind: "response_lost" },
    {
      kind: "response",
      status: 200,
      body: JSON.stringify({
        errors: [{ message: "SECRET_PROVIDER_TEXT" }]
      })
    }
  ] as const) {
    await t.test(unsafe.kind, async () => {
      await assert.rejects(
        resolveLinearBootstrapScope({
          configuredTarget: CONFIGURED_TARGET,
          exchange: async () => unsafe
        }),
        (error: unknown) =>
          hasCode("LINEAR_BOOTSTRAP_REQUEST_FAILED")(
            error
          ) &&
          !String(error).includes("SECRET_PROVIDER_TEXT")
      );
    });
  }
});

test("Linear bootstrap scope redacts adversarial input traps", async () => {
  const secret = "SECRET_BOOTSTRAP_TRAP";
  const hostile = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error(secret);
      }
    }
  );

  await assert.rejects(
    resolveLinearBootstrapScope(hostile),
    (error: unknown) =>
      hasCode("LINEAR_BOOTSTRAP_INPUT_INVALID")(
        error
      ) &&
      !String(error).includes(secret)
  );
});

function createHappyExchange({
  projects = [{ id: PROJECT_ID, name: "TaskSeal" }],
  projectTeamIds = [TEAM_ID],
  states = [{
    id: STATE_ID,
    name: "Backlog",
    type: "backlog"
  }]
}: {
  projects?: Array<{ id: string; name: string }>;
  projectTeamIds?: string[];
  states?: Array<{
    id: string;
    name: string;
    type: string;
  }>;
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
        projects: connection(projects)
      });
    }

    if (request.operation === "resolve_project_teams") {
      return response({
        project: {
          id: PROJECT_ID,
          teams: connection(
            projectTeamIds.map((id) => ({ id }))
          )
        }
      });
    }

    return response({
      team: {
        id: TEAM_ID,
        states: connection(states)
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
  nodes: unknown[],
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

function parseRequest(
  request: LinearBootstrapGraphqlRequest
): {
  variables: Record<string, unknown>;
} {
  const body: unknown = JSON.parse(request.body);

  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !("variables" in body) ||
    body.variables === null ||
    typeof body.variables !== "object" ||
    Array.isArray(body.variables)
  ) {
    throw new Error("Invalid request body.");
  }

  return {
    variables:
      body.variables as Record<string, unknown>
  };
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}
