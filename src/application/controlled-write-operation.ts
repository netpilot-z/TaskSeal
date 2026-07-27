import {
  canonicalizeJson,
  digestCanonicalJson
} from "../lib/canonical-json.ts";

export type ControlledWriteOperationStatus =
  | "approval_required"
  | "approved"
  | "rejected"
  | "submitting"
  | "created"
  | "outcome_unknown"
  | "reconciling"
  | "reconciliation_absent"
  | "reconciled"
  | "failed";

export type ControlledWriteDiagnosticCode =
  | "LINEAR_WRITE_NOT_DISPATCHED"
  | "LINEAR_WRITE_OUTCOME_UNKNOWN"
  | "LINEAR_RECONCILIATION_FAILED"
  | "LINEAR_RECONCILIATION_AMBIGUOUS";

export interface ControlledWriteConfiguredTarget {
  kind: "team";
  key: string;
}

export interface ControlledWriteResolvedTarget {
  organizationId: string;
  teamId: string;
}

export interface ControlledWritePayload {
  title: string;
  description: string;
}

export interface ControlledWriteOperationPlan {
  schemaVersion: 1;
  provider: "linear";
  capability: "work-item.write";
  action: "work-item.create";
  configuredTarget: ControlledWriteConfiguredTarget;
  resolvedTarget: ControlledWriteResolvedTarget;
  clientRequestId: string;
  payload: ControlledWritePayload;
  payloadDigest: string;
  operationKey: string;
  planDigest: string;
}

export interface ControlledWriteActor {
  type: "human";
  id: string;
}

export interface ControlledWriteApproval {
  decision: "approved" | "rejected";
  actor: ControlledWriteActor;
  operationKey: string;
  planDigest: string;
  decidedAt: string;
}

export interface ControlledWriteIssueIdentity {
  id: string;
  identifier: string;
}

export interface ControlledWriteSubmission {
  attempt: number;
  startedAt: string | null;
  completedAt: string | null;
  issue: ControlledWriteIssueIdentity | null;
}

export interface ControlledWriteReconciliation {
  attempt: number;
  startedAt: string;
  completedAt: string | null;
  result:
    | "found"
    | "absent"
    | "failed"
    | "ambiguous"
    | null;
  issue: ControlledWriteIssueIdentity | null;
}

export interface ControlledWriteOperation {
  schemaVersion: 1;
  plan: ControlledWriteOperationPlan;
  version: number;
  status: ControlledWriteOperationStatus;
  approval: ControlledWriteApproval | null;
  submission: ControlledWriteSubmission;
  reconciliation: ControlledWriteReconciliation | null;
  diagnosticCode: ControlledWriteDiagnosticCode | null;
  createdAt: string;
  updatedAt: string;
}

export type ControlledWritePlanClassification =
  | "idempotent"
  | "conflict"
  | "different";

const PLAN_KEYS = [
  "schemaVersion",
  "provider",
  "capability",
  "action",
  "configuredTarget",
  "resolvedTarget",
  "clientRequestId",
  "payload",
  "payloadDigest",
  "operationKey",
  "planDigest"
] as const;
const OPERATION_KEYS = [
  "schemaVersion",
  "plan",
  "version",
  "status",
  "approval",
  "submission",
  "reconciliation",
  "diagnosticCode",
  "createdAt",
  "updatedAt"
] as const;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISSUE_IDENTIFIER_PATTERN =
  /^[A-Z][A-Z0-9]{0,15}-[1-9][0-9]{0,15}$/;
const MAX_TARGET_KEY_LENGTH = 512;
const MAX_TITLE_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 16_384;
const MAX_ACTOR_ID_LENGTH = 128;
const SAFE_DIAGNOSTIC_CODES =
  new Set<ControlledWriteDiagnosticCode>([
    "LINEAR_WRITE_NOT_DISPATCHED",
    "LINEAR_WRITE_OUTCOME_UNKNOWN",
    "LINEAR_RECONCILIATION_FAILED",
    "LINEAR_RECONCILIATION_AMBIGUOUS"
  ]);
const STATUSES = new Set<ControlledWriteOperationStatus>([
  "approval_required",
  "approved",
  "rejected",
  "submitting",
  "created",
  "outcome_unknown",
  "reconciling",
  "reconciliation_absent",
  "reconciled",
  "failed"
]);

