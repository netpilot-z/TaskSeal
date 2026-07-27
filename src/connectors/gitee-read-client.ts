const GITEE_API_ORIGIN = "https://gitee.com";
export const GITEE_RESPONSE_BYTE_LIMIT = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REPOSITORY_PART_LENGTH = 100;
const MAX_TITLE_LENGTH = 10_000;
const MAX_TIMESTAMP_LENGTH = 64;
const ISSUE_REFERENCE_PATTERN =
  /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const REPOSITORY_PART_PATTERN = /^[A-Za-z0-9_.-]+$/;

export interface GiteeFetchRequestOptions {
  method: "GET";
  headers: {
    Accept: "application/json";
    "User-Agent": "TaskSeal";
  };
  redirect: "error";
  signal: AbortSignal;
}

export type GiteeFetchLike = (
  url: string,
  options: GiteeFetchRequestOptions
) => Promise<unknown>;

export interface GiteeRepositoryReadResult {
  repository: string;
}

export interface GiteeIssueReadResult {
  id: number;
  number: string;
  title: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  repository: string;
}

interface ReadGiteeRepositoryOptions {
  repository: string;
  fetchImpl?: GiteeFetchLike;
  timeoutMs?: number;
}

interface ReadGiteeIssueOptions
  extends ReadGiteeRepositoryOptions {
  issueReference: string;
}

interface NormalizedRepository {
  owner: string;
  name: string;
  canonical: string;
}

interface BodyReader {
  read(): Promise<unknown>;
  cancel?(reason?: unknown): Promise<unknown>;
}

export async function readGiteeRepository({
  repository,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
}: ReadGiteeRepositoryOptions): Promise<GiteeRepositoryReadResult> {
  const normalized = normalizeRepository(repository);
  validateFetch(fetchImpl);
  validateTimeout(timeoutMs);
  const body = await getJson({
    path:
      `/api/v5/repos/${encodeURIComponent(normalized.owner)}` +
      `/${encodeURIComponent(normalized.name)}`,
    fetchImpl,
    timeoutMs
  });
  requirePositiveInteger(body.id);
  const returnedRepository = normalizeReturnedRepository(
    body.full_name
  );

  if (returnedRepository.canonical !== normalized.canonical) {
    throw giteeError(
      "GITEE_SCOPE_MISMATCH",
      "Gitee returned a repository outside the configured scope."
    );
  }

  return {
    repository: normalized.canonical
  };
}

export async function readGiteeIssue({
  repository,
  issueReference,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
}: ReadGiteeIssueOptions): Promise<GiteeIssueReadResult> {
  const normalized = normalizeRepository(repository);
  const reference = normalizeIssueReference(issueReference);
  validateFetch(fetchImpl);
  validateTimeout(timeoutMs);
  const body = await getJson({
    path:
      `/api/v5/repos/${encodeURIComponent(normalized.owner)}` +
      `/${encodeURIComponent(normalized.name)}` +
      `/issues/${encodeURIComponent(reference)}`,
    fetchImpl,
    timeoutMs
  });

  requirePositiveInteger(body.id);
  requireBoundedString(body.number, 64);

  if (body.number !== reference) {
    throw giteeError(
      "GITEE_ISSUE_REFERENCE_MISMATCH",
      "Gitee returned a different case-sensitive Issue reference."
    );
  }

  requireBoundedString(body.title, MAX_TITLE_LENGTH);
  requireTimestamp(body.created_at);
  requireTimestamp(body.updated_at);

  if (!isRecord(body.repository)) {
    throw invalidResponse();
  }

  const returnedRepository = normalizeReturnedRepository(
    body.repository.full_name
  );

  if (returnedRepository.canonical !== normalized.canonical) {
    throw giteeError(
      "GITEE_SCOPE_MISMATCH",
      "Gitee returned an Issue outside the configured repository scope."
    );
  }

  const htmlUrl = normalizeIssueUrl({
    value: body.html_url,
    repository: normalized.canonical,
    issueReference: reference
  });

  return {
    id: body.id,
    number: body.number,
    title: body.title,
    htmlUrl,
    createdAt: body.created_at,
    updatedAt: body.updated_at,
    repository: normalized.canonical
  };
}

export function isGiteeIssueReference(
  value: unknown
): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    ISSUE_REFERENCE_PATTERN.test(value)
  );
}

