import {
  applyEvent,
  classifyProcessedEvent
} from "../domain/workflow.js";
import {
  canonicalizeJson,
  digestCanonicalJson
} from "../lib/canonical-json.js";
import {
  digestProviderFactContent
} from "../lib/provider-snapshot.js";
import {
  buildPolicyBinding
} from "./import-policy.js";
import {
  computeImportPlanDigest,
  deriveImportEventId
} from "./import-plan.js";

const SNAPSHOT_BYTE_LIMIT = 1024 * 1024;
const SNAPSHOT_DEPTH_LIMIT = 16;
const SNAPSHOT_FACT_LIMIT = 100;
const ARRAY_ITEM_LIMIT = 100;
const OBJECT_FIELD_LIMIT = 64;
const GENERAL_STRING_LIMIT = 4096;
const TITLE_LIMIT = 512;
const URL_LIMIT = 2048;
const ID_LIMIT = 256;
const EVIDENCE_LIMIT = 64;
const EVIDENCE_KEY_LIMIT = 128;
const MANAGED_FIELD_LIMIT = 8;
const CANDIDATE_EVENT_TYPES = new Set([
  "work_item.created",
  "artifact.linked",
  "evidence.recorded"
]);
const EVENT_TYPE_ORDER = new Map([
  ["work_item.created", 0],
  ["external_link.linked", 1],
  ["external_link.observed", 2],
  ["work_item.updated", 3],
  ["artifact.linked", 4],
  ["evidence.recorded", 5]
]);
const DIRECT_DOMAIN_CONFLICTS = new Set([
  "EVENT_ID_CONFLICT",
  "FIELD_AUTHORITY_CONFLICT",
  "PROVIDER_OBJECT_ALREADY_LINKED",
  "SOURCE_REVISION_CONTENT_CONFLICT",
  "SOURCE_REVISION_ORDER_AMBIGUOUS"
]);

export function parseProviderSnapshotJson(rawSnapshot) {
  if (typeof rawSnapshot !== "string") {
    throw snapshotInvalid();
  }

  if (
    Buffer.byteLength(rawSnapshot, "utf8") >
    SNAPSHOT_BYTE_LIMIT
  ) {
    throw snapshotLimit("snapshot bytes", SNAPSHOT_BYTE_LIMIT);
  }

  try {
    return JSON.parse(rawSnapshot);
  } catch {
    throw snapshotInvalid();
  }
}

export function previewSnapshotImport({
  snapshot,
  workflow,
  importPolicy
}) {
  const normalizedInput = normalizeProviderSnapshot(snapshot);
  const requiredObjectTypes = [
    ...new Set(
      normalizedInput.facts.map(
        (fact) => fact.sourceObject.objectType
      )
    )
  ].sort();
  const {
    policyBinding,
    policyDigest
  } = buildPolicyBinding({
    importPolicy,
    provider: normalizedInput.provider,
    scopeRef: normalizedInput.scope,
    requiredObjectTypes
  });
  const normalizedSnapshot = {
    ...normalizedInput,
    scope: policyBinding.scopeRef
  };
  const mappingDigest = digestCanonicalJson(
    normalizedSnapshot.mapping
  );
  const snapshotDigest = digestCanonicalJson({
    schemaVersion: normalizedSnapshot.schemaVersion,
    provider: normalizedSnapshot.provider,
    scope: normalizedSnapshot.scope,
    mapping: normalizedSnapshot.mapping,
    facts: normalizedSnapshot.facts
  });
  const baseWorkflowDigest = digestCanonicalJson(workflow);
  const planned = planSnapshotFacts({
    snapshot: normalizedSnapshot,
    workflow
  });
  const simulated = simulatePlannedEvents({
    workflow,
    actions: planned.actions,
    events: planned.events
  });
  const events = [...simulated.events].sort(compareEvents);
  const eventTypeById = new Map(
    events.map((event) => [event.eventId, event.type])
  );
  const actions = [...simulated.actions].sort(
    (left, right) =>
      compareActions(left, right, eventTypeById)
  );
  const conflicts = actions
    .filter((action) => action.kind === "conflict")
    .map((action) => {
      const conflict = {
        actionId: action.actionId,
        code: action.reasonCode
      };
      const domainCode = simulated.domainCodes.get(
        action.actionId
      );

      if (domainCode) {
        conflict.domainCode = domainCode;
      }

      return conflict;
    })
    .sort(compareCodeProjections);
  const warnings = actions
    .filter(
      (action) =>
        action.kind === "skip" &&
        action.reasonCode === "STALE_SOURCE_REVISION"
    )
    .map((action) => ({
      actionId: action.actionId,
      code: "STALE_SOURCE_REVISION"
    }))
    .sort(compareCodeProjections);
  const semanticPlan = {
    schemaVersion: 1,
    snapshotDigest,
    mappingDigest,
    policyDigest,
    baseWorkflowDigest,
    policyBinding,
    actions,
    events,
    conflicts,
    warnings
  };

  return {
    schemaVersion: 1,
    mode: "preview",
    snapshotDigest,
    mappingDigest,
    policyBinding,
    policyDigest,
    baseWorkflowDigest,
    planDigest: computeImportPlanDigest(semanticPlan),
    summary: summarizeActions(actions),
    actions,
    events,
    conflicts,
    warnings
  };
}

