import { projectDashboard } from "../dashboard/projection.ts";
import {
  applyEvent,
  classifyProcessedEvent,
  createWorkflow
} from "../domain/workflow.ts";
import type { DashboardProjection } from "../dashboard/projection.ts";
import type {
  AttemptStartedEvent,
  CanonicalEvent,
  Workflow,
  WorkItem
} from "../domain/workflow.ts";
import {
  createImportBatchRecord,
  validateImportBatchRecord,
  validateImportPlanForApply
} from "./import-batch.ts";
import type {
  ImportBatchRecord,
  ImportReceipt
} from "./import-batch.ts";
import {
  computeBaseWorkflowDigest
} from "./import-plan.ts";
import type {
  ImportPlan
} from "./import-plan.ts";
import {
  buildPolicyBinding,
  normalizeImportPolicy
} from "./import-policy.ts";
import type {
  BoundImportPolicy,
  PolicyBinding
} from "./import-policy.ts";
import {
  DEFAULT_PROVIDER_INGRESS_REGISTRY,
  authorizeProviderIngress,
  authorizeProviderIngressFact
} from "./provider-ingress-registry.ts";
import type {
  ProviderIngressRegistry
} from "./provider-ingress-registry.ts";
import {
  collectProviderFactProvenanceClaims,
  verifyProviderFactProvenance
} from "./provider-fact-provenance.ts";
import type {
  ProviderFactProvenanceVerifier
} from "./provider-fact-provenance.ts";

export interface EventJournal {
  readAll(): Promise<unknown[]>;
  append(event: CanonicalEvent): Promise<void>;
  commitBatch?(record: ImportBatchRecord): Promise<void>;
}

export interface TaskSealServiceOpenOptions {
  journal: EventJournal;
  importPolicyProvider?: () => unknown | Promise<unknown>;
  providerIngressRegistry?: ProviderIngressRegistry;
  providerFactProvenanceVerifier?:
    | ProviderFactProvenanceVerifier
    | undefined;
  clock?: () => unknown;
}

interface TaskSealServiceState {
  workflow: Workflow;
  receiptsByPlanDigest: Map<string, ImportReceipt>;
  batchesById: Map<string, string>;
}

interface TaskSealServiceConstructorOptions {
  journal: EventJournal;
  workflow: Workflow;
  receiptsByPlanDigest?:
    | Map<string, ImportReceipt>
    | undefined;
  batchesById?: Map<string, string> | undefined;
  importPolicyProvider?:
    | (() => unknown | Promise<unknown>)
    | undefined;
  providerIngressRegistry: ProviderIngressRegistry;
  providerFactProvenanceVerifier?:
    | ProviderFactProvenanceVerifier
    | undefined;
  clock?: (() => unknown) | undefined;
}

export interface SnapshotImportApplyOptions {
  plan: unknown;
  expectedPlanDigest: unknown;
  actor: unknown;
}

export interface SnapshotImportApplyResult {
  receipt: ImportReceipt;
  resolution: "committed" | "idempotent";
}

export type TaskSealServiceHealth =
  | {
      status: "ready";
    }
  | {
      status: "fenced";
      code:
        | "IMPORT_COMMIT_OUTCOME_UNKNOWN"
        | "JOURNAL_COMMIT_OUTCOME_UNKNOWN";
      planDigest: string | null;
    };

type FencedServiceHealth = Extract<
  TaskSealServiceHealth,
  { status: "fenced" }
>;

interface ImportReceiptQuery {
  planDigest: string;
}

interface RecoverRunningAttemptsOptions {
  occurredAt?: string;
}

