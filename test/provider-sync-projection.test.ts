import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderSyncProjectionQuery,
  projectProviderOperations
} from "../src/application/provider-sync-projection.ts";
import {
  createControlledWriteOperation,
  transitionControlledWriteOperation
} from "../src/application/controlled-write-operation.ts";
import type {
  ControlledWriteOperation,
  ControlledWriteOperationStatus
} from "../src/application/controlled-write-operation.ts";
import type {
  ProviderObservationProjection,
  ProviderObservationQueryPort
} from "../src/application/provider-observation.ts";
import type {
  ProviderOperationJournalQueryPort
} from "../src/application/provider-operation-journal.ts";
import {
  digestCanonicalJson
} from "../src/lib/canonical-json.ts";

const TARGET = {
  kind: "team",
  key: "linear:team-ref:taskseal/netpilot"
} as const;
const TEAM_ID =
  "22222222-2222-4222-8222-222222222222";
const ORGANIZATION_ID =
  "33333333-3333-4333-8333-333333333333";
const START =
  "2026-07-27T12:00:00.000Z";

test("operation projection maps every state and recursively removes sensitive fields", () => {
  const statuses: ControlledWriteOperationStatus[] =
    [
      "approval_required",
      "approved",
      "rejected",
      "submitting",
      "created",
      "outcome_unknown",
      "reconciling",
      "reconciliation_absent",
      "reconciled",
      "failed"
    ];
  const operations = statuses.map(
    (status, index) =>
      operationAt(status, index + 1)
  );

  const projection =
    projectProviderOperations([
      ...operations
    ].reverse());

  assert.equal(projection.schemaVersion, 1);
  assert.deepEqual(
    projection.operations.map(
      (operation) => operation.status
    ).sort(),
    [
      "approval_required",
      "approved",
      "created",
      "outcome_unknown",
      "reconciliation_absent",
      "reconciled",
      "reconciling",
      "rejected",
      "submitting",
      "sync_failed"
    ].sort()
  );
  assert.deepEqual(
    projection.operations.find(
      (operation) =>
        operation.status === "approved"
    )?.approval,
    {
      decision: "approved",
      decidedAt:
        "2026-07-27T12:00:01.000Z"
    }
  );
  assert.equal(
    projection.operations.find(
      (operation) =>
        operation.status ===
        "approval_required"
    )?.approval,
    null
  );
  assert.equal(
    projection.operations.find(
      (operation) =>
        operation.status === "sync_failed"
    )?.diagnosticCode,
    "LINEAR_WRITE_NOT_DISPATCHED"
  );

  const serialized = JSON.stringify(projection);
  for (const forbidden of [
    "SECRET_TITLE",
    "SECRET_DESCRIPTION",
    "SECRET_ACTOR",
    "clientRequestId",
    "resolvedTarget",
    "organizationId",
    "teamId",
    "payload",
    "payloadDigest",
    "planDigest",
    "identifier",
    "issue"
  ]) {
    assert.doesNotMatch(
      serialized,
      new RegExp(forbidden)
    );
  }
});

test("operation projection is canonical, immutable by input order, and changes with an allowed version", () => {
  const first = operationAt(
    "approval_required",
    1
  );
  const second = operationAt(
    "approved",
    2
  );
  const left = projectProviderOperations([
    second,
    first
  ]);
  const right = projectProviderOperations([
    first,
    second
  ]);

  assert.deepEqual(left, right);
  assert.deepEqual(
    left.operations.map(
      (operation) => operation.operationKey
    ),
    [...left.operations]
      .map(
        (operation) =>
          operation.operationKey
      )
      .sort()
  );

  const advanced = projectProviderOperations([
    first,
    operationAt("submitting", 2)
  ]);
  assert.notEqual(
    advanced.revision,
    left.revision
  );
});

test("operation projection rejects duplicates and malformed latest records with a fixed safe error", () => {
  const operation = operationAt(
    "approval_required",
    1
  );
  const sentinel = "SECRET_INVALID_RECORD";
  const malformed = {
    ...structuredClone(operation),
    rawBody: sentinel
  };

  for (const input of [
    [operation, operation],
    [malformed],
    "not-an-array"
  ]) {
    assert.throws(
      () => projectProviderOperations(input),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code ===
          "PROVIDER_SYNC_PROJECTION_INVALID" &&
        !error.message.includes(sentinel) &&
        !("cause" in error)
    );
  }
});

