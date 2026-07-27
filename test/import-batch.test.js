import assert from "node:assert/strict";
import test from "node:test";

import {
  computeImportPlanDigest,
  deriveImportActionId
} from "../src/application/import-plan.js";
import {
  applyEvent,
  createWorkflow
} from "../src/domain/workflow.js";
import {
  createImportBatchRecord,
  validateImportBatchRecord,
  validateImportPlanForApply
} from "../src/application/import-batch.js";
import {
  digestCanonicalJson
} from "../src/lib/canonical-json.js";
import {
  createActor,
  createGitHubIssueSnapshot,
  createPreviewPlan
} from "../test-support/snapshot-import-fixtures.js";

test("a validated import plan becomes a replayable batch and immutable receipt", () => {
  const plan = createPreviewPlan();
  const actor = createActor();
  const record = createImportBatchRecord({
    plan,
    actor,
    appliedAt: "2026-07-26T08:05:00.000Z"
  });
  const validated = validateImportBatchRecord(record);

  assert.equal(
    validateImportPlanForApply(
      plan,
      plan.planDigest
    ).planDigest,
    plan.planDigest
  );
  assert.equal(
    record.batchId,
    `import:${plan.planDigest}`
  );
  assert.deepEqual(record.summary, {
    eventIds: plan.events.map((event) => event.eventId),
    skippedCodes: [],
    warningCodes: []
  });
  assert.match(
    validated.recordDigest,
    /^sha256:[0-9a-f]{64}$/
  );
  assert.deepEqual(validated.receipt, {
    batchId: record.batchId,
    planDigest: plan.planDigest,
    snapshotDigest: plan.snapshotDigest,
    mappingDigest: plan.mappingDigest,
    policyDigest: plan.policyDigest,
    baseWorkflowDigest: plan.baseWorkflowDigest,
    actor,
    appliedAt: record.appliedAt,
    outcome: "applied",
    eventIds: record.summary.eventIds,
    skippedCodes: [],
    warningCodes: []
  });
  assert.doesNotMatch(
    JSON.stringify(validated.receipt),
    /rawSnapshot|token|cookie|filePath/i
  );
});

test("plan validation detects digest, event identity, action identity, and summary tampering", () => {
  const original = createPreviewPlan();
  const mutations = [
    (plan) => {
      plan.planDigest = `sha256:${"0".repeat(64)}`;
    },
    (plan) => {
      plan.events[0].eventId =
        `taskseal:import:v1:create:${"0".repeat(64)}`;
      plan.actions[0].eventIds[0] =
        plan.events[0].eventId;
      plan.planDigest = computeImportPlanDigest(plan);
    },
    (plan) => {
      plan.actions[0].actionId =
        `sha256:${"0".repeat(64)}`;
      plan.planDigest = computeImportPlanDigest(plan);
    },
    (plan) => {
      plan.summary.create = 0;
    }
  ];

  for (const mutate of mutations) {
    const plan = structuredClone(original);
    mutate(plan);

    assert.throws(
      () =>
        validateImportPlanForApply(
          plan,
          plan.planDigest
        ),
      hasCode("IMPORT_PLAN_TAMPERED")
    );
  }

  assert.throws(
    () =>
      validateImportPlanForApply(
        original,
        `sha256:${"f".repeat(64)}`
      ),
    hasCode("IMPORT_PLAN_TAMPERED")
  );
});

test("plan validation binds each approved action to its canonical event semantics", () => {
  const plan = createPreviewPlan();
  plan.actions[0].kind = "update";
  plan.actions[0].reasonCode = "MANAGED_TITLE_CHANGED";
  plan.summary.create = 0;
  plan.summary.update = 1;
  plan.planDigest = computeImportPlanDigest(plan);

  assert.throws(
    () =>
      validateImportPlanForApply(
        plan,
        plan.planDigest
      ),
    hasCode("IMPORT_PLAN_TAMPERED")
  );
});

