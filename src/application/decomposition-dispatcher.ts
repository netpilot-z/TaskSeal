import {
  AttemptRunCoordinator,
  AttemptRunCoordinatorError
} from "./attempt-run-coordinator.ts";
import type {
  AttemptRunExecutionContext,
  AttemptRunStartResult,
  AttemptRunTerminalization
} from "./attempt-run-coordinator.ts";
import type {
  ApprovedDecompositionRecord,
  DecompositionRetirementReasonCode,
  RetiredDecompositionRecord
} from "./decomposition-plan-journal.ts";
import type {
  DigitalEmployeeRegistry,
  PreparedDecompositionPlan,
  PreparedDecompositionNode
} from "./decomposition-plan.ts";
import {
  parsePreparedDecompositionPlan
} from "./decomposition-plan.ts";
import {
  captureDecompositionAttemptBaseline,
  resolveDecompositionAttemptWindow
} from "./decomposition-attempt-baseline.ts";
import type {
  DecompositionAttemptBaseline
} from "./decomposition-attempt-baseline.ts";
import {
  digestCanonicalJson
} from "../lib/canonical-json.ts";
import type {
  RunnerWorkspaceAccess
} from "../runners/runner-contract.ts";
import type {
  Artifact,
  Attempt,
  Evidence,
  WorkItem
} from "../domain/workflow.ts";

export type DecompositionNodePhase =
  | "unknown"
  | "waiting_dependencies"
  | "ready"
  | "running"
  | "awaiting_artifact"
  | "awaiting_evidence"
  | "awaiting_acceptance"
  | "retry_backoff"
  | "blocked"
  | "accepted";

export interface DecompositionBlockingReason {
  readonly code:
    | "WORK_ITEM_MISSING"
    | "DEPENDENCY_NOT_ACCEPTED"
    | "RUNNER_PROFILE_DRIFT"
    | "OWNER_EXECUTION_DRIFT"
    | "PLAN_BASELINE_MISSING"
    | "WORK_ITEM_HISTORY_DRIFT"
    | "DISPATCH_EXECUTION_FAILED"
    | "EVIDENCE_FAILED"
    | "RETRY_EXHAUSTED"
    | "INTERRUPTED_REQUIRES_REVIEW"
    | "HUMAN_REJECTED";
  readonly relatedNodeIds:
    readonly string[];
}

export interface DecompositionNodeProjection {
  readonly nodeId: string;
  readonly workItemId: string;
  readonly phase: DecompositionNodePhase;
  readonly dependsOn: readonly string[];
  readonly owner: {
    readonly runnerId: string;
    readonly profileRevision: string;
    readonly match:
      | "matched"
      | "drifted";
  };
  readonly actualAgentId:
    string | null;
  readonly blockingReasons:
    readonly DecompositionBlockingReason[];
  readonly retry: {
    readonly attempts: number;
    readonly maxAttempts: number;
    readonly nextEligibleAt:
      string | null;
  };
  readonly evidence: {
    readonly passed: number;
    readonly failed: number;
    readonly missing: number;
    readonly total: number;
  };
  readonly attemptTrace:
    readonly Attempt[];
}

export interface DecompositionProjection {
  readonly planId: string;
  readonly planDigest: string;
  readonly rootWorkItemId: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly progress: {
    readonly basis:
      "accepted-nodes";
    readonly acceptedNodes: number;
    readonly totalNodes: number;
    readonly uncertainNodes: number;
  };
  readonly countsByPhase:
    Readonly<
      Record<
        DecompositionNodePhase,
        number
      >
    >;
  readonly queue: {
    readonly durability:
      "ephemeral";
    readonly limit: number;
    readonly queuedCount: number;
    readonly nodeIds:
      readonly string[];
  };
  readonly topologicalOrder:
    readonly string[];
  readonly dispatch: {
    readonly maxParallelism: number;
  };
  readonly activeNodeIds:
    readonly string[];
  readonly nodes:
    readonly DecompositionNodeProjection[];
}

export interface DecompositionPlanQueryPort {
  get(
    planId: string
  ): ApprovedDecompositionRecord | null;
  list():
    readonly ApprovedDecompositionRecord[];
  getRetirement(
    planId: string
  ): RetiredDecompositionRecord | null;
}

export interface DecompositionExecutionOptions {
  readonly workItemId: string;
  readonly runnerId: string;
  readonly instruction: string;
  readonly workspaceAccess:
    RunnerWorkspaceAccess;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly terminalization:
    AttemptRunTerminalization;
}

export interface DecompositionDispatcherOptions {
  readonly plans:
    DecompositionPlanQueryPort;
  readonly registry:
    DigitalEmployeeRegistry;
  readonly getWorkItem: (
    workItemId: string
  ) => WorkItem | null;
  readonly attemptRuns:
    AttemptRunCoordinator;
  readonly execute: (
    options:
      DecompositionExecutionOptions
  ) => unknown | Promise<unknown>;
  readonly approve?:
    | ((input: {
        plan:
          PreparedDecompositionPlan;
        expectedPlanDigest:
          string;
        approvedBy: string;
        approvedAt: string;
        attemptBaselines:
          readonly DecompositionAttemptBaseline[];
      }) =>
        unknown | Promise<unknown>)
    | undefined;
  readonly retire?:
    | ((input: {
        planId: string;
        expectedPlanDigest: string;
        reasonCode:
          DecompositionRetirementReasonCode;
        note: string;
      }) => unknown | Promise<unknown>)
    | undefined;
  readonly now?: (() => Date) | undefined;
}

interface RuntimeDispatchError {
  readonly attemptCount: number;
  readonly code: string;
}

