import {
  assertJsonWithinLimits,
  digestCanonicalJson
} from "../lib/canonical-json.ts";
import type {
  ProviderName,
  ProviderObjectType
} from "../lib/provider-snapshot.ts";

export type ProviderObservationOperation =
  | "configuration"
  | "inspection"
  | "snapshot.preview"
  | "snapshot.import";

export type ProviderObservationStatus =
  | "configured"
  | "scope_mismatch"
  | "sample_missing"
  | "snapshot_ready"
  | "sync_failed";

export interface ProviderObservationTarget {
  kind: "provider" | "repository" | "team";
  key: string;
}

export interface ProviderObservationScope {
  kind: "repository" | "team";
  key: string;
  parentKey: string | null;
}

export interface ProviderObservationSourceRevision {
  objectType: ProviderObjectType;
  id: string;
  occurredAt: string;
  contentDigest: string;
}

export interface ProviderObservationInput {
  operation: ProviderObservationOperation;
  provider: ProviderName;
  configuredTarget: ProviderObservationTarget;
  observedScope: ProviderObservationScope | null;
  status: ProviderObservationStatus;
  startedAt: string;
  observedAt: string;
  sourceRevisions: ProviderObservationSourceRevision[];
  snapshotDigest: string | null;
  mappingDigest: string | null;
  planDigest: string | null;
  missingEvidence: string[];
  diagnosticCode: string | null;
  resolution: "committed" | "idempotent" | null;
}

export interface ProviderObservation
  extends ProviderObservationInput {
  schemaVersion: 1;
  observationId: string;
}

export interface ProviderObservationFile {
  schemaVersion: 1;
  observations: ProviderObservation[];
}

export interface ProviderObservationProjection {
  schemaVersion: 1;
  revision: string;
  providers: ProviderObservation[];
}

export interface ProviderObservationStoragePort {
  load(): Promise<unknown>;
  replace(value: ProviderObservationFile): Promise<void>;
}

export interface ProviderObservationQueryPort {
  list(): Promise<ProviderObservationProjection>;
}

export interface ProviderObservationCommandPort {
  record(
    observation: ProviderObservationInput
  ): Promise<ProviderObservationRecordResult>;
  ensure(
    observation: ProviderObservationInput
  ): Promise<ProviderObservationRecordResult>;
}

export interface ProviderObservationRecordResult {
  resolution: "committed" | "idempotent" | "ignored-stale";
  observationId: string;
}

interface ProjectProviderFailureOptions {
  operation: ProviderObservationOperation;
  provider: ProviderName;
  configuredTarget: ProviderObservationTarget;
  startedAt: string;
  observedAt: string;
  error: unknown;
  observedScope?: ProviderObservationScope | null | undefined;
  snapshotDigest?: string | null | undefined;
  mappingDigest?: string | null | undefined;
  planDigest?: string | null | undefined;
  missingEvidence?: string[] | undefined;
}

interface ProjectProviderSnapshotOptions {
  operation: "inspection" | "snapshot.preview";
  configuredTarget: ProviderObservationTarget;
  startedAt: string;
  observedAt: string;
  snapshot: unknown;
  snapshotDigest?: string | null | undefined;
  mappingDigest?: string | null | undefined;
  planDigest?: string | null | undefined;
  verifiedLinearScopeBinding?: boolean | undefined;
}

const MAX_OBSERVATIONS = 64;
const MAX_SOURCE_REVISIONS = 100;
const MAX_MISSING_EVIDENCE = 64;
const MAX_KEY_LENGTH = 512;
const MAX_ID_LENGTH = 256;
const MAX_TIME_LENGTH = 64;
const MAX_EVIDENCE_KEY_LENGTH = 128;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const OBSERVATION_INPUT_KEYS = [
  "operation",
  "provider",
  "configuredTarget",
  "observedScope",
  "status",
  "startedAt",
  "observedAt",
  "sourceRevisions",
  "snapshotDigest",
  "mappingDigest",
  "planDigest",
  "missingEvidence",
  "diagnosticCode",
  "resolution"
] as const;

