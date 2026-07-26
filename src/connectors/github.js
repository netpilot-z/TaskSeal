export function normalizeGitHubIssue(issue, mapping) {
  requireIdentifier(issue.id, "issue id");
  requireIdentifier(issue.number, "issue number");
  requireString(issue.title, "issue title");
  requireHttpUrl(issue.html_url, "issue html_url");
  requireString(issue.created_at, "issue created_at");
  requireString(issue.updated_at, "issue updated_at");
  requireMappingString(mapping?.workItemId, "workItemId");
  requireEvidenceKeys(mapping?.requiredEvidence);

  if (issue.pull_request) {
    throw new TypeError(
      "GitHub issue must not represent a pull request."
    );
  }

  return {
    eventId: `github:issue-${issue.id}:created`,
    workItemId: mapping.workItemId,
    type: "work_item.created",
    occurredAt: issue.created_at,
    payload: {
      title: issue.title,
      requiredEvidence: [...mapping.requiredEvidence],
      externalLink: {
        provider: "github",
        externalId: String(issue.id),
        url: issue.html_url
      }
    }
  };
}

export function normalizeGitHubPullRequest(pullRequest, mapping) {
  requireIdentifier(pullRequest.id, "pull request id");
  requireHttpUrl(pullRequest.html_url, "pull request html_url");
  requireString(pullRequest.updated_at, "pull request updated_at");
  requireString(pullRequest.head?.sha, "pull request head.sha");
  requireMappingString(mapping?.workItemId, "workItemId");
  requireMappingString(mapping?.attemptId, "attemptId");

  const artifactId = `pr-${pullRequest.id}`;

  return {
    eventId: `github:${artifactId}:${pullRequest.head.sha}:${pullRequest.updated_at}`,
    workItemId: mapping.workItemId,
    type: "artifact.linked",
    occurredAt: pullRequest.updated_at,
    payload: {
      artifactId,
      attemptId: mapping.attemptId,
      kind: "pull_request",
      revision: pullRequest.head.sha,
      url: pullRequest.html_url
    }
  };
}

export function normalizeGitHubCheck(check, mapping) {
  requireIdentifier(check.id, "check id");
  requireString(check.head_sha, "check head_sha");
  requireHttpUrl(check.details_url, "check details_url");
  requireString(check.completed_at, "check completed_at");
  requireMappingString(mapping?.workItemId, "workItemId");
  requireMappingString(mapping?.attemptId, "attemptId");
  requireMappingString(mapping?.artifactId, "artifactId");
  requireMappingString(mapping?.criterionKey, "criterionKey");

  if (check.status !== "completed") {
    throw new TypeError("This experiment only accepts completed GitHub checks.");
  }

  const evidenceId = `check-${check.id}`;

  return {
    eventId: `github:${evidenceId}:${check.head_sha}`,
    workItemId: mapping.workItemId,
    type: "evidence.recorded",
    occurredAt: check.completed_at,
    payload: {
      evidenceId,
      attemptId: mapping.attemptId,
      artifactId: mapping.artifactId,
      revision: check.head_sha,
      criterionKey: mapping.criterionKey,
      outcome: check.conclusion === "success" ? "passed" : "failed",
      url: check.details_url
    }
  };
}

function requireIdentifier(value, field) {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    String(value).length === 0
  ) {
    throw new TypeError(`GitHub ${field} must be present.`);
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`GitHub ${field} must be a non-empty string.`);
  }
}

function requireMappingString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(
      `GitHub mapping ${field} must be a non-empty string.`
    );
  }
}

function requireEvidenceKeys(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (item) => typeof item !== "string" || item.trim().length === 0
    )
  ) {
    throw new TypeError(
      "GitHub mapping requiredEvidence must be a non-empty string array."
    );
  }
}

function requireHttpUrl(value, field) {
  requireString(value, field);

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`GitHub ${field} must be an http or https URL.`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError(`GitHub ${field} must be an http or https URL.`);
  }
}
