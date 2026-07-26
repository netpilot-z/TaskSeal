const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const MAX_PAGES = 10;

export async function readGitHubIssue({
  repository,
  issueNumber,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000
}) {
  const { owner, name } = parseRepository(repository);
  requirePositiveInteger(issueNumber, "issueNumber");
  requireFetch(fetchImpl);
  validateToken(token);
  validateTimeout(timeoutMs);

  const response = await getJson({
    url:
      `${GITHUB_API_ORIGIN}/repos/` +
      `${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/` +
      issueNumber,
    headers: createHeaders(token),
    fetchImpl,
    timeoutMs
  });
  const issue = response.body;

  if (issue?.pull_request) {
    throw githubError(
      "GITHUB_ISSUE_IS_PULL_REQUEST",
      "The configured GitHub issue number represents a pull request."
    );
  }

  return issue;
}

export async function readGitHubDelivery({
  repository,
  issueNumber,
  pullRequestNumber,
  checkName,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000
}) {
  const { owner, name } = parseRepository(repository);
  requirePositiveInteger(issueNumber, "issueNumber");
  requirePositiveInteger(pullRequestNumber, "pullRequestNumber");
  requireNonEmptyString(checkName, "checkName");
  requireFetch(fetchImpl);
  validateToken(token);
  validateTimeout(timeoutMs);

  const headers = createHeaders(token);
  const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const request = (url) =>
    getJson({
      url,
      headers,
      fetchImpl,
      timeoutMs
    });

  const issueResponse = await request(
    `${GITHUB_API_ORIGIN}${repositoryPath}/issues/${issueNumber}`
  );
  const issue = issueResponse.body;

  if (issue?.pull_request) {
    throw githubError(
      "GITHUB_ISSUE_IS_PULL_REQUEST",
      "The configured GitHub issue number represents a pull request."
    );
  }

  const pullRequestResponse = await request(
    `${GITHUB_API_ORIGIN}${repositoryPath}/pulls/${pullRequestNumber}`
  );
  const pullRequest = pullRequestResponse.body;
  const revision = pullRequest?.head?.sha;

  if (typeof revision !== "string" || revision.length === 0) {
    throw githubError(
      "GITHUB_RESPONSE_INVALID",
      "GitHub returned a pull request without a head revision."
    );
  }

  const parameters = new URLSearchParams({
    check_name: checkName,
    filter: "latest",
    per_page: "100"
  });
  let nextUrl =
    `${GITHUB_API_ORIGIN}${repositoryPath}/commits/` +
    `${encodeURIComponent(revision)}/check-runs?${parameters}`;
  const checks = [];
  const visited = new Set();

  for (let page = 0; nextUrl; page += 1) {
    if (page >= MAX_PAGES) {
      throw githubError(
        "GITHUB_PAGINATION_LIMIT",
        "GitHub check pagination exceeded the safety limit."
      );
    }

    validatePaginationUrl(nextUrl);

    if (visited.has(nextUrl)) {
      throw githubError(
        "GITHUB_PAGINATION_LOOP",
        "GitHub check pagination returned a repeated page."
      );
    }

    visited.add(nextUrl);
    const response = await request(nextUrl);

    if (!Array.isArray(response.body?.check_runs)) {
      throw githubError(
        "GITHUB_RESPONSE_INVALID",
        "GitHub returned an invalid check-runs response."
      );
    }

    checks.push(...response.body.check_runs);
    nextUrl = findNextLink(response.headers.get("link"));
  }

  const namedChecks = checks.filter((check) => check?.name === checkName);

  if (namedChecks.length === 0) {
    throw githubError(
      "GITHUB_CHECK_NOT_FOUND",
      "The requested GitHub check was not found for the pull request head."
    );
  }

  if (namedChecks.some((check) => check.head_sha !== revision)) {
    throw githubError(
      "GITHUB_CHECK_REVISION_MISMATCH",
      "GitHub check evidence does not match the pull request head revision."
    );
  }

  if (namedChecks.length > 1) {
    throw githubError(
      "GITHUB_CHECK_AMBIGUOUS",
      "Multiple GitHub checks matched the requested name and revision."
    );
  }

  const [check] = namedChecks;

  if (check.status !== "completed") {
    throw githubError(
      "GITHUB_CHECK_INCOMPLETE",
      "The requested GitHub check has not completed."
    );
  }

  return {
    issue,
    pullRequest,
    check
  };
}

