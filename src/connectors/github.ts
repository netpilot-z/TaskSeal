import {
  digestProviderFactContent
} from "../lib/provider-snapshot.ts";
import type {
  ProviderCheckFact,
  ProviderIssueFact,
  ProviderPullRequestFact
} from "../lib/provider-snapshot.ts";
import type {
  ArtifactLinkedEvent,
  EvidenceRecordedEvent,
  WorkItemCreatedEvent
} from "../domain/workflow.ts";

interface GitHubIssueDto {
  id: string | number;
  number: string | number;
  title: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  pullRequest: unknown;
}

interface GitHubPullRequestDto {
  id: string | number;
  htmlUrl: string;
  updatedAt: string;
  headSha: string;
}

interface GitHubCheckDto {
  id: string | number;
  headSha: string;
  detailsUrl: string;
  completedAt: string;
  status: string;
  conclusion: string;
}

interface GitHubIssueMapping {
  workItemId: string;
  requiredEvidence: string[];
}

interface GitHubPullRequestMapping {
  workItemId: string;
  attemptId: string;
}

interface GitHubCheckMapping {
  workItemId: string;
  attemptId: string;
  artifactId: string;
  criterionKey: string;
}

export function normalizeGitHubIssue(
  issue: unknown,
  mapping?: unknown
): WorkItemCreatedEvent {
  const normalizedIssue = normalizeIssueDto(issue);
  const normalizedMapping =
    normalizeIssueMapping(mapping);

  if (normalizedIssue.pullRequest) {
    throw new TypeError(
      "GitHub issue must not represent a pull request."
    );
  }

  return createIssueEvent(
    normalizedIssue,
    normalizedMapping
  );
}

export function normalizeGitHubIssueFact(
  issue: unknown,
  mapping?: unknown
): ProviderIssueFact {
  const normalizedIssue = normalizeIssueDto(issue);
  const normalizedMapping =
    normalizeIssueMapping(mapping);

  if (normalizedIssue.pullRequest) {
    throw new TypeError(
      "GitHub issue must not represent a pull request."
    );
  }

  const candidateEvent = createIssueEvent(
    normalizedIssue,
    normalizedMapping
  );
  const fact: ProviderIssueFact = {
    sourceObject: {
      providerObjectKey:
        `github:issue:${normalizedIssue.id}`,
      provider: "github",
      objectType: "issue",
      externalId: String(normalizedIssue.id),
      url: normalizedIssue.htmlUrl
    },
    revision: {
      id: normalizedIssue.updatedAt,
      occurredAt: normalizedIssue.updatedAt,
      contentDigest: ""
    },
    observed: {
      title: normalizedIssue.title,
      createdAt: normalizedIssue.createdAt
    },
    candidateEvent
  };

  fact.revision.contentDigest =
    digestProviderFactContent(fact);
  return fact;
}

export function normalizeGitHubPullRequest(
  pullRequest: unknown,
  mapping?: unknown
): ArtifactLinkedEvent {
  return createPullRequestEvent(
    normalizePullRequestDto(pullRequest),
    normalizePullRequestMapping(mapping)
  );
}

export function normalizeGitHubPullRequestFact(
  pullRequest: unknown,
  mapping?: unknown
): ProviderPullRequestFact {
  const normalizedPullRequest =
    normalizePullRequestDto(pullRequest);
  const normalizedMapping =
    normalizePullRequestMapping(mapping);
  const candidateEvent = createPullRequestEvent(
    normalizedPullRequest,
    normalizedMapping
  );
  const fact: ProviderPullRequestFact = {
    sourceObject: {
      providerObjectKey:
        `github:pull_request:${normalizedPullRequest.id}`,
      provider: "github",
      objectType: "pull_request",
      externalId: String(normalizedPullRequest.id),
      url: normalizedPullRequest.htmlUrl
    },
    revision: {
      id: normalizedPullRequest.updatedAt,
      occurredAt: normalizedPullRequest.updatedAt,
      contentDigest: ""
    },
    observed: {
      headRevision: normalizedPullRequest.headSha
    },
    candidateEvent
  };

  fact.revision.contentDigest =
    digestProviderFactContent(fact);
  return fact;
}

export function normalizeGitHubCheck(
  check: unknown,
  mapping?: unknown
): EvidenceRecordedEvent {
  const normalizedCheck = normalizeCheckDto(check);
  const normalizedMapping =
    normalizeCheckMapping(mapping);

  if (normalizedCheck.status !== "completed") {
    throw new TypeError(
      "This experiment only accepts completed GitHub checks."
    );
  }

  return createCheckEvent(
    normalizedCheck,
    normalizedMapping
  );
}