test("plan validation requires canonical ordering and complete stale warning projection", () => {
  const initial = createPreviewPlan();
  const workflow = initial.events.reduce(
    applyEvent,
    createWorkflow()
  );
  const updatePlan = createPreviewPlan({
    workflow,
    snapshot: createGitHubIssueSnapshot({
      title: "Updated provider title",
      revisionId: "2026-07-26T08:02:00.000Z",
      capturedAt: "2026-07-26T08:02:01.000Z"
    })
  });
  const reversed = structuredClone(updatePlan);
  reversed.actions.reverse();
  reversed.events.reverse();
  reversed.planDigest = computeImportPlanDigest(reversed);

  assert.throws(
    () =>
      validateImportPlanForApply(
        reversed,
        reversed.planDigest
      ),
    hasCode("IMPORT_PLAN_TAMPERED")
  );

  const stalePlan = structuredClone(initial);
  const staleIdentity = {
    workItemId: stalePlan.actions[0].workItemId,
    sourceObjectKey:
      stalePlan.actions[0].sourceObjectKey,
    sourceRevisionId:
      stalePlan.actions[0].sourceRevisionId,
    semanticTarget: "external-link-observation"
  };
  stalePlan.actions = [
    {
      ...stalePlan.actions[0],
      actionId: deriveImportActionId(staleIdentity),
      kind: "skip",
      semanticTarget: staleIdentity.semanticTarget,
      reasonCode: "STALE_SOURCE_REVISION",
      eventIds: []
    }
  ];
  stalePlan.events = [];
  stalePlan.summary = {
    create: 0,
    link: 0,
    refresh: 0,
    update: 0,
    skip: 1,
    conflict: 0
  };
  stalePlan.warnings = [];
  stalePlan.planDigest = computeImportPlanDigest(stalePlan);

  assert.throws(
    () =>
      validateImportPlanForApply(
        stalePlan,
        stalePlan.planDigest
      ),
    hasCode("IMPORT_PLAN_TAMPERED")
  );
});

test("batch replay rejects semantic, audit-summary, and schema tampering", () => {
  const record = createImportBatchRecord({
    plan: createPreviewPlan(),
    actor: createActor(),
    appliedAt: "2026-07-26T08:05:00.000Z"
  });
  const mutations = [
    (copy) => {
      copy.events[0].payload.title = "Tampered";
    },
    (copy) => {
      copy.policyDigest = `sha256:${"0".repeat(64)}`;
    },
    (copy) => {
      copy.summary.eventIds = [];
    },
    (copy) => {
      copy.batchId = "import:forged";
    },
    (copy) => {
      copy.secret = "must be rejected";
    }
  ];

  for (const mutate of mutations) {
    const copy = structuredClone(record);
    mutate(copy);

    assert.throws(
      () => validateImportBatchRecord(copy),
      hasCode("JOURNAL_CORRUPT")
    );
  }
});

test("plan validation enforces byte, depth, action, and event limits before apply", () => {
  const original = createPreviewPlan();
  const oversizedBytes = structuredClone(original);
  oversizedBytes.events[0].payload.title =
    "x".repeat(2 * 1024 * 1024);
  const excessiveDepth = structuredClone(original);
  let nested = excessiveDepth.events[0].payload;

  for (let depth = 0; depth < 20; depth += 1) {
    nested.extra = {};
    nested = nested.extra;
  }

  const excessiveActions = structuredClone(original);
  excessiveActions.actions = Array.from(
    { length: 257 },
    () => structuredClone(original.actions[0])
  );
  const excessiveEvents = structuredClone(original);
  excessiveEvents.events = Array.from(
    { length: 257 },
    () => structuredClone(original.events[0])
  );
  const excessiveActionsWithPoisonedItem =
    structuredClone(original);
  excessiveActionsWithPoisonedItem.actions =
    Array.from(
      { length: 257 },
      () => structuredClone(original.actions[0])
    );
  Object.defineProperty(
    excessiveActionsWithPoisonedItem.actions,
    "0",
    {
      enumerable: true,
      get() {
        throw new Error(
          "action contents must not be traversed after the count limit is known"
        );
      }
    }
  );

  for (const plan of [
    oversizedBytes,
    excessiveDepth,
    excessiveActions,
    excessiveEvents,
    excessiveActionsWithPoisonedItem
  ]) {
    assert.throws(
      () =>
        validateImportPlanForApply(
          plan,
          original.planDigest
        ),
      hasCode("IMPORT_PLAN_LIMIT_EXCEEDED")
    );
  }
});

test("successful batches require apply authorization and no conflicts", () => {
  const record = createImportBatchRecord({
    plan: createPreviewPlan(),
    actor: createActor(),
    appliedAt: "2026-07-26T08:05:00.000Z"
  });

  record.policyBinding.applyAllowed = false;
  record.policyDigest = digestCanonicalJson(
    record.policyBinding
  );
  record.planDigest = recomputeRecordPlanDigest(record);
  record.batchId = `import:${record.planDigest}`;

  assert.throws(
    () => validateImportBatchRecord(record),
    hasCode("JOURNAL_CORRUPT")
  );
});

function recomputeRecordPlanDigest(record) {
  return computeImportPlanDigest({
    schemaVersion: record.schemaVersion,
    snapshotDigest: record.snapshotDigest,
    mappingDigest: record.mappingDigest,
    policyDigest: record.policyDigest,
    baseWorkflowDigest: record.baseWorkflowDigest,
    policyBinding: record.policyBinding,
    actions: record.actions,
    events: record.events,
    conflicts: record.conflictCodes,
    warnings: record.warningCodes
  });
}

function hasCode(code) {
  return (error) => error?.code === code;
}
