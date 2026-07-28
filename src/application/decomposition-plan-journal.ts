import {
  digestCanonicalJson
} from "../lib/canonical-json.ts";
import type {
  DecompositionPlanStorage
} from "../storage/decomposition-plan-store.ts";
import {
  DecompositionPlanStoreError
} from "../storage/decomposition-plan-store.ts";
import {
  parsePreparedDecompositionPlan
} from "./decomposition-plan.ts";
import type {
  PreparedDecompositionPlan
} from "./decomposition-plan.ts";
import {
  parseDecompositionAttemptBaselines
} from "./decomposition-attempt-baseline.ts";
import type {
  DecompositionAttemptBaseline
} from "./decomposition-attempt-baseline.ts";

const MAX_APPROVED_PLANS = 32;
const ACTOR_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN =
  /^sha256:[0-9a-f]{64}$/;
const ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface LegacyApprovedDecompositionRecord {
  readonly recordType:
    "decomposition.approved";
  readonly schemaVersion: "1";
  readonly planDigest: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly plan: PreparedDecompositionPlan;
}

export interface BaselineApprovedDecompositionRecord {
  readonly recordType:
    "decomposition.approved";
  readonly schemaVersion: "2";
  readonly planDigest: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly plan: PreparedDecompositionPlan;
  readonly attemptBaselines:
    readonly DecompositionAttemptBaseline[];
}

export type ApprovedDecompositionRecord =
  | LegacyApprovedDecompositionRecord
  | BaselineApprovedDecompositionRecord;

export interface DecompositionApprovalResult {
  readonly resolution:
    | "committed"
    | "idempotent";
  readonly record:
    ApprovedDecompositionRecord;
}

export interface RetiredDecompositionRecord {
  readonly recordType:
    "decomposition.retired";
  readonly schemaVersion: "1";
  readonly planId: string;
  readonly planDigest: string;
  readonly retiredBy: string;
  readonly retiredAt: string;
  readonly reasonCode:
    DecompositionRetirementReasonCode;
  readonly note: string;
}

export type DecompositionRetirementReasonCode =
  | "interrupted"
  | "human_rejected"
  | "runner_profile_drift"
  | "operator_rollback";

export interface DecompositionRetirementResult {
  readonly resolution:
    | "committed"
    | "idempotent";
  readonly record:
    RetiredDecompositionRecord;
}

export type DecompositionPlanJournalHealth =
  | {
      readonly status: "ready";
    }
  | {
      readonly status: "fenced";
      readonly code:
        "DECOMPOSITION_COMMIT_OUTCOME_UNKNOWN";
    };

interface DecompositionPlanEnvelope {
  readonly schemaVersion:
    | "2"
    | "3";
  readonly revision: number;
  readonly records:
    readonly ApprovedDecompositionRecord[];
  readonly retirements:
    readonly RetiredDecompositionRecord[];
}

interface LegacyDecompositionPlanEnvelope {
  readonly schemaVersion: "1";
  readonly revision: number;
  readonly records:
    readonly ApprovedDecompositionRecord[];
}

export class DecompositionPlanJournal {
  readonly #storage:
    DecompositionPlanStorage;
  #records:
    readonly ApprovedDecompositionRecord[];
  #retirements:
    readonly RetiredDecompositionRecord[];
  #writeQueue: Promise<void>;
  #health:
    DecompositionPlanJournalHealth;

  static async open({
    storage
  }: {
    storage: DecompositionPlanStorage;
  }): Promise<DecompositionPlanJournal> {
    if (
      !storage ||
      typeof storage.read !==
        "function" ||
      typeof storage.write !==
        "function"
    ) {
      throw new TypeError(
        "Decomposition plan journal requires storage."
      );
    }

    let raw: unknown;
    try {
      raw = await storage.read();
    } catch (error) {
      throw journalError(
        "DECOMPOSITION_JOURNAL_READ_FAILED",
        "TaskSeal could not read approved decomposition plans.",
        error
      );
    }
    const envelope =
      raw === null
        ? emptyEnvelope()
        : parseEnvelope(raw);

    return new DecompositionPlanJournal(
      storage,
      envelope.records,
      envelope.retirements
    );
  }

