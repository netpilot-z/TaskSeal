import type {
  ExternalLink,
  ScopeRef,
  Workflow
} from "../domain/workflow.ts";
import {
  digestCanonicalJson
} from "../lib/canonical-json.ts";
import {
  digestProviderFactContent
} from "../lib/provider-snapshot.ts";
import type {
  ImportAction,
  ImportPlan
} from "./import-plan.ts";
import type {
  ImportPlanEvent
} from "./import-plan.ts";

export const MAX_PROVIDER_FACT_PROVENANCE_CLAIMS =
  8;

export type ProviderFactProvenanceLocator =
  | {
      kind: "github.issue";
      number: number;
    }
  | {
      kind: "github.pull_request";
      number: number;
    }
  | {
      kind: "github.check_run";
      id: string;
    }
  | {
      kind: "linear.issue";
      id: string;
      identifier: string;
    };

interface ProviderFactProvenanceClaimContent {
  schemaVersion: 1;
  provider: "github" | "linear";
  objectType: "issue" | "pull_request" | "check";
  providerObjectKey: string;
  externalId: string;
  scopeRef: ScopeRef;
  url: string;
  sourceRevisionId: string;
  sourceOccurredAt: string;
  eventType:
    | "work_item.created"
    | "external_link.linked"
    | "external_link.observed"
    | "artifact.linked"
    | "evidence.recorded";
  eventOccurredAt: string;
  contentDigest: string;
  content:
    | {
        kind: "issue";
        title: string;
      }
    | {
        kind: "pull_request";
        headRevision: string;
      }
    | {
        kind: "check";
        headRevision: string;
        outcome: "passed" | "failed";
      };
  locator: ProviderFactProvenanceLocator;
}

export interface ProviderFactProvenanceClaim
  extends ProviderFactProvenanceClaimContent {
  claimDigest: string;
}

export interface ProviderFactProvenanceVerificationResult {
  schemaVersion: 1;
  claimDigest: string;
  outcome: "verified" | "mismatch";
}

export interface ProviderFactProvenanceVerifier {
  verify(
    claims: readonly ProviderFactProvenanceClaim[]
  ): Promise<unknown>;
}

export interface CollectProviderFactProvenanceClaimsOptions {
  plan: ImportPlan;
  baseWorkflow: Workflow;
}

export interface VerifyProviderFactProvenanceOptions {
  claims: readonly ProviderFactProvenanceClaim[];
  verifier:
    | ProviderFactProvenanceVerifier
    | undefined;
}

export function collectProviderFactProvenanceClaims({
  plan,
  baseWorkflow
}: CollectProviderFactProvenanceClaimsOptions):
  ProviderFactProvenanceClaim[] {
  const provider = plan.policyBinding.provider;

  if (provider !== "github" && provider !== "linear") {
    return [];
  }

  const eventsById = new Map(
    plan.events.map((event) => [
      event.eventId,
      event
    ])
  );
  const claimsByDigest = new Map<
    string,
    ProviderFactProvenanceClaim
  >();
  const updateRequirements: Array<{
    providerObjectKey: string;
    sourceRevisionId: string;
    contentDigest: string;
    eventOccurredAt: string;
  }> = [];

  for (const action of plan.actions) {
    if (action.kind === "conflict") {
      continue;
    }

    if (action.eventIds.length === 0) {
      throw unavailable();
    }

    if (action.eventIds.length !== 1) {
      throw mismatch();
    }

    const event = eventsById.get(
      action.eventIds[0] ?? ""
    );

    if (!event) {
      throw mismatch();
    }

    if (event.type === "work_item.updated") {
      updateRequirements.push(
        readUpdateRequirement(action, event)
      );
      continue;
    }

    const claim = createClaimForEvent({
      provider,
      action,
      event,
      scopeRef: plan.policyBinding.scopeRef,
      baseWorkflow
    });

    claimsByDigest.set(
      claim.claimDigest,
      claim
    );
  }

  for (const requirement of updateRequirements) {
    const matchingClaims = [
      ...claimsByDigest.values()
    ].filter(
      (claim) =>
        claim.objectType === "issue" &&
        claim.providerObjectKey ===
          requirement.providerObjectKey &&
        claim.sourceRevisionId ===
          requirement.sourceRevisionId &&
        claim.contentDigest ===
          requirement.contentDigest
    );

    if (matchingClaims.length === 0) {
      throw unavailable();
    }

    if (
      !matchingClaims.some(
        (claim) =>
          claim.sourceOccurredAt ===
          requirement.eventOccurredAt
      )
    ) {
      throw mismatch();
    }
  }

  if (
    claimsByDigest.size >
    MAX_PROVIDER_FACT_PROVENANCE_CLAIMS
  ) {
    throw unavailable();
  }

  return [...claimsByDigest.values()].sort(
    (left, right) =>
      left.claimDigest.localeCompare(
        right.claimDigest
      )
  );
}

