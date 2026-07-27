import { createHash } from "node:crypto";

export type WorkItemStatus =
  | "planned"
  | "running"
  | "reviewing"
  | "blocked"
  | "accepted";

export type AttemptTerminalOutcome =
  | "completed"
  | "failed"
  | "interrupted";

export type AttemptStatus =
  | "running"
  | "superseded"
  | AttemptTerminalOutcome;

export interface Attempt {
  id: string;
  agentId: string;
  status: AttemptStatus;
  startedAt: string;
  completedAt?: string;
  runtimeOutcome?: AttemptTerminalOutcome;
  threadId?: string | undefined;
  turnId?: string | undefined;
  summary?: string | undefined;
}

export interface Artifact {
  id: string;
  attemptId: string;
  kind: string;
  revision: string;
  url: string;
  linkedAt: string;
}

export interface Evidence {
  id: string;
  attemptId: string;
  artifactId: string;
  revision: string;
  criterionKey: string;
  outcome: "passed" | "failed";
  url: string;
  recordedAt: string;
}

export interface AcceptanceDecision {
  decision: "accepted" | "rejected";
  actor: string;
  reason: string;
  decidedAt: string;
}

export interface ActiveArtifact {
  artifactId: string;
  revision: string;
  linkedAt: string;
}

export interface ScopeRef {
  kind: string;
  key: string;
  parentKey?: string;
}

export interface ExternalObservation {
  revisionId: string;
  occurredAt: string;
  contentDigest: string;
  title: string;
  url?: string;
}

export type ManagedField = "title";

export interface RichExternalLink {
  providerObjectKey: string;
  provider: string;
  objectType: string;
  externalId: string;
  scopeRef: ScopeRef;
  url: string;
  managedFields: ManagedField[];
  lastObservation: ExternalObservation;
  legacy?: never;
}

export interface LegacyExternalLink {
  providerObjectKey: string;
  provider: string;
  objectType: "issue" | null;
  externalId: string;
  scopeRef: null;
  url: string;
  managedFields: null;
  lastObservation: null;
  legacy: true;
}

export type ExternalLink = RichExternalLink | LegacyExternalLink;

export interface WorkItem {
  id: string;
  title: string;
  status: WorkItemStatus;
  requiredEvidence: string[];
  activeAttemptId: string | null;
  activeArtifact: ActiveArtifact | null;
  attempts: Attempt[];
  artifacts: Artifact[];
  evidence: Evidence[];
  acceptanceDecision: AcceptanceDecision | null;
  externalLinks: ExternalLink[];
}

export interface Workflow {
  processedEvents: Record<string, string>;
  processedEventIds: string[];
  workItems: Record<string, WorkItem>;
}

interface LegacyCreatedExternalLink {
  providerObjectKey?: never;
  provider: string;
  externalId: string;
  url: string;
}

interface WorkItemCreatedPayload {
  title: string;
  requiredEvidence: string[];
  externalLink: LegacyCreatedExternalLink | RichExternalLink;
}

interface ExternalLinkLinkedPayload {
  link: RichExternalLink;
}

export interface ExternalLinkBaseline {
  providerObjectKey: string;
  objectType: "issue";
  scopeRef: ScopeRef;
  managedFields: ManagedField[];
}

interface ExternalLinkObservedBaselinePayload {
  providerObjectKey: string;
  expectedRevisionId: null;
  observation: ExternalObservation;
  baseline: ExternalLinkBaseline;
}

interface ExternalLinkObservedRevisionPayload {
  providerObjectKey: string;
  expectedRevisionId: string;
  observation: ExternalObservation;
  baseline?: never;
}

type ExternalLinkObservedPayload =
  | ExternalLinkObservedBaselinePayload
  | ExternalLinkObservedRevisionPayload;

export interface UpdateSource {
  providerObjectKey: string;
  revisionId: string;
  contentDigest: string;
}

export interface TitleChanges {
  title: {
    before: string;
    after: string;
  };
}

interface WorkItemUpdatedPayload {
  source: UpdateSource;
  changes: TitleChanges;
}

interface AttemptStartedPayload {
  attemptId: string;
  agentId: string;
}

interface AttemptFinishedPayload {
  attemptId: string;
  outcome: AttemptTerminalOutcome;
  threadId?: string;
  turnId?: string;
  summary?: string;
}

interface ArtifactLinkedPayload {
  artifactId: string;
  attemptId: string;
  kind: string;
  revision: string;
  url: string;
}

interface EvidenceRecordedPayload {
  evidenceId: string;
  attemptId: string;
  artifactId: string;
  revision: string;
  criterionKey: string;
  outcome: "passed" | "failed";
  url: string;
}

interface AcceptanceDecidedPayload {
  decision: "accepted" | "rejected";
  actor: string;
  reason: string;
}

interface CanonicalEventOf<
  Type extends string,
  Payload
> {
  eventId: string;
  workItemId: string;
  type: Type;
  occurredAt: string;
  payload: Payload;
}

export type WorkItemCreatedEvent = CanonicalEventOf<
  "work_item.created",
  WorkItemCreatedPayload
>;
export type ExternalLinkLinkedEvent = CanonicalEventOf<
  "external_link.linked",
  ExternalLinkLinkedPayload
>;
export type ExternalLinkObservedEvent = CanonicalEventOf<
  "external_link.observed",
  ExternalLinkObservedPayload
>;
export type WorkItemUpdatedEvent = CanonicalEventOf<
  "work_item.updated",
  WorkItemUpdatedPayload
>;
export type AttemptStartedEvent = CanonicalEventOf<
  "attempt.started",
  AttemptStartedPayload
>;
export type AttemptFinishedEvent = CanonicalEventOf<
  "attempt.finished",
  AttemptFinishedPayload
>;
export type ArtifactLinkedEvent = CanonicalEventOf<
  "artifact.linked",
  ArtifactLinkedPayload
>;
export type EvidenceRecordedEvent = CanonicalEventOf<
  "evidence.recorded",
  EvidenceRecordedPayload
