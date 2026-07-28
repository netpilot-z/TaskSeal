import assert from "node:assert/strict";
import test from "node:test";

import {
  InjectedLinearWriteTransport
} from "../src/connectors/linear-write-transport.ts";
import type {
  LinearWriteGraphqlExchange,
  LinearWriteGraphqlRequest
} from "../src/connectors/linear-write-transport.ts";

const CLIENT_REQUEST_ID =
  "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID =
  "22222222-2222-4222-8222-222222222222";
const TEAM_ID =
  "33333333-3333-4333-8333-333333333333";
const PROJECT_ID =
  "44444444-4444-4444-8444-444444444444";
const STATE_ID =
  "55555555-5555-4555-8555-555555555555";
const PARENT_ISSUE_ID =
  "66666666-6666-4666-8666-666666666666";
const DRIFT_ID =
  "77777777-7777-4777-8777-777777777777";

const CREATE_INPUT_V2 = {
  clientRequestId: CLIENT_REQUEST_ID,
  organizationId: ORGANIZATION_ID,
  teamId: TEAM_ID,
  projectId: PROJECT_ID,
  stateId: STATE_ID,
  parentIssueId: PARENT_ISSUE_ID,
  title: "Create the project-aware Issue",
  description:
    "Observe the exact organization, team, project, state, and parent."
} as const;

const QUERY_INPUT_V2 = {
  clientRequestId: CLIENT_REQUEST_ID,
  organizationId: ORGANIZATION_ID,
  teamId: TEAM_ID,
  projectId: PROJECT_ID,
  stateId: STATE_ID,
  parentIssueId: PARENT_ISSUE_ID
} as const;