export class TaskSealService {
  static async open({
    journal,
    importPolicyProvider,
    providerIngressRegistry =
      DEFAULT_PROVIDER_INGRESS_REGISTRY,
    providerFactProvenanceVerifier,
    clock = () => new Date()
  }: TaskSealServiceOpenOptions): Promise<TaskSealService> {
    const records = await journal.readAll();
    let workflow = createWorkflow();
    const receiptsByPlanDigest =
      new Map<string, ImportReceipt>();
    const batchesById = new Map<string, string>();

    for (const [index, record] of records.entries()) {
      try {
        if (
          isRecord(record) &&
          record.recordType === "import.batch"
        ) {
          const validated =
            validateImportBatchRecord(record);
          const seenDigest = batchesById.get(
            validated.record.batchId
          );

          if (seenDigest) {
            if (seenDigest !== validated.recordDigest) {
              throw new TaskSealServiceError(
                "JOURNAL_CORRUPT",
                "TaskSeal journal reuses an import batch ID with different content."
              );
            }

            continue;
          }

          if (
            computeBaseWorkflowDigest(workflow) !==
            validated.record.baseWorkflowDigest
          ) {
            throw new TaskSealServiceError(
              "JOURNAL_CORRUPT",
              "TaskSeal import batch does not match the workflow state at its journal position."
            );
          }

          let candidate = workflow;

          for (const event of validated.record.events) {
            candidate = applyEvent(candidate, event);
          }

          workflow = candidate;
          batchesById.set(
            validated.record.batchId,
            validated.recordDigest
          );
          receiptsByPlanDigest.set(
            validated.record.planDigest,
            validated.receipt
          );
        } else {
          workflow = applyEvent(workflow, record);
        }
      } catch (error) {
        throw new TaskSealServiceError(
          "JOURNAL_CORRUPT",
          `TaskSeal could not replay event journal line ${index + 1}: ${readErrorMessage(error)}`,
          { cause: error }
        );
      }
    }

    return new TaskSealService({
      journal,
      workflow,
      receiptsByPlanDigest,
      batchesById,
      importPolicyProvider,
      providerIngressRegistry,
      providerFactProvenanceVerifier,
      clock
    });
  }

  #journal: EventJournal;
  #state: TaskSealServiceState;
  #writeQueue: Promise<void>;
  #importPolicyProvider:
    | TaskSealServiceOpenOptions["importPolicyProvider"];
  #providerIngressRegistry: ProviderIngressRegistry;
  #providerFactProvenanceVerifier:
    | ProviderFactProvenanceVerifier
    | undefined;
  #clock: () => unknown;
  #health: TaskSealServiceHealth;

