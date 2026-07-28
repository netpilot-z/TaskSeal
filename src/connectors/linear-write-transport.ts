import type {
  LinearWriteCreateInput,
  LinearWriteCreateInputV2,
  LinearWriteCreateResult,
  LinearWriteCreateResultV2,
  LinearWriteObservedPlacementV2,
  LinearWriteQueryInput,
  LinearWriteQueryInputV2,
  LinearWriteQueryResult,
  LinearWriteQueryResultV2,
  LinearWriteTransportPort,
  LinearWriteTransportV2Port
} from "../application/linear-write-transport.ts";

export const LINEAR_WRITE_REQUEST_BYTE_LIMIT =
  128 * 1024;
export const LINEAR_WRITE_RESPONSE_BYTE_LIMIT =
  64 * 1024;

const CREATE_ISSUE_MUTATION = `mutation TaskSealCreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      id
      identifier
      team {
        id
      }
    }
  }
}`;

const QUERY_ISSUE = `query TaskSealQueryIssue($id: String!) {
  issue(id: $id) {
    id
    identifier
    team {
      id
    }
  }
}`;

const CREATE_ISSUE_MUTATION_V2 = `mutation TaskSealCreateIssueV2($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      id
      identifier
      team {
        id
        organization {
          id
        }
      }
      project {
        id
      }
      state {
        id
      }
      parent {
        id
      }
    }
  }
}`;

const QUERY_ISSUE_V2 = `query TaskSealQueryIssueV2($id: String!) {
  issue(id: $id) {
    id
    identifier
    team {
      id
      organization {
        id
      }
    }
    project {
      id
    }
    state {
      id
    }
    parent {
      id
    }
  }
}`;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISSUE_IDENTIFIER_PATTERN =
  /^[A-Z][A-Z0-9]{0,15}-[1-9][0-9]{0,15}$/;

export interface LinearWriteGraphqlRequest {
  readonly schemaVersion: 1;
  readonly operation:
    | "issue_create"
    | "issue_by_id"
    | "issue_create_v2"
    | "issue_by_id_v2";
  readonly body: string;
}

export type LinearWriteGraphqlExchange = (
  request: LinearWriteGraphqlRequest
) => Promise<unknown>;

export type LinearWriteGraphqlExchangeResult =
  | {
      kind: "not_dispatched";
    }
  | {
      kind: "response_lost";
    }
  | {
      kind: "response";
      status: number;
      body: string;
    };

interface NormalizedResponse {
  status: number;
  body: string;
}

interface ParsedIssue {
  id: string;
  identifier: string;
  teamId: string;
}

interface ParsedIssueV2 {
  id: string;
  identifier: string;
  observedPlacement:
    LinearWriteObservedPlacementV2;
}

