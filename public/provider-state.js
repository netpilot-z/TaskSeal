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

const OPERATION_STATUSES = {
  approval_required: {
    label: "Approval required",
    icon: "◇",
    tone: "warning",
    priority: 2
  },
  approved: {
    label: "Approved",
    icon: "✓",
    tone: "neutral",
    priority: 5
  },
  rejected: {
    label: "Rejected",
    icon: "×",
    tone: "neutral",
    priority: 8
  },
  submitting: {
    label: "Submitting",
    icon: "→",
    tone: "active",
    priority: 4
  },
  created: {
    label: "Created",
    icon: "✓",
    tone: "ready",
    priority: 7
  },
  transitioned: {
    label: "Transitioned",
    icon: "✓",
    tone: "ready",
    priority: 7
  },
  outcome_unknown: {
    label: "Outcome unknown",
    icon: "!",
    tone: "danger",
    priority: 0
  },
  reconciling: {
    label: "Reconciling",
    icon: "↻",
    tone: "active",
    priority: 4
  },
  reconciliation_absent: {
    label: "Not found; decision required",
    icon: "?",
    tone: "warning",
    priority: 1
  },
  reconciled: {
    label: "Reconciled",
    icon: "✓",
    tone: "ready",
    priority: 7
  },
  sync_failed: {
    label: "Sync failed",
    icon: "×",
    tone: "danger",
    priority: 3
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
const CONTROLLED_OPERATION_KEYS = [
  "schemaVersion",
  "provider",
  "operationKey",
  "configuredTarget",
  "version",
  "status",
  "approval",
  "diagnosticCode",
  "createdAt",
  "updatedAt"
];
const TRANSITION_OPERATION_KEYS = [
  "schemaVersion",
  "provider",
  "action",
  "workItemId",
  "acceptanceDecisionId",
  "operationKey",
  "configuredTarget",
  "version",
  "status",
  "approval",
  "diagnosticCode",
  "createdAt",
  "updatedAt"
];

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
  "SERVICE_REOPEN_REQUIRED",
  "LINEAR_WRITE_NOT_DISPATCHED",
  "LINEAR_WRITE_OUTCOME_UNKNOWN",
  "LINEAR_RECONCILIATION_FAILED",
  "LINEAR_RECONCILIATION_AMBIGUOUS"
]);
const ATTENTION_STATUSES = new Set([
  "scope_mismatch",
  "sample_missing",
  "sync_failed"
]);
const CONTROLLED_DIAGNOSTIC_CODES = new Set([
  "LINEAR_WRITE_NOT_DISPATCHED",
  "LINEAR_WRITE_OUTCOME_UNKNOWN",
  "LINEAR_RECONCILIATION_FAILED",
  "LINEAR_RECONCILIATION_AMBIGUOUS"
]);
const CREATE_OPERATION_STATUSES =
  new Set([
    "approval_required",
    "approved",
    "rejected",
    "submitting",
    "created",
    "outcome_unknown",
    "reconciling",
    "reconciliation_absent",
    "reconciled",
    "sync_failed"
  ]);
const TRANSITION_OPERATION_STATUSES =
  new Set([
    "approval_required",
    "approved",
    "rejected",
    "submitting",
    "transitioned",
    "outcome_unknown",
    "reconciling",
    "reconciliation_absent",
    "reconciled",
    "sync_failed"
  ]);