  constructor({
    journal,
    workflow,
    receiptsByPlanDigest = new Map(),
    batchesById = new Map(),
    importPolicyProvider,
    providerIngressRegistry,
    providerFactProvenanceVerifier,
    clock = () => new Date()
  }: TaskSealServiceConstructorOptions) {
    this.#journal = journal;
    this.#state = {
      workflow,
      receiptsByPlanDigest,
      batchesById
    };
    this.#writeQueue = Promise.resolve();
    this.#importPolicyProvider = importPolicyProvider;
    this.#providerIngressRegistry =
      providerIngressRegistry;
    this.#providerFactProvenanceVerifier =
      providerFactProvenanceVerifier;
    this.#clock = clock;
    this.#health = {
      status: "ready"
    };
  }

  append(event: CanonicalEvent): Promise<Workflow> {
    return this.enqueueWrite(() => this.appendNow(event));
  }

  startAttemptIfIdle(
    event: AttemptStartedEvent
  ): Promise<Workflow> {
    return this.enqueueWrite(() => {
      const workItem =
        this.#state.workflow.workItems[event.workItemId];
      const activeAttempt = workItem?.attempts.find(
        (attempt) =>
          attempt.id === workItem.activeAttemptId &&
          attempt.status === "running"
      );

      if (activeAttempt) {
        throw new TaskSealServiceError(
          "ATTEMPT_ALREADY_ACTIVE",
          `TaskSeal work item ${event.workItemId} already has an active attempt.`
        );
      }

      return this.appendNow(event);
    });
  }

  async appendNow(
    event: CanonicalEvent
  ): Promise<Workflow> {
    this.assertAvailable();
    const processed = classifyProcessedEvent(
      this.#state.workflow,
      event
    );

    if (processed === "EXACT_EVENT_DUPLICATE") {
      return structuredClone(this.#state.workflow);
    }

    if (processed === "EVENT_ID_CONFLICT") {
      applyEvent(this.#state.workflow, event);
    }

    assertDirectIngressAllowed(event);
    const candidate = applyEvent(
      this.#state.workflow,
      event
    );

    if (candidate === this.#state.workflow) {
      return structuredClone(this.#state.workflow);
    }

    try {
      await this.#journal.append(event);
    } catch (error) {
      if (
        hasErrorCode(
          error,
          "JOURNAL_COMMIT_OUTCOME_UNKNOWN"
        )
      ) {
        this.fence({
          code: "JOURNAL_COMMIT_OUTCOME_UNKNOWN",
          planDigest: null
        });
        throw new TaskSealServiceError(
          "JOURNAL_COMMIT_OUTCOME_UNKNOWN",
          "TaskSeal cannot confirm the journal append outcome; reopen is required.",
          { cause: error }
        );
      }

      if (
        hasErrorCode(error, "JOURNAL_WRITE_FAILED") ||
        hasErrorCode(
          error,
          "JOURNAL_ATOMIC_COMMIT_UNSUPPORTED"
        )
      ) {
        throw error;
      }

      throw new TaskSealServiceError(
        "JOURNAL_WRITE_FAILED",
        "TaskSeal could not persist the event; in-memory state was not changed.",
        { cause: error }
      );
    }

    this.#state = {
      ...this.#state,
      workflow: candidate
    };
    return structuredClone(candidate);
  }

  applySnapshotImport({
    plan,
    expectedPlanDigest,
    actor
  }: SnapshotImportApplyOptions): Promise<SnapshotImportApplyResult> {
    return this.enqueueWrite(() =>
      this.applySnapshotImportNow({
        plan,
        expectedPlanDigest,
        actor
      })
    );
  }

  async applySnapshotImportNow({
    plan,
    expectedPlanDigest,
    actor
  }: SnapshotImportApplyOptions): Promise<SnapshotImportApplyResult> {
    this.assertAvailable();
    const normalizedPlan = validateImportPlanForApply(
      plan,
      expectedPlanDigest
    );
    const existing =
      this.#state.receiptsByPlanDigest.get(
        normalizedPlan.planDigest
      );

    if (existing) {
      return {
        receipt: structuredClone(existing),
        resolution: "idempotent"
      };
    }

    this.assertProviderIngress(
      normalizedPlan.policyBinding
    );

    const actionByEventId =
      assertImportPlanIngressPreflight({
        plan: normalizedPlan,
        workflow: this.#state.workflow,
        registry: this.#providerIngressRegistry
      });

    const currentBinding =
      await this.readCurrentPolicyBinding(
        normalizedPlan.policyBinding
      );

    if (!currentBinding.policyBinding.applyAllowed) {
      throw new TaskSealServiceError(
        "IMPORT_APPLY_FORBIDDEN",
        "Current ImportPolicy does not allow snapshot apply."
      );
    }

    if (
      currentBinding.policyDigest !==
      normalizedPlan.policyDigest
    ) {
      throw new TaskSealServiceError(
        "IMPORT_POLICY_STALE",
        "ImportPolicy changed after this plan was previewed."
      );
    }

    if (normalizedPlan.conflicts.length > 0) {
      throw new TaskSealServiceError(
        "IMPORT_PLAN_BLOCKED",
        "ImportPlan contains blocking conflicts."
      );
    }

    if (
      computeBaseWorkflowDigest(
        this.#state.workflow
      ) !== normalizedPlan.baseWorkflowDigest
    ) {
      throw new TaskSealServiceError(
        "IMPORT_PLAN_STALE",
        "Workflow changed after this plan was previewed."
      );
    }

    const candidate = projectAuthorizedImportPlan({
      plan: normalizedPlan,
      workflow: this.#state.workflow,
      registry: this.#providerIngressRegistry,
      actionByEventId
    });

    await this.verifyProviderFactProvenance({
      plan: normalizedPlan,
      baseWorkflow: this.#state.workflow
    });

    const record = createImportBatchRecord({
      plan: normalizedPlan,
      actor,
      appliedAt: this.currentTimestamp()
    });
    const validated = validateImportBatchRecord(record);
    const nextReceipts = new Map(
      this.#state.receiptsByPlanDigest
    );
    const nextBatches = new Map(
      this.#state.batchesById
    );
    nextReceipts.set(
      normalizedPlan.planDigest,
      validated.receipt
    );
    nextBatches.set(
      validated.record.batchId,
      validated.recordDigest
    );

    if (
      typeof this.#journal.commitBatch !== "function"
    ) {
      throw new TaskSealServiceError(
        "JOURNAL_ATOMIC_COMMIT_UNSUPPORTED",
        "The configured journal does not support atomic import batches."
      );
    }

    try {
      await this.#journal.commitBatch(validated.record);
    } catch (error) {
      if (
        hasErrorCode(
          error,
          "JOURNAL_COMMIT_OUTCOME_UNKNOWN"
        )
      ) {
        this.fence({
          code: "IMPORT_COMMIT_OUTCOME_UNKNOWN",
          planDigest: normalizedPlan.planDigest
        });
        throw new TaskSealServiceError(
          "IMPORT_COMMIT_OUTCOME_UNKNOWN",
          "TaskSeal cannot confirm the import commit outcome; reopen is required.",
          { cause: error }
        );
      }

      if (
        hasErrorCode(error, "JOURNAL_WRITE_FAILED") ||
        hasErrorCode(
          error,
          "JOURNAL_ATOMIC_COMMIT_UNSUPPORTED"
        )
      ) {
        throw error;
      }

      throw new TaskSealServiceError(
        "JOURNAL_WRITE_FAILED",
        "TaskSeal could not persist the import batch; in-memory state was not changed.",
        { cause: error }
      );
    }

    this.#state = {
      workflow: candidate,
      receiptsByPlanDigest: nextReceipts,
      batchesById: nextBatches
    };

    return {
      receipt: structuredClone(validated.receipt),
      resolution: "committed"
    };
  }

  async readCurrentPolicyBinding(
    plannedBinding: PolicyBinding
  ): Promise<BoundImportPolicy> {
    if (
      typeof this.#importPolicyProvider !== "function"
    ) {
      throw new TaskSealServiceError(
        "IMPORT_POLICY_INVALID",
        "TaskSeal has no trusted ImportPolicy provider."
      );
    }

    let importPolicy: unknown;

    try {
      importPolicy = await this.#importPolicyProvider();
    } catch (error) {
      throw new TaskSealServiceError(
        "IMPORT_POLICY_INVALID",
        "TaskSeal could not read the current ImportPolicy.",
        { cause: error }
      );
    }

    let normalizedPolicy: ReturnType<
      typeof normalizeImportPolicy
    >;

    try {
      normalizedPolicy =
        normalizeImportPolicy(importPolicy);
    } catch (error) {
      throw new TaskSealServiceError(
        "IMPORT_POLICY_INVALID",
        "Current ImportPolicy is invalid.",
        { cause: error }
      );
    }

    try {
      return buildPolicyBinding({
        importPolicy: normalizedPolicy,
        provider: plannedBinding.provider,
        scopeRef: plannedBinding.scopeRef,
        requiredObjectTypes:
          plannedBinding.requiredObjectTypes
      });
    } catch (error) {
      throw new TaskSealServiceError(
        "IMPORT_POLICY_STALE",
        "Current ImportPolicy no longer covers the planned provider scope.",
        { cause: error }
      );
    }
  }

  private async verifyProviderFactProvenance({
    plan,
    baseWorkflow
  }: {
    plan: ImportPlan;
    baseWorkflow: Workflow;
  }): Promise<void> {
    let claims;

    try {
      claims = collectProviderFactProvenanceClaims({
        plan,
        baseWorkflow
      });
    } catch (error) {
      throw new TaskSealServiceError(
        hasErrorCode(
          error,
          "PROVIDER_FACT_PROVENANCE_UNAVAILABLE"
        )
          ? "IMPORT_PROVENANCE_UNAVAILABLE"
          : "IMPORT_PROVENANCE_MISMATCH",
        hasErrorCode(
          error,
          "PROVIDER_FACT_PROVENANCE_UNAVAILABLE"
        )
          ? "TaskSeal could not verify Provider fact provenance."
          : "Provider facts do not match the reviewed import plan."
      );
    }

    try {
      await verifyProviderFactProvenance({
        claims,
        verifier:
          this.#providerFactProvenanceVerifier
      });
    } catch (error) {
      if (
        hasErrorCode(
          error,
          "PROVIDER_FACT_PROVENANCE_MISMATCH"
        )
      ) {
        throw new TaskSealServiceError(
          "IMPORT_PROVENANCE_MISMATCH",
          "Provider facts no longer match the reviewed import plan."
        );
      }

      throw new TaskSealServiceError(
        "IMPORT_PROVENANCE_UNAVAILABLE",
        "TaskSeal could not verify Provider fact provenance."
      );
    }
  }

  private assertProviderIngress(
    binding: PolicyBinding
  ): void {
    try {
      authorizeProviderIngress({
        registry: this.#providerIngressRegistry,
        provider: binding.provider,
        scopeRef: binding.scopeRef,
        requiredObjectTypes:
          binding.requiredObjectTypes
      });
    } catch {
      throw new TaskSealServiceError(
        "PROVIDER_INGRESS_FORBIDDEN",
        "Provider snapshot ingress is not enabled for this target."
      );
    }
  }

  getWorkflow(): Workflow {
    this.assertAvailable();
    return structuredClone(this.#state.workflow);
  }

  getWorkItem(workItemId: string): WorkItem | null {
    this.assertAvailable();
    const workItem =
      this.#state.workflow.workItems[workItemId];
    return workItem ? structuredClone(workItem) : null;
  }

  getImportReceipt({
    planDigest
  }: ImportReceiptQuery): ImportReceipt | null {
    this.assertAvailable();
    const receipt =
      this.#state.receiptsByPlanDigest.get(planDigest);
    return receipt ? structuredClone(receipt) : null;
  }

  getHealth(): TaskSealServiceHealth {
    return this.#health.status === "fenced"
      ? {
          status: "fenced",
          code: this.#health.code,
          planDigest: this.#health.planDigest
        }
      : {
          status: "ready"
        };
  }

  recoverRunningAttempts({
    occurredAt = new Date().toISOString()
  }: RecoverRunningAttemptsOptions = {}): Promise<number> {
    return this.enqueueWrite(async () => {
      const runningAttempts = Object.values(
        this.#state.workflow.workItems
      ).flatMap((workItem) =>
        workItem.attempts
          .filter(
            (attempt) => attempt.status === "running"
          )
          .map((attempt) => ({
            workItemId: workItem.id,
            attemptId: attempt.id
          }))
      );

      for (const {
        workItemId,
        attemptId
      } of runningAttempts) {
        await this.appendNow({
          eventId: `taskseal:${workItemId}:${attemptId}:recovered-interrupted`,
          workItemId,
          type: "attempt.finished",
          occurredAt,
          payload: {
            attemptId,
            outcome: "interrupted",
            summary:
              "Recovered an unfinished attempt after TaskSeal restarted."
          }
        });
      }

      return runningAttempts.length;
    });
  }

  snapshot(): DashboardProjection {
    this.assertAvailable();
    return structuredClone(
      projectDashboard(this.#state.workflow)
    );
  }

  enqueueWrite<T>(
    operation: () => T | Promise<T>
  ): Promise<T> {
    const queued = this.#writeQueue.then(() => {
      this.assertAvailable();
      return operation();
    });
    this.#writeQueue = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  }

  currentTimestamp(): string {
    const value = this.#clock();
    const timestamp =
      value instanceof Date
        ? value.toISOString()
        : value;

    if (
      typeof timestamp !== "string" ||
      !Number.isFinite(Date.parse(timestamp))
    ) {
      throw new TaskSealServiceError(
        "IMPORT_ACTOR_INVALID",
        "TaskSeal clock did not return a valid timestamp."
      );
    }

    return timestamp;
  }

  fence({
    code,
    planDigest
  }: Omit<FencedServiceHealth, "status">): void {
    this.#health = {
      status: "fenced",
      code,
      planDigest
    };
  }

  assertAvailable(): void {
    if (this.#health.status === "fenced") {
      throw new TaskSealServiceError(
        "SERVICE_REOPEN_REQUIRED",
        "TaskSeal must reopen and replay the journal before serving further reads or writes."
      );
    }
  }
}

