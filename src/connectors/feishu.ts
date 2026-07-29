import type {
  ManagedField,
  RichExternalLink
} from "../domain/workflow.ts";
import {
  digestCanonicalJson
} from "../lib/canonical-json.ts";
import {
  createFeishuTableScope
} from "../lib/feishu-identity.ts";
import type {
  FeishuTableScope
} from "../lib/feishu-identity.ts";
import {
  digestProviderFactContent
} from "../lib/provider-snapshot.ts";
import type {
  ProviderRecordFact,
  ProviderSnapshotMapping,
  ProviderSnapshotV2
} from "../lib/provider-snapshot.ts";
import {
  FeishuReadClient
} from "./feishu-read-client.ts";
import type {
  FeishuFetchLike,
  FeishuFieldMapping,
  FeishuRecordReadResult,
  FeishuTableInspection
} from "./feishu-read-client.ts";
import {
  normalizeProviderAdapterV1
} from "./provider-adapter.ts";
import type {
  AdapterManifestV1,
  ProviderAdapterV1
} from "./provider-adapter.ts";

export const FEISHU_ADAPTER_MANIFEST = {
  schemaVersion: 1,
  apiVersion: "taskseal.provider/v1",
  providerId: "feishu",
  capabilities: [
    "provider.health",
    "work-item.read"
  ],
  configuration: {
    schemaVersion: 1,
    fields: [
      {
        key: "app-token",
        type: "string",
        required: true,
        secret: false
      },
      {
        key: "table-id",
        type: "string",
        required: true,
        secret: false
      },
      {
        key: "record-id",
        type: "string",
        required: true,
        secret: false
      },
      {
        key: "title-field",
        type: "string",
        required: true,
        secret: false
      },
      {
        key: "status-field",
        type: "string",
        required: true,
        secret: false
      },
      {
        key: "updated-at-field",
        type: "string",
        required: true,
        secret: false
      }
    ]
  },
  credential: {
    mode: "environment",
    references: [
      {
        key: "app-id",
        environmentVariable:
          "TASKSEAL_FEISHU_APP_ID",
        secret: true
      },
      {
        key: "app-secret",
        environmentVariable:
          "TASKSEAL_FEISHU_APP_SECRET",
        secret: true
      }
    ]
  },
  scopes: [
    {
      kind: "table",
      objectTypes: ["record"]
    }
  ]
} as const satisfies AdapterManifestV1;

export interface FeishuReadClientPort {
  inspectTable(
    input: unknown
  ): Promise<FeishuTableInspection>;
  readRecord(
    input: unknown
  ): Promise<FeishuRecordReadResult>;
}

export interface FeishuResourceRequest {
  readonly appToken: string;
  readonly tableId: string;
  readonly recordId: string;
  readonly fieldMapping: FeishuFieldMapping;
}

export interface FeishuHealthResult {
  readonly provider: "feishu";
  readonly status: "ready";
  readonly checkedAt: string;
  readonly scope: FeishuTableScope;
  readonly tableName: string;
  readonly recordCount: number;
}

export interface FeishuWorkItemMapping {
  readonly workItemId: string;
  readonly requiredEvidence: string[];
  readonly managedFields: ManagedField[];
}

export interface FeishuWorkItemReadRequest
  extends FeishuResourceRequest {
  readonly mapping: FeishuWorkItemMapping;
}

export interface FeishuProviderSnapshotV2
  extends Omit<
    ProviderSnapshotV2,
    "provider" | "facts" | "scope"
  > {
  readonly provider: "feishu";
  readonly scope: FeishuTableScope;
  readonly facts: ProviderRecordFact[];
}

export {
  createFeishuTableScope
} from "../lib/feishu-identity.ts";
export type {
  FeishuTableScope
} from "../lib/feishu-identity.ts";

interface CreateFeishuAdapterOptions {
  readonly client?: FeishuReadClientPort | undefined;
  readonly appId?: string | undefined;
  readonly appSecret?: string | undefined;
  readonly fetchImpl?: FeishuFetchLike | undefined;
  readonly timeoutMs?: number | undefined;
  readonly now?: (() => unknown) | undefined;
}