export function computeProviderFactProvenanceClaimDigest(
  claim:
    | ProviderFactProvenanceClaimContent
    | ProviderFactProvenanceClaim
): string {
  const {
    claimDigest: _claimDigest,
    ...content
  } = claim as ProviderFactProvenanceClaim;

  return digestCanonicalJson(content);
}

export async function verifyProviderFactProvenance({
  claims,
  verifier
}: VerifyProviderFactProvenanceOptions): Promise<void> {
  if (claims.length === 0) {
    return;
  }

  if (
    !verifier ||
    claims.length >
      MAX_PROVIDER_FACT_PROVENANCE_CLAIMS
  ) {
    throw unavailable();
  }

  const expected = new Set<string>();

  for (const claim of claims) {
    if (
      computeProviderFactProvenanceClaimDigest(
        claim
      ) !== claim.claimDigest ||
      expected.has(claim.claimDigest)
    ) {
      throw unavailable();
    }

    expected.add(claim.claimDigest);
  }

  let rawResults: unknown;

  try {
    rawResults = await verifier.verify(
      structuredClone(claims)
    );
  } catch {
    throw unavailable();
  }

  try {
    if (
      !Array.isArray(rawResults) ||
      rawResults.length !== expected.size
    ) {
      throw unavailable();
    }

    const returned = new Set<string>();
    let hasMismatch = false;

    for (const rawResult of rawResults) {
      const result = normalizeResult(rawResult);

      if (
        !expected.has(result.claimDigest) ||
        returned.has(result.claimDigest)
      ) {
        throw unavailable();
      }

      returned.add(result.claimDigest);
      hasMismatch ||=
        result.outcome === "mismatch";
    }

    if (returned.size !== expected.size) {
      throw unavailable();
    }

    if (hasMismatch) {
      throw mismatch();
    }
  } catch (error) {
    if (
      error instanceof ProviderFactProvenanceError
    ) {
      throw error;
    }

    throw unavailable();
  }
}

export class ProviderFactProvenanceError
  extends Error {
  readonly code:
    | "PROVIDER_FACT_PROVENANCE_MISMATCH"
    | "PROVIDER_FACT_PROVENANCE_UNAVAILABLE";

  constructor(
    code:
      | "PROVIDER_FACT_PROVENANCE_MISMATCH"
      | "PROVIDER_FACT_PROVENANCE_UNAVAILABLE",
    message: string
  ) {
    super(message);
    this.name = "ProviderFactProvenanceError";
    this.code = code;
  }
}

