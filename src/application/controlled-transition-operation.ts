import {
  canonicalizeJson,
  digestCanonicalJson
} from "../lib/canonical-json.ts";

export type ControlledTransitionOperationStatus =
  | "approval_required"
  | "approved"
  | "rejected"
  | "submitting"
  | "transitioned"
  | "outcome_unknown"
  | "reconciling"
  | "reconciliation_absent"
  | "reconciled"
  | "failed";

export type ControlledTransitionDiagnosticCode =
  | "LINEAR_WRITE_NOT_DISPATCHED"
  | "LINEAR_WRITE_OUTCOME_UNKNOWN"
  | "LINEAR_RECONCILIATION_FAILED"
  | "LINEAR_RECONCILIATION_AMBIGUOUS";

export interface ControlledTransitionConfiguredTarget {
  readonly kind: "issue_state";
  readonly key: string;
  readonly workspace: string;
  readonly team: string;
  readonly project: string;
  readonly expectedState: string;
  readonly targetState: string;
}

export interface ControlledTransitionResolvedTarget {
  readonly organizationId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly issueId: string;
  readonly expectedStateId: string;
  readonly expectedRevisionId: string;
  readonly targetStateId: string;
}

export interface ControlledTransitionSourceIntent {
  readonly kind:
    "taskseal.acceptance-decision";
  readonly workItemId: string;
  readonly decisionId: string;
  readonly reviewRevision: string;
  readonly acceptanceDigest: string;
}

export interface ControlledTransitionOperationPlan {
  readonly schemaVersion: 3;
  readonly provider: "linear";
  readonly capability: "acceptance.write";
  readonly action: "work-item.transition";
  readonly configuredTarget:
    ControlledTransitionConfiguredTarget;
  readonly resolvedTarget:
    ControlledTransitionResolvedTarget;
  readonly sourceIntent:
    ControlledTransitionSourceIntent;
  readonly operationKey: string;
  readonly planDigest: string;
}

export interface ControlledTransitionActor {
  readonly type: "human";
  readonly id: string;
}

export interface ControlledTransitionApproval {
  readonly decision:
    | "approved"
    | "rejected";
  readonly actor: ControlledTransitionActor;
  readonly operationKey: string;
  readonly planDigest: string;
  readonly decidedAt: string;
}

export interface ControlledTransitionObservedIssue {
  readonly id: string;
  readonly identifier: string;
  readonly revisionId: string;
  readonly placement: {
    readonly organizationId: string;
    readonly teamId: string;
    readonly projectId: string;
    readonly stateId: string;
  };
}

export interface ControlledTransitionSubmission {
  readonly attempt: number;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly issue:
    | ControlledTransitionObservedIssue
    | null;
}

export interface ControlledTransitionReconciliation {
  readonly attempt: number;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly result:
    | "found"
    | "absent"
    | "failed"
    | "ambiguous"
    | null;
  readonly issue:
    | ControlledTransitionObservedIssue
    | null;
}