const MAX_MAPPING_ID_LENGTH = 200;
const MAX_MAPPING_ITEMS = 32;
const RESOURCE_IDENTIFIER_PATTERN =
  /^[A-Za-z0-9_-]{1,64}$/;

export function createFeishuAdapter({
  client,
  appId,
  appSecret,
  fetchImpl = globalThis.fetch,
  timeoutMs,
  now = () => new Date()
}: CreateFeishuAdapterOptions = {}): ProviderAdapterV1<
  FeishuResourceRequest,
  FeishuHealthResult,
  FeishuWorkItemReadRequest,
  FeishuProviderSnapshotV2
> {
  const resolvedClient =
    client ??
    new FeishuReadClient({
      appId,
      appSecret,
      fetchImpl,
      ...(timeoutMs === undefined
        ? {}
        : { timeoutMs })
    });
  const adapter: ProviderAdapterV1<
    FeishuResourceRequest,
    FeishuHealthResult,
    FeishuWorkItemReadRequest,
    FeishuProviderSnapshotV2
  > = {
    manifest: FEISHU_ADAPTER_MANIFEST,
    ports: {
      "provider.health": async (request) => {
        const resource =
          normalizeResourceRequest(request);
        const inspection =
          normalizeTableInspection(
            await resolvedClient.inspectTable({
              appToken: resource.appToken,
              tableId: resource.tableId,
              fieldMapping: resource.fieldMapping
            })
          );
        return {
          provider: "feishu",
          status: "ready",
          checkedAt: captureTimestamp(now),
          scope: createFeishuTableScope(resource),
          tableName: inspection.tableName,
          recordCount: inspection.recordCount
        };
      },
      "work-item.read": async (request) => {
        const {
          resource,
          mapping: normalizedMapping
        } = normalizeWorkItemReadRequest(request);
        const record = normalizeRecord(
          await resolvedClient.readRecord(resource),
          resource.recordId
        );
        const scope =
          createFeishuTableScope(resource);
        const fact = normalizeFeishuRecordFact({
          resource,
          record,
          scope,
          mapping: normalizedMapping
        });
        const snapshotMapping: ProviderSnapshotMapping = {
          workItemId: normalizedMapping.workItemId,
          requiredEvidence: [
            ...normalizedMapping.requiredEvidence
          ],
          managedFields: [
            ...normalizedMapping.managedFields
          ]
        };

        return {
          schemaVersion: 2,
          mode: "read-only",
          provider: "feishu",
          scope,
          mapping: snapshotMapping,
          capturedAt: captureTimestamp(now),
          facts: [fact]
        };
      }
    }
  };

  normalizeProviderAdapterV1(adapter);
  return adapter;
}

function normalizeFeishuRecordFact({
  resource,
  record,
  scope,
  mapping
}: {
  readonly resource: FeishuResourceRequest;
  readonly record: FeishuRecordReadResult;
  readonly scope: FeishuTableScope;
  readonly mapping: FeishuWorkItemMapping;
}): ProviderRecordFact {
  const identityDigest = digestCanonicalJson({
    schemaVersion: 1,
    provider: "feishu",
    objectType: "record",
    appToken: resource.appToken,
    tableId: resource.tableId,
    recordId: resource.recordId
  });
  const providerObjectKey =
    `feishu:record:${identityDigest}`;
  const sourceObject: ProviderRecordFact["sourceObject"] = {
    providerObjectKey,
    provider: "feishu",
    objectType: "record",
    externalId: identityDigest,
    url: "https://www.feishu.cn/base"
  };
  const observed = {
    title: record.title,
    status: record.status,
    updatedAt: record.updatedAt
  };
  const contentDigest = digestProviderFactContent({
    sourceObject,
    observed
  });
  const externalLink: RichExternalLink = {
    providerObjectKey,
    provider: "feishu",
    objectType: "record",
    externalId: identityDigest,
    scopeRef: scope,
    url: sourceObject.url,
    managedFields: [...mapping.managedFields],
    lastObservation: {
      revisionId: record.updatedAt,
      occurredAt: record.updatedAt,
      contentDigest,
      title: record.title
    }
  };

  return {
    sourceObject,
    revision: {
      id: record.updatedAt,
      occurredAt: record.updatedAt,
      contentDigest
    },
    observed,
    candidateEvent: {
      eventId:
        `feishu:record:${identityDigest.slice(
          "sha256:".length
        )}:observed`,
      workItemId: mapping.workItemId,
      type: "work_item.created",
      occurredAt: record.updatedAt,
      payload: {
        title: record.title,
        requiredEvidence: [
          ...mapping.requiredEvidence
        ],
        externalLink
      }
    }
  };
}

