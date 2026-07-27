import {
  assertJsonWithinLimits,
  canonicalizeJson,
  digestCanonicalJson
} from "../lib/canonical-json.js";
import {
  normalizeImportPlan,
  summarizeImportActions
} from "./import-plan.js";

const RECORD_BYTE_LIMIT = 3 * 1024 * 1024;
const RECORD_DEPTH_LIMIT = 16;
const ID_LIMIT = 256;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RECORD_FIELDS = [
  "recordType",
  "schemaVersion",
  "batchId",
  "planDigest",
  "snapshotDigest",
  "mappingDigest",
  "policyBinding",
  "policyDigest",
  "baseWorkflowDigest",
  "actions",
  "conflictCodes",
  "warningCodes",
  "appliedAt",
  "actor",
  "outcome",
  "events",
  "summary"
];

export function validateImportPlanForApply(
  plan,
  expectedPlanDigest
) {
  let normalized;

  try {
    normalized = normalizeImportPlan(plan);
  } catch (error) {
    if (
      error?.code === "IMPORT_PLAN_LIMIT_EXCEEDED"
    ) {
      throw error;
    }

    throw importPlanTampered(error);
  }

  if (
    !DIGEST_PATTERN.test(expectedPlanDigest ?? "") ||
    normalized.planDigest !== expectedPlanDigest
  ) {
    throw importPlanTampered();
  }

  return normalized;
}

export function createImportBatchRecord({
  plan,
  actor,
  appliedAt
}) {
  const normalizedPlan = validateImportPlanForApply(
    plan,
    plan?.planDigest
  );
  const normalizedActor = normalizeActor(
    actor,
    "IMPORT_ACTOR_INVALID"
  );

  if (!isTimestamp(appliedAt)) {
    throw new ImportBatchError(
      "IMPORT_ACTOR_INVALID",
      "Import audit metadata requires a valid appliedAt timestamp."
    );
  }

  if (!normalizedPlan.policyBinding.applyAllowed) {
    throw new ImportBatchError(
      "IMPORT_APPLY_FORBIDDEN",
      "The approved import plan does not allow apply."
    );
  }

  if (normalizedPlan.conflicts.length > 0) {
    throw new ImportBatchError(
      "IMPORT_PLAN_BLOCKED",
      "The approved import plan contains blocking conflicts."
    );
  }

  const record = {
    recordType: "import.batch",
    schemaVersion: 1,
    batchId: `import:${normalizedPlan.planDigest}`,
    planDigest: normalizedPlan.planDigest,
    snapshotDigest: normalizedPlan.snapshotDigest,
    mappingDigest: normalizedPlan.mappingDigest,
    policyBinding: normalizedPlan.policyBinding,
    policyDigest: normalizedPlan.policyDigest,
    baseWorkflowDigest:
      normalizedPlan.baseWorkflowDigest,
    actions: normalizedPlan.actions,
    conflictCodes: normalizedPlan.conflicts,
    warningCodes: normalizedPlan.warnings,
    appliedAt,
    actor: normalizedActor,
    outcome: "applied",
    events: normalizedPlan.events,
    summary: buildRecordSummary(normalizedPlan)
  };

  return cloneCanonical(record);
}