export class InjectedLinearWriteTransport
  implements
    LinearWriteTransportPort,
    LinearWriteTransportV2Port
{
  readonly #exchange: LinearWriteGraphqlExchange;

  constructor(exchange: unknown) {
    if (typeof exchange !== "function") {
      throw new LinearWriteTransportError(
        "LINEAR_WRITE_TRANSPORT_INVALID_EXCHANGE",
        "Linear write transport requires an injected exchange."
      );
    }
    this.#exchange =
      exchange as LinearWriteGraphqlExchange;
  }

  async createIssue(
    inputValue: unknown
  ): Promise<LinearWriteCreateResult> {
    let input: LinearWriteCreateInput;
    try {
      input = normalizeCreateInput(inputValue);
    } catch {
      throw invalidInput();
    }
    const request = createRequest(
      "issue_create",
      {
        operationName: "TaskSealCreateIssue",
        query: CREATE_ISSUE_MUTATION,
        variables: {
          input: {
            id: input.clientRequestId,
            teamId: input.teamId,
            title: input.title,
            description: input.description
          }
        }
      }
    );

    let exchanged: unknown;
    try {
      exchanged = await this.#exchange(request);
    } catch {
      return outcomeUnknown();
    }

    const exchangeResult =
      normalizeExchangeResult(exchanged);
    if (exchangeResult === null) {
      return outcomeUnknown();
    }
    if (exchangeResult.kind === "not_dispatched") {
      return notDispatched();
    }
    if (exchangeResult.kind === "response_lost") {
      return outcomeUnknown();
    }

    const issue = parseCreateResponse(
      exchangeResult,
      input
    );
    if (issue === null) {
      return outcomeUnknown();
    }
    return freezeResult({
      kind: "created",
      issue: {
        id: issue.id,
        identifier: issue.identifier
      },
      observedTeamId: issue.teamId
    });
  }

  async queryByClientUuid(
    inputValue: unknown
  ): Promise<LinearWriteQueryResult> {
    let input: LinearWriteQueryInput;
    try {
      input = normalizeQueryInput(inputValue);
    } catch {
      throw invalidInput();
    }
    const request = createRequest(
      "issue_by_id",
      {
        operationName: "TaskSealQueryIssue",
        query: QUERY_ISSUE,
        variables: {
          id: input.clientRequestId
        }
      }
    );

    let exchanged: unknown;
    try {
      exchanged = await this.#exchange(request);
    } catch {
      return reconciliationFailed();
    }

    const exchangeResult =
      normalizeExchangeResult(exchanged);
    if (
      exchangeResult === null ||
      exchangeResult.kind !== "response"
    ) {
      return reconciliationFailed();
    }

    const parsed = parseQueryResponse(
      exchangeResult,
      input
    );
    if (parsed === "failed") {
      return reconciliationFailed();
    }
    if (parsed === "absent") {
      return freezeResult({ kind: "absent" });
    }
    if (parsed === "ambiguous") {
      return reconciliationAmbiguous();
    }
    return freezeResult({
      kind: "found",
      issue: {
        id: parsed.id,
        identifier: parsed.identifier
      },
      observedTeamId: parsed.teamId
    });
  }

  async createIssueV2(
    inputValue: unknown
  ): Promise<LinearWriteCreateResultV2> {
    let input: LinearWriteCreateInputV2;
    try {
      input = normalizeCreateInputV2(
        inputValue
      );
    } catch {
      throw invalidInput();
    }
    const request = createRequest(
      "issue_create_v2",
      {
        operationName: "TaskSealCreateIssueV2",
        query: CREATE_ISSUE_MUTATION_V2,
        variables: {
          input: {
            id: input.clientRequestId,
            teamId: input.teamId,
            projectId: input.projectId,
            stateId: input.stateId,
            parentId: input.parentIssueId,
            title: input.title,
            description: input.description
          }
        }
      }
    );

    let exchanged: unknown;
    try {
      exchanged = await this.#exchange(request);
    } catch {
      return outcomeUnknownV2();
    }

    const exchangeResult =
      normalizeExchangeResult(exchanged);
    if (exchangeResult === null) {
      return outcomeUnknownV2();
    }
    if (exchangeResult.kind === "not_dispatched") {
      return notDispatchedV2();
    }
    if (exchangeResult.kind === "response_lost") {
      return outcomeUnknownV2();
    }

    const issue = parseCreateResponseV2(
      exchangeResult,
      input
    );
    if (issue === null) {
      return outcomeUnknownV2();
    }
    return freezeResult({
      kind: "created",
      issue: {
        id: issue.id,
        identifier: issue.identifier
      },
      observedPlacement:
        issue.observedPlacement
    });
  }

  async queryByClientUuidV2(
    inputValue: unknown
  ): Promise<LinearWriteQueryResultV2> {
    let input: LinearWriteQueryInputV2;
    try {
      input = normalizeQueryInputV2(
        inputValue
      );
    } catch {
      throw invalidInput();
    }
    const request = createRequest(
      "issue_by_id_v2",
      {
        operationName: "TaskSealQueryIssueV2",
        query: QUERY_ISSUE_V2,
        variables: {
          id: input.clientRequestId
        }
      }
    );

    let exchanged: unknown;
    try {
      exchanged = await this.#exchange(request);
    } catch {
      return reconciliationFailedV2();
    }

    const exchangeResult =
      normalizeExchangeResult(exchanged);
    if (
      exchangeResult === null ||
      exchangeResult.kind !== "response"
    ) {
      return reconciliationFailedV2();
    }

    const parsed = parseQueryResponseV2(
      exchangeResult,
      input
    );
    if (parsed === "failed") {
      return reconciliationFailedV2();
    }
    if (parsed === "absent") {
      return freezeResult({ kind: "absent" });
    }
    if (parsed === "ambiguous") {
      return reconciliationAmbiguousV2();
    }
    return freezeResult({
      kind: "found",
      issue: {
        id: parsed.id,
        identifier: parsed.identifier
      },
      observedPlacement:
        parsed.observedPlacement
    });
  }
}

