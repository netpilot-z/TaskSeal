export function normalizeLinearIssue(issue, mapping) {
  requireString(issue.id, "id");
  requireString(issue.identifier, "identifier");
  requireString(issue.title, "title");
  requireHttpUrl(issue.url, "url");
  requireString(issue.createdAt, "createdAt");
  requireString(issue.updatedAt, "updatedAt");
  requireMappingString(mapping?.workItemId, "workItemId");

  const requiredEvidence = mapping?.requiredEvidence;

  if (
    !Array.isArray(requiredEvidence) ||
    requiredEvidence.length === 0 ||
    requiredEvidence.some(
      (item) => typeof item !== "string" || item.trim().length === 0
    )
  ) {
    throw new TypeError(
      "Linear mapping requiredEvidence must be a non-empty string array."
    );
  }

  return {
    eventId: `linear:${issue.id}:created`,
    workItemId: mapping.workItemId,
    type: "work_item.created",
    occurredAt: issue.createdAt,
    payload: {
      title: issue.title,
      requiredEvidence: [...requiredEvidence],
      externalLink: {
        provider: "linear",
        externalId: issue.id,
        url: issue.url
      }
    }
  };
}

export function isLinearIssueReference(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }

  const reference = value.trim();

  if (/^\d+$/.test(reference)) {
    return isPositiveSafeInteger(reference);
  }

  const identifier = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(reference);

  if (identifier) {
    return isPositiveSafeInteger(identifier[2]);
  }

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    reference
  );
}

function isPositiveSafeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0;
}

function requireMappingString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(
      `Linear mapping ${field} must be a non-empty string.`
    );
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Linear issue ${field} must be a non-empty string.`);
  }
}

function requireHttpUrl(value, field) {
  requireString(value, field);

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`Linear issue ${field} must be an http or https URL.`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError(`Linear issue ${field} must be an http or https URL.`);
  }
}