export function createControlledWriteOperation(
  value: unknown
): ControlledWriteOperation {
  const input = readExactRecord(value, [
    "configuredTarget",
    "resolvedTarget",
    "clientRequestId",
    "payload",
    "preparedAt"
  ]);
  const plan = createPlan({
    configuredTarget: normalizeConfiguredTarget(
      input.configuredTarget
    ),
    resolvedTarget: normalizeResolvedTarget(
      input.resolvedTarget
    ),
    clientRequestId: normalizeUuid(
      input.clientRequestId,
      true
    ),
    payload: normalizePayload(input.payload)
  });
  const preparedAt = normalizeTimestamp(input.preparedAt);

  return freezeOperation(
    normalizeOperation({
      schemaVersion: 1,
      plan,
      version: 1,
      status: "approval_required",
      approval: null,
      submission: {
        attempt: 0,
        startedAt: null,
        completedAt: null,
        issue: null
      },
      reconciliation: null,
      diagnosticCode: null,
      createdAt: preparedAt,
      updatedAt: preparedAt
    })
  );
}

export function parseControlledWriteOperation(
  value: unknown
): ControlledWriteOperation {
  return freezeOperation(normalizeOperation(value));
}

export function classifyControlledWritePlan(
  left: unknown,
  right: unknown
): ControlledWritePlanClassification {
  const normalizedLeft = normalizePlan(left);
  const normalizedRight = normalizePlan(right);

  if (
    normalizedLeft.operationKey !==
    normalizedRight.operationKey
  ) {
    return "different";
  }
  return normalizedLeft.planDigest ===
    normalizedRight.planDigest
    ? "idempotent"
    : "conflict";
}

