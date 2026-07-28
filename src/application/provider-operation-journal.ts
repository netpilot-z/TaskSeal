import {
  assertJsonWithinLimits,
  canonicalizeJson
} from "../lib/canonical-json.ts";
import {
  parseProviderOperation,
  validateProviderOperationTransition
} from "./provider-operation.ts";
import type {
  ProviderOperation
} from "./provider-operation.ts";

export const PROVIDER_OPERATION_JOURNAL_BYTE_LIMIT =
  16 * 1024 * 1024;
export const PROVIDER_OPERATION_JOURNAL_RECORD_LIMIT =
  512;

export interface ProviderOperationJournalFile {
  schemaVersion: 1;
  records: readonly ProviderOperation[];
}

export interface ProviderOperationJournalStoragePort {
  load(): Promise<unknown>;
  replace(
    value: ProviderOperationJournalFile
  ): Promise<void>;
}

export interface ProviderOperationAppendInput {
  expectedVersion: number;
  operationKey: string;
  planDigest: string;
  next: ProviderOperation;
}

export interface ProviderOperationAppendResult {
  resolution: "committed" | "idempotent";
  operation: ProviderOperation;
}

export interface ProviderOperationJournalCommandPort {
  compareAndAppend(
    input: ProviderOperationAppendInput
  ): Promise<ProviderOperationAppendResult>;
}

export interface ProviderOperationJournalQueryPort {
  get(
    operationKey: string
  ): Promise<ProviderOperation | null>;
  history(
    operationKey: string
  ): Promise<readonly ProviderOperation[]>;
  listLatest(): Promise<
    readonly ProviderOperation[]
  >;
}