function normalizeProviderSnapshot(snapshot) {
  validateSnapshotTree(snapshot);

  if (snapshot.schemaVersion !== 2) {
    throw new SnapshotImportError(
      "SNAPSHOT_SCHEMA_NOT_IMPORTABLE",
      "Only ProviderSnapshot schema version 2 is importable."
    );
  }

  if (
    !isPlainRecord(snapshot) ||
    !hasExactKeys(snapshot, [
      "schemaVersion",
      "mode",
      "provider",
      "scope",
      "mapping",
      "capturedAt",
      "facts"
    ]) ||
    snapshot.mode !== "read-only" ||
    !["github", "linear"].includes(snapshot.provider) ||
    !isTimestamp(snapshot.capturedAt) ||
    codePointLength(snapshot.capturedAt) > ID_LIMIT ||
    !Array.isArray(snapshot.facts) ||
    snapshot.facts.length === 0
  ) {
    throw snapshotInvalid();
  }

  if (snapshot.facts.length > SNAPSHOT_FACT_LIMIT) {
    throw snapshotLimit("facts", SNAPSHOT_FACT_LIMIT);
  }

  const mapping = normalizeMapping(snapshot.mapping);
  const facts = snapshot.facts.map((fact) =>
    normalizeFact({
      fact,
      provider: snapshot.provider,
      scope: snapshot.scope,
      mapping
    })
  );
  const seenObjects = new Set();

  for (const fact of facts) {
    const objectKey = fact.sourceObject.providerObjectKey;

    if (seenObjects.has(objectKey)) {
      throw snapshotInvalid();
    }

    seenObjects.add(objectKey);
  }

  facts.sort(compareFacts);

  return {
    schemaVersion: 2,
    provider: snapshot.provider,
    scope: cloneRecord(snapshot.scope),
    mapping,
    facts
  };
}

function validateSnapshotTree(snapshot) {
  const ancestors = new Set();

  walkSnapshotValue(snapshot, {
    depth: 0,
    ancestors
  });

  let canonicalSnapshot;

  try {
    canonicalSnapshot = canonicalizeJson(snapshot, {
      maxDepth: SNAPSHOT_DEPTH_LIMIT
    });
  } catch (error) {
    if (error?.code === "CANONICAL_JSON_DEPTH_EXCEEDED") {
      throw snapshotLimit("snapshot depth", SNAPSHOT_DEPTH_LIMIT);
    }

    throw snapshotInvalid();
  }

  if (
    Buffer.byteLength(canonicalSnapshot, "utf8") >
    SNAPSHOT_BYTE_LIMIT
  ) {
    throw snapshotLimit("snapshot bytes", SNAPSHOT_BYTE_LIMIT);
  }
}

function walkSnapshotValue(value, {
  depth,
  ancestors
}) {
  if (typeof value === "string") {
    if (codePointLength(value) > GENERAL_STRING_LIMIT) {
      throw snapshotLimit(
        "snapshot string",
        GENERAL_STRING_LIMIT
      );
    }

    return;
  }

  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }

  if (
    !value ||
    typeof value !== "object" ||
    ancestors.has(value)
  ) {
    throw snapshotInvalid();
  }

  const nextDepth = depth + 1;

  if (nextDepth > SNAPSHOT_DEPTH_LIMIT) {
    throw snapshotLimit("snapshot depth", SNAPSHOT_DEPTH_LIMIT);
  }

  const keys = Reflect.ownKeys(value);
  const isArray = Array.isArray(value);

  if (
    keys.some((key) => typeof key !== "string")
  ) {
    throw snapshotInvalid();
  }

  if (isArray && value.length > ARRAY_ITEM_LIMIT) {
    throw snapshotLimit("array items", ARRAY_ITEM_LIMIT);
  }

  if (!isArray && keys.length > OBJECT_FIELD_LIMIT) {
    throw snapshotLimit("object fields", OBJECT_FIELD_LIMIT);
  }

  const prototype = Object.getPrototypeOf(value);
  const arrayKeys = isArray
    ? keys.filter((key) => key !== "length")
    : [];

  if (
    (!isArray &&
      prototype !== Object.prototype &&
      prototype !== null) ||
    (isArray &&
      (arrayKeys.length !== value.length ||
        arrayKeys.some(
          (key, index) => key !== String(index)
        )))
  ) {
    throw snapshotInvalid();
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  ancestors.add(value);

  try {
    for (const key of keys) {
      if (isArray && key === "length") {
        continue;
      }

      if (codePointLength(key) > GENERAL_STRING_LIMIT) {
        throw snapshotLimit(
          "snapshot string",
          GENERAL_STRING_LIMIT
        );
      }

      const descriptor = descriptors[key];

      if (
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        throw snapshotInvalid();
      }

      walkSnapshotValue(descriptor.value, {
        depth: nextDepth,
        ancestors
      });
    }
  } finally {
    ancestors.delete(value);
  }
}

