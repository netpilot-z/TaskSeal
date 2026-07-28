import {
  deriveGitHubCheckSourceRevision,
  deriveGitHubDeliveryEventId,
  deriveGitHubReviewSourceRevision,
  digestProviderFactContent
} from "../lib/provider-snapshot.ts";
import type {
  ProviderCheckFact,
  ProviderIssueFact,
  ProviderPullRequestFact,
  ProviderPullRequestReviewFact,
  ProviderPullRequestReviewState
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
  name: string | null;
  appId: string | null;
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
  deliveryBindingDigest?:
    | string
    | undefined;
}

interface GitHubCheckMapping {
  workItemId: string;
  attemptId: string;
  artifactId: string;
  criterionKey: string;
  deliveryBindingDigest?:
    | string
    | undefined;
  pullRequestNumber?:
    | number
    | undefined;
  checkName?: string | undefined;
  checkAppId?: string | undefined;
  pullRequestRevisionId?:
    | string
    | undefined;
}

interface GitHubPullRequestReviewMapping
  extends GitHubCheckMapping {
  reviewerId: string;
}

interface GitHubPullRequestReviewDto {
  id: string | number;
  htmlUrl: string;
  state: ProviderPullRequestReviewState;
  reviewerId: string;
  submittedAt: string;
  headSha: string;
  pullRequestUpdatedAt: string;
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
  const sourceRevisionId =
    getCheckSourceRevision({
      check: normalizedCheck,
      mapping: normalizedMapping
    });
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
      id: sourceRevisionId,
      occurredAt: normalizedCheck.completedAt,
      contentDigest: ""
    },
    observed: {
      headRevision: normalizedCheck.headSha,
      outcome:
        normalizedCheck.conclusion === "success"
          ? "passed"
          : "failed",
      ...(normalizedMapping
        .deliveryBindingDigest ===
      undefined
        ? {}
        : {
            name:
              normalizedCheck.name!,
            appId:
              normalizedCheck.appId!,
            pullRequestRevisionId:
              normalizedMapping
                .pullRequestRevisionId!
          })
    },
    candidateEvent
  };

  fact.revision.contentDigest =
    digestProviderFactContent(fact);
  return fact;
}