export function createProviderPanelModel(projection) {
  if (!isPlainRecord(projection)) {
    throw invalidProjection();
  }

  let operationJournalConnected;
  let observationRevision;
  let operationRevision;
  let providerValues;
  let operationValues;

  if (
    projection.schemaVersion === 1 &&
    hasExactKeys(projection, [
      "schemaVersion",
      "revision",
      "providers"
    ])
  ) {
    operationJournalConnected = false;
    observationRevision = projection.revision;
    operationRevision = null;
    providerValues = projection.providers;
    operationValues = [];
  } else if (
    projection.schemaVersion === 2 &&
    hasExactKeys(projection, [
      "schemaVersion",
      "revision",
      "observationRevision",
      "operationRevision",
      "providers",
      "operations"
    ])
  ) {
    operationJournalConnected = true;
    observationRevision =
      projection.observationRevision;
    operationRevision =
      projection.operationRevision;
    providerValues = projection.providers;
    operationValues = projection.operations;
  } else {
    throw invalidProjection();
  }

  if (
    !isDigest(projection.revision) ||
    !isDigest(observationRevision) ||
    (operationJournalConnected
      ? !isDigest(operationRevision)
      : operationRevision !== null) ||
    !Array.isArray(providerValues) ||
    providerValues.length > 64 ||
    !Array.isArray(operationValues) ||
    operationValues.length > 512
  ) {
    throw invalidProjection();
  }

  const operationIdentities = new Set();
  const acceptanceIdentities = new Set();
  const operations = operationValues.map(
    (operation) => {
      const projected =
        projectControlledOperation(operation);
      if (
        operationIdentities.has(
          projected.operationKey
        )
      ) {
        throw invalidProjection();
      }
      operationIdentities.add(
        projected.operationKey
      );
      if (
        projected.action ===
        "work-item.transition"
      ) {
        const acceptanceIdentity =
          `${projected.workItemId}\u0000` +
          projected.acceptanceDecisionId;
        if (
          acceptanceIdentities.has(
            acceptanceIdentity
          )
        ) {
          throw invalidProjection();
        }
        acceptanceIdentities.add(
          acceptanceIdentity
        );
      }
      return projected;
    }
  );
  operations.sort(compareOperationRecency);

  const identities = new Set();
  const cards = providerValues.map((observation) => {
    const base = projectProviderCard(observation);
    const identity =
      providerTargetIdentity(base);

    if (identities.has(identity)) {
      throw invalidProjection();
    }
    identities.add(identity);
    const controlledOperations =
      operations.filter(
        (operation) =>
          operation.action !==
            "work-item.transition" &&
          providerTargetIdentity(operation) ===
          identity
      );
    const rollup = [...controlledOperations].sort(
      compareOperationAttention
    )[0];
    return {
      ...base,
      controlledOperations,
      controlledWrite: rollup ?? null,
      approvalLabel:
        operationJournalConnected
          ? rollup?.statusLabel ??
            "No controlled writes"
          : "Operation journal not connected"
    };
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
    sourceSchemaVersion:
      projection.schemaVersion,
    revision: projection.revision,
    observationRevision,
    operationRevision,
    operationJournalConnected,
    cards,
    latest,
    operations,
    contentFingerprint: JSON.stringify({
      cards,
      operations
    }),
    summary: {
      total: cards.length,
      ready: cards.filter(
        (card) => card.status === "snapshot_ready"
      ).length,
      attention: cards.filter(
        (card) =>
          ATTENTION_STATUSES.has(card.status) ||
          card.missingEvidence.length > 0
      ).length,
      operations: operations.length,
      approvalRequired: operations.filter(
        (operation) =>
          operation.status ===
          "approval_required"
      ).length,
      uncertain: operations.filter(
        (operation) =>
          operation.status ===
            "outcome_unknown" ||
          operation.status ===
            "reconciliation_absent"
      ).length,
      syncFailed: operations.filter(
        (operation) =>
          operation.status === "sync_failed"
      ).length
    }
  };
}

export function createProviderPanelState() {
  return {
    phase: "idle",
    model: null,
    message: null,
    messageCode: null
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
      ? model.cards.length === 0 &&
        model.operations.length === 0
        ? "empty"
        : "provider-status"
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
      message: null,
      messageCode: null
    };
  }

  if (
    action.type === "success" &&
    isProviderPanelModel(action.model)
  ) {
    if (
      state.model &&
      isProviderPanelModel(state.model) &&
      !isNonRegressingProviderModel(
        state.model,
        action.model
      )
    ) {
      return {
        phase: "stale",
        model: state.model,
        message:
          "Refresh returned older Provider status. Showing the last known state.",
        messageCode: "provider-refresh-older"
      };
    }
    return {
      phase:
        action.model.cards.length === 0 &&
        action.model.operations.length === 0
          ? "empty"
          : "ready",
      model: action.model,
      message: null,
      messageCode: null
    };
  }

  if (action.type === "failure") {
    return {
      phase: state.model ? "stale" : "error",
      model: state.model ?? null,
      message: state.model
        ? "Refresh failed. Showing the last known Provider status."
        : "Provider status is unavailable.",
      messageCode: state.model
        ? "provider-refresh-failed"
        : "provider-unavailable"
    };
  }

  throw new TypeError(
    "Provider panel transition is invalid."
  );
}

