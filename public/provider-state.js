const PROVIDERS = {
  github: {
    label: "GitHub",
    shortLabel: "GH"
  },
  linear: {
    label: "Linear",
    shortLabel: "LI"
  },
  gitee: {
    label: "Gitee",
    shortLabel: "GE"
  }
};

const STATUSES = {
  configured: {
    label: "Configured",
    icon: "○",
    tone: "neutral"
  },
  scope_mismatch: {
    label: "Scope mismatch",
    icon: "!",
    tone: "danger"
  },
  sample_missing: {
    label: "Sample missing",
    icon: "?",
    tone: "warning"
  },
  snapshot_ready: {
    label: "Snapshot ready",
    icon: "✓",
    tone: "ready"
  },
  sync_failed: {
    label: "Sync failed",
    icon: "×",
    tone: "danger"
  }
};

const OPERATIONS = {
  configuration: "Configuration",
  inspection: "Inspection",
  "snapshot.preview": "Snapshot preview",
  "snapshot.import": "Snapshot import"
};

const OBSERVATION_KEYS = [
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
];

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_KEY_LENGTH = 512;
const MAX_ID_LENGTH = 256;
const MAX_TIME_LENGTH = 64;
const MAX_EVIDENCE_KEY_LENGTH = 128;
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
const ATTENTION_STATUSES = new Set([
  "scope_mismatch",
  "sample_missing",
  "sync_failed"
]);

export function createProviderPanelModel(projection) {
  if (
    !isPlainRecord(projection) ||
    !hasExactKeys(projection, [
      "schemaVersion",
      "revision",
      "providers"
    ]) ||
    projection.schemaVersion !== 1 ||
    !isDigest(projection.revision) ||
    !Array.isArray(projection.providers) ||
    projection.providers.length > 64
  ) {
    throw invalidProjection();
  }

  const identities = new Set();
  const cards = projection.providers.map((observation) => {
    const card = projectProviderCard(observation);
    const identity =
      `${card.provider}\u0000` +
      card.configuredTarget.key;

    if (identities.has(identity)) {
      throw invalidProjection();
    }
    identities.add(identity);
    return card;
  });
  const latest = [...cards].sort(
    (left, right) =>
      Date.parse(right.observedAt) -
        Date.parse(left.observedAt) ||
      left.providerLabel.localeCompare(
        right.providerLabel
      ) ||
      left.configuredTarget.key.localeCompare(
        right.configuredTarget.key
      )
  );

  return {
    revision: projection.revision,
    cards,
    latest,
    summary: {
      total: cards.length,
      ready: cards.filter(
        (card) => card.status === "snapshot_ready"
      ).length,
      attention: cards.filter(
        (card) =>
          ATTENTION_STATUSES.has(card.status) ||
          card.missingEvidence.length > 0
      ).length
    }
  };
}

export function createProviderPanelState() {
  return {
    phase: "idle",
    model: null,
    message: null
  };
}

export function createProviderContentRenderKey(state) {
  if (!isPlainRecord(state)) {
    throw new TypeError(
      "Provider panel state is invalid."
    );
  }

  const model = state.model;
  const view =
    model && isProviderPanelModel(model)
      ? model.cards.length === 0
        ? "empty"
        : "observations"
      : state.phase === "error"
        ? "error"
        : "loading";
  const revision =
    model && isProviderPanelModel(model)
      ? model.revision
      : "none";

  return `${view}:${revision}`;
}

export function shouldPollProviders(mode, phase) {
  return (
    mode === "persistent" &&
    phase !== "loading" &&
    phase !== "refreshing"
  );
}

export function reduceProviderPanelState(state, action) {
  if (
    !isPlainRecord(state) ||
    !isPlainRecord(action) ||
    typeof action.type !== "string"
  ) {
    throw new TypeError(
      "Provider panel transition is invalid."
    );
  }

  if (action.type === "request") {
    return {
      phase: state.model ? "refreshing" : "loading",
      model: state.model ?? null,
      message: null
    };
  }

  if (
    action.type === "success" &&
    isProviderPanelModel(action.model)
  ) {
    return {
      phase:
        action.model.cards.length === 0
          ? "empty"
          : "ready",
      model: action.model,
      message: null
    };
  }

  if (action.type === "failure") {
    return {
      phase: state.model ? "stale" : "error",
      model: state.model ?? null,
      message: state.model
        ? "Refresh failed. Showing the last known Provider observations."
        : "Provider observations are unavailable."
    };
  }

  throw new TypeError(
    "Provider panel transition is invalid."
  );
}

