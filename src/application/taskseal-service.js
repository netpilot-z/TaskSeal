import { projectDashboard } from "../dashboard/projection.js";
import { applyEvent, createWorkflow } from "../domain/workflow.js";
import {
  createImportBatchRecord,
  validateImportBatchRecord,
  validateImportPlanForApply
} from "./import-batch.js";
import {
  computeBaseWorkflowDigest
} from "./import-plan.js";
import {
  buildPolicyBinding,
  normalizeImportPolicy
} from "./import-policy.js";

export class TaskSealService {
  static async open({
    journal,
    importPolicyProvider,
    clock = () => new Date()
  }) {
    const records = await journal.readAll();
    let workflow = createWorkflow();
    const receiptsByPlanDigest = new Map();
    const batchesById = new Map();

    for (const [index, record] of records.entries()) {
      try {
        if (record?.recordType === "import.batch") {
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
          `TaskSeal could not replay event journal line ${index + 1}: ${error.message}`,
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
      clock
    });
  }

  #journal;
  #state;
  #writeQueue;
  #importPolicyProvider;
  #clock;
  #fence;

  constructor({
    journal,
    workflow,
    receiptsByPlanDigest = new Map(),
    batchesById = new Map(),
    importPolicyProvider,
    clock = () => new Date()
  }) {
    this.#journal = journal;
    this.#state = {
      workflow,
      receiptsByPlanDigest,
      batchesById
    };
    this.#writeQueue = Promise.resolve();
    this.#importPolicyProvider = importPolicyProvider;
    this.#clock = clock;
    this.#fence = null;
  }

  append(event) {
    return this.enqueueWrite(() => this.appendNow(event));
  }

  startAttemptIfIdle(event) {
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

  async appendNow(event) {
    this.assertAvailable();
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
        error.code === "JOURNAL_COMMIT_OUTCOME_UNKNOWN"
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
        error.code === "JOURNAL_WRITE_FAILED" ||
        error.code ===
          "JOURNAL_ATOMIC_COMMIT_UNSUPPORTED"
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
  }) {
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
  }) {
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

    let candidate = this.#state.workflow;

    try {
      for (const event of normalizedPlan.events) {
        candidate = applyEvent(candidate, event);
      }
    } catch (error) {
      throw new TaskSealServiceError(
        "IMPORT_PLAN_TAMPERED",
        "ImportPlan events no longer satisfy canonical domain invariants.",
        { cause: error }
      );
    }

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
        error.code === "JOURNAL_COMMIT_OUTCOME_UNKNOWN"
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
        error.code === "JOURNAL_WRITE_FAILED" ||
        error.code ===
          "JOURNAL_ATOMIC_COMMIT_UNSUPPORTED"
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

  async readCurrentPolicyBinding(plannedBinding) {
    if (
      typeof this.#importPolicyProvider !== "function"
    ) {
      throw new TaskSealServiceError(
        "IMPORT_POLICY_INVALID",
        "TaskSeal has no trusted ImportPolicy provider."
      );
    }

    let importPolicy;

    try {
      importPolicy = await this.#importPolicyProvider();
    } catch (error) {
      throw new TaskSealServiceError(
        "IMPORT_POLICY_INVALID",
        "TaskSeal could not read the current ImportPolicy.",
        { cause: error }
      );
    }

    let normalizedPolicy;

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

    if (
      !normalizedPolicy.capabilities[
        "snapshot.import.apply"
      ]
    ) {
      throw new TaskSealServiceError(
        "IMPORT_APPLY_FORBIDDEN",
        "Current ImportPolicy does not allow snapshot apply."
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

  getWorkflow() {
    this.assertAvailable();
    return structuredClone(this.#state.workflow);
  }

  getWorkItem(workItemId) {
    this.assertAvailable();
    const workItem =
      this.#state.workflow.workItems[workItemId];
    return workItem ? structuredClone(workItem) : null;
  }

  getImportReceipt({ planDigest }) {
    this.assertAvailable();
    const receipt =
      this.#state.receiptsByPlanDigest.get(planDigest);
    return receipt ? structuredClone(receipt) : null;
  }

  getHealth() {
    return this.#fence
      ? {
          status: "fenced",
          code: this.#fence.code,
          planDigest: this.#fence.planDigest
        }
      : {
          status: "ready"
        };
  }

  recoverRunningAttempts({
    occurredAt = new Date().toISOString()
  } = {}) {
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

  snapshot() {
    this.assertAvailable();
    return structuredClone(
      projectDashboard(this.#state.workflow)
    );
  }

  enqueueWrite(operation) {
    const queued = this.#writeQueue.then(() => {
      this.assertAvailable();
      return operation();
    });
    this.#writeQueue = queued.catch(() => undefined);
    return queued;
  }

  currentTimestamp() {
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

  fence({ code, planDigest }) {
    this.#fence = {
      code,
      planDigest
    };
  }

  assertAvailable() {
    if (this.#fence) {
      throw new TaskSealServiceError(
        "SERVICE_REOPEN_REQUIRED",
        "TaskSeal must reopen and replay the journal before serving further reads or writes."
      );
    }
  }
}

export class TaskSealServiceError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "TaskSealServiceError";
    this.code = code;
  }
}