const OPERATIONS = new Set<ProviderObservationOperation>([
  "configuration",
  "inspection",
  "snapshot.preview",
  "snapshot.import"
]);
const PROVIDERS = new Set<ProviderName>([
  "github",
  "linear",
  "gitee"
]);
const STATUSES = new Set<ProviderObservationStatus>([
  "configured",
  "scope_mismatch",
  "sample_missing",
  "snapshot_ready",
  "sync_failed"
]);
const OBJECT_TYPES = new Set<ProviderObjectType>([
  "issue",
  "pull_request",
  "check",
  "pull_request_review"
]);
const SAFE_DIAGNOSTIC_CODES = new Set([
  "PROVIDER_OPERATION_FAILED",
  "PROVIDER_OBSERVATION_SCOPE_MISMATCH",
  "PROJECT_CONFIG_INVALID",
  "GITHUB_CONFIG_INVALID",
  "GITEE_CONFIG_INVALID",
  "LINEAR_CONFIG_INVALID",
  "PROVIDER_MAPPING_INVALID",
  "GITHUB_AUTH_FAILED",
  "GITHUB_CHECK_AMBIGUOUS",
  "GITHUB_CHECK_INCOMPLETE",
  "GITHUB_CHECK_NOT_FOUND",
  "GITHUB_CHECK_REVISION_MISMATCH",
  "GITHUB_FETCH_INVALID",
  "GITHUB_FORBIDDEN",
  "GITHUB_HTTP_ERROR",
  "GITHUB_INPUT_INVALID",
  "GITHUB_ISSUE_IS_PULL_REQUEST",
  "GITHUB_NOT_FOUND",
  "GITHUB_PAGINATION_LIMIT",
  "GITHUB_PAGINATION_LOOP",
  "GITHUB_PAGINATION_ORIGIN_INVALID",
  "GITHUB_PAGINATION_URL_INVALID",
  "GITHUB_RATE_LIMITED",
  "GITHUB_REPOSITORY_INVALID",
  "GITHUB_REQUEST_FAILED",
  "GITHUB_RESPONSE_INVALID",
  "GITHUB_TIMEOUT_INVALID",
  "GITHUB_TOKEN_INVALID",
  "LINEAR_AUTH_CONFLICT",
  "LINEAR_AUTH_FAILED",
  "LINEAR_AUTH_INVALID",
  "LINEAR_AUTH_MISSING",
  "LINEAR_FETCH_INVALID",
  "LINEAR_FORBIDDEN",
  "LINEAR_GRAPHQL_ERROR",
  "LINEAR_HTTP_ERROR",
  "LINEAR_INPUT_INVALID",
  "LINEAR_ISSUE_NOT_FOUND",
  "LINEAR_ISSUE_REFERENCE_INVALID",
  "LINEAR_ISSUE_TEAM_MISMATCH",
  "LINEAR_PAGINATION_INVALID",
  "LINEAR_PAGINATION_LIMIT",
  "LINEAR_RATE_LIMITED",
  "LINEAR_REQUEST_FAILED",
  "LINEAR_RESPONSE_INVALID",
  "LINEAR_TEAM_AMBIGUOUS",
  "LINEAR_TEAM_NOT_FOUND",
  "LINEAR_TIMEOUT_INVALID",
  "LINEAR_WORKSPACE_MISMATCH",
  "GITEE_AUTH_REQUIRED",
  "GITEE_CLOCK_INVALID",
  "GITEE_FETCH_INVALID",
  "GITEE_FORBIDDEN",
  "GITEE_HTTP_ERROR",
  "GITEE_ISSUE_INVALID",
  "GITEE_ISSUE_REFERENCE_INVALID",
  "GITEE_ISSUE_REFERENCE_MISMATCH",
  "GITEE_ISSUE_URL_INVALID",
  "GITEE_MAPPING_INVALID",
  "GITEE_NOT_FOUND",
  "GITEE_RATE_LIMITED",
  "GITEE_REPOSITORY_INVALID",
  "GITEE_REQUEST_FAILED",
  "GITEE_RESPONSE_INVALID",
  "GITEE_RESPONSE_TOO_LARGE",
  "GITEE_SCOPE_MISMATCH",
  "GITEE_TIMEOUT_INVALID",
  "SNAPSHOT_INVALID",
  "SNAPSHOT_LIMIT_EXCEEDED",
  "SNAPSHOT_PROVIDER_NOT_IMPORTABLE",
  "SNAPSHOT_SCHEMA_NOT_IMPORTABLE",
  "SNAPSHOT_SCOPE_MISMATCH",
  "IMPORT_ACTION_IDENTITY_INVALID",
  "IMPORT_ACTOR_INVALID",
  "IMPORT_APPLY_FORBIDDEN",
  "IMPORT_COMMIT_OUTCOME_UNKNOWN",
  "IMPORT_EVENT_IDENTITY_INVALID",
  "IMPORT_PLAN_BLOCKED",
  "IMPORT_PLAN_LIMIT_EXCEEDED",
  "IMPORT_PLAN_STALE",
  "IMPORT_PLAN_TAMPERED",
  "IMPORT_POLICY_INVALID",
  "IMPORT_POLICY_STALE",
  "JOURNAL_ATOMIC_COMMIT_UNSUPPORTED",
  "JOURNAL_COMMIT_OUTCOME_UNKNOWN",
  "JOURNAL_CORRUPT",
  "JOURNAL_WRITE_FAILED",
  "SERVICE_REOPEN_REQUIRED"
]);
const SCOPE_MISMATCH_CODES = new Set([
  "PROVIDER_OBSERVATION_SCOPE_MISMATCH",
  "LINEAR_WORKSPACE_MISMATCH",
  "LINEAR_ISSUE_TEAM_MISMATCH",
  "GITEE_SCOPE_MISMATCH",
  "GITEE_ISSUE_REFERENCE_MISMATCH",
  "GITEE_ISSUE_URL_INVALID",
  "SNAPSHOT_SCOPE_MISMATCH"
]);
const SAMPLE_MISSING_CODES = new Set([
  "GITHUB_NOT_FOUND",
  "GITHUB_CHECK_NOT_FOUND",
  "LINEAR_ISSUE_NOT_FOUND",
  "GITEE_NOT_FOUND"
]);