function normalizeCreateInput(
  value: unknown
): LinearWriteCreateInput {
  const input = readExactRecord(value, [
    "clientRequestId",
    "teamId",
    "title",
    "description"
  ]);

  return {
    clientRequestId: normalizeUuid(
      input.clientRequestId,
      true
    ),
    teamId: normalizeUuid(input.teamId, false),
    title: normalizeText(input.title, {
      maximumCodePoints: 256,
      maximumBytes: 1_024,
      allowEmpty: false,
      multiline: false
    }),
    description: normalizeText(
      input.description,
      {
        maximumCodePoints: 16_384,
        maximumBytes: 65_536,
        allowEmpty: true,
        multiline: true
      }
    )
  };
}

function normalizeQueryInput(
  value: unknown
): LinearWriteQueryInput {
  const input = readExactRecord(value, [
    "clientRequestId",
    "teamId"
  ]);

  return {
    clientRequestId: normalizeUuid(
      input.clientRequestId,
      true
    ),
    teamId: normalizeUuid(input.teamId, false)
  };
}

function normalizeCreateInputV2(
  value: unknown
): LinearWriteCreateInputV2 {
  const input = readExactRecord(value, [
    "clientRequestId",
    "organizationId",
    "teamId",
    "projectId",
    "stateId",
    "parentIssueId",
    "title",
    "description"
  ]);

  return {
    clientRequestId: normalizeUuid(
      input.clientRequestId,
      true
    ),
    organizationId: normalizeUuid(
      input.organizationId,
      false
    ),
    teamId: normalizeUuid(input.teamId, false),
    projectId: normalizeUuid(
      input.projectId,
      false
    ),
    stateId: normalizeUuid(
      input.stateId,
      false
    ),
    parentIssueId:
      input.parentIssueId === null
        ? null
        : normalizeUuid(
            input.parentIssueId,
            false
          ),
    title: normalizeText(input.title, {
      maximumCodePoints: 256,
      maximumBytes: 1_024,
      allowEmpty: false,
      multiline: false
    }),
    description: normalizeText(
      input.description,
      {
        maximumCodePoints: 16_384,
        maximumBytes: 65_536,
        allowEmpty: true,
        multiline: true
      }
    )
  };
}

function normalizeQueryInputV2(
  value: unknown
): LinearWriteQueryInputV2 {
  const input = readExactRecord(value, [
    "clientRequestId",
    "organizationId",
    "teamId",
    "projectId",
    "stateId",
    "parentIssueId"
  ]);

  return {
    clientRequestId: normalizeUuid(
      input.clientRequestId,
      true
    ),
    organizationId: normalizeUuid(
      input.organizationId,
      false
    ),
    teamId: normalizeUuid(input.teamId, false),
    projectId: normalizeUuid(
      input.projectId,
      false
    ),
    stateId: normalizeUuid(
      input.stateId,
      false
    ),
    parentIssueId:
      input.parentIssueId === null
        ? null
        : normalizeUuid(
            input.parentIssueId,
            false
          )
  };
}

