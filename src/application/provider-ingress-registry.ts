export interface ProviderIngressRequest {
  provider: string;
  scopeRef: {
    kind: string;
    key: string;
    parentKey?: string | undefined;
  };
  requiredObjectTypes: string[];
}

export interface ProviderIngressBinding {
  schemaVersion: 1;
  capability: "snapshot.import";
  provider: string;
  scopeKind: string;
  requiredObjectTypes: string[];
}

export interface ProviderIngressRegistry {
  bind(
    request: ProviderIngressRequest
  ): ProviderIngressBinding;
  validate(
    request: ProviderIngressFactRequest
  ): true;
}

export class ProviderIngressRegistryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProviderIngressRegistryError";
    this.code = code;
  }
}

interface ProviderIngressScopeRegistration {
  kind: string;
  objectTypes: string[];
}

interface ProviderIngressRegistration {
  schemaVersion: 1;
  provider: string;
  capability: "snapshot.import";
  scopes: ProviderIngressScopeRegistration[];
  validator: ProviderIngressValidator;
}

export interface ProviderIngressFactRequest {
  provider: string;
  scopeRef: ProviderIngressRequest["scopeRef"];
  sourceObjectKey: string;
  fact:
    | {
        kind: "rich-link";
        value: unknown;
      }
    | {
        kind: "artifact";
        value: unknown;
      }
    | {
        kind: "evidence";
        value: unknown;
      };
}

type ProviderIngressValidator = (
  request: ProviderIngressFactRequest
) => boolean;

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;
const OBJECT_TYPE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const MAX_REGISTRATIONS = 32;
const MAX_SCOPES = 16;
const MAX_OBJECT_TYPES = 32;

const BUILTIN_REGISTRATIONS = [
  {
    schemaVersion: 1,
    provider: "github",
    capability: "snapshot.import",
    validator: validateGitHubIngress,
    scopes: [
      {
        kind: "repository",
        objectTypes: [
          "check",
          "issue",
          "pull_request"
        ]
      }
    ]
  },
  {
    schemaVersion: 1,
    provider: "linear",
    capability: "snapshot.import",
    validator: validateLinearIngress,
    scopes: [
      {
        kind: "team",
        objectTypes: ["issue"]
      }
    ]
  },
  {
    schemaVersion: 1,
    provider: "gitee",
    capability: "snapshot.import",
    validator: validateGiteeIngress,
    scopes: [
      {
        kind: "repository",
        objectTypes: ["issue"]
      }
    ]
  }
] as const;

export const DEFAULT_PROVIDER_INGRESS_REGISTRY =
  createProviderIngressRegistry(BUILTIN_REGISTRATIONS);

export function createProviderIngressRegistry(
  value: unknown
): ProviderIngressRegistry {
  let registrations: ProviderIngressRegistration[];

  try {
    if (
      !isDenseArray(value) ||
      value.length > MAX_REGISTRATIONS
    ) {
      throw invalidRegistry();
    }

    registrations = value.map(normalizeRegistration);
    const providers = registrations.map(
      (registration) => registration.provider
    );

    if (new Set(providers).size !== providers.length) {
      throw invalidRegistry();
    }
  } catch (error) {
    if (
      error instanceof ProviderIngressRegistryError &&
      error.code === "PROVIDER_INGRESS_REGISTRY_INVALID"
    ) {
      throw error;
    }

    throw invalidRegistry();
  }

  const byProvider = new Map(
    registrations.map((registration) => [
      registration.provider,
      registration
    ])
  );

  return Object.freeze({
    bind(
      request: ProviderIngressRequest
    ): ProviderIngressBinding {
      const normalized = normalizeRequest(request);
      const registration = byProvider.get(
        normalized.provider
      );
      const scope = registration?.scopes.find(
        (candidate) =>
          candidate.kind === normalized.scopeRef.kind
      );

      if (
        !scope ||
        normalized.requiredObjectTypes.some(
          (objectType) =>
            !scope.objectTypes.includes(objectType)
        )
      ) {
        throw forbidden();
      }

      return {
        schemaVersion: 1,
        capability: "snapshot.import",
        provider: normalized.provider,
        scopeKind: normalized.scopeRef.kind,
        requiredObjectTypes: [
          ...normalized.requiredObjectTypes
        ]
      };
    },
    validate(
      request: ProviderIngressFactRequest
    ): true {
      const normalized = normalizeFactRequest(request);
      const registration = byProvider.get(
        normalized.provider
      );

      if (
        !registration ||
        Reflect.apply(
          registration.validator,
          undefined,
          [normalized]
        ) !== true
      ) {
        throw forbidden();
      }

      return true;
    }
  });
}