export class ProviderObservationReadModel
  implements
    ProviderObservationQueryPort,
    ProviderObservationCommandPort
{
  static async open({
    storage
  }: {
    storage: ProviderObservationStoragePort;
  }): Promise<ProviderObservationReadModel> {
    const model = new ProviderObservationReadModel(storage);
    await model.loadCurrent();
    return model;
  }

  readonly #storage: ProviderObservationStoragePort;
  #writeQueue: Promise<void> = Promise.resolve();
  #reopenRequired = false;

  private constructor(storage: ProviderObservationStoragePort) {
    this.#storage = storage;
  }

  async list(): Promise<ProviderObservationProjection> {
    await this.#writeQueue;
    this.assertOpen();
    const file = await this.loadCurrent();
    const providers = structuredClone(file.observations);

    return {
      schemaVersion: 1,
      revision: digestCanonicalJson(providers),
      providers
    };
  }

  record(
    observation: ProviderObservationInput
  ): Promise<ProviderObservationRecordResult> {
    return this.enqueueWrite(() =>
      this.recordNow(observation, false)
    );
  }

  ensure(
    observation: ProviderObservationInput
  ): Promise<ProviderObservationRecordResult> {
    return this.enqueueWrite(() =>
      this.recordNow(observation, true)
    );
  }

  private enqueueWrite<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    const result = this.#writeQueue.then(
      operation,
      operation
    );
    this.#writeQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async recordNow(
    input: ProviderObservationInput,
    onlyIfMissing: boolean
  ): Promise<ProviderObservationRecordResult> {
    this.assertOpen();
    const observation = normalizeObservationInput(input);
    const current = await this.loadCurrent();
    const identity = observationIdentity(observation);
    const existing = current.observations.find(
      (candidate) =>
        observationIdentity(candidate) === identity
    );

    if (existing && onlyIfMissing) {
      return {
        resolution: "idempotent",
        observationId: existing.observationId
      };
    }

    if (existing) {
      const freshness = compareTimestamps(
        observation.startedAt,
        existing.startedAt
      );

      if (freshness < 0) {
        return {
          resolution: "ignored-stale",
          observationId: existing.observationId
        };
      }

      if (freshness === 0) {
        if (
          observation.observationId ===
          existing.observationId
        ) {
          return {
            resolution: "idempotent",
            observationId: existing.observationId
          };
        }

        throw new ProviderObservationError(
          "PROVIDER_OBSERVATION_VERSION_CONFLICT",
          "Provider observation freshness is ambiguous."
        );
      }
    }

    const observations = current.observations.filter(
      (candidate) =>
        observationIdentity(candidate) !== identity
    );
    observations.push(observation);

    if (observations.length > MAX_OBSERVATIONS) {
      throw new ProviderObservationError(
        "PROVIDER_OBSERVATION_LIMIT_EXCEEDED",
        "Provider observation target limit was exceeded."
      );
    }

    observations.sort(compareObservations);
    const next: ProviderObservationFile = {
      schemaVersion: 1,
      observations
    };

    try {
      await this.#storage.replace(next);
    } catch (error) {
      if (
        hasErrorCode(
          error,
          "PROVIDER_OBSERVATION_COMMIT_OUTCOME_UNKNOWN"
        )
      ) {
        this.#reopenRequired = true;
        throw new ProviderObservationError(
          "PROVIDER_OBSERVATION_REOPEN_REQUIRED",
          "Provider observations must be reopened after an unknown commit outcome.",
          { cause: error }
        );
      }

      if (error instanceof ProviderObservationError) {
        throw error;
      }

      throw new ProviderObservationError(
        "PROVIDER_OBSERVATION_WRITE_FAILED",
        "Provider observation could not be persisted.",
        { cause: error }
      );
    }

    return {
      resolution: "committed",
      observationId: observation.observationId
    };
  }

  private async loadCurrent(): Promise<ProviderObservationFile> {
    let value: unknown;

    try {
      value = await this.#storage.load();
    } catch (error) {
      if (error instanceof ProviderObservationError) {
        throw error;
      }

      throw new ProviderObservationError(
        "PROVIDER_OBSERVATION_READ_FAILED",
        "Provider observations could not be read.",
        { cause: error }
      );
    }

    try {
      return normalizeProviderObservationFile(value);
    } catch (error) {
      throw new ProviderObservationError(
        "PROVIDER_OBSERVATION_STORE_CORRUPT",
        "Provider observation storage is corrupt.",
        { cause: error }
      );
    }
  }

  private assertOpen(): void {
    if (this.#reopenRequired) {
      throw new ProviderObservationError(
        "PROVIDER_OBSERVATION_REOPEN_REQUIRED",
        "Provider observations must be reopened."
      );
    }
  }
}

