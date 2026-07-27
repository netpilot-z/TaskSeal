import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";

import {
  createControlledWriteOperation,
  transitionControlledWriteOperation
} from "../src/application/controlled-write-operation.ts";
import {
  InjectedLinearWriteTransport,
  LINEAR_WRITE_REQUEST_BYTE_LIMIT,
  LINEAR_WRITE_RESPONSE_BYTE_LIMIT
} from "../src/connectors/linear-write-transport.ts";
import type {
  LinearWriteGraphqlRequest
} from "../src/connectors/linear-write-transport.ts";
import {
  FakeLinearWriteGraphql
} from "../test-support/fake-linear-write-graphql.ts";

const CLIENT_REQUEST_ID =
  "11111111-1111-4111-8111-111111111111";
const TEAM_ID =
  "22222222-2222-4222-8222-222222222222";
const CREATE_INPUT = {
  clientRequestId: CLIENT_REQUEST_ID,
  teamId: TEAM_ID,
  title: "Ship the controlled write proof",
  description: "Keep the transport fake and reviewable."
} as const;
const QUERY_INPUT = {
  clientRequestId: CLIENT_REQUEST_ID,
  teamId: TEAM_ID
} as const;

test("injected Linear create emits the fixed mutation and returns only safe identity", async () => {
  const fake = new FakeLinearWriteGraphql();
  const transport = new InjectedLinearWriteTransport(
    fake.exchange
  );

  const result = await transport.createIssue(
    CREATE_INPUT
  );

  assert.deepEqual(result, {
    kind: "created",
    issue: {
      id: CLIENT_REQUEST_ID,
      identifier: "NP-101"
    },
    observedTeamId: TEAM_ID
  });
  assert.equal(fake.requestCount, 1);
  assert.equal(fake.externalWriteCount, 1);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.issue), true);

  const request = requireRequest(fake.requests, 0);
  const body = parseRequestBody(request);
  assert.equal(request.schemaVersion, 1);
  assert.equal(request.operation, "issue_create");
  assert.equal(
    body.operationName,
    "TaskSealCreateIssue"
  );
  assert.equal(Object.isFrozen(request), true);
  assert.match(
    requireString(body.query),
    /mutation TaskSealCreateIssue/
  );
  assert.deepEqual(body.variables, {
    input: {
      id: CLIENT_REQUEST_ID,
      teamId: TEAM_ID,
      title: CREATE_INPUT.title,
      description: CREATE_INPUT.description
    }
  });
  assert.equal(
    Buffer.byteLength(request.body, "utf8") <=
      LINEAR_WRITE_REQUEST_BYTE_LIMIT,
    true
  );
  assert.doesNotMatch(
    JSON.stringify(request),
    /authorization|api.?key|bearer|token/i
  );
});

test("an explicit pre-dispatch refusal is the only not-dispatched create result", async () => {
  const fake = new FakeLinearWriteGraphql({
    createMode: "not_dispatched"
  });
  const transport = new InjectedLinearWriteTransport(
    fake.exchange
  );

  assert.deepEqual(
    await transport.createIssue(CREATE_INPUT),
    {
      kind: "not_dispatched",
      diagnosticCode:
        "LINEAR_WRITE_NOT_DISPATCHED"
    }
  );
  assert.equal(fake.requestCount, 1);
  assert.equal(fake.externalWriteCount, 0);
});

test("a lost create response is fenced and reconciled by the same client UUID", async () => {
  const fake = new FakeLinearWriteGraphql({
    createMode: "response_lost"
  });
  const transport = new InjectedLinearWriteTransport(
    fake.exchange
  );

  assert.deepEqual(
    await transport.createIssue(CREATE_INPUT),
    {
      kind: "outcome_unknown",
      diagnosticCode:
        "LINEAR_WRITE_OUTCOME_UNKNOWN"
    }
  );
  assert.equal(fake.requestCount, 1);
  assert.equal(fake.externalWriteCount, 1);

  const reconciled =
    await transport.queryByClientUuid(QUERY_INPUT);
  assert.deepEqual(reconciled, {
    kind: "found",
    issue: {
      id: CLIENT_REQUEST_ID,
      identifier: "NP-101"
    },
    observedTeamId: TEAM_ID
  });
  assert.equal(fake.requestCount, 2);
  assert.equal(fake.externalWriteCount, 1);

  const query = parseRequestBody(
    requireRequest(fake.requests, 1)
  );
  assert.match(
    requireString(query.query),
    /query TaskSealQueryIssue/
  );
  assert.equal(
    query.operationName,
    "TaskSealQueryIssue"
  );
  assert.deepEqual(query.variables, {
    id: CLIENT_REQUEST_ID
  });
});

