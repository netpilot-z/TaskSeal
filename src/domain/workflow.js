import { createHash } from "node:crypto";

export function createWorkflow() {
  return {
    processedEvents: {},
    processedEventIds: [],
    workItems: {}
  };
}

export function applyEvent(workflow, event) {
  validateEventEnvelope(event);
  validateEventPayload(event);

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

  if (event.type === "work_item.created") {
    return createWorkItem(workflow, event);
  }

  if (event.type === "external_link.linked") {
    return linkExternalObject(workflow, event);
  }

  if (event.type === "external_link.observed") {
    return observeExternalObject(workflow, event);
  }

  if (event.type === "work_item.updated") {
    return updateWorkItem(workflow, event);
  }

  if (event.type === "attempt.started") {
    return startAttempt(workflow, event);
  }

  if (event.type === "attempt.finished") {
    return finishAttempt(workflow, event);
  }

  if (event.type === "artifact.linked") {
    return linkArtifact(workflow, event);
  }

  if (event.type === "evidence.recorded") {
    return recordEvidence(workflow, event);
  }

  if (event.type === "acceptance.decided") {
    return decideAcceptance(workflow, event);
  }

  throw new Error(`Unsupported event type: ${event.type}`);
}

function createWorkItem(workflow, event) {
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

function normalizeCreatedExternalLink(externalLink) {
  if (isNonEmptyString(externalLink.providerObjectKey)) {
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

function linkExternalObject(workflow, event) {
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

function observeExternalObject(workflow, event) {
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
  const currentObservation = link.lastObservation;

  if (event.payload.expectedRevisionId === null) {
    return baselineLegacyExternalLink({
      workflow,
      event,
      workItem,
      linkIndex,
      link
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

  const externalLinks = workItem.externalLinks.map((item, index) =>
    index === linkIndex
      ? {
          ...item,
          url: observation.url ?? item.url,
          lastObservation: { ...observation }
        }
      : item
  );

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
  link
}) {
  const baseline = event.payload.baseline;
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

  const observation = event.payload.observation;
  const externalLinks = workItem.externalLinks.map(
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

function updateWorkItem(workflow, event) {
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

function findExternalLinkOwner(workflow, providerObjectKey) {
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

function cloneExternalLink(link) {
  const scopeRef = {
    kind: link.scopeRef.kind,
    key: link.scopeRef.key
  };

  if (link.scopeRef.parentKey !== undefined) {
    scopeRef.parentKey = link.scopeRef.parentKey;
  }

  const lastObservation = {
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

function startAttempt(workflow, event) {
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

  const previousAttempts = workItem.attempts.map((attempt) =>
    attempt.id === workItem.activeAttemptId && attempt.status === "running"
      ? {
          ...attempt,
          status: "superseded",
          completedAt: event.occurredAt
        }
      : attempt
  );
  const nextWorkItem = {
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

function finishAttempt(workflow, event) {
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
  const attempts = workItem.attempts.map((item) =>
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

function linkArtifact(workflow, event) {
  const workItem = requireWorkItem(workflow, event.workItemId);
  requireActiveAttempt(workItem, event.payload.attemptId);
  const activeAttempt = workItem.attempts.find(
    (attempt) => attempt.id === event.payload.attemptId
  );
  const artifact = {
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
  const nextArtifacts = isSameRevision
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

  const nextWorkItem = {
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

function recordEvidence(workflow, event) {
  const workItem = requireWorkItem(workflow, event.workItemId);
  requireActiveAttempt(workItem, event.payload.attemptId);
  const activeAttempt = workItem.attempts.find(
    (attempt) => attempt.id === event.payload.attemptId
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

  const evidence = {
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
  const nextWorkItem = {
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

function decideAcceptance(workflow, event) {
  const workItem = requireWorkItem(workflow, event.workItemId);
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

  const nextWorkItem = {
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
  workItem,
  event,
  activeAttempt
) {
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

function getLatestEvidenceByCriterion(workItem) {
  const latestEvidence = new Map();
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

function requireActiveAttempt(workItem, attemptId) {
  const attemptExists = workItem.attempts.some(
    (attempt) => attempt.id === attemptId
  );

  if (!attemptExists || workItem.activeAttemptId !== attemptId) {
    throw new DomainError(
      "ATTEMPT_RELATION_INVALID",
      "The event must reference the active attempt."
    );
  }
}

function requireWorkItem(workflow, workItemId) {
  const workItem = workflow.workItems[workItemId];

  if (!workItem) {
    throw new Error(`Work item not found: ${workItemId}`);
  }

  return workItem;
}

function withWorkItem(workflow, event, workItem) {
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

function validateEventEnvelope(event) {
  const hasValidPayload =
    event?.payload &&
    typeof event.payload === "object" &&
    !Array.isArray(event.payload);
  const occurredAt = Date.parse(event?.occurredAt);

  if (
    !isNonEmptyString(event?.eventId) ||
    !isNonEmptyString(event?.workItemId) ||
    !isNonEmptyString(event?.type) ||
    !isNonEmptyString(event?.occurredAt) ||
    !Number.isFinite(occurredAt) ||
    !hasValidPayload
  ) {
    throw new DomainError(
      "EVENT_ENVELOPE_INVALID",
      "Events require non-empty eventId, workItemId, type, occurredAt, and object payload fields."
    );
  }
}

function validateEventPayload(event) {
  const payload = event.payload;

  if (event.type === "work_item.created") {
    const externalLink = payload.externalLink;
    const isRichCreate =
      externalLink?.providerObjectKey !== undefined;
    const titleIsValid = isRichCreate
      ? isTitle(payload.title)
      : isNonEmptyString(payload.title);
    const evidenceIsValid =
      Array.isArray(payload.requiredEvidence) &&
      payload.requiredEvidence.length > 0 &&
      payload.requiredEvidence.every(isNonEmptyString);

    if (
      !titleIsValid ||
      !evidenceIsValid ||
      !externalLink ||
      !isNonEmptyString(externalLink.provider) ||
      !isNonEmptyString(externalLink.externalId) ||
      !isHttpUrl(externalLink.url)
    ) {
      throw invalidPayload(event.type);
    }

    if (
      isRichCreate &&
      (!hasOnlyKeys(payload, [
        "title",
        "requiredEvidence",
        "externalLink"
      ]) ||
        !isRichExternalLink(externalLink))
    ) {
      throw invalidPayload(event.type);
    }
  }

  if (
    event.type === "external_link.linked" &&
    (!hasOnlyKeys(payload, ["link"]) ||
      !isRichExternalLink(payload.link))
  ) {
    throw invalidPayload(event.type);
  }

  if (
    event.type === "external_link.observed" &&
    (!hasOnlyKeys(payload, [
      "providerObjectKey",
      "expectedRevisionId",
      "observation",
      "baseline"
    ]) ||
      !isNonEmptyString(payload.providerObjectKey) ||
      (payload.expectedRevisionId !== null &&
        !isNonEmptyString(payload.expectedRevisionId)) ||
      !isObservation(payload.observation) ||
      (payload.expectedRevisionId === null
        ? !isExternalLinkBaseline(payload.baseline)
        : payload.baseline !== undefined))
  ) {
    throw invalidPayload(event.type);
  }

  if (
    event.type === "work_item.updated" &&
    (!hasOnlyKeys(payload, ["source", "changes"]) ||
      !isUpdateSource(payload.source) ||
      !isTitleChanges(payload.changes))
  ) {
    throw invalidPayload(event.type);
  }

  if (
    event.type === "attempt.started" &&
    (!isNonEmptyString(payload.attemptId) ||
      !isNonEmptyString(payload.agentId))
  ) {
    throw invalidPayload(event.type);
  }

  if (event.type === "attempt.finished") {
    const validOutcome =
      payload.outcome === "completed" ||
      payload.outcome === "failed" ||
      payload.outcome === "interrupted";
    const validOptionalFields = ["threadId", "turnId", "summary"].every(
      (field) =>
        payload[field] === undefined ||
        (isNonEmptyString(payload[field]) && payload[field].length <= 2000)
    );

    if (
      !isNonEmptyString(payload.attemptId) ||
      !validOutcome ||
      !validOptionalFields
    ) {
      throw invalidPayload(event.type);
    }
  }

  if (
    event.type === "artifact.linked" &&
    (!isNonEmptyString(payload.artifactId) ||
      !isNonEmptyString(payload.attemptId) ||
      !isNonEmptyString(payload.kind) ||
      !isNonEmptyString(payload.revision) ||
      !isHttpUrl(payload.url))
  ) {
    throw invalidPayload(event.type);
  }

  if (
    event.type === "evidence.recorded" &&
    (!isNonEmptyString(payload.evidenceId) ||
      !isNonEmptyString(payload.attemptId) ||
      !isNonEmptyString(payload.artifactId) ||
      !isNonEmptyString(payload.revision) ||
      !isNonEmptyString(payload.criterionKey) ||
      (payload.outcome !== "passed" && payload.outcome !== "failed") ||
      !isHttpUrl(payload.url))
  ) {
    throw invalidPayload(event.type);
  }
}

function isRichExternalLink(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    hasOnlyKeys(value, [
      "providerObjectKey",
      "provider",
      "objectType",
      "externalId",
      "scopeRef",
      "url",
      "managedFields",
      "lastObservation"
    ]) &&
    isNonEmptyString(value.providerObjectKey) &&
    isNonEmptyString(value.provider) &&
    isNonEmptyString(value.objectType) &&
    isNonEmptyString(value.externalId) &&
    isProviderScopeRef(value.provider, value.scopeRef) &&
    isHttpUrl(value.url) &&
    isManagedFields(value.managedFields) &&
    isObservation(value.lastObservation) &&
    value.legacy === undefined
  );
}

function isUpdateSource(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
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

function isExternalLinkBaseline(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
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

function isTitleChanges(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !hasOnlyKeys(value, ["title"])
  ) {
    return false;
  }

  const title = value.title;
  return (
    title &&
    typeof title === "object" &&
    !Array.isArray(title) &&
    hasOnlyKeys(title, ["before", "after"]) &&
    isNonEmptyString(title.before) &&
    isNonEmptyString(title.after) &&
    codePointLength(title.before) <= 512 &&
    codePointLength(title.after) <= 512
  );
}

function isScopeRef(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    hasOnlyKeys(value, ["kind", "key", "parentKey"]) &&
    isNonEmptyString(value.kind) &&
    isNonEmptyString(value.key) &&
    (value.parentKey === undefined ||
      isNonEmptyString(value.parentKey))
  );
}

function isManagedFields(value) {
  return (
    Array.isArray(value) &&
    value.length <= 8 &&
    new Set(value).size === value.length &&
    value.every((field) => field === "title")
  );
}

function isProviderScopeRef(provider, value) {
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

function isScopedUuid(value, prefix) {
  const uuid =
    isNonEmptyString(value) && value.startsWith(prefix)
      ? value.slice(prefix.length)
      : "";

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    uuid
  );
}

function isObservation(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
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

function hasOnlyKeys(value, allowedKeys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowedKeys.includes(key))
  );
}

function isValidTimestamp(value) {
  return (
    isNonEmptyString(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isSha256Digest(value) {
  return (
    typeof value === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(value)
  );
}

function invalidPayload(type) {
  return new DomainError(
    "EVENT_PAYLOAD_INVALID",
    `Event ${type} has an invalid or incomplete payload.`
  );
}

function isHttpUrl(value) {
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

export function digestCanonicalEvent(event) {
  return createHash("sha256").update(stableStringify(event)).digest("hex");
}

export function classifyProcessedEvent(workflow, event) {
  const processedDigest =
    workflow.processedEvents[event.eventId];

  if (!processedDigest) {
    return null;
  }

  return processedDigest === digestCanonicalEvent(event)
    ? "EXACT_EVENT_DUPLICATE"
    : "EVENT_ID_CONFLICT";
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify(value[key])}`
      );
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isTitle(value) {
  return (
    isNonEmptyString(value) &&
    codePointLength(value) <= 512
  );
}

function codePointLength(value) {
  return [...value].length;
}

class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
