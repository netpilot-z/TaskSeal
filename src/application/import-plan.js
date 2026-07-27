import {
  assertJsonWithinLimits,
  canonicalizeJson,
  digestCanonicalJson
} from "../lib/canonical-json.js";
import {
  computePolicyDigest,
  normalizePolicyBinding
} from "./import-policy.js";

const PLAN_BYTE_LIMIT = 2 * 1024 * 1024;
const PLAN_DEPTH_LIMIT = 16;
const PLAN_ACTION_LIMIT = 256;
const PLAN_EVENT_LIMIT = 256;
const ID_LIMIT = 256;
const EVENT_ID_PREFIX = new Map([
  ["work_item.created", "create"],
  ["external_link.linked", "link"],
  ["external_link.observed", "observe"],
  ["work_item.updated", "update-title"],
  ["artifact.linked", "artifact"],
  ["evidence.recorded", "evidence"]
]);
const EVENT_TYPE_ORDER = new Map([
  ["work_item.created", 0],
  ["external_link.linked", 1],
  ["external_link.observed", 2],
  ["work_item.updated", 3],
  ["artifact.linked", 4],
  ["evidence.recorded", 5]
]);
const EVENT_ACTION_RULES = new Map([
  [
    "work_item.created",
    new Set(["create|NEW_WORK_ITEM|work-item"])
  ],
  [
    "external_link.linked",
    new Set(["link|NEW_EXTERNAL_LINK|external-link"])
  ],
  [
    "external_link.observed",
    new Set([
      "refresh|LEGACY_LINK_BASELINE|external-link-observation",
      "refresh|NEW_SOURCE_REVISION|external-link-observation"
    ])
  ],
  [
    "work_item.updated",
    new Set([
      "update|MANAGED_TITLE_CHANGED|work-item-title"
    ])
  ],
  [
    "artifact.linked",
    new Set(["link|NEW_ARTIFACT|artifact"])
  ],
  [
    "evidence.recorded",
    new Set(["update|NEW_EVIDENCE|evidence"])
  ]
]);
const NO_EVENT_ACTION_RULES = new Set([
  "skip|EXACT_EVENT_DUPLICATE|artifact",
  "skip|EXACT_EVENT_DUPLICATE|evidence",
  "skip|EXACT_DUPLICATE|external-link-observation",
  "skip|STALE_SOURCE_REVISION|external-link-observation",
  "conflict|PROVIDER_OBJECT_ALREADY_LINKED|work-item",
  "conflict|PROVIDER_OBJECT_ALREADY_LINKED|external-link",
  "conflict|WORK_ITEM_MAPPING_CONFLICT|work-item",
  "conflict|FIELD_AUTHORITY_CONFLICT|external-link",
  "conflict|FIELD_AUTHORITY_CONFLICT|external-link-observation",
  "conflict|FIELD_AUTHORITY_CONFLICT|work-item-title",
  "conflict|SNAPSHOT_SCOPE_MISMATCH|external-link",
  "conflict|SOURCE_REVISION_CONTENT_CONFLICT|external-link-observation",
  "conflict|SOURCE_REVISION_ORDER_AMBIGUOUS|external-link-observation",
  ...[
    "work-item",
    "external-link",
    "external-link-observation",
    "work-item-title",
    "artifact",
    "evidence"
  ].flatMap((semanticTarget) => [
    `conflict|EVENT_ID_CONFLICT|${semanticTarget}`,
    `conflict|DOMAIN_INVARIANT_VIOLATION|${semanticTarget}`
  ])
]);
const EVENT_IDENTITY_FIELDS = [
  "eventType",
  "workItemId",
  "providerObjectKey",
  "sourceRevisionId",
  "semanticTarget"
];
const ACTION_IDENTITY_FIELDS = [
  "workItemId",
  "sourceObjectKey",
  "sourceRevisionId",
  "semanticTarget"
];
const PLAN_FIELDS = [
  "schemaVersion",
  "mode",
  "snapshotDigest",
  "mappingDigest",
  "policyBinding",
  "policyDigest",
  "baseWorkflowDigest",
  "planDigest",
  "summary",
  "actions",
  "events",
  "conflicts",
  "warnings"
];
const ACTION_FIELDS = [
  "actionId",
  "kind",
  "workItemId",
  "sourceObjectKey",
  "sourceRevisionId",
  "semanticTarget",
  "reasonCode",
  "eventIds"
];
const EVENT_FIELDS = [
  "eventId",
  "workItemId",
  "type",
  "occurredAt",
  "payload"
];
const SUMMARY_KEYS = [
  "create",
  "link",
  "refresh",
  "update",
  "skip",
  "conflict"
];
const ACTION_KINDS = new Set(SUMMARY_KEYS);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function deriveImportEventId(identity) {
  if (
    !isPlainRecord(identity) ||
    !hasExactKeys(identity, EVENT_IDENTITY_FIELDS) ||
    !EVENT_ID_PREFIX.has(identity.eventType) ||
    EVENT_IDENTITY_FIELDS.some(
      (field) => !isNonEmptyString(identity[field])
    )
  ) {
    throw new ImportPlanError(
      "IMPORT_EVENT_IDENTITY_INVALID",
      "Import event identity requires a supported event type and complete semantic identity fields."
    );
  }

  const identityDigest = digestCanonicalJson(identity)
    .slice("sha256:".length);

  return [
    "taskseal",
    "import",
    "v1",
    EVENT_ID_PREFIX.get(identity.eventType),
    identityDigest
  ].join(":");
}