export function transitionControlledWriteOperation(
  value: unknown,
  actionValue: unknown
): ControlledWriteOperation {
  const operation = normalizeOperation(value);
  const action = readDataRecord(actionValue);
  const type = action.type;

  if (typeof type !== "string") {
    throw invalidOperation();
  }

  if (type === "approve" || type === "reject") {
    requireTransition(operation, "approval_required");
    requireExactKeys(action, [
      "type",
      "actor",
      "operationKey",
      "planDigest",
      "occurredAt"
    ]);
    const occurredAt = normalizeTransitionTime(
      action.occurredAt,
      operation.updatedAt
    );
    const operationKey = normalizeDigest(
      action.operationKey
    );
    const planDigest = normalizeDigest(action.planDigest);

    if (
      operationKey !== operation.plan.operationKey ||
      planDigest !== operation.plan.planDigest
    ) {
      throw approvalMismatch();
    }

    const decision =
      type === "approve" ? "approved" : "rejected";
    return finalizeTransition({
      ...operation,
      version: operation.version + 1,
      status: decision,
      approval: {
        decision,
        actor: normalizeActor(action.actor),
        operationKey,
        planDigest,
        decidedAt: occurredAt
      },
      updatedAt: occurredAt
    });
  }

  if (type === "begin_submission") {
    requireTransition(operation, "approved");
    requireExactKeys(action, ["type", "occurredAt"]);
    const occurredAt = normalizeTransitionTime(
      action.occurredAt,
      operation.updatedAt
    );

    return finalizeTransition({
      ...operation,
      version: operation.version + 1,
      status: "submitting",
      submission: {
        attempt: 1,
        startedAt: occurredAt,
        completedAt: null,
        issue: null
      },
      updatedAt: occurredAt
    });
  }

  if (type === "submission_created") {
    requireTransition(operation, "submitting");
    requireExactKeys(action, [
      "type",
      "occurredAt",
      "observedTeamId",
      "issue"
    ]);
    const occurredAt = normalizeTransitionTime(
      action.occurredAt,
      operation.updatedAt
    );
    const issue = normalizeObservedIssue(
      action.issue,
      action.observedTeamId,
      operation.plan
    );

    return finalizeTransition({
      ...operation,
      version: operation.version + 1,
      status: "created",
      submission: {
        ...operation.submission,
        completedAt: occurredAt,
        issue
      },
      diagnosticCode: null,
      updatedAt: occurredAt
    });
  }

  if (
    type === "submission_not_dispatched" ||
    type === "submission_outcome_unknown"
  ) {
    requireTransition(operation, "submitting");
    requireExactKeys(action, [
      "type",
      "occurredAt",
      "diagnosticCode"
    ]);
    const occurredAt = normalizeTransitionTime(
      action.occurredAt,
      operation.updatedAt
    );
    const diagnosticCode = normalizeDiagnosticCode(
      action.diagnosticCode
    );
    const expectedCode =
      type === "submission_not_dispatched"
        ? "LINEAR_WRITE_NOT_DISPATCHED"
        : "LINEAR_WRITE_OUTCOME_UNKNOWN";

    if (diagnosticCode !== expectedCode) {
      throw invalidOperation();
    }

    return finalizeTransition({
      ...operation,
      version: operation.version + 1,
      status:
        type === "submission_not_dispatched"
          ? "failed"
          : "outcome_unknown",
      submission: {
        ...operation.submission,
        completedAt: occurredAt,
        issue: null
      },
      diagnosticCode,
      updatedAt: occurredAt
    });
  }

  if (type === "begin_reconciliation") {
    requireTransitionOneOf(operation, [
      "outcome_unknown",
      "reconciliation_absent"
    ]);
    requireExactKeys(action, ["type", "occurredAt"]);
    const occurredAt = normalizeTransitionTime(
      action.occurredAt,
      operation.updatedAt
    );
    const attempt =
      (operation.reconciliation?.attempt ?? 0) + 1;

    return finalizeTransition({
      ...operation,
      version: operation.version + 1,
      status: "reconciling",
      reconciliation: {
        attempt,
        startedAt: occurredAt,
        completedAt: null,
        result: null,
        issue: null
      },
      updatedAt: occurredAt
    });
  }

  if (
    type === "reconciliation_found" ||
    type === "reconciliation_absent"
  ) {
    requireTransition(operation, "reconciling");
    requireExactKeys(
      action,
      type === "reconciliation_found"
        ? [
            "type",
            "occurredAt",
            "observedTeamId",
            "issue"
          ]
        : ["type", "occurredAt"]
    );
    const occurredAt = normalizeTransitionTime(
      action.occurredAt,
      operation.updatedAt
    );
    const issue =
      type === "reconciliation_found"
        ? normalizeObservedIssue(
            action.issue,
            action.observedTeamId,
            operation.plan
          )
        : null;

    return finalizeTransition({
      ...operation,
      version: operation.version + 1,
      status:
        type === "reconciliation_found"
          ? "reconciled"
          : "reconciliation_absent",
      reconciliation: {
        ...requireReconciliation(operation),
        completedAt: occurredAt,
        result:
          type === "reconciliation_found"
            ? "found"
            : "absent",
        issue
      },
      diagnosticCode: null,
      updatedAt: occurredAt
    });
  }

  if (
    type === "reconciliation_failed" ||
    type === "reconciliation_ambiguous"
  ) {
    requireTransition(operation, "reconciling");
    requireExactKeys(action, [
      "type",
      "occurredAt",
      "diagnosticCode"
    ]);
    const occurredAt = normalizeTransitionTime(
      action.occurredAt,
      operation.updatedAt
    );
    const diagnosticCode = normalizeDiagnosticCode(
      action.diagnosticCode
    );

    const expectedCode =
      type === "reconciliation_failed"
        ? "LINEAR_RECONCILIATION_FAILED"
        : "LINEAR_RECONCILIATION_AMBIGUOUS";
    if (diagnosticCode !== expectedCode) {
      throw invalidOperation();
    }

    return finalizeTransition({
      ...operation,
      version: operation.version + 1,
      status: "outcome_unknown",
      reconciliation: {
        ...requireReconciliation(operation),
        completedAt: occurredAt,
        result:
          type === "reconciliation_failed"
            ? "failed"
            : "ambiguous",
        issue: null
      },
      diagnosticCode,
      updatedAt: occurredAt
    });
  }

  throw invalidOperation();
}

export function validateControlledWriteOperationTransition(
  previousValue: unknown,
  nextValue: unknown
): ControlledWriteOperation {
  const previous = normalizeOperation(previousValue);
  const next = normalizeOperation(nextValue);

  if (next.version !== previous.version + 1) {
    throw transitionInvalid();
  }

  let expected: ControlledWriteOperation;
  try {
    expected = transitionControlledWriteOperation(
      previous,
      deriveTransitionAction(previous, next)
    );
  } catch (error) {
    if (error instanceof ControlledWriteOperationError) {
      throw transitionInvalid();
    }
    throw error;
  }

  if (
    canonicalizeJson(expected) !== canonicalizeJson(next)
  ) {
    throw transitionInvalid();
  }
  return freezeOperation(next);
}

