import {
  digestCanonicalJson
} from "../lib/canonical-json.ts";

const APPLY_CAPABILITY = "snapshot.import.apply";
export type ImportProvider = "github" | "linear";
export type ProviderObjectType =
  | "check"
  | "issue"
  | "pull_request";

export interface ProviderScopeRef {
  kind: "repository" | "team";
  key: string;
  parentKey?: string;
}

export interface AllowedImportScope {
  provider: ImportProvider;
  scopeRef: ProviderScopeRef;
  objectTypes: ProviderObjectType[];
}

export interface NormalizedImportPolicy {
  schemaVersion: 1;
  capabilities: {
    "snapshot.import.apply": boolean;
  };
  allowedScopes: AllowedImportScope[];
}

export interface PolicyBinding {
  schemaVersion: 1;
  capability: "snapshot.import.apply";
  applyAllowed: boolean;
  provider: ImportProvider;
  scopeRef: ProviderScopeRef;
  requiredObjectTypes: ProviderObjectType[];
}

export interface BoundImportPolicy {
  policyBinding: PolicyBinding;
  policyDigest: string;
}

const PROVIDER_OBJECT_TYPES: Readonly<
  Record<ImportProvider, ReadonlySet<string>>
> = {
  github: new Set(["check", "issue", "pull_request"]),
  linear: new Set(["issue"])
};

export function normalizeImportPolicy(
  importPolicy: unknown
): NormalizedImportPolicy {
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
  const seenScopes = new Set<string>();

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
}: {
  importPolicy: unknown;
  provider: unknown;
  scopeRef: unknown;
  requiredObjectTypes: unknown;
}): BoundImportPolicy {
  const normalizedPolicy = normalizeImportPolicy(importPolicy);
  let normalizedProvider: ImportProvider;
  let normalizedScopeRef: ProviderScopeRef;
  let normalizedTypes: ProviderObjectType[];

  try {
    normalizedProvider = normalizeProvider(provider);
    normalizedScopeRef = normalizeScopeRef(
      normalizedProvider,
      scopeRef
    );
    normalizedTypes = normalizeObjectTypes(
      normalizedProvider,
      requiredObjectTypes
    );
  } catch {
    throw scopeMismatch();
  }

  const allowedScope = normalizedPolicy.allowedScopes.find(
    (scope) =>
      scope.provider === normalizedProvider &&
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
    provider: normalizedProvider,
    scopeRef: normalizedScopeRef,
    requiredObjectTypes: normalizedTypes
  });

  return {
    policyBinding,
    policyDigest: computePolicyDigest(policyBinding)
  };
}

export function normalizePolicyBinding(
  value: unknown
): PolicyBinding {
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
    !isProvider(value.provider)
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

export function computePolicyDigest(
  policyBinding: unknown
): string {
  return digestCanonicalJson(
    normalizePolicyBinding(policyBinding)
  );
}

function normalizeAllowedScope(
  value: unknown
): AllowedImportScope {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, [
      "provider",
      "scopeRef",
      "objectTypes"
    ]) ||
    !isProvider(value.provider)
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

function normalizeScopeRef(
  provider: ImportProvider,
  value: unknown
): ProviderScopeRef {
  if (!isPlainRecord(value)) {
    throw invalidPolicy();
  }

  if (
    provider === "github" &&
    hasOnlyKeys(value, ["kind", "key"]) &&
    value.kind === "repository" &&
    typeof value.key === "string"
  ) {
    const match =
      /^github:repository:([^/]+)\/([^/]+)$/.exec(value.key);

    if (!match) {
      throw invalidPolicy();
    }

    const owner = match?.[1];
    const repository = match?.[2];

    if (!owner || !repository) {
      throw invalidPolicy();
    }

    const normalizedOwner = owner.toLowerCase();
    const normalizedRepository = repository.toLowerCase();

    if (
      !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(
        normalizedOwner
      ) ||
      !/^[a-z0-9._-]{1,100}$/.test(normalizedRepository)
    ) {
      throw invalidPolicy();
    }

    return {
      kind: "repository",
      key:
        `github:repository:${normalizedOwner}/${normalizedRepository}`
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

function normalizeScopedUuid(
  value: unknown,
  prefix: string
): string {
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

function normalizeObjectTypes(
  provider: ImportProvider,
  value: unknown
): ProviderObjectType[] {
  const allowedTypes = PROVIDER_OBJECT_TYPES[provider];

  if (
    !isDenseArray(value) ||
    value.length === 0
  ) {
    throw invalidPolicy();
  }

  const normalized: ProviderObjectType[] = [];
  for (const objectType of value) {
    if (
      !isProviderObjectType(objectType) ||
      !allowedTypes.has(objectType)
    ) {
      throw invalidPolicy();
    }
    normalized.push(objectType);
  }

  if (new Set(normalized).size !== normalized.length) {
    throw invalidPolicy();
  }

  return normalized.toSorted();
}

function scopeRefsEqual(
  left: ProviderScopeRef,
  right: ProviderScopeRef
): boolean {
  return (
    left.kind === right.kind &&
    left.key === right.key &&
    left.parentKey === right.parentKey
  );
}

function compareAllowedScopes(
  left: AllowedImportScope,
  right: AllowedImportScope
): number {
  return (
    compareStrings(left.provider, right.provider) ||
    compareStrings(left.scopeRef.key, right.scopeRef.key)
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[]
): boolean {
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
  const descriptors = Object.getOwnPropertyDescriptors(value);

  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return false;
    }
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return false;
    }
  }

  return true;
}

function isDenseArray(value: unknown): value is unknown[] {
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

function invalidPolicy(): ImportPolicyError {
  return new ImportPolicyError(
    "IMPORT_POLICY_INVALID",
    "ImportPolicy does not match the supported versioned schema."
  );
}

function scopeMismatch(): ImportPolicyError {
  return new ImportPolicyError(
    "SNAPSHOT_SCOPE_MISMATCH",
    "The snapshot target is not covered by ImportPolicy."
  );
}

export class ImportPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ImportPolicyError";
    this.code = code;
  }
}

function normalizeProvider(value: unknown): ImportProvider {
  if (!isProvider(value)) {
    throw invalidPolicy();
  }
  return value;
}

function isProvider(value: unknown): value is ImportProvider {
  return value === "github" || value === "linear";
}

function isProviderObjectType(
  value: unknown
): value is ProviderObjectType {
  return (
    value === "check" ||
    value === "issue" ||
    value === "pull_request"
  );
}