>;
export type AcceptanceDecidedEvent = CanonicalEventOf<
  "acceptance.decided",
  AcceptanceDecidedPayload
>;

export type CanonicalEvent =
  | WorkItemCreatedEvent
  | ExternalLinkLinkedEvent
  | ExternalLinkObservedEvent
  | WorkItemUpdatedEvent
  | AttemptStartedEvent
  | AttemptFinishedEvent
  | ArtifactLinkedEvent
  | EvidenceRecordedEvent
  | AcceptanceDecidedEvent;

interface EventEnvelope {
  eventId: string;
  workItemId: string;
  type: string;
  occurredAt: string;
  payload: object;
}

type AcceptanceDecisionEventCandidate = CanonicalEventOf<
  "acceptance.decided",
  object
>;

type ValidatedEvent =
  | Exclude<CanonicalEvent, AcceptanceDecidedEvent>
  | AcceptanceDecisionEventCandidate;

export function createWorkflow(): Workflow {
  return {
    processedEvents: {},
    processedEventIds: [],
    workItems: {}
  };
}

export function applyEvent(
  workflow: Workflow,
  event: unknown
): Workflow {
  validateEventEnvelope(event);
  const validatedEvent = validateEventPayload(event);

  const processedDecision = classifyProcessedEvent(
    workflow,
    event
  );

  if (processedDecision === "EXACT_EVENT_DUPLICATE") {
    return workflow;
  }

  if (processedDecision === "EVENT_ID_CONFLICT") {
    throw new DomainError(
      "EVENT_ID_CONFLICT",
      `Event ${event.eventId} was already processed with different content.`
    );
  }

  if (!validatedEvent) {
    throw new Error(`Unsupported event type: ${event.type}`);
  }

  if (validatedEvent.type === "work_item.created") {
    return createWorkItem(workflow, validatedEvent);
  }

  if (validatedEvent.type === "external_link.linked") {
    return linkExternalObject(workflow, validatedEvent);
  }

  if (validatedEvent.type === "external_link.observed") {
    return observeExternalObject(workflow, validatedEvent);
  }

  if (validatedEvent.type === "work_item.updated") {
    return updateWorkItem(workflow, validatedEvent);
  }

  if (validatedEvent.type === "attempt.started") {
    return startAttempt(workflow, validatedEvent);
  }

  if (validatedEvent.type === "attempt.finished") {
    return finishAttempt(workflow, validatedEvent);
  }

  if (validatedEvent.type === "artifact.linked") {
    return linkArtifact(workflow, validatedEvent);
  }

  if (validatedEvent.type === "evidence.recorded") {
    return recordEvidence(workflow, validatedEvent);
  }

  if (validatedEvent.type === "acceptance.decided") {
    return decideAcceptance(workflow, validatedEvent);
  }

  return assertNever(validatedEvent);
}

function createWorkItem(
  workflow: Workflow,
  event: WorkItemCreatedEvent
): Workflow {
  if (workflow.workItems[event.workItemId]) {
    throw new DomainError(
      "WORK_ITEM_ALREADY_EXISTS",
      `Work item ${event.workItemId} already exists; use an update event instead.`
    );
  }

  const externalLink = normalizeCreatedExternalLink(
    event.payload.externalLink
  );

  if (
    externalLink.legacy !== true &&
    findExternalLinkOwner(
      workflow,
      externalLink.providerObjectKey
    )
  ) {
    throw new DomainError(
      "PROVIDER_OBJECT_ALREADY_LINKED",
      "A provider object can be linked only once in a workflow."
    );
  }

  return {
    processedEvents: {
      ...workflow.processedEvents,
      [event.eventId]: digestCanonicalEvent(event)
    },
    processedEventIds: [...workflow.processedEventIds, event.eventId],
    workItems: {
      ...workflow.workItems,
      [event.workItemId]: {
        id: event.workItemId,
        title: event.payload.title,
        status: "planned",
        requiredEvidence: [...event.payload.requiredEvidence],
        activeAttemptId: null,
        activeArtifact: null,
        attempts: [],
        artifacts: [],
        evidence: [],
        acceptanceDecision: null,
        externalLinks: [externalLink]
      }
    }
  };
}

function normalizeCreatedExternalLink(
  externalLink: WorkItemCreatedPayload["externalLink"]
): ExternalLink {
  if (isRichExternalLink(externalLink)) {
    return cloneExternalLink(externalLink);
  }

  const isImportableLegacyIssue =
    externalLink.provider === "github" ||
    externalLink.provider === "linear";

  return {
    providerObjectKey: isImportableLegacyIssue
      ? `${externalLink.provider}:issue:${externalLink.externalId}`
      : `legacy:${externalLink.provider}:${externalLink.externalId}`,
    provider: externalLink.provider,
    objectType: isImportableLegacyIssue ? "issue" : null,
    externalId: externalLink.externalId,
    scopeRef: null,
    url: externalLink.url,
    managedFields: null,
    lastObservation: null,
    legacy: true
  };
}

function linkExternalObject(
  workflow: Workflow,
  event: ExternalLinkLinkedEvent
): Workflow {
  const workItem = requireWorkItem(workflow, event.workItemId);
  const link = event.payload.link;
  const existingOwner = findExternalLinkOwner(
    workflow,
    link.providerObjectKey
  );

  if (existingOwner) {
    throw new DomainError(
      existingOwner.workItemId === event.workItemId
        ? "EXTERNAL_LINK_ALREADY_EXISTS"
        : "PROVIDER_OBJECT_ALREADY_LINKED",
      "A provider object can be linked only once in a workflow."
    );
  }

  if (
    link.managedFields.includes("title") &&
    workItem.externalLinks.some((item) =>
      item.managedFields?.includes("title")
    )
  ) {
    throw new DomainError(
      "FIELD_AUTHORITY_CONFLICT",
      "A work item field can be managed by only one external link."
    );
  }

  return withWorkItem(workflow, event, {
    ...workItem,
    externalLinks: [
      ...workItem.externalLinks,
      cloneExternalLink(link)
    ]
  });
}