export function canonicalizeGiteeRepository(
  repository: string
): string {
  return normalizeRepository(repository).canonical;
}

async function getJson({
  path,
  fetchImpl,
  timeoutMs
}: {
  path: string;
  fetchImpl: GiteeFetchLike;
  timeoutMs: number;
}): Promise<Record<string, unknown>> {
  let response: unknown;

  try {
    response = await fetchImpl(
      new URL(path, GITEE_API_ORIGIN).href,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "TaskSeal"
        },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs)
      }
    );
  } catch {
    throw giteeError(
      "GITEE_REQUEST_FAILED",
      "Gitee request failed before a valid response was received."
    );
  }

  if (
    !isRecord(response) ||
    typeof response.ok !== "boolean" ||
    typeof response.status !== "number" ||
    !Number.isInteger(response.status)
  ) {
    throw invalidResponse();
  }

  if (!response.ok) {
    cancelResponseBody(response);
    throw httpError(response.status);
  }

  const text = await readBoundedBody(response);
  let body: unknown;

  try {
    body = JSON.parse(text);
  } catch {
    throw invalidResponse();
  }

  if (!isPlainRecord(body)) {
    throw invalidResponse();
  }

  return body;
}

function cancelResponseBody(
  response: Record<string, unknown>
): void {
  let body: unknown;
  try {
    body = response.body;
  } catch {
    return;
  }

  if (!isRecord(body)) {
    return;
  }

  const cancel = body.cancel;
  if (typeof cancel === "function") {
    try {
      ignoreCleanupResult(Reflect.apply(cancel, body, []));
    } catch {
      // HTTP classification must remain stable if cleanup is unavailable.
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
      ignoreCleanupResult(
        Reflect.apply(reader.cancel, reader, [])
      );
    }
  } catch {
    // HTTP classification must remain stable if cleanup is unavailable.
  }
}

function ignoreCleanupResult(result: unknown): void {
  try {
    void Promise.resolve(result).catch(() => {});
  } catch {
    // Cleanup must not delay or replace the classified provider error.
  }
}

async function readBoundedBody(
  response: Record<string, unknown>
): Promise<string> {
  validateContentLength(response.headers);
  const stream = response.body;

  if (
    isRecord(stream) &&
    typeof stream.getReader === "function"
  ) {
    return readStreamBody(stream);
  }

  const textMethod = response.text;
  if (typeof textMethod !== "function") {
    throw invalidResponse();
  }

  let text: unknown;
  try {
    text = await Reflect.apply(textMethod, response, []);
  } catch {
    throw invalidResponse();
  }

  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") >
      GITEE_RESPONSE_BYTE_LIMIT
  ) {
    throw responseTooLarge();
  }

  return text;
}

