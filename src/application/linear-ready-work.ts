import type {
  ImportActor,
  ImportReceipt
} from "./import-batch.ts";
import type {
  ImportPlan
} from "./import-plan.ts";
import {
  previewSnapshotImport
} from "./snapshot-import.ts";
import type {
  SnapshotImportApplyOptions,
  SnapshotImportApplyResult,
  ImportReceiptContext
} from "./taskseal-service.ts";
import {
  digestCanonicalJson
} from "../lib/canonical-json.ts";
import type {
  Workflow
} from "../domain/workflow.ts";
import {
  normalizeLinearIssueFact
} from "../connectors/linear.ts";
import type {
  LinearDependencyIndexPort
} from "../connectors/linear-dependency-index.ts";
import type {
  ResolvedLinearReadyWorkScope
} from "../connectors/linear-bootstrap-scope.ts";
import type {
  LinearReadyWorkIssue,
  LinearReadyWorkIssueState
} from "../connectors/linear-ready-work-reader.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN =
  /^sha256:[0-9a-f]{64}$/;
const MAXIMUM_EVIDENCE_KEYS = 64;
const MAXIMUM_DEPENDENCIES = 50;

export interface LinearReadyWorkReadPort {
  listIssues():
    | readonly LinearReadyWorkIssue[]
    | Promise<readonly LinearReadyWorkIssue[]>;
  readIssueStates(
    issueIds: readonly string[]
  ):
    | readonly LinearReadyWorkIssueState[]
    | Promise<
        readonly LinearReadyWorkIssueState[]
      >;
}

export interface LinearReadyWorkWorkflowPort {
  getWorkflow(): Workflow;
}

export interface LinearReadyWorkImportPort {
  getImportReceiptContext(options: {
    readonly planDigest: string;
  }): ImportReceiptContext | null;
  applySnapshotImport(
    options: SnapshotImportApplyOptions
  ): Promise<SnapshotImportApplyResult>;
}

export interface LinearReadyWorkCandidate {
  readonly issueId: string;
  readonly identifier: string;
  readonly title: string;
  readonly url: string;
  readonly readiness:
    | "ready"
    | "blocked"
    | "unknown";
  readonly dependencyIssueIds:
    readonly string[];
  readonly blockingIssueIds:
    readonly string[];
  readonly source: LinearReadyWorkIssue;
}

export type LinearReadyWorkSelectionPreview =
  | {
      readonly kind: "plan";
      readonly candidate:
        LinearReadyWorkCandidate;
      readonly plan: ImportPlan;
    }
  | {
      readonly kind: "already_linked";
      readonly candidate:
        LinearReadyWorkCandidate;
      readonly workItemId: string;
      readonly snapshotDigest: string;
      readonly mappingDigest: string;
    };

export type LinearReadyWorkSelectionApplyResult =
  | {
      readonly kind: "applied";
      readonly candidate:
        LinearReadyWorkCandidate;
      readonly workItemId: string;
      readonly resolution:
        | "committed"
        | "idempotent";
      readonly receipt:
        SnapshotImportApplyResult["receipt"];
    }
  | LinearReadyWorkReceiptRetry;

export interface LinearReadyWorkReceiptRetry {
  readonly kind: "receipt";
  readonly issueId: string;
  readonly workItemId: string;
  readonly resolution: "idempotent";
  readonly receipt: ImportReceipt;
}

interface LinearReadyWorkCoordinatorOptions {
  readonly scope: ResolvedLinearReadyWorkScope;
  readonly reader: LinearReadyWorkReadPort;
  readonly dependencyIndex:
    LinearDependencyIndexPort;
  readonly workflow:
    LinearReadyWorkWorkflowPort;
  readonly imports: LinearReadyWorkImportPort;
  readonly importPolicy: unknown;
  readonly clock?: () => unknown;
}

interface ListLinearReadyWorkCandidatesOptions {
  readonly scope: ResolvedLinearReadyWorkScope;
  readonly reader: LinearReadyWorkReadPort;
  readonly dependencyIndex:
    LinearDependencyIndexPort;
}