export function deriveImportActionId(identity) {
  if (
    !isPlainRecord(identity) ||
    !hasExactKeys(identity, ACTION_IDENTITY_FIELDS) ||
    ACTION_IDENTITY_FIELDS.some(
      (field) => !isBoundedString(identity[field], ID_LIMIT)
    )
  ) {
    throw new ImportPlanError(
      "IMPORT_ACTION_IDENTITY_INVALID",
      "Import action identity requires complete semantic identity fields."
    );
  }

  return digestCanonicalJson(identity);
}

export function buildImportPlanDigestMaterial(plan) {
  return {
    schemaVersion: plan?.schemaVersion,
    snapshotDigest: plan?.snapshotDigest,
    mappingDigest: plan?.mappingDigest,
    policyDigest: plan?.policyDigest,
    baseWorkflowDigest: plan?.baseWorkflowDigest,
    policyBinding: plan?.policyBinding,
    actions: plan?.actions,
    events: plan?.events,
    conflictCodes: plan?.conflicts,
    warningCodes: plan?.warnings
  };
}

export function computeImportPlanDigest(plan) {
  return digestCanonicalJson(
    buildImportPlanDigestMaterial(plan)
  );
}

export function computeBaseWorkflowDigest(workflow) {
  return digestCanonicalJson(workflow);
}

export function compareImportEvents(left, right) {
  return (
    (EVENT_TYPE_ORDER.get(left.type) ?? 99) -
      (EVENT_TYPE_ORDER.get(right.type) ?? 99) ||
    compareStrings(left.occurredAt, right.occurredAt) ||
    compareStrings(left.eventId, right.eventId)
  );
}

export function compareImportActions(
  left,
  right,
  eventTypeById
) {
  const leftEventType = left.eventIds[0]
    ? eventTypeById.get(left.eventIds[0])
    : null;
  const rightEventType = right.eventIds[0]
    ? eventTypeById.get(right.eventIds[0])
    : null;

  return (
    (EVENT_TYPE_ORDER.get(leftEventType) ?? 90) -
      (EVENT_TYPE_ORDER.get(rightEventType) ?? 90) ||
    compareStrings(left.kind, right.kind) ||
    compareStrings(
      left.sourceObjectKey,
      right.sourceObjectKey
    ) ||
    compareStrings(
      left.sourceRevisionId,
      right.sourceRevisionId
    ) ||
    compareStrings(left.actionId, right.actionId)
  );
}

export function compareImportCodeProjections(
  left,
  right
) {
  return (
    compareStrings(left.actionId, right.actionId) ||
    compareStrings(left.code, right.code)
  );
}

