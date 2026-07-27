import {
  createControlledWriteOperation,
  transitionControlledWriteOperation
} from "./controlled-write-operation.ts";
import type {
  ControlledWriteActor,
  ControlledWriteOperation
} from "./controlled-write-operation.ts";
import {
  ProviderOperationJournalError
} from "./provider-operation-journal.ts";
import type {
  ProviderOperationAppendResult,
  ProviderOperationJournalCommandPort,
  ProviderOperationJournalQueryPort
} from "./provider-operation-journal.ts";
import type {
  LinearWriteCreateResult,
  LinearWriteQueryResult,
  LinearWriteTransportPort
} from "./linear-write-transport.ts";

export interface ControlledWriteCoordinatorJournalPort
  extends
    ProviderOperationJournalCommandPort,
    ProviderOperationJournalQueryPort {}

export interface ControlledWriteCoordinatorOptions {
  journal: ControlledWriteCoordinatorJournalPort;
  transport: LinearWriteTransportPort;
  clock?: (() => unknown) | undefined;
}

export interface ControlledWritePreparationInput {
  configuredTarget: unknown;
  resolvedTarget: unknown;
  clientRequestId: unknown;
  payload: unknown;
}

export interface ControlledWriteCoordinatorOperationInput {
  operationKey: string;
  planDigest: string;
}

export interface ControlledWriteCoordinatorApprovalInput
  extends ControlledWriteCoordinatorOperationInput {
  actor: ControlledWriteActor;
}

interface NormalizedApprovalInput
  extends ControlledWriteCoordinatorOperationInput {
  actor: ControlledWriteActor;
}

const DIGEST_PATTERN =
  /^sha256:[0-9a-f]{64}$/;

export class ControlledWriteCoordinator {
  static async open({
    journal,
    transport,
    clock = () => new Date()
  }: ControlledWriteCoordinatorOptions): Promise<ControlledWriteCoordinator> {
    try {
      validateJournal(journal);
      validateTransport(transport);
    } catch {
      throw invalidInput();
    }
    if (typeof clock !== "function") {
      throw invalidInput();
    }

    const coordinator =
      new ControlledWriteCoordinator({
        journal,
        transport,
        clock
      });
    await coordinator.recoverInterruptedOperations();
    return coordinator;
  }

  readonly #journal: ControlledWriteCoordinatorJournalPort;
  readonly #transport: LinearWriteTransportPort;
  readonly #clock: () => unknown;
  readonly #operationQueues = new Map<
    string,
    Promise<void>
  >();
  #reopenRequired = false;

  private constructor({
    journal,
    transport,
    clock
  }: {
    journal: ControlledWriteCoordinatorJournalPort;
    transport: LinearWriteTransportPort;
    clock: () => unknown;
  }) {
    this.#journal = journal;
    this.#transport = transport;
    this.#clock = clock;
  }

  async prepare(
    inputValue: unknown
  ): Promise<ControlledWriteOperation> {
    this.assertOpen();
    let input: ControlledWritePreparationInput;
    let candidate: ControlledWriteOperation;

    try {
      input = normalizePreparationInput(inputValue);
      candidate = createControlledWriteOperation({
        configuredTarget: input.configuredTarget,
        resolvedTarget: input.resolvedTarget,
        clientRequestId: input.clientRequestId,
        payload: input.payload,
        preparedAt: this.captureTimestamp()
      });
    } catch (error) {
      if (
        error instanceof
        ControlledWriteCoordinatorError
      ) {
        throw error;
      }
      throw invalidInput();
    }

    return this.enqueue(
      candidate.plan.operationKey,
      async () => {
        this.assertOpen();
        const current = await this.readCurrent(
          candidate.plan.operationKey
        );

        if (current !== null) {
          if (
            current.plan.planDigest ===
            candidate.plan.planDigest
          ) {
            return current;
          }
          throw planConflict();
        }

        const result = await this.append(
          0,
          candidate
        );
        return result.operation;
      }
    );
  }

  approve(
    inputValue: unknown
  ): Promise<ControlledWriteOperation> {
    return this.decide(inputValue, "approved");
  }

  reject(
    inputValue: unknown
  ): Promise<ControlledWriteOperation> {
    return this.decide(inputValue, "rejected");
  }

