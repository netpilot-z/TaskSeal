import {
  getGitHubCoordinates,
  getLinearCoordinates,
  readProjectConfiguration
} from "../config/project-config.ts";
import {
  normalizeGitHubCheck,
  normalizeGitHubCheckFact,
  normalizeGitHubIssue,
  normalizeGitHubIssueFact,
  normalizeGitHubPullRequest,
  normalizeGitHubPullRequestFact
} from "../connectors/github.js";
import {
  readGitHubDelivery,
  readGitHubIssue
} from "../connectors/github-read-client.js";
import {
  normalizeLinearIssue,
  normalizeLinearIssueFact
} from "../connectors/linear.js";
import { readLinearIssue } from "../connectors/linear-read-client.js";

export async function inspectGitHubIssueProvider({
  cwd,
  issueNumber,
  workItemId,
  requiredEvidence,
  snapshotVersion,
  managedFields,
  now = () => new Date(),
  environment = process.env,
  fetchImpl = globalThis.fetch
}) {
  requireMappingString(workItemId, "workItemId");
  requireEvidenceKeys(requiredEvidence);
  const version = resolveSnapshotVersion({
    snapshotVersion,
    managedFields
  });
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

  if (version.schemaVersion === 2) {
    const normalizedEvidence =
      normalizeV2RequiredEvidence(requiredEvidence);
    const fact = normalizeGitHubIssueFact(issue, {
      workItemId,
      requiredEvidence: normalizedEvidence
    });

    return {
      schemaVersion: 2,
      mode: "read-only",
      provider: "github",
      scope: githubRepositoryScope(repository),
      mapping: {
        workItemId,
        requiredEvidence: normalizedEvidence,
        managedFields: version.managedFields
      },
      capturedAt: captureTimestamp(now),
      facts: [fact]
    };
  }

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
  snapshotVersion,
  managedFields,
  now = () => new Date(),
  environment = process.env,
  fetchImpl = globalThis.fetch
}) {
  requireMappingString(workItemId, "workItemId");
  requireMappingString(attemptId, "attemptId");
  requireMappingString(criterionKey, "criterionKey");
  const version = resolveSnapshotVersion({
    snapshotVersion,
    managedFields
  });
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

  if (version.schemaVersion === 2) {
    const requiredEvidence = [criterionKey];
    const issueFact = normalizeGitHubIssueFact(facts.issue, {
      workItemId,
      requiredEvidence
    });
    const artifactFact = normalizeGitHubPullRequestFact(
      facts.pullRequest,
      {
        workItemId,
        attemptId
      }
    );
    const evidenceFact = normalizeGitHubCheckFact(facts.check, {
      workItemId,
      attemptId,
      artifactId:
        artifactFact.candidateEvent.payload.artifactId,
      criterionKey
    });

    return {
      schemaVersion: 2,
      mode: "read-only",
      provider: "github",
      scope: githubRepositoryScope(repository),
      mapping: {
        workItemId,
        requiredEvidence,
        managedFields: version.managedFields,
        attemptId,
        artifactId:
          artifactFact.candidateEvent.payload.artifactId,
        artifactRevision:
          artifactFact.observed.headRevision,
        criterionKey
      },
      capturedAt: captureTimestamp(now),
      facts: [issueFact, artifactFact, evidenceFact]
    };
  }

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
  snapshotVersion,
  managedFields,
  now = () => new Date(),
  environment = process.env,
  fetchImpl = globalThis.fetch
}) {
  requireMappingString(workItemId, "workItemId");
  requireEvidenceKeys(requiredEvidence);
  const version = resolveSnapshotVersion({
    snapshotVersion,
    managedFields
  });
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

  if (version.schemaVersion === 2) {
    const normalizedEvidence =
      normalizeV2RequiredEvidence(requiredEvidence);
    const fact = normalizeLinearIssueFact(facts.issue, {
      workItemId,
      requiredEvidence: normalizedEvidence
    });

    return {
      schemaVersion: 2,
      mode: "read-only",
      provider: "linear",
      scope: linearTeamScope({
        organizationId: facts.organization.id,
        teamId: facts.team.id
      }),
      mapping: {
        workItemId,
        requiredEvidence: normalizedEvidence,
        managedFields: version.managedFields
      },
      capturedAt: captureTimestamp(now),
      facts: [fact]
    };
  }

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

function resolveSnapshotVersion({
  snapshotVersion,
  managedFields
}) {
  const schemaVersion = snapshotVersion ?? 1;

  if (schemaVersion === 1 && managedFields === undefined) {
    return {
      schemaVersion: 1
    };
  }

  if (
    schemaVersion === 2 &&
    Array.isArray(managedFields) &&
    managedFields.length <= 1 &&
    new Set(managedFields).size === managedFields.length &&
    managedFields.every((field) => field === "title")
  ) {
    return {
      schemaVersion: 2,
      managedFields: [...managedFields]
    };
  }

  throw inspectionError(
    "PROVIDER_MAPPING_INVALID",
    "ProviderSnapshot v2 requires explicit supported managedFields."
  );
}

function normalizeV2RequiredEvidence(value) {
  if (
    value.length > 64 ||
    new Set(value).size !== value.length ||
    value.some((item) => [...item].length > 128)
  ) {
    throw inspectionError(
      "PROVIDER_MAPPING_INVALID",
      "ProviderSnapshot v2 requiredEvidence must be unique and bounded."
    );
  }

  return [...value].sort();
}

function githubRepositoryScope(repository) {
  const match = /^([^/]+)\/([^/]+)$/.exec(repository);

  if (!match) {
    throw inspectionError(
      "PROVIDER_MAPPING_INVALID",
      "GitHub repository scope must be an owner/repository coordinate."
    );
  }

  return {
    kind: "repository",
    key:
      `github:repository:${match[1].toLowerCase()}/${match[2].toLowerCase()}`
  };
}

function linearTeamScope({
  organizationId,
  teamId
}) {
  const organizationUuid = normalizeUuid(
    organizationId,
    "organization"
  );
  const teamUuid = normalizeUuid(teamId, "team");

  return {
    kind: "team",
    key: `linear:team:${teamUuid}`,
    parentKey: `linear:organization:${organizationUuid}`
  };
}

function normalizeUuid(value, field) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value
    )
  ) {
    throw inspectionError(
      "PROVIDER_MAPPING_INVALID",
      `Linear ${field} scope requires a UUID.`
    );
  }

  return value.toLowerCase();
}

function captureTimestamp(now) {
  const capturedAt = now();

  if (
    !(capturedAt instanceof Date) ||
    !Number.isFinite(capturedAt.getTime())
  ) {
    throw inspectionError(
      "PROVIDER_MAPPING_INVALID",
      "Provider capture time must be a valid Date."
    );
  }

  return capturedAt.toISOString();
}

function inspectionError(code, message) {
  const error = new Error(message);
  error.name = "ProviderInspectionError";
  error.code = code;
  return error;
}