export function projectProviderSnapshot({
  operation,
  configuredTarget,
  startedAt,
  observedAt,
  snapshot,
  snapshotDigest,
  mappingDigest,
  planDigest = null,
  verifiedLinearScopeBinding = false
}: ProjectProviderSnapshotOptions): ProviderObservationInput {
  assertJsonWithinLimits(snapshot, {
    maxDepth: 16,
    maxBytes: 1024 * 1024,
    maxArrayLength: 100,
    maxObjectKeys: 64
  });

  if (!isPlainDataRecord(snapshot)) {
    throw observationInvalid();
  }

  const provider = normalizeProvider(snapshot.provider);
  const schemaVersion = snapshot.schemaVersion;
  const mapping = snapshot.mapping;

  if (
    (schemaVersion !== 1 && schemaVersion !== 2) ||
    !isPlainDataRecord(mapping)
  ) {
    throw observationInvalid();
  }

  const requiredEvidence = normalizeEvidenceKeys(
    mapping.requiredEvidence ?? readV1Criterion(mapping)
  );
  const observedEvidence = new Set<string>();
  const sourceRevisions: ProviderObservationSourceRevision[] =
    [];
  let observedScope: ProviderObservationScope;

  if (schemaVersion === 2) {
    observedScope = normalizeProjectedScope(
      snapshot.scope,
      provider
    );
    if (
      !Array.isArray(snapshot.facts) ||
      snapshot.facts.length === 0 ||
      snapshot.facts.length > MAX_SOURCE_REVISIONS
    ) {
      throw observationInvalid();
    }

    for (const fact of snapshot.facts) {
      if (
        !isPlainDataRecord(fact) ||
        !isPlainDataRecord(fact.sourceObject) ||
        !isPlainDataRecord(fact.revision)
      ) {
        throw observationInvalid();
      }

      sourceRevisions.push(
        normalizeSourceRevision({
          objectType: fact.sourceObject.objectType,
          id: fact.revision.id,
          occurredAt: fact.revision.occurredAt,
          contentDigest: fact.revision.contentDigest
        })
      );
      collectEvidenceKey(
        fact.candidateEvent,
        observedEvidence
      );
    }
  } else {
    observedScope = normalizeV1Scope(
      snapshot.scope,
      provider
    );
    if (Array.isArray(snapshot.events)) {
      for (const event of snapshot.events) {
        collectEvidenceKey(event, observedEvidence);
      }
    }
  }

  if (
    !providerObservationScopeMatchesTarget({
      provider,
      configuredTarget,
      observedScope,
      boundScope:
        verifiedLinearScopeBinding &&
        provider === "linear"
          ? observedScope
          : undefined
    }) ||
    (schemaVersion === 1 &&
      provider === "linear" &&
      !linearV1ScopeMatchesConfiguredTarget(
        snapshot.scope,
        configuredTarget
      ))
  ) {
    return projectProviderFailure({
      operation,
      provider,
      configuredTarget,
      observedScope,
      startedAt,
      observedAt,
      error: {
        code: "PROVIDER_OBSERVATION_SCOPE_MISMATCH"
      }
    });
  }

  sourceRevisions.sort(compareSourceRevisions);
  const input: ProviderObservationInput = {
    operation,
    provider,
    configuredTarget,
    observedScope,
    status: "snapshot_ready",
    startedAt,
    observedAt,
    sourceRevisions,
    snapshotDigest:
      snapshotDigest ?? digestCanonicalJson(snapshot),
    mappingDigest:
      mappingDigest ?? digestCanonicalJson(mapping),
    planDigest,
    missingEvidence: requiredEvidence.filter(
      (key) => !observedEvidence.has(key)
    ),
    diagnosticCode: null,
    resolution: null
  };

  return normalizeObservationFields(input);
}