export class DecompositionDispatcher {
  readonly plans:
    DecompositionPlanQueryPort;
  readonly registry:
    DigitalEmployeeRegistry;
  readonly getWorkItem:
    DecompositionDispatcherOptions["getWorkItem"];
  readonly attemptRuns:
    AttemptRunCoordinator;
  readonly execute:
    DecompositionDispatcherOptions["execute"];
  readonly approve:
    | NonNullable<
        DecompositionDispatcherOptions["approve"]
      >
    | null;
  readonly retire:
    | NonNullable<
        DecompositionDispatcherOptions["retire"]
      >
    | null;
  readonly now: () => Date;
  readonly #runtimeErrors:
    Map<string, RuntimeDispatchError>;
  readonly #retiringPlanIds:
    Set<string>;
  readonly #retiringWorkItemIdsByPlanId:
    Map<string, ReadonlySet<string>>;
  readonly #approvingWorkItemIdsByPlanId:
    Map<string, ReadonlySet<string>>;
  readonly #acceptingWorkItemIds:
    Set<string>;

  constructor({
    plans,
    registry,
    getWorkItem,
    attemptRuns,
    execute,
    approve,
    retire,
    now = () => new Date()
  }: DecompositionDispatcherOptions) {
    if (
      !plans ||
      typeof plans.get !== "function" ||
      typeof plans.list !==
        "function" ||
      !registry ||
      typeof registry.matches !==
        "function" ||
      typeof getWorkItem !==
        "function" ||
      !(
        attemptRuns instanceof
        AttemptRunCoordinator
      ) ||
      typeof execute !== "function" ||
      (
        approve !== undefined &&
        typeof approve !==
          "function"
      ) ||
      (
        retire !== undefined &&
        typeof retire !== "function"
      ) ||
      typeof now !== "function"
    ) {
      throw new TypeError(
        "Decomposition dispatcher requires plans, a registry, WorkItems, run coordination, and an executor."
      );
    }
    this.plans = plans;
    this.registry = registry;
    this.getWorkItem = getWorkItem;
    this.attemptRuns = attemptRuns;
    this.execute = execute;
    this.approve =
      approve ?? null;
    this.retire =
      retire ?? null;
    this.now = now;
    this.#runtimeErrors = new Map();
    this.#retiringPlanIds =
      new Set();
    this.#retiringWorkItemIdsByPlanId =
      new Map();
    this.#approvingWorkItemIdsByPlanId =
      new Map();
    this.#acceptingWorkItemIds =
      new Set();
  }

  list():
    readonly DecompositionProjection[] {
    return Object.freeze(
      this.plans
        .list()
        .map((record) =>
          this.projectRecord(record)
        )
        .toSorted((left, right) =>
          compareStrings(
            left.planId,
            right.planId
          )
        )
    );
  }

  project(
    planId: string
  ): DecompositionProjection {
    const record =
      this.plans.get(planId);
    if (!record) {
      throw dispatcherError(
        "DECOMPOSITION_PLAN_NOT_FOUND",
        "The approved decomposition plan does not exist."
      );
    }
    return this.projectRecord(record);
  }

