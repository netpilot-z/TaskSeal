import type {
  AcceptanceDecision
} from "../domain/workflow.ts";
import {
  digestCanonicalJson
} from "../lib/canonical-json.ts";

export interface WorkItemAcceptanceCommand {
  readonly workItemId: string;
  readonly decisionId: string;
  readonly decision:
    | "accepted"
    | "rejected";
  readonly expectedReviewRevision: string;
  readonly actor: string;
  readonly reason: string;
}

export interface WorkItemAcceptanceResult {
  readonly resolution:
    | "committed"
    | "idempotent";
  readonly workItemId: string;
  readonly eventId: string;
  readonly decision: AcceptanceDecision;
  readonly acceptanceDigest: string;
}

const COMMAND_KEYS = [
  "workItemId",
  "decisionId",
  "decision",
  "expectedReviewRevision",
  "actor",
  "reason"
] as const;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN =
  /^sha256:[0-9a-f]{64}$/;
const ACTOR_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function normalizeWorkItemAcceptanceCommand(
  value: unknown
): WorkItemAcceptanceCommand {
  try {
    const input = readExactRecord(
      value,
      COMMAND_KEYS
    );
    if (
      typeof input.workItemId !==
        "string" ||
      input.workItemId !==
        input.workItemId.trim() ||
      input.workItemId.length === 0 ||
      [...input.workItemId].length > 256 ||
      Buffer.byteLength(
        input.workItemId,
        "utf8"
      ) > 1_024 ||
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(
        input.workItemId
      ) ||
      typeof input.decisionId !==
        "string" ||
      !UUID_V4_PATTERN.test(
        input.decisionId
      ) ||
      (
        input.decision !== "accepted" &&
        input.decision !== "rejected"
      ) ||
      typeof input.expectedReviewRevision !==
        "string" ||
      !DIGEST_PATTERN.test(
        input.expectedReviewRevision
      ) ||
      typeof input.actor !== "string" ||
      !ACTOR_PATTERN.test(input.actor) ||
      typeof input.reason !== "string" ||
      input.reason !== input.reason.trim() ||
      input.reason.length === 0 ||
      !input.reason.isWellFormed() ||
      [...input.reason].length > 2_048 ||
      Buffer.byteLength(
        input.reason,
        "utf8"
      ) > 8_192 ||
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(
        input.reason
      )
    ) {
      throw acceptanceInputInvalid();
    }

    return Object.freeze({
      workItemId: input.workItemId,
      decisionId: input.decisionId,
      decision: input.decision,
      expectedReviewRevision:
        input.expectedReviewRevision,
      actor: input.actor,
      reason: input.reason
    });
  } catch (error) {
    if (
      error instanceof
      WorkItemAcceptanceError
    ) {
      throw error;
    }
    throw acceptanceInputInvalid();
  }
}

export function acceptanceEventId(
  decisionId: string
): string {
  if (!UUID_V4_PATTERN.test(decisionId)) {
    throw acceptanceInputInvalid();
  }
  return `taskseal:acceptance:${decisionId}`;
}

export function digestAcceptanceDecision({
  workItemId,
  eventId,
  decision
}: {
  readonly workItemId: string;
  readonly eventId: string;
  readonly decision: AcceptanceDecision;
}): string {
  if (decision.basis === undefined) {
    throw new WorkItemAcceptanceError(
      "ACCEPTANCE_DECISION_LEGACY",
      "A legacy acceptance decision cannot authorize a provider transition."
    );
  }
  return digestCanonicalJson({
    domain:
      "taskseal.acceptance-decision:v2",
    schemaVersion: 2,
    workItemId,
    eventId,
    decision
  });
}

export function matchesAcceptanceCommand(
  {
    workItemId,
    decision
  }: {
    readonly workItemId: string;
    readonly decision: AcceptanceDecision;
  },
  command: WorkItemAcceptanceCommand
): boolean {
  return (
    decision.basis !== undefined &&
    decision.basis.decisionId ===
      command.decisionId &&
    decision.basis.reviewRevision ===
      command.expectedReviewRevision &&
    decision.decision === command.decision &&
    decision.actor === command.actor &&
    decision.reason === command.reason &&
    workItemId === command.workItemId
  );
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
    throw acceptanceInputInvalid();
  }
  const descriptors =
    Object.getOwnPropertyDescriptors(value);
  const result = Object.create(
    null
  ) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw acceptanceInputInvalid();
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw acceptanceInputInvalid();
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
    throw acceptanceInputInvalid();
  }
  return result as Record<
    Keys[number],
    unknown
  >;
}

function acceptanceInputInvalid(): WorkItemAcceptanceError {
  return new WorkItemAcceptanceError(
    "ACCEPTANCE_COMMAND_INVALID",
    "The work item acceptance command is invalid."
  );
}

export class WorkItemAcceptanceError
  extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkItemAcceptanceError";
    this.code = code;
  }
}
