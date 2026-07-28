const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const MAX_PAGES = 10;
const GITHUB_CHECK_STATUSES = new Set([
  "queued",
  "in_progress",
  "completed",
  "waiting",
  "requested",
  "pending"
] as const);
const GITHUB_CHECK_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "success",
  "skipped",
  "stale",
  "timed_out"
] as const);
const GITHUB_REVIEW_STATES = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
  "PENDING"
] as const);

export type GitHubCheckStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "waiting"
  | "requested"
  | "pending";

export type GitHubCheckConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "success"
  | "skipped"
  | "stale"
  | "timed_out";

export type GitHubReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED"
  | "PENDING";

export interface HeadersLike {
  get(name: string): string | null;
}

export interface FetchRequestOptions {
  method: "GET";
  headers: GitHubHeaders;
  redirect: "error";
  signal: AbortSignal;
}

export type FetchLike = (
  url: string,
  options: FetchRequestOptions
) => Promise<unknown>;

export interface GitHubIssue
  extends Record<string, unknown> {
  id: string | number;
  number: string | number;
  title: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}

export interface GitHubPullRequest
  extends Record<string, unknown> {
  id: string | number;
  number: string | number;
  html_url: string;
  updated_at: string;
  head: {
    sha: string;
    ref?: string;
    repo?: {
      full_name: string;
    } | null;
  };
}

export interface GitHubCheckResponse
  extends Record<string, unknown> {
  id: string | number;
  name: string;
  status: GitHubCheckStatus;
  conclusion: GitHubCheckConclusion | null;
  head_sha: string;
  details_url: string;
  completed_at: string | null;
  app?: {
    id: string | number;
  } | null;
}

export interface GitHubCheck
  extends GitHubCheckResponse {
  status: "completed";
  conclusion: GitHubCheckConclusion;
  completed_at: string;
}

export interface GitHubDelivery {
  issue: GitHubIssue;
  pullRequest: GitHubPullRequest;
  check: GitHubCheck;
}

export interface GitHubPullRequestReview
  extends Record<string, unknown> {
  id: string | number;
  html_url: string;
  state: GitHubReviewState;
  submitted_at: string | null;
  commit_id: string | null;
  user: {
    id: string | number;
    login: string;
  };
}

export interface GitHubHeadCheckSelector {
  name: string;
  appId?: string | undefined;
}

export interface GitHubHeadCheckMatch {
  selector: GitHubHeadCheckSelector;
  check: GitHubCheckResponse | null;
}