  async approveOnce({
    plan: planValue,
    expectedPlanDigest,
    approvedBy,
    approvedAt
  }: {
    plan: unknown;
    expectedPlanDigest: unknown;
    approvedBy: unknown;
    approvedAt: unknown;
  }) {
    if (this.approve === null) {
      throw dispatcherError(
        "DECOMPOSITION_APPROVAL_DISABLED",
        "Decomposition approval is not available."
      );
    }
    const plan =
      parsePreparedDecompositionPlan(
        planValue
      );
    const planDigest =
      digestCanonicalJson(plan, {
        maxDepth: 12
      });
    if (
      expectedPlanDigest !==
        planDigest
    ) {
      throw dispatcherError(
        "DECOMPOSITION_APPROVAL_STALE",
        "The reviewed decomposition digest no longer matches the plan."
      );
    }
    if (
      typeof approvedBy !==
        "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
        approvedBy
      ) ||
      typeof approvedAt !==
        "string" ||
      !Number.isFinite(
        Date.parse(approvedAt)
      )
    ) {
      throw dispatcherError(
        "DECOMPOSITION_APPROVAL_INVALID",
        "Decomposition approval requires a trusted actor and timestamp."
      );
    }
    const existing =
      this.plans.get(
        plan.planId
      );
    if (existing) {
      if (
        existing.planDigest !==
          planDigest ||
        existing.approvedBy !==
          approvedBy
      ) {
        throw dispatcherError(
          "DECOMPOSITION_PLAN_CONFLICT",
          "The decomposition plan ID is already bound to different approved content."
        );
      }
      return Object.freeze({
        resolution:
          "idempotent" as const,
        record: existing
      });
    }
    if (
      this.plans.getRetirement(
        plan.planId
      )
    ) {
      throw dispatcherError(
        "DECOMPOSITION_PLAN_RETIRED",
        "A retired decomposition plan ID cannot be reactivated."
      );
    }
    const ownedWorkItemIds =
      new Set([
        plan.rootWorkItemId,
        ...plan.nodes.map(
          (node) =>
            node.workItemId
        )
      ]);
    if (
      [
        ...this
          .#approvingWorkItemIdsByPlanId
          .values(),
        ...this
          .#retiringWorkItemIdsByPlanId
          .values()
      ].some((claimed) =>
        [...ownedWorkItemIds].some(
          (workItemId) =>
            claimed.has(
              workItemId
            )
        )
      ) ||
      [...ownedWorkItemIds].some(
        (workItemId) =>
          this.#acceptingWorkItemIds
            .has(workItemId)
      )
    ) {
      throw dispatcherError(
        "DECOMPOSITION_APPROVING",
        "A decomposition lifecycle decision already owns one of these WorkItems."
      );
    }
    this.#approvingWorkItemIdsByPlanId
      .set(
        plan.planId,
        ownedWorkItemIds
      );
    try {
      const activeWorkItems =
        new Set(
          this.attemptRuns
            .snapshot()
            .runs.map(
              (run) =>
                run.workItemId
            )
        );
      const workItems =
        [...ownedWorkItemIds]
          .map((workItemId) =>
            this.getWorkItem(
              workItemId
            )
          );
      if (
        workItems.some(
          (workItem) =>
            workItem === null
        )
      ) {
        throw dispatcherError(
          "DECOMPOSITION_WORK_ITEM_NOT_FOUND",
          "An owned decomposition WorkItem no longer exists."
        );
      }
      if (
        workItems.some(
          (workItem) =>
            workItem?.status ===
              "accepted"
        )
      ) {
        throw dispatcherError(
          "DECOMPOSITION_WORK_ITEM_REOPEN_REQUIRED",
          "An accepted WorkItem must be explicitly reopened before a new decomposition can own it."
        );
      }
      if (
        [...ownedWorkItemIds].some(
          (workItemId) =>
            activeWorkItems.has(
              workItemId
            )
        ) ||
        workItems.some(
          (workItem) =>
            workItem?.status ===
              "running"
        )
      ) {
        throw dispatcherError(
          "DECOMPOSITION_APPROVAL_ACTIVE",
          "A decomposition cannot be approved while an owned WorkItem is active."
        );
      }
      const attemptBaselines =
        Object.freeze(
          workItems
            .map((workItem) =>
              captureDecompositionAttemptBaseline(
                workItem!
              )
            )
            .toSorted(
              (left, right) =>
                compareStrings(
                  left.workItemId,
                  right.workItemId
                )
            )
        );
      return await this.approve({
        plan,
        expectedPlanDigest:
          planDigest,
        approvedBy,
        approvedAt:
          new Date(
            approvedAt
          ).toISOString(),
        attemptBaselines
      });
    } finally {
      this.#approvingWorkItemIdsByPlanId
        .delete(plan.planId);
    }
  }

  async retireOnce({
    planId,
    expectedPlanDigest,
    reasonCode,
    note
  }: {
    planId: string;
    expectedPlanDigest: string;
    reasonCode:
      DecompositionRetirementReasonCode;
    note: string;
  }) {
    if (this.retire === null) {
      throw dispatcherError(
        "DECOMPOSITION_RETIREMENT_DISABLED",
        "Decomposition retirement is not available."
      );
    }
    if (
      this.#retiringPlanIds.has(
        planId
      )
    ) {
      throw dispatcherError(
        "DECOMPOSITION_RETIRING",
        "The decomposition plan is already being retired."
      );
    }
    const record =
      this.plans.get(planId);
    if (!record) {
      const retirement =
        this.plans.getRetirement(
          planId
        );
      if (!retirement) {
        throw dispatcherError(
          "DECOMPOSITION_PLAN_NOT_FOUND",
          "The approved decomposition plan does not exist."
        );
      }
      if (
        retirement.planDigest !==
        expectedPlanDigest
      ) {
        throw dispatcherError(
          "DECOMPOSITION_RETIREMENT_STALE",
          "The decomposition retirement revision is stale."
        );
      }
      this.#retiringPlanIds.add(
        planId
      );
      try {
        return await this.retire({
          planId,
          expectedPlanDigest,
          reasonCode,
          note
        });
      } finally {
        this.#retiringPlanIds.delete(
          planId
        );
      }
    }
    if (
      record.planDigest !==
      expectedPlanDigest
    ) {
      throw dispatcherError(
        "DECOMPOSITION_RETIREMENT_STALE",
        "The decomposition retirement revision is stale."
      );
    }
    const ownedWorkItemIds =
      new Set([
        record.plan.rootWorkItemId,
        ...record.plan.nodes.map(
          (node) =>
            node.workItemId
        )
      ]);
    this.#retiringPlanIds.add(
      planId
    );
    this.#retiringWorkItemIdsByPlanId
      .set(
        planId,
        ownedWorkItemIds
      );
    try {
      const active =
        this.attemptRuns
          .snapshot()
          .runs.some((run) =>
            ownedWorkItemIds.has(
              run.workItemId
            )
          ) ||
        [...ownedWorkItemIds].some(
          (workItemId) =>
            this.getWorkItem(
              workItemId
            )?.status ===
              "running"
        ) ||
        [...ownedWorkItemIds].some(
          (workItemId) =>
            this.#acceptingWorkItemIds
              .has(workItemId)
        );
      if (active) {
        throw dispatcherError(
          "DECOMPOSITION_RETIREMENT_ACTIVE",
          "The decomposition plan cannot retire while an owned WorkItem is active."
        );
      }
      return await this.retire({
        planId,
        expectedPlanDigest,
        reasonCode,
        note
      });
    } finally {
      this.#retiringPlanIds.delete(
        planId
      );
      this.#retiringWorkItemIdsByPlanId
        .delete(planId);
    }
  }

  dispatchOnce({
    planId,
    expectedPlanDigest
  }: {
    planId: string;
    expectedPlanDigest: string;
  }) {
    const record =
      this.plans.get(planId);
    if (!record) {
      throw dispatcherError(
        "DECOMPOSITION_PLAN_NOT_FOUND",
        "The approved decomposition plan does not exist."
      );
    }
    if (
      this.#retiringPlanIds.has(
        planId
      )
    ) {
      throw dispatcherError(
        "DECOMPOSITION_RETIRING",
        "The decomposition plan is being retired."
      );
    }
    if (
      record.planDigest !==
      expectedPlanDigest
    ) {
      throw dispatcherError(
        "DECOMPOSITION_DISPATCH_STALE",
        "The requested decomposition revision is stale."
      );
    }

    for (const node of record.plan.nodes) {
      this.#runtimeErrors.delete(
        runtimeErrorKey(
          record.plan.planId,
          node.nodeId
        )
      );
    }

    const before =
      this.projectRecord(record);
    const readyById = new Map(
      before.nodes
        .filter(
          (node) =>
            node.phase === "ready"
        )
        .map((node) => [
          node.nodeId,
          node
        ])
    );
    const readyNodes =
      record.plan.topologicalOrder
        .filter((nodeId) =>
          readyById.has(nodeId)
        )
        .map((nodeId) =>
          record.plan.nodes.find(
            (node) =>
              node.nodeId === nodeId
          )
        )
        .filter(
          (
            node
          ): node is PreparedDecompositionNode =>
            node !== undefined
        );

    if (readyNodes.length === 0) {
      throw dispatcherError(
        "DECOMPOSITION_NOT_DISPATCHABLE",
        "The approved decomposition has no dispatchable node."
      );
    }

    const activeWorkItems =
      new Set(
        this.attemptRuns
          .snapshot()
          .runs.map(
            (run) => run.workItemId
          )
      );
    const activePlanCount =
      record.plan.nodes.filter(
        (node) =>
          activeWorkItems.has(
            node.workItemId
          )
      ).length;
    let availableForPlan = Math.max(
      0,
      record.plan.dispatch
        .maxParallelism -
        activePlanCount
    );
    const startedNodeIds: string[] =
      [];

    for (const node of readyNodes) {
      const coordination =
        this.attemptRuns.snapshot();
      if (
        availableForPlan === 0 ||
        coordination.availableSlots === 0
      ) {
        break;
      }
      const workItem =
        this.getWorkItem(
          node.workItemId
        );
      const attemptWindow =
        workItem === null
          ? missingAttemptWindow()
          : resolvePlanAttemptWindow(
              record,
              workItem
            );
      const attemptCount =
        attemptWindow.status ===
          "matched"
          ? attemptWindow.attempts
              .length
          : 0;
      try {
        const run =
          this.attemptRuns.start({
            workItemId:
              node.workItemId,
            execute: ({
              signal,
              terminalization
            }) =>
              this.execute({
                workItemId:
                  node.workItemId,
                runnerId:
                  node.owner.runnerId,
                instruction:
                  node.instruction,
                workspaceAccess:
                  node.execution
                    .workspaceAccess,
                timeoutMs:
                  node.execution
                    .timeoutMs,
                signal,
                terminalization
              })
          });
        startedNodeIds.push(
          node.nodeId
        );
        availableForPlan -= 1;
        void run.execution.then(
          () => {
            this.#runtimeErrors.delete(
              runtimeErrorKey(
                record.plan.planId,
                node.nodeId
              )
            );
          },
          (error) => {
            this.#runtimeErrors.set(
              runtimeErrorKey(
                record.plan.planId,
                node.nodeId
              ),
              {
                attemptCount,
                code:
                  readSafeErrorCode(
                    error
                  )
              }
            );
          }
        );
      } catch (error) {
        if (
          error instanceof
            AttemptRunCoordinatorError &&
          error.code ===
            "RUN_CAPACITY_REACHED"
        ) {
          break;
        }
        throw error;
      }
    }

    if (startedNodeIds.length === 0) {
      throw dispatcherError(
        "DECOMPOSITION_CAPACITY_REACHED",
        "No execution capacity is available for the approved decomposition."
      );
    }
    const started = new Set(
      startedNodeIds
    );
    return Object.freeze({
      startedNodeIds:
        Object.freeze([
          ...startedNodeIds
        ]),
      queuedNodeIds:
        Object.freeze(
          readyNodes
            .map((node) => node.nodeId)
            .filter(
              (nodeId) =>
                !started.has(nodeId)
            )
        ),
      projection:
        this.projectRecord(record)
    });
  }

  assertManualRunAllowed(
    workItemId: string
  ): void {
    const approving =
      [
        ...this
          .#approvingWorkItemIdsByPlanId
          .values()
      ].some((ownedWorkItemIds) =>
        ownedWorkItemIds.has(
          workItemId
        )
      );
    const retiring =
      [
        ...this
          .#retiringWorkItemIdsByPlanId
          .values()
      ].some((ownedWorkItemIds) =>
        ownedWorkItemIds.has(
          workItemId
        )
      );
    const accepting =
      this.#acceptingWorkItemIds
        .has(workItemId);
    if (
      approving ||
      retiring ||
      accepting
    ) {
      throw dispatcherError(
        approving
          ? "DECOMPOSITION_APPROVING"
          : retiring
            ? "DECOMPOSITION_RETIRING"
            : "DECOMPOSITION_ACCEPTING",
        "This WorkItem cannot start while its decomposition lifecycle is changing."
      );
    }
    assertManualDecompositionRunAllowed(
      this.plans,
      this.getWorkItem,
      this.registry,
      workItemId
    );
  }

  startManualRun({
    workItemId,
    execute
  }: {
    workItemId: string;
    execute: (
      context:
        AttemptRunExecutionContext
    ) => unknown | Promise<unknown>;
  }): AttemptRunStartResult {
    this.assertManualRunAllowed(
      workItemId
    );
    return this.attemptRuns.start({
      workItemId,
      execute
    });
  }

  assertAcceptanceAllowed(
    workItemId: string,
    decision:
      | "accepted"
      | "rejected"
  ): void {
    assertDecompositionAcceptanceAllowed(
      this.plans,
      this.getWorkItem,
      this.registry,
      workItemId,
      decision
    );
  }

  async decideAcceptanceOnce<T>({
    workItemId,
    decision,
    decide
  }: {
    workItemId: string;
    decision:
      | "accepted"
      | "rejected";
    decide: () =>
      T | Promise<T>;
  }): Promise<T> {
    if (typeof decide !== "function") {
      throw new TypeError(
        "Decomposition acceptance requires a decision callback."
      );
    }
    const approving =
      [
        ...this
          .#approvingWorkItemIdsByPlanId
          .values()
      ].some((claimed) =>
        claimed.has(workItemId)
      );
    const retiring =
      [
        ...this
          .#retiringWorkItemIdsByPlanId
          .values()
      ].some((claimed) =>
        claimed.has(workItemId)
      );
    const accepting =
      this.#acceptingWorkItemIds
        .has(workItemId);
    if (
      approving ||
      retiring ||
      accepting
    ) {
      throw dispatcherError(
        approving
          ? "DECOMPOSITION_APPROVING"
          : retiring
            ? "DECOMPOSITION_RETIRING"
            : "DECOMPOSITION_ACCEPTING",
        "A decomposition lifecycle decision already owns this WorkItem."
      );
    }
    this.#acceptingWorkItemIds.add(
      workItemId
    );
    try {
      const record =
        this.plans
          .list()
          .find((candidate) =>
            ownsWorkItem(
              candidate,
              workItemId
            )
          );
      if (record) {
        this.assertAcceptanceAllowed(
          workItemId,
          decision
        );
      }
      return await decide();
    } finally {
      this.#acceptingWorkItemIds.delete(
        workItemId
      );
    }
  }

  projectRecord(
    record:
      ApprovedDecompositionRecord
  ): DecompositionProjection {
    const activeWorkItems = new Set(
      this.attemptRuns
        .snapshot()
        .runs.map(
          (run) => run.workItemId
        )
    );
    const nodeById = new Map(
      record.plan.nodes.map(
        (node) => [
          node.nodeId,
          node
        ])
    );
    const workItemByNode = new Map(
      record.plan.nodes.map(
        (node) => [
          node.nodeId,
          this.getWorkItem(
            node.workItemId
          )
        ])
    );
    const nodes =
      record.plan.nodes.map((node) =>
        projectNode({
          record,
          node,
          nodeById,
          workItemByNode,
          activeWorkItems,
          registry: this.registry,
          runtimeError:
            this.#runtimeErrors.get(
              runtimeErrorKey(
                record.plan.planId,
                node.nodeId
              )
            ) ?? null,
          now: this.now()
        })
      ).toSorted((left, right) =>
        compareStrings(
          left.nodeId,
          right.nodeId
        )
      );
    const projectedById =
      new Map(
        nodes.map((node) => [
          node.nodeId,
          node
        ])
      );
    const queueNodeIds =
      record.plan.topologicalOrder
        .filter(
          (nodeId) =>
            projectedById.get(
              nodeId
            )?.phase === "ready"
        );
    const countsByPhase =
      emptyPhaseCounts();
    for (const node of nodes) {
      countsByPhase[node.phase] += 1;
    }
    const acceptedNodes =
      countsByPhase.accepted;
    const activeNodeIds =
      record.plan.topologicalOrder
        .filter((nodeId) => {
          const node =
            nodeById.get(nodeId);
          return (
            node !== undefined &&
            activeWorkItems.has(
              node.workItemId
            )
          );
        });

    return Object.freeze({
      planId: record.plan.planId,
      planDigest: record.planDigest,
      rootWorkItemId:
        record.plan.rootWorkItemId,
      approvedBy: record.approvedBy,
      approvedAt: record.approvedAt,
      progress: Object.freeze({
        basis:
          "accepted-nodes" as const,
        acceptedNodes,
        totalNodes: nodes.length,
        uncertainNodes:
          nodes.length -
          acceptedNodes
      }),
      countsByPhase:
        Object.freeze(
          countsByPhase
        ),
      queue: Object.freeze({
        durability:
          "ephemeral" as const,
        limit:
          record.plan.dispatch
            .maxQueuedNodes,
        queuedCount:
          queueNodeIds.length,
        nodeIds:
          Object.freeze([
            ...queueNodeIds
          ])
      }),
      topologicalOrder:
        record.plan.topologicalOrder,
      dispatch: Object.freeze({
        maxParallelism:
          record.plan.dispatch
            .maxParallelism
      }),
      activeNodeIds:
        Object.freeze([
          ...activeNodeIds
        ]),
      nodes: Object.freeze(nodes)
    });
  }
}

