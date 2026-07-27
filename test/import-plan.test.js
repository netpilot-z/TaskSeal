import assert from "node:assert/strict";
import test from "node:test";

import {
  computeImportPlanDigest,
  deriveImportEventId
} from "../src/application/import-plan.js";

test("import event identity is stable and binds every semantic identity field", () => {
  const identity = createEventIdentity();
  const eventId = deriveImportEventId(identity);

  assert.match(
    eventId,
    /^taskseal:import:v1:create:[0-9a-f]{64}$/
  );
  assert.equal(
    deriveImportEventId(structuredClone(identity)),
    eventId
  );

  for (const [field, replacement] of [
    ["eventType", "external_link.linked"],
    ["workItemId", "TS-2"],
    ["providerObjectKey", "github:issue:502"],
    ["sourceRevisionId", "revision-2"],
    ["semanticTarget", "external-link"]
  ]) {
    assert.notEqual(
      deriveImportEventId({
        ...identity,
        [field]: replacement
      }),
      eventId,
      field
    );
  }
});

test("import plan digest survives JSON round trips and excludes presentation fields", () => {
  const plan = createPlan();
  const planDigest = computeImportPlanDigest(plan);
  const roundTripped = JSON.parse(JSON.stringify({
    ...plan,
    mode: "approval-view",
    planDigest,
    summary: {
      create: 999
    }
  }));

  assert.match(planDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    computeImportPlanDigest(roundTripped),
    planDigest
  );
});

test("import plan digest detects semantic event, action, policy, and projection tampering", () => {
  const plan = createPlan();
  const originalDigest = computeImportPlanDigest(plan);
  const mutations = [
    (copy) => {
      copy.events[0].payload.title = "Tampered";
    },
    (copy) => {
      copy.actions[0].reasonCode = "TAMPERED";
    },
    (copy) => {
      copy.policyBinding.applyAllowed = true;
    },
    (copy) => {
      copy.conflicts.push({
        actionId: "sha256:conflict",
        code: "TAMPERED"
      });
    },
    (copy) => {
      copy.warnings.push({
        actionId: "sha256:warning",
        code: "TAMPERED"
      });
    }
  ];

  for (const mutate of mutations) {
    const copy = structuredClone(plan);
    mutate(copy);
    assert.notEqual(
      computeImportPlanDigest(copy),
      originalDigest
    );
  }
});

test("import event identity rejects unsupported or incomplete identities", () => {
  assert.throws(
    () =>
      deriveImportEventId({
        ...createEventIdentity(),
        eventType: "acceptance.decided"
      }),
    hasCode("IMPORT_EVENT_IDENTITY_INVALID")
  );
  assert.throws(
    () =>
      deriveImportEventId({
        ...createEventIdentity(),
        workItemId: ""
      }),
    hasCode("IMPORT_EVENT_IDENTITY_INVALID")
  );
});

function createEventIdentity() {
  return {
    eventType: "work_item.created",
    workItemId: "TS-1",
    providerObjectKey: "github:issue:501",
    sourceRevisionId: "revision-1",
    semanticTarget: "work-item"
  };
}

function createPlan() {
  const identity = createEventIdentity();
  const eventId = deriveImportEventId(identity);

  return {
    schemaVersion: 1,
    mode: "preview",
    snapshotDigest: `sha256:${"1".repeat(64)}`,
    mappingDigest: `sha256:${"2".repeat(64)}`,
    policyDigest: `sha256:${"3".repeat(64)}`,
    baseWorkflowDigest: `sha256:${"4".repeat(64)}`,
    policyBinding: {
      schemaVersion: 1,
      provider: "github",
      applyAllowed: false
    },
    summary: {
      create: 1
    },
    actions: [
      {
        actionId: `sha256:${"5".repeat(64)}`,
        kind: "create",
        workItemId: identity.workItemId,
        sourceObjectKey: identity.providerObjectKey,
        sourceRevisionId: identity.sourceRevisionId,
        semanticTarget: identity.semanticTarget,
        reasonCode: "NEW_WORK_ITEM",
        eventIds: [eventId]
      }
    ],
    events: [
      {
        eventId,
        workItemId: identity.workItemId,
        type: identity.eventType,
        occurredAt: "2026-07-26T08:01:00.000Z",
        payload: {
          title: "Import provider facts safely"
        }
      }
    ],
    conflicts: [],
    warnings: []
  };
}

function hasCode(code) {
  return (error) => error?.code === code;
}
