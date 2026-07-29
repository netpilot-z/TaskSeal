import type {
  ProviderFactProvenanceClaim,
  ProviderFactProvenanceVerificationResult,
  ProviderFactProvenanceVerifier
} from "../application/provider-fact-provenance.ts";
import {
  MAX_PROVIDER_FACT_PROVENANCE_CLAIMS
} from "../application/provider-fact-provenance.ts";
import {
  deriveGitHubCheckSourceRevision,
  deriveGitHubReviewSourceRevision,
  digestProviderFactContent
} from "../lib/provider-snapshot.ts";
import {
  readGitHubCheckRun,
  readGitHubIssue,
  readGitHubPullRequest,
  readGitHubPullRequestReview
} from "./github-read-client.ts";
import type {
  FetchLike
} from "./github-read-client.ts";
import {
  readLinearIssueIdentity
} from "./linear-read-client.ts";
import type {
  LinearFetchLike
} from "./linear-read-client.ts";

export const PROVIDER_FACT_PROVENANCE_READ_CONCURRENCY =
  4;
export const PROVIDER_FACT_PROVENANCE_MAX_TIMEOUT_MS =
  15_000;
export const PROVIDER_FACT_PROVENANCE_TOTAL_TIMEOUT_MS =
  30_000;

export interface GitHubProvenanceReadOptions {
  token?: string | null | undefined;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface LinearProvenanceReadOptions {
  apiKey?: string | undefined;
  accessToken?: string | undefined;
  expectedProjectId: string;
  fetchImpl?: LinearFetchLike;
  timeoutMs?: number;
}

export interface ReadOnlyProviderFactProvenanceOptions {
  github?: GitHubProvenanceReadOptions | undefined;
  linear?: LinearProvenanceReadOptions | undefined;
  totalTimeoutMs?: number | undefined;
}

export function createReadOnlyProviderFactProvenanceVerifier({
  github,
  linear,
  totalTimeoutMs
}: ReadOnlyProviderFactProvenanceOptions):
  ProviderFactProvenanceVerifier {
  return {
    async verify(
      claims: readonly ProviderFactProvenanceClaim[]
    ): Promise<
      ProviderFactProvenanceVerificationResult[]
    > {
      if (
        claims.length >
        MAX_PROVIDER_FACT_PROVENANCE_CLAIMS
      ) {
        throw unavailable();
      }

      if (claims.length === 0) {
        return [];
      }

      const timeout = normalizeBoundedTimeout({
        timeoutMs: totalTimeoutMs,
        defaultMs:
          PROVIDER_FACT_PROVENANCE_TOTAL_TIMEOUT_MS,
        maximumMs:
          PROVIDER_FACT_PROVENANCE_TOTAL_TIMEOUT_MS
      });

      return withTotalTimeout(
        verifyClaimBatches({
          claims,
          github,
          linear
        }),
        timeout
      );
    }
  };
}

async function verifyClaimBatches({
  claims,
  github,
  linear
}: {
  claims: readonly ProviderFactProvenanceClaim[];
  github:
    | GitHubProvenanceReadOptions
    | undefined;
  linear:
    | LinearProvenanceReadOptions
    | undefined;
}): Promise<
  ProviderFactProvenanceVerificationResult[]
> {
  const results:
    ProviderFactProvenanceVerificationResult[] =
      [];

  for (
    let offset = 0;
    offset < claims.length;
    offset +=
      PROVIDER_FACT_PROVENANCE_READ_CONCURRENCY
  ) {
    const batch = claims.slice(
      offset,
      offset +
        PROVIDER_FACT_PROVENANCE_READ_CONCURRENCY
    );
    const batchResults = await Promise.all(
      batch.map(async (claim) => {
        const verified =
          claim.provider === "github"
            ? await verifyGitHubClaim(
                claim,
                github
              )
            : await verifyLinearClaim(
                claim,
                linear
              );

        return {
          schemaVersion: 1 as const,
          claimDigest: claim.claimDigest,
          outcome: verified
            ? "verified" as const
            : "mismatch" as const
        };
      })
    );

    results.push(...batchResults);
  }

  return results;
}

async function withTotalTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer:
    | ReturnType<typeof setTimeout>
    | undefined;
  const deadline = new Promise<never>(
    (_resolve, reject) => {
      timer = setTimeout(
        () => reject(unavailable()),
        timeoutMs
      );
    }
  );

