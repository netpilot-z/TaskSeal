import type {
  ResolvedLinearReadyWorkScope
} from "./linear-bootstrap-scope.ts";
import {
  LINEAR_GRAPHQL_REQUEST_BYTE_LIMIT,
  LINEAR_GRAPHQL_RESPONSE_BYTE_LIMIT
} from "./linear-graphql-http-exchange.ts";

const PAGE_SIZE = 50;
const MAXIMUM_PAGES = 20;
const MAXIMUM_DEPENDENCIES = 50;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LIST_READY_ISSUES_QUERY =
  `query TaskSealListLinearReadyIssues($teamId: ID!, $projectId: ID!, $stateId: ID!, $after: String) {
  organization {
    id
  }
  issues(
    filter: {
      team: { id: { eq: $teamId } }
      project: { id: { eq: $projectId } }
      state: { id: { eq: $stateId } }
    }
    first: 50
    after: $after
    includeArchived: false
  ) {
    nodes {
      id
      identifier
      title
      url
      createdAt
      updatedAt
      team {
        id
        key
      }
      project {
        id
      }
      state {
        id
        name
        type
      }
      inverseRelations(first: 50, includeArchived: false) {
        nodes {
          id
          type
          issue {
            id
          }
          relatedIssue {
            id
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

const READ_DEPENDENCY_STATES_QUERY =
  `query TaskSealReadLinearDependencyStates($issueIds: [ID!]!) {
  organization {
    id
  }
  issues(
    filter: { id: { in: $issueIds } }
    first: 50
    includeArchived: false
  ) {
    nodes {
      id
      team {
        id
      }
      project {
        id
      }
      state {
        id
        name
        type
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

export interface LinearReadyWorkGraphqlRequest {
  readonly schemaVersion: 1;
  readonly operation:
    | "list_ready_issues"
    | "read_dependency_states";
  readonly body: string;
}

export type LinearReadyWorkGraphqlExchange = (
  request: LinearReadyWorkGraphqlRequest
) => Promise<unknown>;

export interface LinearReadyWorkIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly blockedByIssueIds: readonly string[];
  readonly dependencyCompleteness:
    | "complete"
    | "unknown";
}

export interface LinearReadyWorkIssueState {
  readonly issueId: string;
  readonly stateId: string;
  readonly stateType: string;
}

interface LinearReadyWorkReadOptions {
  readonly scope: ResolvedLinearReadyWorkScope;
  readonly exchange: LinearReadyWorkGraphqlExchange;
}

interface ReadLinearReadyWorkIssueStatesOptions
  extends LinearReadyWorkReadOptions {
  readonly issueIds: readonly string[];
}

interface Connection {
  readonly nodes: readonly unknown[];
  readonly pageInfo: {
    readonly hasNextPage: boolean;
    readonly endCursor: unknown;
  };
}

export async function listLinearReadyWorkIssues(
  optionsValue: unknown
): Promise<readonly LinearReadyWorkIssue[]> {
  const { scope, exchange } =
    normalizeReadOptions(optionsValue);
  const byId =
    new Map<string, LinearReadyWorkIssue>();
  const visitedCursors = new Set<string>();
  let after: string | null = null;

  for (let page = 0; ; page += 1) {
    if (page >= MAXIMUM_PAGES) {
      throw readyError(
        "LINEAR_READY_PAGINATION_LIMIT",
        "Linear ready-work pagination exceeded the safety limit."
      );
    }

    const data = await requestGraphql({
      exchange,
      operation: "list_ready_issues",
      operationName:
        "TaskSealListLinearReadyIssues",
      query: LIST_READY_ISSUES_QUERY,
      variables: {
        teamId: scope.teamId,
        projectId: scope.projectId,
        stateId: scope.readyStateId,
        after
      }
    });
    validateOrganization(
      data.organization,
      scope.organizationId
    );
    const connection = parseConnection(
      data.issues
    );

    for (const node of connection.nodes) {
      const issue = parseReadyIssue(
        node,
        scope
      );
      const existing = byId.get(issue.id);

      if (
        existing !== undefined &&
        JSON.stringify(existing) !==
          JSON.stringify(issue)
      ) {
        throw readyError(
          "LINEAR_READY_RESPONSE_INVALID",
          "Linear issue identity changed during ready-work pagination."
        );
      }

      byId.set(issue.id, issue);
    }

    const next = readNextCursor(
      connection,
      visitedCursors
    );

    if (next === null) {
      break;
    }

    after = next;
  }

  return Object.freeze(
    [...byId.values()]
      .sort((left, right) =>
        left.id.localeCompare(right.id)
      )
      .map(freezeIssue)
  );
}

export async function readLinearReadyWorkIssueStates(
  optionsValue: unknown
): Promise<readonly LinearReadyWorkIssueState[]> {
  const { scope, exchange, issueIds } =
    normalizeStateReadOptions(optionsValue);

  if (issueIds.length === 0) {
    return Object.freeze([]);
  }

  const data = await requestGraphql({
    exchange,
    operation: "read_dependency_states",
    operationName:
      "TaskSealReadLinearDependencyStates",
    query: READ_DEPENDENCY_STATES_QUERY,
    variables: { issueIds }
  });
  validateOrganization(
    data.organization,
    scope.organizationId
  );
  const connection = parseConnection(
    data.issues
  );

  if (connection.pageInfo.hasNextPage) {
    throw readyError(
      "LINEAR_READY_PAGINATION_LIMIT",
      "Linear dependency state response exceeded the safety limit."
    );
  }

  const requested = new Set(issueIds);
  const byId =
    new Map<string, LinearReadyWorkIssueState>();

  for (const node of connection.nodes) {
    const record = readDataRecord(node);
    const issueId = parseUuid(
      record.id,
      "dependency issue"
    );

    if (!requested.has(issueId)) {
      throw readyError(
        "LINEAR_READY_RESPONSE_INVALID",
        "Linear returned an unrequested dependency issue."
      );
    }

    validateIssueScope(record, scope, false);
    const state = readDataRecord(record.state);
    const value = Object.freeze({
      issueId,
      stateId: parseUuid(
        state.id,
        "dependency state"
      ),
      stateType: parseRemoteText(
        state.type,
        "dependency state type"
      )
    });
    const existing = byId.get(issueId);

    if (
      existing !== undefined &&
      JSON.stringify(existing) !==
        JSON.stringify(value)
    ) {
      throw readyError(
        "LINEAR_READY_RESPONSE_INVALID",
        "Linear dependency identity changed during the read."
      );
    }

    byId.set(issueId, value);
  }

  return Object.freeze(
    [...byId.values()].sort((left, right) =>
      left.issueId.localeCompare(
        right.issueId
      )
    )
  );
}

function parseReadyIssue(
  value: unknown,
  scope: ResolvedLinearReadyWorkScope
): LinearReadyWorkIssue {
  const issue = readDataRecord(value);
  const id = parseUuid(issue.id, "issue");
  validateIssueScope(issue, scope, true);
  const relations = parseConnection(
    issue.inverseRelations
  );
  const blockers = new Set<string>();

  for (const value of relations.nodes) {
    const relation = readDataRecord(value);
    parseUuid(relation.id, "issue relation");
    const type = parseRemoteText(
      relation.type,
      "issue relation type"
    );
    const blockingIssue = readDataRecord(
      relation.issue
    );
    const blockedIssue = readDataRecord(
      relation.relatedIssue
    );
    const blockingIssueId = parseUuid(
      blockingIssue.id,
      "blocking issue"
    );
    const blockedIssueId = parseUuid(
      blockedIssue.id,
      "blocked issue"
    );

    if (blockedIssueId !== id) {
      throw readyError(
        "LINEAR_READY_RESPONSE_INVALID",
        "Linear returned an invalid inverse issue relation."
      );
    }

    if (type === "blocks") {
      blockers.add(blockingIssueId);
    }
  }

  return {
    id,
    identifier: parseRemoteText(
      issue.identifier,
      "issue identifier"
    ),
    title: parseRemoteText(
      issue.title,
      "issue title"
    ),
    url: parseHttpUrl(issue.url),
    createdAt: parseTimestamp(
      issue.createdAt,
      "issue createdAt"
    ),
    updatedAt: parseTimestamp(
      issue.updatedAt,
      "issue updatedAt"
    ),
    blockedByIssueIds: Object.freeze(
      [...blockers].sort()
    ),
    dependencyCompleteness:
      relations.pageInfo.hasNextPage
        ? "unknown"
        : "complete"
  };
}

function validateIssueScope(
  issue: Record<string, unknown>,
  scope: ResolvedLinearReadyWorkScope,
  requireReadyState: boolean
): void {
  const team = readDataRecord(issue.team);
  const project = readDataRecord(issue.project);
  const state = readDataRecord(issue.state);
  const teamId = parseUuid(team.id, "issue team");
  const projectId = parseUuid(
    project.id,
    "issue project"
  );
  const stateId = parseUuid(
    state.id,
    "issue state"
  );

  if (
    teamId !== scope.teamId ||
    projectId !== scope.projectId ||
    (
      requireReadyState &&
      (
        stateId !== scope.readyStateId ||
        parseRemoteText(
          state.type,
          "issue state type"
        ) !== "unstarted"
      )
    )
  ) {
    throw readyError(
      "LINEAR_READY_SCOPE_MISMATCH",
      "Linear returned an issue outside the configured ready-work scope."
    );
  }

  if (
    requireReadyState &&
    parseRemoteText(
      team.key,
      "issue team key"
    ).toLowerCase() !==
      scope.teamKey.toLowerCase()
  ) {
    throw readyError(
      "LINEAR_READY_SCOPE_MISMATCH",
      "Linear returned an issue outside the configured ready-work scope."
    );
  }
}

function validateOrganization(
  value: unknown,
  organizationId: string
): void {
  const organization = readDataRecord(value);

  if (
    parseUuid(
      organization.id,
      "organization"
    ) !== organizationId
  ) {
    throw readyError(
      "LINEAR_READY_SCOPE_MISMATCH",
      "Linear organization does not match the configured ready-work scope."
    );
  }
}

async function requestGraphql({
  exchange,
  operation,
  operationName,
  query,
  variables
}: {
  readonly exchange:
    LinearReadyWorkGraphqlExchange;
  readonly operation:
    LinearReadyWorkGraphqlRequest["operation"];
  readonly operationName: string;
  readonly query: string;
  readonly variables: Readonly<
    Record<
      string,
      string | null | readonly string[]
    >
  >;
}): Promise<Record<string, unknown>> {
  const body = JSON.stringify({
    operationName,
    query,
    variables
  });

  if (
    Buffer.byteLength(body, "utf8") >
    LINEAR_GRAPHQL_REQUEST_BYTE_LIMIT
  ) {
    throw readyError(
      "LINEAR_READY_INPUT_INVALID",
      "Linear ready-work request is too large."
    );
  }

  let rawResult: unknown;

  try {
    rawResult = await exchange(
      Object.freeze({
        schemaVersion: 1,
        operation,
        body
      })
    );
  } catch {
    throw requestFailed();
  }

  let result: Record<string, unknown>;

  try {
    result = readDataRecord(rawResult);
  } catch {
    throw requestFailed();
  }

  if (
    result.kind !== "response" ||
    typeof result.status !== "number" ||
    !Number.isInteger(result.status) ||
    typeof result.body !== "string" ||
    Buffer.byteLength(
      result.body,
      "utf8"
    ) > LINEAR_GRAPHQL_RESPONSE_BYTE_LIMIT
  ) {
    throw requestFailed();
  }

  let envelope: unknown;

  try {
    envelope = JSON.parse(result.body);
  } catch {
    throw requestFailed();
  }

  if (result.status !== 200) {
    throw requestFailed();
  }

  const root = readDataRecord(envelope);

  if (
    (
      Object.hasOwn(root, "errors") &&
      (
        !Array.isArray(root.errors) ||
        root.errors.length > 0
      )
    ) ||
    !Object.hasOwn(root, "data")
  ) {
    throw requestFailed();
  }

  return readDataRecord(root.data);
}

function normalizeReadOptions(
  value: unknown
): LinearReadyWorkReadOptions {
  const options = readExactRecord(value, [
    "scope",
    "exchange"
  ]);

  if (typeof options.exchange !== "function") {
    throw inputInvalid();
  }

  return {
    scope: parseScope(options.scope),
    exchange:
      options.exchange as LinearReadyWorkGraphqlExchange
  };
}

function normalizeStateReadOptions(
  value: unknown
): ReadLinearReadyWorkIssueStatesOptions {
  const options = readExactRecord(value, [
    "scope",
    "issueIds",
    "exchange"
  ]);

  if (
    typeof options.exchange !== "function" ||
    !Array.isArray(options.issueIds) ||
    options.issueIds.length >
      MAXIMUM_DEPENDENCIES
  ) {
    throw inputInvalid();
  }

  const issueIds = [
    ...new Set(
      options.issueIds.map((issueId) =>
        parseInputUuid(issueId)
      )
    )
  ].sort();

  return {
    scope: parseScope(options.scope),
    issueIds,
    exchange:
      options.exchange as LinearReadyWorkGraphqlExchange
  };
}

function parseScope(
  value: unknown
): ResolvedLinearReadyWorkScope {
  const scope = readExactRecord(value, [
    "organizationId",
    "teamId",
    "teamKey",
    "projectId",
    "readyStateId",
    "completedStateId"
  ]);

  return {
    organizationId: parseInputUuid(
      scope.organizationId
    ),
    teamId: parseInputUuid(scope.teamId),
    teamKey: parseInputText(scope.teamKey),
    projectId: parseInputUuid(
      scope.projectId
    ),
    readyStateId: parseInputUuid(
      scope.readyStateId
    ),
    completedStateId: parseInputUuid(
      scope.completedStateId
    )
  };
}

function parseConnection(
  value: unknown
): Connection {
  const connection = readDataRecord(value);
  const pageInfo = readDataRecord(
    connection.pageInfo
  );

  if (
    !Array.isArray(connection.nodes) ||
    connection.nodes.length > PAGE_SIZE ||
    typeof pageInfo.hasNextPage !==
      "boolean"
  ) {
    throw responseInvalid();
  }

  return {
    nodes: connection.nodes,
    pageInfo: {
      hasNextPage: pageInfo.hasNextPage,
      endCursor: pageInfo.endCursor
    }
  };
}

function readNextCursor(
  connection: Connection,
  visited: Set<string>
): string | null {
  if (!connection.pageInfo.hasNextPage) {
    return null;
  }

  const cursor = connection.pageInfo.endCursor;

  if (
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    cursor.length > 512 ||
    visited.has(cursor)
  ) {
    throw readyError(
      "LINEAR_READY_PAGINATION_INVALID",
      "Linear returned an invalid ready-work cursor."
    );
  }

  visited.add(cursor);
  return cursor;
}

function freezeIssue(
  issue: LinearReadyWorkIssue
): LinearReadyWorkIssue {
  return Object.freeze({
    ...issue,
    blockedByIssueIds: Object.freeze([
      ...issue.blockedByIssueIds
    ])
  });
}

function parseInputUuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    throw inputInvalid();
  }

  return value.toLowerCase();
}

function parseInputText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > 256
  ) {
    throw inputInvalid();
  }

  return value;
}