  constructor(
    storage: DecompositionPlanStorage,
    records:
      readonly ApprovedDecompositionRecord[],
    retirements:
      readonly RetiredDecompositionRecord[] =
        []
  ) {
    this.#storage = storage;
    this.#records = records;
    this.#retirements =
      retirements;
    this.#writeQueue =
      Promise.resolve();
    this.#health = {
      status: "ready"
    };
  }

  get(
    planId: string
  ): ApprovedDecompositionRecord | null {
    this.assertAvailable();
    return (
      this.activeRecords().find(
        (record) =>
          record.plan.planId === planId
      ) ?? null
    );
  }

  list():
    readonly ApprovedDecompositionRecord[] {
    this.assertAvailable();
    return Object.freeze([
      ...this.activeRecords()
    ]);
  }

  listRetirements():
    readonly RetiredDecompositionRecord[] {
    this.assertAvailable();
    return Object.freeze([
      ...this.#retirements
    ]);
  }

  getRetirement(
    planId: string
  ): RetiredDecompositionRecord | null {
    this.assertAvailable();
    return (
      this.#retirements.find(
        (record) =>
          record.planId === planId
      ) ?? null
    );
  }

  getHealth():
    DecompositionPlanJournalHealth {
    return this.#health.status ===
      "fenced"
      ? {
          status: "fenced",
          code: this.#health.code
        }
      : {
          status: "ready"
        };
  }

  approve({
    plan: planValue,
    expectedPlanDigest,
    approvedBy,
    approvedAt,
    attemptBaselines:
      attemptBaselinesValue
  }: {
    plan: unknown;
    expectedPlanDigest: unknown;
    approvedBy: unknown;
    approvedAt: unknown;
    attemptBaselines?: unknown;
  }): Promise<DecompositionApprovalResult> {
    return this.enqueueWrite(
      async () => {
        const plan =
          parsePreparedDecompositionPlan(
            planValue
          );
        const planDigest =
          digestCanonicalJson(plan, {
            maxDepth: 12
          });
        const actor = readActor(
          approvedBy
        );
        const existing =
          this.#records.find(
            (record) =>
              record.plan.planId ===
              plan.planId
          );

        if (existing) {
          if (
            existing.planDigest !==
              planDigest ||
            existing.approvedBy !== actor
          ) {
            throw journalError(
              "DECOMPOSITION_PLAN_CONFLICT",
              "The decomposition plan ID is already bound to different approved content."
            );
          }
          if (
            expectedPlanDigest !==
            planDigest
          ) {
            throw staleApproval();
          }
          if (
            this.#retirements.some(
              (record) =>
                record.planId ===
                plan.planId
            )
          ) {
            throw journalError(
              "DECOMPOSITION_PLAN_RETIRED",
              "A retired decomposition plan ID cannot be reactivated."
            );
          }
          return Object.freeze({
            resolution:
              "idempotent" as const,
            record: existing
          });
        }

        if (
          typeof expectedPlanDigest !==
            "string" ||
          !DIGEST_PATTERN.test(
            expectedPlanDigest
          ) ||
          expectedPlanDigest !==
            planDigest
        ) {
          throw staleApproval();
        }
        const timestamp =
          readTimestamp(approvedAt);
        assertPlanOwnershipAvailable(
          this.activeRecords(),
          plan
        );
        if (
          this.#records.length >=
          MAX_APPROVED_PLANS
        ) {
          throw journalError(
            "DECOMPOSITION_PLAN_LIMIT_REACHED",
            "The approved decomposition plan limit has been reached."
          );
        }
        let attemptBaselines:
          readonly DecompositionAttemptBaseline[]
          | null = null;
        if (
          attemptBaselinesValue !==
          undefined
        ) {
          try {
            attemptBaselines =
              parseDecompositionAttemptBaselines(
                attemptBaselinesValue,
                [
                  plan.rootWorkItemId,
                  ...plan.nodes.map(
                    (node) =>
                      node.workItemId
                  )
                ]
              );
          } catch (error) {
            throw journalError(
              "DECOMPOSITION_BASELINE_INVALID",
              "The decomposition approval attempt baselines are invalid.",
              error
            );
          }
        }
        const record:
          ApprovedDecompositionRecord =
          attemptBaselines === null
            ? freezeRecord({
                recordType:
                  "decomposition.approved",
                schemaVersion: "1",
                planDigest,
                approvedBy: actor,
                approvedAt: timestamp,
                plan
              })
            : freezeRecord({
                recordType:
                  "decomposition.approved",
                schemaVersion: "2",
                planDigest,
                approvedBy: actor,
                approvedAt: timestamp,
                plan,
                attemptBaselines
              });
        const nextRecords =
          Object.freeze([
            ...this.#records,
            record
          ].toSorted((left, right) =>
            compareStrings(
              left.plan.planId,
              right.plan.planId
            )
          ));
        const envelope =
          createWritableEnvelope(
            nextRecords,
            this.#retirements
          );

        try {
          await this.#storage.write(
            envelope
          );
        } catch (error) {
          if (
            error instanceof
              DecompositionPlanStoreError &&
            error.code ===
              "DECOMPOSITION_STORE_COMMIT_OUTCOME_UNKNOWN"
          ) {
            this.#health = {
              status: "fenced",
              code:
                "DECOMPOSITION_COMMIT_OUTCOME_UNKNOWN"
            };
            throw journalError(
              "DECOMPOSITION_COMMIT_OUTCOME_UNKNOWN",
              "TaskSeal cannot confirm the decomposition approval commit; reopen is required.",
              error
            );
          }
          throw journalError(
            "DECOMPOSITION_JOURNAL_WRITE_FAILED",
            "TaskSeal could not persist the approved decomposition plan.",
            error
          );
        }

        this.#records = nextRecords;
        return Object.freeze({
          resolution:
            "committed" as const,
          record
        });
      }
    );
  }

  retire({
    planId: planIdValue,
    expectedPlanDigest,
    retiredBy,
    retiredAt,
    reasonCode: reasonCodeValue,
    note: noteValue
  }: {
    planId: unknown;
    expectedPlanDigest: unknown;
    retiredBy: unknown;
    retiredAt: unknown;
    reasonCode: unknown;
    note: unknown;
  }): Promise<DecompositionRetirementResult> {
    return this.enqueueWrite(
      async () => {
        const planId =
          readPlanId(planIdValue);
        const approved =
          this.#records.find(
            (record) =>
              record.plan.planId ===
              planId
          );
        if (!approved) {
          throw journalError(
            "DECOMPOSITION_PLAN_NOT_FOUND",
            "The approved decomposition plan does not exist."
          );
        }
        if (
          typeof expectedPlanDigest !==
            "string" ||
          !DIGEST_PATTERN.test(
            expectedPlanDigest
          ) ||
          expectedPlanDigest !==
            approved.planDigest
        ) {
          throw journalError(
            "DECOMPOSITION_RETIREMENT_STALE",
            "The decomposition retirement revision is stale."
          );
        }
        const actor =
          readActor(retiredBy);
        const reasonCode =
          readRetirementReasonCode(
            reasonCodeValue
          );
        const note =
          readRetirementNote(
            noteValue
          );
        const existing =
          this.#retirements.find(
            (record) =>
              record.planId === planId
          );
        if (existing) {
          if (
            existing.planDigest !==
              approved.planDigest ||
            existing.retiredBy !==
              actor ||
            existing.reasonCode !==
              reasonCode ||
            existing.note !== note
          ) {
            throw journalError(
              "DECOMPOSITION_RETIREMENT_CONFLICT",
              "The decomposition plan already has a different retirement decision."
            );
          }
          return Object.freeze({
            resolution:
              "idempotent" as const,
            record: existing
          });
        }
        const timestamp =
          readTimestamp(retiredAt);
        if (
          Date.parse(timestamp) <
          Date.parse(
            approved.approvedAt
          )
        ) {
          throw journalError(
            "DECOMPOSITION_TIMESTAMP_INVALID",
            "Decomposition retirement cannot predate approval."
          );
        }
        const record =
          freezeRetirement({
            recordType:
              "decomposition.retired",
            schemaVersion: "1",
            planId,
            planDigest:
              approved.planDigest,
            retiredBy: actor,
            retiredAt: timestamp,
            reasonCode,
            note
          });
        const nextRetirements =
          Object.freeze([
            ...this.#retirements,
            record
          ].toSorted((left, right) =>
            compareStrings(
              left.planId,
              right.planId
            )
          ));
        const envelope =
          createWritableEnvelope(
            this.#records,
            nextRetirements
          );

        try {
          await this.#storage.write(
            envelope
          );
        } catch (error) {
          if (
            error instanceof
              DecompositionPlanStoreError &&
            error.code ===
              "DECOMPOSITION_STORE_COMMIT_OUTCOME_UNKNOWN"
          ) {
            this.#health = {
              status: "fenced",
              code:
                "DECOMPOSITION_COMMIT_OUTCOME_UNKNOWN"
            };
            throw journalError(
              "DECOMPOSITION_COMMIT_OUTCOME_UNKNOWN",
              "TaskSeal cannot confirm the decomposition retirement commit; reopen is required.",
              error
            );
          }
          throw journalError(
            "DECOMPOSITION_JOURNAL_WRITE_FAILED",
            "TaskSeal could not persist the decomposition retirement.",
            error
          );
        }

        this.#retirements =
          nextRetirements;
        return Object.freeze({
          resolution:
            "committed" as const,
          record
        });
      }
    );
  }

  activeRecords():
    readonly ApprovedDecompositionRecord[] {
    const retiredPlanIds =
      new Set(
        this.#retirements.map(
          (record) =>
            record.planId
        )
      );
    return this.#records.filter(
      (record) =>
        !retiredPlanIds.has(
          record.plan.planId
        )
    );
  }

  enqueueWrite<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    const queued =
      this.#writeQueue.then(() => {
        this.assertAvailable();
        return operation();
      });
    this.#writeQueue = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  }

  assertAvailable(): void {
    if (
      this.#health.status === "fenced"
    ) {
      throw journalError(
        "DECOMPOSITION_REOPEN_REQUIRED",
        "TaskSeal must reopen the decomposition plan journal before continuing."
      );
    }
  }
}

