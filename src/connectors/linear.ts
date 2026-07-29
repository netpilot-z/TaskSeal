import {
  digestProviderFactContent
} from "../lib/provider-snapshot.ts";
import type { ProviderIssueFact } from "../lib/provider-snapshot.ts";
import type { WorkItemCreatedEvent } from "../domain/workflow.ts";

interface LinearIssueDto {
  id: string;
  identifier: string;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

interface LinearIssueMapping {
  workItemId: string;
  requiredEvidence: string[];
}

export function normalizeLinearIssue(
  issue: unknown,
  mapping?: unknown
): WorkItemCreatedEvent {
  return createLinearIssueEvent(
    normalizeLinearIssueDto(issue),
    normalizeLinearIssueMapping(mapping)
  );
}

export function normalizeLinearIssueFact(
  issue: unknown,
  mapping?: unknown
): ProviderIssueFact {
  const normalizedIssue =
    normalizeLinearIssueDto(issue);
  const normalizedMapping =
    normalizeLinearIssueMapping(mapping);
  const externalId =
    normalizedIssue.id.toLowerCase();
  const candidateEvent = createLinearIssueEvent(
    normalizedIssue,
    normalizedMapping
  );
  candidateEvent.eventId =
    `linear:${externalId}:created`;
  candidateEvent.payload.externalLink.externalId =
    externalId;

  const fact: ProviderIssueFact = {
    sourceObject: {
      providerObjectKey:
        `linear:issue:${externalId}`,
      provider: "linear",
      objectType: "issue",
      externalId,
      url: normalizedIssue.url
    },
    revision: {
      id: normalizedIssue.updatedAt,
      occurredAt: normalizedIssue.updatedAt,
      contentDigest: ""
    },
    observed: {
      title: normalizedIssue.title,
      createdAt: normalizedIssue.createdAt
    },
    candidateEvent
  };

  fact.revision.contentDigest =
    digestProviderFactContent(fact);
  return fact;
}

export function isLinearIssueReference(
  value: unknown
): value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0
  ) {
    return false;
  }

  const reference = value.trim();

  if (/^\d+$/.test(reference)) {
    return isPositiveSafeInteger(reference);
  }

  const identifier =
    /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(
      reference
    );

  if (identifier) {
    return isPositiveSafeInteger(identifier[2]);
  }

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    reference
  );
}

export function normalizeLinearIssueUrl(
  value: unknown
): string {
  return normalizeHttpUrl(value, "url");
}

function createLinearIssueEvent(
  issue: LinearIssueDto,
  mapping: LinearIssueMapping
): WorkItemCreatedEvent {
  return {
    eventId: `linear:${issue.id}:created`,
    workItemId: mapping.workItemId,
    type: "work_item.created",
    occurredAt: issue.createdAt,
    payload: {
      title: issue.title,
      requiredEvidence: [...mapping.requiredEvidence],
      externalLink: {
        provider: "linear",
        externalId: issue.id,
        url: issue.url
      }
    }
  };
}

function normalizeLinearIssueDto(
  issue: unknown
): LinearIssueDto {
  const id = readProperty(issue, "id");
  const identifier = readProperty(
    issue,
    "identifier"
  );
  const title = readProperty(issue, "title");
  const url = readProperty(issue, "url");
  const createdAt = readProperty(issue, "createdAt");
  const updatedAt = readProperty(issue, "updatedAt");

  requireString(id, "id");
  requireString(identifier, "identifier");
  requireString(title, "title");
  const normalizedUrl =
    normalizeLinearIssueUrl(url);
  requireString(createdAt, "createdAt");
  requireString(updatedAt, "updatedAt");

  return {
    id,
    identifier,
    title,
    url: normalizedUrl,
    createdAt,
    updatedAt
  };
}

function normalizeLinearIssueMapping(
  mapping: unknown
): LinearIssueMapping {
  const workItemId = readOptionalProperty(
    mapping,
    "workItemId"
  );
  const requiredEvidence = readOptionalProperty(
    mapping,
    "requiredEvidence"
  );

  requireMappingString(workItemId, "workItemId");
  requireEvidenceKeys(requiredEvidence);

  return {
    workItemId,
    requiredEvidence
  };
}

function isPositiveSafeInteger(
  value: string | undefined
): boolean {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0;
}

function requireMappingString(
  value: unknown,
  field: string
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0
  ) {
    throw new TypeError(
      `Linear mapping ${field} must be a non-empty string.`
    );
  }
}

function requireEvidenceKeys(
  value: unknown
): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        item.trim().length === 0
    )
  ) {
    throw new TypeError(
      "Linear mapping requiredEvidence must be a non-empty string array."
    );
  }
}

function requireString(
  value: unknown,
  field: string
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0
  ) {
    throw new TypeError(
      `Linear issue ${field} must be a non-empty string.`
    );
  }
}

function normalizeHttpUrl(
  value: unknown,
  field: string
): string {
  requireString(value, field);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(
      `Linear issue ${field} must be an http or https URL.`
    );
  }

  if (
    url.protocol !== "https:" &&
    url.protocol !== "http:"
  ) {
    throw new TypeError(
      `Linear issue ${field} must be an http or https URL.`
    );
  }

  return url.href;
}

function readProperty(
  value: unknown,
  key: string
): unknown {
  if (value === null || value === undefined) {
    throw new TypeError(
      `Cannot read properties of ${String(value)} (reading '${key}')`
    );
  }

  return Reflect.get(Object(value), key);
}

function readOptionalProperty(
  value: unknown,
  key: string
): unknown {
  return value === null || value === undefined
    ? undefined
    : Reflect.get(Object(value), key);
}
