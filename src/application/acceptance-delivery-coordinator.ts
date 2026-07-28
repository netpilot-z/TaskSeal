import type {
  ControlledTransitionActor,
  ControlledTransitionDiagnosticCode,
  ControlledTransitionOperation,
  ControlledTransitionOperationStatus
} from "./controlled-transition-operation.ts";
import {
  normalizeWorkItemAcceptanceCommand
} from "./work-item-acceptance.ts";
import type {
  WorkItemAcceptanceResult
} from "./work-item-acceptance.ts";

export interface AcceptanceDeliveryServicePort {
  decideAcceptance(
    input: unknown
  ): Promise<WorkItemAcceptanceResult>;
}

export interface AcceptanceDeliveryTransitionPort {
  prepare(input: {
    readonly workItemId: string;
    readonly decisionId: string;
    readonly acceptanceDigest: string;
  }): Promise<ControlledTransitionOperation>;
  approve(input: {
    readonly operationKey: string;
    readonly planDigest: string;
    readonly actor:
      ControlledTransitionActor;
  }): Promise<ControlledTransitionOperation>;
  submit(input: {
    readonly operationKey: string;
    readonly planDigest: string;
  }): Promise<ControlledTransitionOperation>;
  reconcile?(input: {
    readonly operationKey: string;
    readonly planDigest: string;
  }): Promise<ControlledTransitionOperation>;
  get?(
    operationKey: unknown
  ): Promise<ControlledTransitionOperation | null>;
}

export type AcceptanceDeliveryLinearSync =
  | {
      readonly status:
        "disabled";
    }
  | {
      readonly status:
        "not_applicable";
    }
  | {
      readonly status:
        | Exclude<
            ControlledTransitionOperationStatus,
            "failed"
          >
        | "sync_failed";
      readonly operationKey: string;
      readonly version: number;
      readonly diagnosticCode:
        | ControlledTransitionDiagnosticCode
        | null;
    }
  | {
      readonly status:
        "sync_failed";
      readonly diagnosticCode: string;
    };

export interface AcceptanceDeliveryResult {
  readonly local:
    WorkItemAcceptanceResult;
  readonly linearSync:
    AcceptanceDeliveryLinearSync;
}

export interface AcceptanceDeliveryCommandPort {
  decide(
    input: unknown
  ): Promise<AcceptanceDeliveryResult>;
  reconcile(
    input: unknown
  ): Promise<AcceptanceDeliveryLinearSync>;
}

interface AcceptanceDeliveryCoordinatorOptions {
  readonly acceptance:
    AcceptanceDeliveryServicePort;
  readonly actor: string;
  readonly transition:
    | AcceptanceDeliveryTransitionPort
    | null;
}

const COMMAND_KEYS = [
  "workItemId",
  "decisionId",
  "decision",
  "reason",
  "expectedReviewRevision"
] as const;
const ACTOR_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_TRANSITION_FAILURE_CODES =
  new Set([
    "LINEAR_TRANSITION_ACCEPTANCE_STALE",
    "LINEAR_TRANSITION_PRECONDITION_UNAVAILABLE",
    "LINEAR_TRANSITION_PRECONDITION_STALE",
    "LINEAR_TRANSITION_PLAN_CONFLICT",
    "LINEAR_TRANSITION_APPROVAL_CONFLICT",
    "LINEAR_TRANSITION_NOT_FOUND",
    "LINEAR_TRANSITION_STATE_INVALID",
    "LINEAR_TRANSITION_REOPEN_REQUIRED",
    "PROVIDER_OPERATION_JOURNAL_FENCED",
    "PROVIDER_OPERATION_JOURNAL_VERSION_CONFLICT",
    "PROVIDER_OPERATION_JOURNAL_WRITE_FAILED"
  ]);

