import {
  lstat,
  open,
  realpath
} from "node:fs/promises";
import type {
  FileHandle
} from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve
} from "node:path";

import {
  digestCanonicalJson
} from "../lib/canonical-json.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL_ID_PATTERN = /^[1-9]\d*$/;
const MAXIMUM_ENTRIES = 200;
const MAXIMUM_EVIDENCE = 7;
const MAXIMUM_INDEX_BYTES = 512 * 1024;
const MAXIMUM_STRING = 256;

export type GitHubDeliveryEvidenceBinding =
  | {
      readonly criterionKey: string;
      readonly source: {
        readonly kind: "check_run";
        readonly name: string;
        readonly appId?: string | undefined;
      };
    }
  | {
      readonly criterionKey: string;
      readonly source: {
        readonly kind:
          "pull_request_review";
        readonly reviewerId: string;
      };
    };

export interface GitHubDeliveryBinding {
  readonly linearIssueId: string;
  readonly workItemId: string;
  readonly headRepository: string;
  readonly branch: string;
  readonly pullRequestNumber: number;
  readonly evidence:
    readonly GitHubDeliveryEvidenceBinding[];
  readonly bindingDigest: string;
}

export interface GitHubDeliveryIndex {
  readonly target: {
    readonly repository: string;
  };
  readonly entries:
    readonly GitHubDeliveryBinding[];
  byWorkItem(
    workItemId: string
  ): GitHubDeliveryBinding | null;
}

