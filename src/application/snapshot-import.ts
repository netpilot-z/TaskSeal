import {
  applyEvent,
  classifyProcessedEvent
} from "../domain/workflow.ts";
import type {
  ArtifactLinkedEvent,
  EvidenceRecordedEvent,
  ExternalLink,
  ExternalObservation,
  ManagedField,
  RichExternalLink,
  ScopeRef,
  Workflow,
  WorkItemCreatedEvent
} from "../domain/workflow.ts";
import {
  canonicalizeJson,
  digestCanonicalJson
} from "../lib/canonical-json.ts";
import {
  digestProviderFactContent
} from "../lib/provider-snapshot.ts";
import type {
  ProviderCheckFact,
  ProviderCheckObservation,
  ProviderFact,
  ProviderIssueFact,
  ProviderIssueObservation,
  ProviderObjectType,
  ProviderPullRequestFact,
  ProviderPullRequestObservation,
  ProviderRevision,
  ProviderSnapshotMapping,
  ProviderSourceObject
} from "../lib/provider-snapshot.ts";
import {
  buildPolicyBinding
} from "./import-policy.ts";
import type {
  ImportProvider,
  ProviderScopeRef
} from "./import-policy.ts";
import {
  DEFAULT_PROVIDER_INGRESS_REGISTRY,
  authorizeProviderIngress
} from "./provider-ingress-registry.ts";
import type {
  ProviderIngressRegistry
} from "./provider-ingress-registry.ts";
import {
  compareImportActions,
  compareImportCodeProjections,
  compareImportEvents,
  computeBaseWorkflowDigest,
  computeImportPlanDigest,
  deriveImportActionId,
  deriveImportEventId
} from "./import-plan.ts";
import type {
  ImportAction,
  ImportConflict,
  ImportEventType,
  ImportPlan,
  ImportPlanEvent,
  ImportPlanSummary,
  ImportWarning
} from "./import-plan.ts";

interface UnboundNormalizedSnapshot {
  schemaVersion: 2;
  provider: ImportProvider;
  scope: unknown;
  mapping: ProviderSnapshotMapping;
  facts: ProviderFact[];
}

interface AuthorizedSnapshot
  extends Omit<UnboundNormalizedSnapshot, "scope"> {
  scope: ProviderScopeRef;
}

interface PlanningResult {
  actions: ImportAction[];
  events: ImportPlanEvent[];
}

interface SimulationResult extends PlanningResult {
  domainCodes: Map<string, string>;
}

interface WalkSnapshotOptions {
  depth: number;
  ancestors: Set<object>;
}

interface NormalizeUniqueStringsOptions {
  maximumItems: number;
  maximumLength: number;
  allowedValues: ReadonlySet<string> | null;
  allowEmpty?: boolean | undefined;
}

interface CandidateEventEnvelope {
  eventId: string;
  workItemId: string;
  type:
    | "work_item.created"
    | "artifact.linked"
    | "evidence.recorded";
  occurredAt: string;
  payload: unknown;
}

interface OwnedProviderEntry {
  kind: "owned";
  workItemId: string;
  link: ExternalLink;
}

interface AmbiguousProviderEntry {
  kind: "ambiguous";
}

type ProviderIndexEntry =
  | OwnedProviderEntry
  | AmbiguousProviderEntry;

type ProviderIndex = Map<string, ProviderIndexEntry>;

interface CreatedActionAndEvent {
  action: ImportAction;
  event: ImportPlanEvent;
}

const SNAPSHOT_BYTE_LIMIT = 1024 * 1024;
const SNAPSHOT_DEPTH_LIMIT = 16;
const SNAPSHOT_FACT_LIMIT = 100;
const ARRAY_ITEM_LIMIT = 100;
const OBJECT_FIELD_LIMIT = 64;
const GENERAL_STRING_LIMIT = 4096;
const TITLE_LIMIT = 512;
const URL_LIMIT = 2048;
const ID_LIMIT = 256;
const PROVIDER_ID_LIMIT = 512;
const EVIDENCE_LIMIT = 64;
const EVIDENCE_KEY_LIMIT = 128;
const MANAGED_FIELD_LIMIT = 8;
const CANDIDATE_EVENT_TYPES = new Set<
  CandidateEventEnvelope["type"]