interface SelectionOptions {
  readonly issueId: string;
  readonly workItemId: string;
  readonly requiredEvidence:
    readonly string[];
}

interface ApplySelectionOptions
  extends SelectionOptions {
  readonly expectedPlanDigest: string;
  readonly actor: ImportActor;
}

export class LinearReadyWorkCoordinator {
  readonly #scope: ResolvedLinearReadyWorkScope;
  readonly #reader: LinearReadyWorkReadPort;
  readonly #dependencyIndex:
    LinearDependencyIndexPort;
  readonly #workflow:
    LinearReadyWorkWorkflowPort;
  readonly #imports: LinearReadyWorkImportPort;
  readonly #importPolicy: unknown;
  readonly #clock: () => unknown;

  constructor({
    scope,
    reader,
    dependencyIndex,
    workflow,
    imports,
    importPolicy,
    clock = () => new Date()
  }: LinearReadyWorkCoordinatorOptions) {
    this.#scope = structuredClone(scope);
    this.#reader = reader;
    this.#dependencyIndex =
      dependencyIndex;
    this.#workflow = workflow;
    this.#imports = imports;
    this.#importPolicy =
      structuredClone(importPolicy);
    this.#clock = clock;
  }

  async list(): Promise<
    readonly LinearReadyWorkCandidate[]
  > {
    return listLinearReadyWorkCandidates({
      scope: this.#scope,
      reader: this.#reader,
      dependencyIndex: this.#dependencyIndex
    });
  }

  async previewSelection(
    optionsValue: SelectionOptions
  ): Promise<LinearReadyWorkSelectionPreview> {
    const options =
      normalizeSelectionOptions(optionsValue);
    const candidates = await this.list();
    const candidate = candidates.find(
      (value) =>
        value.issueId === options.issueId
    );

    if (candidate === undefined) {
      throw readyError(
        "LINEAR_READY_SELECTION_NOT_FOUND",
        "The selected Linear issue is not in the configured ready-work scope."
      );
    }

    assertCandidateReady(candidate);
    const fact = normalizeLinearIssueFact(
      candidate.source,
      {
        workItemId: options.workItemId,
        requiredEvidence:
          options.requiredEvidence
      }
    );
    const workflow =
      this.#workflow.getWorkflow();
    const existing = findProviderOwner(
      workflow,
      `linear:issue:${candidate.issueId}`
    );

    if (
      existing.length > 1 ||
      (
        existing.length === 1 &&
        existing[0]?.workItemId !==
          options.workItemId
      )
    ) {
      throw readyError(
        "LINEAR_READY_MAPPING_CONFLICT",
        "The selected Linear issue is already mapped to a different local WorkItem."
      );
    }

    const owner = existing[0];
    const snapshot = {
      schemaVersion: 2 as const,
      mode: "read-only" as const,
      provider: "linear" as const,
      scope: {
        kind: "team" as const,
        key:
          `linear:team:${this.#scope.teamId}`,
        parentKey:
          `linear:organization:${this.#scope.organizationId}`
      },
      mapping: {
        workItemId: options.workItemId,
        requiredEvidence: [
          ...options.requiredEvidence
        ],
        managedFields: ["title" as const]
      },
      capturedAt: this.currentTimestamp(),
      facts: [fact] as const
    };
    const plan = previewSnapshotImport({
      snapshot,
      workflow,
      importPolicy: this.#importPolicy
    });

    if (
      owner !== undefined &&
      owner.link.legacy !== true &&
      owner.link.provider === "linear" &&
      owner.link.objectType === "issue" &&
      owner.link.externalId ===
        candidate.issueId &&
      owner.link.scopeRef.kind === "team" &&
      owner.link.scopeRef.key ===
        `linear:team:${this.#scope.teamId}` &&
      owner.link.scopeRef.parentKey ===
        `linear:organization:${this.#scope.organizationId}` &&
      sameStringSet(
        owner.link.managedFields,
        ["title"]
      ) &&
      sameStringSet(
        owner.requiredEvidence,
        options.requiredEvidence
      ) &&
      owner.link.lastObservation.revisionId ===
        fact.revision.id &&
      owner.link.lastObservation.contentDigest ===
        fact.revision.contentDigest &&
      owner.link.lastObservation.title ===
        fact.observed.title
    ) {
      return Object.freeze({
        kind: "already_linked",
        candidate,
        workItemId: owner.workItemId,
        snapshotDigest:
          plan.snapshotDigest,
        mappingDigest:
          plan.mappingDigest
      });
    }

    return Object.freeze({
      kind: "plan",
      candidate,
      plan
    });
  }