function deriveTransitionAction(
  previous: ControlledWriteOperation,
  next: ControlledWriteOperation
): Record<string, unknown> {
  if (
    previous.status === "approval_required" &&
    (next.status === "approved" ||
      next.status === "rejected") &&
    next.approval !== null
  ) {
    return {
      type:
        next.status === "approved" ? "approve" : "reject",
      actor: next.approval.actor,
      operationKey: next.approval.operationKey,
      planDigest: next.approval.planDigest,
      occurredAt: next.updatedAt
    };
  }

  if (
    previous.status === "approved" &&
    next.status === "submitting"
  ) {
    return {
      type: "begin_submission",
      occurredAt: next.updatedAt
    };
  }

  if (previous.status === "submitting") {
    if (
      next.status === "created" &&
      next.submission.issue !== null
    ) {
      return {
        type: "submission_created",
        occurredAt: next.updatedAt,
        observedTeamId: next.plan.resolvedTarget.teamId,
        issue: next.submission.issue
      };
    }
    if (next.status === "failed") {
      return {
        type: "submission_not_dispatched",
        occurredAt: next.updatedAt,
        diagnosticCode: next.diagnosticCode
      };
    }
    if (
      next.status === "outcome_unknown" &&
      next.reconciliation === null
    ) {
      return {
        type: "submission_outcome_unknown",
        occurredAt: next.updatedAt,
        diagnosticCode: next.diagnosticCode
      };
    }
  }

  if (
    (previous.status === "outcome_unknown" ||
      previous.status === "reconciliation_absent") &&
    next.status === "reconciling"
  ) {
    return {
      type: "begin_reconciliation",
      occurredAt: next.updatedAt
    };
  }

  if (
    previous.status === "reconciling" &&
    next.reconciliation !== null
  ) {
    if (
      next.status === "reconciled" &&
      next.reconciliation.result === "found" &&
      next.reconciliation.issue !== null
    ) {
      return {
        type: "reconciliation_found",
        occurredAt: next.updatedAt,
        observedTeamId: next.plan.resolvedTarget.teamId,
        issue: next.reconciliation.issue
      };
    }
    if (
      next.status === "reconciliation_absent" &&
      next.reconciliation.result === "absent"
    ) {
      return {
        type: "reconciliation_absent",
        occurredAt: next.updatedAt
      };
    }
    if (
      next.status === "outcome_unknown" &&
      next.reconciliation.result === "failed"
    ) {
      return {
        type: "reconciliation_failed",
        occurredAt: next.updatedAt,
        diagnosticCode: next.diagnosticCode
      };
    }
    if (
      next.status === "outcome_unknown" &&
      next.reconciliation.result === "ambiguous"
    ) {
      return {
        type: "reconciliation_ambiguous",
        occurredAt: next.updatedAt,
        diagnosticCode: next.diagnosticCode
      };
    }
  }

  throw transitionInvalid();
}

function createPlan({
  configuredTarget,
  resolvedTarget,
  clientRequestId,
  payload
}: {
  configuredTarget: ControlledWriteConfiguredTarget;
  resolvedTarget: ControlledWriteResolvedTarget;
  clientRequestId: string;
  payload: ControlledWritePayload;
}): ControlledWriteOperationPlan {
  const identity = {
    domain: "taskseal.controlled-write.operation-key:v1",
    schemaVersion: 1,
    provider: "linear",
    capability: "work-item.write",
    action: "work-item.create",
    clientRequestId
  };
  const payloadDigest = digestCanonicalJson({
    domain: "taskseal.controlled-write.payload:v1",
    payload
  });
  const operationKey = digestCanonicalJson(identity);
  const withoutPlanDigest = {
    schemaVersion: 1 as const,
    provider: "linear" as const,
    capability: "work-item.write" as const,
    action: "work-item.create" as const,
    configuredTarget,
    resolvedTarget,
    clientRequestId,
    payload,
    payloadDigest,
    operationKey
  };

  return {
    ...withoutPlanDigest,
    planDigest: digestCanonicalJson({
      domain: "taskseal.controlled-write.plan:v1",
      plan: withoutPlanDigest
    })
  };
}

