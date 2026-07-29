import {
  getFeishuReadCoordinates,
  getGiteeCoordinates,
  getGitHubCoordinates,
  getLinearProjectCoordinates,
  readProjectConfiguration
} from "../config/project-config.ts";
import type {
  FeishuReadEnvironment,
  ProjectConfiguration
} from "../config/project-config.ts";
import {
  createFeishuAdapter
} from "../connectors/feishu.ts";
import type {
  FeishuHealthResult,
  FeishuProviderSnapshotV2
} from "../connectors/feishu.ts";
import type {
  FeishuFetchLike
} from "../connectors/feishu-read-client.ts";
import {
  createGiteeAdapter
} from "../connectors/gitee.ts";
import type {
  GiteeHealthResult,
  GiteeProviderSnapshotV2
} from "../connectors/gitee.ts";
import type {
  GiteeFetchLike
} from "../connectors/gitee-read-client.ts";
import {
  normalizeGitHubCheck,
  normalizeGitHubCheckFact,
  normalizeGitHubIssue,
  normalizeGitHubIssueFact,
  normalizeGitHubPullRequest,
  normalizeGitHubPullRequestFact
} from "../connectors/github.ts";
import {
  readGitHubDelivery,
  readGitHubIssue
} from "../connectors/github-read-client.ts";
import type {
  FetchLike,
  GitHubCheck,
  GitHubIssue,
  GitHubPullRequest
} from "../connectors/github-read-client.ts";
import {
  normalizeLinearIssue,
  normalizeLinearIssueFact
} from "../connectors/linear.ts";
import {
  readLinearIssue
} from "../connectors/linear-read-client.ts";
import type {
  LinearFetchLike,
  LinearIssue,
  LinearOrganization,
  LinearTeam
} from "../connectors/linear-read-client.ts";
import type {
  ArtifactLinkedEvent,
  EvidenceRecordedEvent,
  ManagedField,
  WorkItemCreatedEvent
} from "../domain/workflow.ts";
import type {
  ProviderCheckFact,
  ProviderIssueFact,
  ProviderPullRequestFact,
  ProviderSnapshotScope,
  ProviderSnapshotV2
} from "../lib/provider-snapshot.ts";

interface InspectionEnvironment {
  readonly GITHUB_TOKEN?: string | undefined;
  readonly GH_TOKEN?: string | undefined;
  readonly LINEAR_API_KEY?: string | undefined;
  readonly LINEAR_ACCESS_TOKEN?: string | undefined;
  readonly TASKSEAL_FEISHU_APP_ID?: string | undefined;
  readonly TASKSEAL_FEISHU_APP_SECRET?: string | undefined;
  readonly TASKSEAL_FEISHU_APP_TOKEN?: string | undefined;
  readonly TASKSEAL_FEISHU_TABLE_ID?: string | undefined;
  readonly TASKSEAL_FEISHU_RECORD_ID?: string | undefined;
  readonly TASKSEAL_FEISHU_TITLE_FIELD?: string | undefined;
  readonly TASKSEAL_FEISHU_STATUS_FIELD?: string | undefined;
  readonly TASKSEAL_FEISHU_UPDATED_AT_FIELD?: string | undefined;
}

interface SnapshotV1Options {
  snapshotVersion?: 1 | undefined;
  managedFields?: never;
}

interface SnapshotV2Options {
  snapshotVersion: 2;
  managedFields: ManagedField[];
}

interface GitHubIssueInspectionBaseOptions {
  cwd: string;
  issueNumber: number;
  workItemId: string;
  requiredEvidence: string[];
  now?: (() => unknown) | undefined;
  environment?: InspectionEnvironment | undefined;
  fetchImpl?: FetchLike | undefined;
}

type GitHubIssueInspectionV1Options =
  GitHubIssueInspectionBaseOptions & SnapshotV1Options;
type GitHubIssueInspectionV2Options =
  GitHubIssueInspectionBaseOptions & SnapshotV2Options;