test("v2 create sends exact placement and returns only observed identity", async () => {
  const fake = new FakeLinearWriteGraphqlV2();
  const transport = new InjectedLinearWriteTransport(
    fake.exchange
  );

  const result = await transport.createIssueV2(
    CREATE_INPUT_V2
  );

  assert.deepEqual(result, {
    kind: "created",
    issue: {
      id: CLIENT_REQUEST_ID,
      identifier: "NP-101"
    },
    observedPlacement: placement()
  });
  assert.equal(fake.externalWriteCount, 1);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(
    result.kind === "created" &&
      Object.isFrozen(result.observedPlacement),
    true
  );

  const request = requireRequest(
    fake.requests,
    0
  );
  const body = parseRequest(request);
  assert.equal(
    request.operation,
    "issue_create_v2"
  );
  assert.equal(
    body.operationName,
    "TaskSealCreateIssueV2"
  );
  assert.match(
    requireString(body.query),
    /team\s*\{\s*id\s+organization\s*\{\s*id\s*\}/
  );
  assert.match(
    requireString(body.query),
    /project\s*\{\s*id\s*\}/
  );
  assert.match(
    requireString(body.query),
    /state\s*\{\s*id\s*\}/
  );
  assert.match(
    requireString(body.query),
    /parent\s*\{\s*id\s*\}/
  );
  assert.deepEqual(body.variables, {
    input: {
      id: CLIENT_REQUEST_ID,
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      stateId: STATE_ID,
      parentId: PARENT_ISSUE_ID,
      title: CREATE_INPUT_V2.title,
      description: CREATE_INPUT_V2.description
    }
  });
  assert.equal(
    JSON.stringify(body).includes(
      ORGANIZATION_ID
    ),
    false
  );
});

test("v2 query uses only client UUID and validates complete observed placement", async () => {
  const fake = new FakeLinearWriteGraphqlV2();
  const transport = new InjectedLinearWriteTransport(
    fake.exchange
  );

  const result =
    await transport.queryByClientUuidV2(
      QUERY_INPUT_V2
    );

  assert.deepEqual(result, {
    kind: "found",
    issue: {
      id: CLIENT_REQUEST_ID,
      identifier: "NP-101"
    },
    observedPlacement: placement()
  });
  const request = requireRequest(
    fake.requests,
    0
  );
  const body = parseRequest(request);
  assert.equal(
    request.operation,
    "issue_by_id_v2"
  );
  assert.equal(
    body.operationName,
    "TaskSealQueryIssueV2"
  );
  assert.deepEqual(body.variables, {
    id: CLIENT_REQUEST_ID
  });
});

test("v2 lost create response stays fenced and can be queried by the same UUID", async () => {
  const fake = new FakeLinearWriteGraphqlV2({
    createMode: "response_lost"
  });
  const transport = new InjectedLinearWriteTransport(
    fake.exchange
  );

  assert.deepEqual(
    await transport.createIssueV2(
      CREATE_INPUT_V2
    ),
    {
      kind: "outcome_unknown",
      diagnosticCode:
        "LINEAR_WRITE_OUTCOME_UNKNOWN"
    }
  );
  assert.deepEqual(
    await transport.queryByClientUuidV2(
      QUERY_INPUT_V2
    ),
    {
      kind: "found",
      issue: {
        id: CLIENT_REQUEST_ID,
        identifier: "NP-101"
      },
      observedPlacement: placement()
    }
  );
  assert.equal(fake.externalWriteCount, 1);
  assert.equal(fake.requests.length, 2);
});

test("v2 placement drift fails closed for create and query", async (t) => {
  const drifts = [
    ["organizationId", DRIFT_ID],
    ["teamId", DRIFT_ID],
    ["projectId", DRIFT_ID],
    ["stateId", DRIFT_ID],
    ["parentIssueId", null]
  ] as const;

  for (const [field, value] of drifts) {
    await t.test(field, async () => {
      const fake =
        new FakeLinearWriteGraphqlV2({
          observedPlacement: {
            ...placement(),
            [field]: value
          }
        });
      const transport =
        new InjectedLinearWriteTransport(
          fake.exchange
        );

      assert.deepEqual(
        await transport.createIssueV2(
          CREATE_INPUT_V2
        ),
        {
          kind: "outcome_unknown",
          diagnosticCode:
            "LINEAR_WRITE_OUTCOME_UNKNOWN"
        }
      );
      assert.deepEqual(
        await transport.queryByClientUuidV2(
          QUERY_INPUT_V2
        ),
        {
          kind: "ambiguous",
          diagnosticCode:
            "LINEAR_RECONCILIATION_AMBIGUOUS"
        }
      );
    });
  }
});

test("v2 issue identity drift fails closed for create and query", async (t) => {
  const cases = [
    {
      name: "id",
      issueId: DRIFT_ID
    },
    {
      name: "identifier",
      identifier: "not-a-linear-identifier"
    }
  ] as const;

  for (const value of cases) {
    await t.test(value.name, async () => {
      const fake =
        new FakeLinearWriteGraphqlV2(value);
      const transport =
        new InjectedLinearWriteTransport(
          fake.exchange
        );

      assert.equal(
        (
          await transport.createIssueV2(
            CREATE_INPUT_V2
          )
        ).kind,
        "outcome_unknown"
      );
      assert.equal(
        (
          await transport.queryByClientUuidV2(
            QUERY_INPUT_V2
          )
        ).kind,
        "ambiguous"
      );
    });
  }
});

test("v2 explicitly sends and observes a null parent", async () => {
  const fake = new FakeLinearWriteGraphqlV2({
    observedPlacement: {
      ...placement(),
      parentIssueId: null
    }
  });
  const transport = new InjectedLinearWriteTransport(
    fake.exchange
  );
  const input = {
    ...CREATE_INPUT_V2,
    parentIssueId: null
  };

  const result =
    await transport.createIssueV2(input);

  assert.equal(result.kind, "created");
  assert.equal(
    result.kind === "created"
      ? result.observedPlacement.parentIssueId
      : PARENT_ISSUE_ID,
    null
  );
  assert.deepEqual(
    (
      parseRequest(
        requireRequest(fake.requests, 0)
      ).variables as {
        input: Record<string, unknown>;
      }
    ).input.parentId,
    null
  );
});

test("invalid v2 inputs fail before the injected exchange", async () => {
  const fake = new FakeLinearWriteGraphqlV2();
  const transport = new InjectedLinearWriteTransport(
    fake.exchange
  );
  const invalid: readonly unknown[] = [
    {
      ...CREATE_INPUT_V2,
      organizationId: "not-a-uuid"
    },
    {
      ...CREATE_INPUT_V2,
      projectId: "not-a-uuid"
    },
    {
      ...CREATE_INPUT_V2,
      stateId: "not-a-uuid"
    },
    {
      ...CREATE_INPUT_V2,
      parentIssueId: "not-a-uuid"
    },
    {
      ...CREATE_INPUT_V2,
      extra: true
    },
    {
      ...QUERY_INPUT_V2,
      extra: true
    }
  ];

  for (const value of invalid) {
    const promise =
      Object.hasOwn(value as object, "title")
        ? transport.createIssueV2(value)
        : transport.queryByClientUuidV2(value);
    await assert.rejects(
      promise,
      hasCode(
        "LINEAR_WRITE_TRANSPORT_INVALID_INPUT"
      )
    );
  }
  assert.equal(fake.requests.length, 0);
  assert.equal(fake.externalWriteCount, 0);
});

interface ObservedPlacement {
  organizationId: string;
  teamId: string;
  projectId: string;
  stateId: string;
  parentIssueId: string | null;
}

interface FakeOptions {
  observedPlacement?: ObservedPlacement;
  createMode?: "success" | "response_lost";
  issueId?: string;
  identifier?: string;
}

class FakeLinearWriteGraphqlV2 {
  readonly requests: LinearWriteGraphqlRequest[] =
    [];
  readonly #observedPlacement:
    ObservedPlacement;
  readonly #createMode:
    | "success"
    | "response_lost";
  readonly #issueId: string;
  readonly #identifier: string;
  externalWriteCount = 0;

  constructor({
    observedPlacement = placement(),
    createMode = "success",
    issueId = CLIENT_REQUEST_ID,
    identifier = "NP-101"
  }: FakeOptions = {}) {
    this.#observedPlacement =
      observedPlacement;
    this.#createMode = createMode;
    this.#issueId = issueId;
    this.#identifier = identifier;
  }

  readonly exchange: LinearWriteGraphqlExchange =
    async (request) => {
      this.requests.push(request);
      const body = parseRequest(request);
      if (
        body.operationName ===
        "TaskSealCreateIssueV2"
      ) {
        this.externalWriteCount += 1;
        if (
          this.#createMode ===
          "response_lost"
        ) {
          return {
            kind: "response_lost"
          };
        }
        return jsonResponse({
          data: {
            issueCreate: {
              success: true,
              issue: presentIssue(
                this.#observedPlacement,
                this.#issueId,
                this.#identifier
              )
            }
          }
        });
      }
      if (
        body.operationName ===
        "TaskSealQueryIssueV2"
      ) {
        return jsonResponse({
          data: {
            issue: presentIssue(
              this.#observedPlacement,
              this.#issueId,
              this.#identifier
            )
          }
        });
      }
      throw new TypeError(
        "Unexpected fake Linear operation."
      );
    };
}

function presentIssue(
  observedPlacement: ObservedPlacement,
  id = CLIENT_REQUEST_ID,
  identifier = "NP-101"
) {
  return {
    id,
    identifier,
    team: {
      id: observedPlacement.teamId,
      organization: {
        id: observedPlacement.organizationId
      }
    },
    project: {
      id: observedPlacement.projectId
    },
    state: {
      id: observedPlacement.stateId
    },
    parent:
      observedPlacement.parentIssueId === null
        ? null
        : {
            id:
              observedPlacement.parentIssueId
          }
  };
}

function placement(): ObservedPlacement {
  return {
    organizationId: ORGANIZATION_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    stateId: STATE_ID,
    parentIssueId: PARENT_ISSUE_ID
  };
}

function jsonResponse(body: unknown) {
  return {
    kind: "response" as const,
    status: 200,
    body: JSON.stringify(body)
  };
}

function parseRequest(
  request: LinearWriteGraphqlRequest
): {
  operationName: unknown;
  query: unknown;
  variables: unknown;
} {
  return JSON.parse(request.body) as {
    operationName: unknown;
    query: unknown;
    variables: unknown;
  };
}

function requireRequest(
  requests: readonly LinearWriteGraphqlRequest[],
  index: number
): LinearWriteGraphqlRequest {
  const request = requests[index];
  assert.ok(request);
  return request;
}

function requireString(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof Error &&
    "code" in error &&
    error.code === code &&
    !("cause" in error);
}
