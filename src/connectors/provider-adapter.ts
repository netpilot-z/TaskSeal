export type ProviderReadCapability =
  | "provider.health"
  | "work-item.read";

export interface AdapterConfigurationFieldV1 {
  readonly key: string;
  readonly type: "repository-coordinate" | "string";
  readonly required: boolean;
  readonly secret: boolean;
}

export interface AdapterScopeV1 {
  readonly kind: string;
  readonly objectTypes: readonly string[];
}

export interface AdapterManifestV1 {
  readonly schemaVersion: 1;
  readonly apiVersion: "taskseal.provider/v1";
  readonly providerId: string;
  readonly capabilities: readonly [
    "provider.health",
    "work-item.read"
  ];
  readonly configuration: {
    readonly schemaVersion: 1;
    readonly fields: readonly AdapterConfigurationFieldV1[];
  };
  readonly credential: {
    readonly mode: "none";
  };
  readonly scopes: readonly AdapterScopeV1[];
}

export type ProviderHealthPort<
  Request = unknown,
  Result = unknown
> = (request: Request) => Promise<Result>;

export type WorkItemReadPort<
  Request = unknown,
  Result = unknown
> = (request: Request) => Promise<Result>;

export interface ProviderAdapterV1<
  HealthRequest = unknown,
  HealthResult = unknown,
  WorkItemRequest = unknown,
  WorkItemResult = unknown
> {
  readonly manifest: AdapterManifestV1;
  readonly ports: {
    readonly "provider.health": ProviderHealthPort<
      HealthRequest,
      HealthResult
    >;
    readonly "work-item.read": WorkItemReadPort<
      WorkItemRequest,
      WorkItemResult
    >;
  };
}

const CAPABILITIES: readonly ProviderReadCapability[] = [
  "provider.health",
  "work-item.read"
];
const MAX_CONFIGURATION_FIELDS = 32;
const MAX_SCOPES = 16;
const MAX_OBJECT_TYPES = 32;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;

export function normalizeProviderAdapterV1(
  value: unknown
): ProviderAdapterV1 {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["manifest", "ports"]) ||
    !isPlainRecord(value.manifest) ||
    !isPlainRecord(value.ports)
  ) {
    throw invalidAdapter();
  }

  const manifest = normalizeManifest(value.manifest);
  const portKeys = Reflect.ownKeys(value.ports);

  if (
    portKeys.length !== CAPABILITIES.length ||
    !portKeys.every(
      (key) =>
        typeof key === "string" &&
        manifest.capabilities.includes(
          key as ProviderReadCapability
        )
    ) ||
    typeof value.ports["provider.health"] !== "function" ||
    typeof value.ports["work-item.read"] !== "function"
  ) {
    throw invalidAdapter();
  }

  return {
    manifest,
    ports: {
      "provider.health":
        value.ports["provider.health"] as ProviderHealthPort,
      "work-item.read":
        value.ports["work-item.read"] as WorkItemReadPort
    }
  };
}

function normalizeManifest(
  value: Record<string, unknown>
): AdapterManifestV1 {
  const capabilities = value.capabilities;
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "apiVersion",
      "providerId",
      "capabilities",
      "configuration",
      "credential",
      "scopes"
    ]) ||
    value.schemaVersion !== 1 ||
    value.apiVersion !== "taskseal.provider/v1" ||
    !isAdapterIdentifier(value.providerId) ||
    !isDenseArray(capabilities) ||
    capabilities.length !== CAPABILITIES.length ||
    !CAPABILITIES.every((capability) =>
      capabilities.includes(capability)
    ) ||
    new Set(capabilities).size !== capabilities.length ||
    !isPlainRecord(value.configuration) ||
    !isPlainRecord(value.credential) ||
    !isDenseArray(value.scopes)
  ) {
    throw invalidAdapter();
  }

  const configuration = normalizeConfiguration(
    value.configuration
  );
  const credential = normalizeCredential(value.credential);
  const scopes = normalizeScopes(value.scopes);

  return {
    schemaVersion: 1,
    apiVersion: "taskseal.provider/v1",
    providerId: value.providerId,
    capabilities: [
      "provider.health",
      "work-item.read"
    ],
    configuration,
    credential,
    scopes
  };
}

function normalizeConfiguration(
  value: Record<string, unknown>
): AdapterManifestV1["configuration"] {
  if (
    !hasExactKeys(value, ["schemaVersion", "fields"]) ||
    value.schemaVersion !== 1 ||
    !isDenseArray(value.fields) ||
    value.fields.length === 0 ||
    value.fields.length > MAX_CONFIGURATION_FIELDS
  ) {
    throw invalidAdapter();
  }

  const fields = value.fields.map(normalizeConfigurationField);
  const keys = fields.map((field) => field.key);

  if (new Set(keys).size !== keys.length) {
    throw invalidAdapter();
  }

  return {
    schemaVersion: 1,
    fields
  };
}

function normalizeConfigurationField(
  value: unknown
): AdapterConfigurationFieldV1 {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "key",
      "type",
      "required",
      "secret"
    ]) ||
    !isAdapterIdentifier(value.key) ||
    (
      value.type !== "repository-coordinate" &&
      value.type !== "string"
    ) ||
    typeof value.required !== "boolean" ||
    typeof value.secret !== "boolean"
  ) {
    throw invalidAdapter();
  }

  return {
    key: value.key,
    type: value.type,
    required: value.required,
    secret: value.secret
  };
}

function normalizeCredential(
  value: Record<string, unknown>
): AdapterManifestV1["credential"] {
  if (
    !hasExactKeys(value, ["mode"]) ||
    value.mode !== "none"
  ) {
    throw invalidAdapter();
  }

  return { mode: "none" };
}

function normalizeScopes(
  value: unknown[]
): AdapterScopeV1[] {
  if (value.length === 0 || value.length > MAX_SCOPES) {
    throw invalidAdapter();
  }

  const scopes = value.map(normalizeScope);
  const identities = scopes.map(
    (scope) =>
      `${scope.kind}:${[...scope.objectTypes].sort().join(",")}`
  );

  if (new Set(identities).size !== identities.length) {
    throw invalidAdapter();
  }

  return scopes;
}

function normalizeScope(value: unknown): AdapterScopeV1 {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["kind", "objectTypes"]) ||
    !isAdapterIdentifier(value.kind) ||
    !isDenseArray(value.objectTypes) ||
    value.objectTypes.length === 0 ||
    value.objectTypes.length > MAX_OBJECT_TYPES ||
    !value.objectTypes.every(isAdapterIdentifier) ||
    new Set(value.objectTypes).size !== value.objectTypes.length
  ) {
    throw invalidAdapter();
  }

  return {
    kind: value.kind,
    objectTypes: [...value.objectTypes]
  };
}

function isAdapterIdentifier(
  value: unknown
): value is string {
  return (
    typeof value === "string" &&
    IDENTIFIER_PATTERN.test(value)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const actualKeys = Reflect.ownKeys(value);
  return (
    actualKeys.length === keys.length &&
    actualKeys.every(
      (key) =>
        typeof key === "string" &&
        keys.includes(key)
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

  if (
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    return false;
  }

  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") {
      return false;
    }
    const descriptor = descriptors[key];
    return (
      descriptor !== undefined &&
      descriptor.enumerable &&
      "value" in descriptor
    );
  });
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

export class ProviderAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProviderAdapterError";
    this.code = code;
  }
}

function invalidAdapter(): ProviderAdapterError {
  return new ProviderAdapterError(
    "PROVIDER_ADAPTER_INVALID",
    "Provider adapter does not match the supported read-only v1 contract."
  );
}