function validateContentLength(headers: unknown): void {
  if (
    headers === undefined ||
    headers === null
  ) {
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

  if (length > GITEE_RESPONSE_BYTE_LIMIT) {
    throw responseTooLarge();
  }
}

async function readStreamBody(
  stream: Record<string, unknown>
): Promise<string> {
  const getReader = stream.getReader;
  if (typeof getReader !== "function") {
    throw invalidResponse();
  }

  let reader: unknown;
  try {
    reader = Reflect.apply(getReader, stream, []);
  } catch {
    throw invalidResponse();
  }

  if (!isRecord(reader) || typeof reader.read !== "function") {
    throw invalidResponse();
  }

  const typedReader = reader as unknown as BodyReader;
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  while (true) {
    let result: unknown;
    try {
      result = await typedReader.read();
    } catch {
      throw invalidResponse();
    }

    if (
      !isRecord(result) ||
      typeof result.done !== "boolean"
    ) {
      throw invalidResponse();
    }

    if (result.done) {
      break;
    }

    if (!(result.value instanceof Uint8Array)) {
      throw invalidResponse();
    }

    bytes += result.value.byteLength;
    if (bytes > GITEE_RESPONSE_BYTE_LIMIT) {
      if (typeof typedReader.cancel === "function") {
        try {
          await typedReader.cancel();
        } catch {
          // The response is already rejected; cancellation is best effort.
        }
      }
      throw responseTooLarge();
    }

    chunks.push(result.value);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function normalizeRepository(
  value: unknown
): NormalizedRepository {
  const parts =
    typeof value === "string" ? value.split("/") : [];

  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length > MAX_REPOSITORY_PART_LENGTH * 2 + 1 ||
    parts.length !== 2 ||
    parts.some(
      (part) =>
        part.length === 0 ||
        part.length > MAX_REPOSITORY_PART_LENGTH ||
        !REPOSITORY_PART_PATTERN.test(part) ||
        part === "." ||
        part === ".."
    )
  ) {
    throw giteeError(
      "GITEE_REPOSITORY_INVALID",
      "Gitee repository must use owner/name format."
    );
  }

  const owner = parts[0];
  const name = parts[1];

  if (!owner || !name) {
    throw giteeError(
      "GITEE_REPOSITORY_INVALID",
      "Gitee repository must use owner/name format."
    );
  }

  return {
    owner,
    name,
    canonical: `${owner.toLowerCase()}/${name.toLowerCase()}`
  };
}

function normalizeReturnedRepository(
  value: unknown
): NormalizedRepository {
  try {
    return normalizeRepository(value);
  } catch {
    throw invalidResponse();
  }
}

function normalizeIssueReference(value: unknown): string {
  if (!isGiteeIssueReference(value)) {
    throw giteeError(
      "GITEE_ISSUE_REFERENCE_INVALID",
      "Gitee Issue reference must be a bounded case-sensitive identifier."
    );
  }
  return value;
}

function normalizeIssueUrl({
  value,
  repository,
  issueReference
}: {
  value: unknown;
  repository: string;
  issueReference: string;
}): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2048
  ) {
    throw invalidIssueUrl();
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidIssueUrl();
  }

  const [owner, name] = repository.split("/");
  const pathParts = url.pathname.split("/");

  if (
    url.protocol !== "https:" ||
    url.hostname !== "gitee.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    pathParts.length !== 5 ||
    pathParts[0] !== "" ||
    pathParts[1]?.toLowerCase() !== owner ||
    pathParts[2]?.toLowerCase() !== name ||
    pathParts[3] !== "issues" ||
    pathParts[4] !== issueReference
  ) {
    throw invalidIssueUrl();
  }

  return url.href;
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
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    [...value].length > maximumLength
  ) {
    throw invalidResponse();
  }
}

function requireTimestamp(
  value: unknown
): asserts value is string {
  requireBoundedString(value, MAX_TIMESTAMP_LENGTH);
  if (!Number.isFinite(Date.parse(value))) {
    throw invalidResponse();
  }
}

function validateFetch(
  fetchImpl: unknown
): asserts fetchImpl is GiteeFetchLike {
  if (typeof fetchImpl !== "function") {
    throw giteeError(
      "GITEE_FETCH_INVALID",
      "Gitee read client requires a fetch implementation."
    );
  }
}

function validateTimeout(
  timeoutMs: unknown
): asserts timeoutMs is number {
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw giteeError(
      "GITEE_TIMEOUT_INVALID",
      "Gitee timeout must be a positive integer."
    );
  }
}

function httpError(status: number): GiteeReadError {
  if (status === 401) {
    return giteeError(
      "GITEE_AUTH_REQUIRED",
      "Gitee requires authentication for this resource."
    );
  }
  if (status === 403) {
    return giteeError(
      "GITEE_FORBIDDEN",
      "Gitee denied the anonymous read request."
    );
  }
  if (status === 404) {
    return giteeError(
      "GITEE_NOT_FOUND",
      "The requested Gitee resource was not found."
    );
  }
  if (status === 429) {
    return giteeError(
      "GITEE_RATE_LIMITED",
      "Gitee rate-limited the anonymous read request."
    );
  }
  return giteeError(
    "GITEE_HTTP_ERROR",
    `Gitee read request failed with HTTP status ${status}.`
  );
}

function invalidResponse(): GiteeReadError {
  return giteeError(
    "GITEE_RESPONSE_INVALID",
    "Gitee returned an invalid response."
  );
}

function responseTooLarge(): GiteeReadError {
  return giteeError(
    "GITEE_RESPONSE_TOO_LARGE",
    "Gitee response exceeded the configured safety limit."
  );
}

function invalidIssueUrl(): GiteeReadError {
  return giteeError(
    "GITEE_ISSUE_URL_INVALID",
    "Gitee returned an Issue URL outside the requested scope."
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
  return prototype === Object.prototype || prototype === null;
}

export class GiteeReadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GiteeReadError";
    this.code = code;
  }
}

function giteeError(
  code: string,
  message: string
): GiteeReadError {
  return new GiteeReadError(code, message);
}