function normalizePlan(
  value: unknown
): ControlledWriteOperationPlan {
  const plan = readExactRecord(value, PLAN_KEYS);

  if (
    plan.schemaVersion !== 1 ||
    plan.provider !== "linear" ||
    plan.capability !== "work-item.write" ||
    plan.action !== "work-item.create"
  ) {
    throw invalidOperation();
  }

  const normalized = createPlan({
    configuredTarget: normalizeConfiguredTarget(
      plan.configuredTarget
    ),
    resolvedTarget: normalizeResolvedTarget(
      plan.resolvedTarget
    ),
    clientRequestId: normalizeUuid(
      plan.clientRequestId,
      true
    ),
    payload: normalizePayload(plan.payload)
  });

  if (
    normalizeDigest(plan.payloadDigest) !==
      normalized.payloadDigest ||
    normalizeDigest(plan.operationKey) !==
      normalized.operationKey ||
    normalizeDigest(plan.planDigest) !==
      normalized.planDigest
  ) {
    throw invalidOperation();
  }

  return normalized;
}

function normalizeOperation(
  value: unknown
): ControlledWriteOperation {
  const operation = readExactRecord(value, OPERATION_KEYS);

  if (
    operation.schemaVersion !== 1 ||
    !Number.isSafeInteger(operation.version) ||
    (operation.version as number) < 1 ||
    typeof operation.status !== "string" ||
    !STATUSES.has(
      operation.status as ControlledWriteOperationStatus
    )
  ) {
    throw invalidOperation();
  }

  const normalized: ControlledWriteOperation = {
    schemaVersion: 1,
    plan: normalizePlan(operation.plan),
    version: operation.version as number,
    status:
      operation.status as ControlledWriteOperationStatus,
    approval: normalizeApproval(operation.approval),
    submission: normalizeSubmission(
      operation.submission
    ),
    reconciliation: normalizeReconciliation(
      operation.reconciliation
    ),
    diagnosticCode:
      operation.diagnosticCode === null
        ? null
        : normalizeDiagnosticCode(
            operation.diagnosticCode
          ),
    createdAt: normalizeTimestamp(operation.createdAt),
    updatedAt: normalizeTimestamp(operation.updatedAt)
  };

  validateOperationSemantics(normalized);
  return normalized;
}

