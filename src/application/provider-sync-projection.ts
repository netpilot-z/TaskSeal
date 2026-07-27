import {
  digestCanonicalJson
} from "../lib/canonical-json.ts";
import {
  parseControlledWriteOperation
} from "./controlled-write-operation.ts";
import type {
  ControlledWriteDiagnosticCode,
  ControlledWriteOperation,
  ControlledWriteOperationStatus
} from "./controlled-write-operation.ts";
import {
  normalizeProviderObservationFile
} from "./provider-observation.ts";
import type {
  ProviderObservationProjection,
  ProviderObservationQueryPort
} from "./provider-observation.ts";
import type {
  ProviderOperationJournalQueryPort
} from "./provider-operation-journal.ts";

export type ProviderOperationProjectionStatus =
  | "approval_required"
  | "approved"
  | "rejected"
  | "submitting"
  | "created"
  | "outcome_unknown"
  | "reconciling"
  | "reconciliation_absent"
  | "reconciled"
  | "sync_failed";

export type ProviderOperationProjectionDiagnosticCode =
  | "LINEAR_WRITE_NOT_DISPATCHED"
  | "LINEAR_WRITE_OUTCOME_UNKNOWN"
  | "LINEAR_RECONCILIATION_FAILED"
  | "LINEAR_RECONCILIATION_AMBIGUOUS";

export interface ProviderOperationApprovalProjection {
  decision: "approved" | "rejected";
  decidedAt: string;
}

export interface ProviderOperationProjection {
  schemaVersion: 1;
  provider: "linear";
  operationKey: string;
  configuredTarget: {
    kind: "team";
    key: string;
  };
  version: number;
  status: ProviderOperationProjectionStatus;
  approval:
    | ProviderOperationApprovalProjection
    | null;
  diagnosticCode:
    | ProviderOperationProjectionDiagnosticCode
    | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderOperationProjectionSet {
  schemaVersion: 1;
  revision: string;
  operations: readonly ProviderOperationProjection[];
}

export interface ProviderSyncProjection {
  schemaVersion: 2;
  revision: string;
  observationRevision: string;
  operationRevision: string;
  providers: ProviderObservationProjection["providers"];
  operations: readonly ProviderOperationProjection[];
}

export interface ProviderSyncQueryPort {
  list(): Promise<ProviderSyncProjection>;
}

export class ProviderSyncProjectionQuery
  implements ProviderSyncQueryPort
{
  readonly #observations: ProviderObservationQueryPort;
  readonly #operations: ProviderOperationJournalQueryPort;

  constructor({
    observations,
    operations
  }: {
    observations: ProviderObservationQueryPort;
    operations: ProviderOperationJournalQueryPort;
  }) {
    try {
      validateObservationPort(observations);
      validateOperationPort(operations);
    } catch {
      throw projectionInvalid();
    }
    this.#observations = observations;
    this.#operations = operations;
  }

  async list(): Promise<ProviderSyncProjection> {
    let observationValue: unknown;
    let operationValue: unknown;

    try {
      [observationValue, operationValue] =
        await Promise.all([
          this.#observations.list(),
          this.#operations.listLatest()
        ]);
    } catch {
      throw projectionUnavailable();
    }

    try {
      const observations =
        normalizeObservationProjection(
          observationValue
        );
      const operations =
        projectProviderOperations(
          operationValue
        );
      const revision = digestCanonicalJson({
        domain:
          "taskseal.provider-sync-projection:v2",
        schemaVersion: 2,
        observationRevision:
          observations.revision,
        operationRevision:
          operations.revision
      });

      return deepFreeze({
        schemaVersion: 2,
        revision,
        observationRevision:
          observations.revision,
        operationRevision:
          operations.revision,
        providers: observations.providers,
        operations: operations.operations
      });
    } catch (error) {
      if (
        error instanceof
        ProviderSyncProjectionError
      ) {
        throw error;
      }
      throw projectionInvalid();
    }
  }
}

export function projectProviderOperations(
  value: unknown
): ProviderOperationProjectionSet {
  try {
    const values = readDenseArray(value, 512);

    const seen = new Set<string>();
    const operations = values.map((candidate) => {
      const operation =
        parseControlledWriteOperation(candidate);
      if (
        seen.has(operation.plan.operationKey)
      ) {
        throw projectionInvalid();
      }
      seen.add(operation.plan.operationKey);
      return projectOperation(operation);
    });
    operations.sort(compareOperations);

    return deepFreeze({
      schemaVersion: 1,
      revision: digestCanonicalJson(operations),
      operations
    });
  } catch (error) {
    if (
      error instanceof
      ProviderSyncProjectionError
    ) {
      throw error;
    }
    throw projectionInvalid();
  }
}

function normalizeObservationProjection(
  value: unknown
): ProviderObservationProjection {
  try {
    const projection = readExactRecord(value, [
      "schemaVersion",
      "revision",
      "providers"
    ]);
    if (
      projection.schemaVersion !== 1 ||
      typeof projection.revision !==
        "string"
    ) {
      throw projectionInvalid();
    }
    const file =
      normalizeProviderObservationFile({
        schemaVersion: 1,
        observations: projection.providers
      });
    const revision = digestCanonicalJson(
      file.observations
    );
    if (projection.revision !== revision) {
      throw projectionInvalid();
    }

    return {
      schemaVersion: 1,
      revision,
      providers: file.observations
    };
  } catch (error) {
    if (
      error instanceof
      ProviderSyncProjectionError
    ) {
      throw error;
    }
    throw projectionInvalid();
  }
}

function projectOperation(
  operation: ControlledWriteOperation
): ProviderOperationProjection {
  return {
    schemaVersion: 1,
    provider: "linear",
    operationKey:
      operation.plan.operationKey,
    configuredTarget: {
      kind: "team",
      key: operation.plan.configuredTarget.key
    },
    version: operation.version,
    status: projectOperationStatus(
      operation.status
    ),
    approval:
      operation.approval === null
        ? null
        : {
            decision:
              operation.approval.decision,
            decidedAt:
              operation.approval.decidedAt
          },
    diagnosticCode:
      projectOperationDiagnosticCode(
        operation.diagnosticCode
      ),
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt
  };
}

function projectOperationStatus(
  status: ControlledWriteOperationStatus
): ProviderOperationProjectionStatus {
  switch (status) {
    case "approval_required":
    case "approved":
    case "rejected":
    case "submitting":
    case "created":
    case "outcome_unknown":
    case "reconciling":
    case "reconciliation_absent":
    case "reconciled":
      return status;
    case "failed":
      return "sync_failed";
  }
  return unreachable(status);
}

function projectOperationDiagnosticCode(
  code: ControlledWriteDiagnosticCode | null
): ProviderOperationProjectionDiagnosticCode | null {
  if (code === null) {
    return null;
  }
  switch (code) {
    case "LINEAR_WRITE_NOT_DISPATCHED":
    case "LINEAR_WRITE_OUTCOME_UNKNOWN":
    case "LINEAR_RECONCILIATION_FAILED":
    case "LINEAR_RECONCILIATION_AMBIGUOUS":
      return code;
  }
  return unreachable(code);
}

function compareOperations(
  left: ProviderOperationProjection,
  right: ProviderOperationProjection
): number {
  return (
    compareStrings(left.provider, right.provider) ||
    compareStrings(
      left.configuredTarget.kind,
      right.configuredTarget.kind
    ) ||
    compareStrings(
      left.configuredTarget.key,
      right.configuredTarget.key
    ) ||
    compareStrings(
      left.operationKey,
      right.operationKey
    )
  );
}

function compareStrings(
  left: string,
  right: string
): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateObservationPort(
  value: unknown
): asserts value is ProviderObservationQueryPort {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof Reflect.get(value, "list") !==
      "function"
  ) {
    throw projectionInvalid();
  }
}