function parseEnvelope(
  value: unknown
): DecompositionPlanEnvelope {
  const candidate =
    readDataRecord(value);
  const legacy =
    candidate.schemaVersion === "1";
  const envelope = readExactRecord(
    value,
    legacy
      ? [
          "schemaVersion",
          "revision",
          "records"
        ]
      : [
          "schemaVersion",
          "revision",
          "records",
          "retirements"
        ]
  );
  if (
    (
      envelope.schemaVersion !==
        "1" &&
      envelope.schemaVersion !==
        "2" &&
      envelope.schemaVersion !==
        "3"
    ) ||
    typeof envelope.revision !==
      "number" ||
    !Number.isSafeInteger(
      envelope.revision
    ) ||
    envelope.revision < 0
  ) {
    throw corruptJournal();
  }
  const records = readArray(
    envelope.records,
    MAX_APPROVED_PLANS
  ).map(parseRecord);
  const hasBaselineRecord =
    records.some(
      (record) =>
        record.schemaVersion ===
        "2"
    );
  if (
    (
      envelope.schemaVersion ===
        "3"
    ) !== hasBaselineRecord
  ) {
    throw corruptJournal();
  }
  const retirements = readArray(
    legacy
      ? []
      : envelope.retirements,
    MAX_APPROVED_PLANS
  ).map(parseRetirement);
  if (
    envelope.revision !==
    records.length +
      retirements.length
  ) {
    throw corruptJournal();
  }
  const normalized: ApprovedDecompositionRecord[] =
    [];
  for (const record of records) {
    if (
      normalized.some(
        (candidate) =>
          candidate.plan.planId ===
          record.plan.planId
      )
    ) {
      throw corruptJournal();
    }
    normalized.push(record);
  }
  const normalizedRetirements:
    RetiredDecompositionRecord[] =
    [];
  for (
    const retirement of
      retirements
  ) {
    if (
      normalizedRetirements.some(
        (candidate) =>
          candidate.planId ===
          retirement.planId
      )
    ) {
      throw corruptJournal();
    }
    const approved =
      normalized.find(
        (record) =>
          record.plan.planId ===
          retirement.planId
      );
    if (
      !approved ||
      approved.planDigest !==
        retirement.planDigest ||
      Date.parse(
        retirement.retiredAt
      ) <
        Date.parse(
          approved.approvedAt
        )
    ) {
      throw corruptJournal();
    }
    normalizedRetirements.push(
      retirement
    );
  }
  const retiredIds = new Set(
    normalizedRetirements.map(
      (record) => record.planId
    )
  );
  const active: ApprovedDecompositionRecord[] =
    [];
  for (const record of normalized) {
    if (
      retiredIds.has(
        record.plan.planId
      )
    ) {
      continue;
    }
    try {
      assertPlanOwnershipAvailable(
        active,
        record.plan
      );
    } catch {
      throw corruptJournal();
    }
    active.push(record);
  }
  normalized.sort((left, right) =>
    compareStrings(
      left.plan.planId,
      right.plan.planId
    )
  );
  normalizedRetirements.sort(
    (left, right) =>
      compareStrings(
        left.planId,
        right.planId
      )
  );
  return freezeEnvelope({
    schemaVersion:
      normalized.some(
        (record) =>
          record.schemaVersion ===
          "2"
      )
        ? "3"
        : "2",
    revision:
      normalized.length +
      normalizedRetirements.length,
    records: normalized,
    retirements:
      normalizedRetirements
  });
}