export function assertManualDecompositionRunAllowed(
  plans: DecompositionPlanQueryPort,
  getWorkItem: (
    workItemId: string
  ) => WorkItem | null,
  registry:
    DigitalEmployeeRegistry,
  workItemId: string
): void {
  for (const record of plans.list()) {
    if (
      record.plan.nodes.some(
        (node) =>
          node.workItemId ===
          workItemId
      )
    ) {
      throw dispatcherError(
        "DECOMPOSITION_MANAGED_WORK_ITEM",
        "This WorkItem is controlled by an approved decomposition and must use DAG dispatch."
      );
    }
    if (
      record.plan.rootWorkItemId ===
        workItemId &&
      record.plan.nodes.some(
        (node) =>
          !isPlanNodeAccepted(
            record,
            node,
            getWorkItem(
              node.workItemId
            ),
            registry
          )
      )
    ) {
      throw dispatcherError(
        "DECOMPOSITION_ROOT_NOT_READY",
        "The decomposition root cannot run until every node is accepted."
      );
    }
  }
}

export function assertDecompositionAcceptanceAllowed(
  plans: DecompositionPlanQueryPort,
  getWorkItem: (
    workItemId: string
  ) => WorkItem | null,
  registry:
    DigitalEmployeeRegistry,
  workItemId: string,
  decision:
    | "accepted"
    | "rejected"
): void {
  if (
    decision !== "accepted" &&
    decision !== "rejected"
  ) {
    throw new TypeError(
      "Decomposition acceptance requires a decision."
    );
  }
  for (const record of plans.list()) {
    const node =
      record.plan.nodes.find(
        (candidate) =>
          candidate.workItemId ===
          workItemId
      );
    if (node) {
      const nodeById = new Map(
        record.plan.nodes.map(
          (candidate) => [
            candidate.nodeId,
            candidate
          ]
        )
      );
      const dependenciesAccepted =
        node.dependsOn.every(
          (dependencyId) => {
            const dependency =
              nodeById.get(
                dependencyId
              );
            return (
              dependency !==
                undefined &&
              isPlanNodeAccepted(
                record,
                dependency,
                getWorkItem(
                  dependency.workItemId
                ),
                registry
              )
            );
          }
        );
      if (!dependenciesAccepted) {
        throw dispatcherError(
          "DECOMPOSITION_DEPENDENCY_NOT_ACCEPTED",
          "The decomposition node cannot be accepted before every dependency is accepted."
        );
      }
      if (
        decision === "accepted"
      ) {
        assertPlanAcceptanceAttempt({
          record,
          node,
          workItem:
            getWorkItem(
              workItemId
            ),
          registry
        });
      }
    }
    if (
      record.plan.rootWorkItemId ===
        workItemId &&
      record.plan.nodes.some(
        (node) =>
          !isPlanNodeAccepted(
            record,
            node,
            getWorkItem(
              node.workItemId
            ),
            registry
          )
      )
    ) {
      throw dispatcherError(
        "DECOMPOSITION_ROOT_NOT_READY",
        "The decomposition root cannot be accepted until every node is accepted."
      );
    }
    if (
      record.plan.rootWorkItemId ===
        workItemId &&
      decision === "accepted"
    ) {
      assertPlanAcceptanceAttempt({
        record,
        node: null,
        workItem:
          getWorkItem(
            workItemId
          ),
        registry
      });
    }
  }
}