export function createProviderAccessibleSummary(state) {
  if (state.phase === "idle" || state.phase === "loading") {
    return "Loading Provider observations.";
  }
  if (state.phase === "error") {
    return "Provider observations are unavailable.";
  }
  if (state.phase === "empty") {
    return "No Provider observations are configured.";
  }

  const model = state.model;
  if (!isProviderPanelModel(model)) {
    return "Provider observations are unavailable.";
  }

  const stalePrefix =
    state.phase === "stale"
      ? "Provider refresh failed; showing the last known observations. "
      : "";
  const cardSummary = model.cards
    .map((card) => {
      const missing =
        card.missingEvidence.length > 0
          ? `, missing evidence: ${card.missingEvidence.join(", ")}`
          : "";
      return (
        `${card.providerLabel} is ${card.statusLabel}` +
        missing
      );
    })
    .join(". ");

  return (
    stalePrefix +
    `${model.summary.total} Provider observations; ` +
    `${model.summary.ready} snapshot ready; ` +
    `${model.summary.attention} need attention. ` +
    `${cardSummary}.`
  );
}

function projectProviderCard(observation) {
  if (
    !isPlainRecord(observation) ||
    !hasExactKeys(observation, OBSERVATION_KEYS) ||
    observation.schemaVersion !== 1 ||
    !isDigest(observation.observationId) ||
    !Object.hasOwn(PROVIDERS, observation.provider) ||
    !Object.hasOwn(OPERATIONS, observation.operation) ||
    !Object.hasOwn(STATUSES, observation.status) ||
    !isTarget(
      observation.configuredTarget,
      observation.provider
    ) ||
    !isScopeOrNull(
      observation.observedScope,
      observation.provider
    ) ||
    !isCanonicalTimestamp(observation.startedAt) ||
    !isCanonicalTimestamp(observation.observedAt) ||
    Date.parse(observation.observedAt) <
      Date.parse(observation.startedAt) ||
    Date.parse(observation.startedAt) > Date.now() ||
    Date.parse(observation.observedAt) > Date.now() ||
    !isSourceRevisions(observation.sourceRevisions) ||
    !isNullableDigest(observation.snapshotDigest) ||
    !isNullableDigest(observation.mappingDigest) ||
    !isNullableDigest(observation.planDigest) ||
    !isStringArray(
      observation.missingEvidence,
      64,
      MAX_EVIDENCE_KEY_LENGTH
    ) ||
    !isSafeDiagnosticCodeOrNull(
      observation.diagnosticCode
    ) ||
    !(
      observation.resolution === null ||
      observation.resolution === "committed" ||
      observation.resolution === "idempotent"
    ) ||
    !hasValidObservationSemantics(observation)
  ) {
    throw invalidProjection();
  }

  const providerView = PROVIDERS[observation.provider];
  const statusView = STATUSES[observation.status];

  return {
    observationId: observation.observationId,
    provider: observation.provider,
    providerLabel: providerView.label,
    providerShortLabel: providerView.shortLabel,
    configuredTarget: {
      kind: observation.configuredTarget.kind,
      key: observation.configuredTarget.key
    },
    observedScope:
      observation.observedScope === null
        ? null
        : {
            kind: observation.observedScope.kind,
            key: observation.observedScope.key,
            parentKey:
              observation.observedScope.parentKey
          },
    operation: observation.operation,
    operationLabel: OPERATIONS[observation.operation],
    status: observation.status,
    statusLabel: statusView.label,
    statusIcon: statusView.icon,
    tone: statusView.tone,
    startedAt: observation.startedAt,
    observedAt: observation.observedAt,
    sourceRevisionCount:
      observation.sourceRevisions.length,
    snapshotDigest: observation.snapshotDigest,
    mappingDigest: observation.mappingDigest,
    planDigest: observation.planDigest,
    missingEvidence: [...observation.missingEvidence],
    diagnosticCode: observation.diagnosticCode,
    resolution: observation.resolution,
    approvalLabel: "Operation journal not connected"
  };
}