async function getJson({ url, headers, fetchImpl, timeoutMs }) {
  let response;

  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw githubError(
      "GITHUB_REQUEST_FAILED",
      "GitHub request failed before a valid response was received."
    );
  }

  if (!response || typeof response.status !== "number") {
    throw githubError(
      "GITHUB_RESPONSE_INVALID",
      "GitHub returned an invalid HTTP response."
    );
  }

  if (!response.ok) {
    throw githubHttpError(response.status);
  }

  let body;

  try {
    body = await response.json();
  } catch {
    throw githubError(
      "GITHUB_RESPONSE_INVALID",
      "GitHub returned a response that was not valid JSON."
    );
  }

  return response.headers
    ? { body, headers: response.headers }
    : {
        body,
        headers: { get: () => null }
      };
}

function githubHttpError(status) {
  if (status === 401) {
    return githubError(
      "GITHUB_AUTH_FAILED",
      "GitHub rejected the configured credentials."
    );
  }

  if (status === 403) {
    return githubError(
      "GITHUB_FORBIDDEN",
      "GitHub denied the read request or applied a rate limit."
    );
  }

  if (status === 404) {
    return githubError(
      "GITHUB_NOT_FOUND",
      "The requested GitHub resource was not found or is not accessible."
    );
  }

  if (status === 429) {
    return githubError(
      "GITHUB_RATE_LIMITED",
      "GitHub rate-limited the read request."
    );
  }

  return githubError(
    "GITHUB_HTTP_ERROR",
    `GitHub read request failed with HTTP status ${status}.`
  );
}

function createHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "TaskSeal"
  };

  if (typeof token === "string" && token.length > 0) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

function parseRepository(repository) {
  requireNonEmptyString(repository, "repository");
  const parts = repository.split("/");

  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        !/^[A-Za-z0-9_.-]+$/.test(part) ||
        part === "." ||
        part === ".."
    )
  ) {
    throw githubError(
      "GITHUB_REPOSITORY_INVALID",
      "GitHub repository must use the owner/name format."
    );
  }

  return {
    owner: parts[0],
    name: parts[1]
  };
}

function validatePaginationUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw githubError(
      "GITHUB_PAGINATION_URL_INVALID",
      "GitHub returned an invalid pagination URL."
    );
  }

  if (
    url.origin !== GITHUB_API_ORIGIN ||
    url.username ||
    url.password
  ) {
    throw githubError(
      "GITHUB_PAGINATION_ORIGIN_INVALID",
      "GitHub pagination attempted to leave the official API origin."
    );
  }
}

function findNextLink(linkHeader) {
  if (typeof linkHeader !== "string" || linkHeader.length === 0) {
    return null;
  }

  for (const part of linkHeader.split(",")) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"\s*$/.exec(part);

    if (match && match[2].split(/\s+/).includes("next")) {
      return match[1];
    }
  }

  return null;
}

function validateToken(token) {
  if (token === undefined || token === null || token === "") {
    return;
  }

  if (
    typeof token !== "string" ||
    token.trim().length === 0 ||
    /[\r\n]/.test(token)
  ) {
    throw githubError(
      "GITHUB_TOKEN_INVALID",
      "GitHub token must be a non-empty single-line string."
    );
  }
}

function validateTimeout(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw githubError(
      "GITHUB_TIMEOUT_INVALID",
      "GitHub timeout must be a positive integer."
    );
  }
}

function requirePositiveInteger(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw githubError(
      "GITHUB_INPUT_INVALID",
      `GitHub ${field} must be a positive integer.`
    );
  }
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw githubError(
      "GITHUB_INPUT_INVALID",
      `GitHub ${field} must be a non-empty string.`
    );
  }
}

function requireFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw githubError(
      "GITHUB_FETCH_INVALID",
      "GitHub read client requires a fetch implementation."
    );
  }
}

function githubError(code, message) {
  const error = new Error(message);
  error.name = "GitHubReadError";
  error.code = code;
  return error;
}