export function authorizeProviderIngress({
  registry,
  provider,
  scopeRef,
  requiredObjectTypes
}: {
  registry: unknown;
  provider: unknown;
  scopeRef: unknown;
  requiredObjectTypes: unknown;
}): ProviderIngressBinding {
  try {
    const request = normalizeRequest({
      provider,
      scopeRef,
      requiredObjectTypes
    });

    if (
      !registry ||
      typeof registry !== "object"
    ) {
      throw forbidden();
    }

    const bind = readOwnDataProperty(registry, "bind");
    if (typeof bind !== "function") {
      throw forbidden();
    }

    const result = Reflect.apply(bind, registry, [request]);
    const binding = normalizeBinding(result);

    if (
      binding.provider !== request.provider ||
      binding.scopeKind !== request.scopeRef.kind ||
      !sameStrings(
        binding.requiredObjectTypes,
        request.requiredObjectTypes
      )
    ) {
      throw forbidden();
    }

    return binding;
  } catch {
    throw forbidden();
  }
}

export function authorizeProviderIngressFact({
  registry,
  provider,
  scopeRef,
  sourceObjectKey,
  fact
}: {
  registry: unknown;
  provider: unknown;
  scopeRef: unknown;
  sourceObjectKey: unknown;
  fact: unknown;
}): void {
  try {
    const request = normalizeFactRequest({
      provider,
      scopeRef,
      sourceObjectKey,
      fact
    });

    if (
      !registry ||
      typeof registry !== "object"
    ) {
      throw forbidden();
    }

    const validate = readOwnDataProperty(
      registry,
      "validate"
    );
    if (typeof validate !== "function") {
      throw forbidden();
    }

    if (
      Reflect.apply(validate, registry, [request]) !== true
    ) {
      throw forbidden();
    }
  } catch {
    throw forbidden();
  }
}

function normalizeRegistration(
  value: unknown
): ProviderIngressRegistration {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "provider",
      "capability",
      "scopes",
      "validator"
    ]) ||
    value.schemaVersion !== 1 ||
    !isIdentifier(value.provider) ||
    value.capability !== "snapshot.import" ||
    typeof value.validator !== "function" ||
    !isDenseArray(value.scopes) ||
    value.scopes.length === 0 ||
    value.scopes.length > MAX_SCOPES
  ) {
    throw invalidRegistry();
  }

  const scopes = value.scopes.map(normalizeScopeRegistration);
  const kinds = scopes.map((scope) => scope.kind);
  if (new Set(kinds).size !== kinds.length) {
    throw invalidRegistry();
  }

  return Object.freeze({
    schemaVersion: 1,
    provider: value.provider,
    capability: "snapshot.import",
    validator: value.validator as ProviderIngressValidator,
    scopes: Object.freeze(scopes) as unknown as
      ProviderIngressScopeRegistration[]
  });
}

function normalizeFactRequest(
  value: unknown
): ProviderIngressFactRequest {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "provider",
      "scopeRef",
      "sourceObjectKey",
      "fact"
    ]) ||
    !isIdentifier(value.provider) ||
    !isNonEmptyString(value.sourceObjectKey) ||
    !isPlainRecord(value.scopeRef) ||
    !hasAllowedExactKeys(
      value.scopeRef,
      ["kind", "key"],
      ["parentKey"]
    ) ||
    !isIdentifier(value.scopeRef.kind) ||
    !isNonEmptyString(value.scopeRef.key) ||
    (
      value.scopeRef.parentKey !== undefined &&
      !isNonEmptyString(value.scopeRef.parentKey)
    ) ||
    !isPlainRecord(value.fact) ||
    !hasExactKeys(value.fact, ["kind", "value"]) ||
    (
      value.fact.kind !== "rich-link" &&
      value.fact.kind !== "artifact" &&
      value.fact.kind !== "evidence"
    )
  ) {
    throw forbidden();
  }

  return {
    provider: value.provider,
    scopeRef: {
      kind: value.scopeRef.kind,
      key: value.scopeRef.key,
      ...(value.scopeRef.parentKey === undefined
        ? {}
        : { parentKey: value.scopeRef.parentKey })
    },
    sourceObjectKey: value.sourceObjectKey,
    fact: {
      kind: value.fact.kind,
      value: value.fact.value
    }
  };
}

