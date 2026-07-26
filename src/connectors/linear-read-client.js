import { isLinearIssueReference } from "./linear.js";

const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
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
  }
}`;

export async function readLinearIssue({
  workspace,
  team,
  issueReference,
  apiKey,
  accessToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000
}) {
  requireNonEmptyString(workspace, "workspace");
  requireNonEmptyString(team, "team");
  requireNonEmptyString(issueReference, "issueReference");

  if (!isLinearIssueReference(issueReference)) {
    throw invalidIssueReference();
  }

  requireFetch(fetchImpl);
  validateTimeout(timeoutMs);
  const authorization = resolveAuthorization({ apiKey, accessToken });
  const request = (query, variables) =>
    postGraphql({
      query,
      variables,
      authorization,
      fetchImpl,
      timeoutMs
    });

  let after = null;
  let organization = null;
  const teams = [];
  const visitedCursors = new Set();

  for (let page = 0; ; page += 1) {
    if (page >= MAX_TEAM_PAGES) {
      throw linearError(
        "LINEAR_PAGINATION_LIMIT",
        "Linear team pagination exceeded the safety limit."
      );
    }

    const data = await request(RESOLVE_SCOPE_QUERY, { after });
    const pageOrganization = validateOrganization(data?.organization);
    const connection = data?.teams;

    if (
      !connection ||
      !Array.isArray(connection.nodes) ||
      !connection.pageInfo ||
      typeof connection.pageInfo.hasNextPage !== "boolean"
    ) {
      throw invalidResponse("Linear returned an invalid teams connection.");
    }

    if (organization && organization.id !== pageOrganization.id) {
      throw invalidResponse(
        "Linear organization changed during team pagination."
      );
    }

    organization = pageOrganization;
    teams.push(...connection.nodes.map(validateTeam));

    if (!connection.pageInfo.hasNextPage) {
      break;
    }

    const nextCursor = connection.pageInfo.endCursor;

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

  if (normalizeReference(organization.name) !== normalizeReference(workspace)) {
    throw linearError(
      "LINEAR_WORKSPACE_MISMATCH",
      `Configured Linear workspace "${workspace}" does not match the authenticated organization "${organization.name}".`
    );
  }

  const teamReference = normalizeReference(team);
  const matchingTeams = [
    ...new Map(
      teams
        .filter(
          (candidate) =>
            normalizeReference(candidate.key) === teamReference ||
            normalizeReference(candidate.name) === teamReference
        )
        .map((candidate) => [candidate.id, candidate])
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

  const [resolvedTeam] = matchingTeams;
  const issueId = resolveIssueReference(issueReference, resolvedTeam);
  const issueData = await request(READ_ISSUE_QUERY, { id: issueId });
  const issue = issueData?.issue;

  if (!issue) {
    throw linearError(
      "LINEAR_ISSUE_NOT_FOUND",
      "The requested Linear issue was not found or is not accessible."
    );
  }

  const returnedIdentifier =
    /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(issue.identifier ?? "");
  const returnedIdentifierMatches =
    returnedIdentifier &&
    Number.isSafeInteger(Number(returnedIdentifier[2])) &&
    Number(returnedIdentifier[2]) > 0 &&
    normalizeReference(returnedIdentifier[1]) ===
      normalizeReference(resolvedTeam.key);
  const returnedTeamMatches =
    issue.team?.id === resolvedTeam.id &&
    normalizeReference(issue.team?.key ?? "") ===
      normalizeReference(resolvedTeam.key);

  if (!returnedIdentifierMatches || !returnedTeamMatches) {
    throw linearError(
      "LINEAR_ISSUE_TEAM_MISMATCH",
      "The requested Linear issue does not belong to the configured team."
    );
  }

  return {
    organization,
    team: resolvedTeam,
    issue
  };
}

async function postGraphql({
  query,
  variables,
  authorization,
  fetchImpl,
  timeoutMs
}) {
  let response;

  try {
    response = await fetchImpl(LINEAR_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query, variables }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw linearError(
      "LINEAR_REQUEST_FAILED",
      "Linear request failed before a valid response was received."
    );
  }

  if (!response || typeof response.status !== "number") {
    throw invalidResponse("Linear returned an invalid HTTP response.");
  }

  if (!response.ok && response.status !== 400) {
    throw linearHttpError(response.status);
  }

  let body;

  try {
    body = await response.json();
  } catch {
    if (!response.ok) {
      throw linearHttpError(response.status);
    }

    throw invalidResponse(
      "Linear returned a response that was not valid JSON."
    );
  }

  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    const codes = body.errors
      .map((error) => error?.extensions?.code)
      .filter((code) => typeof code === "string");

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

  if (!response.ok) {
    throw linearHttpError(response.status);
  }

  if (!body?.data || typeof body.data !== "object") {
    throw invalidResponse("Linear returned a response without GraphQL data.");
  }

  return body.data;
}

function resolveAuthorization({ apiKey, accessToken }) {
  const hasApiKey = hasCredential(apiKey);
  const hasAccessToken = hasCredential(accessToken);

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

  const credential = hasApiKey ? apiKey : accessToken;

  if (/[\r\n]/.test(credential)) {
    throw linearError(
      "LINEAR_AUTH_INVALID",
      "Linear credentials must use a single-line value."
    );
  }

  return hasApiKey ? credential : `Bearer ${credential}`;
}

function resolveIssueReference(issueReference, team) {
  const value = issueReference.trim();

  if (/^\d+$/.test(value)) {
    const number = Number(value);

    if (!Number.isSafeInteger(number) || number <= 0) {
      throw invalidIssueReference();
    }

    return `${team.key}-${number}`;
  }

  const identifier = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(value);

  if (identifier) {
    if (normalizeReference(identifier[1]) !== normalizeReference(team.key)) {
      throw linearError(
        "LINEAR_ISSUE_TEAM_MISMATCH",
        "The Linear issue identifier does not match the configured team key."
      );
    }

    return `${team.key}-${Number(identifier[2])}`;
  }

  if (isLinearIssueReference(value)) {
    return value;
  }

  throw invalidIssueReference();
}

function validateOrganization(value) {
  if (
    !value ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    typeof value.urlKey !== "string" ||
    value.urlKey.length === 0
  ) {
    throw invalidResponse("Linear returned an invalid organization.");
  }

  return value;
}

function validateTeam(value) {
  if (
    !value ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    typeof value.key !== "string" ||
    value.key.length === 0
  ) {
    throw invalidResponse("Linear returned an invalid team.");
  }

  return value;
}

function linearHttpError(status) {
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

function hasCredential(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeReference(value) {
  return value.trim().toLowerCase();
}

function validateTimeout(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw linearError(
      "LINEAR_TIMEOUT_INVALID",
      "Linear timeout must be a positive integer."
    );
  }
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw linearError(
      "LINEAR_INPUT_INVALID",
      `Linear ${field} must be a non-empty string.`
    );
  }
}

function requireFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw linearError(
      "LINEAR_FETCH_INVALID",
      "Linear read client requires a fetch implementation."
    );
  }
}

function invalidIssueReference() {
  return linearError(
    "LINEAR_ISSUE_REFERENCE_INVALID",
    "Linear issue reference must be a positive number, identifier, or UUID."
  );
}

function invalidResponse(message) {
  return linearError("LINEAR_RESPONSE_INVALID", message);
}

function linearError(code, message) {
  const error = new Error(message);
  error.name = "LinearReadError";
  error.code = code;
  return error;
}