  async submit(
    inputValue: unknown
  ): Promise<ControlledWriteOperation> {
    this.assertOpen();
    const input =
      normalizePublicOperationInput(inputValue);

    return this.enqueue(
      input.operationKey,
      async () => {
        this.assertOpen();
        const current =
          await this.requireCurrent(input);

        if (
          current.status === "created" ||
          current.status === "failed" ||
          current.status === "outcome_unknown" ||
          current.status ===
            "reconciliation_absent" ||
          current.status === "reconciled"
        ) {
          return current;
        }
        if (
          current.status === "submitting" ||
          current.status === "reconciling"
        ) {
          this.#reopenRequired = true;
          throw reopenRequired();
        }
        if (current.status !== "approved") {
          throw stateInvalid();
        }

        const submitting = transitionSafely(
          current,
          {
            type: "begin_submission",
            occurredAt:
              this.captureTimestampNotBefore(
                current.updatedAt
              )
          }
        );
        const begin = await this.append(
          current.version,
          submitting
        );

        if (begin.resolution !== "committed") {
          this.#reopenRequired = true;
          throw reopenRequired();
        }

        let transportResult: unknown;
        try {
          transportResult =
            await this.#transport.createIssue({
              clientRequestId:
                submitting.plan.clientRequestId,
              teamId:
                submitting.plan.resolvedTarget.teamId,
              title:
                submitting.plan.payload.title,
              description:
                submitting.plan.payload.description
            });
        } catch {
          transportResult = null;
        }

        try {
          const completedAt =
            this.captureTimestampOr(
              submitting.updatedAt
            );
          const completed =
            projectSubmissionResult(
              submitting,
              transportResult,
              completedAt
            );
          const result = await this.append(
            submitting.version,
            completed
          );
          return result.operation;
        } catch (error) {
          this.#reopenRequired = true;
          throw error;
        }
      }
    );
  }

  async reconcile(
    inputValue: unknown
  ): Promise<ControlledWriteOperation> {
    this.assertOpen();
    const input =
      normalizePublicOperationInput(inputValue);

    return this.enqueue(
      input.operationKey,
      async () => {
        this.assertOpen();
        const current =
          await this.requireCurrent(input);

        if (
          current.status === "reconciled" ||
          current.status === "created" ||
          current.status === "failed"
        ) {
          return current;
        }
        if (
          current.status === "submitting" ||
          current.status === "reconciling"
        ) {
          this.#reopenRequired = true;
          throw reopenRequired();
        }
        if (
          current.status !== "outcome_unknown" &&
          current.status !==
            "reconciliation_absent"
        ) {
          throw stateInvalid();
        }

        const reconciling = transitionSafely(
          current,
          {
            type: "begin_reconciliation",
            occurredAt:
              this.captureTimestampNotBefore(
                current.updatedAt
              )
          }
        );
        const begin = await this.append(
          current.version,
          reconciling
        );

        if (begin.resolution !== "committed") {
          this.#reopenRequired = true;
          throw reopenRequired();
        }

        let transportResult: unknown;
        try {
          transportResult =
            await this.#transport.queryByClientUuid(
              {
                clientRequestId:
                  reconciling.plan.clientRequestId,
                teamId:
                  reconciling.plan.resolvedTarget
                    .teamId
              }
            );
        } catch {
          transportResult = null;
        }

        try {
          const completedAt =
            this.captureTimestampOr(
              reconciling.updatedAt
            );
          const completed =
            projectReconciliationResult(
              reconciling,
              transportResult,
              completedAt
            );
          const result = await this.append(
            reconciling.version,
            completed
          );
          return result.operation;
        } catch (error) {
          this.#reopenRequired = true;
          throw error;
        }
      }
    );
  }

  async get(
    operationKeyValue: unknown
  ): Promise<ControlledWriteOperation | null> {
    const operationKey =
      normalizePublicDigest(operationKeyValue);
    await this.waitForOperation(operationKey);
    this.assertOpen();
    return this.readCurrent(operationKey);
  }

  async history(
    operationKeyValue: unknown
  ): Promise<readonly ControlledWriteOperation[]> {
    const operationKey =
      normalizePublicDigest(operationKeyValue);
    await this.waitForOperation(operationKey);
    this.assertOpen();
    try {
      return await this.#journal.history(
        operationKey
      );
    } catch (error) {
      throw normalizeJournalError(error);
    }
  }

  private decide(
    inputValue: unknown,
    decision: "approved" | "rejected"
  ): Promise<ControlledWriteOperation> {
    this.assertOpen();
    const input =
      normalizePublicApprovalInput(inputValue);

    return this.enqueue(
      input.operationKey,
      async () => {
        this.assertOpen();
        const current =
          await this.requireCurrent(input);

        if (current.approval !== null) {
          if (
            current.approval.decision === decision &&
            current.approval.actor.type ===
              input.actor.type &&
            current.approval.actor.id ===
              input.actor.id &&
            current.approval.operationKey ===
              input.operationKey &&
            current.approval.planDigest ===
              input.planDigest
          ) {
            return current;
          }
          throw approvalConflict();
        }
        if (
          current.status !== "approval_required"
        ) {
          throw stateInvalid();
        }

        const next = transitionSafely(
          current,
          {
            type:
              decision === "approved"
                ? "approve"
                : "reject",
            actor: input.actor,
            operationKey: input.operationKey,
            planDigest: input.planDigest,
            occurredAt:
              this.captureTimestampNotBefore(
                current.updatedAt
              )
          }
        );
        const result = await this.append(
          current.version,
          next
        );
        return result.operation;
      }
    );
  }

  private async recoverInterruptedOperations(): Promise<void> {
    let latest: readonly ControlledWriteOperation[];
    try {
      latest = await this.#journal.listLatest();
    } catch (error) {
      throw normalizeJournalError(error);
    }

    for (const observed of latest) {
      if (
        observed.status !== "submitting" &&
        observed.status !== "reconciling"
      ) {
        continue;
      }

      await this.enqueue(
        observed.plan.operationKey,
        async () => {
          const current = await this.readCurrent(
            observed.plan.operationKey
          );
          if (
            current === null ||
            (current.status !== "submitting" &&
              current.status !== "reconciling")
          ) {
            return;
          }

          const next =
            current.status === "submitting"
              ? transitionSafely(current, {
                  type:
                    "submission_outcome_unknown",
                  occurredAt:
                    this.captureTimestampNotBefore(
                      current.updatedAt
                    ),
                  diagnosticCode:
                    "LINEAR_WRITE_OUTCOME_UNKNOWN"
                })
              : transitionSafely(current, {
                  type:
                    "reconciliation_failed",
                  occurredAt:
                    this.captureTimestampNotBefore(
                      current.updatedAt
                    ),
                  diagnosticCode:
                    "LINEAR_RECONCILIATION_FAILED"
                });
          await this.append(
            current.version,
            next
          );
        }
      );
    }
  }

  private async requireCurrent(
    input: ControlledWriteCoordinatorOperationInput
  ): Promise<ControlledWriteOperation> {
    const current = await this.readCurrent(
      input.operationKey
    );
    if (current === null) {
      throw notFound();
    }
    if (
      current.plan.planDigest !==
      input.planDigest
    ) {
      throw planConflict();
    }
    return current;
  }

  private async readCurrent(
    operationKey: string
  ): Promise<ControlledWriteOperation | null> {
    try {
      return await this.#journal.get(operationKey);
    } catch (error) {
      throw normalizeJournalError(error);
    }
  }

  private async append(
    expectedVersion: number,
    next: ControlledWriteOperation
  ): Promise<ProviderOperationAppendResult> {
    try {
      return await this.#journal.compareAndAppend({
        expectedVersion,
        operationKey: next.plan.operationKey,
        planDigest: next.plan.planDigest,
        next
      });
    } catch (error) {
      const normalized =
        normalizeJournalError(error);
      if (
        normalized instanceof
          ProviderOperationJournalError &&
        (normalized.code ===
          "PROVIDER_OPERATION_JOURNAL_COMMIT_OUTCOME_UNKNOWN" ||
          normalized.code ===
            "PROVIDER_OPERATION_JOURNAL_REOPEN_REQUIRED")
      ) {
        this.#reopenRequired = true;
      }
      throw normalized;
    }
  }

  private enqueue<T>(
    operationKey: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous =
      this.#operationQueues.get(operationKey) ??
      Promise.resolve();
    const result = previous.then(
      operation,
      operation
    );
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    this.#operationQueues.set(
      operationKey,
      settled
    );
    void settled.then(() => {
      if (
        this.#operationQueues.get(
          operationKey
        ) === settled
      ) {
        this.#operationQueues.delete(
          operationKey
        );
      }
    });
    return result;
  }

  private async waitForOperation(
    operationKey: string
  ): Promise<void> {
    await this.#operationQueues.get(operationKey);
  }

  private captureTimestamp(): string {
    try {
      const value = this.#clock();
      if (!(value instanceof Date)) {
        throw clockInvalid();
      }
      const timestamp =
        Date.prototype.getTime.call(value);
      if (!Number.isFinite(timestamp)) {
        throw clockInvalid();
      }
      return Date.prototype.toISOString.call(
        value
      );
    } catch {
      throw clockInvalid();
    }
  }

  private captureTimestampOr(
    fallback: string
  ): string {
    try {
      return this.captureTimestampNotBefore(
        fallback
      );
    } catch {
      return fallback;
    }
  }

  private captureTimestampNotBefore(
    fallback: string
  ): string {
    const timestamp = this.captureTimestamp();
    return Date.parse(timestamp) <
      Date.parse(fallback)
      ? fallback
      : timestamp;
  }

  private assertOpen(): void {
    if (this.#reopenRequired) {
      throw reopenRequired();
    }
  }
}