function normalizeMapping(mapping) {
  if (
    !isPlainRecord(mapping) ||
    !hasAllowedAndRequiredKeys(
      mapping,
      ["workItemId", "requiredEvidence", "managedFields"],
      [
        "attemptId",
        "artifactId",
        "artifactRevision",
        "criterionKey"
      ]
    ) ||
    !isBoundedString(mapping.workItemId, ID_LIMIT)
  ) {
    throw snapshotInvalid();
  }

  const requiredEvidence = normalizeUniqueStrings(
    mapping.requiredEvidence,
    {
      maximumItems: EVIDENCE_LIMIT,
      maximumLength: EVIDENCE_KEY_LIMIT,
      allowedValues: null
    }
  );
  const managedFields = normalizeUniqueStrings(
    mapping.managedFields,
    {
      maximumItems: MANAGED_FIELD_LIMIT,
      maximumLength: ID_LIMIT,
      allowedValues: new Set(["title"]),
      allowEmpty: true
    }
  );
  const normalized = {
    workItemId: mapping.workItemId,
    requiredEvidence,
    managedFields
  };

  const hasArtifactId = mapping.artifactId !== undefined;
  const hasArtifactRevision =
    mapping.artifactRevision !== undefined;

  if (hasArtifactId !== hasArtifactRevision) {
    throw snapshotInvalid();
  }

  for (const field of [
    "attemptId",
    "artifactId",
    "artifactRevision",
    "criterionKey"
  ]) {
    if (mapping[field] !== undefined) {
      const maximumLength =
        field === "criterionKey"
          ? EVIDENCE_KEY_LIMIT
          : ID_LIMIT;

      if (!isBoundedString(mapping[field], maximumLength)) {
        throw snapshotInvalid();
      }

      normalized[field] = mapping[field];
    }
  }

  return normalized;
}

function normalizeUniqueStrings(value, {
  maximumItems,
  maximumLength,
  allowedValues,
  allowEmpty = false
}) {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximumItems ||
    new Set(value).size !== value.length ||
    value.some(
      (item) =>
        !isBoundedString(item, maximumLength) ||
        (allowedValues && !allowedValues.has(item))
    )
  ) {
    throw snapshotInvalid();
  }

  return [...value].sort();
}

function normalizeFact({
  fact,
  provider,
  scope,
  mapping
}) {
  if (
    !isPlainRecord(fact) ||
    !hasExactKeys(fact, [
      "sourceObject",
      "revision",
      "observed",
      "candidateEvent"
    ])
  ) {
    throw snapshotInvalid();
  }

  const sourceObject = normalizeSourceObject({
    value: fact.sourceObject,
    provider,
    scope
  });
  const revision = normalizeRevision(fact.revision);
  const observed = normalizeObserved(
    fact.observed,
    sourceObject.objectType
  );
  const candidateEvent = normalizeCandidateEvent({
    event: fact.candidateEvent,
    sourceObject,
    revision,
    observed,
    mapping
  });
  const normalized = {
    sourceObject,
    revision,
    observed,
    candidateEvent
  };

  if (
    digestProviderFactContent(normalized) !==
    revision.contentDigest
  ) {
    throw snapshotInvalid();
  }

  return normalized;
}

function normalizeSourceObject({
  value,
  provider,
  scope
}) {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "providerObjectKey",
      "provider",
      "objectType",
      "externalId",
      "url"
    ]) ||
    value.provider !== provider ||
    !isBoundedString(value.providerObjectKey, ID_LIMIT) ||
    !isBoundedString(value.externalId, ID_LIMIT) ||
    !isBoundedString(value.objectType, ID_LIMIT) ||
    !isBoundedString(value.url, URL_LIMIT)
  ) {
    throw snapshotInvalid();
  }

  if (provider === "github") {
    if (
      !["issue", "pull_request", "check"].includes(
        value.objectType
      ) ||
      !/^\d+$/.test(value.externalId) ||
      value.providerObjectKey !==
        `github:${value.objectType}:${value.externalId}`
    ) {
      throw snapshotInvalid();
    }
  } else if (
    provider === "linear" &&
    (value.objectType !== "issue" ||
      !isUuid(value.externalId) ||
      value.providerObjectKey !==
        `linear:issue:${value.externalId.toLowerCase()}`)
  ) {
    throw snapshotInvalid();
  }

  const url = normalizeProviderUrl({
    provider,
    objectType: value.objectType,
    url: value.url,
    scope
  });

  return {
    providerObjectKey: value.providerObjectKey.toLowerCase(),
    provider,
    objectType: value.objectType,
    externalId:
      provider === "linear"
        ? value.externalId.toLowerCase()
        : value.externalId,
    url
  };
}

function normalizeRevision(value) {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "occurredAt",
      "contentDigest"
    ]) ||
    !isBoundedString(value.id, ID_LIMIT) ||
    !isTimestamp(value.occurredAt) ||
    codePointLength(value.occurredAt) > ID_LIMIT ||
    !/^sha256:[0-9a-f]{64}$/.test(value.contentDigest)
  ) {
    throw snapshotInvalid();
  }

  return {
    id: value.id,
    occurredAt: value.occurredAt,
    contentDigest: value.contentDigest
  };
}

function normalizeObserved(value, objectType) {
  if (
    objectType === "issue" &&
    isPlainRecord(value) &&
    hasExactKeys(value, ["title", "createdAt"]) &&
    isBoundedString(value.title, TITLE_LIMIT) &&
    isTimestamp(value.createdAt) &&
    codePointLength(value.createdAt) <= ID_LIMIT
  ) {
    return {
      title: value.title,
      createdAt: value.createdAt
    };
  }

  if (
    objectType === "pull_request" &&
    isPlainRecord(value) &&
    hasExactKeys(value, ["headRevision"]) &&
    isBoundedString(value.headRevision, ID_LIMIT)
  ) {
    return {
      headRevision: value.headRevision
    };
  }

  if (
    objectType === "check" &&
    isPlainRecord(value) &&
    hasExactKeys(value, ["headRevision", "outcome"]) &&
    isBoundedString(value.headRevision, ID_LIMIT) &&
    ["passed", "failed"].includes(value.outcome)
  ) {
    return {
      headRevision: value.headRevision,
      outcome: value.outcome
    };
  }

  throw snapshotInvalid();
}