function validateOperationPort(
  value: unknown
): asserts value is ProviderOperationJournalQueryPort {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof Reflect.get(value, "listLatest") !==
      "function"
  ) {
    throw projectionInvalid();
  }
}

function readExactRecord<
  const T extends readonly string[]
>(
  value: unknown,
  expectedKeys: T
): Record<T[number], unknown> {
  const record = readDataRecord(value);
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();

  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) => key !== expected[index]
    )
  ) {
    throw projectionInvalid();
  }
  return record as Record<T[number], unknown>;
}

function readDataRecord(
  value: unknown
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !==
      Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw projectionInvalid();
  }

  const descriptors =
    Object.getOwnPropertyDescriptors(value);
  const result = Object.create(
    null
  ) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw projectionInvalid();
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw projectionInvalid();
    }
    result[key] = descriptor.value;
  }
  return result;
}

function readDenseArray(
  value: unknown,
  maximumLength: number
): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !==
      Array.prototype
  ) {
    throw projectionInvalid();
  }
  const lengthDescriptor =
    Object.getOwnPropertyDescriptor(
      value,
      "length"
    );
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.enumerable ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(
      lengthDescriptor.value
    ) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximumLength
  ) {
    throw projectionInvalid();
  }
  const length = lengthDescriptor.value;
  const descriptors =
    Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== length + 1 ||
    keys.at(-1) !== "length" ||
    keys
      .slice(0, -1)
      .some(
        (key, index) =>
          key !== String(index)
      )
  ) {
    throw projectionInvalid();
  }

  return Array.from(
    { length },
    (_, index) => {
      const descriptor = descriptors[index];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        throw projectionInvalid();
      }
      return descriptor.value;
    }
  );
}

function unreachable(value: never): never {
  void value;
  throw projectionInvalid();
}

function deepFreeze<T>(value: T): T {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function projectionInvalid(): ProviderSyncProjectionError {
  return new ProviderSyncProjectionError(
    "PROVIDER_SYNC_PROJECTION_INVALID",
    "Provider sync projection is invalid."
  );
}

function projectionUnavailable(): ProviderSyncProjectionError {
  return new ProviderSyncProjectionError(
    "PROVIDER_SYNC_PROJECTION_UNAVAILABLE",
    "Provider sync projection is unavailable."
  );
}

export class ProviderSyncProjectionError
  extends Error
{
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name =
      "ProviderSyncProjectionError";
    this.code = code;
  }
}