type PlanAttemptWindow =
  | {
      readonly status:
        "matched";
      readonly attempts:
        readonly Attempt[];
    }
  | {
      readonly status:
        | "baseline_missing"
        | "history_drift"
        | "work_item_missing";
      readonly attempts:
        readonly [];
    };

function ownsWorkItem(
  record:
    ApprovedDecompositionRecord,
  workItemId: string
): boolean {
  return (
    record.plan.rootWorkItemId ===
      workItemId ||
    record.plan.nodes.some(
      (node) =>
        node.workItemId ===
        workItemId
    )
  );
}

function resolvePlanAttemptWindow(
  record:
    ApprovedDecompositionRecord,
  workItem: WorkItem
): PlanAttemptWindow {
  if (
    record.schemaVersion !== "2"
  ) {
    return unavailableAttemptWindow(
      "baseline_missing"
    );
  }
  const baseline =
    record.attemptBaselines.find(
      (candidate) =>
        candidate.workItemId ===
        workItem.id
    );
  if (!baseline) {
    return unavailableAttemptWindow(
      "baseline_missing"
    );
  }
  const resolved =
    resolveDecompositionAttemptWindow(
      baseline,
      workItem
    );
  return resolved.matched
    ? Object.freeze({
        status:
          "matched" as const,
        attempts:
          resolved.attempts
      })
    : unavailableAttemptWindow(
        "history_drift"
      );
}