export class TaskSealServiceError extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "TaskSealServiceError";
    this.code = code;
  }
}

function assertDirectIngressAllowed(
  event: CanonicalEvent
): void {
  const payload = readOwnDataProperty(
    event,
    "payload"
  );
  const externalLink = isRecord(payload)
    ? readOwnDataProperty(payload, "externalLink")
    : undefined;
  const isProviderManaged =
    event.type === "external_link.linked" ||
    event.type === "external_link.observed" ||
    event.type === "work_item.updated" ||
    (
      event.type === "work_item.created" &&
      isRecord(externalLink) &&
      Object.prototype.hasOwnProperty.call(
        externalLink,
        "providerObjectKey"
      )
    );

  if (isProviderManaged) {
    throw new TaskSealServiceError(
      "PROVIDER_INGRESS_FORBIDDEN",
      "Provider-managed canonical events require an authorized snapshot import batch."
    );
  }
}

function readOwnDataProperty(
  value: object,
  key: string
): unknown {
  const descriptor =
    Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor
    ? descriptor.value
    : undefined;
}

type ImportActionByEventId = Map<
  string,
  ImportPlan["actions"][number]
>;

function assertImportPlanIngressPreflight({
  plan,
  workflow,
  registry
}: {
  plan: ImportPlan;
  workflow: Workflow;
  registry: ProviderIngressRegistry;
}): ImportActionByEventId {
  const binding = plan.policyBinding;
  const actionByEventId: ImportActionByEventId =
    new Map(
      plan.actions.flatMap((action) =>
        action.eventIds.map((eventId) => [
          eventId,
          action
        ] as const)
      )
    );

  for (const action of plan.actions) {
    const objectType = readProviderObjectType(
      action.sourceObjectKey,
      binding.provider
    );

    if (
      objectType === null ||
      !binding.requiredObjectTypes.includes(
        objectType as
          PolicyBinding["requiredObjectTypes"][number]
      )
    ) {
      throw importPlanIngressMismatch();
    }

    if (
      action.kind === "skip" &&
      action.eventIds.length === 0
    ) {
      authorizeExistingSkippedAction({
        workflow,
        workItemId: action.workItemId,
        sourceObjectKey: action.sourceObjectKey,
        objectType,
        binding,
        registry
      });
    }
  }

  const plannedRichLinks = new Set<string>();

  for (const event of plan.events) {
    const action = actionByEventId.get(event.eventId);
    if (!action) {
      throw importPlanIngressMismatch();
    }

    if (event.type === "work_item.created") {
      authorizePlanFact({
        registry,
        binding,
        sourceObjectKey: action.sourceObjectKey,
        fact: {
          kind: "rich-link",
          value: event.payload.externalLink
        }
      });
      plannedRichLinks.add(
        richLinkIdentity(
          event.workItemId,
          action.sourceObjectKey
        )
      );
    } else if (event.type === "external_link.linked") {
      authorizePlanFact({
        registry,
        binding,
        sourceObjectKey: action.sourceObjectKey,
        fact: {
          kind: "rich-link",
          value: event.payload.link
        }
      });
      plannedRichLinks.add(
        richLinkIdentity(
          event.workItemId,
          action.sourceObjectKey
        )
      );
    } else if (event.type === "external_link.observed") {
      if (event.payload.expectedRevisionId === null) {
        authorizePlannedBaselineLink({
          workflow,
          workItemId: event.workItemId,
          sourceObjectKey: action.sourceObjectKey,
          payload: event.payload,
          binding,
          registry
        });
        plannedRichLinks.add(
          richLinkIdentity(
            event.workItemId,
            action.sourceObjectKey
          )
        );
      } else {
        authorizeProjectedLink({
          workflow,
          workItemId: event.workItemId,
          sourceObjectKey: action.sourceObjectKey,
          binding,
          registry
        });
      }
    } else if (
      event.type === "work_item.updated" &&
      !plannedRichLinks.has(
        richLinkIdentity(
          event.workItemId,
          action.sourceObjectKey
        )
      )
    ) {
      authorizeProjectedLink({
        workflow,
        workItemId: event.workItemId,
        sourceObjectKey: action.sourceObjectKey,
        binding,
        registry
      });
    }

    if (event.type === "artifact.linked") {
      authorizePlanFact({
        registry,
        binding,
        sourceObjectKey: action.sourceObjectKey,
        fact: {
          kind: "artifact",
          value: event.payload
        }
      });
    } else if (event.type === "evidence.recorded") {
      authorizePlanFact({
        registry,
        binding,
        sourceObjectKey: action.sourceObjectKey,
        fact: {
          kind: "evidence",
          value: event.payload
        }
      });
    }
  }

  return actionByEventId;
}