function normalizeScopeRegistration(
  value: unknown
): ProviderIngressScopeRegistration {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["kind", "objectTypes"]) ||
    !isIdentifier(value.kind)
  ) {
    throw invalidRegistry();
  }

  const objectTypes = normalizeIdentifiers(
    value.objectTypes,
    MAX_OBJECT_TYPES
  );

  if (objectTypes.length === 0) {
    throw invalidRegistry();
  }

  return Object.freeze({
    kind: value.kind,
    objectTypes: Object.freeze(objectTypes) as unknown as string[]
  });
}

function normalizeRequest(
  value: unknown
): ProviderIngressRequest {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "provider",
      "scopeRef",
      "requiredObjectTypes"
    ]) ||
    !isIdentifier(value.provider) ||
    !isPlainRecord(value.scopeRef) ||
    !hasAllowedExactKeys(
      value.scopeRef,
      ["kind", "key"],
      ["parentKey"]
    ) ||
    !isIdentifier(value.scopeRef.kind) ||
    !isNonEmptyString(value.scopeRef.key) ||
    (
      value.scopeRef.parentKey !== undefined &&
      !isNonEmptyString(value.scopeRef.parentKey)
    )
  ) {
    throw forbidden();
  }

  const requiredObjectTypes = normalizeIdentifiers(
    value.requiredObjectTypes,
    MAX_OBJECT_TYPES
  );

  if (requiredObjectTypes.length === 0) {
    throw forbidden();
  }

  return {
    provider: value.provider,
    scopeRef: {
      kind: value.scopeRef.kind,
      key: value.scopeRef.key,
      ...(value.scopeRef.parentKey === undefined
        ? {}
        : { parentKey: value.scopeRef.parentKey })
    },
    requiredObjectTypes
  };
}

function normalizeBinding(
  value: unknown
): ProviderIngressBinding {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "capability",
      "provider",
      "scopeKind",
      "requiredObjectTypes"
    ]) ||
    value.schemaVersion !== 1 ||
    value.capability !== "snapshot.import" ||
    !isIdentifier(value.provider) ||
    !isIdentifier(value.scopeKind)
  ) {
    throw forbidden();
  }

  const requiredObjectTypes = normalizeIdentifiers(
    value.requiredObjectTypes,
    MAX_OBJECT_TYPES
  );

  if (requiredObjectTypes.length === 0) {
    throw forbidden();
  }

  return {
    schemaVersion: 1,
    capability: "snapshot.import",
    provider: value.provider,
    scopeKind: value.scopeKind,
    requiredObjectTypes
  };
}

function normalizeIdentifiers(
  value: unknown,
  maximumItems: number
): string[] {
  if (
    !isDenseArray(value) ||
    value.length > maximumItems ||
    !value.every(isObjectTypeIdentifier) ||
    new Set(value).size !== value.length
  ) {
    throw invalidRegistry();
  }

  return [...value].sort();
}

function validateGitHubIngress(
  request: ProviderIngressFactRequest
): boolean {
  if (request.provider !== "github") {
    return false;
  }

  if (request.fact.kind === "rich-link") {
    const link = readCommonRichLink(request);
    if (!link || !/^\d+$/.test(link.externalId)) {
      return false;
    }

    return validateGitHubUrl({
      value: link.url,
      scopeRef: request.scopeRef,
      objectType: link.objectType
    });
  }

  const identity = readSourceIdentity(
    request.sourceObjectKey,
    "github"
  );
  const payload = request.fact.value;

  if (!identity || !isPlainRecord(payload)) {
    return false;
  }

  if (request.fact.kind === "artifact") {
    return (
      identity.objectType === "pull_request" &&
      /^\d+$/.test(identity.externalId) &&
      payload.artifactId ===
        `pr-${identity.externalId}` &&
      payload.kind === "pull_request" &&
      typeof payload.url === "string" &&
      validateGitHubUrl({
        value: payload.url,
        scopeRef: request.scopeRef,
        objectType: "pull_request"
      })
    );
  }

  return (
    identity.objectType === "check" &&
    /^\d+$/.test(identity.externalId) &&
    payload.evidenceId ===
      `check-${identity.externalId}` &&
    typeof payload.url === "string" &&
    validateGitHubUrl({
      value: payload.url,
      scopeRef: request.scopeRef,
      objectType: "check"
    })
  );
}

