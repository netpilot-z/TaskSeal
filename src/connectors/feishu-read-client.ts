const FEISHU_API_ORIGIN = "https://open.feishu.cn";
const TENANT_TOKEN_PATH =
  "/open-apis/auth/v3/tenant_access_token/internal";
export const FEISHU_RESPONSE_BYTE_LIMIT = 256 * 1024;

const DEFAULT_TIMEOUT_MS = 15_000;
const MAXIMUM_TIMEOUT_MS = 15_000;
const TOKEN_REFRESH_WINDOW_MS = 30 * 60 * 1_000;
const MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;
const MAX_TABLE_PAGES = 2;
const MAX_FIELD_PAGES = 2;
const MAX_RECORD_PAGES = 8;
const MAX_RECORDS = 16;
const MAX_TABLES = 100;
const MAX_FIELDS = 150;
const MAX_CREDENTIAL_LENGTH = 1_024;
const MAX_TOKEN_LENGTH = 4_096;
const MAX_FIELD_NAME_LENGTH = 100;
const MAX_TABLE_NAME_LENGTH = 100;
const MAX_RECORD_VALUE_LENGTH = 10_000;
const RESOURCE_IDENTIFIER_PATTERN =
  /^[A-Za-z0-9_-]{1,64}$/;

export interface FeishuFetchRequestOptions {
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly redirect: "error";
  readonly signal: AbortSignal;
}

export type FeishuFetchLike = (
  url: string,
  options: FeishuFetchRequestOptions
) => Promise<unknown>;

export interface FeishuFieldMapping {
  readonly title: string;
  readonly status: string;
  readonly updatedAt: string;
}

export interface FeishuTableInspection {
  readonly tableName: string;
  readonly pageCount: number;
  readonly recordCount: number;
  readonly total: number;
}

export interface FeishuRecordReadResult {
  readonly recordId: string;
  readonly title: string;
  readonly status: string;
  readonly updatedAt: string;
}

interface NormalizedOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly fetchImpl: FeishuFetchLike;
  readonly timeoutMs: number;
  readonly now: () => number;
}

interface NormalizedScope {
  readonly appToken: string;
  readonly tableId: string;
  readonly fieldMapping: FeishuFieldMapping;
}

interface TokenCache {
  readonly value: string;
  readonly refreshAt: number;
}

interface NormalizedResponse {
  readonly receiver: Record<string, unknown>;
  readonly ok: boolean;
  readonly status: number;
  readonly headers: unknown;
  readonly body: unknown;
  readonly text: unknown;
}

interface StreamReader {
  read(): Promise<unknown>;
  cancel?(reason?: unknown): Promise<unknown>;
}

interface PageData {
  readonly items: readonly unknown[];
  readonly hasMore: boolean;
  readonly pageToken: string | null;
  readonly total: number | null;
}

type SettledBeforeAbort<T> =
  | {
      readonly kind: "resolved";
      readonly value: T;
    }
  | {
      readonly kind: "rejected";
      readonly error: unknown;
    }
  | {
      readonly kind: "aborted";
    };

export class FeishuReadClient {
  readonly #appId: string;
  readonly #appSecret: string;
  readonly #fetchImpl: FeishuFetchLike;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  #token: TokenCache | null = null;
  #tokenRequest: Promise<string> | null = null;

  constructor(optionsValue: unknown) {
    const options = normalizeOptions(optionsValue);
    this.#appId = options.appId;
    this.#appSecret = options.appSecret;
    this.#fetchImpl = options.fetchImpl;
    this.#timeoutMs = options.timeoutMs;
    this.#now = options.now;
  }

  async inspectTable(
    inputValue: unknown
  ): Promise<FeishuTableInspection> {
    const scope = normalizeScope(inputValue);
    const tableName = await this.#readTable(scope);
    await this.#validateFieldMapping(scope);
    const pagination = await this.#readRecordPages(scope);

    return Object.freeze({
      tableName,
      pageCount: pagination.pageCount,
      recordCount: pagination.recordCount,
      total: pagination.total
    });
  }