function parseRecord(
  value: unknown
): ApprovedDecompositionRecord {
  const candidate =
    readDataRecord(value);
  const baselineRecord =
    candidate.schemaVersion === "2";
  const record = readExactRecord(
    value,
    baselineRecord
      ? [
          "recordType",
          "schemaVersion",
          "planDigest",
          "approvedBy",
          "approvedAt",
          "plan",
          "attemptBaselines"
        ]
      : [
          "recordType",
          "schemaVersion",
          "planDigest",
          "approvedBy",
          "approvedAt",
          "plan"
        ]
  );
  if (
    record.recordType !==
      "decomposition.approved" ||
    (
      record.schemaVersion !==
        "1" &&
      record.schemaVersion !==
        "2"
    ) ||
    typeof record.planDigest !==
      "string" ||
    !DIGEST_PATTERN.test(
      record.planDigest
    )
  ) {
    throw corruptJournal();
  }
  const plan =
    parsePreparedDecompositionPlan(
      record.plan
    );
  if (
    digestCanonicalJson(plan, {
      maxDepth: 12
    }) !== record.planDigest
  ) {
    throw corruptJournal();
  }
  const common = {
    recordType:
      "decomposition.approved" as const,
    planDigest:
      record.planDigest,
    approvedBy: readActor(
      record.approvedBy
    ),
    approvedAt: readTimestamp(
      record.approvedAt
    ),
    plan
  };
  if (!baselineRecord) {
    return freezeRecord({
      ...common,
      schemaVersion: "1"
    });
  }
  let attemptBaselines:
    readonly DecompositionAttemptBaseline[];
  try {
    attemptBaselines =
      parseDecompositionAttemptBaselines(
        record.attemptBaselines,
        [
          plan.rootWorkItemId,
          ...plan.nodes.map(
            (node) =>
              node.workItemId
          )
        ]
      );
  } catch {
    throw corruptJournal();
  }
  return freezeRecord({
    ...common,
    schemaVersion: "2",
    attemptBaselines
  });
}

