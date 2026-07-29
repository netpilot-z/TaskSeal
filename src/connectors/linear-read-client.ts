import {
  isLinearIssueReference
} from "./linear.ts";

const LINEAR_GRAPHQL_ENDPOINT =
  "https://api.linear.app/graphql";
const MAX_TEAM_PAGES = 20;

const RESOLVE_SCOPE_QUERY = `query TaskSealResolveScope($after: String) {
  organization {
    id
    name
    urlKey
  }
  teams(first: 50, after: $after) {
    nodes {
      id
      name
      key
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

const READ_ISSUE_QUERY = `query TaskSealReadIssue($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    url
    createdAt
    updatedAt
    team {
      id
      key
    }
    project {
      id
      name
    }
  }
}`;

const READ_ISSUE_IDENTITY_QUERY =
  `query TaskSealReadIssueIdentity($id: String!) {
  organization {
    id
  }
  issue(id: $id) {
    id
    identifier
    title
    description
    url
    createdAt
    updatedAt
    team {
      id
      key
    }
    project {
      id
      name
    }
  }
}`;

export interface LinearFetchRequestOptions {
  method: "POST";
  headers: {
    Authorization: string;
    "Content-Type": "application/json";
  };
  body: string;
  redirect: "error";
  signal: AbortSignal;
}

export type LinearFetchLike = (
  url: string,
  options: LinearFetchRequestOptions
) => Promise<unknown>;

export interface LinearOrganization
  extends Record<string, unknown> {
  id: string;
  name: string;
  urlKey: string;
}

export interface LinearTeam
  extends Record<string, unknown> {
  id: string;
  name: string;
  key: string;
}

export interface LinearIssue
  extends Record<string, unknown> {
  id: string;
  identifier: string;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  team: {
    id: string;
    key: string;
  };
  project: {
    id: string;
    name: string;
  };
}

export interface LinearIssueReadResult {
  organization: LinearOrganization;
  team: LinearTeam;
  issue: LinearIssue;
}

export interface ReadLinearIssueOptions {
  workspace: string;
  team: string;
  project: string;
  issueReference: string;
  apiKey?: string | undefined;
  accessToken?: string | undefined;
  fetchImpl?: LinearFetchLike;
  timeoutMs?: number;
}

export interface ReadLinearIssueIdentityOptions {
  issueId: string;
  apiKey?: string | undefined;
  accessToken?: string | undefined;
  fetchImpl?: LinearFetchLike;
  timeoutMs?: number;
}

export interface LinearIssueIdentityReadResult {
  organizationId: string;
  issue: LinearIssue;
}

interface GraphqlRequest {
  query: string;
  variables: Record<string, string | null>;
  authorization: string;
  fetchImpl: LinearFetchLike;
  timeoutMs: number;
}

interface TeamConnection {
  nodes: unknown[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: unknown;
  };
}

export async function readLinearIssue({
  workspace,
  team,
  project,
  issueReference,
  apiKey,
  accessToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000
}: ReadLinearIssueOptions): Promise<LinearIssueReadResult> {
  requireNonEmptyString(workspace, "workspace");
  requireNonEmptyString(team, "team");
  requireNonEmptyString(project, "project");
  requireNonEmptyString(
    issueReference,
    "issueReference"
  );

  if (!isLinearIssueReference(issueReference)) {
    throw invalidIssueReference();
  }

  requireFetch(fetchImpl);
  validateTimeout(timeoutMs);
  const authorization = resolveAuthorization({
    apiKey,
    accessToken
  });
  const request = (
    query: string,
    variables: Record<string, string | null>
  ): Promise<Record<string, unknown>> =>
    postGraphql({
      query,
      variables,
      authorization,
      fetchImpl,
      timeoutMs
    });

  let after: string | null = null;
  let organization: LinearOrganization | null =
    null;
  const teams: LinearTeam[] = [];
  const visitedCursors = new Set<string>();

  for (let page = 0; ; page += 1) {
    if (page >= MAX_TEAM_PAGES) {
      throw linearError(
        "LINEAR_PAGINATION_LIMIT",
        "Linear team pagination exceeded the safety limit."
      );
    }

    const data = await request(
      RESOLVE_SCOPE_QUERY,
      { after }
    );
    const pageOrganization =
      validateOrganization(data.organization);
    const connection = validateTeamConnection(
      data.teams
    );

    if (
      organization &&
      organization.id !== pageOrganization.id
    ) {
      throw invalidResponse(
        "Linear organization changed during team pagination."
      );
    }

    organization = pageOrganization;
    teams.push(
      ...connection.nodes.map(validateTeam)
    );

    if (!connection.pageInfo.hasNextPage) {
      break;
    }

    const nextCursor =
      connection.pageInfo.endCursor;

    if (
      typeof nextCursor !== "string" ||
      nextCursor.length === 0 ||
      visitedCursors.has(nextCursor)
    ) {
      throw linearError(
        "LINEAR_PAGINATION_INVALID",
        "Linear returned an invalid or repeated team cursor."
      );
    }

    visitedCursors.add(nextCursor);
    after = nextCursor;
  }

  if (!organization) {
    throw invalidResponse(
      "Linear returned an invalid organization."
    );
  }

  if (
    normalizeReference(organization.name) !==
    normalizeReference(workspace)
  ) {
    throw linearError(
      "LINEAR_WORKSPACE_MISMATCH",
      `Configured Linear workspace "${workspace}" does not match the authenticated organization "${organization.name}".`
    );
  }

  const teamReference = normalizeReference(team);
  const matchingTeams = [
    ...new Map<string, LinearTeam>(
      teams
        .filter(
          (candidate) =>
            normalizeReference(candidate.key) ===
              teamReference ||
            normalizeReference(candidate.name) ===
              teamReference
        )
        .map((candidate) => [
          candidate.id,
          candidate
        ])
    ).values()
  ];

  if (matchingTeams.length === 0) {
    throw linearError(
      "LINEAR_TEAM_NOT_FOUND",
      `Configured Linear team "${team}" was not found in workspace "${workspace}".`
    );
  }

  if (matchingTeams.length > 1) {
    throw linearError(
      "LINEAR_TEAM_AMBIGUOUS",
      `Configured Linear team reference "${team}" matches multiple teams.`
    );
  }

  const resolvedTeam = matchingTeams[0];

  if (!resolvedTeam) {
    throw linearError(
      "LINEAR_TEAM_NOT_FOUND",
      `Configured Linear team "${team}" was not found in workspace "${workspace}".`
    );
  }

  const issueId = resolveIssueReference(
    issueReference,
    resolvedTeam
  );
  const issueData = await request(
    READ_ISSUE_QUERY,
    { id: issueId }
  );
  const rawIssue = issueData.issue;

  if (rawIssue === null || rawIssue === undefined) {
    throw linearError(
      "LINEAR_ISSUE_NOT_FOUND",
      "The requested Linear issue was not found or is not accessible."
    );
  }

  if (!isLinearIssue(rawIssue)) {
    throw invalidResponse(
      "Linear returned an invalid issue."
    );
  }

  const issue = rawIssue;
  const returnedIdentifier =
    /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(
      issue.identifier
    );
  const identifierNumber =
    returnedIdentifier?.[2];
  const identifierTeam =
    returnedIdentifier?.[1];
  const returnedIdentifierMatches =
    identifierNumber !== undefined &&
    identifierTeam !== undefined &&
    Number.isSafeInteger(Number(identifierNumber)) &&
    Number(identifierNumber) > 0 &&
    normalizeReference(identifierTeam) ===
      normalizeReference(resolvedTeam.key);
  const returnedTeamMatches =
    issue.team.id === resolvedTeam.id &&
    normalizeReference(issue.team.key) ===
      normalizeReference(resolvedTeam.key);
  const returnedProjectMatches =
    normalizeReference(issue.project.name) ===
      normalizeReference(project);

  if (
    !returnedIdentifierMatches ||
    !returnedTeamMatches
  ) {
    throw linearError(
      "LINEAR_ISSUE_TEAM_MISMATCH",
      "The requested Linear issue does not belong to the configured team."
    );
  }

  if (!returnedProjectMatches) {
    throw linearError(
      "LINEAR_ISSUE_PROJECT_MISMATCH",
      "The requested Linear issue does not belong to the configured project."
    );
  }

  return {
    organization,
    team: resolvedTeam,
    issue
  };
}

export async function readLinearIssueIdentity({
  issueId,
  apiKey,
  accessToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000
}: ReadLinearIssueIdentityOptions):
  Promise<LinearIssueIdentityReadResult> {
  if (!isUuid(issueId)) {
    throw invalidIssueReference();
  }

  requireFetch(fetchImpl);
  validateTimeout(timeoutMs);
  const authorization = resolveAuthorization({
    apiKey,
    accessToken
  });
  const data = await postGraphql({
    query: READ_ISSUE_IDENTITY_QUERY,
    variables: {
      id: issueId.toLowerCase()
    },
    authorization,
    fetchImpl,
    timeoutMs
  });
  const organization = data.organization;
  const rawIssue = data.issue;

  if (
    !isRecord(organization) ||
    !isNonEmptyString(organization.id)
  ) {
    throw invalidResponse(
      "Linear returned an invalid organization identity."
    );
  }

  if (rawIssue === null || rawIssue === undefined) {
    throw linearError(
      "LINEAR_ISSUE_NOT_FOUND",
      "The requested Linear issue was not found or is not accessible."
    );
  }

  if (!isLinearIssue(rawIssue)) {
    throw invalidResponse(
      "Linear returned an invalid issue."
    );
  }

  return {
    organizationId: organization.id,
    issue: rawIssue
  };
}

async function postGraphql({
  query,
  variables,
  authorization,
  fetchImpl,
  timeoutMs
}: GraphqlRequest): Promise<Record<string, unknown>> {
  let rawResponse: unknown;

  try {
    rawResponse = await fetchImpl(
      LINEAR_GRAPHQL_ENDPOINT,
      {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query,
          variables
        }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs)
      }
    );
  } catch {
    throw linearError(
      "LINEAR_REQUEST_FAILED",
      "Linear request failed before a valid response was received."
    );
  }

  if (
    !isRecord(rawResponse) ||
    typeof rawResponse.status !== "number"
  ) {
    throw invalidResponse(
      "Linear returned an invalid HTTP response."
    );
  }

  const status = rawResponse.status;
  const ok = rawResponse.ok === true;

  if (!ok && status !== 400) {
    throw linearHttpError(status);
  }

  const json = rawResponse.json;
  let body: unknown;

  try {
    if (typeof json !== "function") {
      throw new TypeError(
        "Missing response json method."
      );
    }

    body = await Reflect.apply(
      json,
      rawResponse,
      []
    );
  } catch {
    if (!ok) {
      throw linearHttpError(status);
    }

    throw invalidResponse(
      "Linear returned a response that was not valid JSON."
    );
  }

  const graphqlErrors =
    validateGraphqlErrors(body);

  if (graphqlErrors.length > 0) {
    const codes = graphqlErrors
      .map(readGraphqlErrorCode)
      .filter(isString);

    if (codes.includes("RATELIMITED")) {
      throw linearError(
        "LINEAR_RATE_LIMITED",
        "Linear rate-limited the read request."
      );
    }

    throw linearError(
      "LINEAR_GRAPHQL_ERROR",
      "Linear returned a GraphQL error for the read request."
    );
  }

  if (!ok) {
    throw linearHttpError(status);
  }

  if (
    !isRecord(body) ||
    !isRecord(body.data)
  ) {
    throw invalidResponse(
      "Linear returned a response without GraphQL data."
    );
  }

  return body.data;
}

function validateTeamConnection(
  value: unknown
): TeamConnection {
  if (
    !isRecord(value) ||
    !Array.isArray(value.nodes) ||
    !isRecord(value.pageInfo) ||
    typeof value.pageInfo.hasNextPage !==
      "boolean"
  ) {
    throw invalidResponse(
      "Linear returned an invalid teams connection."
    );
  }

  return {
    nodes: value.nodes,
    pageInfo: {
      hasNextPage: value.pageInfo.hasNextPage,
      endCursor: value.pageInfo.endCursor
    }
  };
}

function resolveAuthorization({
  apiKey,
  accessToken
}: {
  apiKey: unknown;
  accessToken: unknown;
}): string {
  const hasApiKey = hasCredential(apiKey);
  const hasAccessToken =
    hasCredential(accessToken);

  if (hasApiKey && hasAccessToken) {
    throw linearError(
      "LINEAR_AUTH_CONFLICT",
      "Configure either a Linear API key or OAuth access token, not both."
    );
  }

  if (!hasApiKey && !hasAccessToken) {
    throw linearError(
      "LINEAR_AUTH_MISSING",
      "A Linear API key or OAuth access token is required."
    );
  }

  const credential = hasApiKey
    ? apiKey
    : accessToken;

  if (
    typeof credential !== "string" ||
    /[\r\n]/.test(credential)
  ) {
    throw linearError(
      "LINEAR_AUTH_INVALID",
      "Linear credentials must use a single-line value."
    );
  }

  return hasApiKey
    ? credential
    : `Bearer ${credential}`;
}

function resolveIssueReference(
  issueReference: string,
  team: LinearTeam
): string {
  const value = issueReference.trim();

  if (/^\d+$/.test(value)) {
    const number = Number(value);

    if (
      !Number.isSafeInteger(number) ||
      number <= 0
    ) {
      throw invalidIssueReference();
    }

    return `${team.key}-${number}`;
  }

  const identifier =
    /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(
      value
    );
  const identifierTeam = identifier?.[1];
  const identifierNumber = identifier?.[2];

  if (
    identifierTeam !== undefined &&
    identifierNumber !== undefined
  ) {
    if (
      normalizeReference(identifierTeam) !==
      normalizeReference(team.key)
    ) {
      throw linearError(
        "LINEAR_ISSUE_TEAM_MISMATCH",
        "The Linear issue identifier does not match the configured team key."
      );
    }

    return `${team.key}-${Number(identifierNumber)}`;
  }

  if (isLinearIssueReference(value)) {
    return value;
  }

  throw invalidIssueReference();
}

function validateOrganization(
  value: unknown
): LinearOrganization {
  if (!isLinearOrganization(value)) {
    throw invalidResponse(
      "Linear returned an invalid organization."
    );
  }

  return value;
}

function validateTeam(value: unknown): LinearTeam {
  if (!isLinearTeam(value)) {
    throw invalidResponse(
      "Linear returned an invalid team."
    );
  }

  return value;
}

function isLinearOrganization(
  value: unknown
): value is LinearOrganization {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.urlKey)
  );
}

function isLinearTeam(
  value: unknown
): value is LinearTeam {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.key)
  );
}

function isLinearIssue(
  value: unknown
): value is LinearIssue {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.identifier) &&
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.url) &&
    isNonEmptyString(value.createdAt) &&
    isNonEmptyString(value.updatedAt) &&
    isRecord(value.team) &&
    isNonEmptyString(value.team.id) &&
    isNonEmptyString(value.team.key) &&
    isRecord(value.project) &&
    isNonEmptyString(value.project.id) &&
    isNonEmptyString(value.project.name)
  );
}

function validateGraphqlErrors(
  body: unknown
): unknown[] {
  if (
    !isRecord(body) ||
    !Object.hasOwn(body, "errors")
  ) {
    return [];
  }

  if (!Array.isArray(body.errors)) {
    throw invalidResponse(
      "Linear returned an invalid GraphQL errors member."
    );
  }

  return body.errors;
}

function readGraphqlErrorCode(
  error: unknown
): unknown {
  return isRecord(error) &&
    isRecord(error.extensions)
    ? error.extensions.code
    : undefined;
}

function linearHttpError(
  status: number
): LinearReadError {
  if (status === 401) {
    return linearError(
      "LINEAR_AUTH_FAILED",
      "Linear rejected the configured credentials."
    );
  }

  if (status === 403) {
    return linearError(
      "LINEAR_FORBIDDEN",
      "Linear denied the read request."
    );
  }

  if (status === 429) {
    return linearError(
      "LINEAR_RATE_LIMITED",
      "Linear rate-limited the read request."
    );
  }

  return linearError(
    "LINEAR_HTTP_ERROR",
    `Linear read request failed with HTTP status ${status}.`
  );
}

function hasCredential(
  value: unknown
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0
  );
}

function normalizeReference(value: string): string {
  return value.trim().toLowerCase();
}

function validateTimeout(
  timeoutMs: unknown
): asserts timeoutMs is number {
  if (
    !Number.isInteger(timeoutMs) ||
    typeof timeoutMs !== "number" ||
    timeoutMs <= 0
  ) {
    throw linearError(
      "LINEAR_TIMEOUT_INVALID",
      "Linear timeout must be a positive integer."
    );
  }
}

function requireNonEmptyString(
  value: unknown,
  field: string
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0
  ) {
    throw linearError(
      "LINEAR_INPUT_INVALID",
      `Linear ${field} must be a non-empty string.`
    );
  }
}

function requireFetch(
  fetchImpl: unknown
): asserts fetchImpl is LinearFetchLike {
  if (typeof fetchImpl !== "function") {
    throw linearError(
      "LINEAR_FETCH_INVALID",
      "Linear read client requires a fetch implementation."
    );
  }
}

function invalidIssueReference(): LinearReadError {
  return linearError(
    "LINEAR_ISSUE_REFERENCE_INVALID",
    "Linear issue reference must be a positive number, identifier, or UUID."
  );
}

function invalidResponse(
  message: string
): LinearReadError {
  return linearError(
    "LINEAR_RESPONSE_INVALID",
    message
  );
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}

function isNonEmptyString(
  value: unknown
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0
  );
}

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

export class LinearReadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LinearReadError";
    this.code = code;
  }
}

function linearError(
  code: string,
  message: string
): LinearReadError {
  return new LinearReadError(code, message);
}
