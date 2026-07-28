import {
  performance
} from "node:perf_hooks";

export const LINEAR_GRAPHQL_ENDPOINT =
  "https://api.linear.app/graphql";
export const LINEAR_GRAPHQL_REQUEST_BYTE_LIMIT =
  128 * 1024;
export const LINEAR_GRAPHQL_RESPONSE_BYTE_LIMIT =
  64 * 1024;

const DEFAULT_TIMEOUT_MS = 15_000;
const MAXIMUM_TIMEOUT_MS = 15_000;
const OPERATION_PATTERN =
  /^[a-z][a-z0-9_]{0,63}$/;

export interface LinearGraphqlHttpRequest {
  readonly schemaVersion: 1;
  readonly operation: string;
  readonly body: string;
}

export type LinearGraphqlHttpExchangeResult =
  | {
      readonly kind: "not_dispatched";
    }
  | {
      readonly kind: "response_lost";
    }
  | {
      readonly kind: "response";
      readonly status: number;
      readonly body: string;
    };

export type LinearGraphqlHttpExchange = (
  request: unknown
) => Promise<LinearGraphqlHttpExchangeResult>;

interface LinearGraphqlFetchOptions {
  readonly method: "POST";
  readonly headers: {
    readonly Authorization: string;
    readonly "Content-Type": "application/json";
  };
  readonly body: string;
  readonly redirect: "error";
  readonly signal: AbortSignal;
}

type LinearGraphqlFetch = (
  url: string,
  options: LinearGraphqlFetchOptions
) => Promise<unknown>;

interface NormalizedOptions {
  readonly authorization: string;
  readonly fetchImpl: LinearGraphqlFetch;
  readonly timeoutMs: number;
}

interface StreamReader {
  read(): Promise<unknown>;
  cancel(): Promise<unknown>;
}

type SettledBeforeAbort<T> =
  | {
      readonly kind: "resolved";
      readonly value: T;
    }
  | {
      readonly kind: "failed";
    }
  | {
      readonly kind: "aborted";
    };

export function createLinearGraphqlHttpExchange(
  optionsValue: unknown
): LinearGraphqlHttpExchange {
  const options = normalizeOptions(optionsValue);

  return async (
    requestValue: unknown
  ): Promise<LinearGraphqlHttpExchangeResult> => {
    const request = normalizeRequest(requestValue);

    if (request === null) {
      return freezeResult({
        kind: "not_dispatched"
      });
    }

    const deadline =
      performance.now() + options.timeoutMs;
    const signal = AbortSignal.timeout(
      options.timeoutMs
    );
    let dispatched: SettledBeforeAbort<unknown>;

    try {
      dispatched = await settleBeforeAbort(
        Promise.resolve(
          options.fetchImpl(
            LINEAR_GRAPHQL_ENDPOINT,
            {
              method: "POST",
              headers: {
                Authorization:
                  options.authorization,
                "Content-Type":
                  "application/json"
              },
              body: request.body,
              redirect: "error",
              signal
            }
          )
        ),
        signal
      );
    } catch {
      return freezeResult({
        kind: "response_lost"
      });
    }

    if (dispatched.kind !== "resolved") {
      return freezeResult({
        kind: "response_lost"
      });
    }

    let response: ReturnType<
      typeof normalizeResponse
    >;

    try {
      response = normalizeResponse(
        dispatched.value
      );
    } catch {
      return freezeResult({
        kind: "response_lost"
      });
    }

    if (response === null) {
      return freezeResult({
        kind: "response_lost"
      });
    }

    const read = await settleBeforeAbort(
      readBoundedBody(
        response.body,
        signal,
        deadline
      ),
      signal
    );

    if (
      read.kind !== "resolved" ||
      read.value === null
    ) {
      return freezeResult({
        kind: "response_lost"
      });
    }

    return freezeResult({
      kind: "response",
      status: response.status,
      body: read.value
    });
  };
}