export function didAdoptProviderPanelModel(
  state,
  candidate
) {
  return (
    (
      state?.phase === "ready" ||
      state?.phase === "empty"
    ) &&
    state.model === candidate
  );
}

export function createProviderAccessibleSummary(state) {
  if (state.phase === "idle" || state.phase === "loading") {
    return "Loading Provider status.";
  }
  if (state.phase === "error") {
    return "Provider status is unavailable.";
  }
  if (state.phase === "empty") {
    return "No Provider observations or controlled operations are available.";
  }

  const model = state.model;
  if (!isProviderPanelModel(model)) {
    return "Provider status is unavailable.";
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
    `${model.summary.attention} observations need attention; ` +
    `${model.summary.operations} controlled operations; ` +
    `${model.summary.approvalRequired} require approval; ` +
    `${model.summary.uncertain} have an uncertain outcome; ` +
    `${model.summary.syncFailed} sync failed. ` +
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
    observationFingerprint:
      createObservationFingerprint(
        observation
      )
  };
}

function projectControlledOperation(operation) {
  const isCreate =
    isPlainRecord(operation) &&
    operation.schemaVersion === 1;
  const isTransition =
    isPlainRecord(operation) &&
    operation.schemaVersion === 2;
  if (
    !isPlainRecord(operation) ||
    !hasExactKeys(
      operation,
      isCreate
        ? CONTROLLED_OPERATION_KEYS
        : isTransition
          ? TRANSITION_OPERATION_KEYS
          : []
    ) ||
    operation.provider !== "linear" ||
    (isTransition &&
      (operation.action !==
        "work-item.transition" ||
        !isTrimmedString(
          operation.workItemId,
          MAX_ID_LENGTH
        ) ||
        /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(
          operation.workItemId
        ) ||
        !UUID_V4_PATTERN.test(
          operation.acceptanceDecisionId
        ))) ||
    !isDigest(operation.operationKey) ||
    !isControlledOperationTarget(
      operation.configuredTarget,
      isTransition
    ) ||
    !Number.isSafeInteger(operation.version) ||
    operation.version < 1 ||
    !(
      isCreate
        ? CREATE_OPERATION_STATUSES.has(
            operation.status
          )
        : TRANSITION_OPERATION_STATUSES.has(
            operation.status
          )
    ) ||
    !isCanonicalTimestamp(operation.createdAt) ||
    !isCanonicalTimestamp(operation.updatedAt) ||
    Date.parse(operation.updatedAt) <
      Date.parse(operation.createdAt) ||
    Date.parse(operation.createdAt) > Date.now() ||
    Date.parse(operation.updatedAt) > Date.now() ||
    !(
      operation.diagnosticCode === null ||
      (typeof operation.diagnosticCode ===
        "string" &&
        CONTROLLED_DIAGNOSTIC_CODES.has(
          operation.diagnosticCode
        ))
    )
  ) {
    throw invalidProjection();
  }

  const approval =
    projectControlledApproval(
      operation.approval
    );
  if (
    !hasValidControlledOperationSemantics(
      operation,
      approval
    )
  ) {
    throw invalidProjection();
  }

  const statusView =
    OPERATION_STATUSES[operation.status];
  const projected = {
    ...(isTransition
      ? {
          action: operation.action,
          workItemId:
            operation.workItemId,
          acceptanceDecisionId:
            operation.acceptanceDecisionId
        }
      : {}),
    operationKey: operation.operationKey,
    provider: operation.provider,
    providerLabel: PROVIDERS.linear.label,
    configuredTarget: {
      kind: operation.configuredTarget.kind,
      key: operation.configuredTarget.key
    },
    version: operation.version,
    status: operation.status,
    statusLabel: statusView.label,
    statusIcon: statusView.icon,
    tone: statusView.tone,
    priority: statusView.priority,
    approval,
    diagnosticCode:
      operation.diagnosticCode,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt
  };

  return {
    ...projected,
    operationFingerprint:
      JSON.stringify(projected)
  };
}