function parseUuid(
  value: unknown,
  label: string
): string {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    throw readyError(
      "LINEAR_READY_RESPONSE_INVALID",
      `Linear ${label} identity is invalid.`
    );
  }

  return value.toLowerCase();
}

function parseRemoteText(
  value: unknown,
  label: string
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !value.isWellFormed() ||
    [...value].length > 512 ||
    Buffer.byteLength(value, "utf8") >
      4_096
  ) {
    throw readyError(
      "LINEAR_READY_RESPONSE_INVALID",
      `Linear ${label} is invalid.`
    );
  }

  return value;
}

function parseHttpUrl(value: unknown): string {
  const url = parseRemoteText(
    value,
    "issue URL"
  );
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw responseInvalid();
  }

  if (
    (parsed.protocol !== "https:" &&
      parsed.protocol !== "http:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw responseInvalid();
  }

  return url;
}

function parseTimestamp(
  value: unknown,
  label: string
): string {
  const timestamp = parseRemoteText(
    value,
    label
  );

  if (!Number.isFinite(Date.parse(timestamp))) {
    throw responseInvalid();
  }

  return timestamp;
}

function readExactRecord(
  value: unknown,
  expectedKeys: readonly string[]
): Record<string, unknown> {
  const record = readDataRecord(value);
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();

  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) => key !== expected[index]
    )
  ) {
    throw inputInvalid();
  }

  return record;
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
    throw responseInvalid();
  }

  const descriptors =
    Object.getOwnPropertyDescriptors(value);
  const record = Object.create(
    null
  ) as Record<string, unknown>;

  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw responseInvalid();
    }

    const descriptor = descriptors[key];

    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw responseInvalid();
    }

    record[key] = descriptor.value;
  }

  return record;
}

function inputInvalid(): LinearReadyWorkReadError {
  return readyError(
    "LINEAR_READY_INPUT_INVALID",
    "Linear ready-work input is invalid."
  );
}

function responseInvalid(): LinearReadyWorkReadError {
  return readyError(
    "LINEAR_READY_RESPONSE_INVALID",
    "Linear returned invalid ready-work data."
  );
}

function requestFailed(): LinearReadyWorkReadError {
  return readyError(
    "LINEAR_READY_REQUEST_FAILED",
    "Linear ready-work request failed before a trusted response was available."
  );
}

export class LinearReadyWorkReadError
  extends Error
{
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LinearReadyWorkReadError";
    this.code = code;
  }
}

function readyError(
  code: string,
  message: string
): LinearReadyWorkReadError {
  return new LinearReadyWorkReadError(
    code,
    message
  );
}