export function projectProviderFailure({
  operation,
  provider,
  configuredTarget,
  startedAt,
  observedAt,
  error,
  observedScope = null,
  snapshotDigest = null,
  mappingDigest = null,
  planDigest = null,
  missingEvidence = []
}: ProjectProviderFailureOptions): ProviderObservationInput {
  const diagnosticCode = normalizeDiagnosticCode(
    readErrorCode(error)
  );
  const status = SCOPE_MISMATCH_CODES.has(diagnosticCode)
    ? "scope_mismatch"
    : SAMPLE_MISSING_CODES.has(diagnosticCode)
      ? "sample_missing"
      : "sync_failed";

  return normalizeObservationFields({
    operation,
    provider,
    configuredTarget,
    observedScope,
    status,
    startedAt,
    observedAt,
    sourceRevisions: [],
    snapshotDigest,
    mappingDigest,
    planDigest,
    missingEvidence,
    diagnosticCode,
    resolution: null
  });
}

export function providerObservationScopeMatchesTarget({
  provider,
  configuredTarget,
  observedScope,
  boundScope
}: {
  provider: ProviderName;
  configuredTarget: ProviderObservationTarget;
  observedScope: ProviderObservationScope;
  boundScope?: ProviderObservationScope | undefined;
}): boolean {
  const normalizedProvider = normalizeProvider(provider);
  const target = normalizeTarget(
    configuredTarget,
    normalizedProvider
  );
  const scope = normalizeScope(
    observedScope,
    normalizedProvider
  );

  if (
    target.kind === "provider" ||
    target.kind !== scope.kind
  ) {
    return false;
  }

  if (target.key === scope.key) {
    return true;
  }

  const verifiedScope =
    boundScope === undefined
      ? null
      : normalizeScope(boundScope, normalizedProvider);
  return (
    normalizedProvider === "linear" &&
    target.kind === "team" &&
    target.key.startsWith("linear:team-ref:") &&
    /^linear:team:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      scope.key
    ) &&
    typeof scope.parentKey === "string" &&
    /^linear:organization:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      scope.parentKey
    ) &&
    verifiedScope !== null &&
    scopesEqual(scope, verifiedScope)
  );
}

function scopesEqual(
  left: ProviderObservationScope,
  right: ProviderObservationScope
): boolean {
  return (
    left.kind === right.kind &&
    left.key === right.key &&
    left.parentKey === right.parentKey
  );
}

export function normalizeProviderObservationFile(
  value: unknown
): ProviderObservationFile {
  if (
    !isPlainDataRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "observations"
    ]) ||
    value.schemaVersion !== 1
  ) {
    throw observationInvalid();
  }

  const observationValues = readPlainDataArray(
    value.observations,
    MAX_OBSERVATIONS
  );
  const observations = observationValues.map(
    normalizePersistedObservation
  );
  const identities = new Set<string>();

  for (const observation of observations) {
    const identity = observationIdentity(observation);
    if (identities.has(identity)) {
      throw observationInvalid();
    }
    identities.add(identity);
  }

  observations.sort(compareObservations);
  return {
    schemaVersion: 1,
    observations
  };
}

function normalizePersistedObservation(
  value: unknown
): ProviderObservation {
  if (
    !isPlainDataRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "observationId",
      "operation",
      "provider",
      "configuredTarget",
      "observedScope",
      "status",
      "startedAt",
      "observedAt",
      "sourceRevisions",
      "snapshotDigest",
      "mappingDigest",
      "planDigest",
      "missingEvidence",
      "diagnosticCode",
      "resolution"
    ]) ||
    value.schemaVersion !== 1
  ) {
    throw observationInvalid();
  }

  const normalized = normalizeObservationInput({
    operation: value.operation,
    provider: value.provider,
    configuredTarget: value.configuredTarget,
    observedScope: value.observedScope,
    status: value.status,
    startedAt: value.startedAt,
    observedAt: value.observedAt,
    sourceRevisions: value.sourceRevisions,
    snapshotDigest: value.snapshotDigest,
    mappingDigest: value.mappingDigest,
    planDigest: value.planDigest,
    missingEvidence: value.missingEvidence,
    diagnosticCode: value.diagnosticCode,
    resolution: value.resolution
  });
  if (value.observationId !== normalized.observationId) {
    throw observationInvalid();
  }
  return normalized;
}

function normalizeObservationInput(
  value: unknown
): ProviderObservation {
  if (
    !isPlainDataRecord(value) ||
    !hasExactKeys(value, OBSERVATION_INPUT_KEYS)
  ) {
    throw observationInvalid();
  }

  const fields = normalizeObservationFields({
    operation: value.operation as ProviderObservationOperation,
    provider: value.provider as ProviderName,
    configuredTarget:
      value.configuredTarget as ProviderObservationTarget,
    observedScope:
      value.observedScope as ProviderObservationScope | null,
    status: value.status as ProviderObservationStatus,
    startedAt: value.startedAt as string,
    observedAt: value.observedAt as string,
    sourceRevisions:
      value.sourceRevisions as ProviderObservationSourceRevision[],
    snapshotDigest: value.snapshotDigest as string | null,
    mappingDigest: value.mappingDigest as string | null,
    planDigest: value.planDigest as string | null,
    missingEvidence: value.missingEvidence as string[],
    diagnosticCode: value.diagnosticCode as string | null,
    resolution:
      value.resolution as "committed" | "idempotent" | null
  });
  const observationId = digestCanonicalJson(fields);

  return {
    schemaVersion: 1,
    observationId,
    ...fields
  };
}

