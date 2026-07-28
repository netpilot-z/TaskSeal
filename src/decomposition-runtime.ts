import { join } from "node:path";

import {
  assertDecompositionAcceptanceAllowed,
  assertManualDecompositionRunAllowed,
  DecompositionDispatcher
} from "./application/decomposition-dispatcher.ts";
import type {
  DecompositionDispatcherOptions
} from "./application/decomposition-dispatcher.ts";
import {
  DecompositionPlanJournal
} from "./application/decomposition-plan-journal.ts";
import {
  createDigitalEmployeeRegistry,
  prepareDecompositionPlan
} from "./application/decomposition-plan.ts";
import type {
  DecompositionPlanPreview,
  DigitalEmployeeRegistry
} from "./application/decomposition-plan.ts";
import type {
  DecompositionApprovalResult,
  DecompositionRetirementReasonCode,
  RetiredDecompositionRecord
} from "./application/decomposition-plan-journal.ts";
import type {
  AttemptRunCoordinator
} from "./application/attempt-run-coordinator.ts";
import type {
  WorkItem
} from "./domain/workflow.ts";
import type {
  ManagedAttemptRunner
} from "./application/managed-attempt-runner.ts";
import {
  FileDecompositionPlanStore
} from "./storage/decomposition-plan-store.ts";

const ACTOR_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface DecompositionRuntimeServicePort {
  getWorkItem(
    workItemId: string
  ): WorkItem | null;
}

export interface DecompositionControlCapabilities {
  readonly preview: true;
  readonly approve: boolean;
  readonly dispatch: true;
  readonly retire: boolean;
}

export interface DecompositionApprovalCommand {
  readonly draft: unknown;
  readonly expectedPlanDigest: unknown;
}

export interface DecompositionRetirementCommand {
  readonly planId: unknown;
  readonly expectedPlanDigest:
    unknown;
  readonly reasonCode:
    DecompositionRetirementReasonCode;
  readonly note: unknown;
}

export interface DecompositionDispatcherFactoryOptions {
  readonly attemptRuns:
    AttemptRunCoordinator;
  readonly execute:
    DecompositionDispatcherOptions["execute"];
}

export class DecompositionControl {
  readonly service:
    DecompositionRuntimeServicePort;
  readonly journal:
    DecompositionPlanJournal;
  readonly registry:
    DigitalEmployeeRegistry;
  readonly operatorId:
    string | null;
  readonly now: () => Date;
  readonly capabilities:
    DecompositionControlCapabilities;
  #dispatcherCreated: boolean;
  #dispatcher:
    DecompositionDispatcher | null;

  constructor({
    service,
    journal,
    registry,
    operatorId,
    now = () => new Date()
  }: {
    service:
      DecompositionRuntimeServicePort;
    journal:
      DecompositionPlanJournal;
    registry:
      DigitalEmployeeRegistry;
    operatorId:
      string | null;
    now?: (() => Date) | undefined;
  }) {
    if (
      !service ||
      typeof service.getWorkItem !==
        "function" ||
      !(journal instanceof
        DecompositionPlanJournal) ||
      !registry ||
      typeof registry.get !==
        "function" ||
      (
        operatorId !== null &&
        !ACTOR_PATTERN.test(operatorId)
      ) ||
      typeof now !== "function"
    ) {
      throw new TypeError(
        "Decomposition control requires a service, journal, registry, optional actor, and clock."
      );
    }
    this.service = service;
    this.journal = journal;
    this.registry = registry;
    this.operatorId = operatorId;
    this.now = now;
    this.capabilities = Object.freeze({
      preview: true,
      approve: operatorId !== null,
      dispatch: true,
      retire: operatorId !== null
    });
    this.#dispatcherCreated = false;
    this.#dispatcher = null;
  }

  preview(
    draft: unknown
  ): DecompositionPlanPreview {
    return prepareDecompositionPlan(
      draft,
      {
        registry: this.registry,
        getWorkItem: (workItemId) =>
          this.service.getWorkItem(
            workItemId
          )
      }
    );
  }

  async approve({
    draft,
    expectedPlanDigest
  }: DecompositionApprovalCommand):
    Promise<DecompositionApprovalResult> {
    if (this.operatorId === null) {
      throw new DecompositionControlError(
        "DECOMPOSITION_APPROVAL_DISABLED",
        "Decomposition approval requires a server-owned human actor."
      );
    }
    const preview =
      this.preview(draft);
    const now = this.now();
    if (
      !(now instanceof Date) ||
      !Number.isFinite(now.getTime())
    ) {
      throw new DecompositionControlError(
        "DECOMPOSITION_CLOCK_INVALID",
        "Decomposition approval requires a valid clock."
      );
    }
    if (this.#dispatcher === null) {
      throw new DecompositionControlError(
        "DECOMPOSITION_DISPATCHER_NOT_CREATED",
        "Decomposition approval requires the lifecycle dispatcher."
      );
    }
    return await this.#dispatcher
      .approveOnce({
        plan: preview.plan,
        expectedPlanDigest,
        approvedBy:
          this.operatorId,
        approvedAt:
          now.toISOString()
      }) as
      DecompositionApprovalResult;
  }