>([
  "work_item.created",
  "artifact.linked",
  "evidence.recorded"
]);
const DIRECT_DOMAIN_CONFLICTS: ReadonlySet<string> = new Set([
  "EVENT_ID_CONFLICT",
  "FIELD_AUTHORITY_CONFLICT",
  "PROVIDER_OBJECT_ALREADY_LINKED",
  "SOURCE_REVISION_CONTENT_CONFLICT",
  "SOURCE_REVISION_ORDER_AMBIGUOUS"
]);

export function parseProviderSnapshotJson(
  rawSnapshot: unknown
): unknown {
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
  importPolicy,
  providerIngressRegistry =
    DEFAULT_PROVIDER_INGRESS_REGISTRY
}: {
  snapshot: unknown;
  workflow: Workflow;
  importPolicy: unknown;
  providerIngressRegistry?: ProviderIngressRegistry | undefined;
}): ImportPlan {
  const normalizedInput = normalizeProviderSnapshot(snapshot);
  const requiredObjectTypes = [
    ...new Set(
      normalizedInput.facts.map(
        (fact) => fact.sourceObject.objectType
      )
    )
  ].sort();
  authorizeProviderIngress({
    registry: providerIngressRegistry,
    provider: normalizedInput.provider,
    scopeRef: normalizedInput.scope,
    requiredObjectTypes
  });
  const {
    previewAllowed,
    policyBinding,
    policyDigest
  } = buildPolicyBinding({
    importPolicy,
    provider: normalizedInput.provider,
    scopeRef: normalizedInput.scope,
    requiredObjectTypes
  });
  if (!previewAllowed) {
    throw new SnapshotImportError(
      "IMPORT_PREVIEW_FORBIDDEN",
      "ImportPolicy does not allow snapshot preview for this scope."
    );
  }
  const normalizedSnapshot: AuthorizedSnapshot = {
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
  const baseWorkflowDigest =
    computeBaseWorkflowDigest(workflow);
  const planned = planSnapshotFacts({
    snapshot: normalizedSnapshot,
    workflow
  });
  const simulated = simulatePlannedEvents({
    workflow,
    actions: planned.actions,
    events: planned.events
  });
  const events = [...simulated.events].sort(
    compareImportEvents
  );
  const eventTypeById = new Map<string, ImportEventType>(
    events.map((event) => [event.eventId, event.type])
  );
  const actions = [...simulated.actions].sort(
    (left, right) =>
      compareImportActions(
        left,
        right,
        eventTypeById
      )
  );
  const conflicts = actions
    .filter((action) => action.kind === "conflict")
    .map((action) => {
      const conflict: ImportConflict = {
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
    .sort(compareImportCodeProjections);
  const warnings: ImportWarning[] = actions
    .filter(
      (action) =>
        action.kind === "skip" &&
        action.reasonCode === "STALE_SOURCE_REVISION"
    )
    .map((action) => ({
      actionId: action.actionId,
      code: "STALE_SOURCE_REVISION"
    }))
    .sort(compareImportCodeProjections);
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

function normalizeProviderSnapshot(
  snapshot: unknown
): UnboundNormalizedSnapshot {
  validateSnapshotTree(snapshot);

  if (!isPlainRecord(snapshot)) {
    throw snapshotInvalid();
  }

  if (snapshot.schemaVersion !== 2) {
    throw new SnapshotImportError(
      "SNAPSHOT_SCHEMA_NOT_IMPORTABLE",
      "Only ProviderSnapshot schema version 2 is importable."
    );
  }

  if (
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
    !isBoundedString(snapshot.provider, ID_LIMIT) ||
    !isTimestamp(snapshot.capturedAt) ||
    codePointLength(snapshot.capturedAt) > ID_LIMIT ||
    !Array.isArray(snapshot.facts) ||
    snapshot.facts.length === 0
  ) {
    throw snapshotInvalid();
  }

  if (!isImportProvider(snapshot.provider)) {
    throw new SnapshotImportError(
      "SNAPSHOT_PROVIDER_NOT_IMPORTABLE",
      "The snapshot provider is readable but not enabled for import."
    );
  }

  if (snapshot.facts.length > SNAPSHOT_FACT_LIMIT) {
    throw snapshotLimit("facts", SNAPSHOT_FACT_LIMIT);
  }

  const provider =
    normalizeImportProvider(snapshot.provider);
  const mapping = normalizeMapping(snapshot.mapping);
  const facts = snapshot.facts.map((fact) =>
    normalizeFact({
      fact,
      provider,
      scope: snapshot.scope,
      mapping
    })
  );
  const seenObjects = new Set<string>();

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
    provider,
    scope: snapshot.scope,
    mapping,
    facts
  };
}

function validateSnapshotTree(snapshot: unknown): void {
  const ancestors = new Set<object>();

  walkSnapshotValue(snapshot, {
    depth: 0,
    ancestors
  });

  let canonicalSnapshot: string;

  try {
    canonicalSnapshot = canonicalizeJson(snapshot, {
      maxDepth: SNAPSHOT_DEPTH_LIMIT
    });
  } catch (error) {
    if (
      getErrorCode(error) ===
      "CANONICAL_JSON_DEPTH_EXCEEDED"
    ) {
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

function walkSnapshotValue(value: unknown, {
  depth,
  ancestors
}: WalkSnapshotOptions): void {
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

  for (const key of keys) {
    if (typeof key !== "string") {
      throw snapshotInvalid();
    }
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

  ancestors.add(value);

  try {
    for (const key of keys) {
      if (isArray && key === "length") {
        continue;
      }

      if (typeof key !== "string") {
        throw snapshotInvalid();
      }

      if (codePointLength(key) > GENERAL_STRING_LIMIT) {
        throw snapshotLimit(
          "snapshot string",
          GENERAL_STRING_LIMIT
        );
      }

      const descriptor =
        Object.getOwnPropertyDescriptor(value, key);

      if (
        !descriptor ||
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

function normalizeMapping(
  mapping: unknown
): ProviderSnapshotMapping {
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
  const managedFields =
    normalizeManagedFields(mapping.managedFields);
  const normalized: ProviderSnapshotMapping = {
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

  if (mapping.attemptId !== undefined) {
    if (!isBoundedString(mapping.attemptId, ID_LIMIT)) {
      throw snapshotInvalid();
    }
    normalized.attemptId = mapping.attemptId;
  }

  if (mapping.artifactId !== undefined) {
    if (!isBoundedString(mapping.artifactId, ID_LIMIT)) {
      throw snapshotInvalid();
    }
    normalized.artifactId = mapping.artifactId;
  }

  if (mapping.artifactRevision !== undefined) {
    if (
      !isBoundedString(
        mapping.artifactRevision,
        ID_LIMIT
      )
    ) {
      throw snapshotInvalid();
    }
    normalized.artifactRevision =
      mapping.artifactRevision;
  }

  if (mapping.criterionKey !== undefined) {
    if (
      !isBoundedString(
        mapping.criterionKey,
        EVIDENCE_KEY_LIMIT
      )
    ) {
      throw snapshotInvalid();
    }
    normalized.criterionKey = mapping.criterionKey;
  }

  return normalized;
}

function normalizeUniqueStrings(value: unknown, {
  maximumItems,
  maximumLength,
  allowedValues,
  allowEmpty = false
}: NormalizeUniqueStringsOptions): string[] {
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

function normalizeManagedFields(
  value: unknown
): ManagedField[] {
  const fields = normalizeUniqueStrings(value, {
    maximumItems: MANAGED_FIELD_LIMIT,
    maximumLength: ID_LIMIT,
    allowedValues: new Set(["title"]),
    allowEmpty: true
  });

  if (!fields.every(isManagedField)) {
    throw snapshotInvalid();
  }

  return fields;
}

function normalizeFact({
  fact,
  provider,
  scope,
  mapping
}: {
  fact: unknown;
  provider: ImportProvider;
  scope: unknown;
  mapping: ProviderSnapshotMapping;
}): ProviderFact {
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

  if (sourceObject.objectType === "issue") {
    const issueSource: ProviderIssueFact["sourceObject"] = {
      ...sourceObject,
      objectType: "issue"
    };
    const observed =
      normalizeIssueObservation(fact.observed);
    return verifyFactDigest({
      sourceObject: issueSource,
      revision,
      observed,
      candidateEvent: normalizeWorkItemCandidate({
        event: fact.candidateEvent,
        sourceObject: issueSource,
        revision,
        observed,
        mapping,
        scope
      })
    });
  }

  if (
    sourceObject.provider === "github" &&
    sourceObject.objectType === "pull_request"
  ) {
    const pullRequestSource:
      ProviderPullRequestFact["sourceObject"] = {
      ...sourceObject,
      provider: "github",
      objectType: "pull_request"
    };
    const observed =
      normalizePullRequestObservation(fact.observed);
    return verifyFactDigest({
      sourceObject: pullRequestSource,
      revision,
      observed,
      candidateEvent: normalizeArtifactCandidate({
        event: fact.candidateEvent,
        sourceObject: pullRequestSource,
        revision,
        observed,
        mapping
      })
    });
  }

  if (
    sourceObject.provider === "github" &&
    sourceObject.objectType === "check"
  ) {
    const checkSource:
      ProviderCheckFact["sourceObject"] = {
      ...sourceObject,
      provider: "github",
      objectType: "check"
    };
    const observed =
      normalizeCheckObservation(fact.observed);
    return verifyFactDigest({
      sourceObject: checkSource,
      revision,
      observed,
      candidateEvent: normalizeEvidenceCandidate({
        event: fact.candidateEvent,
        sourceObject: checkSource,
        revision,
        observed,
        mapping
      })
    });
  }

  throw snapshotInvalid();
}

function verifyFactDigest<T extends ProviderFact>(
  fact: T
): T {
  if (
    digestProviderFactContent(fact) !==
    fact.revision.contentDigest
  ) {
    throw snapshotInvalid();
  }

  return fact;
}

function normalizeSourceObject({
  value,
  provider,
  scope
}: {
  value: unknown;
  provider: ImportProvider;
  scope: unknown;
}): ProviderSourceObject {
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
    !isBoundedString(
      value.providerObjectKey,
      PROVIDER_ID_LIMIT
    ) ||
    !isBoundedString(value.externalId, PROVIDER_ID_LIMIT) ||
    !isProviderObjectType(value.objectType) ||
    !isBoundedString(value.url, URL_LIMIT)
  ) {
    throw snapshotInvalid();
  }

  if (provider === "github") {
    if (
      !/^\d+$/.test(value.externalId) ||
      value.providerObjectKey !==
        `github:${value.objectType}:${value.externalId}`
    ) {
      throw snapshotInvalid();
    }
    return {
      providerObjectKey:
        value.providerObjectKey.toLowerCase(),
      provider: "github",
      objectType: value.objectType,
      externalId: value.externalId,
      url: normalizeProviderUrl({
        provider: "github",
        objectType: value.objectType,
        externalId: value.externalId,
        url: value.url,
        scope
      })
    };
  }

  if (provider === "gitee") {
    const repository = normalizeGiteeScopeRepository(scope);
    const prefix = `${repository}#`;
    const issueReference =
      value.externalId.startsWith(prefix)
        ? value.externalId.slice(prefix.length)
        : "";

    if (
      value.objectType !== "issue" ||
      !isGiteeIssueReference(issueReference) ||
      value.providerObjectKey !==
        `gitee:issue:${value.externalId}`
    ) {
      throw snapshotInvalid();
    }

    return {
      providerObjectKey: value.providerObjectKey,
      provider: "gitee",
      objectType: "issue",
      externalId: value.externalId,
      url: normalizeProviderUrl({
        provider: "gitee",
        objectType: "issue",
        externalId: value.externalId,
        url: value.url,
        scope
      })
    };
  }

  if (
    value.objectType !== "issue" ||
      !isUuid(value.externalId) ||
      value.providerObjectKey !==
        `linear:issue:${value.externalId.toLowerCase()}`
  ) {
    throw snapshotInvalid();
  }

  return {
    providerObjectKey: value.providerObjectKey.toLowerCase(),
    provider: "linear",
    objectType: "issue",
    externalId: value.externalId.toLowerCase(),
    url: normalizeProviderUrl({
      provider: "linear",
      objectType: "issue",
      externalId: value.externalId,
      url: value.url,
      scope
    })
  };
}

function normalizeRevision(
  value: unknown
): ProviderRevision {
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
    !isDigest(value.contentDigest)
  ) {
    throw snapshotInvalid();
  }

  return {
    id: value.id,
    occurredAt: value.occurredAt,
    contentDigest: value.contentDigest
  };
}

function normalizeIssueObservation(
  value: unknown
): ProviderIssueObservation {
  if (
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

  throw snapshotInvalid();
}

function normalizePullRequestObservation(
  value: unknown
): ProviderPullRequestObservation {
  if (
    isPlainRecord(value) &&
    hasExactKeys(value, ["headRevision"]) &&
    isBoundedString(value.headRevision, ID_LIMIT)
  ) {
    return {
      headRevision: value.headRevision
    };
  }

  throw snapshotInvalid();
}

function normalizeCheckObservation(
  value: unknown
): ProviderCheckObservation {
  if (
    isPlainRecord(value) &&
    hasExactKeys(value, ["headRevision", "outcome"]) &&
    isBoundedString(value.headRevision, ID_LIMIT) &&
    isEvidenceOutcome(value.outcome)
  ) {
    return {
      headRevision: value.headRevision,
      outcome: value.outcome
    };
  }

  throw snapshotInvalid();
}

function normalizeCandidateEventEnvelope({
  event,
  mapping,
  expectedType,
  expectedOccurredAt,
  expectedEventId
}: {
  event: unknown;
  mapping: ProviderSnapshotMapping;
  expectedType: CandidateEventEnvelope["type"];
  expectedOccurredAt: string;
  expectedEventId: string;
}): CandidateEventEnvelope {
  if (
    !isPlainRecord(event) ||
    !hasExactKeys(event, [
      "eventId",
      "workItemId",
      "type",
      "occurredAt",
      "payload"
    ]) ||
    !isBoundedString(
      event.eventId,
      PROVIDER_ID_LIMIT
    ) ||
    event.workItemId !== mapping.workItemId ||
    event.type !== expectedType ||
    !CANDIDATE_EVENT_TYPES.has(expectedType) ||
    !isTimestamp(event.occurredAt) ||
    codePointLength(event.occurredAt) > ID_LIMIT ||
    event.occurredAt !== expectedOccurredAt ||
    event.eventId !== expectedEventId
  ) {
    throw snapshotInvalid();
  }

  return {
    eventId: event.eventId,
    workItemId: mapping.workItemId,
    type: expectedType,
    occurredAt: event.occurredAt,
    payload: event.payload
  };
}

function normalizeWorkItemCandidate({
  event,
  sourceObject,
  revision,
  observed,
  mapping,
  scope
}: {
  event: unknown;
  sourceObject: ProviderIssueFact["sourceObject"];
  revision: ProviderRevision;
  observed: ProviderIssueObservation;
  mapping: ProviderSnapshotMapping;
  scope: unknown;
}): WorkItemCreatedEvent {
  const expectedEventId =
    sourceObject.provider === "github"
      ? `github:issue-${sourceObject.externalId}:created`
      : sourceObject.provider === "linear"
        ? `linear:${sourceObject.externalId}:created`
        : `gitee:issue:${sourceObject.externalId}:created`;
  const candidate = normalizeCandidateEventEnvelope({
    event,
    mapping,
    expectedType: "work_item.created",
    expectedOccurredAt: observed.createdAt,
    expectedEventId
  });
  const payload = candidate.payload;

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
    )
  ) {
    throw snapshotInvalid();
  }

  if (sourceObject.provider === "gitee") {
    const expectedLink: RichExternalLink = {
      providerObjectKey: sourceObject.providerObjectKey,
      provider: "gitee",
      objectType: "issue",
      externalId: sourceObject.externalId,
      scopeRef: normalizeGiteeScopeRef(scope),
      url: sourceObject.url,
      managedFields: [...mapping.managedFields],
      lastObservation: {
        revisionId: revision.id,
        occurredAt: revision.occurredAt,
        contentDigest: revision.contentDigest,
        title: observed.title
      }
    };

    if (
      canonicalizeJson(payload.externalLink) !==
      canonicalizeJson(expectedLink)
    ) {
      throw snapshotInvalid();
    }

    return {
      eventId: candidate.eventId,
      workItemId: candidate.workItemId,
      type: "work_item.created",
      occurredAt: candidate.occurredAt,
      payload: {
        title: observed.title,
        requiredEvidence: [...mapping.requiredEvidence],
        externalLink: expectedLink
      }
    };
  }

  if (
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
    eventId: candidate.eventId,
    workItemId: candidate.workItemId,
    type: "work_item.created",
    occurredAt: candidate.occurredAt,
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
  revision,
  observed,
  mapping
}: {
  event: unknown;
  sourceObject: ProviderPullRequestFact["sourceObject"];
  revision: ProviderRevision;
  observed: ProviderPullRequestObservation;
  mapping: ProviderSnapshotMapping;
}): ArtifactLinkedEvent {
  const candidate = normalizeCandidateEventEnvelope({
    event,
    mapping,
    expectedType: "artifact.linked",
    expectedOccurredAt: revision.occurredAt,
    expectedEventId: [
      "github",
      `pr-${sourceObject.externalId}`,
      observed.headRevision,
      revision.occurredAt
    ].join(":")
  });
  const payload = candidate.payload;

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
    eventId: candidate.eventId,
    workItemId: candidate.workItemId,
    type: "artifact.linked",
    occurredAt: candidate.occurredAt,
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
  revision,
  observed,
  mapping
}: {
  event: unknown;
  sourceObject: ProviderCheckFact["sourceObject"];
  revision: ProviderRevision;
  observed: ProviderCheckObservation;
  mapping: ProviderSnapshotMapping;
}): EvidenceRecordedEvent {
  const candidate = normalizeCandidateEventEnvelope({
    event,
    mapping,
    expectedType: "evidence.recorded",
    expectedOccurredAt: revision.occurredAt,
    expectedEventId: [
      "github",
      `check-${sourceObject.externalId}`,
      observed.headRevision
    ].join(":")
  });
  const payload = candidate.payload;

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
    !isEvidenceOutcome(payload.outcome) ||
    payload.outcome !== observed.outcome ||
    payload.url !== sourceObject.url
  ) {
    throw snapshotInvalid();
  }

  return {
    eventId: candidate.eventId,
    workItemId: candidate.workItemId,
    type: "evidence.recorded",
    occurredAt: candidate.occurredAt,
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

function normalizeGiteeScopeRef(
  value: unknown
): ProviderScopeRef {
  return {
    kind: "repository",
    key:
      `gitee:repository:${normalizeGiteeScopeRepository(value)}`
  };
}

function normalizeGiteeScopeRepository(
  value: unknown
): string {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["kind", "key"]) ||
    value.kind !== "repository" ||
    typeof value.key !== "string"
  ) {
    throw snapshotInvalid();
  }

  const match =
    /^gitee:repository:([^/]+)\/([^/]+)$/.exec(value.key);
  const owner = match?.[1]?.toLowerCase();
  const repository = match?.[2]?.toLowerCase();

  if (
    !owner ||
    !repository ||
    !isGiteeRepositoryPart(owner) ||
    !isGiteeRepositoryPart(repository)
  ) {
    throw snapshotInvalid();
  }

  return `${owner}/${repository}`;
}

function isGiteeRepositoryPart(value: string): boolean {
  return (
    value.length <= 100 &&
    value !== "." &&
    value !== ".." &&
    /^[a-z0-9_.-]+$/.test(value)
  );
}

function isGiteeIssueReference(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value);
}

function normalizeProviderUrl({
  provider,
  objectType,
  externalId,
  url,
  scope
}: {
  provider: ImportProvider;
  objectType: ProviderObjectType;
  externalId: string;
  url: string;
  scope: unknown;
}): string {
  let parsed: URL;

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
    const scopeKey =
      isPlainRecord(scope) &&
      typeof scope.key === "string"
        ? scope.key
        : "";
    const scopeMatch =
      /^github:repository:([^/]+)\/([^/]+)$/.exec(
        scopeKey
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
    const objectNumber = pathSegments[3];
    const matchesRepository =
      pathSegments[0]?.toLowerCase() ===
        scopeMatch?.[1]?.toLowerCase() &&
      pathSegments[1]?.toLowerCase() ===
        scopeMatch?.[2]?.toLowerCase();
    const matchesObjectPath = expectedSegment
      ? pathSegments.length === 4 &&
        matchesRepository &&
        pathSegments[2] === expectedSegment &&
        typeof objectNumber === "string" &&
        /^\d+$/.test(objectNumber)
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
  } else if (provider === "gitee") {
    const repository = normalizeGiteeScopeRepository(scope);
    const issueReference = externalId.startsWith(
      `${repository}#`
    )
      ? externalId.slice(repository.length + 1)
      : "";
    const [owner, name] = repository.split("/");
    const pathSegments = parsed.pathname.split("/");

    if (
      parsed.hostname.toLowerCase() !== "gitee.com" ||
      pathSegments.length !== 5 ||
      pathSegments[0] !== "" ||
      pathSegments[1]?.toLowerCase() !== owner ||
      pathSegments[2]?.toLowerCase() !== name ||
      pathSegments[3] !== "issues" ||
      pathSegments[4] !== issueReference ||
      !isGiteeIssueReference(issueReference)
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
}: {
  snapshot: AuthorizedSnapshot;
  workflow: Workflow;
}): PlanningResult {
  const actions: ImportAction[] = [];
  const events: ImportPlanEvent[] = [];
  let projectedWorkflow = workflow;
  let providerIndex = buildProviderIndex(projectedWorkflow);

  for (const fact of snapshot.facts) {
    if (!isProviderIssueFact(fact)) {
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
    if (!isDeliveryFact(fact)) {
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

function projectPlanningEvents(
  workflow: Workflow,
  events: readonly ImportPlanEvent[]
): Workflow {
  let projected = workflow;

  for (
    const event of [...events].sort(compareImportEvents)
  ) {
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
}: {
  fact: ProviderPullRequestFact | ProviderCheckFact;
  snapshot: AuthorizedSnapshot;
  workflow: Workflow;
}): PlanningResult {
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
    payload: cloneCandidatePayload(candidateEvent)
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
}: {
  fact: ProviderIssueFact;
  snapshot: AuthorizedSnapshot;
  workflow: Workflow;
  providerIndex: ProviderIndex;
}): PlanningResult {
  const actions: ImportAction[] = [];
  const events: ImportPlanEvent[] = [];
  const mapping = snapshot.mapping;
  const objectKey = fact.sourceObject.providerObjectKey;
  const owner = providerIndex.get(objectKey);
  const workItem = workflow.workItems[mapping.workItemId];

  if (owner?.kind === "ambiguous") {
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
    owner?.kind === "owned" &&
    owner.workItemId !== mapping.workItemId
  ) {
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

  if (owner.kind !== "owned") {
    throw snapshotInvalid();
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
          scopeRef: cloneScopeRef(snapshot.scope),
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
}: {
  fact: ProviderIssueFact;
  mapping: ProviderSnapshotMapping;
  before: string;
}): CreatedActionAndEvent {
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
}: {
  fact: ProviderIssueFact;
  snapshot: AuthorizedSnapshot;
}): RichExternalLink {
  return {
    providerObjectKey: fact.sourceObject.providerObjectKey,
    provider: fact.sourceObject.provider,
    objectType: fact.sourceObject.objectType,
    externalId: fact.sourceObject.externalId,
    scopeRef: cloneScopeRef(snapshot.scope),
    url: fact.sourceObject.url,
    managedFields: [...snapshot.mapping.managedFields],
    lastObservation: createObservation(fact)
  };
}

function createObservation(fact: ProviderIssueFact, {
  includeUrl = false
}: {
  includeUrl?: boolean | undefined;
} = {}): ExternalObservation {
  const observation: ExternalObservation = {
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
}: {
  type: ImportEventType;
  fact: ProviderFact;
  mapping: ProviderSnapshotMapping;
  semanticTarget: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}): ImportPlanEvent {
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
}: {
  kind: ImportAction["kind"];
  reasonCode: string;
  fact: ProviderFact;
  mapping: ProviderSnapshotMapping;
  semanticTarget: string;
  event?: ImportPlanEvent | undefined;
}): ImportAction {
  const identity = {
    workItemId: mapping.workItemId,
    sourceObjectKey:
      fact.sourceObject.providerObjectKey,
    sourceRevisionId: fact.revision.id,
    semanticTarget
  };
  const action: ImportAction = {
    actionId: deriveImportActionId(identity),
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
}: {
  workflow: Workflow;
  actions: ImportAction[];
  events: ImportPlanEvent[];
}): SimulationResult {
  const sortedEvents = [...events].sort(
    compareImportEvents
  );
  const actionByEventId =
    new Map<string, ImportAction>();

  for (const action of actions) {
    for (const eventId of action.eventIds) {
      actionByEventId.set(eventId, action);
    }
  }

  let projected = workflow;
  const rejectedEventIds = new Set<string>();
  const replacementActions =
    new Map<string, ImportAction>();
  const domainCodes = new Map<string, string>();

  for (const event of sortedEvents) {
    try {
      projected = applyEvent(projected, event);
    } catch (error) {
      const original = actionByEventId.get(event.eventId);

      if (!original) {
        throw error;
      }

      const errorCode = getErrorCode(error);
      const directConflict =
        errorCode !== undefined &&
        DIRECT_DOMAIN_CONFLICTS.has(errorCode);
      replacementActions.set(
        original.actionId,
        {
          ...original,
          kind: "conflict",
          reasonCode: directConflict
            ? errorCode
            : "DOMAIN_INVARIANT_VIOLATION",
          eventIds: []
        }
      );
      if (!directConflict) {
        domainCodes.set(
          original.actionId,
          errorCode ?? "UNKNOWN"
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

function buildProviderIndex(
  workflow: Workflow
): ProviderIndex {
  const index: ProviderIndex = new Map();

  for (const workItem of Object.values(workflow.workItems)) {
    for (const link of workItem.externalLinks) {
      const existing = index.get(link.providerObjectKey);

      if (existing) {
        index.set(link.providerObjectKey, {
          kind: "ambiguous"
        });
      } else {
        index.set(link.providerObjectKey, {
          kind: "owned",
          workItemId: workItem.id,
          link
        });
      }
    }
  }

  return index;
}

function summarizeActions(
  actions: readonly ImportAction[]
): ImportPlanSummary {
  const summary: ImportPlanSummary = {
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

function compareFacts(
  left: ProviderFact,
  right: ProviderFact
): number {
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

function sameStringSet(
  left: unknown,
  right: unknown
): boolean {
  if (
    !Array.isArray(left) ||
    !Array.isArray(right) ||
    left.length !== right.length ||
    !left.every(isString) ||
    !right.every(isString)
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

function compareStrings(
  left: string,
  right: string
): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function scopeRefsEqual(
  left: ScopeRef | null,
  right: ProviderScopeRef
): boolean {
  return (
    left?.kind === right?.kind &&
    left?.key === right?.key &&
    left?.parentKey === right?.parentKey
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const actualKeys = Object.keys(value);

  return (
    actualKeys.length === keys.length &&
    actualKeys.every((key) => keys.includes(key))
  );
}

function hasAllowedAndRequiredKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[]
): boolean {
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
  return prototype === Object.prototype || prototype === null;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
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
    codePointLength(value) <= maximumLength
  );
}

function codePointLength(value: string): number {
  return [...value].length;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}

function cloneCandidatePayload(
  event: ArtifactLinkedEvent | EvidenceRecordedEvent
): Record<string, unknown> {
  if (event.type === "artifact.linked") {
    return {
      artifactId: event.payload.artifactId,
      attemptId: event.payload.attemptId,
      kind: event.payload.kind,
      revision: event.payload.revision,
      url: event.payload.url
    };
  }

  return {
    evidenceId: event.payload.evidenceId,
    attemptId: event.payload.attemptId,
    artifactId: event.payload.artifactId,
    revision: event.payload.revision,
    criterionKey: event.payload.criterionKey,
    outcome: event.payload.outcome,
    url: event.payload.url
  };
}

function cloneScopeRef(
  scope: ProviderScopeRef
): ScopeRef {
  return {
    kind: scope.kind,
    key: scope.key,
    ...(scope.parentKey === undefined
      ? {}
      : { parentKey: scope.parentKey })
  };
}

function isProviderIssueFact(
  fact: ProviderFact
): fact is ProviderIssueFact {
  return fact.sourceObject.objectType === "issue";
}

function isDeliveryFact(
  fact: ProviderFact
): fact is ProviderPullRequestFact | ProviderCheckFact {
  return (
    fact.sourceObject.objectType === "pull_request" ||
    fact.sourceObject.objectType === "check"
  );
}

function isImportProvider(
  value: unknown
): value is ImportProvider {
  return (
    value === "github" ||
    value === "linear" ||
    value === "gitee"
  );
}

function normalizeImportProvider(
  value: unknown
): ImportProvider {
  if (!isImportProvider(value)) {
    throw snapshotInvalid();
  }

  return value;
}

function isProviderObjectType(
  value: unknown
): value is ProviderObjectType {
  return (
    value === "issue" ||
    value === "pull_request" ||
    value === "check"
  );
}

function isEvidenceOutcome(
  value: unknown
): value is "passed" | "failed" {
  return value === "passed" || value === "failed";
}

function isManagedField(
  value: string
): value is ManagedField {
  return value === "title";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isDigest(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(value)
  );
}

function getErrorCode(error: unknown): string | undefined {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }

  return undefined;
}

function snapshotInvalid(): SnapshotImportError {
  return new SnapshotImportError(
    "SNAPSHOT_INVALID",
    "ProviderSnapshot does not match the supported safe schema."
  );
}

function snapshotLimit(
  field: string,
  limit: number
): SnapshotImportError {
  return new SnapshotImportError(
    "SNAPSHOT_LIMIT_EXCEEDED",
    `Snapshot ${field} exceeds limit ${limit}.`
  );
}

export class SnapshotImportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SnapshotImportError";
    this.code = code;
  }
}