function missingAttemptWindow():
  PlanAttemptWindow {
  return unavailableAttemptWindow(
    "work_item_missing"
  );
}

function unavailableAttemptWindow(
  status:
    | "baseline_missing"
    | "history_drift"
    | "work_item_missing"
): PlanAttemptWindow {
  return Object.freeze({
    status,
    attempts:
      Object.freeze([]) as
        readonly []
  });
}

function findActivePlanAttempt(
  workItem: WorkItem,
  attempts:
    readonly Attempt[]
): Attempt | null {
  if (
    workItem.activeAttemptId ===
      null
  ) {
    return null;
  }
  return (
    attempts.find(
      (attempt) =>
        attempt.id ===
          workItem.activeAttemptId
    ) ?? null
  );
}

function isPlanNodeAccepted(
  record:
    ApprovedDecompositionRecord,
  node:
    PreparedDecompositionNode,
  workItem: WorkItem | null,
  registry:
    DigitalEmployeeRegistry
): boolean {
  if (
    workItem === null ||
    workItem.status !==
      "accepted" ||
    !registry.matches(node)
  ) {
    return false;
  }
  const window =
    resolvePlanAttemptWindow(
      record,
      workItem
    );
  if (
    window.status !== "matched"
  ) {
    return false;
  }
  const attempt =
    findActivePlanAttempt(
      workItem,
      window.attempts
    );
  return (
    attempt !== null &&
    attempt.agentId ===
      node.owner.runnerId &&
    (
      attempt.status ===
        "completed" ||
      attempt.runtimeOutcome ===
        "completed"
    ) &&
    workItem.acceptanceDecision
      ?.decision === "accepted" &&
    workItem.acceptanceDecision
      .basis?.attemptId ===
        attempt.id
  );
}

function assertPlanAcceptanceAttempt({
  record,
  node,
  workItem,
  registry
}: {
  record:
    ApprovedDecompositionRecord;
  node:
    PreparedDecompositionNode | null;
  workItem: WorkItem | null;
  registry:
    DigitalEmployeeRegistry;
}): void {
  if (workItem === null) {
    throw dispatcherError(
      "DECOMPOSITION_WORK_ITEM_NOT_FOUND",
      "The decomposition WorkItem does not exist."
    );
  }
  const window =
    resolvePlanAttemptWindow(
      record,
      workItem
    );
  if (
    window.status ===
      "baseline_missing"
  ) {
    throw dispatcherError(
      "DECOMPOSITION_BASELINE_MISSING",
      "The legacy decomposition approval has no trusted Attempt baseline."
    );
  }
  if (
    window.status !== "matched"
  ) {
    throw dispatcherError(
      "DECOMPOSITION_WORK_ITEM_HISTORY_DRIFT",
      "The WorkItem Attempt history no longer matches the approved baseline."
    );
  }
  const attempt =
    findActivePlanAttempt(
      workItem,
      window.attempts
    );
  if (attempt === null) {
    throw dispatcherError(
      "DECOMPOSITION_ATTEMPT_OUTSIDE_PLAN",
      "Acceptance requires a current Attempt created after this plan was approved."
    );
  }
  if (
    node !== null &&
    (
      attempt.agentId !==
        node.owner.runnerId
    )
  ) {
    throw dispatcherError(
      "DECOMPOSITION_OWNER_EXECUTION_DRIFT",
      "The current Attempt was not executed by the approved digital employee."
    );
  }
  if (
    node !== null &&
    !registry.matches(node)
  ) {
    throw dispatcherError(
      "DECOMPOSITION_RUNNER_PROFILE_DRIFT",
      "The approved digital employee profile has changed."
    );
  }
  if (
    attempt.status !==
      "completed" &&
    attempt.runtimeOutcome !==
      "completed"
  ) {
    throw dispatcherError(
      "DECOMPOSITION_ATTEMPT_NOT_COMPLETED",
      "Acceptance requires a completed current-plan Attempt."
    );
  }
}