function projectSubmissionResult(
  submitting: ControlledWriteOperation,
  value: unknown,
  occurredAt: string
): ControlledWriteOperation {
  const result = normalizeCreateResult(value);

  if (result?.kind === "created") {
    try {
      return transitionControlledWriteOperation(
        submitting,
        {
          type: "submission_created",
          occurredAt,
          observedTeamId:
            result.observedTeamId,
          issue: result.issue
        }
      );
    } catch {
      return submissionUnknown(
        submitting,
        occurredAt
      );
    }
  }
  if (result?.kind === "not_dispatched") {
    return transitionSafely(submitting, {
      type: "submission_not_dispatched",
      occurredAt,
      diagnosticCode:
        "LINEAR_WRITE_NOT_DISPATCHED"
    });
  }
  return submissionUnknown(
    submitting,
    occurredAt
  );
}

function submissionUnknown(
  submitting: ControlledWriteOperation,
  occurredAt: string
): ControlledWriteOperation {
  return transitionSafely(submitting, {
    type: "submission_outcome_unknown",
    occurredAt,
    diagnosticCode:
      "LINEAR_WRITE_OUTCOME_UNKNOWN"
  });
}

function projectReconciliationResult(
  reconciling: ControlledWriteOperation,
  value: unknown,
  occurredAt: string
): ControlledWriteOperation {
  const result = normalizeQueryResult(value);

  if (result?.kind === "found") {
    try {
      return transitionControlledWriteOperation(
        reconciling,
        {
          type: "reconciliation_found",
          occurredAt,
          observedTeamId:
            result.observedTeamId,
          issue: result.issue
        }
      );
    } catch {
      return reconciliationAmbiguous(
        reconciling,
        occurredAt
      );
    }
  }
  if (result?.kind === "absent") {
    return transitionSafely(reconciling, {
      type: "reconciliation_absent",
      occurredAt
    });
  }
  if (result?.kind === "ambiguous") {
    return reconciliationAmbiguous(
      reconciling,
      occurredAt
    );
  }
  return transitionSafely(reconciling, {
    type: "reconciliation_failed",
    occurredAt,
    diagnosticCode:
      "LINEAR_RECONCILIATION_FAILED"
  });
}