function createRequest(
  operation: LinearWriteGraphqlRequest["operation"],
  bodyValue: unknown
): LinearWriteGraphqlRequest {
  const body = JSON.stringify(bodyValue);

  if (
    Buffer.byteLength(body, "utf8") >
    LINEAR_WRITE_REQUEST_BYTE_LIMIT
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
): LinearWriteGraphqlExchangeResult | null {
  try {
    const record = readDataRecord(value);
    if (record.kind === "not_dispatched") {
      requireExactKeys(record, ["kind"]);
      return {
        kind: "not_dispatched"
      };
    }
    if (record.kind === "response_lost") {
      requireExactKeys(record, ["kind"]);
      return {
        kind: "response_lost"
      };
    }
    if (record.kind !== "response") {
      return null;
    }
    requireExactKeys(record, [
      "kind",
      "status",
      "body"
    ]);
    if (
      typeof record.status !== "number" ||
      !Number.isSafeInteger(record.status) ||
      record.status < 100 ||
      record.status > 599 ||
      typeof record.body !== "string" ||
      !record.body.isWellFormed()
    ) {
      return null;
    }
    return {
      kind: "response",
      status: record.status,
      body: record.body
    };
  } catch {
    return null;
  }
}

function parseCreateResponse(
  response: NormalizedResponse,
  input: LinearWriteCreateInput
): ParsedIssue | null {
  const data = parseGraphqlData(response);
  if (data === null) {
    return null;
  }

  try {
    const root = readExactRecord(data, [
      "issueCreate"
    ]);
    const payload = readExactRecord(
      root.issueCreate,
      ["success", "issue"]
    );
    if (payload.success !== true) {
      return null;
    }
    const issue = normalizeIssueCandidate(
      parseIssueShape(payload.issue)
    );
    if (issue === null) {
      return null;
    }
    if (
      issue.id !== input.clientRequestId ||
      issue.teamId !== input.teamId
    ) {
      return null;
    }
    return issue;
  } catch {
    return null;
  }
}

function parseQueryResponse(
  response: NormalizedResponse,
  input: LinearWriteQueryInput
): ParsedIssue | "absent" | "failed" | "ambiguous" {
  const data = parseGraphqlData(response);
  if (data === null) {
    return "failed";
  }

  try {
    const root = readExactRecord(data, ["issue"]);
    if (root.issue === null) {
      return "absent";
    }
    const issue = normalizeIssueCandidate(
      parseIssueShape(root.issue)
    );
    if (issue === null) {
      return "ambiguous";
    }
    if (
      issue.id !== input.clientRequestId ||
      issue.teamId !== input.teamId
    ) {
      return "ambiguous";
    }
    return issue;
  } catch {
    return "failed";
  }
}

function parseCreateResponseV2(
  response: NormalizedResponse,
  input: LinearWriteCreateInputV2
): ParsedIssueV2 | null {
  const data = parseGraphqlData(response);
  if (data === null) {
    return null;
  }

  try {
    const root = readExactRecord(data, [
      "issueCreate"
    ]);
    const payload = readExactRecord(
      root.issueCreate,
      ["success", "issue"]
    );
    if (payload.success !== true) {
      return null;
    }
    const shape = parseIssueShapeV2(
      payload.issue
    );
    if (shape === null) {
      return null;
    }
    const issue =
      normalizeIssueCandidateV2(shape);
    if (
      issue === null ||
      !matchesInputV2(issue, input)
    ) {
      return null;
    }
    return issue;
  } catch {
    return null;
  }
}

function parseQueryResponseV2(
  response: NormalizedResponse,
  input: LinearWriteQueryInputV2
):
  | ParsedIssueV2
  | "absent"
  | "failed"
  | "ambiguous" {
  const data = parseGraphqlData(response);
  if (data === null) {
    return "failed";
  }

  try {
    const root = readExactRecord(data, ["issue"]);
    if (root.issue === null) {
      return "absent";
    }
    const shape = parseIssueShapeV2(root.issue);
    if (shape === null) {
      return "ambiguous";
    }
    const issue =
      normalizeIssueCandidateV2(shape);
    if (
      issue === null ||
      !matchesInputV2(issue, input)
    ) {
      return "ambiguous";
    }
    return issue;
  } catch {
    return "failed";
  }
}

function parseGraphqlData(
  response: NormalizedResponse
): Record<string, unknown> | null {
  if (
    response.status < 200 ||
    response.status >= 300 ||
    Buffer.byteLength(response.body, "utf8") >
      LINEAR_WRITE_RESPONSE_BYTE_LIMIT
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
    const keys = Object.keys(envelope).sort();
    if (
      keys.length < 1 ||
      keys.length > 2 ||
      keys[0] !== "data" ||
      (keys.length === 2 && keys[1] !== "errors")
    ) {
      return null;
    }
    if (Object.hasOwn(envelope, "errors")) {
      if (
        !Array.isArray(envelope.errors) ||
        envelope.errors.length > 0
      ) {
        return null;
      }
    }
    return readDataRecord(envelope.data);
  } catch {
    return null;
  }
}

function parseIssueShape(
  value: unknown
): ParsedIssue {
  const issue = readExactRecord(value, [
    "id",
    "identifier",
    "team"
  ]);
  const team = readExactRecord(issue.team, ["id"]);
  if (
    typeof issue.id !== "string" ||
    !issue.id.isWellFormed() ||
    typeof issue.identifier !== "string" ||
    !issue.identifier.isWellFormed() ||
    typeof team.id !== "string" ||
    !team.id.isWellFormed()
  ) {
    throw invalidInput();
  }
  return {
    id: issue.id,
    identifier: issue.identifier,
    teamId: team.id
  };
}

function parseIssueShapeV2(
  value: unknown
): ParsedIssueV2 | null {
  const issue = readExactRecord(value, [
    "id",
    "identifier",
    "team",
    "project",
    "state",
    "parent"
  ]);
  const team = readExactRecord(issue.team, [
    "id",
    "organization"
  ]);
  const organization = readExactRecord(
    team.organization,
    ["id"]
  );
  if (issue.project === null) {
    return null;
  }
  const project = readExactRecord(
    issue.project,
    ["id"]
  );
  const state = readExactRecord(issue.state, [
    "id"
  ]);
  const parent =
    issue.parent === null
      ? null
      : readExactRecord(issue.parent, ["id"]);
  const parentIssueId =
    parent === null ? null : parent.id;

  if (
    typeof issue.id !== "string" ||
    !issue.id.isWellFormed() ||
    typeof issue.identifier !== "string" ||
    !issue.identifier.isWellFormed() ||
    typeof team.id !== "string" ||
    !team.id.isWellFormed() ||
    typeof organization.id !== "string" ||
    !organization.id.isWellFormed() ||
    typeof project.id !== "string" ||
    !project.id.isWellFormed() ||
    typeof state.id !== "string" ||
    !state.id.isWellFormed() ||
    (parentIssueId !== null &&
      (typeof parentIssueId !== "string" ||
        !parentIssueId.isWellFormed()))
  ) {
    throw invalidInput();
  }

  return {
    id: issue.id,
    identifier: issue.identifier,
    observedPlacement: {
      organizationId: organization.id,
      teamId: team.id,
      projectId: project.id,
      stateId: state.id,
      parentIssueId
    }
  };
}

function normalizeIssueCandidate(
  issue: ParsedIssue
): ParsedIssue | null {
  if (
    !UUID_PATTERN.test(issue.id) ||
    !UUID_PATTERN.test(issue.teamId) ||
    issue.identifier !== issue.identifier.trim() ||
    [...issue.identifier].length > 32 ||
    Buffer.byteLength(
      issue.identifier,
      "utf8"
    ) > 128 ||
    !ISSUE_IDENTIFIER_PATTERN.test(
      issue.identifier
    )
  ) {
    return null;
  }
  return issue;
}

function normalizeIssueCandidateV2(
  issue: ParsedIssueV2
): ParsedIssueV2 | null {
  const placement = issue.observedPlacement;
  if (
    !UUID_PATTERN.test(issue.id) ||
    !UUID_PATTERN.test(
      placement.organizationId
    ) ||
    !UUID_PATTERN.test(placement.teamId) ||
    !UUID_PATTERN.test(placement.projectId) ||
    !UUID_PATTERN.test(placement.stateId) ||
    (placement.parentIssueId !== null &&
      !UUID_PATTERN.test(
        placement.parentIssueId
      )) ||
    issue.identifier !== issue.identifier.trim() ||
    [...issue.identifier].length > 32 ||
    Buffer.byteLength(
      issue.identifier,
      "utf8"
    ) > 128 ||
    !ISSUE_IDENTIFIER_PATTERN.test(
      issue.identifier
    )
  ) {
    return null;
  }
  return issue;
}

function matchesInputV2(
  issue: ParsedIssueV2,
  input:
    | LinearWriteCreateInputV2
    | LinearWriteQueryInputV2
): boolean {
  const placement = issue.observedPlacement;
  return (
    issue.id === input.clientRequestId &&
    placement.organizationId ===
      input.organizationId &&
    placement.teamId === input.teamId &&
    placement.projectId === input.projectId &&
    placement.stateId === input.stateId &&
    placement.parentIssueId ===
      input.parentIssueId
  );
}

function normalizeUuid(
  value: unknown,
  versionFour: boolean
): string {
  if (
    typeof value !== "string" ||
    !(versionFour
      ? UUID_V4_PATTERN
      : UUID_PATTERN
    ).test(value)
  ) {
    throw invalidInput();
  }
  return value;
}

function normalizeText(
  value: unknown,
  {
    maximumCodePoints,
    maximumBytes,
    allowEmpty,
    multiline
  }: {
    maximumCodePoints: number;
    maximumBytes: number;
    allowEmpty: boolean;
    multiline: boolean;
  }
): string {
  const forbiddenControl = multiline
    ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/
    : /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value !== value.trim() ||
    (!allowEmpty && value.length === 0) ||
    [...value].length > maximumCodePoints ||
    Buffer.byteLength(value, "utf8") >
      maximumBytes ||
    forbiddenControl.test(value)
  ) {
    throw invalidInput();
  }
  return value;
}