export async function readGitHubDeliveryIndex({
  workspaceRoot,
  repositoryPath
}: {
  readonly workspaceRoot: string;
  readonly repositoryPath: string;
}): Promise<GitHubDeliveryIndex> {
  const filePath = resolveIndexPath(
    workspaceRoot,
    repositoryPath
  );
  let raw: string;

  try {
    raw = await readBoundedIndexFile({
      workspaceRoot,
      filePath
    });
  } catch (error) {
    if (
      error instanceof
        GitHubDeliveryIndexError
    ) {
      throw error;
    }

    throw deliveryIndexError(
      "GITHUB_DELIVERY_INDEX_READ_FAILED",
      "TaskSeal could not read the GitHub delivery index."
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidIndex();
  }

  return parseGitHubDeliveryIndex(parsed);
}

export function parseGitHubDeliveryIndex(
  value: unknown
): GitHubDeliveryIndex {
  try {
    return parseGitHubDeliveryIndexUnsafe(
      value
    );
  } catch (error) {
    if (
      error instanceof
      GitHubDeliveryIndexError
    ) {
      throw error;
    }

    throw invalidIndex();
  }
}

function parseGitHubDeliveryIndexUnsafe(
  value: unknown
): GitHubDeliveryIndex {
  const root = readDataRecord(value);

  if (
    !hasExactKeys(root, [
      "schemaVersion",
      "provider",
      "target",
      "entries"
    ]) ||
    root.schemaVersion !== 1 ||
    root.provider !== "github" ||
    !Array.isArray(root.entries) ||
    root.entries.length > MAXIMUM_ENTRIES
  ) {
    throw invalidIndex();
  }

  const targetRecord =
    readDataRecord(root.target);
  if (
    !hasExactKeys(targetRecord, [
      "repository"
    ])
  ) {
    throw invalidIndex();
  }

  const repository = parseRepository(
    targetRecord.repository
  );
  const entries =
    root.entries.map(parseEntry);
  const linearIssueIds = new Set<string>();
  const workItemIds = new Set<string>();
  const pullRequests = new Set<string>();
  const branches = new Set<string>();

  for (const entry of entries) {
    const pullRequestKey =
      `${repository}#${entry.pullRequestNumber}`;
    const branchKey =
      `${entry.headRepository}\u0000${entry.branch}`;

    if (
      linearIssueIds.has(
        entry.linearIssueId
      ) ||
      workItemIds.has(entry.workItemId) ||
      pullRequests.has(pullRequestKey) ||
      branches.has(branchKey)
    ) {
      throw invalidIndex();
    }

    linearIssueIds.add(entry.linearIssueId);
    workItemIds.add(entry.workItemId);
    pullRequests.add(pullRequestKey);
    branches.add(branchKey);
  }

  const frozenEntries = Object.freeze(
    entries.map(freezeEntry)
  );
  const byWorkItem = new Map(
    frozenEntries.map((entry) => [
      entry.workItemId,
      entry
    ])
  );

  return Object.freeze({
    target: Object.freeze({
      repository
    }),
    entries: frozenEntries,
    byWorkItem(
      workItemId: string
    ): GitHubDeliveryBinding | null {
      const entry = byWorkItem.get(
        workItemId
      );
      return entry
        ? structuredClone(entry)
        : null;
    }
  });
}

function parseEntry(
  value: unknown
): GitHubDeliveryBinding {
  const entry = readDataRecord(value);

  if (
    !hasExactKeys(entry, [
      "linearIssueId",
      "workItemId",
      "headRepository",
      "branch",
      "pullRequestNumber",
      "evidence"
    ]) ||
    !Array.isArray(entry.evidence) ||
    entry.evidence.length === 0 ||
    entry.evidence.length >
      MAXIMUM_EVIDENCE
  ) {
    throw invalidIndex();
  }

  const linearIssueId =
    parseUuid(entry.linearIssueId);
  const workItemId = parseBoundedString(
    entry.workItemId
  );
  const headRepository =
    parseRepository(entry.headRepository);
  const branch = parseBranch(entry.branch);
  const pullRequestNumber =
    parsePositiveInteger(
      entry.pullRequestNumber
    );
  const evidence =
    entry.evidence.map(
      parseEvidenceBinding
    );
  const criterionKeys = new Set<string>();
  const sourceSelectors =
    new Set<string>();

  for (const binding of evidence) {
    const sourceSelector =
      binding.source.kind === "check_run"
        ? [
            "check_run",
            binding.source.name,
            binding.source.appId ?? ""
          ].join("\u0000")
        : [
            "pull_request_review",
            binding.source.reviewerId
          ].join("\u0000");

    if (
      criterionKeys.has(
        binding.criterionKey
      ) ||
      sourceSelectors.has(sourceSelector)
    ) {
      throw invalidIndex();
    }

    criterionKeys.add(binding.criterionKey);
    sourceSelectors.add(sourceSelector);
  }

  const binding = {
    linearIssueId,
    workItemId,
    headRepository,
    branch,
    pullRequestNumber,
    evidence: [...evidence].sort(
      (left, right) =>
        compareStrings(
          left.criterionKey,
          right.criterionKey
        )
    )
  };

  return {
    ...binding,
    bindingDigest:
      digestCanonicalJson({
        schemaVersion: 1,
        ...binding
      })
  };
}

function parseEvidenceBinding(
  value: unknown
): GitHubDeliveryEvidenceBinding {
  const binding = readDataRecord(value);
  if (
    !hasExactKeys(binding, [
      "criterionKey",
      "source"
    ])
  ) {
    throw invalidIndex();
  }

  const criterionKey =
    parseBoundedString(
      binding.criterionKey
    );
  const source =
    readDataRecord(binding.source);

  if (source.kind === "check_run") {
    if (
      !hasAllowedExactKeys(
        source,
        ["kind", "name"],
        ["appId"]
      )
    ) {
      throw invalidIndex();
    }

    const name = parseBoundedString(
      source.name
    );
    const appId =
      source.appId === undefined
        ? undefined
        : parseDecimalId(source.appId);

    return {
      criterionKey,
      source: {
        kind: "check_run",
        name,
        ...(appId === undefined
          ? {}
          : { appId })
      }
    };
  }

  if (
    source.kind ===
      "pull_request_review" &&
    hasExactKeys(source, [
      "kind",
      "reviewerId"
    ])
  ) {
    return {
      criterionKey,
      source: {
        kind:
          "pull_request_review",
        reviewerId:
          parseDecimalId(
            source.reviewerId
          )
      }
    };
  }

  throw invalidIndex();
}

function compareStrings(
  left: string,
  right: string
): number {
  return left < right
    ? -1
    : left > right
      ? 1
      : 0;
}

function freezeEntry(
  entry: GitHubDeliveryBinding
): GitHubDeliveryBinding {
  const evidence:
    GitHubDeliveryEvidenceBinding[] =
      entry.evidence.map((binding) =>
        binding.source.kind === "check_run"
          ? Object.freeze({
              criterionKey:
                binding.criterionKey,
              source: Object.freeze({
                kind: "check_run" as const,
                name: binding.source.name,
                ...(binding.source.appId ===
                undefined
                  ? {}
                  : {
                      appId:
                        binding.source.appId
                    })
              })
            })
          : Object.freeze({
              criterionKey:
                binding.criterionKey,
              source: Object.freeze({
                kind:
                  "pull_request_review" as const,
                reviewerId:
                  binding.source.reviewerId
              })
            })
      );

  return Object.freeze({
    ...entry,
    evidence: Object.freeze(evidence)
  });
}

function parseRepository(
  value: unknown
): string {
  const repository =
    parseBoundedString(value);
  const parts = repository.split("/");

  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        part === "." ||
        part === ".." ||
        !/^[A-Za-z0-9_.-]+$/.test(
          part
        )
    )
  ) {
    throw invalidIndex();
  }

  return repository.toLowerCase();
}

function parseBranch(value: unknown): string {
  const branch = parseBoundedString(value);

  if (
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    /[\s~^:?*[\\\x00-\x1f\x7f]/.test(
      branch
    ) ||
    branch
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 ||
          segment.endsWith(".lock")
      )
  ) {
    throw invalidIndex();
  }

  return branch;
}

function parseBoundedString(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAXIMUM_STRING ||
    value !== value.trim() ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw invalidIndex();
  }

  return value;
}

function parseUuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    throw invalidIndex();
  }

  return value.toLowerCase();
}