export function normalizeImportPlan(plan) {
  const safePlan = cloneBoundedPlan(plan);

  if (
    Array.isArray(safePlan.actions) &&
    safePlan.actions.length > PLAN_ACTION_LIMIT
  ) {
    throw planLimit("actions", PLAN_ACTION_LIMIT);
  }

  if (
    Array.isArray(safePlan.events) &&
    safePlan.events.length > PLAN_EVENT_LIMIT
  ) {
    throw planLimit("events", PLAN_EVENT_LIMIT);
  }

  if (
    !isPlainRecord(safePlan) ||
    !hasExactKeys(safePlan, PLAN_FIELDS) ||
    safePlan.schemaVersion !== 1 ||
    safePlan.mode !== "preview" ||
    !isDigest(safePlan.snapshotDigest) ||
    !isDigest(safePlan.mappingDigest) ||
    !isDigest(safePlan.policyDigest) ||
    !isDigest(safePlan.baseWorkflowDigest) ||
    !isDigest(safePlan.planDigest) ||
    !Array.isArray(safePlan.actions) ||
    !Array.isArray(safePlan.events) ||
    !Array.isArray(safePlan.conflicts) ||
    !Array.isArray(safePlan.warnings)
  ) {
    throw planTampered();
  }

  let policyBinding;

  try {
    policyBinding = normalizePolicyBinding(
      safePlan.policyBinding
    );
  } catch {
    throw planTampered();
  }

  if (
    canonicalizeJson(policyBinding) !==
      canonicalizeJson(safePlan.policyBinding) ||
    computePolicyDigest(policyBinding) !==
      safePlan.policyDigest
  ) {
    throw planTampered();
  }

  const actions = safePlan.actions.map(normalizeAction);
  const events = safePlan.events.map(normalizeEvent);
  const conflicts = safePlan.conflicts.map(
    normalizeConflict
  );
  const warnings = safePlan.warnings.map(normalizeWarning);
  const eventById = new Map();
  const actionById = new Map();

  for (const event of events) {
    if (eventById.has(event.eventId)) {
      throw planTampered();
    }

    eventById.set(event.eventId, event);
  }

  for (const action of actions) {
    if (actionById.has(action.actionId)) {
      throw planTampered();
    }

    actionById.set(action.actionId, action);
  }

  const referencedEventIds = new Set();

  for (const action of actions) {
    const identity = {
      workItemId: action.workItemId,
      sourceObjectKey: action.sourceObjectKey,
      sourceRevisionId: action.sourceRevisionId,
      semanticTarget: action.semanticTarget
    };

    const actionHasNoEvent =
      action.kind === "skip" ||
      action.kind === "conflict";

    if (
      deriveImportActionId(identity) !== action.actionId ||
      (actionHasNoEvent
        ? action.eventIds.length !== 0 ||
          !NO_EVENT_ACTION_RULES.has(
            actionRuleKey(action)
          )
        : action.eventIds.length !== 1)
    ) {
      throw planTampered();
    }

    for (const eventId of action.eventIds) {
      const event = eventById.get(eventId);

      if (
        !event ||
        referencedEventIds.has(eventId) ||
        event.workItemId !== action.workItemId ||
        !eventActionMatches(action, event) ||
        deriveImportEventId({
          eventType: event.type,
          workItemId: action.workItemId,
          providerObjectKey: action.sourceObjectKey,
          sourceRevisionId: action.sourceRevisionId,
          semanticTarget: action.semanticTarget
        }) !== eventId
      ) {
        throw planTampered();
      }

      referencedEventIds.add(eventId);
    }
  }

  if (referencedEventIds.size !== events.length) {
    throw planTampered();
  }

  validateCanonicalOrder({
    actions,
    events,
    conflicts,
    warnings,
    eventById
  });
  validateProjections({
    conflicts,
    warnings,
    actionById
  });

  const summary = summarizeImportActions(actions);

  if (
    !isSummary(safePlan.summary) ||
    canonicalizeJson(summary) !==
      canonicalizeJson(safePlan.summary)
  ) {
    throw planTampered();
  }

  const normalized = {
    schemaVersion: 1,
    mode: "preview",
    snapshotDigest: safePlan.snapshotDigest,
    mappingDigest: safePlan.mappingDigest,
    policyBinding,
    policyDigest: safePlan.policyDigest,
    baseWorkflowDigest: safePlan.baseWorkflowDigest,
    planDigest: safePlan.planDigest,
    summary,
    actions,
    events,
    conflicts,
    warnings
  };

  if (
    computeImportPlanDigest(normalized) !==
    normalized.planDigest
  ) {
    throw planTampered();
  }

  return normalized;
}

export class ImportPlanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ImportPlanError";
    this.code = code;
  }
}