function reconciliationAmbiguous(
  reconciling: ControlledWriteOperation,
  occurredAt: string
): ControlledWriteOperation {
  return transitionSafely(reconciling, {
    type: "reconciliation_ambiguous",
    occurredAt,
    diagnosticCode:
      "LINEAR_RECONCILIATION_AMBIGUOUS"
  });
}

function normalizeCreateResult(
  value: unknown
): LinearWriteCreateResult | null {
  try {
    const result = readDataRecord(value);
    if (result.kind === "created") {
      requireExactKeys(result, [
        "kind",
        "issue",
        "observedTeamId"
      ]);
      const issue = readExactRecord(
        result.issue,
        ["id", "identifier"]
      );
      if (
        typeof issue.id !== "string" ||
        typeof issue.identifier !== "string" ||
        typeof result.observedTeamId !==
          "string"
      ) {
        return null;
      }
      return {
        kind: "created",
        issue: {
          id: issue.id,
          identifier: issue.identifier
        },
        observedTeamId:
          result.observedTeamId
      };
    }
    if (result.kind === "not_dispatched") {
      requireExactKeys(result, [
        "kind",
        "diagnosticCode"
      ]);
      return result.diagnosticCode ===
        "LINEAR_WRITE_NOT_DISPATCHED"
        ? {
            kind: "not_dispatched",
            diagnosticCode:
              "LINEAR_WRITE_NOT_DISPATCHED"
          }
        : null;
    }
    if (result.kind === "outcome_unknown") {
      requireExactKeys(result, [
        "kind",
        "diagnosticCode"
      ]);
      return result.diagnosticCode ===
        "LINEAR_WRITE_OUTCOME_UNKNOWN"
        ? {
            kind: "outcome_unknown",
            diagnosticCode:
              "LINEAR_WRITE_OUTCOME_UNKNOWN"
          }
        : null;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeQueryResult(
  value: unknown
): LinearWriteQueryResult | null {
  try {
    const result = readDataRecord(value);
    if (result.kind === "found") {
      requireExactKeys(result, [
        "kind",
        "issue",
        "observedTeamId"
      ]);
      const issue = readExactRecord(
        result.issue,
        ["id", "identifier"]
      );
      if (
        typeof issue.id !== "string" ||
        typeof issue.identifier !== "string" ||
        typeof result.observedTeamId !==
          "string"
      ) {
        return null;
      }
      return {
        kind: "found",
        issue: {
          id: issue.id,
          identifier: issue.identifier
        },
        observedTeamId:
          result.observedTeamId
      };
    }
    if (result.kind === "absent") {
      requireExactKeys(result, ["kind"]);
      return { kind: "absent" };
    }
    if (result.kind === "failed") {
      requireExactKeys(result, [
        "kind",
        "diagnosticCode"
      ]);
      return result.diagnosticCode ===
        "LINEAR_RECONCILIATION_FAILED"
        ? {
            kind: "failed",
            diagnosticCode:
              "LINEAR_RECONCILIATION_FAILED"
          }
        : null;
    }
    if (result.kind === "ambiguous") {
      requireExactKeys(result, [
        "kind",
        "diagnosticCode"
      ]);
      return result.diagnosticCode ===
        "LINEAR_RECONCILIATION_AMBIGUOUS"
        ? {
            kind: "ambiguous",
            diagnosticCode:
              "LINEAR_RECONCILIATION_AMBIGUOUS"
          }
        : null;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizePreparationInput(
  value: unknown
): ControlledWritePreparationInput {
  const input = readExactRecord(value, [
    "configuredTarget",
    "resolvedTarget",
    "clientRequestId",
    "payload"
  ]);
  return {
    configuredTarget: input.configuredTarget,
    resolvedTarget: input.resolvedTarget,
    clientRequestId: input.clientRequestId,
    payload: input.payload
  };
}

function normalizePublicOperationInput(
  value: unknown
): ControlledWriteCoordinatorOperationInput {
  try {
    const input = readExactRecord(value, [
      "operationKey",
      "planDigest"
    ]);
    return {
      operationKey: normalizeDigest(
        input.operationKey
      ),
      planDigest: normalizeDigest(
        input.planDigest
      )
    };
  } catch {
    throw invalidInput();
  }
}

function normalizePublicApprovalInput(
  value: unknown
): NormalizedApprovalInput {
  try {
    const input = readExactRecord(value, [
      "operationKey",
      "planDigest",
      "actor"
    ]);
    const actor = readExactRecord(
      input.actor,
      ["type", "id"]
    );
    if (
      actor.type !== "human" ||
      typeof actor.id !== "string" ||
      !actor.id.isWellFormed() ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(
        actor.id
      ) ||
      [...actor.id].length > 128 ||
      Buffer.byteLength(actor.id, "utf8") >
        512
    ) {
      throw invalidInput();
    }
    return {
      operationKey: normalizeDigest(
        input.operationKey
      ),
      planDigest: normalizeDigest(
        input.planDigest
      ),
      actor: {
        type: "human",
        id: actor.id
      }
    };
  } catch {
    throw invalidInput();
  }
}

function normalizePublicDigest(
  value: unknown
): string {
  try {
    return normalizeDigest(value);
  } catch {
    throw invalidInput();
  }
}

function normalizeDigest(value: unknown): string {
  if (
    typeof value !== "string" ||
    !DIGEST_PATTERN.test(value)
  ) {
    throw invalidInput();
  }
  return value;
}

function transitionSafely(
  operation: ControlledWriteOperation,
  action: unknown
): ControlledWriteOperation {
  try {
    return transitionControlledWriteOperation(
      operation,
      action
    );
  } catch {
    throw stateInvalid();
  }
}

function validateJournal(
  value: unknown
): asserts value is ControlledWriteCoordinatorJournalPort {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof Reflect.get(
      value,
      "compareAndAppend"
    ) !== "function" ||
    typeof Reflect.get(value, "get") !==
      "function" ||
    typeof Reflect.get(value, "history") !==
      "function" ||
    typeof Reflect.get(value, "listLatest") !==
      "function"
  ) {
    throw invalidInput();
  }
}

function validateTransport(
  value: unknown
): asserts value is LinearWriteTransportPort {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof Reflect.get(value, "createIssue") !==
      "function" ||
    typeof Reflect.get(
      value,
      "queryByClientUuid"
    ) !== "function"
  ) {
    throw invalidInput();
  }
}

function readExactRecord<const T extends readonly string[]>(
  value: unknown,
  expectedKeys: T
): Record<T[number], unknown> {
  const record = readDataRecord(value);
  requireExactKeys(record, expectedKeys);
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
    throw invalidInput();
  }

  const descriptors =
    Object.getOwnPropertyDescriptors(value);
  const result = Object.create(
    null
  ) as Record<string, unknown>;

  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw invalidInput();
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalidInput();
    }
    result[key] = descriptor.value;
  }
  return result;
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
    throw invalidInput();
  }
}