function projectAuthorizedImportPlan({
  plan,
  workflow,
  registry,
  actionByEventId
}: {
  plan: ImportPlan;
  workflow: Workflow;
  registry: ProviderIngressRegistry;
  actionByEventId: ImportActionByEventId;
}): Workflow {
  const binding = plan.policyBinding;
  let projected = workflow;

  for (const event of plan.events) {
    const action = actionByEventId.get(event.eventId);
    if (!action) {
      throw importPlanIngressMismatch();
    }

    try {
      projected = applyEvent(projected, event);
    } catch {
      throw importPlanIngressMismatch();
    }

    if (
      event.type === "work_item.created" ||
      event.type === "external_link.linked" ||
      event.type === "external_link.observed" ||
      event.type === "work_item.updated"
    ) {
      authorizeProjectedLink({
        workflow: projected,
        workItemId: event.workItemId,
        sourceObjectKey: action.sourceObjectKey,
        binding,
        registry
      });
    }
  }

  return projected;
}

function richLinkIdentity(
  workItemId: string,
  sourceObjectKey: string
): string {
  return `${workItemId}\u0000${sourceObjectKey}`;
}

function authorizeExistingSkippedAction({
  workflow,
  workItemId,
  sourceObjectKey,
  objectType,
  binding,
  registry
}: {
  workflow: Workflow;
  workItemId: string;
  sourceObjectKey: string;
  objectType: string;
  binding: PolicyBinding;
  registry: ProviderIngressRegistry;
}): void {
  const workItem = workflow.workItems[workItemId];
  const link = workItem?.externalLinks.find(
    (candidate) =>
      candidate.providerObjectKey === sourceObjectKey
  );
  if (link && link.legacy !== true) {
    authorizePlanFact({
      registry,
      binding,
      sourceObjectKey,
      fact: {
        kind: "rich-link",
        value: link
      }
    });
    return;
  }

  const externalId = readProviderExternalId(
    sourceObjectKey,
    binding.provider
  );
  if (!workItem || externalId === null) {
    throw importPlanIngressMismatch();
  }

  if (objectType === "pull_request") {
    const artifact = workItem.artifacts.find(
      (candidate) =>
        candidate.id === `pr-${externalId}`
    );
    if (!artifact) {
      throw importPlanIngressMismatch();
    }
    authorizePlanFact({
      registry,
      binding,
      sourceObjectKey,
      fact: {
        kind: "artifact",
        value: {
          artifactId: artifact.id,
          kind: artifact.kind,
          url: artifact.url
        }
      }
    });
    return;
  }

  if (objectType === "check") {
    const evidence = workItem.evidence.find(
      (candidate) =>
        candidate.id === `check-${externalId}`
    );
    if (!evidence) {
      throw importPlanIngressMismatch();
    }
    authorizePlanFact({
      registry,
      binding,
      sourceObjectKey,
      fact: {
        kind: "evidence",
        value: {
          evidenceId: evidence.id,
          url: evidence.url
        }
      }
    });
    return;
  }

  throw importPlanIngressMismatch();
}