type GitHubIssueInspectionOptions =
  | GitHubIssueInspectionV1Options
  | GitHubIssueInspectionV2Options;

interface GitHubDeliveryInspectionBaseOptions {
  cwd: string;
  issueNumber: number;
  pullRequestNumber: number;
  checkName: string;
  workItemId: string;
  attemptId: string;
  criterionKey: string;
  now?: (() => unknown) | undefined;
  environment?: InspectionEnvironment | undefined;
  fetchImpl?: FetchLike | undefined;
}

type GitHubDeliveryInspectionV1Options =
  GitHubDeliveryInspectionBaseOptions & SnapshotV1Options;
type GitHubDeliveryInspectionV2Options =
  GitHubDeliveryInspectionBaseOptions & SnapshotV2Options;
type GitHubDeliveryInspectionOptions =
  | GitHubDeliveryInspectionV1Options
  | GitHubDeliveryInspectionV2Options;

interface LinearInspectionBaseOptions {
  cwd: string;
  configuration?: ProjectConfiguration | undefined;
  issueReference: string;
  workItemId: string;
  requiredEvidence: string[];
  now?: (() => unknown) | undefined;
  environment?: InspectionEnvironment | undefined;
  fetchImpl?: LinearFetchLike | undefined;
}

type LinearInspectionV1Options =
  LinearInspectionBaseOptions & SnapshotV1Options;
type LinearInspectionV2Options =
  LinearInspectionBaseOptions & SnapshotV2Options;
type LinearInspectionOptions =
  | LinearInspectionV1Options
  | LinearInspectionV2Options;

interface GiteeHealthInspectionOptions {
  cwd: string;
  now?: (() => unknown) | undefined;
  fetchImpl?: GiteeFetchLike | undefined;
}

interface GiteeInspectionBaseOptions {
  cwd: string;
  issueReference: string;
  workItemId: string;
  requiredEvidence: string[];
  now?: (() => unknown) | undefined;
  fetchImpl?: GiteeFetchLike | undefined;
}

interface FeishuHealthInspectionOptions {
  cwd: string;
  configuration?: ProjectConfiguration | undefined;
  environment?:
    | (InspectionEnvironment & FeishuReadEnvironment)
    | undefined;
  now?: (() => unknown) | undefined;
  fetchImpl?: FeishuFetchLike | undefined;
}

interface FeishuInspectionOptions
  extends FeishuHealthInspectionOptions {
  workItemId: string;
  requiredEvidence: string[];
  snapshotVersion: 2;
  managedFields: ManagedField[];
}

type GiteeInspectionOptions =
  GiteeInspectionBaseOptions & SnapshotV2Options;

export interface GitHubIssueSnapshotV1 {
  schemaVersion: 1;
  mode: "read-only";
  provider: "github";
  scope: {
    repository: string;
  };
  mapping: {
    workItemId: string;
    requiredEvidence: string[];
  };
  source: {
    issue: {
      id: string;
      number: string | number;
    };
  };
  events: [WorkItemCreatedEvent];
}

export interface GitHubDeliverySnapshotV1 {
  schemaVersion: 1;
  mode: "read-only";
  provider: "github";
  scope: {
    repository: string;
  };
  mapping: {
    association: "explicit";
    workItemId: string;
    attemptId: string;
    criterionKey: string;
  };
  source: {
    issue: {
      id: string;
      number: string | number;
    };
    pullRequest: {
      id: string;
      number: string | number;
      revision: string;
    };
    check: {
      id: string;
      name: string;
      status: string;
      conclusion: unknown;
    };
  };
  events: [
    WorkItemCreatedEvent,
    ArtifactLinkedEvent,
    EvidenceRecordedEvent
  ];
}