function normalizeCandidateEvent({
  event,
  sourceObject,
  revision,
  observed,
  mapping
}) {
  const expectedOccurredAt =
    sourceObject.objectType === "issue"
      ? observed.createdAt
      : revision.occurredAt;
  const expectedEventId = deriveProviderCandidateEventId({
    sourceObject,
    revision,
    observed
  });

  if (
    !isPlainRecord(event) ||
    !hasExactKeys(event, [
      "eventId",
      "workItemId",
      "type",
      "occurredAt",
      "payload"
    ]) ||
    !isBoundedString(event.eventId, ID_LIMIT) ||
    event.workItemId !== mapping.workItemId ||
    !CANDIDATE_EVENT_TYPES.has(event.type) ||
    !isTimestamp(event.occurredAt) ||
    codePointLength(event.occurredAt) > ID_LIMIT ||
    event.occurredAt !== expectedOccurredAt ||
    event.eventId !== expectedEventId
  ) {
    throw snapshotInvalid();
  }

  if (
    sourceObject.objectType === "issue" &&
    event.type === "work_item.created"
  ) {
    return normalizeWorkItemCandidate({
      event,
      sourceObject,
      observed,
      mapping
    });
  }

  if (
    sourceObject.objectType === "pull_request" &&
    event.type === "artifact.linked"
  ) {
    return normalizeArtifactCandidate({
      event,
      sourceObject,
      observed,
      mapping
    });
  }

  if (
    sourceObject.objectType === "check" &&
    event.type === "evidence.recorded"
  ) {
    return normalizeEvidenceCandidate({
      event,
      sourceObject,
      observed,
      mapping
    });
  }

  throw snapshotInvalid();
}

function deriveProviderCandidateEventId({
  sourceObject,
  revision,
  observed
}) {
  if (sourceObject.objectType === "issue") {
    return sourceObject.provider === "github"
      ? `github:issue-${sourceObject.externalId}:created`
      : `linear:${sourceObject.externalId}:created`;
  }

  if (sourceObject.objectType === "pull_request") {
    return [
      "github",
      `pr-${sourceObject.externalId}`,
      observed.headRevision,
      revision.occurredAt
    ].join(":");
  }

  return [
    "github",
    `check-${sourceObject.externalId}`,
    observed.headRevision
  ].join(":");
}

function normalizeWorkItemCandidate({
  event,
  sourceObject,
  observed,
  mapping
}) {
  const payload = event.payload;

  if (
    !isPlainRecord(payload) ||
    !hasExactKeys(payload, [
      "title",
      "requiredEvidence",
      "externalLink"
    ]) ||
    payload.title !== observed.title ||
    !sameStringSet(
      payload.requiredEvidence,
      mapping.requiredEvidence
    ) ||
    !isPlainRecord(payload.externalLink) ||
    !hasExactKeys(payload.externalLink, [
      "provider",
      "externalId",
      "url"
    ]) ||
    payload.externalLink.provider !== sourceObject.provider ||
    String(payload.externalLink.externalId) !==
      sourceObject.externalId ||
    payload.externalLink.url !== sourceObject.url
  ) {
    throw snapshotInvalid();
  }

  return {
    eventId: event.eventId,
    workItemId: event.workItemId,
    type: event.type,
    occurredAt: event.occurredAt,
    payload: {
      title: observed.title,
      requiredEvidence: [...mapping.requiredEvidence],
      externalLink: {
        provider: sourceObject.provider,
        externalId: sourceObject.externalId,
        url: sourceObject.url
      }
    }
  };
}

function normalizeArtifactCandidate({
  event,
  sourceObject,
  observed,
  mapping
}) {
  const payload = event.payload;

  if (
    !isBoundedString(mapping.attemptId, ID_LIMIT) ||
    !isBoundedString(mapping.artifactId, ID_LIMIT) ||
    !isBoundedString(
      mapping.artifactRevision,
      ID_LIMIT
    ) ||
    !isPlainRecord(payload) ||
    !hasExactKeys(payload, [
      "artifactId",
      "attemptId",
      "kind",
      "revision",
      "url"
    ]) ||
    !isBoundedString(payload.artifactId, ID_LIMIT) ||
    payload.artifactId !== mapping.artifactId ||
    payload.artifactId !==
      `pr-${sourceObject.externalId}` ||
    payload.attemptId !== mapping.attemptId ||
    payload.kind !== "pull_request" ||
    !isBoundedString(payload.revision, ID_LIMIT) ||
    payload.revision !== observed.headRevision ||
    payload.revision !== mapping.artifactRevision ||
    payload.url !== sourceObject.url
  ) {
    throw snapshotInvalid();
  }

  return {
    eventId: event.eventId,
    workItemId: event.workItemId,
    type: event.type,
    occurredAt: event.occurredAt,
    payload: {
      artifactId: payload.artifactId,
      attemptId: payload.attemptId,
      kind: "pull_request",
      revision: payload.revision,
      url: sourceObject.url
    }
  };
}