function parseRetirement(
  value: unknown
): RetiredDecompositionRecord {
  const record = readExactRecord(
    value,
    [
      "recordType",
      "schemaVersion",
      "planId",
      "planDigest",
      "retiredBy",
      "retiredAt",
      "reasonCode",
      "note"
    ]
  );
  if (
    record.recordType !==
      "decomposition.retired" ||
    record.schemaVersion !== "1" ||
    typeof record.planDigest !==
      "string" ||
    !DIGEST_PATTERN.test(
      record.planDigest
    )
  ) {
    throw corruptJournal();
  }
  return freezeRetirement({
    recordType:
      "decomposition.retired",
    schemaVersion: "1",
    planId: readPlanId(
      record.planId
    ),
    planDigest:
      record.planDigest,
    retiredBy: readActor(
      record.retiredBy
    ),
    retiredAt: readTimestamp(
      record.retiredAt
    ),
    reasonCode:
      readRetirementReasonCode(
        record.reasonCode
      ),
    note:
      readRetirementNote(
        record.note
      )
  });
}

function assertPlanOwnershipAvailable(
  records:
    readonly ApprovedDecompositionRecord[],
  plan: PreparedDecompositionPlan
): void {
  const existingRoots = new Set(
    records.map(
      (record) =>
        record.plan.rootWorkItemId
    )
  );
  const existingNodes = new Set(
    records.flatMap((record) =>
      record.plan.nodes.map(
        (node) => node.workItemId
      )
    )
  );
  if (
    existingRoots.has(
      plan.rootWorkItemId
    ) ||
    existingNodes.has(
      plan.rootWorkItemId
    ) ||
    plan.nodes.some(
      (node) =>
        existingRoots.has(
          node.workItemId
        ) ||
        existingNodes.has(
          node.workItemId
        )
    )
  ) {
    throw journalError(
      "DECOMPOSITION_PLAN_CONFLICT",
      "A WorkItem cannot be owned by multiple or recursive decomposition plans."
    );
  }
}