function authorizePlannedBaselineLink({
  workflow,
  workItemId,
  sourceObjectKey,
  payload,
  binding,
  registry
}: {
  workflow: Workflow;
  workItemId: string;
  sourceObjectKey: string;
  payload: Record<string, unknown>;
  binding: PolicyBinding;
  registry: ProviderIngressRegistry;
}): void {
  const link = workflow.workItems[
    workItemId
  ]?.externalLinks.find(
    (candidate) =>
      candidate.providerObjectKey === sourceObjectKey
  );
  const baseline = payload.baseline;
  const observation = payload.observation;

  if (
    !link ||
    link.legacy !== true ||
    payload.providerObjectKey !== sourceObjectKey ||
    !isRecord(baseline) ||
    baseline.providerObjectKey !== sourceObjectKey ||
    !isRecord(observation)
  ) {
    throw importPlanIngressMismatch();
  }

  authorizePlanFact({
    registry,
    binding,
    sourceObjectKey,
    fact: {
      kind: "rich-link",
      value: {
        providerObjectKey: sourceObjectKey,
        provider: link.provider,
        objectType: baseline.objectType,
        externalId: link.externalId,
        scopeRef: baseline.scopeRef,
        url:
          observation.url === undefined
            ? link.url
            : observation.url,
        managedFields: baseline.managedFields,
        lastObservation: observation
      }
    }
  });
}