test("every dispatched or indeterminate create failure becomes outcome unknown", async (t) => {
  const modes = [
    "http_error",
    "graphql_error",
    "timeout",
    "response_lost",
    "malformed_response",
    "oversized_response",
    "correlation_mismatch",
    "id_mismatch",
    "identifier_mismatch",
    "success_false"
  ] as const;

  for (const mode of modes) {
    await t.test(mode, async () => {
      const sentinel =
        `SECRET_CREATE_${mode}`;
      const fake = new FakeLinearWriteGraphql({
        createMode: mode,
        rawErrorText: sentinel
      });
      const transport =
        new InjectedLinearWriteTransport(
          fake.exchange
        );
      const result =
        await transport.createIssue(CREATE_INPUT);

      assert.deepEqual(result, {
        kind: "outcome_unknown",
        diagnosticCode:
          "LINEAR_WRITE_OUTCOME_UNKNOWN"
      });
      assert.equal(fake.requestCount, 1);
      assert.equal(fake.externalWriteCount, 1);
      assert.doesNotMatch(
        inspect(result, { depth: null }),
        new RegExp(sentinel)
      );
    });
  }
});

test("client UUID query distinguishes absent and correlation ambiguity", async () => {
  const absentFake =
    new FakeLinearWriteGraphql();
  const absentTransport =
    new InjectedLinearWriteTransport(
      absentFake.exchange
    );
  assert.deepEqual(
    await absentTransport.queryByClientUuid(
      QUERY_INPUT
    ),
    { kind: "absent" }
  );

  const ambiguousFake =
    new FakeLinearWriteGraphql({
      queryMode: "ambiguous"
    });
  const ambiguousTransport =
    new InjectedLinearWriteTransport(
      ambiguousFake.exchange
    );
  assert.deepEqual(
    await ambiguousTransport.queryByClientUuid(
      QUERY_INPUT
    ),
    {
      kind: "ambiguous",
      diagnosticCode:
        "LINEAR_RECONCILIATION_AMBIGUOUS"
    }
  );

  for (const queryMode of [
    "id_mismatch",
    "identifier_mismatch"
  ] as const) {
    const fake = new FakeLinearWriteGraphql({
      queryMode
    });
    const transport =
      new InjectedLinearWriteTransport(
        fake.exchange
      );
    assert.deepEqual(
      await transport.queryByClientUuid(
        QUERY_INPUT
      ),
      {
        kind: "ambiguous",
        diagnosticCode:
          "LINEAR_RECONCILIATION_AMBIGUOUS"
      }
    );
  }
});

test("query transport failures are safe failed results and never invent absence", async (t) => {
  const modes = [
    "http_error",
    "graphql_error",
    "timeout",
    "response_lost",
    "malformed_response",
    "oversized_response"
  ] as const;

  for (const mode of modes) {
    await t.test(mode, async () => {
      const sentinel =
        `SECRET_QUERY_${mode}`;
      const fake = new FakeLinearWriteGraphql({
        queryMode: mode,
        rawErrorText: sentinel
      });
      const transport =
        new InjectedLinearWriteTransport(
          fake.exchange
        );
      const result =
        await transport.queryByClientUuid(
          QUERY_INPUT
        );

      assert.deepEqual(result, {
        kind: "failed",
        diagnosticCode:
          "LINEAR_RECONCILIATION_FAILED"
      });
      assert.equal(fake.requestCount, 1);
      assert.equal(fake.externalWriteCount, 0);
      assert.doesNotMatch(
        inspect(result, { depth: null }),
        new RegExp(sentinel)
      );
    });
  }
});