function cloneBoundedPlan(plan) {
  let canonical;

  try {
    rejectKnownOversizedPlanArrays(plan);
    assertJsonWithinLimits(plan, {
      maxDepth: PLAN_DEPTH_LIMIT,
      maxBytes: PLAN_BYTE_LIMIT,
      maxArrayLength: PLAN_ACTION_LIMIT,
      maxObjectKeys: PLAN_ACTION_LIMIT
    });
    canonical = canonicalizeJson(plan, {
      maxDepth: PLAN_DEPTH_LIMIT
    });
  } catch (error) {
    if (
      error?.code === "IMPORT_PLAN_LIMIT_EXCEEDED"
    ) {
      throw error;
    }

    if (
      error?.code ===
        "CANONICAL_JSON_DEPTH_EXCEEDED" ||
      error?.code ===
        "CANONICAL_JSON_LIMIT_EXCEEDED"
    ) {
      throw planLimit(
        error.code ===
          "CANONICAL_JSON_DEPTH_EXCEEDED"
          ? "nesting depth"
          : "encoded structure",
        error.code ===
          "CANONICAL_JSON_DEPTH_EXCEEDED"
          ? PLAN_DEPTH_LIMIT
          : PLAN_BYTE_LIMIT
      );
    }

    throw planTampered();
  }

  if (
    Buffer.byteLength(canonical, "utf8") >
    PLAN_BYTE_LIMIT
  ) {
    throw planLimit("bytes", PLAN_BYTE_LIMIT);
  }

  return JSON.parse(canonical);
}

function rejectKnownOversizedPlanArrays(plan) {
  if (!isPlainRecord(plan)) {
    return;
  }

  for (const [field, limit] of [
    ["actions", PLAN_ACTION_LIMIT],
    ["events", PLAN_EVENT_LIMIT]
  ]) {
    const descriptor =
      Object.getOwnPropertyDescriptor(plan, field);

    if (
      descriptor &&
      "value" in descriptor &&
      Array.isArray(descriptor.value) &&
      descriptor.value.length > limit
    ) {
      throw planLimit(field, limit);
    }
  }
}

function normalizeAction(value) {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ACTION_FIELDS) ||
    !isDigest(value.actionId) ||
    !ACTION_KINDS.has(value.kind) ||
    !isBoundedString(value.workItemId, ID_LIMIT) ||
    !isBoundedString(value.sourceObjectKey, ID_LIMIT) ||
    !isBoundedString(value.sourceRevisionId, ID_LIMIT) ||
    !isBoundedString(value.semanticTarget, ID_LIMIT) ||
    !isBoundedString(value.reasonCode, ID_LIMIT) ||
    !Array.isArray(value.eventIds) ||
    value.eventIds.length > PLAN_EVENT_LIMIT ||
    new Set(value.eventIds).size !== value.eventIds.length ||
    value.eventIds.some(
      (eventId) => !isBoundedString(eventId, ID_LIMIT)
    )
  ) {
    throw planTampered();
  }

  return value;
}

function normalizeEvent(value) {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, EVENT_FIELDS) ||
    !isBoundedString(value.eventId, ID_LIMIT) ||
    !isBoundedString(value.workItemId, ID_LIMIT) ||
    !EVENT_ID_PREFIX.has(value.type) ||
    !isBoundedString(value.occurredAt, ID_LIMIT) ||
    !Number.isFinite(Date.parse(value.occurredAt)) ||
    !isPlainRecord(value.payload)
  ) {
    throw planTampered();
  }

  return value;
}

function normalizeConflict(value) {
  if (
    !isPlainRecord(value) ||
    !hasAllowedExactKeys(
      value,
      ["actionId", "code"],
      ["domainCode"]
    ) ||
    !isDigest(value.actionId) ||
    !isBoundedString(value.code, ID_LIMIT) ||
    (value.domainCode !== undefined &&
      !isBoundedString(value.domainCode, ID_LIMIT))
  ) {
    throw planTampered();
  }

  return value;
}

function normalizeWarning(value) {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["actionId", "code"]) ||
    !isDigest(value.actionId) ||
    !isBoundedString(value.code, ID_LIMIT)
  ) {
    throw planTampered();
  }

  return value;
}