function normalizeObservationFields(
  value: ProviderObservationInput
): ProviderObservationInput {
  const operation = normalizeOperation(value.operation);
  const provider = normalizeProvider(value.provider);
  const configuredTarget = normalizeTarget(
    value.configuredTarget,
    provider
  );
  const observedScope =
    value.observedScope === null
      ? null
      : normalizeScope(value.observedScope, provider);
  const status = normalizeStatus(value.status);
  const startedAt = normalizeTimestamp(value.startedAt);
  const observedAt = normalizeTimestamp(value.observedAt);

  if (compareTimestamps(observedAt, startedAt) < 0) {
    throw observationInvalid();
  }

  const sourceRevisionValues = readPlainDataArray(
    value.sourceRevisions,
    MAX_SOURCE_REVISIONS
  );
  const sourceRevisions = sourceRevisionValues.map(
    normalizeSourceRevision
  );
  sourceRevisions.sort(compareSourceRevisions);
  const sourceKeys = new Set(
    sourceRevisions.map(
      (revision) =>
        `${revision.objectType}\u0000${revision.id}`
    )
  );
  if (sourceKeys.size !== sourceRevisions.length) {
    throw observationInvalid();
  }

  const snapshotDigest = normalizeNullableDigest(
    value.snapshotDigest
  );
  const mappingDigest = normalizeNullableDigest(
    value.mappingDigest
  );
  const planDigest = normalizeNullableDigest(
    value.planDigest
  );
  const missingEvidence = normalizeEvidenceKeys(
    value.missingEvidence
  );
  const diagnosticCode =
    value.diagnosticCode === null
      ? null
      : requireSafeDiagnosticCode(value.diagnosticCode);
  const resolution = normalizeResolution(value.resolution);

  if (
    (status === "configured" ||
      status === "snapshot_ready") &&
    diagnosticCode !== null
  ) {
    throw observationInvalid();
  }

  if (
    (status === "scope_mismatch" ||
      status === "sample_missing" ||
      status === "sync_failed") &&
    diagnosticCode === null
  ) {
    throw observationInvalid();
  }

  if (
    status === "snapshot_ready" &&
    (snapshotDigest === null || mappingDigest === null)
  ) {
    throw observationInvalid();
  }

  if (
    resolution !== null &&
    operation !== "snapshot.import"
  ) {
    throw observationInvalid();
  }

  return {
    operation,
    provider,
    configuredTarget,
    observedScope,
    status,
    startedAt,
    observedAt,
    sourceRevisions,
    snapshotDigest,
    mappingDigest,
    planDigest,
    missingEvidence,
    diagnosticCode,
    resolution
  };
}

function normalizeOperation(
  value: unknown
): ProviderObservationOperation {
  if (
    typeof value !== "string" ||
    !OPERATIONS.has(value as ProviderObservationOperation)
  ) {
    throw observationInvalid();
  }
  return value as ProviderObservationOperation;
}

function normalizeProvider(value: unknown): ProviderName {
  if (
    typeof value !== "string" ||
    !PROVIDERS.has(value as ProviderName)
  ) {
    throw observationInvalid();
  }
  return value as ProviderName;
}

function normalizeStatus(
  value: unknown
): ProviderObservationStatus {
  if (
    typeof value !== "string" ||
    !STATUSES.has(value as ProviderObservationStatus)
  ) {
    throw observationInvalid();
  }
  return value as ProviderObservationStatus;
}

function normalizeTarget(
  value: unknown,
  provider: ProviderName
): ProviderObservationTarget {
  if (
    !isPlainDataRecord(value) ||
    !hasExactKeys(value, ["kind", "key"]) ||
    (value.kind !== "provider" &&
      value.kind !== "repository" &&
      value.kind !== "team")
  ) {
    throw observationInvalid();
  }

  return {
    kind: value.kind,
    key: normalizeProviderKey(value.key, provider)
  };
}

function normalizeScope(
  value: unknown,
  provider: ProviderName
): ProviderObservationScope {
  if (
    !isPlainDataRecord(value) ||
    !hasExactKeys(value, ["kind", "key", "parentKey"]) ||
    (value.kind !== "repository" && value.kind !== "team")
  ) {
    throw observationInvalid();
  }

  return {
    kind: value.kind,
    key: normalizeProviderKey(value.key, provider),
    parentKey:
      value.parentKey === null
        ? null
        : normalizeProviderKey(value.parentKey, provider)
  };
}

