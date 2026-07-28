import type {
  LinearTransitionGraphqlExchange,
  LinearTransitionGraphqlExchangeResult,
  LinearTransitionGraphqlRequest,
  LinearTransitionObservedIssue,
  LinearTransitionReadResult,
  LinearTransitionTransportPort,
  LinearTransitionUpdateResult
} from "../application/linear-transition-transport.ts";

const READ_ISSUE_QUERY =
  `query TaskSealReadTransitionIssue($id: String!) {
    issue(id: $id) {
      id
      identifier
      updatedAt
      team {
        id
        organization { id }
      }
      project { id }
      state {
        id
        type
      }
    }
  }`;

const UPDATE_STATE_MUTATION =
  `mutation TaskSealUpdateTransitionState($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue { id }
    }
  }`;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER_PATTERN =
  /^[A-Z][A-Z0-9]{0,15}-[1-9][0-9]{0,15}$/;
const REQUEST_BYTE_LIMIT =
  128 * 1024;
const RESPONSE_BYTE_LIMIT =
  64 * 1024;

export class InjectedLinearTransitionTransport
  implements LinearTransitionTransportPort {
  readonly #exchange:
    LinearTransitionGraphqlExchange;

  constructor({
    exchange
  }: {
    exchange:
      LinearTransitionGraphqlExchange;
  }) {
    if (typeof exchange !== "function") {
      throw invalidInput();
    }
    this.#exchange = exchange;
  }

  async readIssue(
    inputValue: unknown
  ): Promise<LinearTransitionReadResult> {
    let issueId: string;
    try {
      const input = readExactRecord(
        inputValue,
        ["issueId"]
      );
      issueId = normalizeUuid(
        input.issueId
      );
    } catch {
      throw invalidInput();
    }
    const request = createRequest(
      "read_transition_issue",
      {
        query: READ_ISSUE_QUERY,
        variables: {
          id: issueId
        }
      }
    );
    let exchanged: unknown;
    try {
      exchanged = await this.#exchange(
        request
      );
    } catch {
      return readFailed();
    }
    const result =
      normalizeExchangeResult(exchanged);
    if (
      result === null ||
      result.kind !== "response"
    ) {
      return readFailed();
    }
    const data = parseGraphqlData(result);
    if (data === null) {
      return readFailed();
    }
    try {
      const root = readExactRecord(
        data,
        ["issue"]
      );
      if (root.issue === null) {
        return freezeResult({
          kind: "missing"
        });
      }
      const issue =
        parseObservedIssue(root.issue);
      if (issue.id !== issueId) {
        return readFailed();
      }
      return freezeResult({
        kind: "found",
        issue
      });
    } catch {
      return readFailed();
    }
  }

  async updateIssueState(
    inputValue: unknown
  ): Promise<LinearTransitionUpdateResult> {
    let issueId: string;
    let stateId: string;
    try {
      const input = readExactRecord(
        inputValue,
        ["issueId", "stateId"]
      );
      issueId = normalizeUuid(
        input.issueId
      );
      stateId = normalizeUuid(
        input.stateId
      );
    } catch {
      throw invalidInput();
    }
    const request = createRequest(
      "update_transition_state",
      {
        query: UPDATE_STATE_MUTATION,
        variables: {
          id: issueId,
          input: {
            stateId
          }
        }
      }
    );
    let exchanged: unknown;
    try {
      exchanged = await this.#exchange(
        request
      );
    } catch {
      return updateUnknown();
    }
    const result =
      normalizeExchangeResult(exchanged);
    if (result === null) {
      return updateUnknown();
    }
    if (result.kind === "not_dispatched") {
      return freezeResult({
        kind: "not_dispatched",
        diagnosticCode:
          "LINEAR_WRITE_NOT_DISPATCHED"
      });
    }
    if (result.kind !== "response") {
      return updateUnknown();
    }
    const data = parseGraphqlData(result);
    if (data === null) {
      return updateUnknown();
    }
    try {
      const root = readExactRecord(
        data,
        ["issueUpdate"]
      );
      const payload = readExactRecord(
        root.issueUpdate,
        ["success", "issue"]
      );
      const issue = readExactRecord(
        payload.issue,
        ["id"]
      );
      if (
        payload.success !== true ||
        normalizeUuid(issue.id) !==
          issueId
      ) {
        return updateUnknown();
      }
      return freezeResult({
        kind: "dispatched"
      });
    } catch {
      return updateUnknown();
    }
  }
}

function createRequest(
  operation:
    LinearTransitionGraphqlRequest["operation"],
  value: unknown
): LinearTransitionGraphqlRequest {
  const body = JSON.stringify(value);
  if (
    Buffer.byteLength(body, "utf8") >
    REQUEST_BYTE_LIMIT
  ) {
    throw invalidInput();
  }
  return freezeResult({
    schemaVersion: 1,
    operation,
    body
  });
}