  async #commitApproval(
    input: Parameters<
      NonNullable<
        DecompositionDispatcherOptions["approve"]
      >
    >[0]
  ) {
    return this.journal.approve(
      input
    );
  }

  async #commitRetirement({
    planId,
    expectedPlanDigest,
    reasonCode,
    note
  }: DecompositionRetirementCommand) {
    if (this.operatorId === null) {
      throw new DecompositionControlError(
        "DECOMPOSITION_RETIREMENT_DISABLED",
        "Decomposition retirement requires a server-owned human actor."
      );
    }
    const now = this.now();
    if (
      !(now instanceof Date) ||
      !Number.isFinite(now.getTime())
    ) {
      throw new DecompositionControlError(
        "DECOMPOSITION_CLOCK_INVALID",
        "Decomposition retirement requires a valid clock."
      );
    }
    return this.journal.retire({
      planId,
      expectedPlanDigest,
      retiredBy: this.operatorId,
      retiredAt: now.toISOString(),
      reasonCode,
      note
    });
  }

  listRetirements():
    readonly RetiredDecompositionRecord[] {
    return this.journal.listRetirements();
  }

  createDispatcher({
    attemptRuns,
    execute
  }: DecompositionDispatcherFactoryOptions):
    DecompositionDispatcher {
    if (this.#dispatcherCreated) {
      throw new DecompositionControlError(
        "DECOMPOSITION_DISPATCHER_ALREADY_CREATED",
        "A decomposition control can own only one lifecycle dispatcher."
      );
    }
    const dispatcher =
      new DecompositionDispatcher({
      plans: this.journal,
      registry: this.registry,
      getWorkItem: (workItemId) =>
        this.service.getWorkItem(
          workItemId
        ),
      attemptRuns,
      execute,
      approve: (command) =>
        this.#commitApproval(
          command
        ),
      retire: (command) =>
        this.#commitRetirement(command),
      now: this.now
    });
    this.#dispatcherCreated = true;
    this.#dispatcher =
      dispatcher;
    return dispatcher;
  }

  getHealth() {
    return this.journal.getHealth();
  }

  assertManualRunAllowed(
    workItemId: string
  ): void {
    if (this.#dispatcher !== null) {
      this.#dispatcher
        .assertManualRunAllowed(
          workItemId
        );
      return;
    }
    assertManualDecompositionRunAllowed(
      this.journal,
      (candidateId) =>
        this.service.getWorkItem(
          candidateId
        ),
      this.registry,
      workItemId
    );
  }

  assertAcceptanceAllowed(
    workItemId: string,
    decision:
      | "accepted"
      | "rejected"
  ): void {
    if (this.#dispatcher !== null) {
      this.#dispatcher
        .assertAcceptanceAllowed(
          workItemId,
          decision
        );
      return;
    }
    assertDecompositionAcceptanceAllowed(
      this.journal,
      (candidateId) =>
        this.service.getWorkItem(
          candidateId
        ),
      this.registry,
      workItemId,
      decision
    );
  }
}

export async function createLocalDecompositionControl({
  cwd,
  service,
  runner,
  environment = process.env,
  now = () => new Date()
}: {
  cwd: string;
  service:
    DecompositionRuntimeServicePort;
  runner: ManagedAttemptRunner;
  environment?:
    NodeJS.ProcessEnv | undefined;
  now?: (() => Date) | undefined;
}): Promise<DecompositionControl> {
  const actor = readOptionalActor(
    environment.TASKSEAL_HUMAN_ACTOR
  );
  const registry =
    createDigitalEmployeeRegistry([
      {
        manifest: runner.manifest,
        allowedWorkspaceAccess:
          runner.allowedWorkspaceAccess,
        skillTags: [
          "software-delivery"
        ]
      }
    ]);
  const journal =
    await DecompositionPlanJournal.open({
      storage:
        new FileDecompositionPlanStore({
          workspaceRoot: cwd,
          filePath: join(
            cwd,
            ".taskseal",
            "decomposition-plans.json"
          )
        })
    });

  return new DecompositionControl({
    service,
    journal,
    registry,
    operatorId: actor,
    now
  });
}

function readOptionalActor(
  value: string | undefined
): string | null {
  if (value === undefined) {
    return null;
  }
  if (!ACTOR_PATTERN.test(value)) {
    throw new DecompositionControlError(
      "DECOMPOSITION_ACTOR_INVALID",
      "TASKSEAL_HUMAN_ACTOR is invalid."
    );
  }
  return value;
}

export class DecompositionControlError extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string
  ) {
    super(message);
    this.name =
      "DecompositionControlError";
    this.code = code;
  }
}