export class AcceptanceDeliveryCoordinator
  implements AcceptanceDeliveryCommandPort {
  readonly #acceptance:
    AcceptanceDeliveryServicePort;
  readonly #actor: string;
  readonly #transition:
    | AcceptanceDeliveryTransitionPort
    | null;

  constructor({
    acceptance,
    actor,
    transition
  }: AcceptanceDeliveryCoordinatorOptions) {
    if (
      acceptance === null ||
      typeof acceptance !== "object" ||
      typeof acceptance.decideAcceptance !==
        "function" ||
      !ACTOR_PATTERN.test(actor) ||
      (
        transition !== null &&
        (
          typeof transition !== "object" ||
          typeof transition.prepare !==
            "function" ||
          typeof transition.approve !==
            "function" ||
          typeof transition.submit !==
            "function"
        )
      )
    ) {
      throw invalidConfiguration();
    }
    this.#acceptance = acceptance;
    this.#actor = actor;
    this.#transition = transition;
  }

  async decide(
    inputValue: unknown
  ): Promise<AcceptanceDeliveryResult> {
    const input =
      normalizeDeliveryInput(
        inputValue,
        this.#actor
      );
    const local =
      await this.#acceptance
        .decideAcceptance(input);

    if (
      local.decision.decision ===
      "rejected"
    ) {
      return freeze({
        local,
        linearSync: {
          status: "not_applicable"
        }
      });
    }
    if (this.#transition === null) {
      return freeze({
        local,
        linearSync: {
          status: "disabled"
        }
      });
    }

    try {
      const prepared =
        await this.#transition.prepare({
          workItemId: local.workItemId,
          decisionId:
            input.decisionId,
          acceptanceDigest:
            local.acceptanceDigest
        });
      const approved =
        await this.#transition.approve({
          operationKey:
            prepared.plan.operationKey,
          planDigest:
            prepared.plan.planDigest,
          actor: {
            type: "human",
            id: this.#actor
          }
        });
      const submitted =
        await this.#transition.submit({
          operationKey:
            approved.plan.operationKey,
          planDigest:
            approved.plan.planDigest
        });
      return freeze({
        local,
        linearSync:
          projectLinearSync(submitted)
      });
    } catch (error) {
      return freeze({
        local,
        linearSync: {
          status: "sync_failed",
          diagnosticCode:
            readSafeFailureCode(error)
        }
      });
    }
  }

  async reconcile(
    inputValue: unknown
  ): Promise<AcceptanceDeliveryLinearSync> {
    const input =
      normalizeReconciliationInput(
        inputValue
      );
    if (
      this.#transition === null ||
      typeof this.#transition
        .reconcile !== "function" ||
      typeof this.#transition.get !==
        "function"
    ) {
      return freeze({
        status: "disabled"
      });
    }
    try {
      const operation =
        await this.#transition.get(
          input.operationKey
        );
      if (operation === null) {
        return freeze({
          status: "sync_failed",
          diagnosticCode:
            "LINEAR_TRANSITION_NOT_FOUND"
        });
      }
      return freeze(
        projectLinearSync(
          await this.#transition.reconcile(
            {
              operationKey:
                input.operationKey,
              planDigest:
                operation.plan.planDigest
            }
          )
        )
      );
    } catch (error) {
      return freeze({
        status: "sync_failed",
        diagnosticCode:
          readSafeFailureCode(error)
      });
    }
  }
}

function normalizeDeliveryInput(
  value: unknown,
  actor: string
) {
  try {
    const input = readExactRecord(
      value,
      COMMAND_KEYS
    );
    return normalizeWorkItemAcceptanceCommand({
      workItemId: input.workItemId,
      decisionId: input.decisionId,
      decision: input.decision,
      expectedReviewRevision:
        input.expectedReviewRevision,
      actor,
      reason: input.reason
    });
  } catch {
    throw invalidCommand();
  }
}

function normalizeReconciliationInput(
  value: unknown
) {
  try {
    const input = readExactRecord(
      value,
      ["operationKey"]
    );
    if (
      typeof input.operationKey !==
        "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(
        input.operationKey
      )
    ) {
      throw invalidCommand();
    }
    return {
      operationKey:
        input.operationKey
    };
  } catch {
    throw invalidCommand();
  }
}

function projectLinearSync(
  operation: ControlledTransitionOperation
): AcceptanceDeliveryLinearSync {
  return {
    status:
      operation.status === "failed"
        ? "sync_failed"
        : operation.status,
    operationKey:
      operation.plan.operationKey,
    version: operation.version,
    diagnosticCode:
      operation.diagnosticCode
  };
}

function readSafeFailureCode(
  error: unknown
): string {
  const code =
    error !== null &&
    typeof error === "object" &&
    typeof Reflect.get(error, "code") ===
      "string"
      ? Reflect.get(error, "code")
      : null;
  return typeof code === "string" &&
    SAFE_TRANSITION_FAILURE_CODES.has(code)
    ? code
    : "LINEAR_TRANSITION_FAILED";
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
    throw invalidCommand();
  }
  const descriptors =
    Object.getOwnPropertyDescriptors(value);
  const result = Object.create(
    null
  ) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw invalidCommand();
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalidCommand();
    }
    result[key] = descriptor.value;
  }
  const actual = Object.keys(result).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) =>
        key !== expected[index]
    )
  ) {
    throw invalidCommand();
  }
  return result as Record<
    Keys[number],
    unknown
  >;
}

function freeze<T>(value: T): T {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const nested of Object.values(value)) {
    freeze(nested);
  }
  return Object.freeze(value);
}

function invalidCommand():
  AcceptanceDeliveryCoordinatorError {
  return new AcceptanceDeliveryCoordinatorError(
    "ACCEPTANCE_DELIVERY_COMMAND_INVALID",
    "The acceptance delivery command is invalid."
  );
}

function invalidConfiguration():
  AcceptanceDeliveryCoordinatorError {
  return new AcceptanceDeliveryCoordinatorError(
    "ACCEPTANCE_DELIVERY_CONFIGURATION_INVALID",
    "The acceptance delivery coordinator configuration is invalid."
  );
}

export class AcceptanceDeliveryCoordinatorError
  extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name =
      "AcceptanceDeliveryCoordinatorError";
    this.code = code;
  }
}