  async applySelection(
    optionsValue: ApplySelectionOptions
  ): Promise<LinearReadyWorkSelectionApplyResult> {
    const options =
      normalizeApplySelectionOptions(
        optionsValue
      );
    const retry =
      findLinearReadyWorkReceiptRetry({
        selection: options,
        workflow: this.#workflow,
        imports: this.#imports
      });

    if (retry !== null) {
      return retry;
    }

    const preview =
      await this.previewSelection(options);

    if (preview.kind === "already_linked") {
      throw readyPlanStale();
    }

    if (
      preview.plan.planDigest !==
      options.expectedPlanDigest
    ) {
      throw readyError(
        "LINEAR_READY_PLAN_STALE",
        "The Linear ready-work import plan changed after review."
      );
    }

    const result =
      await this.#imports.applySnapshotImport({
        plan: preview.plan,
        expectedPlanDigest:
          options.expectedPlanDigest,
        actor: options.actor
      });

    return Object.freeze({
      kind: "applied",
      candidate: preview.candidate,
      workItemId: options.workItemId,
      resolution: result.resolution,
      receipt: result.receipt
    });
  }

  private currentTimestamp(): string {
    const value = this.#clock();

    if (
      !(value instanceof Date) ||
      !Number.isFinite(value.getTime())
    ) {
      throw readyError(
        "LINEAR_READY_CLOCK_INVALID",
        "Linear ready-work clock returned an invalid timestamp."
      );
    }

    return value.toISOString();
  }
}

export function findLinearReadyWorkReceiptRetry({
  selection: selectionValue,
  workflow,
  imports
}: {
  readonly selection: ApplySelectionOptions;
  readonly workflow:
    LinearReadyWorkWorkflowPort;
  readonly imports: LinearReadyWorkImportPort;
}): LinearReadyWorkReceiptRetry | null {
  const selection =
    normalizeApplySelectionOptions(
      selectionValue
    );
  const context =
    imports.getImportReceiptContext({
      planDigest:
        selection.expectedPlanDigest
    });

  if (context === null) {
    return null;
  }

  const state = workflow.getWorkflow();
  const workItem =
    state.workItems[selection.workItemId];
  const providerObjectKey =
    `linear:issue:${selection.issueId}`;
  const link = workItem?.externalLinks.find(
    (value) =>
      value.providerObjectKey ===
      providerObjectKey
  );
  const binding = context.policyBinding;
  const expectedMappingDigest =
    digestCanonicalJson({
      workItemId: selection.workItemId,
      requiredEvidence: [
        ...selection.requiredEvidence
      ],
      managedFields: ["title"]
    });

  if (
    context.receipt.planDigest !==
      selection.expectedPlanDigest ||
    context.receipt.mappingDigest !==
      expectedMappingDigest ||
    binding.schemaVersion !== 1 ||
    binding.capability !==
      "snapshot.import.apply" ||
    binding.applyAllowed !== true ||
    binding.provider !== "linear" ||
    binding.scopeRef.kind !== "team" ||
    binding.requiredObjectTypes.length !==
      1 ||
    binding.requiredObjectTypes[0] !==
      "issue" ||
    context.actions.length === 0 ||
    context.actions.some(
      (action) =>
        action.workItemId !==
          selection.workItemId ||
        action.sourceObjectKey !==
          providerObjectKey
    ) ||
    workItem === undefined ||
    !sameStringSet(
      workItem.requiredEvidence,
      selection.requiredEvidence
    ) ||
    link === undefined ||
    link.legacy === true ||
    link.provider !== "linear" ||
    link.objectType !== "issue" ||
    link.externalId !== selection.issueId ||
    link.scopeRef.kind !== "team" ||
    link.scopeRef.key !==
      binding.scopeRef.key ||
    link.scopeRef.parentKey !==
      binding.scopeRef.parentKey ||
    !sameStringSet(
      link.managedFields,
      ["title"]
    )
  ) {
    throw readyPlanStale();
  }

  return Object.freeze({
    kind: "receipt",
    issueId: selection.issueId,
    workItemId: selection.workItemId,
    resolution: "idempotent",
    receipt: structuredClone(
      context.receipt
    )
  });
}