function normalizeProjectedScope(
  value: unknown,
  provider: ProviderName
): ProviderObservationScope {
  if (
    !isPlainDataRecord(value) ||
    (value.kind !== "repository" && value.kind !== "team") ||
    typeof value.key !== "string" ||
    (value.parentKey !== undefined &&
      typeof value.parentKey !== "string")
  ) {
    throw observationInvalid();
  }

  const allowedKeys =
    value.parentKey === undefined
      ? ["kind", "key"]
      : ["kind", "key", "parentKey"];
  if (!hasExactKeys(value, allowedKeys)) {
    throw observationInvalid();
  }

  return {
    kind: value.kind,
    key: normalizeProviderKey(value.key, provider),
    parentKey:
      value.parentKey === undefined
        ? null
        : normalizeProviderKey(value.parentKey, provider)
  };
}

function normalizeV1Scope(
  value: unknown,
  provider: ProviderName
): ProviderObservationScope {
  if (
    provider === "github" &&
    isPlainDataRecord(value) &&
    hasExactKeys(value, ["repository"]) &&
    typeof value.repository === "string"
  ) {
    const repository = normalizeString(
      value.repository,
      MAX_KEY_LENGTH
    ).toLowerCase();
    if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
      throw observationInvalid();
    }

    return {
      kind: "repository",
      key: normalizeProviderKey(
        `github:repository:${repository}`,
        provider
      ),
      parentKey: null
    };
  }

  if (
    provider === "linear" &&
    isPlainDataRecord(value) &&
    isPlainDataRecord(value.workspace) &&
    isPlainDataRecord(value.team) &&
    typeof value.workspace.id === "string" &&
    typeof value.team.id === "string"
  ) {
    return {
      kind: "team",
      key: normalizeProviderKey(
        `linear:team:${value.team.id.toLowerCase()}`,
        provider
      ),
      parentKey: normalizeProviderKey(
        `linear:organization:${value.workspace.id.toLowerCase()}`,
        provider
      )
    };
  }

  throw observationInvalid();
}

function linearV1ScopeMatchesConfiguredTarget(
  value: unknown,
  configuredTarget: ProviderObservationTarget
): boolean {
  if (
    !isPlainDataRecord(value) ||
    !isPlainDataRecord(value.workspace) ||
    !isPlainDataRecord(value.team) ||
    typeof value.workspace.configured !== "string" ||
    typeof value.team.configured !== "string"
  ) {
    return false;
  }

  const workspace = encodeURIComponent(
    value.workspace.configured.trim().toLowerCase()
  );
  const team = encodeURIComponent(
    value.team.configured.trim().toLowerCase()
  );
  return (
    configuredTarget.kind === "team" &&
    configuredTarget.key ===
      `linear:team-ref:${workspace}/${team}`
  );
}

function normalizeSourceRevision(
  value: unknown
): ProviderObservationSourceRevision {
  if (
    !isPlainDataRecord(value) ||
    !hasExactKeys(value, [
      "objectType",
      "id",
      "occurredAt",
      "contentDigest"
    ]) ||
    typeof value.objectType !== "string" ||
    !OBJECT_TYPES.has(
      value.objectType as ProviderObjectType
    )
  ) {
    throw observationInvalid();
  }

  return {
    objectType: value.objectType as ProviderObjectType,
    id: normalizeString(value.id, MAX_ID_LENGTH),
    occurredAt: normalizeTimestamp(value.occurredAt),
    contentDigest: normalizeDigest(value.contentDigest)
  };
}

function normalizeEvidenceKeys(value: unknown): string[] {
  const values = readPlainDataArray(
    value,
    MAX_MISSING_EVIDENCE
  );
  const normalized = values.map((item) =>
    normalizeString(item, MAX_EVIDENCE_KEY_LENGTH)
  );
  if (new Set(normalized).size !== normalized.length) {
    throw observationInvalid();
  }
  return normalized.sort();
}

function normalizeResolution(
  value: unknown
): "committed" | "idempotent" | null {
  if (
    value !== null &&
    value !== "committed" &&
    value !== "idempotent"
  ) {
    throw observationInvalid();
  }
  return value;
}

function normalizeNullableDigest(
  value: unknown
): string | null {
  return value === null ? null : normalizeDigest(value);
}

function normalizeDigest(value: unknown): string {
  if (
    typeof value !== "string" ||
    !DIGEST_PATTERN.test(value)
  ) {
    throw observationInvalid();
  }
  return value;
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value !== "string") {
    throw observationInvalid();
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value
    );

  if (
    !match ||
    value.length > MAX_TIME_LENGTH ||
    !isValidTimestampParts(match)
  ) {
    throw observationInvalid();
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw observationInvalid();
  }

  return new Date(timestamp).toISOString();
}