  async readRecord(
    inputValue: unknown
  ): Promise<FeishuRecordReadResult> {
    const input = readDataRecord(inputValue);
    requireExactKeys(input, [
      "appToken",
      "tableId",
      "fieldMapping",
      "recordId"
    ]);
    const scope = normalizeScope({
      appToken: input.appToken,
      tableId: input.tableId,
      fieldMapping: input.fieldMapping
    });
    const recordId = normalizeResourceIdentifier(
      input.recordId
    );

    await this.#validateFieldMapping(scope);
    const data = await this.#readData({
      path:
        tablePath(scope) +
        `/records/${encodeURIComponent(recordId)}`,
      method: "GET"
    });
    const record = readResponseRecord(data.record);

    if (record.record_id !== recordId) {
      throw feishuError(
        "FEISHU_SCOPE_MISMATCH",
        "Feishu returned a record outside the configured scope."
      );
    }

    const fields = readResponseRecord(record.fields);
    const title = normalizeMappedString(
      fields[scope.fieldMapping.title]
    );
    const status = normalizeMappedString(
      fields[scope.fieldMapping.status]
    );
    const updatedAt = normalizeUpdatedAt(
      fields[scope.fieldMapping.updatedAt]
    );

    return Object.freeze({
      recordId,
      title,
      status,
      updatedAt
    });
  }

  async #readTable(
    scope: NormalizedScope
  ): Promise<string> {
    const items = await this.#readPagedItems({
      path:
        `/open-apis/bitable/v1/apps/` +
        `${encodeURIComponent(scope.appToken)}/tables`,
      pageSize: 100,
      maximumPages: MAX_TABLE_PAGES,
      maximumItems: MAX_TABLES,
      requireTotal: false
    });
    const matches = items.items.filter((item) => {
      const table = readResponseRecord(item);
      return table.table_id === scope.tableId;
    });

    if (matches.length !== 1) {
      throw feishuError(
        "FEISHU_SCOPE_MISMATCH",
        "Feishu did not return exactly one configured table."
      );
    }

    const table = readResponseRecord(matches[0]);
    requirePositiveInteger(table.revision);
    return requireBoundedString(
      table.name,
      MAX_TABLE_NAME_LENGTH
    );
  }

  async #validateFieldMapping(
    scope: NormalizedScope
  ): Promise<void> {
    const items = await this.#readPagedItems({
      path: tablePath(scope) + "/fields",
      pageSize: 100,
      maximumPages: MAX_FIELD_PAGES,
      maximumItems: MAX_FIELDS,
      requireTotal: false
    });
    const expectations = new Map<string, number>([
      [scope.fieldMapping.title, 1],
      [scope.fieldMapping.status, 3],
      [scope.fieldMapping.updatedAt, 5]
    ]);

    for (const [fieldName, fieldType] of expectations) {
      const matches = items.items.filter((item) => {
        const field = readResponseRecord(item);
        return field.field_name === fieldName;
      });

      if (matches.length !== 1) {
        throw invalidFieldMapping();
      }

      const field = readResponseRecord(matches[0]);
      requireResourceIdentifier(field.field_id);
      if (field.type !== fieldType) {
        throw invalidFieldMapping();
      }
    }
  }

  async #readRecordPages(
    scope: NormalizedScope
  ): Promise<{
    readonly pageCount: number;
    readonly recordCount: number;
    readonly total: number;
  }> {
    let pageToken: string | null = null;
    const seenPageTokens = new Set<string>();
    const seenRecords = new Set<string>();
    let pageCount = 0;
    let expectedTotal: number | null = null;

    for (;;) {
      if (pageCount >= MAX_RECORD_PAGES) {
        throw invalidPagination();
      }

      const data = await this.#readData({
        path: appendPagination(
          tablePath(scope) + "/records/search",
          2,
          pageToken
        ),
        method: "POST",
        body: "{}"
      });
      const page = normalizePage(data, true);
      pageCount += 1;

      if (
        page.items.length > 2 ||
        page.total === null ||
        page.total > MAX_RECORDS ||
        (expectedTotal !== null &&
          expectedTotal !== page.total)
      ) {
        throw invalidPagination();
      }
      expectedTotal = page.total;

      for (const item of page.items) {
        const record = readResponseRecord(item);
        const recordId = requireResourceIdentifier(
          record.record_id
        );
        readResponseRecord(record.fields);

        if (
          seenRecords.size >= MAX_RECORDS ||
          seenRecords.has(recordId)
        ) {
          throw invalidPagination();
        }
        seenRecords.add(recordId);
      }

      if (!page.hasMore) {
        break;
      }
      if (
        page.pageToken === null ||
        seenPageTokens.has(page.pageToken)
      ) {
        throw invalidPagination();
      }
      seenPageTokens.add(page.pageToken);
      pageToken = page.pageToken;
    }

    if (
      expectedTotal === null ||
      seenRecords.size !== expectedTotal
    ) {
      throw invalidPagination();
    }

    return {
      pageCount,
      recordCount: seenRecords.size,
      total: expectedTotal
    };
  }

  async #readPagedItems({
    path,
    pageSize,
    maximumPages,
    maximumItems,
    requireTotal
  }: {
    readonly path: string;
    readonly pageSize: number;
    readonly maximumPages: number;
    readonly maximumItems: number;
    readonly requireTotal: boolean;
  }): Promise<{
    readonly items: readonly unknown[];
    readonly total: number | null;
  }> {
    const items: unknown[] = [];
    const seenPageTokens = new Set<string>();
    let pageToken: string | null = null;
    let expectedTotal: number | null = null;

    for (let page = 0; page < maximumPages; page += 1) {
      const data = await this.#readData({
        path: appendPagination(
          path,
          pageSize,
          pageToken
        ),
        method: "GET"
      });
      const normalized = normalizePage(
        data,
        requireTotal
      );

      if (
        normalized.items.length > pageSize ||
        items.length + normalized.items.length >
          maximumItems ||
        (expectedTotal !== null &&
          normalized.total !== null &&
          normalized.total !== expectedTotal)
      ) {
        throw invalidPagination();
      }

      if (normalized.total !== null) {
        expectedTotal = normalized.total;
      }
      items.push(...normalized.items);

      if (!normalized.hasMore) {
        return {
          items,
          total: expectedTotal
        };
      }
      if (
        normalized.pageToken === null ||
        seenPageTokens.has(normalized.pageToken)
      ) {
        throw invalidPagination();
      }
      seenPageTokens.add(normalized.pageToken);
      pageToken = normalized.pageToken;
    }

    throw invalidPagination();
  }

  async #readData({
    path,
    method,
    body
  }: {
    readonly path: string;
    readonly method: "GET" | "POST";
    readonly body?: string;
  }): Promise<Record<string, unknown>> {
    const token = await this.#getTenantToken();
    let response: Record<string, unknown>;

    try {
      response = await this.#requestJson({
        path,
        method,
        ...(body === undefined ? {} : { body }),
        authorization: `Bearer ${token}`
      });
    } catch (error) {
      if (
        error instanceof FeishuReadError &&
        error.code === "FEISHU_UNAUTHORIZED"
      ) {
        this.#token = null;
      }
      throw error;
    }

    const code = response.code;
    if (
      typeof code !== "number" ||
      !Number.isSafeInteger(code)
    ) {
      throw invalidResponse();
    }
    if (code !== 0) {
      throw feishuError(
        "FEISHU_API_ERROR",
        "Feishu rejected the bounded read request."
      );
    }
    return readResponseRecord(response.data);
  }

  async #getTenantToken(): Promise<string> {
    const now = readClock(this.#now);
    if (
      this.#token !== null &&
      now < this.#token.refreshAt
    ) {
      return this.#token.value;
    }
    if (this.#tokenRequest !== null) {
      return this.#tokenRequest;
    }

    const request = this.#requestTenantToken(now);
    this.#tokenRequest = request;

    try {
      return await request;
    } finally {
      if (this.#tokenRequest === request) {
        this.#tokenRequest = null;
      }
    }
  }

  async #requestTenantToken(
    requestedAt: number
  ): Promise<string> {
    const response = await this.#requestJson({
      path: TENANT_TOKEN_PATH,
      method: "POST",
      body: JSON.stringify({
        app_id: this.#appId,
        app_secret: this.#appSecret
      })
    });
    const code = response.code;

    if (
      typeof code !== "number" ||
      !Number.isSafeInteger(code)
    ) {
      throw invalidResponse();
    }
    if (code !== 0) {
      throw feishuError(
        "FEISHU_AUTH_FAILED",
        "Feishu rejected the configured application credentials."
      );
    }

    const token = requireResponseCredential(
      response.tenant_access_token,
      MAX_TOKEN_LENGTH
    );
    const expire = response.expire;

    if (
      typeof expire !== "number" ||
      !Number.isSafeInteger(expire) ||
      expire <= 0 ||
      expire > MAX_TOKEN_LIFETIME_SECONDS
    ) {
      throw invalidResponse();
    }

    const expiresAt = requestedAt + expire * 1_000;
    if (!Number.isSafeInteger(expiresAt)) {
      throw invalidResponse();
    }

    this.#token = Object.freeze({
      value: token,
      refreshAt:
        expiresAt - TOKEN_REFRESH_WINDOW_MS
    });
    return token;
  }

  async #requestJson({
    path,
    method,
    body,
    authorization
  }: {
    readonly path: string;
    readonly method: "GET" | "POST";
    readonly body?: string;
    readonly authorization?: string;
  }): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "TaskSeal"
    };
    if (body !== undefined) {
      headers["Content-Type"] =
        "application/json; charset=utf-8";
    }
    if (authorization !== undefined) {
      headers.Authorization = authorization;
    }

    const signal = AbortSignal.timeout(this.#timeoutMs);
    let dispatched: SettledBeforeAbort<unknown>;
    try {
      dispatched = await settleBeforeAbort(
        Promise.resolve(
          this.#fetchImpl(
            new URL(path, FEISHU_API_ORIGIN).href,
            {
              method,
              headers,
              ...(body === undefined ? {} : { body }),
              redirect: "error",
              signal
            }
          )
        ),
        signal
      );
    } catch {
      throw feishuError(
        "FEISHU_REQUEST_FAILED",
        "Feishu request failed before a valid response was received."
      );
    }
    if (dispatched.kind !== "resolved") {
      throw feishuError(
        "FEISHU_REQUEST_FAILED",
        "Feishu request failed before a valid response was received."
      );
    }

    const response = normalizeResponse(dispatched.value);
    if (!response.ok) {
      cancelResponseBody(response.body);
      throw httpError(response.status);
    }

    const read = await settleBeforeAbort(
      readBoundedBody(response, signal),
      signal
    );
    if (read.kind === "aborted") {
      throw feishuError(
        "FEISHU_REQUEST_FAILED",
        "Feishu request failed before a valid response was received."
      );
    }
    if (read.kind === "rejected") {
      throw read.error;
    }
    const text = read.value;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalidResponse();
    }

    if (!isPlainRecord(parsed)) {
      throw invalidResponse();
    }
    return parsed;
  }
}