export function normalizeGitHubCheckFact(
  check: unknown,
  mapping?: unknown
): ProviderCheckFact {
  const normalizedCheck = normalizeCheckDto(check);
  const normalizedMapping =
    normalizeCheckMapping(mapping);

  if (normalizedCheck.status !== "completed") {
    throw new TypeError(
      "This experiment only accepts completed GitHub checks."
    );
  }

  const candidateEvent = createCheckEvent(
    normalizedCheck,
    normalizedMapping
  );
  const fact: ProviderCheckFact = {
    sourceObject: {
      providerObjectKey:
        `github:check:${normalizedCheck.id}`,
      provider: "github",
      objectType: "check",
      externalId: String(normalizedCheck.id),
      url: normalizedCheck.detailsUrl
    },
    revision: {
      id: normalizedCheck.completedAt,
      occurredAt: normalizedCheck.completedAt,
      contentDigest: ""
    },
    observed: {
      headRevision: normalizedCheck.headSha,
      outcome:
        normalizedCheck.conclusion === "success"
          ? "passed"
          : "failed"
    },
    candidateEvent
  };

  fact.revision.contentDigest =
    digestProviderFactContent(fact);
  return fact;
}

function createIssueEvent(
  issue: GitHubIssueDto,
  mapping: GitHubIssueMapping
): WorkItemCreatedEvent {
  return {
    eventId: `github:issue-${issue.id}:created`,
    workItemId: mapping.workItemId,
    type: "work_item.created",
    occurredAt: issue.createdAt,
    payload: {
      title: issue.title,
      requiredEvidence: [...mapping.requiredEvidence],
      externalLink: {
        provider: "github",
        externalId: String(issue.id),
        url: issue.htmlUrl
      }
    }
  };
}

function createPullRequestEvent(
  pullRequest: GitHubPullRequestDto,
  mapping: GitHubPullRequestMapping
): ArtifactLinkedEvent {
  const artifactId = `pr-${pullRequest.id}`;

  return {
    eventId:
      `github:${artifactId}:${pullRequest.headSha}:${pullRequest.updatedAt}`,
    workItemId: mapping.workItemId,
    type: "artifact.linked",
    occurredAt: pullRequest.updatedAt,
    payload: {
      artifactId,
      attemptId: mapping.attemptId,
      kind: "pull_request",
      revision: pullRequest.headSha,
      url: pullRequest.htmlUrl
    }
  };
}

function createCheckEvent(
  check: GitHubCheckDto,
  mapping: GitHubCheckMapping
): EvidenceRecordedEvent {
  const evidenceId = `check-${check.id}`;

  return {
    eventId: `github:${evidenceId}:${check.headSha}`,
    workItemId: mapping.workItemId,
    type: "evidence.recorded",
    occurredAt: check.completedAt,
    payload: {
      evidenceId,
      attemptId: mapping.attemptId,
      artifactId: mapping.artifactId,
      revision: check.headSha,
      criterionKey: mapping.criterionKey,
      outcome:
        check.conclusion === "success"
          ? "passed"
          : "failed",
      url: check.detailsUrl
    }
  };
}

function normalizeIssueDto(
  issue: unknown
): GitHubIssueDto {
  const id = readProperty(issue, "id");
  const number = readProperty(issue, "number");
  const title = readProperty(issue, "title");
  const htmlUrl = readProperty(issue, "html_url");
  const createdAt = readProperty(issue, "created_at");
  const updatedAt = readProperty(issue, "updated_at");

  requireIdentifier(id, "issue id");
  requireIdentifier(number, "issue number");
  requireString(title, "issue title");
  requireHttpUrl(htmlUrl, "issue html_url");
  requireString(createdAt, "issue created_at");
  requireString(updatedAt, "issue updated_at");

  return {
    id,
    number,
    title,
    htmlUrl,
    createdAt,
    updatedAt,
    pullRequest: readProperty(issue, "pull_request")
  };
}

