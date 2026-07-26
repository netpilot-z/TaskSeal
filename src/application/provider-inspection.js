import {
  getGitHubCoordinates,
  getLinearCoordinates,
  readProjectConfiguration
} from "../config/project-config.ts";
import {
  normalizeGitHubCheck,
  normalizeGitHubIssue,
  normalizeGitHubPullRequest
} from "../connectors/github.js";
import {
  readGitHubDelivery,
  readGitHubIssue
} from "../connectors/github-read-client.js";
import { normalizeLinearIssue } from "../connectors/linear.js";
import { readLinearIssue } from "../connectors/linear-read-client.js";

export async function inspectGitHubIssueProvider({
  cwd,
  issueNumber,
  workItemId,
  requiredEvidence,
  environment = process.env,
  fetchImpl = globalThis.fetch
}) {
  requireMappingString(workItemId, "workItemId");
  requireEvidenceKeys(requiredEvidence);
  const configuration = await readProjectConfiguration({ cwd });
  const { repository } = getGitHubCoordinates(configuration);
  const token = firstCredential(
    environment.GITHUB_TOKEN,
    environment.GH_TOKEN
  );
  const issue = await readGitHubIssue({
    repository,
    issueNumber,
    token,
    fetchImpl
  });
  const event = normalizeGitHubIssue(issue, {
    workItemId,
    requiredEvidence
  });

  return {
    schemaVersion: 1,
    mode: "read-only",
    provider: "github",
    scope: {
      repository
    },
    mapping: {
      workItemId,
      requiredEvidence: [...requiredEvidence]
    },
    source: {
      issue: {
        id: String(issue.id),
        number: issue.number
      }
    },
    events: [event]
  };
}

export async function inspectGitHubProvider({
  cwd,
  issueNumber,
  pullRequestNumber,
  checkName,
  workItemId,
  attemptId,
  criterionKey,
  environment = process.env,
  fetchImpl = globalThis.fetch
}) {
  requireMappingString(workItemId, "workItemId");
  requireMappingString(attemptId, "attemptId");
  requireMappingString(criterionKey, "criterionKey");
  const configuration = await readProjectConfiguration({ cwd });
  const { repository } = getGitHubCoordinates(configuration);
  const token = firstCredential(
    environment.GITHUB_TOKEN,
    environment.GH_TOKEN
  );
  const facts = await readGitHubDelivery({
    repository,
    issueNumber,
    pullRequestNumber,
    checkName,
    token,
    fetchImpl
  });
  const issueEvent = normalizeGitHubIssue(facts.issue, {
    workItemId,
    requiredEvidence: [criterionKey]
  });
  const artifactEvent = normalizeGitHubPullRequest(facts.pullRequest, {
    workItemId,
    attemptId
  });
  const evidenceEvent = normalizeGitHubCheck(facts.check, {
    workItemId,
    attemptId,
    artifactId: artifactEvent.payload.artifactId,
    criterionKey
  });

  return {
    schemaVersion: 1,
    mode: "read-only",
    provider: "github",
    scope: {
      repository
    },
    mapping: {
      association: "explicit",
      workItemId,
      attemptId,
      criterionKey
    },
    source: {
      issue: {
        id: String(facts.issue.id),
        number: facts.issue.number
      },
      pullRequest: {
        id: String(facts.pullRequest.id),
        number: facts.pullRequest.number,
        revision: facts.pullRequest.head.sha
      },
      check: {
        id: String(facts.check.id),
        name: facts.check.name,
        status: facts.check.status,
        conclusion: facts.check.conclusion
      }
    },
    events: [issueEvent, artifactEvent, evidenceEvent]
  };
}

export async function inspectLinearProvider({
  cwd,
  issueReference,
  workItemId,
  requiredEvidence,
  environment = process.env,
  fetchImpl = globalThis.fetch
}) {
  requireMappingString(workItemId, "workItemId");
  requireEvidenceKeys(requiredEvidence);
  const configuration = await readProjectConfiguration({ cwd });
  const { workspace, team } = getLinearCoordinates(configuration);
  const facts = await readLinearIssue({
    workspace,
    team,
    issueReference,
    apiKey: environment.LINEAR_API_KEY,
    accessToken: environment.LINEAR_ACCESS_TOKEN,
    fetchImpl
  });
  const event = normalizeLinearIssue(facts.issue, {
    workItemId,
    requiredEvidence
  });

  return {
    schemaVersion: 1,
    mode: "read-only",
    provider: "linear",
    scope: {
      workspace: {
        configured: workspace,
        id: facts.organization.id,
        name: facts.organization.name,
        urlKey: facts.organization.urlKey
      },
      team: {
        configured: team,
        id: facts.team.id,
        name: facts.team.name,
        key: facts.team.key
      }
    },
    mapping: {
      workItemId,
      requiredEvidence: [...requiredEvidence]
    },
    source: {
      issue: {
        id: facts.issue.id,
        identifier: facts.issue.identifier
      }
    },
    events: [event]
  };
}

function firstCredential(...values) {
  return values.find(
    (value) => typeof value === "string" && value.trim().length > 0
  );
}

function requireMappingString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw inspectionError(
      "PROVIDER_MAPPING_INVALID",
      `Provider mapping ${field} must be a non-empty string.`
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
    throw inspectionError(
      "PROVIDER_MAPPING_INVALID",
      "Provider requiredEvidence must be a non-empty string array."
    );
  }
}

function inspectionError(code, message) {
  const error = new Error(message);
  error.name = "ProviderInspectionError";
  error.code = code;
  return error;
}