function isValidTimestampParts(
  match: RegExpExecArray
): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8];
  const offset =
    zone && zone !== "Z"
      ? /^([+-])(\d{2}):(\d{2})$/.exec(zone)
      : null;
  const offsetHour = offset ? Number(offset[2]) : 0;
  const offsetMinute = offset ? Number(offset[3]) : 0;

  return (
    year >= 0 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59 &&
    offsetHour >= 0 &&
    offsetHour <= 23 &&
    offsetMinute >= 0 &&
    offsetMinute <= 59
  );
}

function daysInMonth(
  year: number,
  month: number
): number {
  if (month === 2) {
    return year % 4 === 0 &&
      (year % 100 !== 0 || year % 400 === 0)
      ? 29
      : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function readPlainDataArray(
  value: unknown,
  maximumLength: number
): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximumLength
  ) {
    throw observationInvalid();
  }

  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== value.length + 1 ||
    ownKeys.at(-1) !== "length" ||
    ownKeys
      .slice(0, -1)
      .some((key, index) => key !== String(index))
  ) {
    throw observationInvalid();
  }

  const descriptors =
    Object.getOwnPropertyDescriptors(value);
  const result: unknown[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw observationInvalid();
    }
    result.push(descriptor.value);
  }

  return result;
}

function normalizeProviderKey(
  value: unknown,
  provider: ProviderName
): string {
  const key = normalizeString(value, MAX_KEY_LENGTH);
  if (!key.startsWith(`${provider}:`)) {
    throw observationInvalid();
  }
  return key;
}

function normalizeString(
  value: unknown,
  maximum: number
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    [...value].length > maximum
  ) {
    throw observationInvalid();
  }
  return value;
}

function normalizeDiagnosticCode(value: unknown): string {
  return typeof value === "string" &&
    SAFE_DIAGNOSTIC_CODES.has(value)
    ? value
    : "PROVIDER_OPERATION_FAILED";
}

function requireSafeDiagnosticCode(value: unknown): string {
  if (
    typeof value !== "string" ||
    !SAFE_DIAGNOSTIC_CODES.has(value)
  ) {
    throw observationInvalid();
  }
  return value;
}

function readErrorCode(error: unknown): unknown {
  if (
    error === null ||
    (typeof error !== "object" &&
      typeof error !== "function")
  ) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    error,
    "code"
  );
  return descriptor && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function readV1Criterion(
  mapping: Record<string, unknown>
): unknown {
  return typeof mapping.criterionKey === "string"
    ? [mapping.criterionKey]
    : [];
}

function collectEvidenceKey(
  value: unknown,
  target: Set<string>
): void {
  if (
    !isPlainDataRecord(value) ||
    value.type !== "evidence.recorded" ||
    !isPlainDataRecord(value.payload) ||
    typeof value.payload.criterionKey !== "string"
  ) {
    return;
  }
  target.add(value.payload.criterionKey);
}

function observationIdentity(
  observation: Pick<
    ProviderObservation,
    "provider" | "configuredTarget"
  >
): string {
  return (
    `${observation.provider}\u0000` +
    observation.configuredTarget.key
  );
}

function compareObservations(
  left: ProviderObservation,
  right: ProviderObservation
): number {
  return (
    left.provider.localeCompare(right.provider) ||
    left.configuredTarget.key.localeCompare(
      right.configuredTarget.key
    )
  );
}

function compareSourceRevisions(
  left: ProviderObservationSourceRevision,
  right: ProviderObservationSourceRevision
): number {
  return (
    left.objectType.localeCompare(right.objectType) ||
    left.id.localeCompare(right.id)
  );
}

function compareTimestamps(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isPlainDataRecord(
  value: unknown
): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    return false;
  }

  return Object.values(
    Object.getOwnPropertyDescriptors(value)
  ).every(
    (descriptor) =>
      "value" in descriptor &&
      descriptor.enumerable === true
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return readErrorCode(error) === code;
}

function observationInvalid(): ProviderObservationError {
  return new ProviderObservationError(
    "PROVIDER_OBSERVATION_INVALID",
    "Provider observation is invalid."
  );
}

export type ProviderObservationErrorCode =
  | "PROVIDER_OBSERVATION_INVALID"
  | "PROVIDER_OBSERVATION_LIMIT_EXCEEDED"
  | "PROVIDER_OBSERVATION_VERSION_CONFLICT"
  | "PROVIDER_OBSERVATION_STORE_CORRUPT"
  | "PROVIDER_OBSERVATION_READ_FAILED"
  | "PROVIDER_OBSERVATION_WRITE_FAILED"
  | "PROVIDER_OBSERVATION_COMMIT_OUTCOME_UNKNOWN"
  | "PROVIDER_OBSERVATION_REOPEN_REQUIRED";

export class ProviderObservationError extends Error {
  readonly code: ProviderObservationErrorCode;

  constructor(
    code: ProviderObservationErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ProviderObservationError";
    this.code = code;
  }
}