function normalizeOptions(
  value: unknown
): NormalizedOptions {
  const options = readDataRecord(value);
  requireAllowedKeys(options, [
    "appId",
    "appSecret",
    "fetchImpl",
    "timeoutMs",
    "now"
  ]);
  const appId = requireCredential(
    options.appId,
    MAX_CREDENTIAL_LENGTH
  );
  const appSecret = requireCredential(
    options.appSecret,
    MAX_CREDENTIAL_LENGTH
  );
  const fetchValue =
    options.fetchImpl ?? globalThis.fetch;
  const timeoutValue =
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const nowValue = options.now ?? Date.now;

  if (typeof fetchValue !== "function") {
    throw inputError();
  }
  if (
    typeof timeoutValue !== "number" ||
    !Number.isInteger(timeoutValue) ||
    timeoutValue <= 0 ||
    timeoutValue > MAXIMUM_TIMEOUT_MS
  ) {
    throw inputError();
  }
  if (typeof nowValue !== "function") {
    throw inputError();
  }

  return {
    appId,
    appSecret,
    fetchImpl: fetchValue as FeishuFetchLike,
    timeoutMs: timeoutValue,
    now: nowValue as () => number
  };
}

function normalizeScope(
  value: unknown
): NormalizedScope {
  const input = readDataRecord(value);
  requireExactKeys(input, [
    "appToken",
    "tableId",
    "fieldMapping"
  ]);
  const mapping = readDataRecord(input.fieldMapping);
  requireExactKeys(mapping, [
    "title",
    "status",
    "updatedAt"
  ]);
  const fieldMapping = {
    title: requireFieldName(mapping.title),
    status: requireFieldName(mapping.status),
    updatedAt: requireFieldName(mapping.updatedAt)
  };

  if (
    new Set(Object.values(fieldMapping)).size !== 3
  ) {
    throw inputError();
  }

  return {
    appToken: normalizeResourceIdentifier(
      input.appToken
    ),
    tableId: normalizeResourceIdentifier(
      input.tableId
    ),
    fieldMapping: Object.freeze(fieldMapping)
  };
}