function observeExternalObject(
  workflow: Workflow,
  event: ExternalLinkObservedEvent
): Workflow {
  const workItem = requireWorkItem(workflow, event.workItemId);
  const linkIndex = workItem.externalLinks.findIndex(
    (link) =>
      link.providerObjectKey === event.payload.providerObjectKey
  );

  if (linkIndex < 0) {
    throw new DomainError(
      "EXTERNAL_LINK_NOT_FOUND",
      "An observation must reference a linked provider object."
    );
  }

  const link = workItem.externalLinks[linkIndex];

  if (!link) {
    throw new DomainError(
      "EXTERNAL_LINK_NOT_FOUND",
      "An observation must reference a linked provider object."
    );
  }

  const currentObservation = link.lastObservation;

  if (event.payload.expectedRevisionId === null) {
    return baselineLegacyExternalLink({
      workflow,
      event,
      workItem,
      linkIndex,
      link,
      baseline: event.payload.baseline,
      observation: event.payload.observation
    });
  }

  if (link.legacy === true || !currentObservation) {
    throw new DomainError(
      "EXTERNAL_LINK_BASELINE_INVALID",
      "Only a valid legacy link can receive a baseline observation."
    );
  }

  if (
    event.payload.expectedRevisionId !==
    currentObservation.revisionId
  ) {
    throw new DomainError(
      "EXTERNAL_LINK_REVISION_MISMATCH",
      "The observation precondition does not match the current revision."
    );
  }

  const observation = event.payload.observation;

  if (observation.revisionId === currentObservation.revisionId) {
    throw new DomainError(
      observation.contentDigest === currentObservation.contentDigest
        ? "SOURCE_REVISION_NOT_ADVANCED"
        : "SOURCE_REVISION_CONTENT_CONFLICT",
      "A source revision cannot be observed with conflicting or duplicate content."
    );
  }

  const incomingTimestamp = Date.parse(observation.occurredAt);
  const currentTimestamp = Date.parse(
    currentObservation.occurredAt
  );

  if (incomingTimestamp < currentTimestamp) {
    throw new DomainError(
      "SOURCE_REVISION_STALE",
      "An older source revision cannot replace a newer observation."
    );
  }

  if (incomingTimestamp === currentTimestamp) {
    throw new DomainError(
      "SOURCE_REVISION_ORDER_AMBIGUOUS",
      "Different source revisions with the same timestamp cannot be ordered safely."
    );
  }

  const externalLinks = [...workItem.externalLinks];
  externalLinks[linkIndex] = {
    ...link,
    url: observation.url ?? link.url,
    lastObservation: { ...observation }
  };

  return withWorkItem(workflow, event, {
    ...workItem,
    externalLinks
  });
}

function baselineLegacyExternalLink({
  workflow,
  event,
  workItem,
  linkIndex,
  link,
  baseline,
  observation
}: {
  workflow: Workflow;
  event: ExternalLinkObservedEvent;
  workItem: WorkItem;
  linkIndex: number;
  link: ExternalLink;
  baseline: ExternalLinkBaseline;
  observation: ExternalObservation;
}): Workflow {
  const hasConflictingOwner = Object.values(
    workflow.workItems
  ).some(
    (item) =>
      item.id !== event.workItemId &&
      item.externalLinks.some(
        (externalLink) =>
          externalLink.providerObjectKey ===
          link.providerObjectKey
      )
  );

  if (hasConflictingOwner) {
    throw new DomainError(
      "PROVIDER_OBJECT_ALREADY_LINKED",
      "An ambiguous legacy provider object cannot be baselined."
    );
  }

  const canBaseline =
    link.legacy === true &&
    (link.provider === "github" || link.provider === "linear") &&
    link.objectType === "issue" &&
    link.scopeRef === null &&
    link.managedFields === null &&
    link.lastObservation === null &&
    baseline.providerObjectKey === link.providerObjectKey &&
    baseline.objectType === "issue" &&
    isProviderScopeRef(link.provider, baseline.scopeRef);

  if (!canBaseline) {
    throw new DomainError(
      "EXTERNAL_LINK_BASELINE_INVALID",
      "The baseline does not match an importable legacy issue link."
    );
  }

  if (
    baseline.managedFields.includes("title") &&
    workItem.externalLinks.some(
      (item, index) =>
        index !== linkIndex &&
        item.managedFields?.includes("title")
    )
  ) {
    throw new DomainError(
      "FIELD_AUTHORITY_CONFLICT",
      "A work item field can be managed by only one external link."
    );
  }

  const externalLinks: ExternalLink[] = workItem.externalLinks.map(
    (item, index) => {
      if (index !== linkIndex) {
        return item;
      }

      return {
        providerObjectKey: baseline.providerObjectKey,
        provider: link.provider,
        objectType: baseline.objectType,
        externalId: link.externalId,
        scopeRef: { ...baseline.scopeRef },
        url: observation.url ?? link.url,
        managedFields: [...baseline.managedFields],
        lastObservation: { ...observation }
      };
    }
  );

  return withWorkItem(workflow, event, {
    ...workItem,
    externalLinks
  });
}

function updateWorkItem(
  workflow: Workflow,
  event: WorkItemUpdatedEvent
): Workflow {
  const workItem = requireWorkItem(workflow, event.workItemId);
  const source = event.payload.source;
  const titleChange = event.payload.changes.title;
  const sourceLink = workItem.externalLinks.find(
    (link) =>
      link.providerObjectKey === source.providerObjectKey
  );

  if (!sourceLink) {
    throw new DomainError(
      "EXTERNAL_LINK_NOT_FOUND",
      "A work item update must reference a linked provider object."
    );
  }

  if (!sourceLink.managedFields?.includes("title")) {
    throw new DomainError(
      "FIELD_AUTHORITY_CONFLICT",
      "The source external link does not manage the title field."
    );
  }

  const observation = sourceLink.lastObservation;

  if (
    !observation ||
    observation.revisionId !== source.revisionId ||
    observation.contentDigest !== source.contentDigest ||
    observation.title !== titleChange.after
  ) {
    throw new DomainError(
      "SOURCE_REVISION_MISMATCH",
      "The work item update must match the source link observation."
    );
  }

  if (workItem.title !== titleChange.before) {
    throw new DomainError(
      "WORK_ITEM_UPDATE_PRECONDITION_FAILED",
      "The work item title no longer matches the planned before value."
    );
  }

  return withWorkItem(workflow, event, {
    ...workItem,
    title: titleChange.after
  });
}