function normalizeEvidenceCandidate({
  event,
  sourceObject,
  observed,
  mapping
}) {
  const payload = event.payload;

  if (
    !isBoundedString(mapping.attemptId, ID_LIMIT) ||
    !isBoundedString(mapping.artifactId, ID_LIMIT) ||
    !isBoundedString(
      mapping.artifactRevision,
      ID_LIMIT
    ) ||
    !isBoundedString(
      mapping.criterionKey,
      EVIDENCE_KEY_LIMIT
    ) ||
    !isPlainRecord(payload) ||
    !hasExactKeys(payload, [
      "evidenceId",
      "attemptId",
      "artifactId",
      "revision",
      "criterionKey",
      "outcome",
      "url"
    ]) ||
    !isBoundedString(payload.evidenceId, ID_LIMIT) ||
    payload.evidenceId !==
      `check-${sourceObject.externalId}` ||
    payload.attemptId !== mapping.attemptId ||
    !isBoundedString(payload.artifactId, ID_LIMIT) ||
    payload.artifactId !== mapping.artifactId ||
    !isBoundedString(payload.revision, ID_LIMIT) ||
    payload.revision !== observed.headRevision ||
    payload.revision !== mapping.artifactRevision ||
    payload.criterionKey !== mapping.criterionKey ||
    !mapping.requiredEvidence.includes(payload.criterionKey) ||
    !["passed", "failed"].includes(payload.outcome) ||
    payload.outcome !== observed.outcome ||
    payload.url !== sourceObject.url
  ) {
    throw snapshotInvalid();
  }

  return {
    eventId: event.eventId,
    workItemId: event.workItemId,
    type: event.type,
    occurredAt: event.occurredAt,
    payload: {
      evidenceId: payload.evidenceId,
      attemptId: payload.attemptId,
      artifactId: payload.artifactId,
      revision: payload.revision,
      criterionKey: payload.criterionKey,
      outcome: payload.outcome,
      url: sourceObject.url
    }
  };
}

function normalizeProviderUrl({
  provider,
  objectType,
  url,
  scope
}) {
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    throw snapshotInvalid();
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    throw snapshotInvalid();
  }

  if (provider === "github") {
    const scopeMatch =
      /^github:repository:([^/]+)\/([^/]+)$/.exec(
        scope?.key
      );
    const pathSegments = parsed.pathname
      .split("/")
      .filter(Boolean);
    const expectedSegment =
      objectType === "issue"
        ? "issues"
        : objectType === "pull_request"
          ? "pull"
          : null;
    const matchesRepository =
      pathSegments[0]?.toLowerCase() ===
        scopeMatch?.[1]?.toLowerCase() &&
      pathSegments[1]?.toLowerCase() ===
        scopeMatch?.[2]?.toLowerCase();
    const matchesObjectPath = expectedSegment
      ? pathSegments.length === 4 &&
        matchesRepository &&
        pathSegments[2] === expectedSegment &&
        /^\d+$/.test(pathSegments[3])
      : objectType === "check" &&
        pathSegments.length >= 4 &&
        matchesRepository &&
        pathSegments[2] === "actions";

    if (
      parsed.hostname.toLowerCase() !== "github.com" ||
      !scopeMatch ||
      !matchesObjectPath
    ) {
      throw snapshotInvalid();
    }
  } else if (
    provider === "linear" &&
    (parsed.hostname.toLowerCase() !== "linear.app" ||
      !parsed.pathname.split("/").includes("issue"))
  ) {
    throw snapshotInvalid();
  }

  return parsed.href;
}

function planSnapshotFacts({
  snapshot,
  workflow
}) {
  const actions = [];
  const events = [];
  let projectedWorkflow = workflow;
  let providerIndex = buildProviderIndex(projectedWorkflow);

  for (const fact of snapshot.facts) {
    if (fact.sourceObject.objectType !== "issue") {
      continue;
    }

    const planned = planWorkItemFact({
      fact,
      snapshot,
      workflow: projectedWorkflow,
      providerIndex
    });
    actions.push(...planned.actions);
    events.push(...planned.events);
    projectedWorkflow = projectPlanningEvents(
      projectedWorkflow,
      planned.events
    );
    providerIndex = buildProviderIndex(projectedWorkflow);
  }

  for (const fact of snapshot.facts) {
    if (fact.sourceObject.objectType === "issue") {
      continue;
    }

    const planned = planCandidateFact({
      fact,
      snapshot,
      workflow: projectedWorkflow
    });
    actions.push(...planned.actions);
    events.push(...planned.events);
    projectedWorkflow = projectPlanningEvents(
      projectedWorkflow,
      planned.events
    );
  }

  return { actions, events };
}

function projectPlanningEvents(workflow, events) {
  let projected = workflow;

  for (const event of [...events].sort(compareEvents)) {
    try {
      projected = applyEvent(projected, event);
    } catch {
      // Final simulation converts the same failure into a stable conflict.
    }
  }

  return projected;
}