function validateOperationSemantics(
  operation: ControlledWriteOperation
): void {
  const {
    plan,
    version,
    status,
    approval,
    submission,
    reconciliation,
    diagnosticCode,
    createdAt,
    updatedAt
  } = operation;

  if (
    compareTimestamps(updatedAt, createdAt) < 0 ||
    (approval !== null &&
      (approval.operationKey !== plan.operationKey ||
        approval.planDigest !== plan.planDigest))
  ) {
    throw invalidOperation();
  }

  const timeline = [
    createdAt,
    approval?.decidedAt,
    submission.startedAt,
    submission.completedAt,
    reconciliation?.startedAt,
    reconciliation?.completedAt
  ].filter((value): value is string => value !== null && value !== undefined);

  for (let index = 1; index < timeline.length; index += 1) {
    const previous = timeline[index - 1];
    const current = timeline[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareTimestamps(current, previous) < 0
    ) {
      throw invalidOperation();
    }
  }

  const noSubmission =
    submission.attempt === 0 &&
    submission.startedAt === null &&
    submission.completedAt === null &&
    submission.issue === null;
  const activeSubmission =
    submission.attempt === 1 &&
    submission.startedAt !== null &&
    submission.completedAt === null &&
    submission.issue === null;
  const completedWithoutIssue =
    submission.attempt === 1 &&
    submission.startedAt !== null &&
    submission.completedAt !== null &&
    submission.issue === null;
  const completedWithIssue =
    submission.attempt === 1 &&
    submission.startedAt !== null &&
    submission.completedAt !== null &&
    submission.issue !== null;

  if (
    status === "approval_required" &&
    !(
      version === 1 &&
      approval === null &&
      noSubmission &&
      reconciliation === null &&
      diagnosticCode === null &&
      updatedAt === createdAt
    )
  ) {
    throw invalidOperation();
  }

  if (
    (status === "approved" || status === "rejected") &&
    !(
      version === 2 &&
      approval?.decision === status &&
      noSubmission &&
      reconciliation === null &&
      diagnosticCode === null &&
      updatedAt === approval.decidedAt
    )
  ) {
    throw invalidOperation();
  }

  if (
    status === "submitting" &&
    !(
      version === 3 &&
      approval?.decision === "approved" &&
      activeSubmission &&
      reconciliation === null &&
      diagnosticCode === null &&
      updatedAt === submission.startedAt
    )
  ) {
    throw invalidOperation();
  }

  if (
    status === "created" &&
    !(
      version === 4 &&
      approval?.decision === "approved" &&
      completedWithIssue &&
      submission.issue?.id === plan.clientRequestId &&
      reconciliation === null &&
      diagnosticCode === null &&
      updatedAt === submission.completedAt
    )
  ) {
    throw invalidOperation();
  }

  if (
    status === "failed" &&
    !(
      version === 4 &&
      approval?.decision === "approved" &&
      completedWithoutIssue &&
      reconciliation === null &&
      diagnosticCode ===
        "LINEAR_WRITE_NOT_DISPATCHED" &&
      updatedAt === submission.completedAt
    )
  ) {
    throw invalidOperation();
  }

  if (status === "outcome_unknown") {
    const initialUnknown =
      version === 4 &&
      reconciliation === null &&
      diagnosticCode ===
        "LINEAR_WRITE_OUTCOME_UNKNOWN" &&
      updatedAt === submission.completedAt;
    const reconciliationUnknown =
      reconciliation !== null &&
      (reconciliation.result === "failed" ||
        reconciliation.result === "ambiguous") &&
      reconciliation.completedAt !== null &&
      reconciliation.issue === null &&
      version ===
        6 + 2 * (reconciliation.attempt - 1) &&
      ((reconciliation.result === "failed" &&
        diagnosticCode ===
          "LINEAR_RECONCILIATION_FAILED") ||
        (reconciliation.result === "ambiguous" &&
          diagnosticCode ===
            "LINEAR_RECONCILIATION_AMBIGUOUS")) &&
      updatedAt === reconciliation.completedAt;

    if (
      !(
        approval?.decision === "approved" &&
        completedWithoutIssue &&
        (initialUnknown || reconciliationUnknown)
      )
    ) {
      throw invalidOperation();
    }
  }

  if (status === "reconciling") {
    const validDiagnostic =
      reconciliation?.attempt === 1
        ? diagnosticCode ===
          "LINEAR_WRITE_OUTCOME_UNKNOWN"
        : diagnosticCode === null ||
          diagnosticCode ===
            "LINEAR_WRITE_OUTCOME_UNKNOWN" ||
          diagnosticCode ===
            "LINEAR_RECONCILIATION_FAILED" ||
          diagnosticCode ===
            "LINEAR_RECONCILIATION_AMBIGUOUS";
    if (
      !(
        approval?.decision === "approved" &&
        completedWithoutIssue &&
        reconciliation !== null &&
        reconciliation.attempt >= 1 &&
        reconciliation.completedAt === null &&
        reconciliation.result === null &&
        reconciliation.issue === null &&
        version ===
          5 + 2 * (reconciliation.attempt - 1) &&
        validDiagnostic &&
        updatedAt === reconciliation.startedAt
      )
    ) {
      throw invalidOperation();
    }
  }

  if (
    status === "reconciled" ||
    status === "reconciliation_absent"
  ) {
    const validResult =
      status === "reconciled"
        ? reconciliation?.result === "found" &&
          reconciliation.issue?.id === plan.clientRequestId
        : reconciliation?.result === "absent" &&
          reconciliation.issue === null;
    if (
      !(
        approval?.decision === "approved" &&
        completedWithoutIssue &&
        reconciliation !== null &&
        reconciliation.attempt >= 1 &&
        reconciliation.completedAt !== null &&
        validResult &&
        version ===
          6 + 2 * (reconciliation.attempt - 1) &&
        diagnosticCode === null &&
        updatedAt === reconciliation.completedAt
      )
    ) {
      throw invalidOperation();
    }
  }
}

function normalizeConfiguredTarget(
  value: unknown
): ControlledWriteConfiguredTarget {
  const target = readExactRecord(value, ["kind", "key"]);
  const key = normalizeTrimmedString(
    target.key,
    MAX_TARGET_KEY_LENGTH,
    false,
    {
      maximumBytes: 2_048,
      multiline: false
    }
  );

  if (
    target.kind !== "team" ||
    !/^linear:team-ref:[^\s/]+\/[^\s/]+$/.test(key)
  ) {
    throw invalidOperation();
  }

  return {
    kind: "team",
    key
  };
}

function normalizeResolvedTarget(
  value: unknown
): ControlledWriteResolvedTarget {
  const target = readExactRecord(value, [
    "organizationId",
    "teamId"
  ]);

  return {
    organizationId: normalizeUuid(
      target.organizationId,
      false
    ),
    teamId: normalizeUuid(target.teamId, false)
  };
}