const FILE_KEYS = ["schemaVersion", "records"] as const;
const APPEND_KEYS = [
  "expectedVersion",
  "operationKey",
  "planDigest",
  "next"
] as const;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class ProviderOperationJournal
  implements
    ProviderOperationJournalCommandPort,
    ProviderOperationJournalQueryPort
{
  static async open({
    storage
  }: {
    storage: ProviderOperationJournalStoragePort;
  }): Promise<ProviderOperationJournal> {
    const journal = new ProviderOperationJournal(storage);
    await journal.loadCurrent();
    return journal;
  }

  readonly #storage: ProviderOperationJournalStoragePort;
  #writeQueue: Promise<void> = Promise.resolve();
  #reopenRequired = false;

  private constructor(
    storage: ProviderOperationJournalStoragePort
  ) {
    this.#storage = storage;
  }

  async get(
    operationKeyValue: string
  ): Promise<ProviderOperation | null> {
    await this.#writeQueue;
    this.assertOpen();
    const operationKey =
      normalizeLookupOperationKey(operationKeyValue);
    const file = await this.loadCurrent();

    for (let index = file.records.length - 1; index >= 0; index -= 1) {
      const record = file.records[index];
      if (record?.plan.operationKey === operationKey) {
        return record;
      }
    }
    return null;
  }

  async history(
    operationKeyValue: string
  ): Promise<readonly ProviderOperation[]> {
    await this.#writeQueue;
    this.assertOpen();
    const operationKey =
      normalizeLookupOperationKey(operationKeyValue);
    const file = await this.loadCurrent();

    return Object.freeze(
      file.records.filter(
        (record) =>
          record.plan.operationKey === operationKey
      )
    );
  }

  async listLatest(): Promise<
    readonly ProviderOperation[]
  > {
    await this.#writeQueue;
    this.assertOpen();
    const file = await this.loadCurrent();
    const latest = new Map<
      string,
      ProviderOperation
    >();

    for (const record of file.records) {
      latest.set(record.plan.operationKey, record);
    }
    return Object.freeze([...latest.values()]);
  }

  compareAndAppend(
    input: ProviderOperationAppendInput
  ): Promise<ProviderOperationAppendResult> {
    return this.enqueueWrite(() =>
      this.compareAndAppendNow(input)
    );
  }

  private enqueueWrite<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    const result = this.#writeQueue.then(
      operation,
      operation
    );
    this.#writeQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async compareAndAppendNow(
    inputValue: unknown
  ): Promise<ProviderOperationAppendResult> {
    this.assertOpen();
    const input = normalizeAppendInput(inputValue);
    const current = await this.loadCurrent();
    const history = current.records.filter(
      (record) =>
        record.plan.operationKey === input.operationKey
    );
    const latest = history.at(-1);

    if (latest === undefined) {
      if (
        input.expectedVersion !== 0 ||
        input.next.version !== 1
      ) {
        throw versionConflict();
      }
    } else {
      if (
        latest.plan.planDigest !== input.planDigest ||
        latest.plan.planDigest !==
          input.next.plan.planDigest
      ) {
        throw planConflict();
      }

      if (
        latest.version === input.next.version &&
        input.expectedVersion + 1 === input.next.version &&
        operationsEqual(latest, input.next)
      ) {
        return freezeAppendResult({
          resolution: "idempotent",
          operation: latest
        });
      }

      if (
        latest.version !== input.expectedVersion ||
        input.next.version !== input.expectedVersion + 1
      ) {
        throw versionConflict();
      }

      try {
        validateProviderOperationTransition(
          latest,
          input.next
        );
      } catch {
        throw versionConflict();
      }
    }

    const nextFile =
      normalizeProviderOperationJournalFile({
        schemaVersion: 1,
        records: [...current.records, input.next]
      });

    try {
      await this.#storage.replace(nextFile);
    } catch (error) {
      if (
        hasErrorCode(
          error,
          "PROVIDER_OPERATION_JOURNAL_COMMIT_OUTCOME_UNKNOWN"
        )
      ) {
        this.#reopenRequired = true;
        if (
          error instanceof ProviderOperationJournalError
        ) {
          throw error;
        }
        throw new ProviderOperationJournalError(
          "PROVIDER_OPERATION_JOURNAL_COMMIT_OUTCOME_UNKNOWN",
          "Provider operation journal commit outcome is unknown."
        );
      }
      if (error instanceof ProviderOperationJournalError) {
        throw error;
      }
      throw new ProviderOperationJournalError(
        "PROVIDER_OPERATION_JOURNAL_WRITE_FAILED",
        "Provider operation journal could not be persisted."
      );
    }

    return freezeAppendResult({
      resolution: "committed",
      operation: input.next
    });
  }

  private async loadCurrent(): Promise<ProviderOperationJournalFile> {
    let value: unknown;
    try {
      value = await this.#storage.load();
    } catch (error) {
      if (error instanceof ProviderOperationJournalError) {
        throw error;
      }
      throw new ProviderOperationJournalError(
        "PROVIDER_OPERATION_JOURNAL_READ_FAILED",
        "Provider operation journal could not be read."
      );
    }

    try {
      return normalizeProviderOperationJournalFile(value);
    } catch (error) {
      throw new ProviderOperationJournalError(
        "PROVIDER_OPERATION_JOURNAL_STORE_CORRUPT",
        "Provider operation journal storage is corrupt."
      );
    }
  }

  private assertOpen(): void {
    if (this.#reopenRequired) {
      throw new ProviderOperationJournalError(
        "PROVIDER_OPERATION_JOURNAL_REOPEN_REQUIRED",
        "Provider operation journal must be reopened."
      );
    }
  }
}

export function normalizeProviderOperationJournalFile(
  value: unknown
): ProviderOperationJournalFile {
  try {
    assertJsonWithinLimits(value, {
      maxDepth: 16,
      maxBytes: PROVIDER_OPERATION_JOURNAL_BYTE_LIMIT,
      maxArrayLength:
        PROVIDER_OPERATION_JOURNAL_RECORD_LIMIT,
      maxObjectKeys: 16
    });
  } catch (error) {
    if (hasErrorCode(error, "CANONICAL_JSON_LIMIT_EXCEEDED")) {
      throw new ProviderOperationJournalError(
        "PROVIDER_OPERATION_JOURNAL_LIMIT_EXCEEDED",
        "Provider operation journal limit was exceeded."
      );
    }
    throw invalidJournal();
  }

  try {
    const file = readExactRecord(value, FILE_KEYS);
    if (file.schemaVersion !== 1) {
      throw invalidJournal();
    }
    const records = readDenseArray(file.records).map(
      (record) => parseProviderOperation(record)
    );
    records.sort(compareRecords);
    validateReplay(records);

    return deepFreeze({
      schemaVersion: 1,
      records
    });
  } catch (error) {
    if (error instanceof ProviderOperationJournalError) {
      throw error;
    }
    throw invalidJournal();
  }
}