export interface LinearSnapshotV1 {
  schemaVersion: 1;
  mode: "read-only";
  provider: "linear";
  scope: {
    workspace: {
      configured: string;
      id: string;
      name: string;
      urlKey: string;
    };
    team: {
      configured: string;
      id: string;
      name: string;
      key: string;
    };
  };
  mapping: {
    workItemId: string;
    requiredEvidence: string[];
  };
  source: {
    issue: {
      id: string;
      identifier: string;
    };
  };
  events: [WorkItemCreatedEvent];
}

export interface GitHubIssueSnapshotV2
  extends Omit<
    ProviderSnapshotV2,
    "provider" | "facts"
  > {
  provider: "github";
  facts: [ProviderIssueFact];
}

export interface GitHubDeliverySnapshotV2
  extends Omit<
    ProviderSnapshotV2,
    "provider" | "facts"
  > {
  provider: "github";
  facts: [
    ProviderIssueFact,
    ProviderPullRequestFact,
    ProviderCheckFact
  ];
}

export interface LinearSnapshotV2
  extends Omit<
    ProviderSnapshotV2,
    "provider" | "facts"
  > {
  provider: "linear";
  facts: [ProviderIssueFact];
}

interface ResolvedSnapshotV1 {
  schemaVersion: 1;
}

interface ResolvedSnapshotV2 {
  schemaVersion: 2;
  managedFields: ManagedField[];
}

type ResolvedSnapshotVersion =
  | ResolvedSnapshotV1
  | ResolvedSnapshotV2;

type InspectionErrorCode =
  | "PROVIDER_MAPPING_INVALID"
  | "FEISHU_CONFIG_INVALID";

export async function inspectGiteeHealthProvider({
  cwd,
  now = () => new Date(),
  fetchImpl = globalThis.fetch
}: GiteeHealthInspectionOptions): Promise<GiteeHealthResult> {
  const configuration =
    await readProjectConfiguration({ cwd });
  const { repository } =
    getGiteeCoordinates(configuration);
  const adapter = createGiteeAdapter({
    fetchImpl,
    now
  });

  return adapter.ports["provider.health"]({
    repository
  });
}

export async function inspectGiteeProvider({
  cwd,
  issueReference,
  workItemId,
  requiredEvidence,
  snapshotVersion,
  managedFields,
  now = () => new Date(),
  fetchImpl = globalThis.fetch
}: GiteeInspectionOptions): Promise<GiteeProviderSnapshotV2> {
  requireMappingString(workItemId, "workItemId");
  const validatedEvidence =
    requireEvidenceKeys(requiredEvidence);
  const version = resolveSnapshotVersion({
    snapshotVersion,
    managedFields
  });

  if (version.schemaVersion !== 2) {
    throw inspectionError(
      "PROVIDER_MAPPING_INVALID",
      "Gitee inspection supports only ProviderSnapshot version 2."
    );
  }

  const configuration =
    await readProjectConfiguration({ cwd });
  const { repository } =
    getGiteeCoordinates(configuration);
  const adapter = createGiteeAdapter({
    fetchImpl,
    now
  });

  return adapter.ports["work-item.read"]({
    repository,
    issueReference,
    mapping: {
      workItemId,
      requiredEvidence:
        normalizeV2RequiredEvidence(validatedEvidence),
      managedFields: [...version.managedFields]
    }
  });
}

export async function inspectFeishuHealthProvider({
  cwd,
  configuration: providedConfiguration,
  environment = process.env,
  now = () => new Date(),
  fetchImpl = globalThis.fetch
}: FeishuHealthInspectionOptions): Promise<FeishuHealthResult> {
  const configuration =
    providedConfiguration ??
    (await readProjectConfiguration({ cwd }));
  const resource = getFeishuReadCoordinates(
    configuration,
    environment
  );
  const credentials =
    requireFeishuCredentials(environment);
  const adapter = createFeishuAdapter({
    ...credentials,
    fetchImpl,
    now
  });

  return adapter.ports["provider.health"]({
    appToken: resource.appToken,
    tableId: resource.tableId,
    recordId: resource.recordId,
    fieldMapping: resource.fieldMapping
  });
}