function createClaimForEvent({
  provider,
  action,
  event,
  scopeRef,
  baseWorkflow
}: {
  provider: "github" | "linear";
  action: ImportAction;
  event: ImportPlanEvent;
  scopeRef: ScopeRef;
  baseWorkflow: Workflow;
}): ProviderFactProvenanceClaim {
  const identity = readSourceIdentity(
    action.sourceObjectKey,
    provider
  );

  if (
    !identity ||
    event.workItemId !== action.workItemId
  ) {
    throw mismatch();
  }

  let content: ProviderFactProvenanceClaimContent;

  if (
    identity.objectType === "issue" &&
    (
      event.type === "work_item.created" ||
      event.type === "external_link.linked"
    )
  ) {
    const link = readPlannedIssueLink({
      value:
        event.type === "work_item.created"
          ? event.payload.externalLink
          : event.payload.link,
      provider,
      identity,
      action,
      scopeRef
    });
    if (
      event.type === "work_item.created" &&
      event.payload.title !== link.title
    ) {
      throw mismatch();
    }
    content = createIssueClaimContent({
      provider,
      action,
      identity,
      scopeRef,
      url: link.url,
      contentDigest: link.contentDigest,
      title: link.title,
      sourceOccurredAt:
        link.sourceOccurredAt,
      eventType: event.type,
      eventOccurredAt: event.occurredAt
    });
  } else if (
    identity.objectType === "issue" &&
    event.type === "external_link.observed"
  ) {
    const observation =
      readPlannedIssueObservation({
        event,
        action,
        provider,
        identity,
        scopeRef,
        baseWorkflow
      });
    content = createIssueClaimContent({
      provider,
      action,
      identity,
      scopeRef,
      url: observation.url,
      contentDigest:
        observation.contentDigest,
      title: observation.title,
      sourceOccurredAt:
        observation.sourceOccurredAt,
      eventType: event.type,
      eventOccurredAt: event.occurredAt
    });
  } else if (
    provider === "github" &&
    identity.objectType === "pull_request" &&
    event.type === "artifact.linked"
  ) {
    const payload = event.payload;
    if (
      payload.artifactId !==
        `pr-${identity.externalId}` ||
      payload.kind !== "pull_request" ||
      typeof payload.revision !== "string" ||
      payload.revision.length === 0 ||
      typeof payload.url !== "string"
    ) {
      throw mismatch();
    }

    const sourceObject = {
      providerObjectKey: action.sourceObjectKey,
      provider,
      objectType: "pull_request" as const,
      externalId: identity.externalId,
      url: payload.url
    };
    content = {
      schemaVersion: 1,
      provider,
      objectType: "pull_request",
      providerObjectKey:
        action.sourceObjectKey,
      externalId: identity.externalId,
      scopeRef: cloneScopeRef(scopeRef),
      url: payload.url,
      sourceRevisionId:
        action.sourceRevisionId,
      sourceOccurredAt: event.occurredAt,
      eventType: "artifact.linked",
      eventOccurredAt: event.occurredAt,
      contentDigest: digestProviderFactContent({
        sourceObject,
        observed: {
          headRevision: payload.revision
        }
      }),
      content: {
        kind: "pull_request",
        headRevision: payload.revision
      },
      locator: parseGitHubPullRequestLocator(
        payload.url,
        scopeRef
      )
    };
  } else if (
    provider === "github" &&
    identity.objectType === "check" &&
    event.type === "evidence.recorded"
  ) {
    const payload = event.payload;
    if (
      payload.evidenceId !==
        `check-${identity.externalId}` ||
      typeof payload.revision !== "string" ||
      payload.revision.length === 0 ||
      (
        payload.outcome !== "passed" &&
        payload.outcome !== "failed"
      ) ||
      typeof payload.url !== "string"
    ) {
      throw mismatch();
    }

    const sourceObject = {
      providerObjectKey: action.sourceObjectKey,
      provider,
      objectType: "check" as const,
      externalId: identity.externalId,
      url: payload.url
    };
    content = {
      schemaVersion: 1,
      provider,
      objectType: "check",
      providerObjectKey:
        action.sourceObjectKey,
      externalId: identity.externalId,
      scopeRef: cloneScopeRef(scopeRef),
      url: payload.url,
      sourceRevisionId:
        action.sourceRevisionId,
      sourceOccurredAt: event.occurredAt,
      eventType: "evidence.recorded",
      eventOccurredAt: event.occurredAt,
      contentDigest: digestProviderFactContent({
        sourceObject,
        observed: {
          headRevision: payload.revision,
          outcome: payload.outcome
        }
      }),
      content: {
        kind: "check",
        headRevision: payload.revision,
        outcome: payload.outcome
      },
      locator: {
        kind: "github.check_run",
        id: identity.externalId
      }
    };
  } else {
    throw mismatch();
  }

  return {
    ...content,
    claimDigest:
      computeProviderFactProvenanceClaimDigest(
        content
      )
  };
}

