import {
  digestCanonicalJson
} from "../lib/canonical-json.js";

const EVENT_ID_PREFIX = new Map([
  ["work_item.created", "create"],
  ["external_link.linked", "link"],
  ["external_link.observed", "observe"],
  ["work_item.updated", "update-title"],
  ["artifact.linked", "artifact"],
  ["evidence.recorded", "evidence"]
]);
const EVENT_IDENTITY_FIELDS = [
  "eventType",
  "workItemId",
  "providerObjectKey",
  "sourceRevisionId",
  "semanticTarget"
];

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

export class ImportPlanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ImportPlanError";
    this.code = code;
  }
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

function isNonEmptyString(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0
  );
}