function normalizePage(
  data: Record<string, unknown>,
  requireTotal: boolean
): PageData {
  if (
    !Array.isArray(data.items) ||
    data.items.length > MAX_FIELDS ||
    typeof data.has_more !== "boolean"
  ) {
    throw invalidResponse();
  }

  const total =
    data.total === undefined
      ? null
      : normalizeNonNegativeInteger(data.total);
  if (requireTotal && total === null) {
    throw invalidResponse();
  }

  let pageToken: string | null = null;
  if (data.page_token !== undefined && data.page_token !== null) {
    pageToken = normalizePageToken(
      data.page_token
    );
  }
  if (data.has_more && pageToken === null) {
    throw invalidPagination();
  }

  return {
    items: data.items,
    hasMore: data.has_more,
    pageToken,
    total
  };
}

function appendPagination(
  path: string,
  pageSize: number,
  pageToken: string | null
): string {
  const search = new URLSearchParams({
    page_size: String(pageSize)
  });
  if (pageToken !== null) {
    search.set("page_token", pageToken);
  }
  return `${path}?${search.toString()}`;
}

function tablePath(
  scope: NormalizedScope
): string {
  return (
    `/open-apis/bitable/v1/apps/` +
    `${encodeURIComponent(scope.appToken)}/tables/` +
    encodeURIComponent(scope.tableId)
  );
}