function normalizePayload(
  value: unknown
): ControlledWritePayload {
  const payload = readExactRecord(value, [
    "title",
    "description"
  ]);

  return {
    title: normalizeTrimmedString(
      payload.title,
      MAX_TITLE_LENGTH,
      false,
      {
        maximumBytes: 1_024,
        multiline: false
      }
    ),
    description: normalizeTrimmedString(
      payload.description,
      MAX_DESCRIPTION_LENGTH,
      true,
      {
        maximumBytes: 65_536,
        multiline: true
      }
    )
  };
}

function normalizeActor(
  value: unknown
): ControlledWriteActor {
  const actor = readExactRecord(value, ["type", "id"]);

  if (actor.type !== "human") {
    throw invalidOperation();
  }

  const id = normalizeTrimmedString(
    actor.id,
    MAX_ACTOR_ID_LENGTH,
    false,
    {
      maximumBytes: 512,
      multiline: false
    }
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    throw invalidOperation();
  }

  return {
    type: "human",
    id
  };
}

function normalizeApproval(
  value: unknown
): ControlledWriteApproval | null {
  if (value === null) {
    return null;
  }

  const approval = readExactRecord(value, [
    "decision",
    "actor",
    "operationKey",
    "planDigest",
    "decidedAt"
  ]);

  if (
    approval.decision !== "approved" &&
    approval.decision !== "rejected"
  ) {
    throw invalidOperation();
  }

  return {
    decision: approval.decision,
    actor: normalizeActor(approval.actor),
    operationKey: normalizeDigest(
      approval.operationKey
    ),
    planDigest: normalizeDigest(approval.planDigest),
    decidedAt: normalizeTimestamp(approval.decidedAt)
  };
}

function normalizeSubmission(
  value: unknown
): ControlledWriteSubmission {
  const submission = readExactRecord(value, [
    "attempt",
    "startedAt",
    "completedAt",
    "issue"
  ]);

  if (
    !Number.isSafeInteger(submission.attempt) ||
    ((submission.attempt as number) !== 0 &&
      (submission.attempt as number) !== 1)
  ) {
    throw invalidOperation();
  }

  return {
    attempt: submission.attempt as number,
    startedAt: normalizeNullableTimestamp(
      submission.startedAt
    ),
    completedAt: normalizeNullableTimestamp(
      submission.completedAt
    ),
    issue:
      submission.issue === null
        ? null
        : normalizeIssue(submission.issue)
  };
}

function normalizeReconciliation(
  value: unknown
): ControlledWriteReconciliation | null {
  if (value === null) {
    return null;
  }

  const reconciliation = readExactRecord(value, [
    "attempt",
    "startedAt",
    "completedAt",
    "result",
    "issue"
  ]);
  if (
    !Number.isSafeInteger(reconciliation.attempt) ||
    (reconciliation.attempt as number) < 1 ||
    !(
      reconciliation.result === null ||
      reconciliation.result === "found" ||
      reconciliation.result === "absent" ||
      reconciliation.result === "failed" ||
      reconciliation.result === "ambiguous"
    )
  ) {
    throw invalidOperation();
  }

  return {
    attempt: reconciliation.attempt as number,
    startedAt: normalizeTimestamp(
      reconciliation.startedAt
    ),
    completedAt: normalizeNullableTimestamp(
      reconciliation.completedAt
    ),
    result: reconciliation.result,
    issue:
      reconciliation.issue === null
        ? null
        : normalizeIssue(reconciliation.issue)
  };
}

function normalizeIssue(
  value: unknown
): ControlledWriteIssueIdentity {
  const issue = readExactRecord(value, [
    "id",
    "identifier"
  ]);
  const identifier = normalizeTrimmedString(
    issue.identifier,
    32,
    false,
    {
      maximumBytes: 128,
      multiline: false
    }
  );

  if (!ISSUE_IDENTIFIER_PATTERN.test(identifier)) {
    throw invalidOperation();
  }

  return {
    id: normalizeUuid(issue.id, false),
    identifier
  };
}

function normalizeObservedIssue(
  value: unknown,
  observedTeamIdValue: unknown,
  plan: ControlledWriteOperationPlan
): ControlledWriteIssueIdentity {
  const issue = normalizeIssue(value);
  const observedTeamId = normalizeUuid(
    observedTeamIdValue,
    false
  );

  if (
    issue.id !== plan.clientRequestId ||
    observedTeamId !== plan.resolvedTarget.teamId
  ) {
    throw transitionInvalid();
  }
  return issue;
}

