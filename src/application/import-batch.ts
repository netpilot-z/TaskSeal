import {
  assertJsonWithinLimits,
  canonicalizeJson,
  digestCanonicalJson
} from "../lib/canonical-json.ts";
import {
  normalizeImportPlan,
  summarizeImportActions
} from "./import-plan.ts";
import type {
  ImportAction,
  ImportConflict,
  ImportPlan,
  ImportPlanEvent,
  ImportWarning
} from "./import-plan.ts";
import type { PolicyBinding } from "./import-policy.ts";

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

export interface ImportActor {
  type: string;
  id: string;
}

export interface ImportRecordSummary {
  eventIds: string[];
  skippedCodes: string[];
  warningCodes: string[];
}

export interface ImportBatchRecord {
  recordType: "import.batch";
  schemaVersion: 1;
  batchId: string;
  planDigest: string;
  snapshotDigest: string;
  mappingDigest: string;
  policyBinding: PolicyBinding;
  policyDigest: string;
  baseWorkflowDigest: string;
  actions: ImportAction[];
  conflictCodes: ImportConflict[];
  warningCodes: ImportWarning[];
  appliedAt: string;
  actor: ImportActor;
  outcome: "applied";
  events: ImportPlanEvent[];
  summary: ImportRecordSummary;
}

export interface ImportReceipt {
  batchId: string;
  planDigest: string;
  snapshotDigest: string;
  mappingDigest: string;
  policyDigest: string;
  baseWorkflowDigest: string;
  actor: ImportActor;
  appliedAt: string;
  outcome: "applied";
  eventIds: string[];
  skippedCodes: string[];
  warningCodes: string[];
}

export interface ValidatedImportBatch {
  record: ImportBatchRecord;
  recordDigest: string;
  plan: ImportPlan;
  receipt: ImportReceipt;
}