function validateLinearIngress(
  request: ProviderIngressFactRequest
): boolean {
  if (
    request.provider !== "linear" ||
    request.fact.kind !== "rich-link"
  ) {
    return false;
  }

  const link = readCommonRichLink(request);
  if (
    !link ||
    link.objectType !== "issue" ||
    !isUuid(link.externalId) ||
    !isLinearScope(request.scopeRef)
  ) {
    return false;
  }

  const url = parseSafeHttpsUrl(link.url);
  const pathParts = url?.pathname.split("/");
  return (
    url?.hostname.toLowerCase() === "linear.app" &&
    Array.isArray(pathParts) &&
    pathParts.includes("issue") &&
    pathParts.every(
      (part, index) => index === 0 || part.length > 0
    )
  );
}

function validateGiteeIngress(
  request: ProviderIngressFactRequest
): boolean {
  if (
    request.provider !== "gitee" ||
    request.fact.kind !== "rich-link"
  ) {
    return false;
  }

  const link = readCommonRichLink(request);
  const repository = readRepositoryScope(
    request.scopeRef,
    "gitee"
  );

  if (
    !link ||
    !repository ||
    link.objectType !== "issue" ||
    !link.externalId.startsWith(`${repository}#`)
  ) {
    return false;
  }

  const issueReference = link.externalId.slice(
    repository.length + 1
  );
  if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(issueReference)) {
    return false;
  }

  const [owner, name] = repository.split("/");
  const url = parseSafeHttpsUrl(link.url);
  const parts = url?.pathname.split("/");
  return (
    url?.hostname.toLowerCase() === "gitee.com" &&
    Array.isArray(parts) &&
    parts.length === 5 &&
    parts[0] === "" &&
    parts[1]?.toLowerCase() === owner &&
    parts[2]?.toLowerCase() === name &&
    parts[3] === "issues" &&
    parts[4] === issueReference
  );
}

function readCommonRichLink(
  request: ProviderIngressFactRequest
): {
  providerObjectKey: string;
  provider: string;
  objectType: string;
  externalId: string;
  url: string;
} | null {
  const link = request.fact.value;
  if (
    !isPlainRecord(link) ||
    !hasExactKeys(link, [
      "providerObjectKey",
      "provider",
      "objectType",
      "externalId",
      "scopeRef",
      "url",
      "managedFields",
      "lastObservation"
    ]) ||
    link.provider !== request.provider ||
    link.providerObjectKey !== request.sourceObjectKey ||
    !isObjectTypeIdentifier(link.objectType) ||
    !isNonEmptyString(link.externalId) ||
    !isNonEmptyString(link.url) ||
    link.providerObjectKey !==
      `${link.provider}:${link.objectType}:${link.externalId}` ||
    !scopeRefsEqual(link.scopeRef, request.scopeRef)
  ) {
    return null;
  }

  return {
    providerObjectKey: link.providerObjectKey,
    provider: link.provider,
    objectType: link.objectType,
    externalId: link.externalId,
    url: link.url
  };
}

function validateGitHubUrl({
  value,
  scopeRef,
  objectType
}: {
  value: string;
  scopeRef: ProviderIngressRequest["scopeRef"];
  objectType: string;
}): boolean {
  const repository = readRepositoryScope(
    scopeRef,
    "github"
  );
  const url = parseSafeHttpsUrl(value);
  if (
    !repository ||
    url?.hostname.toLowerCase() !== "github.com"
  ) {
    return false;
  }

  const [owner, name] = repository.split("/");
  const parts = url.pathname.split("/");
  const repositoryMatches =
    parts[0] === "" &&
    parts[1]?.toLowerCase() === owner &&
    parts[2]?.toLowerCase() === name;

  if (
    objectType === "issue" ||
    objectType === "pull_request"
  ) {
    return (
      parts.length === 5 &&
      repositoryMatches &&
      parts[3] ===
        (objectType === "issue" ? "issues" : "pull") &&
      typeof parts[4] === "string" &&
      /^\d+$/.test(parts[4])
    );
  }

  return (
    objectType === "check" &&
    parts.length >= 5 &&
    repositoryMatches &&
    parts[3] === "actions" &&
    parts.slice(4).every((part) => part.length > 0)
  );
}

function parseSafeHttpsUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.search &&
    !url.hash
  )
    ? url
    : null;
}

function readRepositoryScope(
  scopeRef: ProviderIngressRequest["scopeRef"],
  provider: "github" | "gitee"
): string | null {
  if (
    scopeRef.kind !== "repository" ||
    scopeRef.parentKey !== undefined
  ) {
    return null;
  }

  const prefix = `${provider}:repository:`;
  if (!scopeRef.key.startsWith(prefix)) {
    return null;
  }

  const repository = scopeRef.key.slice(prefix.length);
  const parts = repository.split("/");
  return (
    parts.length === 2 &&
    parts.every((part) => part.length > 0)
  )
    ? repository
    : null;
}

function isLinearScope(
  scopeRef: ProviderIngressRequest["scopeRef"]
): boolean {
  return (
    scopeRef.kind === "team" &&
    isScopedUuid(scopeRef.key, "linear:team:") &&
    isScopedUuid(
      scopeRef.parentKey,
      "linear:organization:"
    )
  );
}

function isScopedUuid(
  value: unknown,
  prefix: string
): boolean {
  return (
    typeof value === "string" &&
    value.startsWith(prefix) &&
    isUuid(value.slice(prefix.length))
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value
  );
}

function readSourceIdentity(
  value: string,
  provider: string
): {
  objectType: string;
  externalId: string;
} | null {
  const prefix = `${provider}:`;
  if (!value.startsWith(prefix)) {
    return null;
  }

  const remainder = value.slice(prefix.length);
  const separator = remainder.indexOf(":");
  const objectType = remainder.slice(0, separator);
  const externalId = remainder.slice(separator + 1);
  return (
    separator > 0 &&
    isObjectTypeIdentifier(objectType) &&
    externalId.length > 0
  )
    ? { objectType, externalId }
    : null;
}

function scopeRefsEqual(
  value: unknown,
  expected: ProviderIngressRequest["scopeRef"]
): boolean {
  return (
    isPlainRecord(value) &&
    value.kind === expected.kind &&
    value.key === expected.key &&
    value.parentKey === expected.parentKey
  );
}

function readOwnDataProperty(
  value: object,
  key: string
): unknown {
  const descriptor =
    Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every(
      (key) =>
        typeof key === "string" &&
        keys.includes(key)
    )
  );
}

function hasAllowedExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[]
): boolean {
  const allowed = new Set([...required, ...optional]);
  const actual = Reflect.ownKeys(value);
  return (
    required.every((key) => actual.includes(key)) &&
    actual.every(
      (key) =>
        typeof key === "string" && allowed.has(key)
    )
  );
}

function isPlainRecord(
  value: unknown
): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (
    (prototype === Object.prototype ||
      prototype === null) &&
    Reflect.ownKeys(value).every((key) => {
      const descriptor =
        typeof key === "string"
          ? descriptors[key]
          : undefined;
      return (
        typeof key === "string" &&
        descriptor !== undefined &&
        descriptor.enumerable &&
        "value" in descriptor
      );
    })
  );
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

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    IDENTIFIER_PATTERN.test(value)
  );
}

function isObjectTypeIdentifier(
  value: unknown
): value is string {
  return (
    typeof value === "string" &&
    OBJECT_TYPE_PATTERN.test(value)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim()
  );
}

function invalidRegistry(): ProviderIngressRegistryError {
  return new ProviderIngressRegistryError(
    "PROVIDER_INGRESS_REGISTRY_INVALID",
    "Provider ingress registry does not match the supported contract."
  );
}

function forbidden(): ProviderIngressRegistryError {
  return new ProviderIngressRegistryError(
    "PROVIDER_INGRESS_FORBIDDEN",
    "Provider snapshot ingress is not enabled for this target."
  );
}