function normalizeDiagnosticCode(
  value: unknown
): ControlledWriteDiagnosticCode {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    !SAFE_DIAGNOSTIC_CODES.has(
      value as ControlledWriteDiagnosticCode
    )
  ) {
    throw invalidOperation();
  }
  return value as ControlledWriteDiagnosticCode;
}

function normalizeDigest(value: unknown): string {
  if (
    typeof value !== "string" ||
    !DIGEST_PATTERN.test(value)
  ) {
    throw invalidOperation();
  }
  return value;
}

function normalizeUuid(
  value: unknown,
  requireVersionFour: boolean
): string {
  if (
    typeof value !== "string" ||
    !(requireVersionFour
      ? UUID_V4_PATTERN
      : UUID_PATTERN
    ).test(value)
  ) {
    throw invalidOperation();
  }
  return value;
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value !== "string") {
    throw invalidOperation();
  }
  const timestamp = Date.parse(value);

  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw invalidOperation();
  }
  return value;
}

function normalizeNullableTimestamp(
  value: unknown
): string | null {
  return value === null ? null : normalizeTimestamp(value);
}

function normalizeTransitionTime(
  value: unknown,
  previous: string
): string {
  const timestamp = normalizeTimestamp(value);
  if (compareTimestamps(timestamp, previous) < 0) {
    throw transitionInvalid();
  }
  return timestamp;
}

function normalizeTrimmedString(
  value: unknown,
  maximumLength: number,
  allowEmpty: boolean,
  {
    maximumBytes = maximumLength * 4,
    multiline = false
  }: {
    maximumBytes?: number;
    multiline?: boolean;
  } = {}
): string {
  const forbiddenControl = multiline
    ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/
    : /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value !== value.trim() ||
    (!allowEmpty && value.length === 0) ||
    [...value].length > maximumLength ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    forbiddenControl.test(value)
  ) {
    throw invalidOperation();
  }
  return value;
}

function requireTransition(
  operation: ControlledWriteOperation,
  expected: ControlledWriteOperationStatus
): void {
  if (operation.status !== expected) {
    throw transitionInvalid();
  }
}

function requireTransitionOneOf(
  operation: ControlledWriteOperation,
  expected: readonly ControlledWriteOperationStatus[]
): void {
  if (!expected.includes(operation.status)) {
    throw transitionInvalid();
  }
}

function requireReconciliation(
  operation: ControlledWriteOperation
): ControlledWriteReconciliation {
  if (operation.reconciliation === null) {
    throw transitionInvalid();
  }
  return operation.reconciliation;
}

function finalizeTransition(
  operation: ControlledWriteOperation
): ControlledWriteOperation {
  try {
    return freezeOperation(normalizeOperation(operation));
  } catch (error) {
    if (
      error instanceof ControlledWriteOperationError &&
      error.code === "CONTROLLED_WRITE_INVALID"
    ) {
      throw transitionInvalid();
    }
    throw error;
  }
}

function compareTimestamps(
  left: string,
  right: string
): number {
  return Date.parse(left) - Date.parse(right);
}

function readExactRecord<const T extends readonly string[]>(
  value: unknown,
  expectedKeys: T
): Record<T[number], unknown> {
  const record = readDataRecord(value);
  requireExactKeys(record, expectedKeys);
  return record as Record<T[number], unknown>;
}

function readDataRecord(
  value: unknown
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw invalidOperation();
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(
    null
  ) as Record<string, unknown>;

  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw invalidOperation();
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalidOperation();
    }
    result[key] = descriptor.value;
  }
  return result;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();

  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) => key !== expected[index]
    )
  ) {
    throw invalidOperation();
  }
}

function freezeOperation(
  operation: ControlledWriteOperation
): ControlledWriteOperation {
  return deepFreeze(operation);
}

function deepFreeze<T>(value: T): T {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

export class ControlledWriteOperationError
  extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ControlledWriteOperationError";
    this.code = code;
  }
}

function invalidOperation(): ControlledWriteOperationError {
  return new ControlledWriteOperationError(
    "CONTROLLED_WRITE_INVALID",
    "Controlled write operation is invalid."
  );
}

function transitionInvalid(): ControlledWriteOperationError {
  return new ControlledWriteOperationError(
    "CONTROLLED_WRITE_TRANSITION_INVALID",
    "Controlled write operation transition is invalid."
  );
}

function approvalMismatch(): ControlledWriteOperationError {
  return new ControlledWriteOperationError(
    "CONTROLLED_WRITE_APPROVAL_MISMATCH",
    "Controlled write approval does not match the operation plan."
  );
}