export function validateImportPlanForApply(
  plan: unknown,
  expectedPlanDigest: unknown
): ImportPlan {
  let normalized: ImportPlan;

  try {
    normalized = normalizeImportPlan(plan);
  } catch (error) {
    if (
      getErrorCode(error) === "IMPORT_PLAN_LIMIT_EXCEEDED"
    ) {
      throw error;
    }

    throw importPlanTampered(error);
  }

  if (
    !isDigest(expectedPlanDigest) ||
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
}: {
  plan: unknown;
  actor: unknown;
  appliedAt: unknown;
}): ImportBatchRecord {
  const normalizedPlan = validateImportPlanForApply(
    plan,
    readOptionalProperty(plan, "planDigest")
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

  const record: ImportBatchRecord = {
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

  return cloneCanonicalImportBatchRecord(record);
}

export function validateImportBatchRecord(
  record: unknown
): ValidatedImportBatch {
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

    safeRecord.actor = actor;
    safeRecord.policyBinding = plan.policyBinding;
    safeRecord.actions = plan.actions;
    safeRecord.conflictCodes = plan.conflicts;
    safeRecord.warningCodes = plan.warnings;
    safeRecord.events = plan.events;

    if (
      !isBoundImportBatchRecord(
        safeRecord,
        actor,
        plan
      )
    ) {
      throw journalCorrupt();
    }

    const normalizedRecord = safeRecord;

    return {
      record: normalizedRecord,
      recordDigest:
        computeImportBatchRecordDigest(normalizedRecord),
      plan,
      receipt: projectImportReceipt(normalizedRecord)
    };
  } catch (error) {
    if (getErrorCode(error) === "JOURNAL_CORRUPT") {
      throw error;
    }

    throw journalCorrupt(error);
  }
}

export function computeImportBatchRecordDigest(
  record: unknown
): string {
  return digestCanonicalJson(record);
}

export function projectImportReceipt(
  record: ImportBatchRecord
): ImportReceipt {
  return {
    actor: {
      id: record.actor.id,
      type: record.actor.type
    },
    appliedAt: record.appliedAt,
    baseWorkflowDigest: record.baseWorkflowDigest,
    batchId: record.batchId,
    eventIds: [...record.summary.eventIds],
    mappingDigest: record.mappingDigest,
    outcome: record.outcome,
    planDigest: record.planDigest,
    policyDigest: record.policyDigest,
    skippedCodes: [...record.summary.skippedCodes],
    snapshotDigest: record.snapshotDigest,
    warningCodes: [...record.summary.warningCodes]
  };
}

function buildRecordSummary(
  plan: ImportPlan
): ImportRecordSummary {
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

function normalizeActor(
  value: unknown,
  errorCode: string
): ImportActor {
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

function cloneBoundedRecord(record: unknown): unknown {
  let canonical: string;

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

  const parsed: unknown = JSON.parse(canonical);
  return parsed;
}

function cloneCanonicalImportBatchRecord(
  record: ImportBatchRecord
): ImportBatchRecord {
  const clone: unknown = JSON.parse(
    canonicalizeJson(record)
  );

  if (
    !isPlainRecord(clone) ||
    !isCanonicalImportBatchRecordClone(
      clone,
      record
    )
  ) {
    throw new TypeError(
      "Import batch canonical clone failed."
    );
  }

  return clone;
}

function isCanonicalImportBatchRecordClone(
  clone: unknown,
  source: ImportBatchRecord
): clone is ImportBatchRecord {
  return (
    isPlainRecord(clone) &&
    clone.recordType === source.recordType &&
    clone.schemaVersion === source.schemaVersion &&
    canonicalizeJson(clone) === canonicalizeJson(source)
  );
}

function isBoundImportBatchRecord(
  value: unknown,
  actor: ImportActor,
  plan: ImportPlan
): value is ImportBatchRecord {
  return (
    isPlainRecord(value) &&
    value.recordType === "import.batch" &&
    value.schemaVersion === 1 &&
    isDigest(value.planDigest) &&
    typeof value.batchId === "string" &&
    value.batchId === `import:${value.planDigest}` &&
    isDigest(value.snapshotDigest) &&
    isDigest(value.mappingDigest) &&
    value.policyBinding === plan.policyBinding &&
    isDigest(value.policyDigest) &&
    isDigest(value.baseWorkflowDigest) &&
    value.actions === plan.actions &&
    value.conflictCodes === plan.conflicts &&
    value.warningCodes === plan.warnings &&
    isTimestamp(value.appliedAt) &&
    value.actor === actor &&
    value.outcome === "applied" &&
    value.events === plan.events &&
    isPlainRecord(value.summary) &&
    canonicalizeJson(value.summary) ===
      canonicalizeJson(buildRecordSummary(plan))
  );
}

function isPlainRecord(
  value: unknown
): value is Record<string, unknown> {
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

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
): boolean {
  const keys = Reflect.ownKeys(value);

  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key) => keys.includes(key))
  );
}

function isDigest(value: unknown): value is string {
  return (
    typeof value === "string" &&
    DIGEST_PATTERN.test(value)
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    isBoundedString(value, ID_LIMIT) &&
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
    [...value].length <= maximumLength
  );
}

function importPlanTampered(
  cause?: unknown
): ImportBatchError {
  return new ImportBatchError(
    "IMPORT_PLAN_TAMPERED",
    "ImportPlan does not match the approved digest and schema.",
    cause ? { cause } : undefined
  );
}

function journalCorrupt(cause?: unknown): ImportBatchError {
  return new ImportBatchError(
    "JOURNAL_CORRUPT",
    "TaskSeal import batch failed integrity validation.",
    cause ? { cause } : undefined
  );
}

export class ImportBatchError extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ImportBatchError";
    this.code = code;
  }
}

function getErrorCode(error: unknown): unknown {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error
  )
    ? error.code
    : undefined;
}

function readOptionalProperty(
  value: unknown,
  key: string
): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }
  return Reflect.get(Object(value), key);
}