function planCandidateFact({
  fact,
  snapshot,
  workflow
}) {
  const candidateEvent = fact.candidateEvent;
  const candidateDecision = classifyProcessedEvent(
    workflow,
    candidateEvent
  );
  const semanticTarget =
    candidateEvent.type === "artifact.linked"
      ? "artifact"
      : "evidence";

  if (candidateDecision) {
    return {
      actions: [
        createAction({
          kind:
            candidateDecision === "EXACT_EVENT_DUPLICATE"
              ? "skip"
              : "conflict",
          reasonCode: candidateDecision,
          fact,
          mapping: snapshot.mapping,
          semanticTarget
        })
      ],
      events: []
    };
  }

  const event = createImportedEvent({
    type: candidateEvent.type,
    fact,
    mapping: snapshot.mapping,
    semanticTarget,
    occurredAt: candidateEvent.occurredAt,
    payload: cloneRecord(candidateEvent.payload)
  });
  const importedDecision = classifyProcessedEvent(
    workflow,
    event
  );

  if (importedDecision) {
    return {
      actions: [
        createAction({
          kind:
            importedDecision === "EXACT_EVENT_DUPLICATE"
              ? "skip"
              : "conflict",
          reasonCode: importedDecision,
          fact,
          mapping: snapshot.mapping,
          semanticTarget
        })
      ],
      events: []
    };
  }

  const action = createAction({
    kind:
      candidateEvent.type === "artifact.linked"
        ? "link"
        : "update",
    reasonCode:
      candidateEvent.type === "artifact.linked"
        ? "NEW_ARTIFACT"
        : "NEW_EVIDENCE",
    fact,
    mapping: snapshot.mapping,
    semanticTarget,
    event
  });

  return {
    actions: [action],
    events: [event]
  };
}

function planWorkItemFact({
  fact,
  snapshot,
  workflow,
  providerIndex
}) {
  const actions = [];
  const events = [];
  const mapping = snapshot.mapping;
  const objectKey = fact.sourceObject.providerObjectKey;
  const owner = providerIndex.get(objectKey);
  const workItem = workflow.workItems[mapping.workItemId];

  if (owner?.ambiguous) {
    actions.push(
      createAction({
        kind: "conflict",
        reasonCode: "PROVIDER_OBJECT_ALREADY_LINKED",
        fact,
        mapping,
        semanticTarget: "work-item"
      })
    );
    return { actions, events };
  }

  if (owner && owner.workItemId !== mapping.workItemId) {
    actions.push(
      createAction({
        kind: "conflict",
        reasonCode: "PROVIDER_OBJECT_ALREADY_LINKED",
        fact,
        mapping,
        semanticTarget: "work-item"
      })
    );
    return { actions, events };
  }

  if (
    workItem &&
    !sameStringSet(
      workItem.requiredEvidence,
      mapping.requiredEvidence
    )
  ) {
    actions.push(
      createAction({
        kind: "conflict",
        reasonCode: "WORK_ITEM_MAPPING_CONFLICT",
        fact,
        mapping,
        semanticTarget: "work-item"
      })
    );
    return { actions, events };
  }

  if (!workItem) {
    const event = createImportedEvent({
      type: "work_item.created",
      fact,
      mapping,
      semanticTarget: "work-item",
      occurredAt: fact.candidateEvent.occurredAt,
      payload: {
        title: fact.observed.title,
        requiredEvidence: [...mapping.requiredEvidence],
        externalLink: createRichLink({
          fact,
          snapshot
        })
      }
    });
    const action = createAction({
      kind: "create",
      reasonCode: "NEW_WORK_ITEM",
      fact,
      mapping,
      semanticTarget: "work-item",
      event
    });
    actions.push(action);
    events.push(event);
    return { actions, events };
  }

  if (!owner) {
    if (
      mapping.managedFields.includes("title") &&
      workItem.externalLinks.some((link) =>
        link.managedFields?.includes("title")
      )
    ) {
      actions.push(
        createAction({
          kind: "conflict",
          reasonCode: "FIELD_AUTHORITY_CONFLICT",
          fact,
          mapping,
          semanticTarget: "external-link"
        })
      );
      return { actions, events };
    }

    const linkEvent = createImportedEvent({
      type: "external_link.linked",
      fact,
      mapping,
      semanticTarget: "external-link",
      occurredAt: fact.revision.occurredAt,
      payload: {
        link: createRichLink({ fact, snapshot })
      }
    });
    actions.push(
      createAction({
        kind: "link",
        reasonCode: "NEW_EXTERNAL_LINK",
        fact,
        mapping,
        semanticTarget: "external-link",
        event: linkEvent
      })
    );
    events.push(linkEvent);

    if (
      mapping.managedFields.includes("title") &&
      workItem.title !== fact.observed.title
    ) {
      const update = createTitleUpdate({
        fact,
        mapping,
        before: workItem.title
      });
      actions.push(update.action);
      events.push(update.event);
    }

    return { actions, events };
  }

  const link = owner.link;

  if (link.legacy === true) {
    const observationEvent = createImportedEvent({
      type: "external_link.observed",
      fact,
      mapping,
      semanticTarget: "external-link-observation",
      occurredAt: fact.revision.occurredAt,
      payload: {
        providerObjectKey: objectKey,
        expectedRevisionId: null,
        baseline: {
          providerObjectKey: objectKey,
          objectType: fact.sourceObject.objectType,
          scopeRef: cloneRecord(snapshot.scope),
          managedFields: [...mapping.managedFields]
        },
        observation: createObservation(fact, {
          includeUrl: true
        })
      }
    });
    actions.push(
      createAction({
        kind: "refresh",
        reasonCode: "LEGACY_LINK_BASELINE",
        fact,
        mapping,
        semanticTarget: "external-link-observation",
        event: observationEvent
      })
    );
    events.push(observationEvent);

    if (
      mapping.managedFields.includes("title") &&
      workItem.title !== fact.observed.title
    ) {
      const update = createTitleUpdate({
        fact,
        mapping,
        before: workItem.title
      });
      actions.push(update.action);
      events.push(update.event);
    }

    return { actions, events };
  }

  if (
    !sameStringSet(link.managedFields, mapping.managedFields)
  ) {
    actions.push(
      createAction({
        kind: "conflict",
        reasonCode: "FIELD_AUTHORITY_CONFLICT",
        fact,
        mapping,
        semanticTarget: "external-link"
      })
    );
    return { actions, events };
  }

  if (
    !scopeRefsEqual(link.scopeRef, snapshot.scope) ||
    !link.lastObservation
  ) {
    actions.push(
      createAction({
        kind: "conflict",
        reasonCode: "SNAPSHOT_SCOPE_MISMATCH",
        fact,
        mapping,
        semanticTarget: "external-link"
      })
    );
    return { actions, events };
  }

  const current = link.lastObservation;
  const incoming = fact.revision;

  if (incoming.id === current.revisionId) {
    actions.push(
      createAction({
        kind:
          incoming.contentDigest === current.contentDigest
            ? "skip"
            : "conflict",
        reasonCode:
          incoming.contentDigest === current.contentDigest
            ? "EXACT_DUPLICATE"
            : "SOURCE_REVISION_CONTENT_CONFLICT",
        fact,
        mapping,
        semanticTarget: "external-link-observation"
      })
    );
    return { actions, events };
  }

  const incomingTime = Date.parse(incoming.occurredAt);
  const currentTime = Date.parse(current.occurredAt);

  if (incomingTime < currentTime) {
    actions.push(
      createAction({
        kind: "skip",
        reasonCode: "STALE_SOURCE_REVISION",
        fact,
        mapping,
        semanticTarget: "external-link-observation"
      })
    );
    return { actions, events };
  }

  if (incomingTime === currentTime) {
    actions.push(
      createAction({
        kind: "conflict",
        reasonCode: "SOURCE_REVISION_ORDER_AMBIGUOUS",
        fact,
        mapping,
        semanticTarget: "external-link-observation"
      })
    );
    return { actions, events };
  }

  const observationEvent = createImportedEvent({
    type: "external_link.observed",
    fact,
    mapping,
    semanticTarget: "external-link-observation",
    occurredAt: fact.revision.occurredAt,
    payload: {
      providerObjectKey: objectKey,
      expectedRevisionId: current.revisionId,
      observation: createObservation(fact, {
        includeUrl: true
      })
    }
  });
  actions.push(
    createAction({
      kind: "refresh",
      reasonCode: "NEW_SOURCE_REVISION",
      fact,
      mapping,
      semanticTarget: "external-link-observation",
      event: observationEvent
    })
  );
  events.push(observationEvent);

  if (
    link.managedFields.includes("title") &&
    workItem.title !== fact.observed.title
  ) {
    const update = createTitleUpdate({
      fact,
      mapping,
      before: workItem.title
    });
    actions.push(update.action);
    events.push(update.event);
  }

  return { actions, events };
}