function authorizeProjectedLink({
  workflow,
  workItemId,
  sourceObjectKey,
  binding,
  registry
}: {
  workflow: Workflow;
  workItemId: string;
  sourceObjectKey: string;
  binding: PolicyBinding;
  registry: ProviderIngressRegistry;
}): void {
  const link = workflow.workItems[
    workItemId
  ]?.externalLinks.find(
    (candidate) =>
      candidate.providerObjectKey === sourceObjectKey
  );

  if (!link || link.legacy === true) {
    throw importPlanIngressMismatch();
  }

  authorizePlanFact({
    registry,
    binding,
    sourceObjectKey,
    fact: {
      kind: "rich-link",
      value: link
    }
  });
}

function authorizePlanFact({
  registry,
  binding,
  sourceObjectKey,
  fact
}: {
  registry: ProviderIngressRegistry;
  binding: PolicyBinding;
  sourceObjectKey: string;
  fact:
    | {
        kind: "rich-link";
        value: unknown;
      }
    | {
        kind: "artifact";
        value: unknown;
      }
    | {
        kind: "evidence";
        value: unknown;
      };
}): void {
  try {
    authorizeProviderIngressFact({
      registry,
      provider: binding.provider,
      scopeRef: binding.scopeRef,
      sourceObjectKey,
      fact
    });
  } catch {
    throw importPlanIngressMismatch();
  }
}

function readProviderObjectType(
  providerObjectKey: string,
  provider: string
): string | null {
  const prefix = `${provider}:`;
  if (!providerObjectKey.startsWith(prefix)) {
    return null;
  }

  const remainder = providerObjectKey.slice(
    prefix.length
  );
  const separator = remainder.indexOf(":");
  return separator > 0
    ? remainder.slice(0, separator)
    : null;
}

function readProviderExternalId(
  providerObjectKey: string,
  provider: string
): string | null {
  const prefix = `${provider}:`;
  if (!providerObjectKey.startsWith(prefix)) {
    return null;
  }

  const remainder = providerObjectKey.slice(
    prefix.length
  );
  const separator = remainder.indexOf(":");
  return separator > 0 &&
    separator < remainder.length - 1
    ? remainder.slice(separator + 1)
    : null;
}

function importPlanIngressMismatch(): TaskSealServiceError {
  return new TaskSealServiceError(
    "IMPORT_PLAN_TAMPERED",
    "ImportPlan events do not match the authorized Provider ingress binding."
  );
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

function hasErrorCode(
  error: unknown,
  expectedCode: string
): boolean {
  return (
    isRecord(error) &&
    error.code === expectedCode
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