function findExternalLinkOwner(
  workflow: Workflow,
  providerObjectKey: string
): {
  workItemId: string;
  link: ExternalLink;
} | null {
  for (const workItem of Object.values(workflow.workItems)) {
    const link = workItem.externalLinks.find(
      (item) => item.providerObjectKey === providerObjectKey
    );

    if (link) {
      return { workItemId: workItem.id, link };
    }
  }

  return null;
}

function cloneExternalLink(
  link: RichExternalLink
): RichExternalLink {
  const scopeRef: ScopeRef = {
    kind: link.scopeRef.kind,
    key: link.scopeRef.key
  };

  if (link.scopeRef.parentKey !== undefined) {
    scopeRef.parentKey = link.scopeRef.parentKey;
  }

  const lastObservation: ExternalObservation = {
    revisionId: link.lastObservation.revisionId,
    occurredAt: link.lastObservation.occurredAt,
    contentDigest: link.lastObservation.contentDigest,
    title: link.lastObservation.title
  };

  if (link.lastObservation.url !== undefined) {
    lastObservation.url = link.lastObservation.url;
  }

  return {
    providerObjectKey: link.providerObjectKey,
    provider: link.provider,
    objectType: link.objectType,
    externalId: link.externalId,
    scopeRef,
    url: link.url,
    managedFields: [...link.managedFields],
    lastObservation
  };
}

function startAttempt(
  workflow: Workflow,
  event: AttemptStartedEvent
): Workflow {
  const workItem = requireWorkItem(workflow, event.workItemId);

  if (
    workItem.attempts.some((attempt) => attempt.id === event.payload.attemptId)
  ) {
    throw new DomainError(
      "ATTEMPT_ALREADY_EXISTS",
      `Attempt ${event.payload.attemptId} already exists.`
    );
  }

  const activeAttempt = workItem.attempts.find(
    (attempt) => attempt.id === workItem.activeAttemptId
  );
  const incomingTimestamp = Date.parse(event.occurredAt);
  const activeTimestamp = activeAttempt
    ? Date.parse(activeAttempt.startedAt)
    : -Infinity;

  if (activeAttempt && incomingTimestamp === activeTimestamp) {
    throw new DomainError(
      "ATTEMPT_ORDER_AMBIGUOUS",
      "Two attempts have the same provider start timestamp."
    );
  }

  if (activeAttempt && incomingTimestamp < activeTimestamp) {
    return withWorkItem(workflow, event, {
      ...workItem,
      attempts: [
        ...workItem.attempts,
        {
          id: event.payload.attemptId,
          agentId: event.payload.agentId,
          status: "superseded",
          startedAt: event.occurredAt,
          completedAt: activeAttempt.startedAt
        }
      ]
    });
  }

  const previousAttempts: Attempt[] = workItem.attempts.map((attempt) =>
    attempt.id === workItem.activeAttemptId && attempt.status === "running"
      ? {
          ...attempt,
          status: "superseded",
          completedAt: event.occurredAt
        }
      : attempt
  );
  const nextWorkItem: WorkItem = {
    ...workItem,
    status: "running",
    activeAttemptId: event.payload.attemptId,
    activeArtifact: null,
    acceptanceDecision: null,
    attempts: [
      ...previousAttempts,
      {
        id: event.payload.attemptId,
        agentId: event.payload.agentId,
        status: "running",
        startedAt: event.occurredAt
      }
    ]
  };

  return withWorkItem(workflow, event, nextWorkItem);
}

function finishAttempt(
  workflow: Workflow,
  event: AttemptFinishedEvent
): Workflow {
  const workItem = requireWorkItem(workflow, event.workItemId);
  const attempt = workItem.attempts.find(
    (item) => item.id === event.payload.attemptId
  );

  if (!attempt) {
    throw new DomainError(
      "ATTEMPT_RELATION_INVALID",
      "The finish event must reference an existing attempt."
    );
  }

  if (attempt.runtimeOutcome) {
    throw new DomainError(
      "ATTEMPT_TERMINAL_CONFLICT",
      "An Attempt terminal outcome cannot be changed after it is recorded."
    );
  }

  const changesActiveState =
    workItem.activeAttemptId === attempt.id &&
    attempt.status === "running";
  const attempts: Attempt[] = workItem.attempts.map((item) =>
    item.id === attempt.id
      ? {
          ...item,
          status: changesActiveState ? event.payload.outcome : item.status,
          runtimeOutcome: event.payload.outcome,
          completedAt: item.completedAt ?? event.occurredAt,
          threadId: event.payload.threadId ?? item.threadId,
          turnId: event.payload.turnId ?? item.turnId,
          summary: event.payload.summary ?? item.summary
        }
      : item
  );

  return withWorkItem(workflow, event, {
    ...workItem,
    status: changesActiveState
      ? event.payload.outcome === "completed"
        ? "reviewing"
        : "blocked"
      : workItem.status,
    attempts,
    acceptanceDecision: changesActiveState
      ? null
      : workItem.acceptanceDecision
  });
}