function createTitleUpdate({
  fact,
  mapping,
  before
}) {
  const semanticTarget = "work-item-title";
  const event = createImportedEvent({
    type: "work_item.updated",
    fact,
    mapping,
    semanticTarget,
    occurredAt: fact.revision.occurredAt,
    payload: {
      source: {
        providerObjectKey:
          fact.sourceObject.providerObjectKey,
        revisionId: fact.revision.id,
        contentDigest: fact.revision.contentDigest
      },
      changes: {
        title: {
          before,
          after: fact.observed.title
        }
      }
    }
  });

  return {
    event,
    action: createAction({
      kind: "update",
      reasonCode: "MANAGED_TITLE_CHANGED",
      fact,
      mapping,
      semanticTarget,
      event
    })
  };
}

function createRichLink({
  fact,
  snapshot
}) {
  return {
    providerObjectKey: fact.sourceObject.providerObjectKey,
    provider: fact.sourceObject.provider,
    objectType: fact.sourceObject.objectType,
    externalId: fact.sourceObject.externalId,
    scopeRef: cloneRecord(snapshot.scope),
    url: fact.sourceObject.url,
    managedFields: [...snapshot.mapping.managedFields],
    lastObservation: createObservation(fact)
  };
}

function createObservation(fact, {
  includeUrl = false
} = {}) {
  const observation = {
    revisionId: fact.revision.id,
    occurredAt: fact.revision.occurredAt,
    contentDigest: fact.revision.contentDigest,
    title: fact.observed.title
  };

  if (includeUrl) {
    observation.url = fact.sourceObject.url;
  }

  return observation;
}

function createImportedEvent({
  type,
  fact,
  mapping,
  semanticTarget,
  occurredAt,
  payload
}) {
  return {
    eventId: deriveImportEventId({
      eventType: type,
      workItemId: mapping.workItemId,
      providerObjectKey:
        fact.sourceObject.providerObjectKey,
      sourceRevisionId: fact.revision.id,
      semanticTarget
    }),
    workItemId: mapping.workItemId,
    type,
    occurredAt,
    payload
  };
}