export async function listLinearReadyWorkCandidates({
  scope,
  reader,
  dependencyIndex
}: ListLinearReadyWorkCandidatesOptions): Promise<
  readonly LinearReadyWorkCandidate[]
> {
  assertDependencyIndexScope(
    scope,
    dependencyIndex
  );
  const issues = await reader.listIssues();
  const normalizedIssues = normalizeIssues(issues);
  const dependenciesByIssue =
    new Map<
      string,
      {
        readonly completeness:
          | "complete"
          | "unknown";
        readonly issueIds:
          readonly string[];
      }
    >();
  const allDependencyIds = new Set<string>();

  for (const issue of normalizedIssues) {
    const declared =
      dependencyIndex.dependenciesOf(issue.id);
    const declaredIds =
      normalizeDependencyIds(
        declared.issueIds
      );
    const nativeIds =
      normalizeDependencyIds(
        issue.blockedByIssueIds
      );

    if (
      ![
        "complete",
        "unknown",
        "unindexed"
      ].includes(declared.completeness) ||
      (
        declared.completeness ===
          "unindexed" &&
        declaredIds.length !== 0
      )
    ) {
      throw readyDataInvalid();
    }

    const issueIds = [
      ...new Set([
        ...declaredIds,
        ...nativeIds
      ])
    ].sort();

    if (
      issueIds.length > MAXIMUM_DEPENDENCIES
    ) {
      throw readyError(
        "LINEAR_READY_DEPENDENCY_LIMIT",
        "Linear ready-work dependency count exceeds the safety limit."
      );
    }

    for (const issueId of issueIds) {
      allDependencyIds.add(issueId);
    }

    dependenciesByIssue.set(issue.id, {
      completeness:
        issue.dependencyCompleteness ===
          "complete" &&
        declared.completeness !== "unknown"
          ? "complete"
          : "unknown",
      issueIds
    });
  }

  if (
    allDependencyIds.size >
    MAXIMUM_DEPENDENCIES
  ) {
    throw readyError(
      "LINEAR_READY_DEPENDENCY_LIMIT",
      "Linear ready-work dependency read exceeds the safety limit."
    );
  }

  const states = await reader.readIssueStates(
    [...allDependencyIds].sort()
  );
  const stateByIssueId =
    normalizeStates(states);

  return Object.freeze(
    normalizedIssues.map((issue) => {
      const dependency =
        dependenciesByIssue.get(issue.id);

      if (dependency === undefined) {
        throw readyError(
          "LINEAR_READY_DEPENDENCY_UNKNOWN",
          "Linear ready-work dependency data is incomplete."
        );
      }

      let hasMissingState = false;
      const blockingIssueIds: string[] = [];

      for (
        const dependencyIssueId of
          dependency.issueIds
      ) {
        const state = stateByIssueId.get(
          dependencyIssueId
        );

        if (state === undefined) {
          hasMissingState = true;
          continue;
        }

        if (
          state.stateId !==
            scope.completedStateId ||
          state.stateType !== "completed"
        ) {
          blockingIssueIds.push(
            dependencyIssueId
          );
        }
      }

      const readiness =
        dependency.completeness ===
          "unknown" ||
        hasMissingState
          ? "unknown"
          : blockingIssueIds.length > 0
            ? "blocked"
            : "ready";

      return freezeCandidate({
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        readiness,
        dependencyIssueIds:
          dependency.issueIds,
        blockingIssueIds:
          blockingIssueIds.sort(),
        source: issue
      });
    })
  );
}