function projectControlledApproval(value) {
  if (value === null) {
    return null;
  }
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "decision",
      "decidedAt"
    ]) ||
    (value.decision !== "approved" &&
      value.decision !== "rejected") ||
    !isCanonicalTimestamp(value.decidedAt)
  ) {
    throw invalidProjection();
  }
  return {
    decision: value.decision,
    decidedAt: value.decidedAt
  };
}

function hasValidControlledOperationSemantics(
  operation,
  approval
) {
  if (
    operation.status === "approval_required"
  ) {
    return (
      approval === null &&
      operation.diagnosticCode === null &&
      operation.updatedAt ===
        operation.createdAt
    );
  }
  if (
    approval === null ||
    Date.parse(approval.decidedAt) <
      Date.parse(operation.createdAt) ||
    Date.parse(approval.decidedAt) >
      Date.parse(operation.updatedAt)
  ) {
    return false;
  }
  if (
    (operation.status === "rejected") !==
    (approval.decision === "rejected")
  ) {
    return false;
  }
  if (operation.status === "sync_failed") {
    return (
      operation.diagnosticCode ===
      "LINEAR_WRITE_NOT_DISPATCHED"
    );
  }
  if (
    operation.status === "outcome_unknown"
  ) {
    return (
      operation.diagnosticCode ===
        "LINEAR_WRITE_OUTCOME_UNKNOWN" ||
      operation.diagnosticCode ===
        "LINEAR_RECONCILIATION_FAILED" ||
      operation.diagnosticCode ===
        "LINEAR_RECONCILIATION_AMBIGUOUS"
    );
  }
  if (operation.status === "reconciling") {
    return (
      operation.diagnosticCode === null ||
      operation.diagnosticCode ===
        "LINEAR_WRITE_OUTCOME_UNKNOWN" ||
      operation.diagnosticCode ===
        "LINEAR_RECONCILIATION_FAILED" ||
      operation.diagnosticCode ===
        "LINEAR_RECONCILIATION_AMBIGUOUS"
    );
  }
  return operation.diagnosticCode === null;
}

function compareOperationRecency(left, right) {
  return (
    Date.parse(right.updatedAt) -
      Date.parse(left.updatedAt) ||
    left.operationKey.localeCompare(
      right.operationKey
    )
  );
}

function compareOperationAttention(left, right) {
  return (
    left.priority - right.priority ||
    compareOperationRecency(left, right)
  );
}

function providerTargetIdentity(value) {
  return (
    `${value.provider}\u0000` +
    value.configuredTarget.key
  );
}

