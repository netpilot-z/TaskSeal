import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyControlledTransitionPlan,
  createControlledTransitionOperation,
  parseControlledTransitionOperation,
  transitionControlledTransitionOperation,
  validateControlledTransitionOperationTransition
} from "../src/application/controlled-transition-operation.ts";

test("transition v3 creates a deterministic immutable acceptance-bound plan", () => {
  const first =
    createControlledTransitionOperation(
      operationInput()
    );
  const second =
    createControlledTransitionOperation(
      operationInput()
    );

  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, 3);
  assert.equal(
    first.plan.capability,
    "acceptance.write"
  );
  assert.equal(
    first.plan.action,
    "work-item.transition"
  );
  assert.equal(
    first.plan.configuredTarget.kind,
    "issue_state"
  );
  assert.match(
    first.plan.configuredTarget.key,
    /^linear:issue-state-ref:/
  );
  assert.match(
    first.plan.operationKey,
    /^sha256:[0-9a-f]{64}$/
  );
  assert.match(
    first.plan.planDigest,
    /^sha256:[0-9a-f]{64}$/
  );
  assert.equal(first.status, "approval_required");
  assert.equal(first.version, 1);
  assert.equal(
    classifyControlledTransitionPlan(
      first.plan,
      second.plan
    ),
    "idempotent"
  );

  const changed = createControlledTransitionOperation({
    ...operationInput(),
    resolvedTarget: {
      ...operationInput().resolvedTarget,
      expectedRevisionId:
        "2026-07-28T00:05:01.000Z"
    }
  });
  assert.equal(
    classifyControlledTransitionPlan(
      first.plan,
      changed.plan
    ),
    "conflict"
  );
});

test("approval and a confirmed exact readback produce a transitioned terminal record", () => {
  const prepared =
    createControlledTransitionOperation(
      operationInput()
    );
  const approved =
    transitionControlledTransitionOperation(
      prepared,
      {
        type: "approve",
        actor: {
          type: "human",
          id: "operator.jeffrey"
        },
        operationKey:
          prepared.plan.operationKey,
        planDigest:
          prepared.plan.planDigest,
        occurredAt:
          "2026-07-28T00:06:00.000Z"
      }
    );
  const submitting =
    transitionControlledTransitionOperation(
      approved,
      {
        type: "begin_submission",
        occurredAt:
          "2026-07-28T00:07:00.000Z"
      }
    );
  const transitioned =
    transitionControlledTransitionOperation(
      submitting,
      {
        type: "transition_confirmed",
        occurredAt:
          "2026-07-28T00:08:00.000Z",
        issue: targetIssue()
      }
    );

  assert.equal(approved.status, "approved");
  assert.equal(submitting.status, "submitting");
  assert.equal(
    transitioned.status,
    "transitioned"
  );
  assert.equal(transitioned.version, 4);
  assert.deepEqual(
    transitioned.submission.issue,
    targetIssue()
  );
  assert.deepEqual(
    validateControlledTransitionOperationTransition(
      submitting,
      transitioned
    ),
    transitioned
  );
  assert.throws(
    () =>
      transitionControlledTransitionOperation(
        transitioned,
        {
          type: "begin_submission",
          occurredAt:
            "2026-07-28T00:09:00.000Z"
        }
      ),
    hasCode(
      "CONTROLLED_TRANSITION_INVALID"
    )
  );
});

test("transition operation rejects stale approval, tampered scope, revision, and unknown fields", () => {
  const prepared =
    createControlledTransitionOperation(
      operationInput()
    );
  assert.throws(
    () =>
      transitionControlledTransitionOperation(
        prepared,
        {
          type: "approve",
          actor: {
            type: "human",
            id: "operator.jeffrey"
          },
          operationKey:
            prepared.plan.operationKey,
          planDigest:
            `sha256:${"0".repeat(64)}`,
          occurredAt:
            "2026-07-28T00:06:00.000Z"
        }
      ),
    hasCode(
      "CONTROLLED_TRANSITION_APPROVAL_MISMATCH"
    )
  );

  for (const tampered of [
    {
      ...structuredClone(prepared),
      extra: true
    },
    {
      ...structuredClone(prepared),
      plan: {
        ...structuredClone(prepared.plan),
        resolvedTarget: {
          ...structuredClone(
            prepared.plan.resolvedTarget
          ),
          issueId:
            "99999999-9999-4999-8999-999999999999"
        }
      }
    },
    {
      ...structuredClone(prepared),
      plan: {
        ...structuredClone(prepared.plan),
        resolvedTarget: {
          ...structuredClone(
            prepared.plan.resolvedTarget
          ),
          expectedRevisionId:
            "2026-07-28T00:05:01.000Z"
        }
      }
    }
  ]) {
    assert.throws(
      () =>
        parseControlledTransitionOperation(
          tampered
        ),
      hasCode(
        "CONTROLLED_TRANSITION_INVALID"
      )
    );
  }
});