function readExactRecord<const T extends readonly string[]>(
  value: unknown,
  expectedKeys: T
): Record<T[number], unknown> {
  const record = readDataRecord(value);
  requireExactKeys(record, expectedKeys);
  return record as Record<T[number], unknown>;
}

function readDataRecord(
  value: unknown
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !==
      Object.prototype &&
      Object.getPrototypeOf(value) !== null)
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

function notDispatched(): LinearWriteCreateResult {
  return freezeResult({
    kind: "not_dispatched",
    diagnosticCode:
      "LINEAR_WRITE_NOT_DISPATCHED"
  });
}

function outcomeUnknown(): LinearWriteCreateResult {
  return freezeResult({
    kind: "outcome_unknown",
    diagnosticCode:
      "LINEAR_WRITE_OUTCOME_UNKNOWN"
  });
}

function reconciliationFailed(): LinearWriteQueryResult {
  return freezeResult({
    kind: "failed",
    diagnosticCode:
      "LINEAR_RECONCILIATION_FAILED"
  });
}

function reconciliationAmbiguous(): LinearWriteQueryResult {
  return freezeResult({
    kind: "ambiguous",
    diagnosticCode:
      "LINEAR_RECONCILIATION_AMBIGUOUS"
  });
}

function notDispatchedV2(): LinearWriteCreateResultV2 {
  return freezeResult({
    kind: "not_dispatched",
    diagnosticCode:
      "LINEAR_WRITE_NOT_DISPATCHED"
  });
}

function outcomeUnknownV2(): LinearWriteCreateResultV2 {
  return freezeResult({
    kind: "outcome_unknown",
    diagnosticCode:
      "LINEAR_WRITE_OUTCOME_UNKNOWN"
  });
}

function reconciliationFailedV2(): LinearWriteQueryResultV2 {
  return freezeResult({
    kind: "failed",
    diagnosticCode:
      "LINEAR_RECONCILIATION_FAILED"
  });
}

function reconciliationAmbiguousV2(): LinearWriteQueryResultV2 {
  return freezeResult({
    kind: "ambiguous",
    diagnosticCode:
      "LINEAR_RECONCILIATION_AMBIGUOUS"
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

function invalidInput(): LinearWriteTransportError {
  return new LinearWriteTransportError(
    "LINEAR_WRITE_TRANSPORT_INVALID_INPUT",
    "Linear write transport input is invalid."
  );
}

export class LinearWriteTransportError
  extends Error
{
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LinearWriteTransportError";
    this.code = code;
  }
}