function normalizeResponse(
  value: unknown
): NormalizedResponse {
  if (!isRecord(value)) {
    throw invalidResponse();
  }

  let ok: unknown;
  let status: unknown;
  let headers: unknown;
  let body: unknown;
  let text: unknown;
  try {
    ok = Reflect.get(value, "ok");
    status = Reflect.get(value, "status");
    headers = Reflect.get(value, "headers");
    body = Reflect.get(value, "body");
    text = Reflect.get(value, "text");
  } catch {
    throw invalidResponse();
  }

  if (
    typeof ok !== "boolean" ||
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599
  ) {
    throw invalidResponse();
  }

  return {
    receiver: value,
    ok,
    status,
    headers,
    body,
    text
  };
}

async function readBoundedBody(
  response: NormalizedResponse,
  signal: AbortSignal
): Promise<string> {
  validateContentLength(response.headers);

  if (
    isRecord(response.body) &&
    typeof response.body.getReader === "function"
  ) {
    return readStreamBody(response.body, signal);
  }
  if (typeof response.text !== "function") {
    throw invalidResponse();
  }

  let text: unknown;
  try {
    text = await Reflect.apply(
      response.text,
      response.receiver,
      []
    );
  } catch {
    throw invalidResponse();
  }

  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") >
      FEISHU_RESPONSE_BYTE_LIMIT
  ) {
    throw responseTooLarge();
  }
  return text;
}

function validateContentLength(headers: unknown): void {
  if (headers === undefined || headers === null) {
    return;
  }
  if (
    !isRecord(headers) ||
    typeof headers.get !== "function"
  ) {
    throw invalidResponse();
  }

  let value: unknown;
  try {
    value = Reflect.apply(
      headers.get,
      headers,
      ["content-length"]
    );
  } catch {
    throw invalidResponse();
  }
  if (value === null) {
    return;
  }
  if (
    typeof value !== "string" ||
    !/^\d+$/.test(value)
  ) {
    throw invalidResponse();
  }

  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw invalidResponse();
  }
  if (length > FEISHU_RESPONSE_BYTE_LIMIT) {
    throw responseTooLarge();
  }
}