function readUpdateRequirement(
  action: ImportAction,
  event: ImportPlanEvent
): {
  providerObjectKey: string;
  sourceRevisionId: string;
  contentDigest: string;
  eventOccurredAt: string;
} {
  const source = event.payload.source;

  if (
    !isRecord(source) ||
    source.providerObjectKey !==
      action.sourceObjectKey ||
    source.revisionId !==
      action.sourceRevisionId ||
    !isDigest(source.contentDigest)
  ) {
    throw mismatch();
  }

  return {
    providerObjectKey:
      action.sourceObjectKey,
    sourceRevisionId:
      action.sourceRevisionId,
    contentDigest: source.contentDigest,
    eventOccurredAt: event.occurredAt
  };
}

function readPlannedIssueLink({
  value,
  provider,
  identity,
  action,
  scopeRef
}: {
  value: unknown;
  provider: "github" | "linear";
  identity: {
    externalId: string;
  };
  action: ImportAction;
  scopeRef: ScopeRef;
}): {
  url: string;
  contentDigest: string;
  title: string;
  sourceOccurredAt: string;
} {
  if (
    !isRecord(value) ||
    value.providerObjectKey !==
      action.sourceObjectKey ||
    value.provider !== provider ||
    value.objectType !== "issue" ||
    value.externalId !== identity.externalId ||
    typeof value.url !== "string" ||
    !isScopeRef(value.scopeRef) ||
    !scopeRefsEqual(value.scopeRef, scopeRef) ||
    !isRecord(value.lastObservation) ||
    value.lastObservation.revisionId !==
      action.sourceRevisionId ||
    typeof value.lastObservation.title !==
      "string" ||
    !isTimestamp(
      value.lastObservation.occurredAt
    ) ||
    !isDigest(
      value.lastObservation.contentDigest
    ) ||
    value.lastObservation.url !== undefined
  ) {
    throw mismatch();
  }

  return {
    url: value.url,
    contentDigest:
      value.lastObservation.contentDigest,
    title: value.lastObservation.title,
    sourceOccurredAt:
      value.lastObservation.occurredAt
  };
}

function readPlannedIssueObservation({
  event,
  action,
  provider,
  identity,
  scopeRef,
  baseWorkflow
}: {
  event: ImportPlanEvent;
  action: ImportAction;
  provider: "github" | "linear";
  identity: {
    externalId: string;
  };
  scopeRef: ScopeRef;
  baseWorkflow: Workflow;
}): {
  url: string;
  contentDigest: string;
  title: string;
  sourceOccurredAt: string;
} {
  const observation =
    event.payload.observation;
  const baseline = event.payload.baseline;
  const baseLink = findBaseLink(
    baseWorkflow,
    action
  );

  if (
    event.payload.providerObjectKey !==
      action.sourceObjectKey ||
    !isRecord(observation) ||
    observation.revisionId !==
      action.sourceRevisionId ||
    !isDigest(observation.contentDigest) ||
    typeof observation.title !== "string" ||
    !isTimestamp(observation.occurredAt) ||
    typeof observation.url !== "string" ||
    !baseLink ||
    baseLink.provider !== provider ||
    baseLink.externalId !== identity.externalId
  ) {
    throw mismatch();
  }

  if (baseline === undefined) {
    if (
      baseLink.legacy === true ||
      baseLink.objectType !== "issue" ||
      !scopeRefsEqual(
        baseLink.scopeRef,
        scopeRef
      )
    ) {
      throw mismatch();
    }
  } else if (
    !isRecord(baseline) ||
    baseline.providerObjectKey !==
      action.sourceObjectKey ||
    baseline.objectType !== "issue" ||
    !isScopeRef(baseline.scopeRef) ||
    !scopeRefsEqual(
      baseline.scopeRef,
      scopeRef
    ) ||
    baseLink.legacy !== true
  ) {
    throw mismatch();
  }

  return {
    url: observation.url,
    contentDigest:
      observation.contentDigest,
    title: observation.title,
    sourceOccurredAt:
      observation.occurredAt
  };
}