test("response loss is reconciled by exact target or exact unchanged source without resubmission", () => {
  const submitting = approvedSubmitting();
  const unknown =
    transitionControlledTransitionOperation(
      submitting,
      {
        type: "submission_outcome_unknown",
        occurredAt:
          "2026-07-28T00:08:00.000Z",
        diagnosticCode:
          "LINEAR_WRITE_OUTCOME_UNKNOWN"
      }
    );
  const reconciling =
    transitionControlledTransitionOperation(
      unknown,
      {
        type: "begin_reconciliation",
        occurredAt:
          "2026-07-28T00:09:00.000Z"
      }
    );
  const found =
    transitionControlledTransitionOperation(
      reconciling,
      {
        type:
          "reconciliation_target_confirmed",
        occurredAt:
          "2026-07-28T00:10:00.000Z",
        issue: targetIssue()
      }
    );
  assert.equal(found.status, "reconciled");
  assert.equal(
    found.reconciliation?.result,
    "found"
  );

  const absent =
    transitionControlledTransitionOperation(
      reconciling,
      {
        type:
          "reconciliation_expected_unchanged",
        occurredAt:
          "2026-07-28T00:10:00.000Z",
        issue: sourceIssue()
      }
    );
  assert.equal(
    absent.status,
    "reconciliation_absent"
  );
  assert.equal(
    absent.reconciliation?.result,
    "absent"
  );
  assert.deepEqual(
    absent.reconciliation?.issue,
    sourceIssue()
  );
});

function approvedSubmitting() {
  const prepared =
    createControlledTransitionOperation(
      operationInput()
    );
  const approved =
    transitionControlledTransitionOperation(
      prepared,
      {
        type: "approve",
        actor: {
          type: "human",
          id: "operator.jeffrey"
        },
        operationKey:
          prepared.plan.operationKey,
        planDigest:
          prepared.plan.planDigest,
        occurredAt:
          "2026-07-28T00:06:00.000Z"
      }
    );
  return transitionControlledTransitionOperation(
    approved,
    {
      type: "begin_submission",
      occurredAt:
        "2026-07-28T00:07:00.000Z"
    }
  );
}

function operationInput() {
  return {
    configuredTarget: {
      workspace: "netpilot-z",
      team: "netpilot",
      project: "TaskSeal",
      expectedState: "Todo",
      targetState: "Done"
    },
    resolvedTarget: {
      organizationId:
        "7eb4877f-0fa0-429c-9cd2-76dfffa0f20b",
      teamId:
        "658d1189-f63d-4245-b761-0f4f2c389663",
      projectId:
        "3e1b05e6-0a14-43d4-9fed-e1bee6ef0683",
      issueId:
        "70cbe548-5e6c-4d35-b019-a570058a8cf2",
      expectedStateId:
        "3d2677e2-2192-48c1-8fb9-e6da2dedf95f",
      expectedRevisionId:
        "2026-07-28T00:05:00.000Z",
      targetStateId:
        "2d716bbd-be75-4718-95c9-27f184d19e56"
    },
    sourceIntent: {
      workItemId: "TS-NP-7",
      decisionId: DECISION_ID,
      reviewRevision:
        `sha256:${"1".repeat(64)}`,
      acceptanceDigest:
        `sha256:${"2".repeat(64)}`
    },
    preparedAt:
      "2026-07-28T00:05:30.000Z"
  };
}

const DECISION_ID =
  "11111111-1111-4111-8111-111111111111";

function targetIssue() {
  return {
    id:
      "70cbe548-5e6c-4d35-b019-a570058a8cf2",
    identifier: "NP-7",
    revisionId:
      "2026-07-28T00:07:30.000Z",
    placement: {
      organizationId:
        "7eb4877f-0fa0-429c-9cd2-76dfffa0f20b",
      teamId:
        "658d1189-f63d-4245-b761-0f4f2c389663",
      projectId:
        "3e1b05e6-0a14-43d4-9fed-e1bee6ef0683",
      stateId:
        "2d716bbd-be75-4718-95c9-27f184d19e56"
    }
  };
}

function sourceIssue() {
  return {
    ...targetIssue(),
    revisionId:
      "2026-07-28T00:05:00.000Z",
    placement: {
      ...targetIssue().placement,
      stateId:
        "3d2677e2-2192-48c1-8fb9-e6da2dedf95f"
    }
  };
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error: unknown) =>
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code;
}