function freezeRecord(
  record: ApprovedDecompositionRecord
): ApprovedDecompositionRecord {
  const common = {
    recordType:
      "decomposition.approved" as const,
    planDigest: record.planDigest,
    approvedBy: record.approvedBy,
    approvedAt: record.approvedAt,
    plan: record.plan
  };
  return record.schemaVersion ===
    "1"
    ? Object.freeze({
        ...common,
        schemaVersion:
          "1" as const
      })
    : Object.freeze({
        ...common,
        schemaVersion:
          "2" as const,
        attemptBaselines:
          Object.freeze([
            ...record
              .attemptBaselines
          ])
      });
}

function freezeRetirement(
  record:
    RetiredDecompositionRecord
): RetiredDecompositionRecord {
  return Object.freeze({
    recordType:
      "decomposition.retired",
    schemaVersion: "1",
    planId: record.planId,
    planDigest:
      record.planDigest,
    retiredBy:
      record.retiredBy,
    retiredAt:
      record.retiredAt,
    reasonCode:
      record.reasonCode,
    note: record.note
  });
}

function freezeEnvelope(
  envelope:
    DecompositionPlanEnvelope
): DecompositionPlanEnvelope {
  return Object.freeze({
    schemaVersion:
      envelope.schemaVersion,
    revision: envelope.revision,
    records: Object.freeze([
      ...envelope.records
    ]),
    retirements: Object.freeze([
      ...envelope.retirements
    ])
  });
}

function freezeLegacyEnvelope(
  records:
    readonly ApprovedDecompositionRecord[]
): LegacyDecompositionPlanEnvelope {
  return Object.freeze({
    schemaVersion: "1",
    revision: records.length,
    records: Object.freeze([
      ...records
    ])
  });
}

function createWritableEnvelope(
  records:
    readonly ApprovedDecompositionRecord[],
  retirements:
    readonly RetiredDecompositionRecord[]
):
  | LegacyDecompositionPlanEnvelope
  | DecompositionPlanEnvelope {
  if (
    records.some(
      (record) =>
        record.schemaVersion ===
        "2"
    )
  ) {
    return freezeEnvelope({
      schemaVersion: "3",
      revision:
        records.length +
        retirements.length,
      records,
      retirements
    });
  }
  return retirements.length === 0
    ? freezeLegacyEnvelope(
        records
      )
    : freezeEnvelope({
        schemaVersion: "2",
        revision:
          records.length +
          retirements.length,
        records,
        retirements
      });
}