function linkArtifact(
  workflow: Workflow,
  event: ArtifactLinkedEvent
): Workflow {
  const workItem = requireWorkItem(workflow, event.workItemId);
  const activeAttempt = requireActiveAttempt(
    workItem,
    event.payload.attemptId
  );
  const artifact: Artifact = {
    id: event.payload.artifactId,
    attemptId: event.payload.attemptId,
    kind: event.payload.kind,
    revision: event.payload.revision,
    url: event.payload.url,
    linkedAt: event.occurredAt
  };
  const activeArtifact = workItem.activeArtifact;
  const isSameRevision =
    activeArtifact &&
    activeArtifact.artifactId === artifact.id &&
    activeArtifact.revision === artifact.revision;
  const isStale =
    activeArtifact &&
    Date.parse(event.occurredAt) < Date.parse(activeArtifact.linkedAt);
  const preservesCurrentState = isStale || isSameRevision;
  const preservesDecision =
    preservesCurrentState ||
    shouldPreserveDecisionForExternalFact(
      workItem,
      event,
      activeAttempt
    );
  const nextArtifacts: Artifact[] = isSameRevision
    ? workItem.artifacts.map((item) =>
        item.id === artifact.id &&
        item.attemptId === artifact.attemptId &&
        item.revision === artifact.revision
          ? {
              ...item,
              kind: artifact.kind,
              url: artifact.url
            }
          : item
      )
    : [...workItem.artifacts, artifact];

  if (
    activeArtifact &&
    !isSameRevision &&
    Date.parse(event.occurredAt) === Date.parse(activeArtifact.linkedAt) &&
    event.payload.revision !== activeArtifact.revision
  ) {
    throw new DomainError(
      "ARTIFACT_REVISION_ORDER_AMBIGUOUS",
      "Two artifact revisions have the same provider timestamp."
    );
  }

  const nextWorkItem: WorkItem = {
    ...workItem,
    status: preservesCurrentState
      ? workItem.status
      : activeAttempt.status === "running"
        ? "running"
        : activeAttempt.status === "completed"
          ? "reviewing"
          : activeAttempt.status === "failed" ||
              activeAttempt.status === "interrupted"
            ? "blocked"
            : workItem.status,
    activeArtifact: preservesCurrentState
      ? activeArtifact
      : {
          artifactId: artifact.id,
          revision: artifact.revision,
          linkedAt: artifact.linkedAt
        },
    attempts: workItem.attempts,
    artifacts: nextArtifacts,
    acceptanceDecision: preservesDecision
      ? workItem.acceptanceDecision
      : null
  };

  return withWorkItem(workflow, event, nextWorkItem);
}

function recordEvidence(
  workflow: Workflow,
  event: EvidenceRecordedEvent
): Workflow {
  const workItem = requireWorkItem(workflow, event.workItemId);
  const activeAttempt = requireActiveAttempt(
    workItem,
    event.payload.attemptId
  );

  const artifactExists = workItem.artifacts.some(
    (artifact) =>
      artifact.id === event.payload.artifactId &&
      artifact.attemptId === event.payload.attemptId &&
      artifact.revision === event.payload.revision
  );

  if (!artifactExists) {
    throw new DomainError(
      "EVIDENCE_ARTIFACT_MISMATCH",
      "Evidence must reference an artifact revision from the active attempt."
    );
  }

  const conflictingEvidence = workItem.evidence.some(
    (item) =>
      item.attemptId === event.payload.attemptId &&
      item.artifactId === event.payload.artifactId &&
      item.revision === event.payload.revision &&
      item.criterionKey === event.payload.criterionKey &&
      Date.parse(item.recordedAt) === Date.parse(event.occurredAt) &&
      item.outcome !== event.payload.outcome
  );

  if (conflictingEvidence) {
    throw new DomainError(
      "EVIDENCE_ORDER_AMBIGUOUS",
      "Conflicting evidence at the same provider timestamp cannot be ordered safely."
    );
  }

  const evidence: Evidence = {
    id: event.payload.evidenceId,
    attemptId: event.payload.attemptId,
    artifactId: event.payload.artifactId,
    revision: event.payload.revision,
    criterionKey: event.payload.criterionKey,
    outcome: event.payload.outcome,
    url: event.payload.url,
    recordedAt: event.occurredAt
  };
  const currentLatestEvidence = getLatestEvidenceByCriterion(workItem);
  const nextEvidence = [...workItem.evidence, evidence];
  const isCurrentArtifact =
    event.payload.attemptId === workItem.activeAttemptId &&
    event.payload.artifactId === workItem.activeArtifact?.artifactId &&
    event.payload.revision === workItem.activeArtifact?.revision;

  if (!isCurrentArtifact) {
    return withWorkItem(workflow, event, {
      ...workItem,
      evidence: nextEvidence
    });
  }

  const latestEvidence = getLatestEvidenceByCriterion({
    ...workItem,
    evidence: nextEvidence
  });
  const previousOutcome = currentLatestEvidence.get(
    event.payload.criterionKey
  )?.outcome;
  const nextOutcome = latestEvidence.get(event.payload.criterionKey)?.outcome;
  const changesRequiredGate =
    workItem.requiredEvidence.includes(event.payload.criterionKey) &&
    previousOutcome !== nextOutcome;

  if (!changesRequiredGate) {
    return withWorkItem(workflow, event, {
      ...workItem,
      evidence: nextEvidence
    });
  }

  const hasFailedRequirement = workItem.requiredEvidence.some(
    (criterion) => latestEvidence.get(criterion)?.outcome === "failed"
  );
  const nextWorkItem: WorkItem = {
    ...workItem,
    status:
      activeAttempt.status === "failed" ||
      activeAttempt.status === "interrupted"
        ? "blocked"
        : hasFailedRequirement
          ? "blocked"
          : "reviewing",
    evidence: nextEvidence,
    acceptanceDecision: shouldPreserveDecisionForExternalFact(
      workItem,
      event,
      activeAttempt
    )
      ? workItem.acceptanceDecision
      : null
  };

  return withWorkItem(workflow, event, nextWorkItem);
}