function findBaseLink(
  workflow: Workflow,
  action: ImportAction
): ExternalLink | undefined {
  return workflow.workItems[
    action.workItemId
  ]?.externalLinks.find(
    (link) =>
      link.providerObjectKey ===
      action.sourceObjectKey
  );
}

function createIssueClaimContent({
  provider,
  action,
  identity,
  scopeRef,
  url,
  contentDigest,
  title,
  sourceOccurredAt,
  eventType,
  eventOccurredAt
}: {
  provider: "github" | "linear";
  action: ImportAction;
  identity: {
    externalId: string;
  };
  scopeRef: ScopeRef;
  url: string;
  contentDigest: string;
  title: string;
  sourceOccurredAt: string;
  eventType:
    | "work_item.created"
    | "external_link.linked"
    | "external_link.observed";
  eventOccurredAt: string;
}): ProviderFactProvenanceClaimContent {
  return {
    schemaVersion: 1,
    provider,
    objectType: "issue",
    providerObjectKey:
      action.sourceObjectKey,
    externalId: identity.externalId,
    scopeRef: cloneScopeRef(scopeRef),
    url,
    sourceRevisionId:
      action.sourceRevisionId,
    sourceOccurredAt,
    eventType,
    eventOccurredAt,
    contentDigest,
    content: {
      kind: "issue",
      title
    },
    locator:
      provider === "github"
        ? parseGitHubIssueLocator(
            url,
            scopeRef
          )
        : parseLinearIssueLocator({
            url,
            externalId: identity.externalId,
            scopeRef
          })
  };
}

function parseGitHubIssueLocator(
  url: string,
  scopeRef: ScopeRef
): Extract<
  ProviderFactProvenanceLocator,
  { kind: "github.issue" }
> {
  return {
    kind: "github.issue",
    number: parseGitHubNumberLocator({
      url,
      scopeRef,
      pathKind: "issues"
    })
  };
}

function parseGitHubPullRequestLocator(
  url: string,
  scopeRef: ScopeRef
): Extract<
  ProviderFactProvenanceLocator,
  { kind: "github.pull_request" }
> {
  return {
    kind: "github.pull_request",
    number: parseGitHubNumberLocator({
      url,
      scopeRef,
      pathKind: "pull"
    })
  };
}

function parseGitHubNumberLocator({
  url,
  scopeRef,
  pathKind
}: {
  url: string;
  scopeRef: ScopeRef;
  pathKind: "issues" | "pull";
}): number {
  const repository = readScopeCoordinate(
    scopeRef,
    "github",
    "repository"
  );
  const parsed = parseHttpsUrl(url);
  const parts = parsed.pathname.split("/");
  const [owner, name] = repository.split("/");
  const numberText = parts[4];
  const number =
    typeof numberText === "string" &&
    /^\d+$/.test(numberText)
      ? Number(numberText)
      : Number.NaN;

  if (
    parsed.hostname.toLowerCase() !== "github.com" ||
    parts.length !== 5 ||
    parts[0] !== "" ||
    parts[1]?.toLowerCase() !== owner ||
    parts[2]?.toLowerCase() !== name ||
    parts[3] !== pathKind ||
    !Number.isSafeInteger(number) ||
    number <= 0
  ) {
    throw mismatch();
  }

  return number;
}

function parseLinearIssueLocator(
  {
    url,
    externalId,
    scopeRef
  }: {
    url: string;
    externalId: string;
    scopeRef: ScopeRef;
  }
): Extract<
  ProviderFactProvenanceLocator,
  { kind: "linear.issue" }
> {
  readScopeUuid(
    scopeRef,
    "linear",
    "team",
    "organization"
  );
  const parsed = parseHttpsUrl(url);
  const parts = parsed.pathname.split("/");
  const issueIndex = parts.indexOf("issue");
  const identifier = parts[issueIndex + 1];

  if (
    parsed.hostname.toLowerCase() !== "linear.app" ||
    issueIndex < 2 ||
    typeof identifier !== "string" ||
    !/^[A-Za-z][A-Za-z0-9]*-[1-9]\d*$/.test(
      identifier
    )
  ) {
    throw mismatch();
  }

  return {
    kind: "linear.issue",
    id: externalId,
    identifier
  };
}