export async function inspectFeishuProvider({
  cwd,
  configuration: providedConfiguration,
  environment = process.env,
  workItemId,
  requiredEvidence,
  snapshotVersion,
  managedFields,
  now = () => new Date(),
  fetchImpl = globalThis.fetch
}: FeishuInspectionOptions): Promise<FeishuProviderSnapshotV2> {
  requireMappingString(workItemId, "workItemId");
  const validatedEvidence =
    requireEvidenceKeys(requiredEvidence);
  const version = resolveSnapshotVersion({
    snapshotVersion,
    managedFields
  });
  if (version.schemaVersion !== 2) {
    throw inspectionError(
      "PROVIDER_MAPPING_INVALID",
      "Feishu inspection supports only ProviderSnapshot version 2."
    );
  }

  const configuration =
    providedConfiguration ??
    (await readProjectConfiguration({ cwd }));
  const resource = getFeishuReadCoordinates(
    configuration,
    environment
  );
  const credentials =
    requireFeishuCredentials(environment);
  const adapter = createFeishuAdapter({
    ...credentials,
    fetchImpl,
    now
  });

  return adapter.ports["work-item.read"]({
    appToken: resource.appToken,
    tableId: resource.tableId,
    recordId: resource.recordId,
    fieldMapping: resource.fieldMapping,
    mapping: {
      workItemId,
      requiredEvidence:
        normalizeV2RequiredEvidence(validatedEvidence),
      managedFields: [...version.managedFields]
    }
  });
}

export function inspectGitHubIssueProvider(
  options: GitHubIssueInspectionV1Options
): Promise<GitHubIssueSnapshotV1>;
export function inspectGitHubIssueProvider(
  options: GitHubIssueInspectionV2Options
): Promise<GitHubIssueSnapshotV2>;
export function inspectGitHubIssueProvider(
  options: GitHubIssueInspectionOptions
): Promise<GitHubIssueSnapshotV1 | GitHubIssueSnapshotV2>;
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
}: GitHubIssueInspectionOptions): Promise<
  GitHubIssueSnapshotV1 | GitHubIssueSnapshotV2
> {
  requireMappingString(workItemId, "workItemId");
  const validatedEvidence =
    requireEvidenceKeys(requiredEvidence);
  const version = resolveSnapshotVersion({
    snapshotVersion,
    managedFields
  });
  const configuration =
    await readProjectConfiguration({ cwd });
  const { repository } =
    getGitHubCoordinates(configuration);
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
    requiredEvidence: validatedEvidence
  });

  if (version.schemaVersion === 2) {
    const normalizedEvidence =
      normalizeV2RequiredEvidence(validatedEvidence);
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

  return createGitHubIssueSnapshotV1({
    repository,
    issue,
    workItemId,
    requiredEvidence: validatedEvidence,
    event
  });
}

export function inspectGitHubProvider(
  options: GitHubDeliveryInspectionV1Options
): Promise<GitHubDeliverySnapshotV1>;
export function inspectGitHubProvider(
  options: GitHubDeliveryInspectionV2Options
): Promise<GitHubDeliverySnapshotV2>;
export function inspectGitHubProvider(
  options: GitHubDeliveryInspectionOptions
): Promise<
  GitHubDeliverySnapshotV1 | GitHubDeliverySnapshotV2
>;
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
}: GitHubDeliveryInspectionOptions): Promise<
  GitHubDeliverySnapshotV1 | GitHubDeliverySnapshotV2