test("invalid transport inputs fail before the injected exchange is called", async (t) => {
  const invalidCreates: readonly unknown[] = [
    null,
    [],
    {
      ...CREATE_INPUT,
      unexpected: true
    },
    {
      ...CREATE_INPUT,
      clientRequestId:
        "11111111-1111-1111-8111-111111111111"
    },
    {
      ...CREATE_INPUT,
      teamId: "not-a-uuid"
    },
    {
      ...CREATE_INPUT,
      title: " leading"
    },
    {
      ...CREATE_INPUT,
      title: "x".repeat(257)
    },
    {
      ...CREATE_INPUT,
      description: "\u0000"
    }
  ];

  for (const [index, value] of invalidCreates.entries()) {
    await t.test(`create ${index}`, async () => {
      const fake = new FakeLinearWriteGraphql();
      const transport =
        new InjectedLinearWriteTransport(
          fake.exchange
        );
      await assert.rejects(
        transport.createIssue(value),
        hasCode(
          "LINEAR_WRITE_TRANSPORT_INVALID_INPUT"
        )
      );
      assert.equal(fake.requestCount, 0);
      assert.equal(fake.externalWriteCount, 0);
    });
  }

  const invalidQueries: readonly unknown[] = [
    {
      ...QUERY_INPUT,
      unexpected: true
    },
    {
      ...QUERY_INPUT,
      clientRequestId:
        "11111111-1111-1111-8111-111111111111"
    },
    {
      ...QUERY_INPUT,
      teamId: "not-a-uuid"
    }
  ];

  for (const [index, value] of invalidQueries.entries()) {
    await t.test(`query ${index}`, async () => {
      const fake = new FakeLinearWriteGraphql();
      const transport =
        new InjectedLinearWriteTransport(
          fake.exchange
        );
      await assert.rejects(
        transport.queryByClientUuid(value),
        hasCode(
          "LINEAR_WRITE_TRANSPORT_INVALID_INPUT"
        )
      );
      assert.equal(fake.requestCount, 0);
    });
  }
});

test("malformed exchange envelopes fail closed without leaking raw values", async () => {
  const sentinel = "SECRET_INVALID_EXCHANGE";
  const transport =
    new InjectedLinearWriteTransport(
      async () => ({
        kind: "response",
        status: 200,
        body: sentinel,
        unexpected: true
      })
    );

  const created =
    await transport.createIssue(CREATE_INPUT);
  const queried =
    await transport.queryByClientUuid(
      QUERY_INPUT
    );

  assert.deepEqual(created, {
    kind: "outcome_unknown",
    diagnosticCode:
      "LINEAR_WRITE_OUTCOME_UNKNOWN"
  });
  assert.deepEqual(queried, {
    kind: "failed",
    diagnosticCode:
      "LINEAR_RECONCILIATION_FAILED"
  });
  assert.doesNotMatch(
    inspect({ created, queried }, { depth: null }),
    new RegExp(sentinel)
  );
});

test("adversarial input traps are normalized to a fixed public error", async () => {
  const sentinel = "SECRET_INPUT_PROXY";
  const input = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error(sentinel);
      }
    }
  );
  const fake = new FakeLinearWriteGraphql();
  const transport =
    new InjectedLinearWriteTransport(
      fake.exchange
    );

  await assert.rejects(
    transport.createIssue(input),
    (error: unknown) =>
      hasCode(
        "LINEAR_WRITE_TRANSPORT_INVALID_INPUT"
      )(error) &&
      !new RegExp(sentinel).test(
        inspect(error, { depth: null })
      )
  );
  assert.equal(fake.requestCount, 0);
  assert.equal(fake.externalWriteCount, 0);
});