function isProviderPanelModel(value) {
  return (
    isPlainRecord(value) &&
    Array.isArray(value.cards) &&
    Array.isArray(value.latest) &&
    isPlainRecord(value.summary)
  );
}

function isTarget(value, provider) {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["kind", "key"]) &&
    (value.kind === "provider" ||
      value.kind === "repository" ||
      value.kind === "team") &&
    isTrimmedString(value.key, MAX_KEY_LENGTH) &&
    value.key.startsWith(`${provider}:`)
  );
}

function isScopeOrNull(value, provider) {
  return (
    value === null ||
    (isPlainRecord(value) &&
      hasExactKeys(value, [
        "kind",
        "key",
        "parentKey"
      ]) &&
      (value.kind === "repository" ||
        value.kind === "team") &&
      isTrimmedString(value.key, MAX_KEY_LENGTH) &&
      value.key.startsWith(`${provider}:`) &&
      (value.parentKey === null ||
        (isTrimmedString(
          value.parentKey,
          MAX_KEY_LENGTH
        ) &&
          value.parentKey.startsWith(`${provider}:`))))
  );
}

function isSourceRevisions(value) {
  if (
    !(
      Array.isArray(value) &&
      value.length <= 100 &&
      value.every(
        (revision) =>
          isPlainRecord(revision) &&
          hasExactKeys(revision, [
            "objectType",
            "id",
            "occurredAt",
            "contentDigest"
          ]) &&
          (revision.objectType === "issue" ||
            revision.objectType === "pull_request" ||
            revision.objectType === "check") &&
          isTrimmedString(revision.id, MAX_ID_LENGTH) &&
          isCanonicalTimestamp(revision.occurredAt) &&
          isDigest(revision.contentDigest)
      )
    )
  ) {
    return false;
  }

  const identities = value.map(
    (revision) =>
      `${revision.objectType}\u0000${revision.id}`
  );
  return new Set(identities).size === identities.length;
}

function isStringArray(value, maximum, maximumItemLength) {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every(
      (item) =>
        isTrimmedString(item, maximumItemLength)
    ) &&
    new Set(value).size === value.length
  );
}

function isNullableDigest(value) {
  return value === null || isDigest(value);
}

function isDigest(value) {
  return (
    typeof value === "string" &&
    DIGEST_PATTERN.test(value)
  );
}

function isSafeDiagnosticCodeOrNull(value) {
  return (
    value === null ||
    (typeof value === "string" &&
      SAFE_DIAGNOSTIC_CODES.has(value))
  );
}

function isCanonicalTimestamp(value) {
  if (
    typeof value !== "string" ||
    value.length > MAX_TIME_LENGTH
  ) {
    return false;
  }

  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === value
  );
}

function isTrimmedString(value, maximumLength) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    [...value].length <= maximumLength
  );
}

function hasValidObservationSemantics(observation) {
  const statusNeedsDiagnostic =
    observation.status === "scope_mismatch" ||
    observation.status === "sample_missing" ||
    observation.status === "sync_failed";
  const statusForbidsDiagnostic =
    observation.status === "configured" ||
    observation.status === "snapshot_ready";

  return (
    (!statusNeedsDiagnostic ||
      observation.diagnosticCode !== null) &&
    (!statusForbidsDiagnostic ||
      observation.diagnosticCode === null) &&
    (observation.status !== "snapshot_ready" ||
      (observation.snapshotDigest !== null &&
        observation.mappingDigest !== null)) &&
    (observation.resolution === null ||
      observation.operation === "snapshot.import")
  );
}

function isPlainRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every(
      (key, index) => key === sortedExpected[index]
    )
  );
}

function invalidProjection() {
  return new TypeError(
    "Provider observation projection is invalid."
  );
}