function normalizeOptions(
  value: unknown
): NormalizedOptions {
  try {
    return normalizeOptionsUnsafe(value);
  } catch (error) {
    if (
      error instanceof
      LinearHttpGraphqlExchangeError
    ) {
      throw error;
    }

    throw exchangeError(
      "LINEAR_HTTP_EXCHANGE_INPUT_INVALID",
      "Linear HTTP exchange input is invalid."
    );
  }
}

function normalizeOptionsUnsafe(
  value: unknown
): NormalizedOptions {
  const options = readDataRecord(value);
  requireAllowedKeys(options, [
    "apiKey",
    "accessToken",
    "fetchImpl",
    "timeoutMs"
  ]);
  const apiKey = normalizeCredential(
    options.apiKey
  );
  const accessToken = normalizeCredential(
    options.accessToken
  );

  if (
    (apiKey === null) ===
    (accessToken === null)
  ) {
    throw exchangeError(
      "LINEAR_HTTP_EXCHANGE_AUTH_INVALID",
      "Configure exactly one Linear credential."
    );
  }

  const fetchValue =
    options.fetchImpl ?? globalThis.fetch;

  if (typeof fetchValue !== "function") {
    throw exchangeError(
      "LINEAR_HTTP_EXCHANGE_FETCH_INVALID",
      "Linear HTTP exchange requires a fetch implementation."
    );
  }

  const timeoutValue =
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (
    typeof timeoutValue !== "number" ||
    !Number.isInteger(timeoutValue) ||
    timeoutValue <= 0 ||
    timeoutValue > MAXIMUM_TIMEOUT_MS
  ) {
    throw exchangeError(
      "LINEAR_HTTP_EXCHANGE_TIMEOUT_INVALID",
      "Linear HTTP exchange timeout is invalid."
    );
  }

  return {
    authorization:
      apiKey ?? `Bearer ${accessToken}`,
    fetchImpl:
      fetchValue as LinearGraphqlFetch,
    timeoutMs: timeoutValue
  };
}

function normalizeCredential(
  value: unknown
): string | null {
  if (value === undefined) {
    return null;
  }

  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\r\n]/.test(value)
  ) {
    throw exchangeError(
      "LINEAR_HTTP_EXCHANGE_AUTH_INVALID",
      "Linear credential configuration is invalid."
    );
  }

  return value;
}

function normalizeRequest(
  value: unknown
): LinearGraphqlHttpRequest | null {
  try {
    const request = readDataRecord(value);
    requireExactKeys(request, [
      "schemaVersion",
      "operation",
      "body"
    ]);

    if (
      request.schemaVersion !== 1 ||
      typeof request.operation !== "string" ||
      !OPERATION_PATTERN.test(
        request.operation
      ) ||
      typeof request.body !== "string" ||
      !request.body.isWellFormed() ||
      Buffer.byteLength(
        request.body,
        "utf8"
      ) > LINEAR_GRAPHQL_REQUEST_BYTE_LIMIT
    ) {
      return null;
    }

    return {
      schemaVersion: 1,
      operation: request.operation,
      body: request.body
    };
  } catch {
    return null;
  }
}

function normalizeResponse(
  value: unknown
): {
  readonly status: number;
  readonly body: unknown;
} | null {
  if (!isRecord(value)) {
    return null;
  }

  let status: unknown;
  let body: unknown;

  try {
    status = Reflect.get(value, "status");
    body = Reflect.get(value, "body");
  } catch {
    return null;
  }

  if (
    typeof status !== "number" ||
    !Number.isSafeInteger(status) ||
    status < 100 ||
    status > 599
  ) {
    return null;
  }

  return {
    status,
    body
  };
}