function parseDecimalId(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    !DECIMAL_ID_PATTERN.test(value) ||
    value.length > 32
  ) {
    throw invalidIndex();
  }

  return value;
}

function parsePositiveInteger(
  value: unknown
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw invalidIndex();
  }

  return value;
}

function resolveIndexPath(
  workspaceRoot: string,
  repositoryPath: string
): string {
  if (
    typeof workspaceRoot !== "string" ||
    workspaceRoot.length === 0 ||
    typeof repositoryPath !== "string" ||
    repositoryPath.length === 0 ||
    repositoryPath !==
      repositoryPath.trim() ||
    isAbsolute(repositoryPath) ||
    !isSafeRepositoryPath(
      repositoryPath
    )
  ) {
    throw invalidIndex();
  }

  const root = resolve(workspaceRoot);
  const target = resolve(root, repositoryPath);
  const fromRoot = relative(root, target);

  if (
    fromRoot.length === 0 ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..\\`) ||
    fromRoot.startsWith("../") ||
    isAbsolute(fromRoot)
  ) {
    throw invalidIndex();
  }

  return target;
}

function isSafeRepositoryPath(
  value: string
): boolean {
  if (
    value.length > 512 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    !value.endsWith(".json")
  ) {
    return false;
  }

  return value.split("/").every(
    (segment) =>
      segment.length > 0 &&
      segment.length <= 100 &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(
        segment
      ) &&
      !segment.endsWith(".") &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(
        segment
      )
  );
}

async function readBoundedIndexFile({
  workspaceRoot,
  filePath
}: {
  readonly workspaceRoot: string;
  readonly filePath: string;
}): Promise<string> {
  const canonicalRoot = await realpath(
    resolve(workspaceRoot)
  );
  const metadata = await lstat(filePath);

  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink()
  ) {
    throw invalidIndex();
  }

  const canonicalTarget =
    await realpath(filePath);

  if (
    !isStrictDescendant(
      canonicalRoot,
      canonicalTarget
    )
  ) {
    throw invalidIndex();
  }

  let handle: FileHandle | undefined;

  try {
    handle = await open(filePath, "r");
    const opened = await handle.stat();

    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino
    ) {
      throw invalidIndex();
    }

    return await readBoundedUtf8(handle);
  } finally {
    await closeIgnoringErrors(handle);
  }
}

async function readBoundedUtf8(
  handle: FileHandle
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  while (total <= MAXIMUM_INDEX_BYTES) {
    const remaining =
      MAXIMUM_INDEX_BYTES + 1 - total;
    const buffer = Buffer.allocUnsafe(
      Math.min(64 * 1024, remaining)
    );
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.length,
      total
    );

    if (bytesRead === 0) {
      break;
    }

    chunks.push(
      buffer.subarray(0, bytesRead)
    );
    total += bytesRead;
  }

  if (total > MAXIMUM_INDEX_BYTES) {
    throw deliveryIndexError(
      "GITHUB_DELIVERY_INDEX_LIMIT_EXCEEDED",
      "GitHub delivery index exceeds the safety limit."
    );
  }

  return Buffer.concat(
    chunks,
    total
  ).toString("utf8");
}

function isStrictDescendant(
  parent: string,
  candidate: string
): boolean {
  const value = relative(parent, candidate);

  return (
    value.length > 0 &&
    !value.startsWith("..") &&
    !isAbsolute(value)
  );
}

async function closeIgnoringErrors(
  handle: FileHandle | undefined
): Promise<void> {
  if (handle === undefined) {
    return;
  }

  try {
    await handle.close();
  } catch {
    // The primary read or validation error remains authoritative.
  }
}

function readDataRecord(
  value: unknown
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (
      Object.getPrototypeOf(value) !==
        Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
  ) {
    throw invalidIndex();
  }

  const descriptors =
    Object.getOwnPropertyDescriptors(value);
  const record = Object.create(
    null
  ) as Record<string, unknown>;

  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw invalidIndex();
    }

    const descriptor = descriptors[key];

    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalidIndex();
    }

    record[key] = descriptor.value;
  }

  return record;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value);

  return (
    keys.length === expected.length &&
    keys.every((key) =>
      expected.includes(key)
    )
  );
}

function hasAllowedExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[]
): boolean {
  const allowed = new Set([
    ...required,
    ...optional
  ]);
  const keys = Object.keys(value);

  return (
    required.every((key) =>
      Object.hasOwn(value, key)
    ) &&
    keys.every((key) => allowed.has(key))
  );
}

function invalidIndex():
  GitHubDeliveryIndexError {
  return deliveryIndexError(
    "GITHUB_DELIVERY_INDEX_INVALID",
    "GitHub delivery index is invalid."
  );
}

export class GitHubDeliveryIndexError
  extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name =
      "GitHubDeliveryIndexError";
    this.code = code;
  }
}

function deliveryIndexError(
  code: string,
  message: string
): GitHubDeliveryIndexError {
  return new GitHubDeliveryIndexError(
    code,
    message
  );
}