function normalizeAppendInput(
  value: unknown
): ProviderOperationAppendInput {
  try {
    const input = readExactRecord(value, APPEND_KEYS);
    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      (input.expectedVersion as number) < 0
    ) {
      throw invalidJournal();
    }
    const next = parseProviderOperation(input.next);
    const operationKey = normalizeDigest(
      input.operationKey
    );
    const planDigest = normalizeDigest(input.planDigest);

    if (
      operationKey !== next.plan.operationKey ||
      planDigest !== next.plan.planDigest
    ) {
      throw invalidJournal();
    }

    return {
      expectedVersion: input.expectedVersion as number,
      operationKey,
      planDigest,
      next
    };
  } catch (error) {
    if (
      error instanceof ProviderOperationJournalError &&
      error.code === "PROVIDER_OPERATION_JOURNAL_INVALID"
    ) {
      throw error;
    }
    throw invalidJournal();
  }
}

function validateReplay(
  records: readonly ProviderOperation[]
): void {
  let previous: ProviderOperation | undefined;

  for (const record of records) {
    if (
      previous === undefined ||
      previous.plan.operationKey !==
        record.plan.operationKey
    ) {
      if (
        record.version !== 1 ||
        record.status !== "approval_required"
      ) {
        throw invalidJournal();
      }
    } else {
      if (record.version === previous.version) {
        throw invalidJournal();
      }
      validateProviderOperationTransition(
        previous,
        record
      );
    }
    previous = record;
  }
}

function compareRecords(
  left: ProviderOperation,
  right: ProviderOperation
): number {
  const keyOrder = compareStrings(
    left.plan.operationKey,
    right.plan.operationKey
  );
  return keyOrder !== 0
    ? keyOrder
    : left.version - right.version;
}

function operationsEqual(
  left: ProviderOperation,
  right: ProviderOperation
): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function normalizeLookupOperationKey(
  value: unknown
): string {
  try {
    return normalizeDigest(value);
  } catch (error) {
    throw invalidJournal();
  }
}

function normalizeDigest(value: unknown): string {
  if (
    typeof value !== "string" ||
    !DIGEST_PATTERN.test(value)
  ) {
    throw invalidJournal();
  }
  return value;
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
    throw invalidJournal();
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
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw invalidJournal();
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(
    null
  ) as Record<string, unknown>;

  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw invalidJournal();
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalidJournal();
    }
    result[key] = descriptor.value;
  }
  return result;
}

function readDenseArray(value: unknown): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw invalidJournal();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.at(-1) !== "length" ||
    keys
      .slice(0, -1)
      .some((key, index) => key !== String(index))
  ) {
    throw invalidJournal();
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[index];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalidJournal();
    }
    return descriptor.value;
  });
}

function freezeAppendResult(
  value: ProviderOperationAppendResult
): ProviderOperationAppendResult {
  return Object.freeze(value);
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

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function versionConflict(): ProviderOperationJournalError {
  return new ProviderOperationJournalError(
    "PROVIDER_OPERATION_JOURNAL_VERSION_CONFLICT",
    "Provider operation journal version does not match."
  );
}

function planConflict(): ProviderOperationJournalError {
  return new ProviderOperationJournalError(
    "PROVIDER_OPERATION_JOURNAL_PLAN_CONFLICT",
    "Provider operation journal plan does not match."
  );
}

function invalidJournal(): ProviderOperationJournalError {
  return new ProviderOperationJournalError(
    "PROVIDER_OPERATION_JOURNAL_INVALID",
    "Provider operation journal input is invalid."
  );
}

function hasErrorCode(
  error: unknown,
  code: string
): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

export class ProviderOperationJournalError extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string
  ) {
    super(message);
    this.name = "ProviderOperationJournalError";
    this.code = code;
  }
}