function assertDependencyIndexScope(
  scope: ResolvedLinearReadyWorkScope,
  dependencyIndex:
    LinearDependencyIndexPort
): void {
  if (
    dependencyIndex.target.organizationId !==
      scope.organizationId ||
    dependencyIndex.target.teamId !==
      scope.teamId ||
    dependencyIndex.target.projectId !==
      scope.projectId
  ) {
    throw readyError(
      "LINEAR_READY_DEPENDENCY_SCOPE_MISMATCH",
      "Linear dependency index does not match the configured ready-work scope."
    );
  }
}

function normalizeIssues(
  values: readonly LinearReadyWorkIssue[]
): readonly LinearReadyWorkIssue[] {
  if (!Array.isArray(values)) {
    throw readyDataInvalid();
  }

  const byId =
    new Map<string, LinearReadyWorkIssue>();

  for (const value of values) {
    if (
      value === null ||
      typeof value !== "object"
    ) {
      throw readyDataInvalid();
    }

    const id = parseUuid(value.id);
    const existing = byId.get(id);
    const normalized: LinearReadyWorkIssue = {
      id,
      identifier: parseText(
        value.identifier
      ),
      title: parseText(value.title),
      url: parseText(value.url),
      createdAt: parseTimestamp(
        value.createdAt
      ),
      updatedAt: parseTimestamp(
        value.updatedAt
      ),
      blockedByIssueIds:
        normalizeDependencyIds(
          value.blockedByIssueIds
        ),
      dependencyCompleteness:
        value.dependencyCompleteness ===
          "complete" ||
        value.dependencyCompleteness ===
          "unknown"
          ? value.dependencyCompleteness
          : (() => {
              throw readyDataInvalid();
            })()
    };

    if (
      existing !== undefined &&
      JSON.stringify(existing) !==
        JSON.stringify(normalized)
    ) {
      throw readyDataInvalid();
    }

    byId.set(id, normalized);
  }

  return [...byId.values()].sort(
    (left, right) =>
      left.id.localeCompare(right.id)
  );
}

function normalizeStates(
  values:
    readonly LinearReadyWorkIssueState[]
): ReadonlyMap<
  string,
  LinearReadyWorkIssueState
> {
  if (!Array.isArray(values)) {
    throw readyDataInvalid();
  }

  const byId =
    new Map<
      string,
      LinearReadyWorkIssueState
    >();

  for (const value of values) {
    if (
      value === null ||
      typeof value !== "object"
    ) {
      throw readyDataInvalid();
    }

    const normalized = {
      issueId: parseUuid(value.issueId),
      stateId: parseUuid(value.stateId),
      stateType: parseText(
        value.stateType
      )
    };
    const existing = byId.get(
      normalized.issueId
    );

    if (
      existing !== undefined &&
      JSON.stringify(existing) !==
        JSON.stringify(normalized)
    ) {
      throw readyDataInvalid();
    }

    byId.set(normalized.issueId, normalized);
  }

  return byId;
}

function normalizeSelectionOptions(
  value: SelectionOptions
): {
  readonly issueId: string;
  readonly workItemId: string;
  readonly requiredEvidence:
    readonly string[];
} {
  if (
    value === null ||
    typeof value !== "object"
  ) {
    throw readyInputInvalid();
  }

  const requiredEvidence =
    normalizeEvidence(value.requiredEvidence);

  return {
    issueId: parseInputUuid(value.issueId),
    workItemId: parseInputText(
      value.workItemId
    ),
    requiredEvidence
  };
}

function normalizeApplySelectionOptions(
  value: ApplySelectionOptions
): ApplySelectionOptions {
  const selection =
    normalizeSelectionOptions(value);

  if (
    typeof value.expectedPlanDigest !==
      "string" ||
    !DIGEST_PATTERN.test(
      value.expectedPlanDigest
    ) ||
    value.actor === null ||
    typeof value.actor !== "object"
  ) {
    throw readyInputInvalid();
  }

  return {
    ...selection,
    expectedPlanDigest:
      value.expectedPlanDigest,
    actor: structuredClone(value.actor)
  };
}

