import {
  createControlledTransitionOperation,
  transitionControlledTransitionOperation
} from "./controlled-transition-operation.ts";
import type {
  ControlledTransitionActor,
  ControlledTransitionObservedIssue,
  ControlledTransitionOperation,
  ControlledTransitionOperationPlan
} from "./controlled-transition-operation.ts";
import type {
  LinearTransitionObservedIssue,
  LinearTransitionReadResult,
  LinearTransitionTransportPort,
  LinearTransitionUpdateResult
} from "./linear-transition-transport.ts";
import {
  ProviderOperationJournalError
} from "./provider-operation-journal.ts";
import type {
  ProviderOperationJournalCommandPort,
  ProviderOperationJournalQueryPort
} from "./provider-operation-journal.ts";
import type {
  ProviderOperation
} from "./provider-operation.ts";
import {
  acceptanceEventId,
  digestAcceptanceDecision
} from "./work-item-acceptance.ts";
import type {
  WorkItem
} from "../domain/workflow.ts";

export interface LinearTransitionWorkItemPort {
  getWorkItem(
    workItemId: string
  ): WorkItem | null;
}

export interface LinearTransitionCoordinatorJournalPort
  extends
    ProviderOperationJournalCommandPort,
    ProviderOperationJournalQueryPort {}

export interface LinearTransitionPreparationInput {
  readonly workItemId: string;
  readonly decisionId: string;
  readonly acceptanceDigest: string;
}

export interface LinearTransitionOperationInput {
  readonly operationKey: string;
  readonly planDigest: string;
}

export interface LinearTransitionApprovalInput
  extends LinearTransitionOperationInput {
  readonly actor:
    ControlledTransitionActor;
}

interface LinearTransitionCoordinatorOptions {
  readonly journal:
    LinearTransitionCoordinatorJournalPort;
  readonly transport:
    LinearTransitionTransportPort;
  readonly workItems:
    LinearTransitionWorkItemPort;
  readonly configuredTarget: unknown;
  readonly resolvedTarget: unknown;
  readonly clock?:
    | (() => unknown)
    | undefined;
}

interface LocalAcceptanceBinding {
  readonly workItem: WorkItem;
  readonly decision:
    NonNullable<
      WorkItem["acceptanceDecision"]
    >;
  readonly link: Extract<
    WorkItem["externalLinks"][number],
    { legacy?: never }
  >;
  readonly eventId: string;
  readonly acceptanceDigest: string;
}

interface NormalizedScope {
  readonly organizationId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly expectedStateId: string;
  readonly targetStateId: string;
}

interface AppendResult {
  readonly resolution:
    | "committed"
    | "idempotent";
  readonly operation:
    ControlledTransitionOperation;
}