function isRejectedForAttempt(
  workItem: WorkItem,
  attemptId: string
): boolean {
  return (
    workItem.acceptanceDecision
      ?.decision === "rejected" &&
    workItem.acceptanceDecision
      .basis?.attemptId ===
        attemptId
  );
}

function emptyEvidence(
  total: number
) {
  return {
    passed: 0,
    failed: 0,
    missing: total,
    total
  };
}

function projectNode({
  record,
  node,
  nodeById,
  workItemByNode,
  activeWorkItems,
  registry,
  runtimeError,
  now
}: {
  record:
    ApprovedDecompositionRecord;
  node: PreparedDecompositionNode;
  nodeById: ReadonlyMap<
    string,
    PreparedDecompositionNode
  >;
  workItemByNode: ReadonlyMap<
    string,
    WorkItem | null
  >;
  activeWorkItems:
    ReadonlySet<string>;
  registry:
    DigitalEmployeeRegistry;
  runtimeError:
    RuntimeDispatchError | null;
  now: Date;
}): DecompositionNodeProjection {
  const workItem =
    workItemByNode.get(node.nodeId) ??
    null;
  const ownerMatched =
    registry.matches(node);
  const dependencies =
    node.dependsOn.filter(
      (dependencyId) => {
        const dependency =
          nodeById.get(
            dependencyId
          );
        if (!dependency) {
          return true;
        }
        return !isPlanNodeAccepted(
          record,
          dependency,
          workItemByNode.get(
            dependencyId
          ) ?? null,
          registry
        );
      }
    );
  const blockers:
    DecompositionBlockingReason[] =
    [];
  let phase:
    DecompositionNodePhase;
  let nextEligibleAt:
    string | null = null;
  const attemptWindow =
    workItem === null
      ? missingAttemptWindow()
      : resolvePlanAttemptWindow(
          record,
          workItem
        );
  const planAttempts =
    attemptWindow.status ===
      "matched"
      ? attemptWindow.attempts
      : [];
  const latestAttempt =
    workItem === null ||
    attemptWindow.status !==
      "matched"
      ? null
      : findActivePlanAttempt(
          workItem,
          planAttempts
        );
  const accepted =
    isPlanNodeAccepted(
      record,
      node,
      workItem,
      registry
    );
  const evidence =
    workItem !== null &&
    latestAttempt !== null
      ? projectEvidence(workItem)
      : emptyEvidence(
          workItem
            ?.requiredEvidence
            .length ??
            node
              .acceptanceCriteria
              .length
        );

  if (!workItem) {
    phase = "unknown";
    blockers.push(
      blockingReason(
        "WORK_ITEM_MISSING"
      )
    );
  } else if (
    attemptWindow.status ===
      "baseline_missing"
  ) {
    phase = "blocked";
    blockers.push(
      blockingReason(
        "PLAN_BASELINE_MISSING"
      )
    );
  } else if (
    attemptWindow.status ===
      "history_drift"
  ) {
    phase = "blocked";
    blockers.push(
      blockingReason(
        "WORK_ITEM_HISTORY_DRIFT"
      )
    );
  } else if (
    accepted
  ) {
    phase = "accepted";
  } else if (
    activeWorkItems.has(
      node.workItemId
    ) ||
    latestAttempt?.status ===
      "running"
  ) {
    phase = "running";
  } else if (!ownerMatched) {
    phase = "blocked";
    blockers.push(
      blockingReason(
        "RUNNER_PROFILE_DRIFT"
      )
    );
  } else if (
    dependencies.length > 0
  ) {
    phase =
      "waiting_dependencies";
    blockers.push({
      code:
        "DEPENDENCY_NOT_ACCEPTED",
      relatedNodeIds:
        Object.freeze([
          ...dependencies
        ])
    });
  } else if (
    runtimeError !== null &&
    runtimeError.attemptCount ===
      planAttempts.length
  ) {
    phase = "blocked";
    blockers.push(
      blockingReason(
        "DISPATCH_EXECUTION_FAILED"
      )
    );
  } else if (
    latestAttempt === null
  ) {
    if (
      workItem.status ===
        "running" ||
      workItem.status ===
        "accepted"
    ) {
      phase = "blocked";
      blockers.push(
        blockingReason(
          "WORK_ITEM_HISTORY_DRIFT"
        )
      );
    } else {
      phase = "ready";
    }
  } else if (
    latestAttempt.agentId !==
      node.owner.runnerId
  ) {
    phase = "blocked";
    blockers.push(
      blockingReason(
        "OWNER_EXECUTION_DRIFT"
      )
    );
  } else if (
    isRejectedForAttempt(
      workItem,
      latestAttempt.id
    )
  ) {
    phase = "blocked";
    blockers.push(
      blockingReason(
        "HUMAN_REJECTED"
      )
    );
  } else if (
    evidence.failed > 0
  ) {
    phase = "blocked";
    blockers.push(
      blockingReason(
        "EVIDENCE_FAILED"
      )
    );
  } else if (
    latestAttempt.runtimeOutcome ===
        "interrupted" ||
    latestAttempt.status ===
        "interrupted"
  ) {
    phase = "blocked";
    blockers.push(
      blockingReason(
        "INTERRUPTED_REQUIRES_REVIEW"
      )
    );
  } else if (
    latestAttempt.runtimeOutcome ===
        "failed" ||
    latestAttempt.status ===
        "failed"
  ) {
    if (
      planAttempts.length >=
      node.retryPolicy.maxAttempts
    ) {
      phase = "blocked";
      blockers.push(
        blockingReason(
          "RETRY_EXHAUSTED"
        )
      );
    } else {
      nextEligibleAt =
        computeNextEligibleAt(
          latestAttempt,
          node.retryPolicy
            .backoffMs
        );
      phase =
        nextEligibleAt !== null &&
        Date.parse(nextEligibleAt) >
          now.getTime()
          ? "retry_backoff"
          : "ready";
    }
  } else if (
    latestAttempt.status ===
      "completed" ||
    latestAttempt.runtimeOutcome ===
      "completed"
  ) {
    if (
      findActiveArtifact(
        workItem
      ) === null
    ) {
      phase = "awaiting_artifact";
    } else if (
      evidence.missing > 0
    ) {
      phase = "awaiting_evidence";
    } else {
      phase =
        "awaiting_acceptance";
    }
  } else {
    phase = "blocked";
    blockers.push(
      blockingReason(
        "WORK_ITEM_HISTORY_DRIFT"
      )
    );
  }

  return Object.freeze({
    nodeId: node.nodeId,
    workItemId: node.workItemId,
    phase,
    dependsOn: node.dependsOn,
    owner: Object.freeze({
      runnerId:
        node.owner.runnerId,
      profileRevision:
        node.owner.profileRevision,
      match: ownerMatched
        ? "matched" as const
        : "drifted" as const
    }),
    actualAgentId:
      latestAttempt?.agentId ?? null,
    blockingReasons:
      Object.freeze(blockers),
    retry: Object.freeze({
      attempts:
        planAttempts.length,
      maxAttempts:
        node.retryPolicy.maxAttempts,
      nextEligibleAt
    }),
    evidence: Object.freeze(evidence),
    attemptTrace:
      Object.freeze(
        workItem === null
          ? []
          : structuredClone(
              planAttempts
            )
      )
  });
}