function decideAcceptance(
  workflow: Workflow,
  event: AcceptanceDecisionEventCandidate
): Workflow {
  const workItem = requireWorkItem(workflow, event.workItemId);
  validateAcceptanceDecisionEvent(event);
  const validDecision =
    event.payload.decision === "accepted" ||
    event.payload.decision === "rejected";

  if (
    !validDecision ||
    !isNonEmptyString(event.payload.actor) ||
    !isNonEmptyString(event.payload.reason)
  ) {
    throw new DomainError(
      "ACCEPTANCE_DECISION_INVALID",
      "Acceptance decisions require accepted/rejected, actor, and reason fields."
    );
  }

  if (event.payload.decision === "accepted") {
    const latestEvidence = getLatestEvidenceByCriterion(workItem);
    const activeArtifact = workItem.activeArtifact;
    const activeAttempt = workItem.attempts.find(
      (attempt) => attempt.id === workItem.activeAttemptId
    );
    const hasRequiredEvidence = workItem.requiredEvidence.every((criterion) =>
      latestEvidence.get(criterion)?.outcome === "passed"
    );

    if (!activeArtifact || !hasRequiredEvidence) {
      throw new DomainError(
        "ACCEPTANCE_EVIDENCE_INCOMPLETE",
        "A work item needs an artifact and all required evidence before acceptance."
      );
    }

    if (activeAttempt?.runtimeOutcome !== "completed") {
      throw new DomainError(
        "ACCEPTANCE_ATTEMPT_INCOMPLETE",
        "A work item can be accepted only after its active attempt completed successfully."
      );
    }
  }

  const nextWorkItem: WorkItem = {
    ...workItem,
    status: event.payload.decision === "accepted" ? "accepted" : "blocked",
    acceptanceDecision: {
      decision: event.payload.decision,
      actor: event.payload.actor,
      reason: event.payload.reason,
      decidedAt: event.occurredAt
    }
  };

  return withWorkItem(workflow, event, nextWorkItem);
}

function shouldPreserveDecisionForExternalFact(
  workItem: WorkItem,
  event: ArtifactLinkedEvent | EvidenceRecordedEvent,
  activeAttempt: Attempt
): boolean {
  if (!workItem.acceptanceDecision) {
    return false;
  }

  if (
    activeAttempt.status === "failed" ||
    activeAttempt.status === "interrupted"
  ) {
    return true;
  }

  return (
    Date.parse(event.occurredAt) <=
    Date.parse(workItem.acceptanceDecision.decidedAt)
  );
}

function getLatestEvidenceByCriterion(
  workItem: WorkItem
): Map<string, Evidence> {
  const latestEvidence = new Map<string, Evidence>();
  const activeArtifact = workItem.activeArtifact;

  for (const item of workItem.evidence) {
    if (
      item.attemptId !== workItem.activeAttemptId ||
      item.artifactId !== activeArtifact?.artifactId ||
      item.revision !== activeArtifact?.revision
    ) {
      continue;
    }

    const current = latestEvidence.get(item.criterionKey);
    const itemTimestamp = Date.parse(item.recordedAt);
    const currentTimestamp = current ? Date.parse(current.recordedAt) : -Infinity;
    const isNewer =
      !current ||
      itemTimestamp > currentTimestamp ||
      (itemTimestamp === currentTimestamp &&
        item.id.localeCompare(current.id) > 0);

    if (isNewer) {
      latestEvidence.set(item.criterionKey, item);
    }
  }

  return latestEvidence;
}

function requireActiveAttempt(
  workItem: WorkItem,
  attemptId: string
): Attempt {
  const attempt = workItem.attempts.find(
    (attempt) => attempt.id === attemptId
  );

  if (!attempt || workItem.activeAttemptId !== attemptId) {
    throw new DomainError(
      "ATTEMPT_RELATION_INVALID",
      "The event must reference the active attempt."
    );
  }

  return attempt;
}

function requireWorkItem(
  workflow: Workflow,
  workItemId: string
): WorkItem {
  const workItem = workflow.workItems[workItemId];

  if (!workItem) {
    throw new Error(`Work item not found: ${workItemId}`);
  }

  return workItem;
}

function withWorkItem(
  workflow: Workflow,
  event: CanonicalEvent,
  workItem: WorkItem
): Workflow {
  return {
    processedEvents: {
      ...workflow.processedEvents,
      [event.eventId]: digestCanonicalEvent(event)
    },
    processedEventIds: [...workflow.processedEventIds, event.eventId],
    workItems: {
      ...workflow.workItems,
      [event.workItemId]: workItem
    }
  };
}

function validateEventEnvelope(
  event: unknown
): asserts event is EventEnvelope {
  if (
    !isRecord(event) ||
    !isNonEmptyString(event.eventId) ||
    !isNonEmptyString(event.workItemId) ||
    !isNonEmptyString(event.type) ||
    !isValidTimestamp(event.occurredAt) ||
    !isRecord(event.payload)
  ) {
    throw new DomainError(
      "EVENT_ENVELOPE_INVALID",
      "Events require non-empty eventId, workItemId, type, occurredAt, and object payload fields."
    );
  }
}

function validateEventPayload(
  event: EventEnvelope
): ValidatedEvent | null {
  if (event.type === "work_item.created") {
    if (!isWorkItemCreatedEvent(event)) {
      throw invalidPayload(event.type);
    }
    return event;
  }

  if (event.type === "external_link.linked") {
    if (!isExternalLinkLinkedEvent(event)) {
      throw invalidPayload(event.type);
    }
    return event;
  }

  if (event.type === "external_link.observed") {
    if (!isExternalLinkObservedEvent(event)) {
      throw invalidPayload(event.type);
    }
    return event;
  }

  if (event.type === "work_item.updated") {
    if (!isWorkItemUpdatedEvent(event)) {
      throw invalidPayload(event.type);
    }
    return event;
  }

  if (event.type === "attempt.started") {
    if (!isAttemptStartedEvent(event)) {
      throw invalidPayload(event.type);
    }
    return event;
  }

  if (event.type === "attempt.finished") {
    if (!isAttemptFinishedEvent(event)) {
      throw invalidPayload(event.type);
    }
    return event;
  }

  if (event.type === "artifact.linked") {
    if (!isArtifactLinkedEvent(event)) {
      throw invalidPayload(event.type);
    }
    return event;
  }

  if (event.type === "evidence.recorded") {
    if (!isEvidenceRecordedEvent(event)) {
      throw invalidPayload(event.type);
    }
    return event;
  }

  if (event.type === "acceptance.decided") {
    if (!isAcceptanceDecisionEventCandidate(event)) {
      return null;
    }
    return event;
  }

  return null;
}