async function readBoundedBody(
  body: unknown,
  signal: AbortSignal,
  deadline: number
): Promise<string | null> {
  const reader = createReader(body);

  if (reader === null) {
    return null;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = (): void => {
    void safeCancel(reader);
  };
  signal.addEventListener("abort", cancel, {
    once: true
  });

  try {
    for (;;) {
      if (deadlineExceeded(signal, deadline)) {
        await safeCancel(reader);
        return null;
      }

      const step = await reader.read();

      if (deadlineExceeded(signal, deadline)) {
        await safeCancel(reader);
        return null;
      }

      if (!isRecord(step)) {
        return null;
      }

      if (step.done === true) {
        if (step.value !== undefined) {
          return null;
        }
        break;
      }

      if (
        step.done !== false ||
        !(step.value instanceof Uint8Array)
      ) {
        return null;
      }

      if (step.value.byteLength === 0) {
        await safeCancel(reader);
        return null;
      }

      total += step.value.byteLength;

      if (
        total >
        LINEAR_GRAPHQL_RESPONSE_BYTE_LIMIT
      ) {
        await safeCancel(reader);
        return null;
      }

      chunks.push(step.value);
    }

    try {
      return new TextDecoder("utf-8", {
        fatal: true
      }).decode(concatenate(chunks, total));
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function deadlineExceeded(
  signal: AbortSignal,
  deadline: number
): boolean {
  return (
    signal.aborted ||
    performance.now() >= deadline
  );
}

function createReader(
  body: unknown
): StreamReader | null {
  if (
    !isRecord(body) ||
    typeof body.getReader !== "function"
  ) {
    return null;
  }

  let candidate: unknown;

  try {
    candidate = Reflect.apply(
      body.getReader,
      body,
      []
    );
  } catch {
    return null;
  }

  if (
    !isRecord(candidate) ||
    typeof candidate.read !== "function" ||
    typeof candidate.cancel !== "function"
  ) {
    return null;
  }

  return {
    read: () =>
      Promise.resolve(
        Reflect.apply(
          candidate.read as (...args: never[]) => unknown,
          candidate,
          []
        )
      ),
    cancel: () =>
      Promise.resolve(
        Reflect.apply(
          candidate.cancel as (...args: never[]) => unknown,
          candidate,
          []
        )
      )
  };
}

async function safeCancel(
  reader: StreamReader
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // A failed cancel cannot restore a trustworthy response.
  }
}

function concatenate(
  chunks: readonly Uint8Array[],
  length: number
): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
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
    () => ({ kind: "failed" })
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
    throw exchangeError(
      "LINEAR_HTTP_EXCHANGE_INPUT_INVALID",
      "Linear HTTP exchange input is invalid."
    );
  }

  const descriptors =
    Object.getOwnPropertyDescriptors(value);
  const result = Object.create(
    null
  ) as Record<string, unknown>;

  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw exchangeError(
        "LINEAR_HTTP_EXCHANGE_INPUT_INVALID",
        "Linear HTTP exchange input is invalid."
      );
    }

    const descriptor = descriptors[key];

    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw exchangeError(
        "LINEAR_HTTP_EXCHANGE_INPUT_INVALID",
        "Linear HTTP exchange input is invalid."
      );
    }

    result[key] = descriptor.value;
  }

  return result;
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
    throw exchangeError(
      "LINEAR_HTTP_EXCHANGE_INPUT_INVALID",
      "Linear HTTP exchange input is invalid."
    );
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
    throw exchangeError(
      "LINEAR_HTTP_EXCHANGE_INPUT_INVALID",
      "Linear HTTP exchange input is invalid."
    );
  }
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

function freezeResult<T extends object>(
  value: T
): Readonly<T> {
  return Object.freeze(value);
}

export class LinearHttpGraphqlExchangeError
  extends Error
{
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name =
      "LinearHttpGraphqlExchangeError";
    this.code = code;
  }
}

function exchangeError(
  code: string,
  message: string
): LinearHttpGraphqlExchangeError {
  return new LinearHttpGraphqlExchangeError(
    code,
    message
  );
}