function normalizeResourceRequest(
  value: unknown
): FeishuResourceRequest {
  const resource = readDataRecord(value);
  if (
    resource === null ||
    !hasExactKeys(resource, [
      "appToken",
      "tableId",
      "recordId",
      "fieldMapping"
    ])
  ) {
    throw invalidResource();
  }
  const fieldMapping = readDataRecord(
    resource.fieldMapping
  );
  if (
    fieldMapping === null ||
    !hasExactKeys(fieldMapping, [
      "title",
      "status",
      "updatedAt"
    ])
  ) {
    throw invalidResource();
  }
  const mapping = {
    title: requireFieldName(fieldMapping.title),
    status: requireFieldName(fieldMapping.status),
    updatedAt: requireFieldName(fieldMapping.updatedAt)
  };
  if (new Set(Object.values(mapping)).size !== 3) {
    throw invalidResource();
  }

  return {
    appToken: requireResourceIdentifier(
      resource.appToken
    ),
    tableId: requireResourceIdentifier(
      resource.tableId
    ),
    recordId: requireResourceIdentifier(
      resource.recordId
    ),
    fieldMapping: mapping
  };
}

function normalizeWorkItemReadRequest(
  value: unknown
): {
  readonly resource: FeishuResourceRequest;
  readonly mapping: FeishuWorkItemMapping;
} {
  const request = readDataRecord(value);
  if (
    request === null ||
    !hasExactKeys(request, [
      "appToken",
      "tableId",
      "recordId",
      "fieldMapping",
      "mapping"
    ])
  ) {
    throw invalidResource();
  }
  return {
    resource: normalizeResourceRequest({
      appToken: request.appToken,
      tableId: request.tableId,
      recordId: request.recordId,
      fieldMapping: request.fieldMapping
    }),
    mapping: normalizeFeishuMapping(request.mapping)
  };
}

function normalizeTableInspection(
  value: unknown
): FeishuTableInspection {
  const inspection = readDataRecord(value);
  if (
    inspection === null ||
    !hasExactKeys(inspection, [
      "tableName",
      "pageCount",
      "recordCount",
      "total"
    ]) ||
    !isBoundedString(inspection.tableName, 100) ||
    !isPositiveInteger(inspection.pageCount) ||
    !isNonNegativeInteger(inspection.recordCount) ||
    inspection.total !== inspection.recordCount
  ) {
    throw invalidResource();
  }
  return {
    tableName: inspection.tableName,
    pageCount: inspection.pageCount,
    recordCount: inspection.recordCount,
    total: inspection.total as number
  };
}

function normalizeRecord(
  value: unknown,
  expectedRecordId: string
): FeishuRecordReadResult {
  const record = readDataRecord(value);
  if (
    record === null ||
    !hasExactKeys(record, [
      "recordId",
      "title",
      "status",
      "updatedAt"
    ]) ||
    record.recordId !== expectedRecordId ||
    !isBoundedString(record.title, 10_000) ||
    !isBoundedString(record.status, 1_000) ||
    !isTimestamp(record.updatedAt)
  ) {
    throw invalidResource();
  }
  return {
    recordId: record.recordId,
    title: record.title,
    status: record.status,
    updatedAt: record.updatedAt
  };
}

