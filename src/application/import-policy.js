import {
  digestCanonicalJson
} from "../lib/canonical-json.js";

const APPLY_CAPABILITY = "snapshot.import.apply";
const PROVIDER_OBJECT_TYPES = {
  github: new Set(["check", "issue", "pull_request"]),
  linear: new Set(["issue"])
};

export function normalizeImportPolicy(importPolicy) {
  if (
    !isPlainRecord(importPolicy) ||
    !hasOnlyKeys(importPolicy, [
      "schemaVersion",
      "capabilities",
      "allowedScopes"
    ]) ||
    importPolicy.schemaVersion !== 1 ||
    !isPlainRecord(importPolicy.capabilities) ||
    !hasOnlyKeys(importPolicy.capabilities, [
      APPLY_CAPABILITY
    ]) ||
    typeof importPolicy.capabilities[APPLY_CAPABILITY] !==
      "boolean" ||
    !isDenseArray(importPolicy.allowedScopes) ||
    importPolicy.allowedScopes.length > 32
  ) {
    throw invalidPolicy();
  }

  const normalizedScopes = importPolicy.allowedScopes.map(
    normalizeAllowedScope
  );
  const seenScopes = new Set();

  for (const scope of normalizedScopes) {
    const identity = `${scope.provider}:${scope.scopeRef.key}`;

    if (seenScopes.has(identity)) {
      throw invalidPolicy();
    }

    seenScopes.add(identity);
  }

  normalizedScopes.sort(compareAllowedScopes);

  return {
    schemaVersion: 1,
    capabilities: {
      [APPLY_CAPABILITY]:
        importPolicy.capabilities[APPLY_CAPABILITY]
    },
    allowedScopes: normalizedScopes
  };
}

export function buildPolicyBinding({
  importPolicy,
  provider,
  scopeRef,
  requiredObjectTypes
}) {
  const normalizedPolicy = normalizeImportPolicy(importPolicy);
  let normalizedScopeRef;
  let normalizedTypes;

  try {
    normalizedScopeRef = normalizeScopeRef(provider, scopeRef);
    normalizedTypes = normalizeObjectTypes(
      provider,
      requiredObjectTypes
    );
  } catch {
    throw scopeMismatch();
  }

  const allowedScope = normalizedPolicy.allowedScopes.find(
    (scope) =>
      scope.provider === provider &&
      scopeRefsEqual(scope.scopeRef, normalizedScopeRef)
  );

  if (
    !allowedScope ||
    normalizedTypes.some(
      (objectType) =>
        !allowedScope.objectTypes.includes(objectType)
    )
  ) {
    throw scopeMismatch();
  }

  const policyBinding = normalizePolicyBinding({
    schemaVersion: 1,
    capability: APPLY_CAPABILITY,
    applyAllowed:
      normalizedPolicy.capabilities[APPLY_CAPABILITY],
    provider,
    scopeRef: normalizedScopeRef,
    requiredObjectTypes: normalizedTypes
  });

  return {
    policyBinding,
    policyDigest: computePolicyDigest(policyBinding)
  };
}

export function normalizePolicyBinding(value) {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "capability",
      "applyAllowed",
      "provider",
      "scopeRef",
      "requiredObjectTypes"
    ]) ||
    value.schemaVersion !== 1 ||
    value.capability !== APPLY_CAPABILITY ||
    typeof value.applyAllowed !== "boolean" ||
    !Object.hasOwn(PROVIDER_OBJECT_TYPES, value.provider)
  ) {
    throw invalidPolicy();
  }

  return {
    schemaVersion: 1,
    capability: APPLY_CAPABILITY,
    applyAllowed: value.applyAllowed,
    provider: value.provider,
    scopeRef: normalizeScopeRef(
      value.provider,
      value.scopeRef
    ),
    requiredObjectTypes: normalizeObjectTypes(
      value.provider,
      value.requiredObjectTypes
    )
  };
}

export function computePolicyDigest(policyBinding) {
  return digestCanonicalJson(
    normalizePolicyBinding(policyBinding)
  );
}