function normalizePullRequestDto(
  pullRequest: unknown
): GitHubPullRequestDto {
  const id = readProperty(pullRequest, "id");
  const htmlUrl = readProperty(
    pullRequest,
    "html_url"
  );
  const updatedAt = readProperty(
    pullRequest,
    "updated_at"
  );
  const headSha = readProperty(
    readProperty(pullRequest, "head"),
    "sha"
  );

  requireIdentifier(id, "pull request id");
  requireHttpUrl(htmlUrl, "pull request html_url");
  requireString(
    updatedAt,
    "pull request updated_at"
  );
  requireString(headSha, "pull request head.sha");

  return {
    id,
    htmlUrl,
    updatedAt,
    headSha
  };
}

function normalizeCheckDto(
  check: unknown
): GitHubCheckDto {
  const id = readProperty(check, "id");
  const headSha = readProperty(check, "head_sha");
  const detailsUrl = readProperty(
    check,
    "details_url"
  );
  const completedAt = readProperty(
    check,
    "completed_at"
  );
  const status = readProperty(check, "status");
  const conclusion = readProperty(
    check,
    "conclusion"
  );

  requireIdentifier(id, "check id");
  requireString(headSha, "check head_sha");
  requireHttpUrl(detailsUrl, "check details_url");
  requireString(completedAt, "check completed_at");
  requireString(status, "check status");
  requireString(conclusion, "check conclusion");

  return {
    id,
    headSha,
    detailsUrl,
    completedAt,
    status,
    conclusion
  };
}

function normalizeIssueMapping(
  mapping: unknown
): GitHubIssueMapping {
  const workItemId = readOptionalProperty(
    mapping,
    "workItemId"
  );
  const requiredEvidence = readOptionalProperty(
    mapping,
    "requiredEvidence"
  );

  requireMappingString(workItemId, "workItemId");
  requireEvidenceKeys(requiredEvidence);

  return {
    workItemId,
    requiredEvidence
  };
}

function normalizePullRequestMapping(
  mapping: unknown
): GitHubPullRequestMapping {
  const workItemId = readOptionalProperty(
    mapping,
    "workItemId"
  );
  const attemptId = readOptionalProperty(
    mapping,
    "attemptId"
  );

  requireMappingString(workItemId, "workItemId");
  requireMappingString(attemptId, "attemptId");

  return {
    workItemId,
    attemptId
  };
}

function normalizeCheckMapping(
  mapping: unknown
): GitHubCheckMapping {
  const workItemId = readOptionalProperty(
    mapping,
    "workItemId"
  );
  const attemptId = readOptionalProperty(
    mapping,
    "attemptId"
  );
  const artifactId = readOptionalProperty(
    mapping,
    "artifactId"
  );
  const criterionKey = readOptionalProperty(
    mapping,
    "criterionKey"
  );

  requireMappingString(workItemId, "workItemId");
  requireMappingString(attemptId, "attemptId");
  requireMappingString(artifactId, "artifactId");
  requireMappingString(criterionKey, "criterionKey");

  return {
    workItemId,
    attemptId,
    artifactId,
    criterionKey
  };
}

function requireIdentifier(
  value: unknown,
  field: string
): asserts value is string | number {
  if (
    (typeof value !== "string" &&
      typeof value !== "number") ||
    String(value).length === 0
  ) {
    throw new TypeError(
      `GitHub ${field} must be present.`
    );
  }
}

function requireString(
  value: unknown,
  field: string
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0
  ) {
    throw new TypeError(
      `GitHub ${field} must be a non-empty string.`
    );
  }
}

function requireMappingString(
  value: unknown,
  field: string
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0
  ) {
    throw new TypeError(
      `GitHub mapping ${field} must be a non-empty string.`
    );
  }
}

function requireEvidenceKeys(
  value: unknown
): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        item.trim().length === 0
    )
  ) {
    throw new TypeError(
      "GitHub mapping requiredEvidence must be a non-empty string array."
    );
  }
}

function requireHttpUrl(
  value: unknown,
  field: string
): asserts value is string {
  requireString(value, field);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(
      `GitHub ${field} must be an http or https URL.`
    );
  }

  if (
    url.protocol !== "https:" &&
    url.protocol !== "http:"
  ) {
    throw new TypeError(
      `GitHub ${field} must be an http or https URL.`
    );
  }
}

function readProperty(
  value: unknown,
  key: string
): unknown {
  if (value === null || value === undefined) {
    throw new TypeError(
      `Cannot read properties of ${String(value)} (reading '${key}')`
    );
  }

  return Reflect.get(Object(value), key);
}

function readOptionalProperty(
  value: unknown,
  key: string
): unknown {
  return value === null || value === undefined
    ? undefined
    : Reflect.get(Object(value), key);
}