export interface ControlledTransitionOperation {
  readonly schemaVersion: 3;
  readonly plan:
    ControlledTransitionOperationPlan;
  readonly version: number;
  readonly status:
    ControlledTransitionOperationStatus;
  readonly approval:
    | ControlledTransitionApproval
    | null;
  readonly submission:
    ControlledTransitionSubmission;
  readonly reconciliation:
    | ControlledTransitionReconciliation
    | null;
  readonly diagnosticCode:
    | ControlledTransitionDiagnosticCode
    | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ControlledTransitionPlanClassification =
  | "idempotent"
  | "conflict"
  | "different";

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
const PLAN_KEYS = [
  "schemaVersion",
  "provider",
  "capability",
  "action",
  "configuredTarget",
  "resolvedTarget",
  "sourceIntent",
  "operationKey",
  "planDigest"
] as const;
const CONFIGURED_TARGET_KEYS = [
  "kind",
  "key",
  "workspace",
  "team",
  "project",
  "expectedState",
  "targetState"
] as const;
const RESOLVED_TARGET_KEYS = [
  "organizationId",
  "teamId",
  "projectId",
  "issueId",
  "expectedStateId",
  "expectedRevisionId",
  "targetStateId"
] as const;
const SOURCE_INTENT_KEYS = [
  "kind",
  "workItemId",
  "decisionId",
  "reviewRevision",
  "acceptanceDigest"
] as const;
const SUBMISSION_KEYS = [
  "attempt",
  "startedAt",
  "completedAt",
  "issue"
] as const;
const RECONCILIATION_KEYS = [
  "attempt",
  "startedAt",
  "completedAt",
  "result",
  "issue"
] as const;
const APPROVAL_KEYS = [
  "decision",
  "actor",
  "operationKey",
  "planDigest",
  "decidedAt"
] as const;
const OBSERVED_ISSUE_KEYS = [
  "id",
  "identifier",
  "revisionId",
  "placement"
] as const;
const PLACEMENT_KEYS = [
  "organizationId",
  "teamId",
  "projectId",
  "stateId"
] as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN =
  /^sha256:[0-9a-f]{64}$/;
const ISSUE_IDENTIFIER_PATTERN =
  /^[A-Z][A-Z0-9]{0,15}-[1-9][0-9]{0,15}$/;
const ACTOR_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATUSES =
  new Set<ControlledTransitionOperationStatus>([
    "approval_required",
    "approved",
    "rejected",
    "submitting",
    "transitioned",
    "outcome_unknown",
    "reconciling",
    "reconciliation_absent",
    "reconciled",
    "failed"
  ]);
const DIAGNOSTICS =
  new Set<ControlledTransitionDiagnosticCode>([
    "LINEAR_WRITE_NOT_DISPATCHED",
    "LINEAR_WRITE_OUTCOME_UNKNOWN",
    "LINEAR_RECONCILIATION_FAILED",
    "LINEAR_RECONCILIATION_AMBIGUOUS"
  ]);

export function createControlledTransitionOperation(
  value: unknown
): ControlledTransitionOperation {
  const input = readExactRecord(value, [
    "configuredTarget",
    "resolvedTarget",
    "sourceIntent",
    "preparedAt"
  ]);
  const configuredTarget =
    normalizeConfiguredTargetInput(
      input.configuredTarget
    );
  const resolvedTarget =
    normalizeResolvedTarget(
      input.resolvedTarget
    );
  const sourceIntent =
    normalizeSourceIntentInput(
      input.sourceIntent
    );
  const operationKey =
    digestCanonicalJson({
      domain:
        "taskseal.controlled-transition.operation-key:v3",
      schemaVersion: 3,
      provider: "linear",
      capability:
        "acceptance.write",
      action: "work-item.transition",
      decisionId:
        sourceIntent.decisionId
    });
  const planWithoutDigest = {
    schemaVersion: 3 as const,
    provider: "linear" as const,
    capability:
      "acceptance.write" as const,
    action:
      "work-item.transition" as const,
    configuredTarget,
    resolvedTarget,
    sourceIntent,
    operationKey
  };
  const plan: ControlledTransitionOperationPlan =
    {
      ...planWithoutDigest,
      planDigest:
        digestCanonicalJson({
          domain:
            "taskseal.controlled-transition.plan:v3",
          plan: planWithoutDigest
        })
    };
  const preparedAt =
    normalizeTimestamp(input.preparedAt);
  return parseControlledTransitionOperation({
    schemaVersion: 3,
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
  });
}

export function parseControlledTransitionOperation(
  value: unknown
): ControlledTransitionOperation {
  try {
    const operation = readExactRecord(
      value,
      OPERATION_KEYS
    );
    if (
      operation.schemaVersion !== 3 ||
      !Number.isSafeInteger(
        operation.version
      ) ||
      (operation.version as number) < 1 ||
      typeof operation.status !==
        "string" ||
      !STATUSES.has(
        operation.status as
          ControlledTransitionOperationStatus
      )
    ) {
      throw invalidTransition();
    }
    const normalized: ControlledTransitionOperation =
      {
        schemaVersion: 3,
        plan: normalizePlan(
          operation.plan
        ),
        version: operation.version as number,
        status:
          operation.status as
            ControlledTransitionOperationStatus,
        approval: normalizeApproval(
          operation.approval
        ),
        submission:
          normalizeSubmission(
            operation.submission
          ),
        reconciliation:
          normalizeReconciliation(
            operation.reconciliation
          ),
        diagnosticCode:
          normalizeDiagnostic(
            operation.diagnosticCode
          ),
        createdAt: normalizeTimestamp(
          operation.createdAt
        ),
        updatedAt: normalizeTimestamp(
          operation.updatedAt
        )
      };
    validateOperationSemantics(normalized);
    return deepFreeze(normalized);
  } catch (error) {
    if (
      error instanceof
      ControlledTransitionOperationError
    ) {
      throw error;
    }
    throw invalidTransition();
  }
}

export function classifyControlledTransitionPlan(
  leftValue: unknown,
  rightValue: unknown
): ControlledTransitionPlanClassification {
  const left = normalizePlan(leftValue);
  const right = normalizePlan(rightValue);
  if (
    left.operationKey !== right.operationKey
  ) {
    return "different";
  }
  return left.planDigest ===
    right.planDigest
    ? "idempotent"
    : "conflict";
}

export function transitionControlledTransitionOperation(
  value: unknown,
  actionValue: unknown
): ControlledTransitionOperation {
  const operation =
    parseControlledTransitionOperation(value);
  const action = readDataRecord(actionValue);
  const type = action.type;
  if (typeof type !== "string") {
    throw invalidTransition();
  }

  if (type === "approve" || type === "reject") {
    requireStatus(
      operation,
      "approval_required"
    );
    requireExactKeys(action, [
      "type",
      "actor",
      "operationKey",
      "planDigest",
      "occurredAt"
    ]);
    const operationKey =
      normalizeDigest(action.operationKey);
    const planDigest =
      normalizeDigest(action.planDigest);
    if (
      operationKey !==
        operation.plan.operationKey ||
      planDigest !==
        operation.plan.planDigest
    ) {
      throw new ControlledTransitionOperationError(
        "CONTROLLED_TRANSITION_APPROVAL_MISMATCH",
        "The transition approval no longer matches the plan."
      );
    }
    const occurredAt =
      normalizeTransitionTime(
        action.occurredAt,
        operation.updatedAt
      );
    const decision =
      type === "approve"
        ? "approved"
        : "rejected";
    return parseControlledTransitionOperation({
      ...operation,
      version: operation.version + 1,
      status: decision,
      approval: {
        decision,
        actor: normalizeActor(
          action.actor
        ),
        operationKey,
        planDigest,
        decidedAt: occurredAt
      },
      updatedAt: occurredAt
    });
  }

  if (type === "begin_submission") {
    requireStatus(operation, "approved");
    requireExactKeys(action, [
      "type",
      "occurredAt"
    ]);
    const occurredAt =
      normalizeTransitionTime(
        action.occurredAt,
        operation.updatedAt
      );
    return parseControlledTransitionOperation({
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

  if (type === "transition_confirmed") {
    requireStatus(
      operation,
      "submitting"
    );
    requireExactKeys(action, [
      "type",
      "occurredAt",
      "issue"
    ]);
    const occurredAt =
      normalizeTransitionTime(
        action.occurredAt,
        operation.updatedAt
      );
    const issue = normalizeObservedIssue(
      action.issue
    );
    assertIssueMatches(
      issue,
      operation.plan,
      "target"
    );
    return parseControlledTransitionOperation({
      ...operation,
      version: operation.version + 1,
      status: "transitioned",
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
    requireStatus(
      operation,
      "submitting"
    );
    requireExactKeys(action, [
      "type",
      "occurredAt",
      "diagnosticCode"
    ]);
    const occurredAt =
      normalizeTransitionTime(
        action.occurredAt,
        operation.updatedAt
      );
    const diagnosticCode =
      normalizeDiagnostic(
        action.diagnosticCode
      );
    const expected =
      type === "submission_not_dispatched"
        ? "LINEAR_WRITE_NOT_DISPATCHED"
        : "LINEAR_WRITE_OUTCOME_UNKNOWN";
    if (diagnosticCode !== expected) {
      throw invalidTransition();
    }
    return parseControlledTransitionOperation({
      ...operation,
      version: operation.version + 1,
      status:
        type ===
        "submission_not_dispatched"
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
    requireStatusOneOf(operation, [
      "outcome_unknown",
      "reconciliation_absent"
    ]);
    requireExactKeys(action, [
      "type",
      "occurredAt"
    ]);
    const occurredAt =
      normalizeTransitionTime(
        action.occurredAt,
        operation.updatedAt
      );
    return parseControlledTransitionOperation({
      ...operation,
      version: operation.version + 1,
      status: "reconciling",
      reconciliation: {
        attempt:
          (
            operation.reconciliation
              ?.attempt ?? 0
          ) + 1,
        startedAt: occurredAt,
        completedAt: null,
        result: null,
        issue: null
      },
      updatedAt: occurredAt
    });
  }

  if (
    type ===
      "reconciliation_target_confirmed" ||
    type ===
      "reconciliation_expected_unchanged"
  ) {
    requireStatus(
      operation,
      "reconciling"
    );
    requireExactKeys(action, [
      "type",
      "occurredAt",
      "issue"
    ]);
    const occurredAt =
      normalizeTransitionTime(
        action.occurredAt,
        operation.updatedAt
      );
    const issue = normalizeObservedIssue(
      action.issue
    );
    const isTarget =
      type ===
      "reconciliation_target_confirmed";
    assertIssueMatches(
      issue,
      operation.plan,
      isTarget ? "target" : "source"
    );
    return parseControlledTransitionOperation({
      ...operation,
      version: operation.version + 1,
      status: isTarget
        ? "reconciled"
        : "reconciliation_absent",
      reconciliation: {
        ...requireReconciliation(
          operation
        ),
        completedAt: occurredAt,
        result: isTarget
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
    type ===
      "reconciliation_ambiguous"
  ) {
    requireStatus(
      operation,
      "reconciling"
    );
    requireExactKeys(action, [
      "type",
      "occurredAt",
      "diagnosticCode"
    ]);
    const occurredAt =
      normalizeTransitionTime(
        action.occurredAt,
        operation.updatedAt
      );
    const diagnosticCode =
      normalizeDiagnostic(
        action.diagnosticCode
      );
    const expected =
      type === "reconciliation_failed"
        ? "LINEAR_RECONCILIATION_FAILED"
        : "LINEAR_RECONCILIATION_AMBIGUOUS";
    if (diagnosticCode !== expected) {
      throw invalidTransition();
    }
    return parseControlledTransitionOperation({
      ...operation,
      version: operation.version + 1,
      status: "outcome_unknown",
      reconciliation: {
        ...requireReconciliation(
          operation
        ),
        completedAt: occurredAt,
        result:
          type ===
          "reconciliation_failed"
            ? "failed"
            : "ambiguous",
        issue: null
      },
      diagnosticCode,
      updatedAt: occurredAt
    });
  }

  throw invalidTransition();
}

export function validateControlledTransitionOperationTransition(
  previousValue: unknown,
  nextValue: unknown
): ControlledTransitionOperation {
  const previous =
    parseControlledTransitionOperation(
      previousValue
    );
  const next =
    parseControlledTransitionOperation(
      nextValue
    );
  if (
    next.version !== previous.version + 1 ||
    next.plan.planDigest !==
      previous.plan.planDigest
  ) {
    throw transitionPairInvalid();
  }
  let expected: ControlledTransitionOperation;
  try {
    expected =
      transitionControlledTransitionOperation(
        previous,
        deriveAction(previous, next)
      );
  } catch {
    throw transitionPairInvalid();
  }
  if (
    canonicalizeJson(expected) !==
    canonicalizeJson(next)
  ) {
    throw transitionPairInvalid();
  }
  return next;
}

function deriveAction(
  previous: ControlledTransitionOperation,
  next: ControlledTransitionOperation
): Record<string, unknown> {
  if (
    previous.status ===
      "approval_required" &&
    (
      next.status === "approved" ||
      next.status === "rejected"
    ) &&
    next.approval !== null
  ) {
    return {
      type:
        next.status === "approved"
          ? "approve"
          : "reject",
      actor: next.approval.actor,
      operationKey:
        next.approval.operationKey,
      planDigest:
        next.approval.planDigest,
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
      next.status === "transitioned" &&
      next.submission.issue !== null
    ) {
      return {
        type: "transition_confirmed",
        occurredAt: next.updatedAt,
        issue: next.submission.issue
      };
    }
    if (next.status === "failed") {
      return {
        type:
          "submission_not_dispatched",
        occurredAt: next.updatedAt,
        diagnosticCode:
          next.diagnosticCode
      };
    }
    if (
      next.status ===
        "outcome_unknown" &&
      next.reconciliation === null
    ) {
      return {
        type:
          "submission_outcome_unknown",
        occurredAt: next.updatedAt,
        diagnosticCode:
          next.diagnosticCode
      };
    }
  }
  if (
    (
      previous.status ===
        "outcome_unknown" ||
      previous.status ===
        "reconciliation_absent"
    ) &&
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
      next.reconciliation.result ===
        "found" &&
      next.reconciliation.issue !== null
    ) {
      return {
        type:
          "reconciliation_target_confirmed",
        occurredAt: next.updatedAt,
        issue:
          next.reconciliation.issue
      };
    }
    if (
      next.status ===
        "reconciliation_absent" &&
      next.reconciliation.result ===
        "absent" &&
      next.reconciliation.issue !== null
    ) {
      return {
        type:
          "reconciliation_expected_unchanged",
        occurredAt: next.updatedAt,
        issue:
          next.reconciliation.issue
      };
    }
    if (
      next.status ===
        "outcome_unknown" &&
      (
        next.reconciliation.result ===
          "failed" ||
        next.reconciliation.result ===
          "ambiguous"
      )
    ) {
      return {
        type:
          next.reconciliation.result ===
          "failed"
            ? "reconciliation_failed"
            : "reconciliation_ambiguous",
        occurredAt: next.updatedAt,
        diagnosticCode:
          next.diagnosticCode
      };
    }
  }
  throw transitionPairInvalid();
}

function normalizePlan(
  value: unknown
): ControlledTransitionOperationPlan {
  const plan = readExactRecord(
    value,
    PLAN_KEYS
  );
  if (
    plan.schemaVersion !== 3 ||
    plan.provider !== "linear" ||
    plan.capability !==
      "acceptance.write" ||
    plan.action !==
      "work-item.transition"
  ) {
    throw invalidTransition();
  }
  const configuredTarget =
    normalizeConfiguredTarget(
      plan.configuredTarget
    );
  const resolvedTarget =
    normalizeResolvedTarget(
      plan.resolvedTarget
    );
  const sourceIntent =
    normalizeSourceIntent(
      plan.sourceIntent
    );
  const operationKey =
    normalizeDigest(plan.operationKey);
  const planDigest =
    normalizeDigest(plan.planDigest);
  const expectedOperationKey =
    digestCanonicalJson({
      domain:
        "taskseal.controlled-transition.operation-key:v3",
      schemaVersion: 3,
      provider: "linear",
      capability:
        "acceptance.write",
      action: "work-item.transition",
      decisionId:
        sourceIntent.decisionId
    });
  const withoutDigest = {
    schemaVersion: 3 as const,
    provider: "linear" as const,
    capability:
      "acceptance.write" as const,
    action:
      "work-item.transition" as const,
    configuredTarget,
    resolvedTarget,
    sourceIntent,
    operationKey
  };
  const expectedPlanDigest =
    digestCanonicalJson({
      domain:
        "taskseal.controlled-transition.plan:v3",
      plan: withoutDigest
    });
  if (
    operationKey !==
      expectedOperationKey ||
    planDigest !== expectedPlanDigest
  ) {
    throw invalidTransition();
  }
  return {
    ...withoutDigest,
    planDigest
  };
}

function normalizeConfiguredTargetInput(
  value: unknown
): ControlledTransitionConfiguredTarget {
  const input = readExactRecord(value, [
    "workspace",
    "team",
    "project",
    "expectedState",
    "targetState"
  ]);
  const workspace =
    normalizeReference(input.workspace);
  const team =
    normalizeReference(input.team);
  const project =
    normalizeReference(input.project);
  const expectedState =
    normalizeReference(
      input.expectedState
    );
  const targetState =
    normalizeReference(input.targetState);
  if (
    expectedState.toLowerCase() ===
    targetState.toLowerCase()
  ) {
    throw invalidTransition();
  }
  return {
    kind: "issue_state",
    key: configuredTargetKey({
      workspace,
      team,
      project,
      expectedState,
      targetState
    }),
    workspace,
    team,
    project,
    expectedState,
    targetState
  };
}

function normalizeConfiguredTarget(
  value: unknown
): ControlledTransitionConfiguredTarget {
  const input = readExactRecord(
    value,
    CONFIGURED_TARGET_KEYS
  );
  if (input.kind !== "issue_state") {
    throw invalidTransition();
  }
  const normalized =
    normalizeConfiguredTargetInput({
      workspace: input.workspace,
      team: input.team,
      project: input.project,
      expectedState:
        input.expectedState,
      targetState: input.targetState
    });
  if (input.key !== normalized.key) {
    throw invalidTransition();
  }
  return normalized;
}

function configuredTargetKey(
  target: Omit<
    ControlledTransitionConfiguredTarget,
    "kind" | "key"
  >
): string {
  return (
    "linear:issue-state-ref:" +
    [
      target.workspace,
      target.team,
      target.project,
      target.expectedState,
      target.targetState
    ].map(encodeURIComponent).join("/")
  );
}

function normalizeResolvedTarget(
  value: unknown
): ControlledTransitionResolvedTarget {
  const input = readExactRecord(
    value,
    RESOLVED_TARGET_KEYS
  );
  const normalized = {
    organizationId:
      normalizeUuid(
        input.organizationId,
        false
      ),
    teamId: normalizeUuid(
      input.teamId,
      false
    ),
    projectId: normalizeUuid(
      input.projectId,
      false
    ),
    issueId: normalizeUuid(
      input.issueId,
      false
    ),
    expectedStateId: normalizeUuid(
      input.expectedStateId,
      false
    ),
    expectedRevisionId:
      normalizeTimestamp(
        input.expectedRevisionId
      ),
    targetStateId: normalizeUuid(
      input.targetStateId,
      false
    )
  };
  if (
    normalized.expectedStateId ===
    normalized.targetStateId
  ) {
    throw invalidTransition();
  }
  return normalized;
}

function normalizeSourceIntentInput(
  value: unknown
): ControlledTransitionSourceIntent {
  const input = readExactRecord(value, [
    "workItemId",
    "decisionId",
    "reviewRevision",
    "acceptanceDigest"
  ]);
  return normalizeSourceIntent({
    kind:
      "taskseal.acceptance-decision",
    ...input
  });
}

function normalizeSourceIntent(
  value: unknown
): ControlledTransitionSourceIntent {
  const input = readExactRecord(
    value,
    SOURCE_INTENT_KEYS
  );
  if (
    input.kind !==
      "taskseal.acceptance-decision" ||
    typeof input.workItemId !==
      "string" ||
    input.workItemId !==
      input.workItemId.trim() ||
    input.workItemId.length === 0 ||
    [...input.workItemId].length > 256 ||
    Buffer.byteLength(
      input.workItemId,
      "utf8"
    ) > 1_024 ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(
      input.workItemId
    ) ||
    typeof input.decisionId !==
      "string" ||
    !UUID_V4_PATTERN.test(
      input.decisionId
    )
  ) {
    throw invalidTransition();
  }
  return {
    kind:
      "taskseal.acceptance-decision",
    workItemId: input.workItemId,
    decisionId: input.decisionId,
    reviewRevision:
      normalizeDigest(
        input.reviewRevision
      ),
    acceptanceDigest:
      normalizeDigest(
        input.acceptanceDigest
      )
  };
}

function normalizeApproval(
  value: unknown
): ControlledTransitionApproval | null {
  if (value === null) {
    return null;
  }
  const input = readExactRecord(
    value,
    APPROVAL_KEYS
  );
  if (
    input.decision !== "approved" &&
    input.decision !== "rejected"
  ) {
    throw invalidTransition();
  }
  return {
    decision: input.decision,
    actor: normalizeActor(input.actor),
    operationKey:
      normalizeDigest(input.operationKey),
    planDigest:
      normalizeDigest(input.planDigest),
    decidedAt:
      normalizeTimestamp(input.decidedAt)
  };
}

function normalizeActor(
  value: unknown
): ControlledTransitionActor {
  const actor = readExactRecord(value, [
    "type",
    "id"
  ]);
  if (
    actor.type !== "human" ||
    typeof actor.id !== "string" ||
    !ACTOR_PATTERN.test(actor.id)
  ) {
    throw invalidTransition();
  }
  return {
    type: "human",
    id: actor.id
  };
}

function normalizeSubmission(
  value: unknown
): ControlledTransitionSubmission {
  const input = readExactRecord(
    value,
    SUBMISSION_KEYS
  );
  if (
    !Number.isSafeInteger(input.attempt) ||
    (input.attempt as number) < 0
  ) {
    throw invalidTransition();
  }
  return {
    attempt: input.attempt as number,
    startedAt:
      input.startedAt === null
        ? null
        : normalizeTimestamp(
            input.startedAt
          ),
    completedAt:
      input.completedAt === null
        ? null
        : normalizeTimestamp(
            input.completedAt
          ),
    issue:
      input.issue === null
        ? null
        : normalizeObservedIssue(
            input.issue
          )
  };
}

function normalizeReconciliation(
  value: unknown
): ControlledTransitionReconciliation | null {
  if (value === null) {
    return null;
  }
  const input = readExactRecord(
    value,
    RECONCILIATION_KEYS
  );
  if (
    !Number.isSafeInteger(input.attempt) ||
    (input.attempt as number) < 1 ||
    (
      input.result !== null &&
      input.result !== "found" &&
      input.result !== "absent" &&
      input.result !== "failed" &&
      input.result !== "ambiguous"
    )
  ) {
    throw invalidTransition();
  }
  return {
    attempt: input.attempt as number,
    startedAt:
      normalizeTimestamp(
        input.startedAt
      ),
    completedAt:
      input.completedAt === null
        ? null
        : normalizeTimestamp(
            input.completedAt
          ),
    result: input.result,
    issue:
      input.issue === null
        ? null
        : normalizeObservedIssue(
            input.issue
          )
  };
}

function normalizeObservedIssue(
  value: unknown
): ControlledTransitionObservedIssue {
  const input = readExactRecord(
    value,
    OBSERVED_ISSUE_KEYS
  );
  const placementInput = readExactRecord(
    input.placement,
    PLACEMENT_KEYS
  );
  if (
    typeof input.identifier !==
      "string" ||
    !ISSUE_IDENTIFIER_PATTERN.test(
      input.identifier
    )
  ) {
    throw invalidTransition();
  }
  return {
    id: normalizeUuid(input.id, false),
    identifier: input.identifier,
    revisionId:
      normalizeTimestamp(
        input.revisionId
      ),
    placement: {
      organizationId: normalizeUuid(
        placementInput.organizationId,
        false
      ),
      teamId: normalizeUuid(
        placementInput.teamId,
        false
      ),
      projectId: normalizeUuid(
        placementInput.projectId,
        false
      ),
      stateId: normalizeUuid(
        placementInput.stateId,
        false
      )
    }
  };
}

function validateOperationSemantics(
  operation: ControlledTransitionOperation
): void {
  const {
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
    Date.parse(updatedAt) <
      Date.parse(createdAt) ||
    (
      approval !== null &&
      (
        approval.operationKey !==
          operation.plan.operationKey ||
        approval.planDigest !==
          operation.plan.planDigest ||
        Date.parse(approval.decidedAt) <
          Date.parse(createdAt) ||
        Date.parse(approval.decidedAt) >
          Date.parse(updatedAt)
      )
    )
  ) {
    throw invalidTransition();
  }
  if (status === "approval_required") {
    requireShape(
      version === 1 &&
        approval === null &&
        emptySubmission(submission) &&
        reconciliation === null &&
        diagnosticCode === null &&
        createdAt === updatedAt
    );
    return;
  }
  if (
    approval === null ||
    (
      status === "rejected"
        ? approval.decision !== "rejected"
        : approval.decision !== "approved"
    )
  ) {
    throw invalidTransition();
  }
  if (
    status === "approved" ||
    status === "rejected"
  ) {
    requireShape(
      version === 2 &&
        emptySubmission(submission) &&
        reconciliation === null &&
        diagnosticCode === null
    );
    return;
  }
  requireShape(
    submission.attempt === 1 &&
      submission.startedAt !== null &&
      Date.parse(submission.startedAt) >=
        Date.parse(approval.decidedAt) &&
      Date.parse(submission.startedAt) <=
        Date.parse(updatedAt)
  );
  if (status === "submitting") {
    requireShape(
      version === 3 &&
        submission.completedAt === null &&
        submission.issue === null &&
        reconciliation === null &&
        diagnosticCode === null
    );
    return;
  }
  requireShape(
    submission.completedAt !== null &&
      Date.parse(
        submission.completedAt
      ) >=
        Date.parse(
          submission.startedAt
        ) &&
      Date.parse(
        submission.completedAt
      ) <= Date.parse(updatedAt)
  );
  if (status === "transitioned") {
    requireShape(
      version === 4 &&
        submission.issue !== null &&
        reconciliation === null &&
        diagnosticCode === null
    );
    assertIssueMatches(
      submission.issue!,
      operation.plan,
      "target"
    );
    return;
  }
  requireShape(submission.issue === null);
  if (status === "failed") {
    requireShape(
      version === 4 &&
        reconciliation === null &&
        diagnosticCode ===
          "LINEAR_WRITE_NOT_DISPATCHED"
    );
    return;
  }
  if (reconciliation === null) {
    requireShape(
      status === "outcome_unknown" &&
        version === 4 &&
        diagnosticCode ===
          "LINEAR_WRITE_OUTCOME_UNKNOWN"
    );
    return;
  }
  requireShape(
    reconciliation.attempt >= 1 &&
      Date.parse(
        reconciliation.startedAt
      ) >=
        Date.parse(
          submission.completedAt
        ) &&
      Date.parse(
        reconciliation.startedAt
      ) <= Date.parse(updatedAt)
  );
  if (status === "reconciling") {
    requireShape(
      version >= 5 &&
        version % 2 === 1 &&
        reconciliation.completedAt ===
          null &&
        reconciliation.result === null &&
        reconciliation.issue === null
    );
    return;
  }
  requireShape(
    reconciliation.completedAt !==
      null &&
      Date.parse(
        reconciliation.completedAt
      ) >=
        Date.parse(
          reconciliation.startedAt
        ) &&
      Date.parse(
        reconciliation.completedAt
      ) <= Date.parse(updatedAt) &&
      version >= 6 &&
      version % 2 === 0
  );
  if (status === "reconciled") {
    requireShape(
      reconciliation.result ===
        "found" &&
        reconciliation.issue !== null &&
        diagnosticCode === null
    );
    assertIssueMatches(
      reconciliation.issue!,
      operation.plan,
      "target"
    );
    return;
  }
  if (
    status ===
    "reconciliation_absent"
  ) {
    requireShape(
      reconciliation.result ===
        "absent" &&
        reconciliation.issue !== null &&
        diagnosticCode === null
    );
    assertIssueMatches(
      reconciliation.issue!,
      operation.plan,
      "source"
    );
    return;
  }
  requireShape(
    status === "outcome_unknown" &&
      reconciliation.issue === null &&
      (
        (
          reconciliation.result ===
            "failed" &&
          diagnosticCode ===
            "LINEAR_RECONCILIATION_FAILED"
        ) ||
        (
          reconciliation.result ===
            "ambiguous" &&
          diagnosticCode ===
            "LINEAR_RECONCILIATION_AMBIGUOUS"
        )
      )
  );
}

function assertIssueMatches(
  issue: ControlledTransitionObservedIssue,
  plan: ControlledTransitionOperationPlan,
  expected: "source" | "target"
): void {
  const resolved = plan.resolvedTarget;
  if (
    issue.id !== resolved.issueId ||
    issue.placement.organizationId !==
      resolved.organizationId ||
    issue.placement.teamId !==
      resolved.teamId ||
    issue.placement.projectId !==
      resolved.projectId ||
    issue.placement.stateId !==
      (
        expected === "source"
          ? resolved.expectedStateId
          : resolved.targetStateId
      ) ||
    (
      expected === "source"
        ? issue.revisionId !==
          resolved.expectedRevisionId
        : Date.parse(issue.revisionId) <
          Date.parse(
            resolved.expectedRevisionId
          )
    )
  ) {
    throw invalidTransition();
  }
}

function normalizeReference(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length === 0 ||
    [...value].length > 128 ||
    Buffer.byteLength(value, "utf8") >
      512 ||
    /[\/\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(
      value
    )
  ) {
    throw invalidTransition();
  }
  return value;
}

function normalizeUuid(
  value: unknown,
  versionFour: boolean
): string {
  if (
    typeof value !== "string" ||
    !(versionFour
      ? UUID_V4_PATTERN
      : UUID_PATTERN
    ).test(value)
  ) {
    throw invalidTransition();
  }
  return value;
}

function normalizeDigest(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    !DIGEST_PATTERN.test(value)
  ) {
    throw invalidTransition();
  }
  return value;
}

function normalizeTimestamp(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(
      Date.parse(value)
    ).toISOString() !== value
  ) {
    throw invalidTransition();
  }
  return value;
}

function normalizeTransitionTime(
  value: unknown,
  previous: string
): string {
  const timestamp =
    normalizeTimestamp(value);
  if (
    Date.parse(timestamp) <
    Date.parse(previous)
  ) {
    throw invalidTransition();
  }
  return timestamp;
}

function normalizeDiagnostic(
  value: unknown
): ControlledTransitionDiagnosticCode | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    !DIAGNOSTICS.has(
      value as
        ControlledTransitionDiagnosticCode
    )
  ) {
    throw invalidTransition();
  }
  return value as
    ControlledTransitionDiagnosticCode;
}

function requireStatus(
  operation: ControlledTransitionOperation,
  status: ControlledTransitionOperationStatus
): void {
  if (operation.status !== status) {
    throw invalidTransition();
  }
}

function requireStatusOneOf(
  operation: ControlledTransitionOperation,
  statuses: readonly ControlledTransitionOperationStatus[]
): void {
  if (!statuses.includes(operation.status)) {
    throw invalidTransition();
  }
}

function requireReconciliation(
  operation: ControlledTransitionOperation
): ControlledTransitionReconciliation {
  if (operation.reconciliation === null) {
    throw invalidTransition();
  }
  return operation.reconciliation;
}

function emptySubmission(
  value: ControlledTransitionSubmission
): boolean {
  return (
    value.attempt === 0 &&
    value.startedAt === null &&
    value.completedAt === null &&
    value.issue === null
  );
}

function requireShape(
  condition: boolean
): asserts condition {
  if (!condition) {
    throw invalidTransition();
  }
}

function readExactRecord<
  const Keys extends readonly string[]
>(
  value: unknown,
  expectedKeys: Keys
): Record<Keys[number], unknown> {
  const record = readDataRecord(value);
  requireExactKeys(record, expectedKeys);
  return record as Record<
    Keys[number],
    unknown
  >;
}

function readDataRecord(
  value: unknown
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (
      Object.getPrototypeOf(value) !==
        Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
  ) {
    throw invalidTransition();
  }
  const descriptors =
    Object.getOwnPropertyDescriptors(value);
  const result = Object.create(
    null
  ) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw invalidTransition();
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalidTransition();
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
    throw invalidTransition();
  }
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

function invalidTransition(): ControlledTransitionOperationError {
  return new ControlledTransitionOperationError(
    "CONTROLLED_TRANSITION_INVALID",
    "The controlled transition operation is invalid."
  );
}

function transitionPairInvalid(): ControlledTransitionOperationError {
  return new ControlledTransitionOperationError(
    "CONTROLLED_TRANSITION_PAIR_INVALID",
    "The controlled transition operation pair is invalid."
  );
}

export class ControlledTransitionOperationError
  extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name =
      "ControlledTransitionOperationError";
    this.code = code;
  }
}