function createAction({
  kind,
  reasonCode,
  fact,
  mapping,
  semanticTarget,
  event
}) {
  const identity = {
    workItemId: mapping.workItemId,
    sourceObjectKey:
      fact.sourceObject.providerObjectKey,
    sourceRevisionId: fact.revision.id,
    semanticTarget
  };
  const action = {
    actionId: digestCanonicalJson(identity),
    kind,
    workItemId: mapping.workItemId,
    sourceObjectKey:
      fact.sourceObject.providerObjectKey,
    sourceRevisionId: fact.revision.id,
    semanticTarget,
    reasonCode,
    eventIds: event ? [event.eventId] : []
  };

  return action;
}

function simulatePlannedEvents({
  workflow,
  actions,
  events
}) {
  const sortedEvents = [...events].sort(compareEvents);
  const actionByEventId = new Map();

  for (const action of actions) {
    for (const eventId of action.eventIds) {
      actionByEventId.set(eventId, action);
    }
  }

  let projected = workflow;
  const rejectedEventIds = new Set();
  const replacementActions = new Map();
  const domainCodes = new Map();

  for (const event of sortedEvents) {
    try {
      projected = applyEvent(projected, event);
    } catch (error) {
      const original = actionByEventId.get(event.eventId);

      if (!original) {
        throw error;
      }

      const directConflict =
        DIRECT_DOMAIN_CONFLICTS.has(error?.code);
      replacementActions.set(
        original.actionId,
        {
          ...original,
          kind: "conflict",
          reasonCode: directConflict
            ? error.code
            : "DOMAIN_INVARIANT_VIOLATION",
          eventIds: []
        }
      );
      if (!directConflict) {
        domainCodes.set(
          original.actionId,
          error?.code ?? "UNKNOWN"
        );
      }
      rejectedEventIds.add(event.eventId);
    }
  }

  return {
    actions: actions.map(
      (action) =>
        replacementActions.get(action.actionId) ?? action
    ),
    events: sortedEvents.filter(
      (event) => !rejectedEventIds.has(event.eventId)
    ),
    domainCodes
  };
}

function buildProviderIndex(workflow) {
  const index = new Map();

  for (const workItem of Object.values(workflow.workItems)) {
    for (const link of workItem.externalLinks) {
      const existing = index.get(link.providerObjectKey);

      if (existing) {
        index.set(link.providerObjectKey, {
          ambiguous: true
        });
      } else {
        index.set(link.providerObjectKey, {
          workItemId: workItem.id,
          link
        });
      }
    }
  }

  return index;
}

function summarizeActions(actions) {
  const summary = {
    create: 0,
    link: 0,
    refresh: 0,
    update: 0,
    skip: 0,
    conflict: 0
  };

  for (const action of actions) {
    summary[action.kind] += 1;
  }

  return summary;
}

function compareFacts(left, right) {
  return (
    compareStrings(
      left.sourceObject.providerObjectKey,
      right.sourceObject.providerObjectKey
    ) ||
    compareStrings(
      left.revision.occurredAt,
      right.revision.occurredAt
    ) ||
    compareStrings(left.revision.id, right.revision.id) ||
    compareStrings(
      left.candidateEvent.eventId,
      right.candidateEvent.eventId
    )
  );
}

function compareEvents(left, right) {
  return (
    (EVENT_TYPE_ORDER.get(left.type) ?? 99) -
      (EVENT_TYPE_ORDER.get(right.type) ?? 99) ||
    compareStrings(left.occurredAt, right.occurredAt) ||
    compareStrings(left.eventId, right.eventId)
  );
}

function compareActions(
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

function compareCodeProjections(left, right) {
  return (
    compareStrings(left.actionId, right.actionId) ||
    compareStrings(left.code, right.code)
  );
}

function sameStringSet(left, right) {
  if (
    !Array.isArray(left) ||
    !Array.isArray(right) ||
    left.length !== right.length
  ) {
    return false;
  }

  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();

  return (
    normalizedLeft.every(
      (value, index) => value === normalizedRight[index]
    )
  );
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function scopeRefsEqual(left, right) {
  return (
    left?.kind === right?.kind &&
    left?.key === right?.key &&
    left?.parentKey === right?.parentKey
  );
}

function hasExactKeys(value, keys) {
  const actualKeys = Object.keys(value);

  return (
    actualKeys.length === keys.length &&
    actualKeys.every((key) => keys.includes(key))
  );
}

function hasAllowedAndRequiredKeys(
  value,
  requiredKeys,
  optionalKeys
) {
  const keys = Object.keys(value);
  const allowedKeys = new Set([
    ...requiredKeys,
    ...optionalKeys
  ]);

  return (
    requiredKeys.every((key) => keys.includes(key)) &&
    keys.every((key) => allowedKeys.has(key))
  );
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
  return prototype === Object.prototype || prototype === null;
}

function isTimestamp(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}

function isBoundedString(value, maximumLength) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    codePointLength(value) <= maximumLength
  );
}

function codePointLength(value) {
  return [...value].length;
}

function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}

function cloneRecord(value) {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      Array.isArray(item)
        ? [...item]
        : isPlainRecord(item)
          ? cloneRecord(item)
          : item
    ])
  );
}

function snapshotInvalid() {
  return new SnapshotImportError(
    "SNAPSHOT_INVALID",
    "ProviderSnapshot does not match the supported safe schema."
  );
}

function snapshotLimit(field, limit) {
  return new SnapshotImportError(
    "SNAPSHOT_LIMIT_EXCEEDED",
    `Snapshot ${field} exceeds limit ${limit}.`
  );
}

export class SnapshotImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SnapshotImportError";
    this.code = code;
  }
}