export interface ReadGitHubIssueOptions {
  repository: string;
  issueNumber: number;
  token?: string | null | undefined;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface ReadGitHubDeliveryOptions {
  repository: string;
  issueNumber: number;
  pullRequestNumber: number;
  checkName: string;
  token?: string | null | undefined;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface ReadGitHubPullRequestOptions {
  repository: string;
  pullRequestNumber: number;
  token?: string | null | undefined;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface ReadGitHubCheckRunOptions {
  repository: string;
  checkRunId: string;
  token?: string | null | undefined;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface ReadGitHubMappedPullRequestOptions
  extends ReadGitHubPullRequestOptions {
  headRepository: string;
  branch: string;
}

export interface ReadGitHubHeadChecksOptions {
  repository: string;
  headSha: string;
  selectors:
    readonly GitHubHeadCheckSelector[];
  token?: string | null | undefined;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface ReadGitHubPullRequestReviewsOptions {
  repository: string;
  pullRequestNumber: number;
  token?: string | null | undefined;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface ReadGitHubPullRequestReviewOptions
  extends ReadGitHubPullRequestReviewsOptions {
  reviewId: string;
}

interface JsonResponse {
  body: unknown;
  headers: HeadersLike;
}

export type GitHubHeaders = Record<string, string>;

export async function readGitHubIssue({
  repository,
  issueNumber,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000
}: ReadGitHubIssueOptions): Promise<GitHubIssue> {
  const { owner, name } =
    parseRepository(repository);
  requirePositiveInteger(
    issueNumber,
    "issueNumber"
  );
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

  if (
    isRecord(issue) &&
    issue.pull_request
  ) {
    throw githubError(
      "GITHUB_ISSUE_IS_PULL_REQUEST",
      "The configured GitHub issue number represents a pull request."
    );
  }

  if (!isGitHubIssue(issue)) {
    throw githubError(
      "GITHUB_RESPONSE_INVALID",
      "GitHub returned an invalid issue response."
    );
  }

  return issue;
}

export async function readGitHubPullRequest({
  repository,
  pullRequestNumber,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000
}: ReadGitHubPullRequestOptions):
  Promise<GitHubPullRequest> {
  const { owner, name } =
    parseRepository(repository);
  requirePositiveInteger(
    pullRequestNumber,
    "pullRequestNumber"
  );
  requireFetch(fetchImpl);
  validateToken(token);
  validateTimeout(timeoutMs);

  const response = await getJson({
    url:
      `${GITHUB_API_ORIGIN}/repos/` +
      `${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/` +
      pullRequestNumber,
    headers: createHeaders(token),
    fetchImpl,
    timeoutMs
  });

  if (!isGitHubPullRequest(response.body)) {
    throw githubError(
      "GITHUB_RESPONSE_INVALID",
      "GitHub returned an invalid pull request response."
    );
  }

  return response.body;
}

export async function readGitHubMappedPullRequest({
  repository,
  pullRequestNumber,
  headRepository,
  branch,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000
}: ReadGitHubMappedPullRequestOptions):
  Promise<GitHubPullRequest & {
    head: {
      sha: string;
      ref: string;
      repo: {
        full_name: string;
      };
    };
  }> {
  const expectedHead =
    parseRepository(headRepository);
  requireNonEmptyString(branch, "branch");
  const pullRequest =
    await readGitHubPullRequest({
      repository,
      pullRequestNumber,
      token,
      fetchImpl,
      timeoutMs
    });
  const ref = pullRequest.head.ref;
  const repositoryName =
    pullRequest.head.repo?.full_name;
  let actualHead:
    | ReturnType<typeof parseRepository>
    | null = null;

  try {
    actualHead =
      typeof repositoryName === "string"
        ? parseRepository(repositoryName)
        : null;
  } catch {
    actualHead = null;
  }

  if (
    ref !== branch ||
    actualHead === null ||
    actualHead.owner.toLowerCase() !==
      expectedHead.owner.toLowerCase() ||
    actualHead.name.toLowerCase() !==
      expectedHead.name.toLowerCase()
  ) {
    throw githubError(
      "GITHUB_PULL_REQUEST_MAPPING_MISMATCH",
      "The GitHub pull request head does not match the configured delivery binding."
    );
  }

  return pullRequest as GitHubPullRequest & {
    head: {
      sha: string;
      ref: string;
      repo: {
        full_name: string;
      };
    };
  };
}

export async function readGitHubCheckRun({
  repository,
  checkRunId,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000
}: ReadGitHubCheckRunOptions):
  Promise<GitHubCheckResponse> {
  const { owner, name } =
    parseRepository(repository);
  requirePositiveDecimalIdentifier(
    checkRunId,
    "checkRunId"
  );
  requireFetch(fetchImpl);
  validateToken(token);
  validateTimeout(timeoutMs);

  const response = await getJson({
    url:
      `${GITHUB_API_ORIGIN}/repos/` +
      `${encodeURIComponent(owner)}/${encodeURIComponent(name)}/check-runs/` +
      checkRunId,
    headers: createHeaders(token),
    fetchImpl,
    timeoutMs
  });

  if (!isGitHubCheck(response.body)) {
    throw githubError(
      "GITHUB_RESPONSE_INVALID",
      "GitHub returned an invalid check run response."
    );
  }

  return response.body;
}

export async function readGitHubHeadChecks({
  repository,
  headSha,
  selectors,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000
}: ReadGitHubHeadChecksOptions):
  Promise<GitHubHeadCheckMatch[]> {
  const { owner, name } =
    parseRepository(repository);
  requireNonEmptyString(headSha, "headSha");
  const normalizedSelectors =
    normalizeHeadCheckSelectors(selectors);
  requireFetch(fetchImpl);
  validateToken(token);
  validateTimeout(timeoutMs);

  const parameters = new URLSearchParams({
    filter: "latest",
    per_page: "100"
  });
  let nextUrl: string | null =
    `${GITHUB_API_ORIGIN}/repos/` +
    `${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/` +
    `${encodeURIComponent(headSha)}/check-runs?${parameters}`;
  const checks: GitHubCheckResponse[] = [];
  const visited = new Set<string>();
  const headers = createHeaders(token);

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
    const response = await getJson({
      url: nextUrl,
      headers,
      fetchImpl,
      timeoutMs
    });
    checks.push(
      ...readCheckRuns(response.body)
    );
    nextUrl = findNextLink(
      response.headers.get("link")
    );
  }

  return normalizedSelectors.map(
    (selector) => {
      const matching = checks.filter(
        (check) =>
          check.name === selector.name &&
          (
            selector.appId === undefined ||
            readCheckAppId(check) ===
              selector.appId
          )
      );

      if (matching.length > 1) {
        throw githubError(
          "GITHUB_CHECK_AMBIGUOUS",
          "Multiple GitHub checks matched a configured delivery selector."
        );
      }

      const check = matching[0] ?? null;
      if (
        check !== null &&
        check.head_sha !== headSha
      ) {
        throw githubError(
          "GITHUB_CHECK_REVISION_MISMATCH",
          "GitHub check evidence does not match the configured pull request head."
        );
      }

      return {
        selector: { ...selector },
        check
      };
    }
  );
}

export async function readGitHubPullRequestReviews({
  repository,
  pullRequestNumber,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000
}: ReadGitHubPullRequestReviewsOptions):
  Promise<GitHubPullRequestReview[]> {
  const { owner, name } =
    parseRepository(repository);
  requirePositiveInteger(
    pullRequestNumber,
    "pullRequestNumber"
  );
  requireFetch(fetchImpl);
  validateToken(token);
  validateTimeout(timeoutMs);

  let nextUrl: string | null =
    `${GITHUB_API_ORIGIN}/repos/` +
    `${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/` +
    `${pullRequestNumber}/reviews?per_page=100`;
  const reviews:
    GitHubPullRequestReview[] = [];
  const visited = new Set<string>();
  const headers = createHeaders(token);

  for (let page = 0; nextUrl; page += 1) {
    if (page >= MAX_PAGES) {
      throw githubError(
        "GITHUB_PAGINATION_LIMIT",
        "GitHub review pagination exceeded the safety limit."
      );
    }

    validatePaginationUrl(nextUrl);
    if (visited.has(nextUrl)) {
      throw githubError(
        "GITHUB_PAGINATION_LOOP",
        "GitHub review pagination returned a repeated page."
      );
    }

    visited.add(nextUrl);
    const response = await getJson({
      url: nextUrl,
      headers,
      fetchImpl,
      timeoutMs
    });
    reviews.push(
      ...readPullRequestReviews(
        response.body
      )
    );
    nextUrl = findNextLink(
      response.headers.get("link")
    );
  }

  return reviews;
}

export async function readGitHubPullRequestReview({
  repository,
  pullRequestNumber,
  reviewId,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000
}: ReadGitHubPullRequestReviewOptions):
  Promise<GitHubPullRequestReview> {
  const { owner, name } =
    parseRepository(repository);
  requirePositiveInteger(
    pullRequestNumber,
    "pullRequestNumber"
  );
  requirePositiveDecimalIdentifier(
    reviewId,
    "reviewId"
  );
  requireFetch(fetchImpl);
  validateToken(token);
  validateTimeout(timeoutMs);

  const response = await getJson({
    url:
      `${GITHUB_API_ORIGIN}/repos/` +
      `${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/` +
      `${pullRequestNumber}/reviews/${reviewId}`,
    headers: createHeaders(token),
    fetchImpl,
    timeoutMs
  });

  if (
    !isGitHubPullRequestReview(
      response.body
    )
  ) {
    throw githubError(
      "GITHUB_RESPONSE_INVALID",
      "GitHub returned an invalid pull request review response."
    );
  }

  return response.body;
}

export async function readGitHubDelivery({
  repository,
  issueNumber,
  pullRequestNumber,
  checkName,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000
}: ReadGitHubDeliveryOptions): Promise<GitHubDelivery> {
  const { owner, name } =
    parseRepository(repository);
  requirePositiveInteger(
    issueNumber,
    "issueNumber"
  );
  requirePositiveInteger(
    pullRequestNumber,
    "pullRequestNumber"
  );
  requireNonEmptyString(checkName, "checkName");
  requireFetch(fetchImpl);
  validateToken(token);
  validateTimeout(timeoutMs);

  const headers = createHeaders(token);
  const repositoryPath =
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const request = (url: string): Promise<JsonResponse> =>
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

  if (
    isRecord(issue) &&
    issue.pull_request
  ) {
    throw githubError(
      "GITHUB_ISSUE_IS_PULL_REQUEST",
      "The configured GitHub issue number represents a pull request."
    );
  }

  if (!isGitHubIssue(issue)) {
    throw githubError(
      "GITHUB_RESPONSE_INVALID",
      "GitHub returned an invalid issue response."
    );
  }

  const pullRequestResponse = await request(
    `${GITHUB_API_ORIGIN}${repositoryPath}/pulls/${pullRequestNumber}`
  );
  const pullRequest = pullRequestResponse.body;

  if (!isGitHubPullRequest(pullRequest)) {
    throw githubError(
      "GITHUB_RESPONSE_INVALID",
      "GitHub returned a pull request without a head revision."
    );
  }

  const revision = pullRequest.head.sha;
  const parameters = new URLSearchParams({
    check_name: checkName,
    filter: "latest",
    per_page: "100"
  });
  let nextUrl: string | null =
    `${GITHUB_API_ORIGIN}${repositoryPath}/commits/` +
    `${encodeURIComponent(revision)}/check-runs?${parameters}`;
  const checks: GitHubCheckResponse[] = [];
  const visited = new Set<string>();

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
    const checkRuns = readCheckRuns(response.body);

    checks.push(...checkRuns);
    nextUrl = findNextLink(
      response.headers.get("link")
    );
  }

  const namedChecks = checks.filter(
    (check) => check.name === checkName
  );

  if (namedChecks.length === 0) {
    throw githubError(
      "GITHUB_CHECK_NOT_FOUND",
      "The requested GitHub check was not found for the pull request head."
    );
  }

  if (
    namedChecks.some(
      (check) => check.head_sha !== revision
    )
  ) {
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

  const check = namedChecks[0];

  if (!check) {
    throw githubError(
      "GITHUB_CHECK_NOT_FOUND",
      "The requested GitHub check was not found for the pull request head."
    );
  }

  if (check.status !== "completed") {
    throw githubError(
      "GITHUB_CHECK_INCOMPLETE",
      "The requested GitHub check has not completed."
    );
  }

  if (!isCompletedGitHubCheck(check)) {
    throw githubError(
      "GITHUB_RESPONSE_INVALID",
      "GitHub returned an invalid completed check response."
    );
  }

  return {
    issue,
    pullRequest,
    check
  };
}

async function getJson({
  url,
  headers,
  fetchImpl,
  timeoutMs
}: {
  url: string;
  headers: GitHubHeaders;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<JsonResponse> {
  let rawResponse: unknown;

  try {
    rawResponse = await fetchImpl(url, {
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

  if (
    !isRecord(rawResponse) ||
    typeof rawResponse.status !== "number"
  ) {
    throw githubError(
      "GITHUB_RESPONSE_INVALID",
      "GitHub returned an invalid HTTP response."
    );
  }

  const status = rawResponse.status;
  const ok = rawResponse.ok === true;

  if (!ok) {
    throw githubHttpError(status);
  }

  const json = rawResponse.json;
  let body: unknown;

  try {
    if (typeof json !== "function") {
      throw new TypeError("Missing response json method.");
    }

    body = await Reflect.apply(
      json,
      rawResponse,
      []
    );
  } catch {
    throw githubError(
      "GITHUB_RESPONSE_INVALID",
      "GitHub returned a response that was not valid JSON."
    );
  }

  return {
    body,
    headers: readHeaders(rawResponse.headers)
  };
}

function readCheckRuns(
  body: unknown
): GitHubCheckResponse[] {
  if (
    !isRecord(body) ||
    !Array.isArray(body.check_runs) ||
    !body.check_runs.every(isGitHubCheck)
  ) {
    throw githubError(
      "GITHUB_RESPONSE_INVALID",
      "GitHub returned an invalid check-runs response."
    );
  }

  return body.check_runs;
}

function readPullRequestReviews(
  body: unknown
): GitHubPullRequestReview[] {
  if (
    !Array.isArray(body) ||
    !body.every(
      isGitHubPullRequestReview
    )
  ) {
    throw githubError(
      "GITHUB_RESPONSE_INVALID",
      "GitHub returned an invalid pull request reviews response."
    );
  }

  return body;
}

function isGitHubIssue(
  value: unknown
): value is GitHubIssue {
  return (
    isRecord(value) &&
    isIdentifier(value.id) &&
    isIdentifier(value.number) &&
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.html_url) &&
    isNonEmptyString(value.created_at) &&
    isNonEmptyString(value.updated_at)
  );
}

function isGitHubPullRequest(
  value: unknown
): value is GitHubPullRequest {
  return (
    isRecord(value) &&
    isIdentifier(value.id) &&
    isIdentifier(value.number) &&
    isNonEmptyString(value.html_url) &&
    isNonEmptyString(value.updated_at) &&
    isRecord(value.head) &&
    isNonEmptyString(value.head.sha)
  );
}

function isGitHubCheck(
  value: unknown
): value is GitHubCheckResponse {
  return (
    isRecord(value) &&
    isIdentifier(value.id) &&
    isNonEmptyString(value.name) &&
    isGitHubCheckStatus(value.status) &&
    isNonEmptyString(value.head_sha) &&
    isNonEmptyString(value.details_url) &&
    (
      value.status === "completed"
        ? isGitHubCheckConclusion(
            value.conclusion
          ) &&
          isNonEmptyString(
            value.completed_at
          )
        : value.conclusion === null &&
          value.completed_at === null
    ) &&
    (
      value.app === undefined ||
      value.app === null ||
      (
        isRecord(value.app) &&
        isIdentifier(value.app.id)
      )
    )
  );
}

function isGitHubPullRequestReview(
  value: unknown
): value is GitHubPullRequestReview {
  return (
    isRecord(value) &&
    isIdentifier(value.id) &&
    isNonEmptyString(value.html_url) &&
    isGitHubReviewState(value.state) &&
    isRecord(value.user) &&
    isIdentifier(value.user.id) &&
    isNonEmptyString(value.user.login) &&
    (
      value.state === "PENDING"
        ? (
            value.submitted_at === null &&
            (
              value.commit_id === null ||
              isNonEmptyString(
                value.commit_id
              )
            )
          )
        : (
            isNonEmptyString(
              value.submitted_at
            ) &&
            isNonEmptyString(
              value.commit_id
            )
          )
    )
  );
}

function isCompletedGitHubCheck(
  value: GitHubCheckResponse
): value is GitHubCheck {
  return (
    value.status === "completed" &&
    isNonEmptyString(value.conclusion) &&
    isNonEmptyString(value.completed_at)
  );
}

function isGitHubCheckStatus(
  value: unknown
): value is GitHubCheckStatus {
  return (
    typeof value === "string" &&
    GITHUB_CHECK_STATUSES.has(
      value as GitHubCheckStatus
    )
  );
}

function isGitHubCheckConclusion(
  value: unknown
): value is GitHubCheckConclusion {
  return (
    typeof value === "string" &&
    GITHUB_CHECK_CONCLUSIONS.has(
      value as GitHubCheckConclusion
    )
  );
}

function isGitHubReviewState(
  value: unknown
): value is GitHubReviewState {
  return (
    typeof value === "string" &&
    GITHUB_REVIEW_STATES.has(
      value as GitHubReviewState
    )
  );
}

function normalizeHeadCheckSelectors(
  value: unknown
): GitHubHeadCheckSelector[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 7
  ) {
    throw githubError(
      "GITHUB_INPUT_INVALID",
      "GitHub head check selectors must contain between one and seven entries."
    );
  }

  const selectors =
    value.map((candidate) => {
      if (
        !isRecord(candidate) ||
        typeof candidate.name !== "string" ||
        candidate.name.trim().length === 0 ||
        candidate.name !==
          candidate.name.trim() ||
        candidate.name.length > 256 ||
        (
          candidate.appId !== undefined &&
          (
            typeof candidate.appId !==
              "string" ||
            !/^[1-9]\d*$/.test(
              candidate.appId
            ) ||
            candidate.appId.length > 32
          )
        )
      ) {
        throw githubError(
          "GITHUB_INPUT_INVALID",
          "GitHub head check selector is invalid."
        );
      }

      return {
        name: candidate.name,
        ...(candidate.appId === undefined
          ? {}
          : {
              appId: candidate.appId
            })
      };
    });
  const identities = selectors.map(
    (selector) =>
      `${selector.name}\u0000${selector.appId ?? ""}`
  );

  if (
    new Set(identities).size !==
      identities.length
  ) {
    throw githubError(
      "GITHUB_INPUT_INVALID",
      "GitHub head check selectors must be unique."
    );
  }

  return selectors;
}

function readCheckAppId(
  check: GitHubCheckResponse
): string | null {
  return check.app &&
    isIdentifier(check.app.id)
    ? String(check.app.id)
    : null;
}

function githubHttpError(
  status: number
): GitHubReadError {
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

function createHeaders(token: unknown): GitHubHeaders {
  const headers: GitHubHeaders = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "TaskSeal"
  };

  if (
    typeof token === "string" &&
    token.length > 0
  ) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

function parseRepository(
  repository: unknown
): {
  owner: string;
  name: string;
} {
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

  const owner = parts[0];
  const name = parts[1];

  if (!owner || !name) {
    throw githubError(
      "GITHUB_REPOSITORY_INVALID",
      "GitHub repository must use the owner/name format."
    );
  }

  return {
    owner,
    name
  };
}

function validatePaginationUrl(value: string): void {
  let url: URL;

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

function findNextLink(
  linkHeader: string | null
): string | null {
  if (
    typeof linkHeader !== "string" ||
    linkHeader.length === 0
  ) {
    return null;
  }

  for (const part of linkHeader.split(",")) {
    const match =
      /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"\s*$/.exec(
        part
      );
    const relation = match?.[2];
    const url = match?.[1];

    if (
      url &&
      relation?.split(/\s+/).includes("next")
    ) {
      return url;
    }
  }

  return null;
}

function validateToken(token: unknown): void {
  if (
    token === undefined ||
    token === null ||
    token === ""
  ) {
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

function validateTimeout(
  timeoutMs: unknown
): asserts timeoutMs is number {
  if (
    !Number.isInteger(timeoutMs) ||
    typeof timeoutMs !== "number" ||
    timeoutMs <= 0
  ) {
    throw githubError(
      "GITHUB_TIMEOUT_INVALID",
      "GitHub timeout must be a positive integer."
    );
  }
}

function requirePositiveInteger(
  value: unknown,
  field: string
): asserts value is number {
  if (
    !Number.isInteger(value) ||
    typeof value !== "number" ||
    value <= 0
  ) {
    throw githubError(
      "GITHUB_INPUT_INVALID",
      `GitHub ${field} must be a positive integer.`
    );
  }
}

function requirePositiveDecimalIdentifier(
  value: unknown,
  field: string
): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d*$/.test(value)
  ) {
    throw githubError(
      "GITHUB_INPUT_INVALID",
      `GitHub ${field} must be a positive decimal identifier.`
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
    throw githubError(
      "GITHUB_INPUT_INVALID",
      `GitHub ${field} must be a non-empty string.`
    );
  }
}

function requireFetch(
  fetchImpl: unknown
): asserts fetchImpl is FetchLike {
  if (typeof fetchImpl !== "function") {
    throw githubError(
      "GITHUB_FETCH_INVALID",
      "GitHub read client requires a fetch implementation."
    );
  }
}

function readHeaders(value: unknown): HeadersLike {
  if (
    isRecord(value) &&
    typeof value.get === "function"
  ) {
    const get = value.get;

    return {
      get(name: string): string | null {
        const result: unknown = Reflect.apply(
          get,
          value,
          [name]
        );
        return typeof result === "string"
          ? result
          : null;
      }
    };
  }

  return {
    get(): null {
      return null;
    }
  };
}

function isIdentifier(
  value: unknown
): value is string | number {
  return (
    (typeof value === "string" ||
      typeof value === "number") &&
    String(value).length > 0
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

export class GitHubReadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GitHubReadError";
    this.code = code;
  }
}

function githubError(
  code: string,
  message: string
): GitHubReadError {
  return new GitHubReadError(code, message);
}