export function validateImportBatchRecord(record) {
  try {
    const safeRecord = cloneBoundedRecord(record);

    if (
      !isPlainRecord(safeRecord) ||
      !hasExactKeys(safeRecord, RECORD_FIELDS) ||
      safeRecord.recordType !== "import.batch" ||
      safeRecord.schemaVersion !== 1 ||
      !isDigest(safeRecord.planDigest) ||
      safeRecord.batchId !==
        `import:${safeRecord.planDigest}` ||
      !isDigest(safeRecord.snapshotDigest) ||
      !isDigest(safeRecord.mappingDigest) ||
      !isDigest(safeRecord.policyDigest) ||
      !isDigest(safeRecord.baseWorkflowDigest) ||
      !isTimestamp(safeRecord.appliedAt) ||
      safeRecord.outcome !== "applied" ||
      !Array.isArray(safeRecord.actions) ||
      !Array.isArray(safeRecord.events) ||
      !Array.isArray(safeRecord.conflictCodes) ||
      !Array.isArray(safeRecord.warningCodes) ||
      !isPlainRecord(safeRecord.summary)
    ) {
      throw journalCorrupt();
    }

    const actor = normalizeActor(
      safeRecord.actor,
      "JOURNAL_CORRUPT"
    );
    const plan = normalizeImportPlan({
      schemaVersion: 1,
      mode: "preview",
      snapshotDigest: safeRecord.snapshotDigest,
      mappingDigest: safeRecord.mappingDigest,
      policyBinding: safeRecord.policyBinding,
      policyDigest: safeRecord.policyDigest,
      baseWorkflowDigest:
        safeRecord.baseWorkflowDigest,
      planDigest: safeRecord.planDigest,
      summary: summarizeImportActions(
        safeRecord.actions
      ),
      actions: safeRecord.actions,
      events: safeRecord.events,
      conflicts: safeRecord.conflictCodes,
      warnings: safeRecord.warningCodes
    });

    if (
      !plan.policyBinding.applyAllowed ||
      plan.conflicts.length > 0 ||
      canonicalizeJson(
        buildRecordSummary(plan)
      ) !== canonicalizeJson(safeRecord.summary)
    ) {
      throw journalCorrupt();
    }

    const normalizedRecord = {
      ...safeRecord,
      actor,
      policyBinding: plan.policyBinding,
      actions: plan.actions,
      conflictCodes: plan.conflicts,
      warningCodes: plan.warnings,
      events: plan.events
    };

    return {
      record: normalizedRecord,
      recordDigest:
        computeImportBatchRecordDigest(normalizedRecord),
      plan,
      receipt: projectImportReceipt(normalizedRecord)
    };
  } catch (error) {
    if (error?.code === "JOURNAL_CORRUPT") {
      throw error;
    }

    throw journalCorrupt(error);
  }
}

export function computeImportBatchRecordDigest(record) {
  return digestCanonicalJson(record);
}

export function projectImportReceipt(record) {
  return cloneCanonical({
    batchId: record.batchId,
    planDigest: record.planDigest,
    snapshotDigest: record.snapshotDigest,
    mappingDigest: record.mappingDigest,
    policyDigest: record.policyDigest,
    baseWorkflowDigest: record.baseWorkflowDigest,
    actor: record.actor,
    appliedAt: record.appliedAt,
    outcome: record.outcome,
    eventIds: record.summary.eventIds,
    skippedCodes: record.summary.skippedCodes,
    warningCodes: record.summary.warningCodes
  });
}

function buildRecordSummary(plan) {
  return {
    eventIds: plan.events.map((event) => event.eventId),
    skippedCodes: plan.actions
      .filter((action) => action.kind === "skip")
      .map((action) => action.reasonCode),
    warningCodes: plan.warnings.map(
      (warning) => warning.code
    )
  };
}

function normalizeActor(value, errorCode) {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["type", "id"]) ||
    !isBoundedString(value.type, ID_LIMIT) ||
    !isBoundedString(value.id, ID_LIMIT)
  ) {
    if (errorCode === "JOURNAL_CORRUPT") {
      throw journalCorrupt();
    }

    throw new ImportBatchError(
      errorCode,
      "Import actor requires stable non-secret type and id fields."
    );
  }

  return {
    type: value.type,
    id: value.id
  };
}

function cloneBoundedRecord(record) {
  let canonical;

  try {
    assertJsonWithinLimits(record, {
      maxDepth: RECORD_DEPTH_LIMIT,
      maxBytes: RECORD_BYTE_LIMIT,
      maxArrayLength: 256,
      maxObjectKeys: 256
    });
    canonical = canonicalizeJson(record, {
      maxDepth: RECORD_DEPTH_LIMIT
    });
  } catch (error) {
    throw journalCorrupt(error);
  }

  if (
    Buffer.byteLength(canonical, "utf8") >
    RECORD_BYTE_LIMIT
  ) {
    throw journalCorrupt();
  }

  return JSON.parse(canonical);
}

function cloneCanonical(value) {
  return JSON.parse(canonicalizeJson(value));
}

function isPlainRecord(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
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

function isDigest(value) {
  return (
    typeof value === "string" &&
    DIGEST_PATTERN.test(value)
  );
}

function isTimestamp(value) {
  return (
    isBoundedString(value, ID_LIMIT) &&
    Number.isFinite(Date.parse(value))
  );
}

function isBoundedString(value, maximumLength) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    [...value].length <= maximumLength
  );
}

function importPlanTampered(cause) {
  return new ImportBatchError(
    "IMPORT_PLAN_TAMPERED",
    "ImportPlan does not match the approved digest and schema.",
    cause ? { cause } : undefined
  );
}

function journalCorrupt(cause) {
  return new ImportBatchError(
    "JOURNAL_CORRUPT",
    "TaskSeal import batch failed integrity validation.",
    cause ? { cause } : undefined
  );
}

export class ImportBatchError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ImportBatchError";
    this.code = code;
  }
}
