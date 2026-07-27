import {
  canonicalizeGiteeRepository,
  isGiteeIssueReference,
  readGiteeIssue,
  readGiteeRepository
} from "./gitee-read-client.ts";
import type {
  GiteeFetchLike,
  GiteeIssueReadResult
} from "./gitee-read-client.ts";
import type {
  AdapterManifestV1,
  ProviderAdapterV1
} from "./provider-adapter.ts";
import {
  normalizeProviderAdapterV1
} from "./provider-adapter.ts";
import {
  digestProviderFactContent
} from "../lib/provider-snapshot.ts";
import type {
  ProviderIssueFact,
  ProviderSnapshotMapping,
  ProviderSnapshotScope,
  ProviderSnapshotV2
} from "../lib/provider-snapshot.ts";
import type {
  ManagedField,
  RichExternalLink
} from "../domain/workflow.ts";

export const GITEE_ADAPTER_MANIFEST = {
  schemaVersion: 1,
  apiVersion: "taskseal.provider/v1",
  providerId: "gitee",
  capabilities: [
    "provider.health",
    "work-item.read"
  ],
  configuration: {
    schemaVersion: 1,
    fields: [
      {
        key: "repository",
        type: "repository-coordinate",
        required: true,
        secret: false
      }
    ]
  },
  credential: {
    mode: "none"
  },
  scopes: [
    {
      kind: "repository",
      objectTypes: ["issue"]
    }
  ]
} as const satisfies AdapterManifestV1;

export interface GiteeHealthRequest {
  repository: string;
}

export interface GiteeHealthResult {
  provider: "gitee";
  status: "ready";
  checkedAt: string;
  scope: ProviderSnapshotScope & {
    kind: "repository";
  };
}

export interface GiteeWorkItemMapping {
  workItemId: string;
  requiredEvidence: string[];
  managedFields: ManagedField[];
}

export interface GiteeWorkItemReadRequest {
  repository: string;
  issueReference: string;
  mapping: GiteeWorkItemMapping;
}

export interface GiteeProviderSnapshotV2
  extends Omit<
    ProviderSnapshotV2,
    "provider" | "facts"
  > {
  provider: "gitee";
  facts: ProviderIssueFact[];
}

interface CreateGiteeAdapterOptions {
  fetchImpl?: GiteeFetchLike;
  timeoutMs?: number;
  now?: () => unknown;
}

interface NormalizedGiteeIssue {
  number: string;
  title: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  repository: string;
}

const MAX_MAPPING_ID_LENGTH = 200;
const MAX_MAPPING_ITEMS = 32;

export function createGiteeAdapter({
  fetchImpl = globalThis.fetch,
  timeoutMs,
  now = () => new Date()
}: CreateGiteeAdapterOptions = {}): ProviderAdapterV1<
  GiteeHealthRequest,
  GiteeHealthResult,
  GiteeWorkItemReadRequest,
  GiteeProviderSnapshotV2
> {
  const adapter: ProviderAdapterV1<
    GiteeHealthRequest,
    GiteeHealthResult,
    GiteeWorkItemReadRequest,
    GiteeProviderSnapshotV2
  > = {
    manifest: GITEE_ADAPTER_MANIFEST,
    ports: {
      "provider.health": async ({ repository }) => {
        const result = await readGiteeRepository({
          repository,
          fetchImpl,
          ...(timeoutMs === undefined ? {} : { timeoutMs })
        });
        return {
          provider: "gitee",
          status: "ready",
          checkedAt: captureTimestamp(now),
          scope: createRepositoryScope(result.repository)
        };
      },
      "work-item.read": async ({
        repository,
        issueReference,
        mapping
      }) => {
        const normalizedMapping =
          normalizeGiteeMapping(mapping);
        const issue = await readGiteeIssue({
          repository,
          issueReference,
          fetchImpl,
          ...(timeoutMs === undefined ? {} : { timeoutMs })
        });
        const fact = normalizeGiteeIssueFact(
          issue,
          normalizedMapping
        );
        const scope =
          createRepositoryScope(issue.repository);
        const snapshotMapping: ProviderSnapshotMapping = {
          workItemId: normalizedMapping.workItemId,
          requiredEvidence: [
            ...normalizedMapping.requiredEvidence
          ],
          managedFields: [
            ...normalizedMapping.managedFields
          ]
        };

        return {
          schemaVersion: 2,
          mode: "read-only",
          provider: "gitee",
          scope,
          mapping: snapshotMapping,
          capturedAt: captureTimestamp(now),
          facts: [fact]
        };
      }
    }
  };

  normalizeProviderAdapterV1(adapter);
  return adapter;
}

export function normalizeGiteeIssueFact(
  issue: unknown,
  mapping?: unknown
): ProviderIssueFact {
  const normalizedIssue = normalizeGiteeIssue(issue);
  const normalizedMapping = normalizeGiteeMapping(mapping);
  const externalId =
    `${normalizedIssue.repository}#${normalizedIssue.number}`;
  const providerObjectKey =
    `gitee:issue:${externalId}`;
  const scopeRef = createRepositoryScope(
    normalizedIssue.repository
  );
  const sourceObject: ProviderIssueFact["sourceObject"] = {
    providerObjectKey,
    provider: "gitee",
    objectType: "issue",
    externalId,
    url: normalizedIssue.htmlUrl
  };
  const observed = {
    title: normalizedIssue.title,
    createdAt: normalizedIssue.createdAt
  };
  const contentDigest = digestProviderFactContent({
    sourceObject,
    observed
  });
  const externalLink: RichExternalLink = {
    providerObjectKey,
    provider: "gitee",
    objectType: "issue",
    externalId,
    scopeRef,
    url: normalizedIssue.htmlUrl,
    managedFields: [
      ...normalizedMapping.managedFields
    ],
    lastObservation: {
      revisionId: normalizedIssue.updatedAt,
      occurredAt: normalizedIssue.updatedAt,
      contentDigest,
      title: normalizedIssue.title
    }
  };

  return {
    sourceObject,
    revision: {
      id: normalizedIssue.updatedAt,
      occurredAt: normalizedIssue.updatedAt,
      contentDigest
    },
    observed,
    candidateEvent: {
      eventId:
        `gitee:issue:${externalId}:created`,
      workItemId: normalizedMapping.workItemId,
      type: "work_item.created",
      occurredAt: normalizedIssue.createdAt,
      payload: {
        title: normalizedIssue.title,
        requiredEvidence: [
          ...normalizedMapping.requiredEvidence
        ],
        externalLink
      }
    }
  };
}