function normalizeJournalError(
  error: unknown
): ProviderOperationJournalError | ControlledWriteCoordinatorError {
  if (
    error instanceof ProviderOperationJournalError
  ) {
    return error;
  }
  return new ControlledWriteCoordinatorError(
    "CONTROLLED_WRITE_COORDINATOR_JOURNAL_FAILED",
    "Controlled write coordinator journal operation failed."
  );
}

function invalidInput(): ControlledWriteCoordinatorError {
  return new ControlledWriteCoordinatorError(
    "CONTROLLED_WRITE_COORDINATOR_INVALID_INPUT",
    "Controlled write coordinator input is invalid."
  );
}

function notFound(): ControlledWriteCoordinatorError {
  return new ControlledWriteCoordinatorError(
    "CONTROLLED_WRITE_COORDINATOR_NOT_FOUND",
    "Controlled write operation was not found."
  );
}

function planConflict(): ControlledWriteCoordinatorError {
  return new ControlledWriteCoordinatorError(
    "CONTROLLED_WRITE_COORDINATOR_PLAN_CONFLICT",
    "Controlled write operation plan conflicts with the persisted plan."
  );
}

function approvalConflict(): ControlledWriteCoordinatorError {
  return new ControlledWriteCoordinatorError(
    "CONTROLLED_WRITE_COORDINATOR_APPROVAL_CONFLICT",
    "Controlled write operation approval conflicts with the persisted approval."
  );
}

function stateInvalid(): ControlledWriteCoordinatorError {
  return new ControlledWriteCoordinatorError(
    "CONTROLLED_WRITE_COORDINATOR_STATE_INVALID",
    "Controlled write operation is not valid for this action."
  );
}

function clockInvalid(): ControlledWriteCoordinatorError {
  return new ControlledWriteCoordinatorError(
    "CONTROLLED_WRITE_COORDINATOR_CLOCK_INVALID",
    "Controlled write coordinator clock is invalid."
  );
}

function reopenRequired(): ControlledWriteCoordinatorError {
  return new ControlledWriteCoordinatorError(
    "CONTROLLED_WRITE_COORDINATOR_REOPEN_REQUIRED",
    "Controlled write coordinator must be reopened."
  );
}

export class ControlledWriteCoordinatorError
  extends Error
{
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name =
      "ControlledWriteCoordinatorError";
    this.code = code;
  }
}