function normalizeExchangeResult(
  value: unknown
): LinearTransitionGraphqlExchangeResult | null {
  try {
    const result = readDataRecord(value);
    if (
      result.kind ===
        "not_dispatched" ||
      result.kind === "response_lost"
    ) {
      requireExactKeys(result, ["kind"]);
      return {
        kind: result.kind
      };
    }
    if (result.kind !== "response") {
      return null;
    }
    requireExactKeys(result, [
      "kind",
      "status",
      "body"
    ]);
    if (
      typeof result.status !== "number" ||
      !Number.isSafeInteger(
        result.status
      ) ||
      result.status < 100 ||
      result.status > 599 ||
      typeof result.body !== "string" ||
      !result.body.isWellFormed() ||
      Buffer.byteLength(
        result.body,
        "utf8"
      ) > RESPONSE_BYTE_LIMIT
    ) {
      return null;
    }
    return {
      kind: "response",
      status: result.status,
      body: result.body
    };
  } catch {
    return null;
  }
}

function parseGraphqlData(
  response: Extract<
    LinearTransitionGraphqlExchangeResult,
    { kind: "response" }
  >
): Record<string, unknown> | null {
  if (
    response.status < 200 ||
    response.status >= 300
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return null;
  }
  try {
    const envelope = readDataRecord(parsed);
    const keys = Object.keys(
      envelope
    ).sort();
    if (
      keys.length < 1 ||
      keys.length > 2 ||
      keys[0] !== "data" ||
      (
        keys.length === 2 &&
        keys[1] !== "errors"
      ) ||
      (
        Object.hasOwn(
          envelope,
          "errors"
        ) &&
        (
          !Array.isArray(
            envelope.errors
          ) ||
          envelope.errors.length > 0
        )
      )
    ) {
      return null;
    }
    return readDataRecord(envelope.data);
  } catch {
    return null;
  }
}

function parseObservedIssue(
  value: unknown
): LinearTransitionObservedIssue {
  const issue = readExactRecord(value, [
    "id",
    "identifier",
    "updatedAt",
    "team",
    "project",
    "state"
  ]);
  const team = readExactRecord(
    issue.team,
    ["id", "organization"]
  );
  const organization =
    readExactRecord(
      team.organization,
      ["id"]
    );
  const project = readExactRecord(
    issue.project,
    ["id"]
  );
  const state = readExactRecord(
    issue.state,
    ["id", "type"]
  );
  if (
    typeof issue.identifier !==
      "string" ||
    !IDENTIFIER_PATTERN.test(
      issue.identifier
    ) ||
    typeof state.type !== "string" ||
    state.type !== state.type.trim() ||
    state.type.length === 0 ||
    state.type.length > 64 ||
    !/^[a-z][a-z_]*$/.test(
      state.type
    )
  ) {
    throw invalidInput();
  }
  return {
    id: normalizeUuid(issue.id),
    identifier: issue.identifier,
    revisionId:
      normalizeTimestamp(
        issue.updatedAt
      ),
    stateType: state.type,
    placement: {
      organizationId: normalizeUuid(
        organization.id
      ),
      teamId: normalizeUuid(team.id),
      projectId: normalizeUuid(
        project.id
      ),
      stateId: normalizeUuid(state.id)
    }
  };
}

function normalizeUuid(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    throw invalidInput();
  }
  return value;
}

function normalizeTimestamp(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(
      Date.parse(value)
    ).toISOString() !== value
  ) {
    throw invalidInput();
  }
  return value;
}

function readExactRecord<
  const Keys extends readonly string[]
>(
  value: unknown,
  expectedKeys: Keys
): Record<Keys[number], unknown> {
  const record = readDataRecord(value);
  requireExactKeys(record, expectedKeys);
  return record as Record<
    Keys[number],
    unknown
  >;
}

function readDataRecord(
  value: unknown
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (
      Object.getPrototypeOf(value) !==
        Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
  ) {
    throw invalidInput();
  }
  const descriptors =
    Object.getOwnPropertyDescriptors(value);
  const result = Object.create(
    null
  ) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw invalidInput();
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalidInput();
    }
    result[key] = descriptor.value;
  }
  return result;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) => key !== expected[index]
    )
  ) {
    throw invalidInput();
  }
}

function readFailed(): LinearTransitionReadResult {
  return freezeResult({
    kind: "failed",
    diagnosticCode:
      "LINEAR_RECONCILIATION_FAILED"
  });
}

function updateUnknown(): LinearTransitionUpdateResult {
  return freezeResult({
    kind: "outcome_unknown",
    diagnosticCode:
      "LINEAR_WRITE_OUTCOME_UNKNOWN"
  });
}

function freezeResult<T>(value: T): T {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const nested of Object.values(value)) {
    freezeResult(nested);
  }
  return Object.freeze(value);
}

function invalidInput(): LinearTransitionTransportError {
  return new LinearTransitionTransportError(
    "LINEAR_TRANSITION_TRANSPORT_INVALID_INPUT",
    "Linear transition transport input is invalid."
  );
}

export class LinearTransitionTransportError
  extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name =
      "LinearTransitionTransportError";
    this.code = code;
  }
}