function readSourceIdentity(
  sourceObjectKey: string,
  provider: "github" | "linear"
): {
  objectType: "issue" | "pull_request" | "check";
  externalId: string;
} | null {
  const prefix = `${provider}:`;
  if (!sourceObjectKey.startsWith(prefix)) {
    return null;
  }

  const remainder = sourceObjectKey.slice(
    prefix.length
  );
  const separator = remainder.indexOf(":");
  const objectType = remainder.slice(0, separator);
  const externalId = remainder.slice(separator + 1);

  if (
    separator <= 0 ||
    externalId.length === 0 ||
    (
      objectType !== "issue" &&
      objectType !== "pull_request" &&
      objectType !== "check"
    )
  ) {
    return null;
  }

  return {
    objectType,
    externalId
  };
}

function readScopeCoordinate(
  scopeRef: ScopeRef,
  provider: string,
  kind: string
): string {
  const prefix = `${provider}:${kind}:`;
  if (
    scopeRef.kind !== kind ||
    scopeRef.parentKey !== undefined ||
    !scopeRef.key.startsWith(prefix)
  ) {
    throw mismatch();
  }

  const coordinate = scopeRef.key.slice(
    prefix.length
  );
  const parts = coordinate.split("/");
  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        part.length === 0 ||
        part !== part.toLowerCase()
    )
  ) {
    throw mismatch();
  }

  return coordinate;
}

function readScopeUuid(
  scopeRef: ScopeRef,
  provider: string,
  kind: string,
  parentKind: string
): {
  key: string;
  parentKey: string;
} {
  const keyPrefix = `${provider}:${kind}:`;
  const parentPrefix =
    `${provider}:${parentKind}:`;
  const key = scopeRef.key.slice(keyPrefix.length);
  const parentKey =
    typeof scopeRef.parentKey === "string"
      ? scopeRef.parentKey.slice(
          parentPrefix.length
        )
      : "";

  if (
    scopeRef.kind !== kind ||
    !scopeRef.key.startsWith(keyPrefix) ||
    typeof scopeRef.parentKey !== "string" ||
    !scopeRef.parentKey.startsWith(parentPrefix) ||
    !isUuid(key) ||
    !isUuid(parentKey)
  ) {
    throw mismatch();
  }

  return {
    key,
    parentKey
  };
}

function parseHttpsUrl(value: string): URL {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw mismatch();
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    throw mismatch();
  }

  return parsed;
}

function normalizeResult(
  value: unknown
): ProviderFactProvenanceVerificationResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "claimDigest",
      "outcome"
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.claimDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(
      value.claimDigest
    ) ||
    (
      value.outcome !== "verified" &&
      value.outcome !== "mismatch"
    )
  ) {
    throw unavailable();
  }

  return {
    schemaVersion: 1,
    claimDigest: value.claimDigest,
    outcome: value.outcome
  };
}

function cloneScopeRef(scopeRef: ScopeRef): ScopeRef {
  return {
    kind: scopeRef.kind,
    key: scopeRef.key,
    ...(scopeRef.parentKey === undefined
      ? {}
      : { parentKey: scopeRef.parentKey })
  };
}

function scopeRefsEqual(
  left: ScopeRef,
  right: ScopeRef
): boolean {
  return (
    left.kind === right.kind &&
    left.key === right.key &&
    left.parentKey === right.parentKey
  );
}

function isScopeRef(
  value: unknown
): value is ScopeRef {
  return (
    isRecord(value) &&
    typeof value.kind === "string" &&
    typeof value.key === "string" &&
    (
      value.parentKey === undefined ||
      typeof value.parentKey === "string"
    )
  );
}

function isDigest(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(value)
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => keys.includes(key))
  );
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

function mismatch(): ProviderFactProvenanceError {
  return new ProviderFactProvenanceError(
    "PROVIDER_FACT_PROVENANCE_MISMATCH",
    "Provider fact provenance does not match the projected import."
  );
}

function unavailable(): ProviderFactProvenanceError {
  return new ProviderFactProvenanceError(
    "PROVIDER_FACT_PROVENANCE_UNAVAILABLE",
    "Provider fact provenance could not be verified."
  );
}