function normalizeFeishuMapping(
  value: unknown
): FeishuWorkItemMapping {
  const mapping = readDataRecord(value);
  if (
    mapping === null ||
    !hasExactKeys(mapping, [
      "workItemId",
      "requiredEvidence",
      "managedFields"
    ]) ||
    !isBoundedString(
      mapping.workItemId,
      MAX_MAPPING_ID_LENGTH
    )
  ) {
    throw invalidMapping();
  }
  const requiredEvidence = normalizeUniqueStrings(
    mapping.requiredEvidence,
    false,
    null
  );
  const managedFields = normalizeUniqueStrings(
    mapping.managedFields,
    true,
    new Set(["title"])
  );
  if (!managedFields.every(isManagedField)) {
    throw invalidMapping();
  }
  return {
    workItemId: mapping.workItemId as string,
    requiredEvidence,
    managedFields
  };
}

function normalizeUniqueStrings(
  value: unknown,
  allowEmpty: boolean,
  allowed: ReadonlySet<string> | null
): string[] {
  const items = readDenseArray(value);
  if (
    items === null ||
    (!allowEmpty && items.length === 0) ||
    items.length > MAX_MAPPING_ITEMS ||
    new Set(items).size !== items.length ||
    items.some(
      (item) =>
        !isBoundedString(
          item,
          MAX_MAPPING_ID_LENGTH
        ) ||
        (allowed !== null && !allowed.has(item))
    )
  ) {
    throw invalidMapping();
  }
  return [...items].sort() as string[];
}

function captureTimestamp(now: () => unknown): string {
  const value = now();
  const timestamp =
    value instanceof Date ? value.toISOString() : value;
  if (!isTimestamp(timestamp)) {
    throw new FeishuConnectorError(
      "FEISHU_CLOCK_INVALID",
      "Feishu adapter clock must return a valid timestamp."
    );
  }
  return timestamp;
}

function requireResourceIdentifier(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    !RESOURCE_IDENTIFIER_PATTERN.test(value)
  ) {
    throw invalidResource();
  }
  return value;
}

function requireFieldName(value: unknown): string {
  if (!isBoundedString(value, 100)) {
    throw invalidResource();
  }
  return value;
}

function isManagedField(
  value: string
): value is ManagedField {
  return value === "title";
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function isNonNegativeInteger(
  value: unknown
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    isBoundedString(value, 64) &&
    Number.isFinite(Date.parse(value))
  );
}

function isBoundedString(
  value: unknown,
  maximumLength: number
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    [...value].length <= maximumLength
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === expected.length &&
    actual.every(
      (key) =>
        typeof key === "string" &&
        expected.includes(key)
    )
  );
}

function readDataRecord(
  value: unknown
): Record<string, unknown> | null {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value);
    if (
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      return null;
    }
    const descriptors =
      Object.getOwnPropertyDescriptors(
        value
      ) as unknown as Record<
        PropertyKey,
        PropertyDescriptor
      >;
    const result = Object.create(
      null
    ) as Record<string, unknown>;

    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (
        typeof key !== "string" ||
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        return null;
      }
      const stringKey = key;
      result[stringKey] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function readDenseArray(
  value: unknown
): unknown[] | null {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      return null;
    }
    const descriptors =
      Object.getOwnPropertyDescriptors(
        value
      ) as unknown as Record<
        PropertyKey,
        PropertyDescriptor
      >;
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" &&
            !/^(?:0|[1-9][0-9]*)$/.test(key))
      )
    ) {
      return null;
    }
    const lengthDescriptor = descriptors["length"];
    const lengthValue = lengthDescriptor?.value;
    if (
      lengthDescriptor === undefined ||
      lengthDescriptor.enumerable ||
      !("value" in lengthDescriptor) ||
      typeof lengthValue !== "number" ||
      !Number.isInteger(lengthValue) ||
      lengthValue < 0 ||
      lengthValue > MAX_MAPPING_ITEMS
    ) {
      return null;
    }
    const length = lengthValue;
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        return null;
      }
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return null;
  }
}

function invalidResource(): FeishuConnectorError {
  return new FeishuConnectorError(
    "FEISHU_RESOURCE_INVALID",
    "Feishu resource does not match the bounded read contract."
  );
}

function invalidMapping(): FeishuConnectorError {
  return new FeishuConnectorError(
    "FEISHU_MAPPING_INVALID",
    "Feishu WorkItem mapping must be explicit and bounded."
  );
}

export class FeishuConnectorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FeishuConnectorError";
    this.code = code;
  }
}
