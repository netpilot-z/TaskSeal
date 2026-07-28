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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAXIMUM_ENTRIES = 200;
const MAXIMUM_RELATIONS = 500;
const MAXIMUM_DEPENDENCIES = 32;
const MAXIMUM_INDEX_BYTES = 512 * 1024;

export interface LinearDependencyResolution {
  readonly completeness:
    | "complete"
    | "unknown"
    | "unindexed";
  readonly issueIds: readonly string[];
}

export interface LinearDependencyIndexPort {
  readonly target: {
    readonly organizationId: string;
    readonly teamId: string;
    readonly projectId: string;
    readonly stateId: string;
  };
  dependenciesOf(
    issueId: string
  ): LinearDependencyResolution;
}

interface ParsedEntry {
  readonly sourceTicket: string;
  readonly issueId: string;
  readonly dependsOnTickets: readonly string[];
}

interface ParsedRelation {
  readonly relationId: string;
  readonly blockingTicket: string;
  readonly blockedTicket: string;
  readonly issueId: string;
  readonly relatedIssueId: string;
}

export async function readLinearDependencyIndex({
  workspaceRoot,
  repositoryPath
}: {
  readonly workspaceRoot: string;
  readonly repositoryPath: string;
}): Promise<LinearDependencyIndexPort> {
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
        LinearDependencyIndexError
    ) {
      throw error;
    }

    throw dependencyError(
      "LINEAR_DEPENDENCY_INDEX_READ_FAILED",
      "TaskSeal could not read the Linear dependency index."
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidIndex();
  }

  return parseLinearDependencyIndex(parsed);
}

export function parseLinearDependencyIndex(
  value: unknown
): LinearDependencyIndexPort {
  try {
    return parseLinearDependencyIndexUnsafe(value);
  } catch (error) {
    if (
      error instanceof LinearDependencyIndexError
    ) {
      throw error;
    }

    throw invalidIndex();
  }
}

function parseLinearDependencyIndexUnsafe(
  value: unknown
): LinearDependencyIndexPort {
  const root = readDataRecord(value);

  if (
    root.schemaVersion !== 1 ||
    root.provider !== "linear" ||
    !Array.isArray(root.entries) ||
    root.entries.length === 0 ||
    root.entries.length > MAXIMUM_ENTRIES ||
    !Array.isArray(root.relations) ||
    root.relations.length > MAXIMUM_RELATIONS
  ) {
    throw invalidIndex();
  }

  const entries = root.entries.map(parseEntry);
  const relations =
    root.relations.map(parseRelation);
  const target = parseTarget(root.target);
  const entryByTicket =
    new Map<string, ParsedEntry>();
  const entryByIssueId =
    new Map<string, ParsedEntry>();

  for (const entry of entries) {
    if (
      entryByTicket.has(entry.sourceTicket) ||
      entryByIssueId.has(entry.issueId)
    ) {
      throw invalidIndex();
    }

    entryByTicket.set(
      entry.sourceTicket,
      entry
    );
    entryByIssueId.set(entry.issueId, entry);
  }

  const relationByPair =
    new Map<string, ParsedRelation>();
  const relationIds = new Set<string>();

  for (const relation of relations) {
    const blocker = entryByTicket.get(
      relation.blockingTicket
    );
    const blocked = entryByTicket.get(
      relation.blockedTicket
    );

    if (
      blocker === undefined ||
      blocked === undefined ||
      blocker.issueId !== relation.issueId ||
      blocked.issueId !==
        relation.relatedIssueId
    ) {
      throw invalidIndex();
    }

    const pair = dependencyPair(
      relation.blockingTicket,
      relation.blockedTicket
    );

    if (
      relationByPair.has(pair) ||
      relationIds.has(relation.relationId)
    ) {
      throw invalidIndex();
    }

    relationByPair.set(pair, relation);
    relationIds.add(relation.relationId);
  }

  for (const relation of relations) {
    const blocked = entryByTicket.get(
      relation.blockedTicket
    );

    if (
      blocked === undefined ||
      !blocked.dependsOnTickets.includes(
        relation.blockingTicket
      )
    ) {
      throw invalidIndex();
    }
  }

  const byIssueId =
    new Map<
      string,
      LinearDependencyResolution
    >();

  for (const entry of entries) {
    let completeness:
      | "complete"
      | "unknown" = "complete";
    const dependencyIds = new Set<string>();

    for (
      const dependencyTicket of
        entry.dependsOnTickets
    ) {
      const dependency =
        entryByTicket.get(dependencyTicket);
      const relation = relationByPair.get(
        dependencyPair(
          dependencyTicket,
          entry.sourceTicket
        )
      );

      if (
        dependency === undefined ||
        relation === undefined
      ) {
        completeness = "unknown";
        continue;
      }

      dependencyIds.add(dependency.issueId);
    }

    byIssueId.set(
      entry.issueId,
      freezeResolution({
        completeness,
        issueIds: [...dependencyIds].sort()
      })
    );
  }

  return Object.freeze({
    target,
    dependenciesOf(
      issueId: string
    ): LinearDependencyResolution {
      const normalized = parseUuid(issueId);
      return (
        byIssueId.get(normalized) ??
        freezeResolution({
          completeness: "unindexed",
          issueIds: []
        })
      );
    }
  });
}