function isWorkItemCreatedEvent(
  event: EventEnvelope
): event is WorkItemCreatedEvent {
  if (event.type !== "work_item.created" || !isRecord(event.payload)) {
    return false;
  }

  const payload = event.payload;
  const externalLink = payload.externalLink;

  if (!isRecord(externalLink)) {
    return false;
  }

  const isRichCreate =
    externalLink.providerObjectKey !== undefined;
  const titleIsValid = isRichCreate
    ? isTitle(payload.title)
    : isNonEmptyString(payload.title);
  const evidenceIsValid =
    Array.isArray(payload.requiredEvidence) &&
    payload.requiredEvidence.length > 0 &&
    payload.requiredEvidence.every(isNonEmptyString);
  const commonFieldsAreValid =
    titleIsValid &&
    evidenceIsValid &&
    isNonEmptyString(externalLink.provider) &&
    isNonEmptyString(externalLink.externalId) &&
    isHttpUrl(externalLink.url);

  if (!commonFieldsAreValid) {
    return false;
  }

  return isRichCreate
    ? hasOnlyKeys(payload, [
        "title",
        "requiredEvidence",
        "externalLink"
      ]) && isRichExternalLink(externalLink)
    : isLegacyCreatedExternalLink(externalLink);
}

function isLegacyCreatedExternalLink(
  value: Record<string, unknown>
): value is Record<string, unknown> & LegacyCreatedExternalLink {
  return (
    value.providerObjectKey === undefined &&
    isNonEmptyString(value.provider) &&
    isNonEmptyString(value.externalId) &&
    isHttpUrl(value.url)
  );
}

function isExternalLinkLinkedEvent(
  event: EventEnvelope
): event is ExternalLinkLinkedEvent {
  return (
    event.type === "external_link.linked" &&
    isRecord(event.payload) &&
    hasOnlyKeys(event.payload, ["link"]) &&
    isRichExternalLink(event.payload.link)
  );
}

function isExternalLinkObservedEvent(
  event: EventEnvelope
): event is ExternalLinkObservedEvent {
  if (
    event.type !== "external_link.observed" ||
    !isRecord(event.payload) ||
    !hasOnlyKeys(event.payload, [
      "providerObjectKey",
      "expectedRevisionId",
      "observation",
      "baseline"
    ]) ||
    !isNonEmptyString(event.payload.providerObjectKey) ||
    !isObservation(event.payload.observation)
  ) {
    return false;
  }

  if (event.payload.expectedRevisionId === null) {
    return isExternalLinkBaseline(event.payload.baseline);
  }

  return (
    isNonEmptyString(event.payload.expectedRevisionId) &&
    event.payload.baseline === undefined
  );
}

function isWorkItemUpdatedEvent(
  event: EventEnvelope
): event is WorkItemUpdatedEvent {
  return (
    event.type === "work_item.updated" &&
    isRecord(event.payload) &&
    hasOnlyKeys(event.payload, ["source", "changes"]) &&
    isUpdateSource(event.payload.source) &&
    isTitleChanges(event.payload.changes)
  );
}

function isAttemptStartedEvent(
  event: EventEnvelope
): event is AttemptStartedEvent {
  return (
    event.type === "attempt.started" &&
    isRecord(event.payload) &&
    isNonEmptyString(event.payload.attemptId) &&
    isNonEmptyString(event.payload.agentId)
  );
}

function isAttemptFinishedEvent(
  event: EventEnvelope
): event is AttemptFinishedEvent {
  if (event.type !== "attempt.finished" || !isRecord(event.payload)) {
    return false;
  }

  const payload = event.payload;
  const validOutcome =
    payload.outcome === "completed" ||
    payload.outcome === "failed" ||
    payload.outcome === "interrupted";
  const validOptionalFields = ["threadId", "turnId", "summary"].every(
    (field) =>
      payload[field] === undefined ||
      (isNonEmptyString(payload[field]) && payload[field].length <= 2000)
  );

  return (
    isNonEmptyString(payload.attemptId) &&
    validOutcome &&
    validOptionalFields
  );
}

function isArtifactLinkedEvent(
  event: EventEnvelope
): event is ArtifactLinkedEvent {
  return (
    event.type === "artifact.linked" &&
    isRecord(event.payload) &&
    isNonEmptyString(event.payload.artifactId) &&
    isNonEmptyString(event.payload.attemptId) &&
    isNonEmptyString(event.payload.kind) &&
    isNonEmptyString(event.payload.revision) &&
    isHttpUrl(event.payload.url)
  );
}

function isEvidenceRecordedEvent(
  event: EventEnvelope
): event is EvidenceRecordedEvent {
  return (
    event.type === "evidence.recorded" &&
    isRecord(event.payload) &&
    isNonEmptyString(event.payload.evidenceId) &&
    isNonEmptyString(event.payload.attemptId) &&
    isNonEmptyString(event.payload.artifactId) &&
    isNonEmptyString(event.payload.revision) &&
    isNonEmptyString(event.payload.criterionKey) &&
    (event.payload.outcome === "passed" ||
      event.payload.outcome === "failed") &&
    isHttpUrl(event.payload.url)
  );
}

function isAcceptanceDecisionEventCandidate(
  event: EventEnvelope
): event is AcceptanceDecisionEventCandidate {
  return (
    event.type === "acceptance.decided" &&
    isRecord(event.payload)
  );
}