function normalizeEvidence(
  value: readonly string[]
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAXIMUM_EVIDENCE_KEYS
  ) {
    throw readyInputInvalid();
  }

  const normalized = value.map(
    parseInputText
  );

  if (
    new Set(normalized).size !==
    normalized.length
  ) {
    throw readyInputInvalid();
  }

  return Object.freeze(
    [...normalized].sort()
  );
}

function normalizeDependencyIds(
  value: readonly string[]
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAXIMUM_DEPENDENCIES
  ) {
    throw readyDataInvalid();
  }

  const ids = value.map(parseUuid);

  if (new Set(ids).size !== ids.length) {
    throw readyDataInvalid();
  }

  return Object.freeze(ids.sort());
}

function findProviderOwner(
  workflow: Workflow,
  providerObjectKey: string
): Array<{
  readonly workItemId: string;
  readonly requiredEvidence:
    readonly string[];
  readonly link: Workflow["workItems"][string]["externalLinks"][number];
}> {
  return Object.values(workflow.workItems)
    .flatMap((workItem) =>
      workItem.externalLinks
        .filter(
          (link) =>
            link.providerObjectKey ===
            providerObjectKey
        )
        .map((link) => ({
          workItemId: workItem.id,
          requiredEvidence:
            workItem.requiredEvidence,
          link
        }))
    );
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();

  return normalizedLeft.every(
    (value, index) =>
      value === normalizedRight[index]
  );
}

function assertCandidateReady(
  candidate: LinearReadyWorkCandidate
): void {
  if (candidate.readiness === "blocked") {
    throw readyError(
      "LINEAR_READY_DEPENDENCY_BLOCKED",
      "The selected Linear issue has incomplete dependencies."
    );
  }

  if (candidate.readiness === "unknown") {
    throw readyError(
      "LINEAR_READY_DEPENDENCY_UNKNOWN",
      "The selected Linear issue dependency status is incomplete."
    );
  }
}

function freezeCandidate(
  value: LinearReadyWorkCandidate
): LinearReadyWorkCandidate {
  return Object.freeze({
    ...value,
    dependencyIssueIds: Object.freeze([
      ...value.dependencyIssueIds
    ]),
    blockingIssueIds: Object.freeze([
      ...value.blockingIssueIds
    ]),
    source: Object.freeze({
      ...value.source,
      blockedByIssueIds: Object.freeze([
        ...value.source.blockedByIssueIds
      ])
    })
  });
}

function parseInputUuid(value: unknown): string {
  try {
    return parseUuid(value);
  } catch {
    throw readyInputInvalid();
  }
}

function parseUuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    throw readyDataInvalid();
  }

  return value.toLowerCase();
}

function parseInputText(value: unknown): string {
  try {
    return parseText(value);
  } catch {
    throw readyInputInvalid();
  }
}

function parseText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !value.isWellFormed() ||
    [...value].length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw readyDataInvalid();
  }

  return value;
}

function parseTimestamp(value: unknown): string {
  const timestamp = parseText(value);

  if (!Number.isFinite(Date.parse(timestamp))) {
    throw readyDataInvalid();
  }

  return timestamp;
}

function readyInputInvalid():
  LinearReadyWorkError {
  return readyError(
    "LINEAR_READY_INPUT_INVALID",
    "Linear ready-work selection input is invalid."
  );
}

function readyDataInvalid():
  LinearReadyWorkError {
  return readyError(
    "LINEAR_READY_DATA_INVALID",
    "Linear ready-work data is invalid."
  );
}

function readyPlanStale():
  LinearReadyWorkError {
  return readyError(
    "LINEAR_READY_PLAN_STALE",
    "The Linear ready-work import plan changed after review."
  );
}

export class LinearReadyWorkError
  extends Error
{
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LinearReadyWorkError";
    this.code = code;
  }
}

function readyError(
  code: string,
  message: string
): LinearReadyWorkError {
  return new LinearReadyWorkError(
    code,
    message
  );
}