function normalizeGiteeIssue(
  value: unknown
): NormalizedGiteeIssue {
  if (!isRecord(value)) {
    throw invalidIssue();
  }

  requirePositiveInteger(value.id);
  const number = value.number;
  const title = value.title;
  const htmlUrl = value.htmlUrl;
  const createdAt = value.createdAt;
  const updatedAt = value.updatedAt;
  const repository = value.repository;

  if (
    !isGiteeIssueReference(number) ||
    !isBoundedString(title, 10_000) ||
    !isTimestamp(createdAt) ||
    !isTimestamp(updatedAt) ||
    typeof repository !== "string"
  ) {
    throw invalidIssue();
  }

  let canonicalRepository: string;
  try {
    canonicalRepository =
      canonicalizeGiteeRepository(repository);
  } catch {
    throw invalidIssue();
  }

  const normalizedUrl = validateIssueUrl({
    value: htmlUrl,
    repository: canonicalRepository,
    issueReference: number
  });

  return {
    number,
    title,
    htmlUrl: normalizedUrl,
    createdAt,
    updatedAt,
    repository: canonicalRepository
  };
}

function normalizeGiteeMapping(
  value: unknown
): GiteeWorkItemMapping {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "workItemId",
      "requiredEvidence",
      "managedFields"
    ]) ||
    !isBoundedString(
      value.workItemId,
      MAX_MAPPING_ID_LENGTH
    )
  ) {
    throw invalidMapping();
  }

  const requiredEvidence = normalizeUniqueStrings(
    value.requiredEvidence,
    {
      allowEmpty: false,
      allowed: null
    }
  );
  const managedFields = normalizeUniqueStrings(
    value.managedFields,
    {
      allowEmpty: true,
      allowed: new Set(["title"])
    }
  );

  if (!managedFields.every(isManagedField)) {
    throw invalidMapping();
  }

  return {
    workItemId: value.workItemId,
    requiredEvidence,
    managedFields
  };
}

function normalizeUniqueStrings(
  value: unknown,
  {
    allowEmpty,
    allowed
  }: {
    allowEmpty: boolean;
    allowed: ReadonlySet<string> | null;
  }
): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.length > MAX_MAPPING_ITEMS ||
    new Set(value).size !== value.length ||
    value.some(
      (item) =>
        !isBoundedString(item, MAX_MAPPING_ID_LENGTH) ||
        (allowed !== null && !allowed.has(item))
    )
  ) {
    throw invalidMapping();
  }

  return [...value].sort();
}

function createRepositoryScope(
  repository: string
): ProviderSnapshotScope & {
  kind: "repository";
} {
  return {
    kind: "repository",
    key: `gitee:repository:${repository}`
  };
}

function captureTimestamp(now: () => unknown): string {
  const value = now();
  const timestamp =
    value instanceof Date ? value.toISOString() : value;

  if (
    typeof timestamp !== "string" ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    throw new GiteeConnectorError(
      "GITEE_CLOCK_INVALID",
      "Gitee adapter clock must return a valid timestamp."
    );
  }

  return timestamp;
}

function validateIssueUrl({
  value,
  repository,
  issueReference
}: {
  value: unknown;
  repository: string;
  issueReference: string;
}): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2048
  ) {
    throw invalidIssue();
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidIssue();
  }

  const [owner, name] = repository.split("/");
  const parts = url.pathname.split("/");

  if (
    url.protocol !== "https:" ||
    url.hostname !== "gitee.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    parts.length !== 5 ||
    parts[0] !== "" ||
    parts[1]?.toLowerCase() !== owner ||
    parts[2]?.toLowerCase() !== name ||
    parts[3] !== "issues" ||
    parts[4] !== issueReference
  ) {
    throw invalidIssue();
  }

  return url.href;
}

function isManagedField(
  value: string
): value is ManagedField {
  return value === "title";
}

function requirePositiveInteger(
  value: unknown
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw invalidIssue();
  }
}

function isTimestamp(value: unknown): value is string {
  return (
    isBoundedString(value, 64) &&
    Number.isFinite(Date.parse(value))
  );
}

function isBoundedString(
  value: unknown,
  maximumLength: number
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value === value.trim() &&
    [...value].length <= maximumLength
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const actualKeys = Reflect.ownKeys(value);
  return (
    actualKeys.length === keys.length &&
    actualKeys.every(
      (key) =>
        typeof key === "string" &&
        keys.includes(key)
    )
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

function invalidIssue(): GiteeConnectorError {
  return new GiteeConnectorError(
    "GITEE_ISSUE_INVALID",
    "Gitee Issue does not match the normalized read contract."
  );
}

function invalidMapping(): GiteeConnectorError {
  return new GiteeConnectorError(
    "GITEE_MAPPING_INVALID",
    "Gitee WorkItem mapping must be explicit and bounded."
  );
}

export class GiteeConnectorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GiteeConnectorError";
    this.code = code;
  }
}