function normalizeAllowedScope(value) {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, [
      "provider",
      "scopeRef",
      "objectTypes"
    ]) ||
    !Object.hasOwn(PROVIDER_OBJECT_TYPES, value.provider)
  ) {
    throw invalidPolicy();
  }

  return {
    provider: value.provider,
    scopeRef: normalizeScopeRef(
      value.provider,
      value.scopeRef
    ),
    objectTypes: normalizeObjectTypes(
      value.provider,
      value.objectTypes
    )
  };
}

function normalizeScopeRef(provider, value) {
  if (!isPlainRecord(value)) {
    throw invalidPolicy();
  }

  if (
    provider === "github" &&
    hasOnlyKeys(value, ["kind", "key"]) &&
    value.kind === "repository"
  ) {
    const match =
      /^github:repository:([^/]+)\/([^/]+)$/.exec(value.key);

    if (!match) {
      throw invalidPolicy();
    }

    const owner = match[1].toLowerCase();
    const repository = match[2].toLowerCase();

    if (
      !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(
        owner
      ) ||
      !/^[a-z0-9._-]{1,100}$/.test(repository)
    ) {
      throw invalidPolicy();
    }

    return {
      kind: "repository",
      key: `github:repository:${owner}/${repository}`
    };
  }

  if (
    provider === "linear" &&
    hasOnlyKeys(value, ["kind", "key", "parentKey"]) &&
    value.kind === "team"
  ) {
    const teamId = normalizeScopedUuid(
      value.key,
      "linear:team:"
    );
    const organizationId = normalizeScopedUuid(
      value.parentKey,
      "linear:organization:"
    );

    return {
      kind: "team",
      key: `linear:team:${teamId}`,
      parentKey: `linear:organization:${organizationId}`
    };
  }

  throw invalidPolicy();
}

function normalizeScopedUuid(value, prefix) {
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix)
  ) {
    throw invalidPolicy();
  }

  const uuid = value.slice(prefix.length).toLowerCase();

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      uuid
    )
  ) {
    throw invalidPolicy();
  }

  return uuid;
}

function normalizeObjectTypes(provider, value) {
  const allowedTypes = PROVIDER_OBJECT_TYPES[provider];

  if (
    !allowedTypes ||
    !isDenseArray(value) ||
    value.length === 0 ||
    new Set(value).size !== value.length ||
    value.some(
      (objectType) =>
        typeof objectType !== "string" ||
        !allowedTypes.has(objectType)
    )
  ) {
    throw invalidPolicy();
  }

  return [...value].sort();
}

function scopeRefsEqual(left, right) {
  return (
    left.kind === right.kind &&
    left.key === right.key &&
    left.parentKey === right.parentKey
  );
}

function compareAllowedScopes(left, right) {
  return (
    compareStrings(left.provider, right.provider) ||
    compareStrings(left.scopeRef.key, right.scopeRef.key)
  );
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasOnlyKeys(value, allowedKeys) {
  const keys = Reflect.ownKeys(value);

  return (
    keys.length === allowedKeys.length &&
    keys.every(
      (key) =>
        typeof key === "string" &&
        allowedKeys.includes(key)
    )
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
  const descriptors = Object.getOwnPropertyDescriptors(value);

  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every((key) => {
      const descriptor = descriptors[key];
      return (
        typeof key === "string" &&
        descriptor.enumerable &&
        "value" in descriptor
      );
    })
  );
}

function isDenseArray(value) {
  if (!Array.isArray(value)) {
    return false;
  }

  const keys = Reflect.ownKeys(value);
  return (
    keys.length === value.length + 1 &&
    keys.at(-1) === "length" &&
    keys
      .slice(0, -1)
      .every((key, index) => key === String(index))
  );
}

function invalidPolicy() {
  return new ImportPolicyError(
    "IMPORT_POLICY_INVALID",
    "ImportPolicy does not match the supported versioned schema."
  );
}

function scopeMismatch() {
  return new ImportPolicyError(
    "SNAPSHOT_SCOPE_MISMATCH",
    "The snapshot target is not covered by ImportPolicy."
  );
}

export class ImportPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ImportPolicyError";
    this.code = code;
  }
}