function projectEvidence(
  workItem: WorkItem
) {
  const activeArtifact =
    findActiveArtifact(workItem);
  if (!activeArtifact) {
    return {
      passed: 0,
      failed: 0,
      missing:
        workItem.requiredEvidence
          .length,
      total:
        workItem.requiredEvidence
          .length
    };
  }
  const latestByCriterion =
    new Map<string, Evidence>();
  for (const evidence of workItem.evidence) {
    if (
      evidence.attemptId !==
        workItem.activeAttemptId ||
      evidence.artifactId !==
        activeArtifact.id ||
      evidence.revision !==
        activeArtifact.revision ||
      !workItem.requiredEvidence.includes(
        evidence.criterionKey
      )
    ) {
      continue;
    }
    const prior =
      latestByCriterion.get(
        evidence.criterionKey
      );
    if (
      prior === undefined ||
      Date.parse(evidence.recordedAt) >
        Date.parse(prior.recordedAt)
    ) {
      latestByCriterion.set(
        evidence.criterionKey,
        evidence
      );
    }
  }
  let passed = 0;
  let failed = 0;
  for (const evidence of latestByCriterion.values()) {
    if (evidence.outcome === "passed") {
      passed += 1;
    } else {
      failed += 1;
    }
  }
  return {
    passed,
    failed,
    missing:
      workItem.requiredEvidence.length -
      latestByCriterion.size,
    total:
      workItem.requiredEvidence.length
  };
}

function findActiveArtifact(
  workItem: WorkItem
): Artifact | null {
  if (
    workItem.activeArtifact === null ||
    workItem.activeAttemptId === null
  ) {
    return null;
  }
  return (
    workItem.artifacts.find(
      (artifact) =>
        artifact.id ===
          workItem.activeArtifact
            ?.artifactId &&
        artifact.revision ===
          workItem.activeArtifact
            ?.revision &&
        artifact.attemptId ===
          workItem.activeAttemptId
    ) ?? null
  );
}

function computeNextEligibleAt(
  attempt: Attempt,
  backoffMs: number
): string | null {
  if (
    backoffMs === 0 ||
    attempt.completedAt === undefined
  ) {
    return null;
  }
  const completedAt = Date.parse(
    attempt.completedAt
  );
  if (!Number.isFinite(completedAt)) {
    return null;
  }
  return new Date(
    completedAt + backoffMs
  ).toISOString();
}

function blockingReason(
  code:
    DecompositionBlockingReason["code"]
): DecompositionBlockingReason {
  return Object.freeze({
    code,
    relatedNodeIds:
      Object.freeze([])
  });
}

function emptyPhaseCounts():
  Record<
    DecompositionNodePhase,
    number
  > {
  return {
    unknown: 0,
    waiting_dependencies: 0,
    ready: 0,
    running: 0,
    awaiting_artifact: 0,
    awaiting_evidence: 0,
    awaiting_acceptance: 0,
    retry_backoff: 0,
    blocked: 0,
    accepted: 0
  };
}

function runtimeErrorKey(
  planId: string,
  nodeId: string
): string {
  return `${planId}\u0000${nodeId}`;
}

function readSafeErrorCode(
  error: unknown
): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(
      error.code
    )
  ) {
    return error.code;
  }
  return "DISPATCH_EXECUTION_FAILED";
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

function dispatcherError(
  code: string,
  message: string
): DecompositionDispatcherError {
  return new DecompositionDispatcherError(
    code,
    message
  );
}

export class DecompositionDispatcherError extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string
  ) {
    super(message);
    this.name =
      "DecompositionDispatcherError";
    this.code = code;
  }
}