test("accessor, symbol, and non-enumerable input fields fail before dispatch", async () => {
  let getterCalled = false;
  const accessorInput = {
    ...CREATE_INPUT
  } as Record<PropertyKey, unknown>;
  Object.defineProperty(accessorInput, "title", {
    enumerable: true,
    get() {
      getterCalled = true;
      return CREATE_INPUT.title;
    }
  });
  const symbolInput = {
    ...CREATE_INPUT,
    [Symbol("secret")]: "hidden"
  };
  const nonEnumerableInput = {
    ...CREATE_INPUT
  };
  Object.defineProperty(
    nonEnumerableInput,
    "hidden",
    {
      enumerable: false,
      value: "secret"
    }
  );
  const fake = new FakeLinearWriteGraphql();
  const transport =
    new InjectedLinearWriteTransport(
      fake.exchange
    );

  for (const value of [
    accessorInput,
    symbolInput,
    nonEnumerableInput
  ]) {
    await assert.rejects(
      transport.createIssue(value),
      hasCode(
        "LINEAR_WRITE_TRANSPORT_INVALID_INPUT"
      )
    );
  }
  assert.equal(getterCalled, false);
  assert.equal(fake.requestCount, 0);
  assert.equal(fake.externalWriteCount, 0);
});

test("description code-point and byte boundaries match the operation plan contract", async () => {
  const maximumDescription =
    "😀".repeat(16_384);
  const fake = new FakeLinearWriteGraphql();
  const transport =
    new InjectedLinearWriteTransport(
      fake.exchange
    );

  assert.equal(
    (
      await transport.createIssue({
        ...CREATE_INPUT,
        description: maximumDescription
      })
    ).kind,
    "created"
  );
  assert.equal(
    Buffer.byteLength(
      maximumDescription,
      "utf8"
    ),
    65_536
  );
  assert.equal(fake.requestCount, 1);

  await assert.rejects(
    transport.createIssue({
      ...CREATE_INPUT,
      description: "x".repeat(16_385)
    }),
    hasCode(
      "LINEAR_WRITE_TRANSPORT_INVALID_INPUT"
    )
  );
  assert.equal(fake.requestCount, 1);
});

test("response byte limits are enforced before JSON parsing", async () => {
  const oversized =
    "x".repeat(
      LINEAR_WRITE_RESPONSE_BYTE_LIMIT + 1
    );
  const transport =
    new InjectedLinearWriteTransport(
      async () => ({
        kind: "response",
        status: 200,
        body: oversized
      })
    );

  assert.deepEqual(
    await transport.createIssue(CREATE_INPUT),
    {
      kind: "outcome_unknown",
      diagnosticCode:
        "LINEAR_WRITE_OUTCOME_UNKNOWN"
    }
  );
  assert.deepEqual(
    await transport.queryByClientUuid(
      QUERY_INPUT
    ),
    {
      kind: "failed",
      diagnosticCode:
        "LINEAR_RECONCILIATION_FAILED"
    }
  );
});

test("a rejected approval does not cause background or constructor transport calls", () => {
  const fake = new FakeLinearWriteGraphql();
  new InjectedLinearWriteTransport(fake.exchange);
  const prepared = createControlledWriteOperation({
    configuredTarget: {
      kind: "team",
      key: "linear:team-ref:taskseal/netpilot"
    },
    resolvedTarget: {
      organizationId:
        "33333333-3333-4333-8333-333333333333",
      teamId: TEAM_ID
    },
    clientRequestId: CLIENT_REQUEST_ID,
    payload: {
      title: CREATE_INPUT.title,
      description: CREATE_INPUT.description
    },
    preparedAt: "2026-07-27T10:00:00.000Z"
  });
  const rejected =
    transitionControlledWriteOperation(
      prepared,
      {
        type: "reject",
        actor: {
          type: "human",
          id: "owner"
        },
        operationKey:
          prepared.plan.operationKey,
        planDigest: prepared.plan.planDigest,
        occurredAt:
          "2026-07-27T10:01:00.000Z"
      }
    );

  assert.equal(rejected.status, "rejected");
  assert.equal(fake.requestCount, 0);
  assert.equal(fake.externalWriteCount, 0);
});

function parseRequestBody(
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