export function normalizeGitHubPullRequestReviewFact(
  review: unknown,
  pullRequest: unknown,
  mapping?: unknown
): ProviderPullRequestReviewFact {
  const normalizedMapping =
    normalizePullRequestReviewMapping(
      mapping
    );
  const normalizedReview =
    normalizePullRequestReviewDto({
      review,
      pullRequest,
      reviewerId:
        normalizedMapping.reviewerId
    });
  const candidateEvent =
    createPullRequestReviewEvent(
      normalizedReview,
      normalizedMapping
    );
  const sourceObject:
    ProviderPullRequestReviewFact["sourceObject"] = {
      providerObjectKey:
        `github:pull_request_review:${normalizedReview.id}`,
      provider: "github",
      objectType:
        "pull_request_review",
      externalId:
        String(normalizedReview.id),
      url: normalizedReview.htmlUrl
    };
  const observed:
    ProviderPullRequestReviewFact["observed"] = {
      headRevision:
        normalizedReview.headSha,
      reviewerId:
        normalizedReview.reviewerId,
      state: normalizedReview.state,
      outcome:
        normalizedReview.state ===
        "approved"
          ? "passed"
          : "failed"
    };
  const fact:
    ProviderPullRequestReviewFact = {
      sourceObject,
      revision: {
        id:
          deriveGitHubReviewSourceRevision({
            pullRequestUpdatedAt:
              normalizedReview.pullRequestUpdatedAt,
            state:
              normalizedReview.state
          }),
        occurredAt:
          normalizedReview.pullRequestUpdatedAt,
        contentDigest: ""
      },
      observed,
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
  const sourceObjectKey =
    `github:pull_request:${pullRequest.id}`;

  return {
    eventId:
      mapping.deliveryBindingDigest ===
      undefined
        ? `github:${artifactId}:${pullRequest.headSha}:${pullRequest.updatedAt}`
        : deriveGitHubDeliveryEventId({
            deliveryBindingDigest:
              mapping.deliveryBindingDigest,
            workItemId:
              mapping.workItemId,
            attemptId:
              mapping.attemptId,
            artifactId,
            artifactRevision:
              pullRequest.headSha,
            sourceObjectKey,
            sourceRevisionId:
              pullRequest.headSha
          }),
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
  const evidenceId =
    mapping.deliveryBindingDigest ===
    undefined
      ? `check-${check.id}`
      : `check-${check.id}:pr-${mapping.pullRequestNumber}`;
  const sourceObjectKey =
    `github:check:${check.id}`;
  const sourceRevisionId =
    getCheckSourceRevision({
      check,
      mapping
    });

  return {
    eventId:
      mapping.deliveryBindingDigest ===
      undefined
        ? `github:${evidenceId}:${check.headSha}`
        : deriveGitHubDeliveryEventId({
            deliveryBindingDigest:
              mapping.deliveryBindingDigest,
            workItemId:
              mapping.workItemId,
            attemptId:
              mapping.attemptId,
            artifactId:
              mapping.artifactId,
            artifactRevision:
              check.headSha,
            sourceObjectKey,
            sourceRevisionId,
            criterionKey:
              mapping.criterionKey
          }),
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

function createPullRequestReviewEvent(
  review: GitHubPullRequestReviewDto,
  mapping:
    GitHubPullRequestReviewMapping
): EvidenceRecordedEvent {
  const evidenceId =
    `review-${review.id}:reviewer-${review.reviewerId}:${review.state}`;
  const sourceObjectKey =
    `github:pull_request_review:${review.id}`;
  const sourceRevisionId =
    deriveGitHubReviewSourceRevision({
      pullRequestUpdatedAt:
        review.pullRequestUpdatedAt,
      state: review.state
    });

  if (
    mapping.deliveryBindingDigest ===
    undefined
  ) {
    throw new TypeError(
      "GitHub review evidence requires a delivery binding digest."
    );
  }

  return {
    eventId:
      deriveGitHubDeliveryEventId({
        deliveryBindingDigest:
          mapping.deliveryBindingDigest,
        workItemId: mapping.workItemId,
        attemptId: mapping.attemptId,
        artifactId: mapping.artifactId,
        artifactRevision:
          review.headSha,
        sourceObjectKey,
        sourceRevisionId,
        criterionKey:
          mapping.criterionKey
      }),
    workItemId: mapping.workItemId,
    type: "evidence.recorded",
    occurredAt:
      review.pullRequestUpdatedAt,
    payload: {
      evidenceId,
      attemptId: mapping.attemptId,
      artifactId: mapping.artifactId,
      revision: review.headSha,
      criterionKey:
        mapping.criterionKey,
      outcome:
        review.state === "approved"
          ? "passed"
          : "failed",
      url: review.htmlUrl
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
  const name = readProperty(check, "name");
  const app = readProperty(check, "app");
  const appId =
    app === null || app === undefined
      ? null
      : readProperty(app, "id");
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
    name:
      typeof name === "string"
        ? name
        : null,
    appId:
      (
        typeof appId === "string" ||
        typeof appId === "number"
      )
        ? String(appId)
        : null,
    headSha,
    detailsUrl,
    completedAt,
    status,
    conclusion
  };
}

function normalizePullRequestReviewDto({
  review,
  pullRequest,
  reviewerId
}: {
  review: unknown;
  pullRequest: unknown;
  reviewerId: string;
}): GitHubPullRequestReviewDto {
  const id = readProperty(review, "id");
  const htmlUrl = readProperty(
    review,
    "html_url"
  );
  const rawState = readProperty(
    review,
    "state"
  );
  const submittedAt = readProperty(
    review,
    "submitted_at"
  );
  const commitId = readProperty(
    review,
    "commit_id"
  );
  const actualReviewerId = readProperty(
    readProperty(review, "user"),
    "id"
  );
  const normalizedPullRequest =
    normalizePullRequestDto(pullRequest);
  const state =
    normalizeReviewState(rawState);

  requireIdentifier(id, "review id");
  requireHttpUrl(
    htmlUrl,
    "review html_url"
  );
  requireString(
    submittedAt,
    "review submitted_at"
  );
  requireString(commitId, "review commit_id");
  requireIdentifier(
    actualReviewerId,
    "review user.id"
  );

  if (
    String(actualReviewerId) !==
      reviewerId ||
    commitId !==
      normalizedPullRequest.headSha
  ) {
    throw new TypeError(
      "GitHub review does not match the configured reviewer and pull request head."
    );
  }

  return {
    id,
    htmlUrl,
    state,
    reviewerId,
    submittedAt,
    headSha:
      normalizedPullRequest.headSha,
    pullRequestUpdatedAt:
      normalizedPullRequest.updatedAt
  };
}

function getCheckSourceRevision({
  check,
  mapping
}: {
  check: GitHubCheckDto;
  mapping: GitHubCheckMapping;
}): string {
  if (
    mapping.deliveryBindingDigest ===
    undefined
  ) {
    return check.completedAt;
  }

  if (
    check.name === null ||
    check.name.trim().length === 0 ||
    check.name !== check.name.trim() ||
    check.name.length > 256 ||
    check.appId === null ||
    !/^[1-9]\d*$/.test(check.appId) ||
    check.appId.length > 32 ||
    mapping.checkName === undefined ||
    mapping.pullRequestRevisionId ===
      undefined ||
    check.name !== mapping.checkName ||
    (
      mapping.checkAppId !== undefined &&
      check.appId !== mapping.checkAppId
    )
  ) {
    throw new TypeError(
      "GitHub delivery check requires exact selector and pull request revision identity."
    );
  }

  return deriveGitHubCheckSourceRevision({
    completedAt: check.completedAt,
    name: check.name,
    appId: check.appId,
    pullRequestRevisionId:
      mapping.pullRequestRevisionId
  });
}

function normalizeReviewState(
  value: unknown
): ProviderPullRequestReviewState {
  if (value === "APPROVED") {
    return "approved";
  }

  if (value === "CHANGES_REQUESTED") {
    return "changes_requested";
  }

  if (value === "DISMISSED") {
    return "dismissed";
  }

  throw new TypeError(
    "GitHub review state is not delivery evidence."
  );
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
  const deliveryBindingDigest =
    readOptionalProperty(
      mapping,
      "deliveryBindingDigest"
    );

  requireMappingString(workItemId, "workItemId");
  requireMappingString(attemptId, "attemptId");
  requireOptionalDigest(
    deliveryBindingDigest,
    "deliveryBindingDigest"
  );
  return {
    workItemId,
    attemptId,
    ...(deliveryBindingDigest ===
    undefined
      ? {}
      : { deliveryBindingDigest })
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
  const deliveryBindingDigest =
    readOptionalProperty(
      mapping,
      "deliveryBindingDigest"
    );
  const pullRequestNumber =
    readOptionalProperty(
      mapping,
      "pullRequestNumber"
    );
  const checkName =
    readOptionalProperty(
      mapping,
      "checkName"
    );
  const checkAppId =
    readOptionalProperty(
      mapping,
      "checkAppId"
    );
  const pullRequestRevisionId =
    readOptionalProperty(
      mapping,
      "pullRequestRevisionId"
    );

  requireMappingString(workItemId, "workItemId");
  requireMappingString(attemptId, "attemptId");
  requireMappingString(artifactId, "artifactId");
  requireMappingString(criterionKey, "criterionKey");
  requireOptionalDigest(
    deliveryBindingDigest,
    "deliveryBindingDigest"
  );
  if (
    deliveryBindingDigest !== undefined &&
    (
      typeof pullRequestNumber !==
        "number" ||
      !Number.isSafeInteger(
        pullRequestNumber
      ) ||
      pullRequestNumber <= 0
    )
  ) {
    throw new TypeError(
      "GitHub mapping pullRequestNumber must be a positive integer for delivery evidence."
    );
  }

  if (
    checkName !== undefined &&
    (
      typeof checkName !== "string" ||
      checkName.trim().length === 0 ||
      checkName !== checkName.trim() ||
      checkName.length > 256
    )
  ) {
    throw new TypeError(
      "GitHub mapping checkName is invalid."
    );
  }

  if (
    checkAppId !== undefined &&
    (
      typeof checkAppId !== "string" ||
      !/^[1-9]\d*$/.test(checkAppId) ||
      checkAppId.length > 32
    )
  ) {
    throw new TypeError(
      "GitHub mapping checkAppId is invalid."
    );
  }

  if (
    pullRequestRevisionId !==
      undefined &&
    (
      typeof pullRequestRevisionId !==
        "string" ||
      pullRequestRevisionId.length === 0 ||
      pullRequestRevisionId.length > 256 ||
      !Number.isFinite(
        Date.parse(
          pullRequestRevisionId
        )
      )
    )
  ) {
    throw new TypeError(
      "GitHub mapping pullRequestRevisionId is invalid."
    );
  }

  return {
    workItemId,
    attemptId,
    artifactId,
    criterionKey,
    ...(deliveryBindingDigest ===
    undefined
      ? {}
      : {
          deliveryBindingDigest,
          pullRequestNumber:
            pullRequestNumber as number,
          ...(checkName === undefined
            ? {}
            : { checkName }),
          ...(checkAppId === undefined
            ? {}
            : { checkAppId }),
          ...(pullRequestRevisionId ===
          undefined
            ? {}
            : {
                pullRequestRevisionId
              })
        })
  };
}

function normalizePullRequestReviewMapping(
  mapping: unknown
): GitHubPullRequestReviewMapping {
  const normalized =
    normalizeCheckMapping(mapping);
  const reviewerId =
    readOptionalProperty(
      mapping,
      "reviewerId"
    );

  if (
    typeof reviewerId !== "string" ||
    !/^[1-9]\d*$/.test(reviewerId) ||
    reviewerId.length > 32
  ) {
    throw new TypeError(
      "GitHub mapping reviewerId must be a positive decimal identifier."
    );
  }

  return {
    ...normalized,
    reviewerId
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

function requireOptionalDigest(
  value: unknown,
  field: string
): asserts value is string | undefined {
  if (
    value !== undefined &&
    (
      typeof value !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(
        value
      )
    )
  ) {
    throw new TypeError(
      `GitHub mapping ${field} must be a SHA-256 digest.`
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