> {
  requireMappingString(workItemId, "workItemId");
  requireMappingString(attemptId, "attemptId");
  requireMappingString(criterionKey, "criterionKey");
  const version = resolveSnapshotVersion({
    snapshotVersion,
    managedFields
  });
  const configuration =
    await readProjectConfiguration({ cwd });
  const { repository } =
    getGitHubCoordinates(configuration);
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
  const requiredEvidence = [criterionKey];
  const issueEvent = normalizeGitHubIssue(facts.issue, {
    workItemId,
    requiredEvidence
  });
  const artifactEvent =
    normalizeGitHubPullRequest(facts.pullRequest, {
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
    const issueFact =
      normalizeGitHubIssueFact(facts.issue, {
        workItemId,
        requiredEvidence
      });
    const artifactFact =
      normalizeGitHubPullRequestFact(
        facts.pullRequest,
        {
          workItemId,
          attemptId
        }
      );
    const artifactId =
      artifactFact.candidateEvent.payload.artifactId;
    const evidenceFact =
      normalizeGitHubCheckFact(facts.check, {
        workItemId,
        attemptId,
        artifactId,
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
        artifactId,
        artifactRevision:
          artifactFact.observed.headRevision,
        criterionKey
      },
      capturedAt: captureTimestamp(now),
      facts: [issueFact, artifactFact, evidenceFact]
    };
  }

  return createGitHubDeliverySnapshotV1({
    repository,
    facts,
    workItemId,
    attemptId,
    criterionKey,
    issueEvent,
    artifactEvent,
    evidenceEvent
  });
}

export function inspectLinearProvider(
  options: LinearInspectionV1Options
): Promise<LinearSnapshotV1>;
export function inspectLinearProvider(
  options: LinearInspectionV2Options
): Promise<LinearSnapshotV2>;
export function inspectLinearProvider(
  options: LinearInspectionOptions
): Promise<LinearSnapshotV1 | LinearSnapshotV2>;
export async function inspectLinearProvider({
  cwd,
  configuration: providedConfiguration,
  issueReference,
  workItemId,
  requiredEvidence,
  snapshotVersion,
  managedFields,
  now = () => new Date(),
  environment = process.env,
  fetchImpl = globalThis.fetch
}: LinearInspectionOptions): Promise<
  LinearSnapshotV1 | LinearSnapshotV2
> {
  requireMappingString(workItemId, "workItemId");
  const validatedEvidence =
    requireEvidenceKeys(requiredEvidence);
  const version = resolveSnapshotVersion({
    snapshotVersion,
    managedFields
  });
  const configuration =
    providedConfiguration ??
    (await readProjectConfiguration({ cwd }));
  const { workspace, team, project } =
    getLinearProjectCoordinates(configuration);
  const facts = await readLinearIssue({
    workspace,
    team,
    project,
    issueReference,
    apiKey: environment.LINEAR_API_KEY,
    accessToken: environment.LINEAR_ACCESS_TOKEN,
    fetchImpl
  });
  const event = normalizeLinearIssue(facts.issue, {
    workItemId,
    requiredEvidence: validatedEvidence
  });

  if (version.schemaVersion === 2) {
    const normalizedEvidence =
      normalizeV2RequiredEvidence(validatedEvidence);
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

  return createLinearSnapshotV1({
    workspace,
    configuredTeam: team,
    facts,
    workItemId,
    requiredEvidence: validatedEvidence,
    event
  });
}

function createGitHubIssueSnapshotV1({
  repository,
  issue,
  workItemId,
  requiredEvidence,
  event
}: {
  repository: string;
  issue: GitHubIssue;
  workItemId: string;
  requiredEvidence: string[];
  event: WorkItemCreatedEvent;
}): GitHubIssueSnapshotV1 {
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

function createGitHubDeliverySnapshotV1({
  repository,
  facts,
  workItemId,
  attemptId,
  criterionKey,
  issueEvent,
  artifactEvent,
  evidenceEvent
}: {
  repository: string;
  facts: {
    issue: GitHubIssue;
    pullRequest: GitHubPullRequest;
    check: GitHubCheck;
  };
  workItemId: string;
  attemptId: string;
  criterionKey: string;
  issueEvent: WorkItemCreatedEvent;
  artifactEvent: ArtifactLinkedEvent;
  evidenceEvent: EvidenceRecordedEvent;
}): GitHubDeliverySnapshotV1 {
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

function createLinearSnapshotV1({
  workspace,
  configuredTeam,
  facts,
  workItemId,
  requiredEvidence,
  event
}: {
  workspace: string;
  configuredTeam: string;
  facts: {
    organization: LinearOrganization;
    team: LinearTeam;
    issue: LinearIssue;
  };
  workItemId: string;
  requiredEvidence: string[];
  event: WorkItemCreatedEvent;
}): LinearSnapshotV1 {
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
        configured: configuredTeam,
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

function firstCredential(
  ...values: Array<string | undefined>
): string | undefined {
  return values.find(
    (value): value is string =>
      typeof value === "string" &&
      value.trim().length > 0
  );
}

function requireFeishuCredentials(
  environment: InspectionEnvironment
): {
  readonly appId: string;
  readonly appSecret: string;
} {
  const appId = normalizeFeishuCredential(
    environment.TASKSEAL_FEISHU_APP_ID
  );
  const appSecret = normalizeFeishuCredential(
    environment.TASKSEAL_FEISHU_APP_SECRET
  );
  return { appId, appSecret };
}

function normalizeFeishuCredential(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    value !== value.trim() ||
    !value.isWellFormed() ||
    /[\r\n]/.test(value)
  ) {
    throw inspectionError(
      "FEISHU_CONFIG_INVALID",
      "Feishu application credentials are missing or invalid."
    );
  }
  return value;
}

function requireMappingString(
  value: unknown,
  field: string
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0
  ) {
    throw inspectionError(
      "PROVIDER_MAPPING_INVALID",
      `Provider mapping ${field} must be a non-empty string.`
    );
  }

  return value;
}

function requireEvidenceKeys(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (item: unknown) =>
        typeof item !== "string" ||
        item.trim().length === 0
    )
  ) {
    throw inspectionError(
      "PROVIDER_MAPPING_INVALID",
      "Provider requiredEvidence must be a non-empty string array."
    );
  }

  return value;
}

function resolveSnapshotVersion({
  snapshotVersion,
  managedFields
}: {
  snapshotVersion: unknown;
  managedFields: unknown;
}): ResolvedSnapshotVersion {
  const schemaVersion = snapshotVersion ?? 1;

  if (
    schemaVersion === 1 &&
    managedFields === undefined
  ) {
    return {
      schemaVersion: 1
    };
  }

  if (
    schemaVersion === 2 &&
    isManagedFields(managedFields)
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

function isManagedFields(
  value: unknown
): value is ManagedField[] {
  return (
    Array.isArray(value) &&
    value.length <= 1 &&
    new Set(value).size === value.length &&
    value.every(
      (field: unknown): field is ManagedField =>
        field === "title"
    )
  );
}

function normalizeV2RequiredEvidence(
  value: string[]
): string[] {
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

function githubRepositoryScope(
  repository: string
): ProviderSnapshotScope {
  const match = /^([^/]+)\/([^/]+)$/.exec(repository);
  const owner = match?.[1];
  const name = match?.[2];

  if (!owner || !name) {
    throw inspectionError(
      "PROVIDER_MAPPING_INVALID",
      "GitHub repository scope must be an owner/repository coordinate."
    );
  }

  return {
    kind: "repository",
    key:
      `github:repository:${owner.toLowerCase()}/` +
      name.toLowerCase()
  };
}

function linearTeamScope({
  organizationId,
  teamId
}: {
  organizationId: string;
  teamId: string;
}): ProviderSnapshotScope {
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

function normalizeUuid(
  value: unknown,
  field: string
): string {
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

function captureTimestamp(now: () => unknown): string {
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

class ProviderInspectionError extends Error {
  readonly code: InspectionErrorCode;

  constructor(
    code: InspectionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ProviderInspectionError";
    this.code = code;
  }
}

function inspectionError(
  code: InspectionErrorCode,
  message: string
): ProviderInspectionError {
  return new ProviderInspectionError(code, message);
}