function parseTarget(value: unknown): {
  readonly organizationId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly stateId: string;
} {
  const target = readDataRecord(value);

  if (
    !hasExactKeys(target, [
      "organizationId",
      "teamId",
      "projectId",
      "stateId"
    ])
  ) {
    throw invalidIndex();
  }

  return Object.freeze({
    organizationId: parseUuid(
      target.organizationId
    ),
    teamId: parseUuid(target.teamId),
    projectId: parseUuid(
      target.projectId
    ),
    stateId: parseUuid(target.stateId)
  });
}

function parseEntry(value: unknown): ParsedEntry {
  const entry = readDataRecord(value);
  const linearIssue = readDataRecord(
    entry.linearIssue
  );
  const sourceTicket = parseTicket(
    entry.sourceTicket
  );

  if (
    !Array.isArray(entry.dependsOnTickets) ||
    entry.dependsOnTickets.length >
      MAXIMUM_DEPENDENCIES
  ) {
    throw invalidIndex();
  }

  const dependsOnTickets =
    entry.dependsOnTickets.map(parseTicket);

  if (
    new Set(dependsOnTickets).size !==
      dependsOnTickets.length ||
    dependsOnTickets.includes(sourceTicket)
  ) {
    throw invalidIndex();
  }

  return {
    sourceTicket,
    issueId: parseUuid(linearIssue.id),
    dependsOnTickets: Object.freeze([
      ...dependsOnTickets
    ])
  };
}

function parseRelation(
  value: unknown
): ParsedRelation {
  const relation = readDataRecord(value);

  if (relation.type !== "blocks") {
    throw invalidIndex();
  }

  return {
    relationId: parseUuid(
      relation.clientRequestId
    ),
    blockingTicket: parseTicket(
      relation.blockingTicket
    ),
    blockedTicket: parseTicket(
      relation.blockedTicket
    ),
    issueId: parseUuid(relation.issueId),
    relatedIssueId: parseUuid(
      relation.relatedIssueId
    )
  };
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
    throw dependencyError(
      "LINEAR_DEPENDENCY_INDEX_LIMIT_EXCEEDED",
      "Linear dependency index exceeds the safety limit."
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

function dependencyPair(
  blockingTicket: string,
  blockedTicket: string
): string {
  return `${blockingTicket}\u0000${blockedTicket}`;
}

function freezeResolution(
  value: LinearDependencyResolution
): LinearDependencyResolution {
  return Object.freeze({
    completeness: value.completeness,
    issueIds: Object.freeze([
      ...value.issueIds
    ])
  });
}

function parseTicket(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^T[1-9][0-9]*(?:\.[1-9][0-9]*)?$/.test(
      value
    )
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

function invalidIndex():
  LinearDependencyIndexError {
  return dependencyError(
    "LINEAR_DEPENDENCY_INDEX_INVALID",
    "Linear dependency index is invalid."
  );
}

export class LinearDependencyIndexError
  extends Error
{
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LinearDependencyIndexError";
    this.code = code;
  }
}

function dependencyError(
  code: string,
  message: string
): LinearDependencyIndexError {
  return new LinearDependencyIndexError(
    code,
    message
  );
}