function validateProjections({
  conflicts,
  warnings,
  actionById
}) {
  const seenConflictActions = new Set();
  const seenWarningActions = new Set();

  for (const conflict of conflicts) {
    const action = actionById.get(conflict.actionId);

    if (
      !action ||
      action.kind !== "conflict" ||
      action.reasonCode !== conflict.code ||
      seenConflictActions.has(conflict.actionId)
    ) {
      throw planTampered();
    }

    seenConflictActions.add(conflict.actionId);
  }

  for (const action of actionById.values()) {
    if (
      action.kind === "conflict" &&
      !seenConflictActions.has(action.actionId)
    ) {
      throw planTampered();
    }
  }

  for (const warning of warnings) {
    const action = actionById.get(warning.actionId);

    if (
      !action ||
      action.kind !== "skip" ||
      action.reasonCode !== warning.code ||
      seenWarningActions.has(warning.actionId)
    ) {
      throw planTampered();
    }

    seenWarningActions.add(warning.actionId);
  }

  const expectedWarnings = [...actionById.values()]
    .filter(
      (action) =>
        action.kind === "skip" &&
        action.reasonCode ===
          "STALE_SOURCE_REVISION"
    )
    .map((action) => ({
      actionId: action.actionId,
      code: "STALE_SOURCE_REVISION"
    }))
    .sort(compareImportCodeProjections);

  if (
    canonicalizeJson(warnings) !==
    canonicalizeJson(expectedWarnings)
  ) {
    throw planTampered();
  }
}

function validateCanonicalOrder({
  actions,
  events,
  conflicts,
  warnings,
  eventById
}) {
  const eventTypeById = new Map(
    [...eventById].map(([eventId, event]) => [
      eventId,
      event.type
    ])
  );
  const canonicalEvents = [...events].sort(
    compareImportEvents
  );
  const canonicalActions = [...actions].sort(
    (left, right) =>
      compareImportActions(
        left,
        right,
        eventTypeById
      )
  );
  const canonicalConflicts = [...conflicts].sort(
    compareImportCodeProjections
  );
  const canonicalWarnings = [...warnings].sort(
    compareImportCodeProjections
  );

  if (
    canonicalizeJson(events) !==
      canonicalizeJson(canonicalEvents) ||
    canonicalizeJson(actions) !==
      canonicalizeJson(canonicalActions) ||
    canonicalizeJson(conflicts) !==
      canonicalizeJson(canonicalConflicts) ||
    canonicalizeJson(warnings) !==
      canonicalizeJson(canonicalWarnings)
  ) {
    throw planTampered();
  }
}

function eventActionMatches(action, event) {
  return (
    EVENT_ACTION_RULES.get(event.type)?.has(
      actionRuleKey(action)
    ) === true
  );
}

function actionRuleKey(action) {
  return [
    action.kind,
    action.reasonCode,
    action.semanticTarget
  ].join("|");
}

export function summarizeImportActions(actions) {
  const summary = Object.fromEntries(
    SUMMARY_KEYS.map((key) => [key, 0])
  );

  for (const action of actions) {
    summary[action.kind] += 1;
  }

  return summary;
}

function isSummary(value) {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, SUMMARY_KEYS) &&
    SUMMARY_KEYS.every(
      (key) =>
        Number.isSafeInteger(value[key]) &&
        value[key] >= 0
    )
  );
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

function hasExactKeys(value, expectedKeys) {
  const keys = Reflect.ownKeys(value);

  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key) => keys.includes(key))
  );
}

function hasAllowedExactKeys(
  value,
  requiredKeys,
  optionalKeys
) {
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([
    ...requiredKeys,
    ...optionalKeys
  ]);

  return (
    requiredKeys.every((key) => keys.includes(key)) &&
    keys.every(
      (key) =>
        typeof key === "string" && allowed.has(key)
    )
  );
}

function isNonEmptyString(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0
  );
}

function isBoundedString(value, maximumLength) {
  return (
    isNonEmptyString(value) &&
    [...value].length <= maximumLength
  );
}

function isDigest(value) {
  return (
    typeof value === "string" &&
    DIGEST_PATTERN.test(value)
  );
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function planTampered() {
  return new ImportPlanError(
    "IMPORT_PLAN_TAMPERED",
    "ImportPlan does not match its approved canonical semantics."
  );
}

function planLimit(field, limit) {
  return new ImportPlanError(
    "IMPORT_PLAN_LIMIT_EXCEEDED",
    `ImportPlan ${field} exceeds limit ${limit}.`
  );
}