const DIGEST_PATTERN =
  /^sha256:[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class LinearTransitionCoordinator {
  static async open(
    options: LinearTransitionCoordinatorOptions
  ): Promise<LinearTransitionCoordinator> {
    try {
      validateJournal(options.journal);
      validateTransport(options.transport);
      validateWorkItems(options.workItems);
      if (
        options.clock !== undefined &&
        typeof options.clock !== "function"
      ) {
        throw invalidInput();
      }
    } catch {
      throw invalidInput();
    }
    const coordinator =
      new LinearTransitionCoordinator({
        ...options,
        clock:
          options.clock ?? (() => new Date())
      });
    await coordinator.recoverInterruptedOperations();
    return coordinator;
  }

  readonly #journal:
    LinearTransitionCoordinatorJournalPort;
  readonly #transport:
    LinearTransitionTransportPort;
  readonly #workItems:
    LinearTransitionWorkItemPort;
  readonly #configuredTarget: unknown;
  readonly #scope: NormalizedScope;
  readonly #clock: () => unknown;
  readonly #queues =
    new Map<string, Promise<void>>();
  #reopenRequired = false;

  private constructor({
    journal,
    transport,
    workItems,
    configuredTarget,
    resolvedTarget,
    clock
  }: LinearTransitionCoordinatorOptions & {
    clock: () => unknown;
  }) {
    this.#journal = journal;
    this.#transport = transport;
    this.#workItems = workItems;
    this.#configuredTarget =
      structuredClone(configuredTarget);
    this.#scope =
      normalizeResolvedScope(
        resolvedTarget
      );
    this.#clock = clock;
  }

  async prepare(
    inputValue: unknown
  ): Promise<ControlledTransitionOperation> {
    this.assertOpen();
    const input =
      normalizePreparationInput(inputValue);
    const binding =
      this.requireLocalAcceptance(input);
    const basis = binding.decision.basis;
    if (basis === undefined) {
      throw acceptanceStale();
    }
    const candidate =
      createControlledTransitionOperation({
        configuredTarget:
          this.#configuredTarget,
        resolvedTarget: {
          ...this.#scope,
          issueId:
            binding.link.externalId,
          expectedRevisionId:
            binding.link.lastObservation
              .revisionId
        },
        sourceIntent: {
          workItemId: input.workItemId,
          decisionId: input.decisionId,
          reviewRevision:
            basis.reviewRevision,
          acceptanceDigest:
            input.acceptanceDigest
        },
        preparedAt:
          this.captureTimestamp()
      });

    return this.enqueue(
      candidate.plan.operationKey,
      async () => {
        this.assertOpen();
        const current =
          await this.readCurrent(
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
        const observed =
          await this.safeReadIssue(
            candidate.plan.resolvedTarget
              .issueId
          );
        assertSourcePrecondition(
          observed,
          candidate.plan
        );
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
  ): Promise<ControlledTransitionOperation> {
    return this.decide(
      inputValue,
      "approved"
    );
  }

  reject(
    inputValue: unknown
  ): Promise<ControlledTransitionOperation> {
    return this.decide(
      inputValue,
      "rejected"
    );
  }

  async submit(
    inputValue: unknown
  ): Promise<ControlledTransitionOperation> {
    this.assertOpen();
    const input =
      normalizeOperationInput(inputValue);
    return this.enqueue(
      input.operationKey,
      async () => {
        this.assertOpen();
        const current =
          await this.requireCurrent(input);
        if (
          current.status ===
            "transitioned" ||
          current.status === "failed" ||
          current.status ===
            "outcome_unknown" ||
          current.status ===
            "reconciliation_absent" ||
          current.status === "reconciled"
        ) {
          return current;
        }
        if (
          current.status ===
            "submitting" ||
          current.status ===
            "reconciling"
        ) {
          this.#reopenRequired = true;
          throw reopenRequired();
        }
        if (current.status !== "approved") {
          throw stateInvalid();
        }
        this.requirePlanAcceptance(
          current.plan
        );
        const source =
          await this.safeReadIssue(
            current.plan.resolvedTarget
              .issueId
          );
        assertSourcePrecondition(
          source,
          current.plan
        );
        const submitting =
          transitionControlledTransitionOperation(
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
        if (
          begin.resolution !== "committed"
        ) {
          this.#reopenRequired = true;
          throw reopenRequired();
        }
        const committed = begin.operation;
        let update:
          LinearTransitionUpdateResult;
        try {
          update =
            await this.#transport.updateIssueState(
              {
                issueId:
                  committed.plan
                    .resolvedTarget.issueId,
                stateId:
                  committed.plan
                    .resolvedTarget.targetStateId
              }
            );
        } catch {
          update = {
            kind: "outcome_unknown",
            diagnosticCode:
              "LINEAR_WRITE_OUTCOME_UNKNOWN"
          };
        }

        try {
          const completedAt =
            this.captureTimestampNotBefore(
              committed.updatedAt
            );
          const completed =
            await this.projectSubmission(
              committed,
              update,
              completedAt
            );
          const result = await this.append(
            committed.version,
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
  ): Promise<ControlledTransitionOperation> {
    this.assertOpen();
    const input =
      normalizeOperationInput(inputValue);
    return this.enqueue(
      input.operationKey,
      async () => {
        this.assertOpen();
        const current =
          await this.requireCurrent(input);
        if (
          current.status ===
            "transitioned" ||
          current.status ===
            "reconciled" ||
          current.status === "failed"
        ) {
          return current;
        }
        if (
          current.status ===
            "submitting" ||
          current.status ===
            "reconciling"
        ) {
          this.#reopenRequired = true;
          throw reopenRequired();
        }
        if (
          current.status !==
            "outcome_unknown" &&
          current.status !==
            "reconciliation_absent"
        ) {
          throw stateInvalid();
        }
        const reconciling =
          transitionControlledTransitionOperation(
            current,
            {
              type:
                "begin_reconciliation",
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
        if (
          begin.resolution !== "committed"
        ) {
          this.#reopenRequired = true;
          throw reopenRequired();
        }
        const committed = begin.operation;
        const observed =
          await this.safeReadIssue(
            committed.plan.resolvedTarget
              .issueId
          );
        try {
          const completed =
            projectReconciliation(
              committed,
              observed,
              this.captureTimestampNotBefore(
                committed.updatedAt
              )
            );
          const result = await this.append(
            committed.version,
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
  ): Promise<ControlledTransitionOperation | null> {
    const operationKey =
      normalizeDigest(
        operationKeyValue
      );
    await this.waitForOperation(
      operationKey
    );
    this.assertOpen();
    return this.readCurrent(operationKey);
  }

  async history(
    operationKeyValue: unknown
  ): Promise<readonly ControlledTransitionOperation[]> {
    const operationKey =
      normalizeDigest(
        operationKeyValue
      );
    await this.waitForOperation(
      operationKey
    );
    this.assertOpen();
    try {
      const values =
        await this.#journal.history(
          operationKey
        );
      return values.map(
        requireTransitionOperation
      );
    } catch (error) {
      throw normalizeJournalError(error);
    }
  }

  private decide(
    inputValue: unknown,
    decision: "approved" | "rejected"
  ): Promise<ControlledTransitionOperation> {
    this.assertOpen();
    const input =
      normalizeApprovalInput(inputValue);
    return this.enqueue(
      input.operationKey,
      async () => {
        this.assertOpen();
        const current =
          await this.requireCurrent(input);
        if (current.approval !== null) {
          if (
            current.approval.decision ===
              decision &&
            current.approval.actor.id ===
              input.actor.id &&
            current.approval.actor.type ===
              input.actor.type
          ) {
            return current;
          }
          throw approvalConflict();
        }
        if (
          current.status !==
          "approval_required"
        ) {
          throw stateInvalid();
        }
        if (decision === "approved") {
          const binding =
            this.requirePlanAcceptance(
              current.plan
            );
          if (
            binding.decision.actor !==
            input.actor.id
          ) {
            throw approvalConflict();
          }
        }
        const next =
          transitionControlledTransitionOperation(
            current,
            {
              type:
                decision === "approved"
                  ? "approve"
                  : "reject",
              actor: input.actor,
              operationKey:
                input.operationKey,
              planDigest:
                input.planDigest,
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

  private requireLocalAcceptance(
    input: LinearTransitionPreparationInput
  ): LocalAcceptanceBinding {
    const workItem =
      this.#workItems.getWorkItem(
        input.workItemId
      );
    if (
      workItem === null ||
      workItem.status !== "accepted" ||
      workItem.acceptanceDecision ===
        null ||
      workItem.acceptanceDecision
        .decision !== "accepted" ||
      workItem.acceptanceDecision.basis
        ?.decisionId !== input.decisionId
    ) {
      throw acceptanceStale();
    }
    const eventId = acceptanceEventId(
      input.decisionId
    );
    const acceptanceDigest =
      digestAcceptanceDecision({
        workItemId: workItem.id,
        eventId,
        decision:
          workItem.acceptanceDecision
      });
    if (
      acceptanceDigest !==
      input.acceptanceDigest
    ) {
      throw acceptanceStale();
    }
    const links =
      workItem.externalLinks.filter(
        (link) =>
          link.legacy !== true &&
          link.provider === "linear" &&
          link.objectType === "issue" &&
          link.providerObjectKey ===
            `linear:issue:${link.externalId}`
      );
    if (links.length !== 1) {
      throw acceptanceStale();
    }
    const link = links[0];
    if (
      link === undefined ||
      link.legacy === true ||
      !UUID_PATTERN.test(
        link.externalId
      ) ||
      link.scopeRef.kind !== "team" ||
      link.scopeRef.key !==
        `linear:team:${this.#scope.teamId}` ||
      link.scopeRef.parentKey !==
        `linear:organization:${this.#scope.organizationId}`
    ) {
      throw acceptanceStale();
    }
    return {
      workItem,
      decision:
        workItem.acceptanceDecision,
      link,
      eventId,
      acceptanceDigest
    };
  }

  private requirePlanAcceptance(
    plan: ControlledTransitionOperationPlan
  ): LocalAcceptanceBinding {
    const binding =
      this.requireLocalAcceptance({
        workItemId:
          plan.sourceIntent.workItemId,
        decisionId:
          plan.sourceIntent.decisionId,
        acceptanceDigest:
          plan.sourceIntent
            .acceptanceDigest
      });
    if (
      binding.decision.basis
        ?.reviewRevision !==
        plan.sourceIntent
          .reviewRevision ||
      binding.link.externalId !==
        plan.resolvedTarget.issueId ||
      binding.link.lastObservation
        .revisionId !==
        plan.resolvedTarget
          .expectedRevisionId
    ) {
      throw acceptanceStale();
    }
    return binding;
  }

  private async projectSubmission(
    operation: ControlledTransitionOperation,
    update: LinearTransitionUpdateResult,
    occurredAt: string
  ): Promise<ControlledTransitionOperation> {
    if (update.kind === "not_dispatched") {
      return transitionControlledTransitionOperation(
        operation,
        {
          type:
            "submission_not_dispatched",
          occurredAt,
          diagnosticCode:
            update.diagnosticCode
        }
      );
    }
    if (update.kind !== "dispatched") {
      return transitionControlledTransitionOperation(
        operation,
        {
          type:
            "submission_outcome_unknown",
          occurredAt,
          diagnosticCode:
            update.diagnosticCode
        }
      );
    }
    const observed =
      await this.safeReadIssue(
        operation.plan.resolvedTarget
          .issueId
      );
    if (
      observed.kind === "found" &&
      matchesTarget(
        observed.issue,
        operation.plan
      )
    ) {
      return transitionControlledTransitionOperation(
        operation,
        {
          type: "transition_confirmed",
          occurredAt,
          issue:
            projectObservedIssue(
              observed.issue
            )
        }
      );
    }
    return transitionControlledTransitionOperation(
      operation,
      {
        type:
          "submission_outcome_unknown",
        occurredAt,
        diagnosticCode:
          "LINEAR_WRITE_OUTCOME_UNKNOWN"
      }
    );
  }

  private async safeReadIssue(
    issueId: string
  ): Promise<LinearTransitionReadResult> {
    try {
      return await this.#transport.readIssue(
        { issueId }
      );
    } catch {
      return {
        kind: "failed",
        diagnosticCode:
          "LINEAR_RECONCILIATION_FAILED"
      };
    }
  }

  private async recoverInterruptedOperations(): Promise<void> {
    let latest: readonly ProviderOperation[];
    try {
      latest =
        await this.#journal.listLatest();
    } catch (error) {
      throw normalizeJournalError(error);
    }
    for (const observed of latest) {
      if (
        observed.schemaVersion !== 3 ||
        (
          observed.status !==
            "submitting" &&
          observed.status !==
            "reconciling"
        )
      ) {
        continue;
      }
      await this.enqueue(
        observed.plan.operationKey,
        async () => {
          const current =
            await this.readCurrent(
              observed.plan.operationKey
            );
          if (
            current === null ||
            (
              current.status !==
                "submitting" &&
              current.status !==
                "reconciling"
            )
          ) {
            return;
          }
          const next =
            transitionControlledTransitionOperation(
              current,
              current.status ===
              "submitting"
                ? {
                    type:
                      "submission_outcome_unknown",
                    occurredAt:
                      this.captureTimestampNotBefore(
                        current.updatedAt
                      ),
                    diagnosticCode:
                      "LINEAR_WRITE_OUTCOME_UNKNOWN"
                  }
                : {
                    type:
                      "reconciliation_failed",
                    occurredAt:
                      this.captureTimestampNotBefore(
                        current.updatedAt
                      ),
                    diagnosticCode:
                      "LINEAR_RECONCILIATION_FAILED"
                  }
            );
          await this.append(
            current.version,
            next
          );
        }
      );
    }
  }

  private async requireCurrent(
    input: LinearTransitionOperationInput
  ): Promise<ControlledTransitionOperation> {
    const current =
      await this.readCurrent(
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
  ): Promise<ControlledTransitionOperation | null> {
    try {
      const operation =
        await this.#journal.get(
          operationKey
        );
      return operation === null
        ? null
        : requireTransitionOperation(
            operation
          );
    } catch (error) {
      throw normalizeJournalError(error);
    }
  }

  private async append(
    expectedVersion: number,
    next: ControlledTransitionOperation
  ): Promise<AppendResult> {
    try {
      const result =
        await this.#journal.compareAndAppend({
          expectedVersion,
          operationKey:
            next.plan.operationKey,
          planDigest:
            next.plan.planDigest,
          next
        });
      return {
        resolution: result.resolution,
        operation:
          requireTransitionOperation(
            result.operation
          )
      };
    } catch (error) {
      const normalized =
        normalizeJournalError(error);
      if (
        normalized instanceof
          ProviderOperationJournalError &&
        (
          normalized.code ===
            "PROVIDER_OPERATION_JOURNAL_COMMIT_OUTCOME_UNKNOWN" ||
          normalized.code ===
            "PROVIDER_OPERATION_JOURNAL_REOPEN_REQUIRED"
        )
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
      this.#queues.get(operationKey) ??
      Promise.resolve();
    const result = previous.then(
      operation,
      operation
    );
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    this.#queues.set(
      operationKey,
      settled
    );
    void settled.then(() => {
      if (
        this.#queues.get(operationKey) ===
        settled
      ) {
        this.#queues.delete(operationKey);
      }
    });
    return result;
  }

  private async waitForOperation(
    operationKey: string
  ): Promise<void> {
    await (
      this.#queues.get(operationKey) ??
      Promise.resolve()
    );
  }

  private captureTimestamp(): string {
    return normalizeClockValue(
      this.#clock()
    );
  }

  private captureTimestampNotBefore(
    previous: string
  ): string {
    const captured =
      this.captureTimestamp();
    return Date.parse(captured) <
      Date.parse(previous)
      ? previous
      : captured;
  }

  private assertOpen(): void {
    if (this.#reopenRequired) {
      throw reopenRequired();
    }
  }
}

function projectReconciliation(
  operation: ControlledTransitionOperation,
  observed: LinearTransitionReadResult,
  occurredAt: string
): ControlledTransitionOperation {
  if (observed.kind === "found") {
    if (
      matchesTarget(
        observed.issue,
        operation.plan
      )
    ) {
      return transitionControlledTransitionOperation(
        operation,
        {
          type:
            "reconciliation_target_confirmed",
          occurredAt,
          issue:
            projectObservedIssue(
              observed.issue
            )
        }
      );
    }
    if (
      matchesSource(
        observed.issue,
        operation.plan
      )
    ) {
      return transitionControlledTransitionOperation(
        operation,
        {
          type:
            "reconciliation_expected_unchanged",
          occurredAt,
          issue:
            projectObservedIssue(
              observed.issue
            )
        }
      );
    }
    return transitionControlledTransitionOperation(
      operation,
      {
        type:
          "reconciliation_ambiguous",
        occurredAt,
        diagnosticCode:
          "LINEAR_RECONCILIATION_AMBIGUOUS"
      }
    );
  }
  return transitionControlledTransitionOperation(
    operation,
    {
      type:
        observed.kind === "failed"
          ? "reconciliation_failed"
          : "reconciliation_ambiguous",
      occurredAt,
      diagnosticCode:
        observed.kind === "failed"
          ? "LINEAR_RECONCILIATION_FAILED"
          : "LINEAR_RECONCILIATION_AMBIGUOUS"
    }
  );
}

function assertSourcePrecondition(
  observed: LinearTransitionReadResult,
  plan: ControlledTransitionOperationPlan
): void {
  if (observed.kind !== "found") {
    throw preconditionUnavailable();
  }
  if (!matchesSource(observed.issue, plan)) {
    throw preconditionStale();
  }
}

function matchesSource(
  issue: LinearTransitionObservedIssue,
  plan: ControlledTransitionOperationPlan
): boolean {
  return (
    matchesCommon(issue, plan) &&
    issue.placement.stateId ===
      plan.resolvedTarget
        .expectedStateId &&
    issue.revisionId ===
      plan.resolvedTarget
        .expectedRevisionId &&
    (
      issue.stateType === "unstarted" ||
      issue.stateType === "started"
    )
  );
}

function matchesTarget(
  issue: LinearTransitionObservedIssue,
  plan: ControlledTransitionOperationPlan
): boolean {
  return (
    matchesCommon(issue, plan) &&
    issue.placement.stateId ===
      plan.resolvedTarget.targetStateId &&
    issue.stateType === "completed" &&
    Date.parse(issue.revisionId) >=
      Date.parse(
        plan.resolvedTarget
          .expectedRevisionId
      )
  );
}

function matchesCommon(
  issue: LinearTransitionObservedIssue,
  plan: ControlledTransitionOperationPlan
): boolean {
  const target = plan.resolvedTarget;
  return (
    issue.id === target.issueId &&
    issue.placement.organizationId ===
      target.organizationId &&
    issue.placement.teamId ===
      target.teamId &&
    issue.placement.projectId ===
      target.projectId
  );
}

function projectObservedIssue(
  issue: LinearTransitionObservedIssue
): ControlledTransitionObservedIssue {
  return {
    id: issue.id,
    identifier: issue.identifier,
    revisionId: issue.revisionId,
    placement: {
      organizationId:
        issue.placement.organizationId,
      teamId:
        issue.placement.teamId,
      projectId:
        issue.placement.projectId,
      stateId:
        issue.placement.stateId
    }
  };
}

function normalizePreparationInput(
  value: unknown
): LinearTransitionPreparationInput {
  const input = readExactRecord(value, [
    "workItemId",
    "decisionId",
    "acceptanceDigest"
  ]);
  if (
    typeof input.workItemId !==
      "string" ||
    input.workItemId !==
      input.workItemId.trim() ||
    input.workItemId.length === 0 ||
    [...input.workItemId].length > 256 ||
    typeof input.decisionId !==
      "string" ||
    !UUID_V4_PATTERN.test(
      input.decisionId
    )
  ) {
    throw invalidInput();
  }
  return {
    workItemId: input.workItemId,
    decisionId: input.decisionId,
    acceptanceDigest:
      normalizeDigest(
        input.acceptanceDigest
      )
  };
}

function normalizeOperationInput(
  value: unknown
): LinearTransitionOperationInput {
  const input = readExactRecord(value, [
    "operationKey",
    "planDigest"
  ]);
  return {
    operationKey:
      normalizeDigest(
        input.operationKey
      ),
    planDigest:
      normalizeDigest(input.planDigest)
  };
}

function normalizeApprovalInput(
  value: unknown
): LinearTransitionApprovalInput {
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
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
      actor.id
    )
  ) {
    throw invalidInput();
  }
  return {
    ...normalizeOperationInput({
      operationKey:
        input.operationKey,
      planDigest: input.planDigest
    }),
    actor: {
      type: "human",
      id: actor.id
    }
  };
}

function normalizeResolvedScope(
  value: unknown
): NormalizedScope {
  const input = readExactRecord(value, [
    "organizationId",
    "teamId",
    "projectId",
    "expectedStateId",
    "targetStateId"
  ]);
  const scope = {
    organizationId:
      normalizeUuid(
        input.organizationId
      ),
    teamId:
      normalizeUuid(input.teamId),
    projectId:
      normalizeUuid(input.projectId),
    expectedStateId:
      normalizeUuid(
        input.expectedStateId
      ),
    targetStateId:
      normalizeUuid(
        input.targetStateId
      )
  };
  if (
    scope.expectedStateId ===
    scope.targetStateId
  ) {
    throw invalidInput();
  }
  return scope;
}

function requireTransitionOperation(
  operation: ProviderOperation
): ControlledTransitionOperation {
  if (operation.schemaVersion !== 3) {
    throw planConflict();
  }
  return operation;
}

function validateJournal(
  value: unknown
): asserts value is
  LinearTransitionCoordinatorJournalPort {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof Reflect.get(
      value,
      "compareAndAppend"
    ) !== "function" ||
    typeof Reflect.get(value, "get") !==
      "function" ||
    typeof Reflect.get(
      value,
      "history"
    ) !== "function" ||
    typeof Reflect.get(
      value,
      "listLatest"
    ) !== "function"
  ) {
    throw invalidInput();
  }
}

function validateTransport(
  value: unknown
): asserts value is
  LinearTransitionTransportPort {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof Reflect.get(
      value,
      "readIssue"
    ) !== "function" ||
    typeof Reflect.get(
      value,
      "updateIssueState"
    ) !== "function"
  ) {
    throw invalidInput();
  }
}

function validateWorkItems(
  value: unknown
): asserts value is
  LinearTransitionWorkItemPort {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof Reflect.get(
      value,
      "getWorkItem"
    ) !== "function"
  ) {
    throw invalidInput();
  }
}

function normalizeClockValue(
  value: unknown
): string {
  const timestamp =
    value instanceof Date
      ? value.toISOString()
      : value;
  if (
    typeof timestamp !== "string" ||
    timestamp.length > 64 ||
    !Number.isFinite(
      Date.parse(timestamp)
    ) ||
    new Date(
      Date.parse(timestamp)
    ).toISOString() !== timestamp
  ) {
    throw clockInvalid();
  }
  return timestamp;
}

function normalizeUuid(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    throw invalidInput();
  }
  return value;
}

function normalizeDigest(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    !DIGEST_PATTERN.test(value)
  ) {
    throw invalidInput();
  }
  return value;
}

function readExactRecord<
  const Keys extends readonly string[]
>(
  value: unknown,
  expectedKeys: Keys
): Record<Keys[number], unknown> {
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
  const actual = Object.keys(result).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) => key !== expected[index]
    )
  ) {
    throw invalidInput();
  }
  return result as Record<
    Keys[number],
    unknown
  >;
}

function normalizeJournalError(
  error: unknown
):
  | ProviderOperationJournalError
  | LinearTransitionCoordinatorError {
  if (
    error instanceof
    LinearTransitionCoordinatorError
  ) {
    return error;
  }
  if (
    error instanceof
    ProviderOperationJournalError
  ) {
    return error;
  }
  return new LinearTransitionCoordinatorError(
    "LINEAR_TRANSITION_JOURNAL_FAILED",
    "The Linear transition journal operation failed."
  );
}

function invalidInput(): LinearTransitionCoordinatorError {
  return new LinearTransitionCoordinatorError(
    "LINEAR_TRANSITION_INVALID_INPUT",
    "The Linear transition coordinator input is invalid."
  );
}

function acceptanceStale(): LinearTransitionCoordinatorError {
  return new LinearTransitionCoordinatorError(
    "LINEAR_TRANSITION_ACCEPTANCE_STALE",
    "The accepted local delivery no longer matches the transition command."
  );
}

function preconditionUnavailable(): LinearTransitionCoordinatorError {
  return new LinearTransitionCoordinatorError(
    "LINEAR_TRANSITION_PRECONDITION_UNAVAILABLE",
    "The Linear transition precondition could not be read."
  );
}

function preconditionStale(): LinearTransitionCoordinatorError {
  return new LinearTransitionCoordinatorError(
    "LINEAR_TRANSITION_PRECONDITION_STALE",
    "The Linear issue state or revision changed before transition."
  );
}

function planConflict(): LinearTransitionCoordinatorError {
  return new LinearTransitionCoordinatorError(
    "LINEAR_TRANSITION_PLAN_CONFLICT",
    "The Linear transition plan conflicts with persisted history."
  );
}

function approvalConflict(): LinearTransitionCoordinatorError {
  return new LinearTransitionCoordinatorError(
    "LINEAR_TRANSITION_APPROVAL_CONFLICT",
    "The Linear transition approval conflicts with the acceptance actor."
  );
}

function notFound(): LinearTransitionCoordinatorError {
  return new LinearTransitionCoordinatorError(
    "LINEAR_TRANSITION_NOT_FOUND",
    "The Linear transition operation was not found."
  );
}

function stateInvalid(): LinearTransitionCoordinatorError {
  return new LinearTransitionCoordinatorError(
    "LINEAR_TRANSITION_STATE_INVALID",
    "The Linear transition operation is not valid for this action."
  );
}

function reopenRequired(): LinearTransitionCoordinatorError {
  return new LinearTransitionCoordinatorError(
    "LINEAR_TRANSITION_REOPEN_REQUIRED",
    "The Linear transition coordinator must be reopened."
  );
}

function clockInvalid(): LinearTransitionCoordinatorError {
  return new LinearTransitionCoordinatorError(
    "LINEAR_TRANSITION_CLOCK_INVALID",
    "The Linear transition clock is invalid."
  );
}

export class LinearTransitionCoordinatorError
  extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name =
      "LinearTransitionCoordinatorError";
    this.code = code;
  }
}