test("operation projection rejects sparse, accessor, symbol, and oversized latest arrays without evaluating accessors", () => {
  const operation = operationAt(
    "approval_required",
    1
  );
  let accessorCalls = 0;
  const accessorArray: unknown[] = [];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return operation;
    }
  });
  accessorArray.length = 1;

  const symbolArray = [operation];
  Object.defineProperty(
    symbolArray,
    Symbol("secret"),
    {
      enumerable: true,
      value: "SECRET_SYMBOL"
    }
  );
  let oversizedOwnKeysCalls = 0;
  const oversizedArray = new Proxy(
    Array.from(
      { length: 513 },
      () => operation
    ),
    {
      ownKeys(target) {
        oversizedOwnKeysCalls += 1;
        return Reflect.ownKeys(target);
      }
    }
  );

  const inputs: unknown[] = [
    new Array(1),
    accessorArray,
    symbolArray,
    oversizedArray
  ];

  for (const input of inputs) {
    assert.throws(
      () => projectProviderOperations(input),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code ===
          "PROVIDER_SYNC_PROJECTION_INVALID" &&
        !("cause" in error)
    );
  }
  assert.equal(accessorCalls, 0);
  assert.equal(oversizedOwnKeysCalls, 0);
});

test("combined projection preserves both component revisions without inventing a global version", async () => {
  const observations = observationProjection();
  const operation = operationAt(
    "outcome_unknown",
    1
  );
  let getCalls = 0;
  let historyCalls = 0;
  let latestCalls = 0;
  const query =
    new ProviderSyncProjectionQuery({
      observations: fixedObservations(
        observations
      ),
      operations: {
        async get() {
          getCalls += 1;
          throw new Error("get must not be called");
        },
        async history() {
          historyCalls += 1;
          throw new Error(
            "history must not be called"
          );
        },
        async listLatest() {
          latestCalls += 1;
          return [operation];
        }
      }
    });

  const projection = await query.list();

  assert.equal(projection.schemaVersion, 2);
  assert.equal(
    projection.observationRevision,
    observations.revision
  );
  assert.match(
    projection.operationRevision,
    /^sha256:[0-9a-f]{64}$/
  );
  assert.match(
    projection.revision,
    /^sha256:[0-9a-f]{64}$/
  );
  assert.deepEqual(
    projection.providers,
    observations.providers
  );
  assert.equal(
    projection.operations[0]?.status,
    "outcome_unknown"
  );
  assert.equal(getCalls, 0);
  assert.equal(historyCalls, 0);
  assert.equal(latestCalls, 1);
});

test("combined projection rejects a forged observation envelope with a fixed safe error", async () => {
  const sentinel = "SECRET_OBSERVATION_ENVELOPE";
  const observations = {
    ...observationProjection(),
    rawBody: sentinel
  };
  const query =
    new ProviderSyncProjectionQuery({
      observations: {
        async list() {
          return observations;
        }
      },
      operations: operationQuery([])
    });

  await assert.rejects(
    query.list(),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code ===
        "PROVIDER_SYNC_PROJECTION_INVALID" &&
      !error.message.includes(sentinel) &&
      !("cause" in error)
  );
});

test("combined projection returns no partial result when either source fails", async (t) => {
  const sentinel = "SECRET_SOURCE_FAILURE";

  await t.test(
    "observation failure",
    async () => {
      let operationCalls = 0;
      const query =
        new ProviderSyncProjectionQuery({
          observations: {
            async list() {
              throw new Error(sentinel);
            }
          },
          operations: operationQuery(
            [],
            () => {
              operationCalls += 1;
            }
          )
        });

      await assert.rejects(
        query.list(),
        safeProjectionFailure(sentinel)
      );
      assert.equal(operationCalls, 1);
    }
  );

  await t.test("operation failure", async () => {
    const query =
      new ProviderSyncProjectionQuery({
        observations: fixedObservations(
          observationProjection()
        ),
        operations: {
          async get() {
            return null;
          },
          async history() {
            return [];
          },
          async listLatest() {
            throw new Error(sentinel);
          }
        }
      });

    await assert.rejects(
      query.list(),
      safeProjectionFailure(sentinel)
    );
  });
});