function isNonRegressingProviderModel(
  current,
  incoming
) {
  if (
    current.operationJournalConnected &&
    !incoming.operationJournalConnected
  ) {
    return false;
  }
  if (
    current.revision === incoming.revision &&
    current.contentFingerprint !==
      incoming.contentFingerprint
  ) {
    return false;
  }

  const incomingCards = new Map(
    incoming.cards.map((card) => [
      providerTargetIdentity(card),
      card
    ])
  );
  for (const currentCard of current.cards) {
    const incomingCard = incomingCards.get(
      providerTargetIdentity(currentCard)
    );
    if (!incomingCard) {
      return false;
    }
    const freshness =
      Date.parse(incomingCard.startedAt) -
      Date.parse(currentCard.startedAt);
    if (
      freshness < 0 ||
      (freshness === 0 &&
        (incomingCard.observationId !==
          currentCard.observationId ||
          incomingCard.observationFingerprint !==
            currentCard.observationFingerprint))
    ) {
      return false;
    }
  }

  if (
    current.observationRevision ===
      incoming.observationRevision &&
    JSON.stringify(
      current.cards.map((card) => [
        providerTargetIdentity(card),
        card.observationFingerprint
      ])
    ) !==
      JSON.stringify(
        incoming.cards.map((card) => [
          providerTargetIdentity(card),
          card.observationFingerprint
        ])
      )
  ) {
    return false;
  }

  const incomingOperations = new Map(
    incoming.operations.map((operation) => [
      operation.operationKey,
      operation
    ])
  );
  for (const currentOperation of current.operations) {
    const incomingOperation =
      incomingOperations.get(
        currentOperation.operationKey
      );
    if (
      !incomingOperation ||
      incomingOperation.version <
        currentOperation.version ||
      (incomingOperation.version ===
        currentOperation.version &&
        incomingOperation.operationFingerprint !==
          currentOperation.operationFingerprint)
    ) {
      return false;
    }
  }

  if (
    current.operationRevision !== null &&
    current.operationRevision ===
      incoming.operationRevision &&
    JSON.stringify(current.operations) !==
      JSON.stringify(incoming.operations)
  ) {
    return false;
  }
  return true;
}

function isProviderPanelModel(value) {
  return (
    isPlainRecord(value) &&
    Array.isArray(value.cards) &&
    Array.isArray(value.latest) &&
    Array.isArray(value.operations) &&
    typeof value.operationJournalConnected ===
      "boolean" &&
    isPlainRecord(value.summary)
  );
}

function createObservationFingerprint(
  observation
) {
  return JSON.stringify({
    schemaVersion: observation.schemaVersion,
    observationId: observation.observationId,
    operation: observation.operation,
    provider: observation.provider,
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
    status: observation.status,
    startedAt: observation.startedAt,
    observedAt: observation.observedAt,
    sourceRevisions:
      observation.sourceRevisions.map(
        (revision) => ({
          objectType: revision.objectType,
          id: revision.id,
          occurredAt: revision.occurredAt,
          contentDigest:
            revision.contentDigest
        })
      ),
    snapshotDigest: observation.snapshotDigest,
    mappingDigest: observation.mappingDigest,
    planDigest: observation.planDigest,
    missingEvidence: [
      ...observation.missingEvidence
    ],
    diagnosticCode: observation.diagnosticCode,
    resolution: observation.resolution
  });
}

function isControlledOperationTarget(
  value,
  transition
) {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["kind", "key"]) ||
    !isTrimmedString(value.key, MAX_KEY_LENGTH)
  ) {
    return false;
  }

  if (!transition && value.kind === "team") {
    return /^linear:team-ref:[^\s/]+\/[^\s/]+$/.test(
      value.key
    );
  }
  if (
    transition &&
    value.kind === "issue_state"
  ) {
    return /^linear:issue-state-ref:[^\s/]+\/[^\s/]+\/[^\s/]+\/[^\s/]+\/[^\s/]+$/.test(
      value.key
    );
  }
  return (
    !transition &&
    value.kind === "project_state" &&
    /^linear:project-state-ref:[^\s/]+\/[^\s/]+\/[^\s/]+\/[^\s/]+$/.test(
      value.key
    )
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