function validateAcceptanceDecisionEvent(
  event: AcceptanceDecisionEventCandidate
): asserts event is AcceptanceDecidedEvent {
  const payload = event.payload;

  if (
    !isRecord(payload) ||
    (payload.decision !== "accepted" &&
      payload.decision !== "rejected") ||
    !isNonEmptyString(payload.actor) ||
    !isNonEmptyString(payload.reason)
  ) {
    throw new DomainError(
      "ACCEPTANCE_DECISION_INVALID",
      "Acceptance decisions require accepted/rejected, actor, and reason fields."
    );
  }
}

function isRichExternalLink(
  value: unknown
): value is RichExternalLink {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "providerObjectKey",
      "provider",
      "objectType",
      "externalId",
      "scopeRef",
      "url",
      "managedFields",
      "lastObservation"
    ]) ||
    !isNonEmptyString(value.providerObjectKey) ||
    !isNonEmptyString(value.provider) ||
    !isNonEmptyString(value.objectType) ||
    !isNonEmptyString(value.externalId) ||
    !isProviderNeutralScopeRef(
      value.provider,
      value.scopeRef
    ) ||
    !isHttpUrl(value.url) ||
    !isManagedFields(value.managedFields) ||
    !isObservation(value.lastObservation) ||
    value.legacy !== undefined
  ) {
    return false;
  }

  return true;
}

function isUpdateSource(
  value: unknown
): value is UpdateSource {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "providerObjectKey",
      "revisionId",
      "contentDigest"
    ]) &&
    isNonEmptyString(value.providerObjectKey) &&
    isNonEmptyString(value.revisionId) &&
    isSha256Digest(value.contentDigest)
  );
}

function isExternalLinkBaseline(
  value: unknown
): value is ExternalLinkBaseline {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "providerObjectKey",
      "objectType",
      "scopeRef",
      "managedFields"
    ]) &&
    isNonEmptyString(value.providerObjectKey) &&
    value.objectType === "issue" &&
    isScopeRef(value.scopeRef) &&
    isManagedFields(value.managedFields)
  );
}

function isTitleChanges(
  value: unknown
): value is TitleChanges {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["title"])
  ) {
    return false;
  }

  const title = value.title;
  return (
    isRecord(title) &&
    hasOnlyKeys(title, ["before", "after"]) &&
    isNonEmptyString(title.before) &&
    isNonEmptyString(title.after) &&
    codePointLength(title.before) <= 512 &&
    codePointLength(title.after) <= 512
  );
}

function isScopeRef(value: unknown): value is ScopeRef {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["kind", "key", "parentKey"]) &&
    isNonEmptyString(value.kind) &&
    isNonEmptyString(value.key) &&
    (value.parentKey === undefined ||
      isNonEmptyString(value.parentKey))
  );
}

function isManagedFields(
  value: unknown
): value is ManagedField[] {
  return (
    Array.isArray(value) &&
    value.length <= 8 &&
    new Set(value).size === value.length &&
    value.every((field) => field === "title")
  );
}

function isProviderScopeRef(
  provider: string,
  value: unknown
): value is ScopeRef {
  if (!isScopeRef(value)) {
    return false;
  }

  if (provider === "github") {
    return (
      hasOnlyKeys(value, ["kind", "key"]) &&
      value.kind === "repository" &&
      /^github:repository:[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9._-]{1,100}$/.test(
        value.key
      )
    );
  }

  if (provider === "linear") {
    return (
      hasOnlyKeys(value, ["kind", "key", "parentKey"]) &&
      value.kind === "team" &&
      isScopedUuid(value.key, "linear:team:") &&
      isScopedUuid(
        value.parentKey,
        "linear:organization:"
      )
    );
  }

  return false;
}

function isProviderNeutralScopeRef(
  provider: string,
  value: unknown
): value is ScopeRef {
  return (
    isScopeRef(value) &&
    value.key.startsWith(
      `${provider}:${value.kind}:`
    ) &&
    (
      value.parentKey === undefined ||
      value.parentKey.startsWith(`${provider}:`)
    )
  );
}

function isScopedUuid(
  value: unknown,
  prefix: string
): boolean {
  const uuid =
    isNonEmptyString(value) && value.startsWith(prefix)
      ? value.slice(prefix.length)
      : "";

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    uuid
  );
}

function isObservation(
  value: unknown
): value is ExternalObservation {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "revisionId",
      "occurredAt",
      "contentDigest",
      "title",
      "url"
    ]) &&
    isNonEmptyString(value.revisionId) &&
    isValidTimestamp(value.occurredAt) &&
    isSha256Digest(value.contentDigest) &&
    isTitle(value.title) &&
    (value.url === undefined || isHttpUrl(value.url))
  );
}

function hasOnlyKeys(
  value: unknown,
  allowedKeys: readonly string[]
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => allowedKeys.includes(key))
  );
}

function isValidTimestamp(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isSha256Digest(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(value)
  );
}

function invalidPayload(type: string): DomainError {
  return new DomainError(
    "EVENT_PAYLOAD_INVALID",
    `Event ${type} has an invalid or incomplete payload.`
  );
}

function isHttpUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function digestCanonicalEvent(event: object): string {
  return createHash("sha256").update(stableStringify(event)).digest("hex");
}

export type ProcessedEventDecision =
  | "EXACT_EVENT_DUPLICATE"
  | "EVENT_ID_CONFLICT"
  | null;

export function classifyProcessedEvent(
  workflow: Workflow,
  event: {
    eventId: string;
  }
): ProcessedEventDecision {
  const processedDigest =
    workflow.processedEvents[event.eventId];

  if (!processedDigest) {
    return null;
  }

  return processedDigest === digestCanonicalEvent(event)
    ? "EXACT_EVENT_DUPLICATE"
    : "EVENT_ID_CONFLICT";
}

function stableStringify(value: object): string;
function stableStringify(value: unknown): string | undefined;
function stableStringify(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (isRecord(value)) {
    const entries: string[] = Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify(value[key])}`
      );
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTitle(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    codePointLength(value) <= 512
  );
}

function codePointLength(value: string): number {
  return [...value].length;
}

class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function assertNever(value: never): never {
  throw new Error(`Unsupported event: ${String(value)}`);
}