async function readStreamBody(
  stream: Record<string, unknown>,
  signal: AbortSignal
): Promise<string> {
  let readerValue: unknown;
  try {
    readerValue = Reflect.apply(
      stream.getReader as (...args: never[]) => unknown,
      stream,
      []
    );
  } catch {
    throw invalidResponse();
  }
  if (
    !isRecord(readerValue) ||
    typeof readerValue.read !== "function"
  ) {
    throw invalidResponse();
  }

  const reader = readerValue as unknown as StreamReader;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = (): void => {
    if (typeof reader.cancel === "function") {
      try {
        ignoreCleanup(reader.cancel());
      } catch {
        // Abort cleanup cannot replace the bounded request result.
      }
    }
  };
  signal.addEventListener("abort", cancel, {
    once: true
  });

  try {
    for (;;) {
      let step: unknown;
      try {
        step = await reader.read();
      } catch {
        throw invalidResponse();
      }
      if (
        !isRecord(step) ||
        typeof step.done !== "boolean"
      ) {
        throw invalidResponse();
      }
      if (step.done) {
        break;
      }
      if (!(step.value instanceof Uint8Array)) {
        throw invalidResponse();
      }

      bytes += step.value.byteLength;
      if (bytes > FEISHU_RESPONSE_BYTE_LIMIT) {
        if (typeof reader.cancel === "function") {
          try {
            await reader.cancel();
          } catch {
            // The response has already exceeded the hard limit.
          }
        }
        throw responseTooLarge();
      }
      chunks.push(step.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function settleBeforeAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<SettledBeforeAbort<T>> {
  let onAbort: (() => void) | null = null;
  const aborted =
    new Promise<SettledBeforeAbort<T>>(
      (resolve) => {
        if (signal.aborted) {
          resolve({ kind: "aborted" });
          return;
        }
        onAbort = () =>
          resolve({ kind: "aborted" });
        signal.addEventListener(
          "abort",
          onAbort,
          { once: true }
        );
      }
    );
  const settled = promise.then<
    SettledBeforeAbort<T>,
    SettledBeforeAbort<T>
  >(
    (value) => ({
      kind: "resolved",
      value
    }),
    (error: unknown) => ({
      kind: "rejected",
      error
    })
  );

  try {
    return await Promise.race([
      settled,
      aborted
    ]);
  } finally {
    if (onAbort !== null) {
      signal.removeEventListener(
        "abort",
        onAbort
      );
    }
  }
}

function cancelResponseBody(body: unknown): void {
  if (!isRecord(body)) {
    return;
  }
  const cancel = body.cancel;
  if (typeof cancel === "function") {
    try {
      ignoreCleanup(
        Reflect.apply(cancel, body, [])
      );
    } catch {
      // Error classification must not depend on cleanup support.
    }
    return;
  }
  const getReader = body.getReader;
  if (typeof getReader !== "function") {
    return;
  }

  try {
    const reader = Reflect.apply(
      getReader,
      body,
      []
    );
    if (
      isRecord(reader) &&
      typeof reader.cancel === "function"
    ) {
      ignoreCleanup(
        Reflect.apply(reader.cancel, reader, [])
      );
    }
  } catch {
    // Error classification must not depend on cleanup support.
  }
}

function ignoreCleanup(value: unknown): void {
  try {
    void Promise.resolve(value).catch(() => {});
  } catch {
    // Cleanup is best effort only.
  }
}

function readDataRecord(
  value: unknown
): Record<string, unknown> {
  try {
    if (!isPlainRecord(value)) {
      throw inputError();
    }
    const descriptors =
      Object.getOwnPropertyDescriptors(value);
    const result = Object.create(
      null
    ) as Record<string, unknown>;

    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") {
        throw inputError();
      }
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        throw inputError();
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof FeishuReadError) {
      throw error;
    }
    throw inputError();
  }
}

function readResponseRecord(
  value: unknown
): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw invalidResponse();
  }
  return value;
}

function requireAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[]
): void {
  const allowed = new Set(allowedKeys);
  if (
    Object.keys(value).some(
      (key) => !allowed.has(key)
    )
  ) {
    throw inputError();
  }
}

function requireExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) => key !== expected[index]
    )
  ) {
    throw inputError();
  }
}

function requireCredential(
  value: unknown,
  maximumLength: number
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value !== value.trim() ||
    !value.isWellFormed() ||
    /[\r\n]/.test(value)
  ) {
    throw inputError();
  }
  return value;
}

function requireResponseCredential(
  value: unknown,
  maximumLength: number
): string {
  try {
    return requireCredential(
      value,
      maximumLength
    );
  } catch {
    throw invalidResponse();
  }
}

function requireFieldName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    [...value].length > MAX_FIELD_NAME_LENGTH ||
    value !== value.trim()
  ) {
    throw inputError();
  }
  return value;
}

function normalizeResourceIdentifier(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    !RESOURCE_IDENTIFIER_PATTERN.test(value)
  ) {
    throw inputError();
  }
  return value;
}

function normalizePageToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value !== value.trim() ||
    !value.isWellFormed() ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw invalidResponse();
  }
  return value;
}

function requireResourceIdentifier(
  value: unknown
): string {
  try {
    return normalizeResourceIdentifier(value);
  } catch {
    throw invalidResponse();
  }
}

function normalizeMappedString(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    [...value].length > MAX_RECORD_VALUE_LENGTH
  ) {
    throw invalidResponse();
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw invalidResponse();
  }
  return normalized;
}

function normalizeUpdatedAt(value: unknown): string {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw invalidResponse();
  }
  try {
    return new Date(value).toISOString();
  } catch {
    throw invalidResponse();
  }
}

function normalizeNonNegativeInteger(
  value: unknown
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw invalidResponse();
  }
  return value;
}

function requirePositiveInteger(
  value: unknown
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw invalidResponse();
  }
}

function requireBoundedString(
  value: unknown,
  maximumLength: number
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    [...value].length > maximumLength
  ) {
    throw invalidResponse();
  }
  return value;
}

function readClock(now: () => number): number {
  let value: unknown;
  try {
    value = now();
  } catch {
    throw inputError();
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw inputError();
  }
  return value;
}

function httpError(status: number): FeishuReadError {
  if (status === 401) {
    return feishuError(
      "FEISHU_UNAUTHORIZED",
      "Feishu rejected the tenant access token."
    );
  }
  if (status === 403) {
    return feishuError(
      "FEISHU_FORBIDDEN",
      "Feishu denied access to the configured Base."
    );
  }
  if (status === 404) {
    return feishuError(
      "FEISHU_NOT_FOUND",
      "The configured Feishu resource was not found."
    );
  }
  if (status === 429) {
    return feishuError(
      "FEISHU_RATE_LIMITED",
      "Feishu rate-limited the bounded read request."
    );
  }
  return feishuError(
    "FEISHU_HTTP_ERROR",
    `Feishu read request failed with HTTP status ${status}.`
  );
}

function inputError(): FeishuReadError {
  return feishuError(
    "FEISHU_INPUT_INVALID",
    "Feishu read client input is invalid."
  );
}

function invalidResponse(): FeishuReadError {
  return feishuError(
    "FEISHU_RESPONSE_INVALID",
    "Feishu returned an invalid response."
  );
}

function responseTooLarge(): FeishuReadError {
  return feishuError(
    "FEISHU_RESPONSE_TOO_LARGE",
    "Feishu response exceeded the configured safety limit."
  );
}

function invalidPagination(): FeishuReadError {
  return feishuError(
    "FEISHU_PAGINATION_INVALID",
    "Feishu returned invalid or unbounded pagination."
  );
}

function invalidFieldMapping(): FeishuReadError {
  return feishuError(
    "FEISHU_FIELD_MAPPING_INVALID",
    "Feishu fields do not match the configured read mapping."
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

function isPlainRecord(
  value: unknown
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

export class FeishuReadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FeishuReadError";
    this.code = code;
  }
}

function feishuError(
  code: string,
  message: string
): FeishuReadError {
  return new FeishuReadError(code, message);
}