function emptyEnvelope():
  DecompositionPlanEnvelope {
  return freezeEnvelope({
    schemaVersion: "2",
    revision: 0,
    records: [],
    retirements: []
  });
}

function readExactRecord(
  value: unknown,
  expectedKeys: readonly string[]
): Record<string, unknown> {
  const record =
    readDataRecord(value);
  const descriptors =
    Object.getOwnPropertyDescriptors(
      record
    );
  if (
    Object.keys(descriptors).length !==
      expectedKeys.length ||
    expectedKeys.some((key) => {
      const descriptor =
        descriptors[key];
      return (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      );
    })
  ) {
    throw corruptJournal();
  }
  return record;
}

function readDataRecord(
  value: unknown
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !==
      Object.prototype ||
    Object.getOwnPropertySymbols(value)
      .length !== 0
  ) {
    throw corruptJournal();
  }
  return value as Record<
    string,
    unknown
  >;
}

function readArray(
  value: unknown,
  maximum: number
): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !==
      Array.prototype ||
    value.length > maximum
  ) {
    throw corruptJournal();
  }
  for (
    let index = 0;
    index < value.length;
    index += 1
  ) {
    const descriptor =
      Object.getOwnPropertyDescriptor(
        value,
        String(index)
      );
    if (
      descriptor === undefined ||
      !("value" in descriptor)
    ) {
      throw corruptJournal();
    }
  }
  return value;
}

function readActor(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    !ACTOR_PATTERN.test(value)
  ) {
    throw journalError(
      "DECOMPOSITION_ACTOR_INVALID",
      "Decomposition approval requires a safe server-owned actor."
    );
  }
  return value;
}

function readPlanId(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    !ID_PATTERN.test(value)
  ) {
    throw journalError(
      "DECOMPOSITION_PLAN_ID_INVALID",
      "Decomposition retirement requires a safe plan ID."
    );
  }
  return value;
}

function readRetirementReasonCode(
  value: unknown
): DecompositionRetirementReasonCode {
  if (
    value !== "interrupted" &&
    value !== "human_rejected" &&
    value !==
      "runner_profile_drift" &&
    value !== "operator_rollback"
  ) {
    throw journalError(
      "DECOMPOSITION_RETIREMENT_REASON_INVALID",
      "Decomposition retirement reasonCode is invalid."
    );
  }
  return value;
}

function readRetirementNote(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length === 0 ||
    !value.isWellFormed() ||
    [...value].length > 2_048 ||
    Buffer.byteLength(
      value,
      "utf8"
    ) > 8_192 ||
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(
      value
    )
  ) {
    throw journalError(
      "DECOMPOSITION_RETIREMENT_REASON_INVALID",
      "Decomposition retirement requires a bounded human note."
    );
  }
  return value;
}

function readTimestamp(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(
      Date.parse(value)
    )
  ) {
    throw journalError(
      "DECOMPOSITION_TIMESTAMP_INVALID",
      "Decomposition approval requires a valid timestamp."
    );
  }
  return new Date(value).toISOString();
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

function staleApproval():
  DecompositionPlanJournalError {
  return journalError(
    "DECOMPOSITION_APPROVAL_STALE",
    "The reviewed decomposition digest no longer matches the plan."
  );
}

function corruptJournal():
  DecompositionPlanJournalError {
  return journalError(
    "DECOMPOSITION_JOURNAL_CORRUPT",
    "The decomposition plan journal is invalid."
  );
}

function journalError(
  code: string,
  message: string,
  cause?: unknown
): DecompositionPlanJournalError {
  return new DecompositionPlanJournalError(
    code,
    message,
    cause === undefined
      ? undefined
      : { cause }
  );
}

export class DecompositionPlanJournalError extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name =
      "DecompositionPlanJournalError";
    this.code = code;
  }
}