  try {
    return await Promise.race([
      operation,
      deadline
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function verifyGitHubClaim(
  claim: ProviderFactProvenanceClaim,
  options: GitHubProvenanceReadOptions | undefined
): Promise<boolean> {
  const readOptions =
    normalizeGitHubReadOptions(options);

  const repository = readGitHubRepository(claim);
  if (!repository) {
    return false;
  }

  if (
    claim.objectType === "issue" &&
    claim.locator.kind === "github.issue"
  ) {
    try {
      const issue = await readGitHubIssue({
        ...readOptions,
        repository,
        issueNumber: claim.locator.number
      });
      const externalId = String(issue.id);
      const sourceObject = {
        providerObjectKey:
          `github:issue:${externalId}`,
        provider: "github" as const,
        objectType: "issue" as const,
        externalId,
        url: issue.html_url
      };

      return (
        externalId === claim.externalId &&
        String(issue.number) ===
          String(claim.locator.number) &&
        sourceObject.providerObjectKey ===
          claim.providerObjectKey &&
        issue.html_url === claim.url &&
        issue.updated_at ===
          claim.sourceRevisionId &&
        issueTimesMatch(claim, {
          createdAt: issue.created_at,
          updatedAt: issue.updated_at
        }) &&
        claim.content.kind === "issue" &&
        issue.title === claim.content.title &&
        digestProviderFactContent({
          sourceObject,
          observed: {
            title: issue.title,
            createdAt: issue.created_at
          }
        }) === claim.contentDigest
      );
    } catch (error) {
      if (
        hasErrorCode(
          error,
          "GITHUB_ISSUE_IS_PULL_REQUEST"
        )
      ) {
        return false;
      }

      throw unavailable();
    }
  }

  if (
    claim.objectType === "pull_request" &&
    claim.locator.kind === "github.pull_request"
  ) {
    let pullRequest;

    try {
      pullRequest = await readGitHubPullRequest({
        ...readOptions,
        repository,
        pullRequestNumber:
          claim.locator.number
      });
    } catch {
      throw unavailable();
    }

    const externalId = String(pullRequest.id);
    const sourceObject = {
      providerObjectKey:
        `github:pull_request:${externalId}`,
      provider: "github" as const,
      objectType: "pull_request" as const,
      externalId,
      url: pullRequest.html_url
    };

    return (
      externalId === claim.externalId &&
      String(pullRequest.number) ===
        String(claim.locator.number) &&
      sourceObject.providerObjectKey ===
        claim.providerObjectKey &&
      pullRequest.html_url === claim.url &&
      pullRequest.updated_at ===
        claim.sourceRevisionId &&
      claim.eventType === "artifact.linked" &&
      pullRequest.updated_at ===
        claim.sourceOccurredAt &&
      pullRequest.updated_at ===
        claim.eventOccurredAt &&
      claim.content.kind ===
        "pull_request" &&
      pullRequest.head.sha ===
        claim.content.headRevision &&
      digestProviderFactContent({
        sourceObject,
        observed: {
          headRevision: pullRequest.head.sha
        }
      }) === claim.contentDigest
    );
  }

  if (
    claim.objectType === "check" &&
    claim.locator.kind === "github.check_run"
  ) {
    let check;
    let pullRequest:
      | Awaited<
          ReturnType<
            typeof readGitHubPullRequest
          >
        >
      | null = null;

    try {
      check = await readGitHubCheckRun({
        ...readOptions,
        repository,
        checkRunId: claim.locator.id
      });
      if (
        claim.locator
          .pullRequestNumber !==
        undefined
      ) {
        pullRequest =
          await readGitHubPullRequest({
            ...readOptions,
            repository,
            pullRequestNumber:
              claim.locator
                .pullRequestNumber
          });
      }
    } catch {
      throw unavailable();
    }

    if (
      check.status !== "completed" ||
      typeof check.conclusion !== "string" ||
      typeof check.completed_at !== "string"
    ) {
      return false;
    }

    const externalId = String(check.id);
    const sourceObject = {
      providerObjectKey:
        `github:check:${externalId}`,
      provider: "github" as const,
      objectType: "check" as const,
      externalId,
      url: check.details_url
    };
    const deliveryCheckAppId =
      check.app === undefined ||
      check.app === null
        ? null
        : String(check.app.id);
    const sourceRevisionId =
      claim.locator
        .pullRequestNumber ===
      undefined
        ? check.completed_at
        : deliveryCheckAppId !== null &&
            /^[1-9]\d*$/.test(
              deliveryCheckAppId
            )
          ? deriveGitHubCheckSourceRevision({
              completedAt:
                check.completed_at,
              name: check.name,
              appId:
                deliveryCheckAppId,
              pullRequestRevisionId:
                pullRequest
                  ?.updated_at ?? ""
            })
          : null;

    return (
      externalId === claim.externalId &&
      externalId === claim.locator.id &&
      sourceObject.providerObjectKey ===
        claim.providerObjectKey &&
      check.details_url === claim.url &&
      sourceRevisionId ===
        claim.sourceRevisionId &&
      claim.eventType ===
        "evidence.recorded" &&
      check.completed_at ===
        claim.sourceOccurredAt &&
      check.completed_at ===
        claim.eventOccurredAt &&
      claim.content.kind === "check" &&
      check.head_sha ===
        claim.content.headRevision &&
      (
        pullRequest === null ||
        (
          claim.locator
            .pullRequestNumber !==
            undefined &&
          String(
            pullRequest.number
          ) ===
            String(
              claim.locator
                .pullRequestNumber
            ) &&
          isMappedGitHubPullRequestUrl({
            value:
              pullRequest.html_url,
            repository,
            pullRequestNumber:
              claim.locator
                .pullRequestNumber
          }) &&
          pullRequest.head.sha ===
            check.head_sha &&
          pullRequest.head.sha ===
            claim.content
              .headRevision
        )
      ) &&
      (
        check.conclusion === "success"
          ? "passed"
          : "failed"
      ) === claim.content.outcome &&
      digestProviderFactContent({
        sourceObject,
        observed: {
          headRevision: check.head_sha,
          outcome:
            check.conclusion === "success"
              ? "passed"
              : "failed"
        }
      }) === claim.contentDigest
    );
  }

  if (
    claim.objectType ===
      "pull_request_review" &&
    claim.locator.kind ===
      "github.pull_request_review"
  ) {
    let pullRequest;
    let review;

    try {
      review =
        await readGitHubPullRequestReview({
          ...readOptions,
          repository,
          pullRequestNumber:
            claim.locator
              .pullRequestNumber,
          reviewId:
            claim.locator.id
        });
      pullRequest =
        await readGitHubPullRequest({
          ...readOptions,
          repository,
          pullRequestNumber:
            claim.locator
              .pullRequestNumber
        });
    } catch {
      throw unavailable();
    }

    const state =
      review.state === "APPROVED"
        ? "approved"
        : review.state ===
            "CHANGES_REQUESTED"
          ? "changes_requested"
          : review.state ===
              "DISMISSED"
            ? "dismissed"
            : null;
    if (
      state === null ||
      claim.content.kind !==
        "pull_request_review"
    ) {
      return false;
    }

    const externalId = String(review.id);
    const reviewerId =
      String(review.user.id);
    const outcome =
      state === "approved"
        ? "passed"
        : "failed";
    const sourceObject = {
      providerObjectKey:
        `github:pull_request_review:${externalId}`,
      provider: "github" as const,
      objectType:
        "pull_request_review" as const,
      externalId,
      url: review.html_url
    };
    const observed = {
      headRevision:
        pullRequest.head.sha,
      reviewerId,
      state,
      outcome
    };

    return (
      externalId === claim.externalId &&
      externalId ===
        claim.locator.id &&
      String(pullRequest.number) ===
        String(
          claim.locator
            .pullRequestNumber
        ) &&
      sourceObject.providerObjectKey ===
        claim.providerObjectKey &&
      review.html_url === claim.url &&
      review.commit_id ===
        pullRequest.head.sha &&
      pullRequest.head.sha ===
        claim.content.headRevision &&
      reviewerId ===
        claim.content.reviewerId &&
      state === claim.content.state &&
      outcome === claim.content.outcome &&
      pullRequest.updated_at ===
        claim.sourceOccurredAt &&
      pullRequest.updated_at ===
        claim.eventOccurredAt &&
      deriveGitHubReviewSourceRevision({
        pullRequestUpdatedAt:
          pullRequest.updated_at,
        state
      }) === claim.sourceRevisionId &&
      claim.eventType ===
        "evidence.recorded" &&
      digestProviderFactContent({
        sourceObject,
        observed
      }) === claim.contentDigest
    );
  }

  return false;
}

async function verifyLinearClaim(
  claim: ProviderFactProvenanceClaim,
  options: LinearProvenanceReadOptions | undefined
): Promise<boolean> {
  if (
    claim.objectType !== "issue" ||
    claim.locator.kind !== "linear.issue"
  ) {
    return false;
  }

  const readOptions =
    normalizeLinearReadOptions(options);
  const scope = readLinearScope(claim);
  if (
    !scope ||
    claim.locator.id !== claim.externalId
  ) {
    return false;
  }

  let result;

  try {
    result = await readLinearIssueIdentity({
      ...readOptions,
      issueId: claim.locator.id
    });
  } catch {
    throw unavailable();
  }

  const issue = result.issue;
  const externalId = issue.id.toLowerCase();
  const sourceObject = {
    providerObjectKey:
      `linear:issue:${externalId}`,
    provider: "linear" as const,
    objectType: "issue" as const,
    externalId,
    url: issue.url
  };
  const identifier =
    /^([A-Za-z][A-Za-z0-9]*)-([1-9]\d*)$/.exec(
      issue.identifier
    );

  return (
    result.organizationId.toLowerCase() ===
      scope.organizationId &&
    issue.team.id.toLowerCase() ===
      scope.teamId &&
    issue.project.id.toLowerCase() ===
      readOptions.expectedProjectId &&
    identifier !== null &&
    identifier[1]?.toLowerCase() ===
      issue.team.key.toLowerCase() &&
    issue.identifier ===
      claim.locator.identifier &&
    externalId === claim.externalId &&
    sourceObject.providerObjectKey ===
      claim.providerObjectKey &&
    issue.url === claim.url &&
    issue.updatedAt ===
      claim.sourceRevisionId &&
    issueTimesMatch(claim, {
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt
    }) &&
    claim.content.kind === "issue" &&
    issue.title === claim.content.title &&
    digestProviderFactContent({
      sourceObject,
      observed: {
        title: issue.title,
        createdAt: issue.createdAt
      }
    }) === claim.contentDigest
  );
}

function issueTimesMatch(
  claim: ProviderFactProvenanceClaim,
  {
    createdAt,
    updatedAt
  }: {
    createdAt: string;
    updatedAt: string;
  }
): boolean {
  if (claim.sourceOccurredAt !== updatedAt) {
    return false;
  }

  if (claim.eventType === "work_item.created") {
    return claim.eventOccurredAt === createdAt;
  }

  return (
    (
      claim.eventType ===
        "external_link.linked" ||
      claim.eventType ===
        "external_link.observed"
    ) &&
    claim.eventOccurredAt === updatedAt
  );
}

function normalizeGitHubReadOptions(
  options: GitHubProvenanceReadOptions | undefined
): GitHubProvenanceReadOptions & {
  timeoutMs: number;
} {
  if (!options) {
    throw unavailable();
  }

  return {
    ...options,
    timeoutMs: normalizeBoundedTimeout({
      timeoutMs: options.timeoutMs,
      defaultMs:
        PROVIDER_FACT_PROVENANCE_MAX_TIMEOUT_MS,
      maximumMs:
        PROVIDER_FACT_PROVENANCE_MAX_TIMEOUT_MS
    })
  };
}

function normalizeLinearReadOptions(
  options: LinearProvenanceReadOptions | undefined
): LinearProvenanceReadOptions & {
  timeoutMs: number;
} {
  if (!options) {
    throw unavailable();
  }

  const expectedProjectId =
    options.expectedProjectId?.toLowerCase();

  if (
    typeof expectedProjectId !== "string" ||
    !isUuid(expectedProjectId)
  ) {
    throw unavailable();
  }

  return {
    ...options,
    expectedProjectId,
    timeoutMs: normalizeBoundedTimeout({
      timeoutMs: options.timeoutMs,
      defaultMs:
        PROVIDER_FACT_PROVENANCE_MAX_TIMEOUT_MS,
      maximumMs:
        PROVIDER_FACT_PROVENANCE_MAX_TIMEOUT_MS
    })
  };
}

function normalizeBoundedTimeout({
  timeoutMs,
  defaultMs,
  maximumMs
}: {
  timeoutMs: number | undefined;
  defaultMs: number;
  maximumMs: number;
}): number {
  const normalized = timeoutMs ?? defaultMs;

  if (
    !Number.isInteger(normalized) ||
    normalized <= 0 ||
    normalized > maximumMs
  ) {
    throw unavailable();
  }

  return normalized;
}

function readGitHubRepository(
  claim: ProviderFactProvenanceClaim
): string | null {
  const prefix = "github:repository:";
  if (
    claim.scopeRef.kind !== "repository" ||
    claim.scopeRef.parentKey !== undefined ||
    !claim.scopeRef.key.startsWith(prefix)
  ) {
    return null;
  }

  const repository = claim.scopeRef.key.slice(
    prefix.length
  );
  const parts = repository.split("/");
  return parts.length === 2 &&
    parts.every(
      (part) =>
        /^[a-z0-9_.-]+$/.test(part) &&
        part !== "." &&
        part !== ".."
    )
    ? repository
    : null;
}

function isMappedGitHubPullRequestUrl({
  value,
  repository,
  pullRequestNumber
}: {
  value: string;
  repository: string;
  pullRequestNumber: number;
}): boolean {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return false;
  }

  const [owner, name] =
    repository.split("/");
  const parts = url.pathname.split("/");

  return (
    url.protocol === "https:" &&
    url.hostname.toLowerCase() ===
      "github.com" &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.search &&
    !url.hash &&
    parts.length === 5 &&
    parts[0] === "" &&
    parts[1]?.toLowerCase() ===
      owner &&
    parts[2]?.toLowerCase() ===
      name &&
    parts[3] === "pull" &&
    parts[4] ===
      String(pullRequestNumber)
  );
}

function readLinearScope(
  claim: ProviderFactProvenanceClaim
): {
  teamId: string;
  organizationId: string;
} | null {
  const teamPrefix = "linear:team:";
  const organizationPrefix =
    "linear:organization:";
  if (
    claim.scopeRef.kind !== "team" ||
    !claim.scopeRef.key.startsWith(teamPrefix) ||
    typeof claim.scopeRef.parentKey !== "string" ||
    !claim.scopeRef.parentKey.startsWith(
      organizationPrefix
    )
  ) {
    return null;
  }

  const teamId = claim.scopeRef.key
    .slice(teamPrefix.length)
    .toLowerCase();
  const organizationId =
    claim.scopeRef.parentKey
      .slice(organizationPrefix.length)
      .toLowerCase();

  return isUuid(teamId) &&
    isUuid(organizationId)
    ? {
        teamId,
        organizationId
      }
    : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value
  );
}

function hasErrorCode(
  error: unknown,
  code: string
): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === code
  );
}

function unavailable(): Error {
  return new Error(
    "Provider provenance read is unavailable."
  );
}