function operationAt(
  status: ControlledWriteOperationStatus,
  index: number
): ControlledWriteOperation {
  const clientRequestId = uuid(index);
  const prepared =
    createControlledWriteOperation({
      configuredTarget: TARGET,
      resolvedTarget: {
        organizationId: ORGANIZATION_ID,
        teamId: TEAM_ID
      },
      clientRequestId,
      payload: {
        title: `SECRET_TITLE_${index}`,
        description:
          `SECRET_DESCRIPTION_${index}`
      },
      preparedAt: START
    });
  if (status === "approval_required") {
    return prepared;
  }

  const decision =
    status === "rejected"
      ? "reject"
      : "approve";
  const approved =
    transitionControlledWriteOperation(
      prepared,
      {
        type: decision,
        actor: {
          type: "human",
          id: `SECRET_ACTOR_${index}`
        },
        operationKey:
          prepared.plan.operationKey,
        planDigest:
          prepared.plan.planDigest,
        occurredAt:
          "2026-07-27T12:00:01.000Z"
      }
    );
  if (
    status === "approved" ||
    status === "rejected"
  ) {
    return approved;
  }

  const submitting =
    transitionControlledWriteOperation(
      approved,
      {
        type: "begin_submission",
        occurredAt:
          "2026-07-27T12:00:02.000Z"
      }
    );
  if (status === "submitting") {
    return submitting;
  }
  if (status === "created") {
    return transitionControlledWriteOperation(
      submitting,
      {
        type: "submission_created",
        occurredAt:
          "2026-07-27T12:00:03.000Z",
        observedTeamId: TEAM_ID,
        issue: {
          id: clientRequestId,
          identifier: `NP-${100 + index}`
        }
      }
    );
  }
  if (status === "failed") {
    return transitionControlledWriteOperation(
      submitting,
      {
        type: "submission_not_dispatched",
        occurredAt:
          "2026-07-27T12:00:03.000Z",
        diagnosticCode:
          "LINEAR_WRITE_NOT_DISPATCHED"
      }
    );
  }

  const unknown =
    transitionControlledWriteOperation(
      submitting,
      {
        type: "submission_outcome_unknown",
        occurredAt:
          "2026-07-27T12:00:03.000Z",
        diagnosticCode:
          "LINEAR_WRITE_OUTCOME_UNKNOWN"
      }
    );
  if (status === "outcome_unknown") {
    return unknown;
  }

  const reconciling =
    transitionControlledWriteOperation(
      unknown,
      {
        type: "begin_reconciliation",
        occurredAt:
          "2026-07-27T12:00:04.000Z"
      }
    );
  if (status === "reconciling") {
    return reconciling;
  }
  if (
    status === "reconciliation_absent"
  ) {
    return transitionControlledWriteOperation(
      reconciling,
      {
        type: "reconciliation_absent",
        occurredAt:
          "2026-07-27T12:00:05.000Z"
      }
    );
  }
  return transitionControlledWriteOperation(
    reconciling,
    {
      type: "reconciliation_found",
      occurredAt:
        "2026-07-27T12:00:05.000Z",
      observedTeamId: TEAM_ID,
      issue: {
        id: clientRequestId,
        identifier: `NP-${100 + index}`
      }
    }
  );
}

function uuid(index: number): string {
  return (
    "00000000-0000-4000-8000-" +
    index.toString(16).padStart(12, "0")
  );
}

function observationProjection(): ProviderObservationProjection {
  const fields = {
    operation: "configuration" as const,
    provider: "linear" as const,
    configuredTarget: TARGET,
    observedScope: null,
    status: "configured" as const,
    startedAt: START,
    observedAt: START,
    sourceRevisions: [],
    snapshotDigest: null,
    mappingDigest: null,
    planDigest: null,
    missingEvidence: [],
    diagnosticCode: null,
    resolution: null
  };
  const providers = [
    {
      schemaVersion: 1 as const,
      observationId:
        digestCanonicalJson(fields),
      ...fields
    }
  ];
  return {
    schemaVersion: 1,
    revision:
      digestCanonicalJson(providers),
    providers
  };
}

function fixedObservations(
  value: ProviderObservationProjection
): ProviderObservationQueryPort {
  return {
    async list() {
      return structuredClone(value);
    }
  };
}

function operationQuery(
  values: readonly ControlledWriteOperation[],
  onList: () => void = () => {}
): ProviderOperationJournalQueryPort {
  return {
    async get() {
      return null;
    },
    async history() {
      return [];
    },
    async listLatest() {
      onList();
      return values;
    }
  };
}

function safeProjectionFailure(
  sentinel: string
): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code ===
      "PROVIDER_SYNC_PROJECTION_UNAVAILABLE" &&
    !error.message.includes(sentinel) &&
    !("cause" in error);
}
