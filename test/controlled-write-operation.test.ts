import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyControlledWritePlan,
  createControlledWriteOperation,
  parseControlledWriteOperation,
  transitionControlledWriteOperation,
  validateControlledWriteOperationTransition
} from "../src/application/controlled-write-operation.ts";

test("controlled write plan is deterministic, immutable, and separates identity from payload", () => {
  const first = createControlledWriteOperation(input());
  const second = createControlledWriteOperation(input());
  const changedPayload = createControlledWriteOperation(
    input({
      payload: {
        title: "Create the delivery ticket",
        description: "Changed reviewed content."
      }
    })
  );
  const changedIdentity = createControlledWriteOperation(
    input({
      clientRequestId:
        "44444444-4444-4444-8444-444444444444"
    })
  );
  const changedScope = createControlledWriteOperation(
    input({
      resolvedTarget: {
        organizationId:
          "11111111-1111-4111-8111-111111111111",
        teamId:
          "66666666-6666-4666-8666-666666666666"
      }
    })
  );

  assert.deepEqual(second, first);
  assert.match(
    first.plan.operationKey,
    /^sha256:[0-9a-f]{64}$/
  );
  assert.deepEqual(
    {
      operationKey: first.plan.operationKey,
      payloadDigest: first.plan.payloadDigest,
      planDigest: first.plan.planDigest
    },
    {
      operationKey:
        "sha256:216863cf6d1c42e21a2fe6e96cf4976fbe6ff74e108d155c1453a4902e5ee216",
      payloadDigest:
        "sha256:aa3cc0ad3dbd6d22b8245f0811e1c23d5b020406d60246f19efbfca5cbc51211",
      planDigest:
        "sha256:7b8523a7dd4d8ee31abf60c1ec2d2587d4d2605927317a2e52728479dc185cb2"
    }
  );
  assert.match(
    first.plan.payloadDigest,
    /^sha256:[0-9a-f]{64}$/
  );
  assert.match(
    first.plan.planDigest,
    /^sha256:[0-9a-f]{64}$/
  );
  assert.equal(
    changedPayload.plan.operationKey,
    first.plan.operationKey
  );
  assert.notEqual(
    changedPayload.plan.payloadDigest,
    first.plan.payloadDigest
  );
  assert.equal(
    classifyControlledWritePlan(
      first.plan,
      changedPayload.plan
    ),
    "conflict"
  );
  assert.equal(
    classifyControlledWritePlan(first.plan, second.plan),
    "idempotent"
  );
  assert.equal(
    classifyControlledWritePlan(
      first.plan,
      changedIdentity.plan
    ),
    "different"
  );
  assert.equal(
    changedScope.plan.operationKey,
    first.plan.operationKey
  );
  assert.equal(
    classifyControlledWritePlan(
      first.plan,
      changedScope.plan
    ),
    "conflict"
  );
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.plan), true);
  assert.equal(Object.isFrozen(first.plan.payload), true);
});

test("controlled write plan rejects drift, unsafe values, and claimed digest tampering", () => {
  const prototypeField = input();
  Object.defineProperty(prototypeField, "__proto__", {
    value: { polluted: true },
    enumerable: true
  });
  const invalidInputs = [
    input({
      clientRequestId:
        "33333333-3333-3333-8333-333333333333"
    }),
    input({
      clientRequestId:
        "33333333-3333-4333-7333-333333333333"
    }),
    input({
      resolvedTarget: {
        organizationId:
          "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        teamId:
          "22222222-2222-4222-8222-222222222222"
      }
    }),
    input({
      configuredTarget: {
        kind: "team",
        key: "github:repository:netpilot-z/taskseal"
      }
    }),
    input({
      payload: {
        title: " has leading whitespace",
        description: "Reviewed."
      }
    }),
    input({
      payload: {
        title: "\ud800",
        description: "Reviewed."
      }
    }),
    input({
      payload: {
        title: "Hidden\u0085control",
        description: "Reviewed."
      }
    }),
    input({
      payload: {
        title: "Hidden\u2028line",
        description: "Reviewed."
      }
    }),
    input({
      payload: {
        title: "Reviewed title",
        description: "Line one\r\nLine two"
      }
    }),
    input({
      configuredTarget: {
        kind: "team",
        key: "linear:team-ref:netpilot z/netpilot"
      }
    }),
    {
      ...input(),
      extra: true
    },
    prototypeField
  ];

  for (const value of invalidInputs) {
    assert.throws(
      () => createControlledWriteOperation(value),
      hasCode("CONTROLLED_WRITE_INVALID")
    );
  }

  const operation = createControlledWriteOperation(input());
  const tampered = structuredClone(operation);
  tampered.plan.payload.description = "Tampered";

  assert.throws(
    () => parseControlledWriteOperation(tampered),
    hasCode("CONTROLLED_WRITE_INVALID")
  );
  assert.throws(
    () =>
      transitionControlledWriteOperation(operation, {
        ...approvalAction(operation, "approve"),
        actor: {
          type: "human",
          id: "owner@example.com"
        }
      }),
    hasCode("CONTROLLED_WRITE_INVALID")
  );
});

test("approval binds the exact operation and plan digest", () => {
  const operation = createControlledWriteOperation(input());
  const approved = transitionControlledWriteOperation(
    operation,
    approvalAction(operation, "approve")
  );

  assert.equal(operation.status, "approval_required");
  assert.equal(operation.version, 1);
  assert.equal(approved.status, "approved");
  assert.equal(approved.version, 2);
  assert.deepEqual(approved.approval, {
    decision: "approved",
    actor: {
      type: "human",
      id: "owner"
    },
    operationKey: operation.plan.operationKey,
    planDigest: operation.plan.planDigest,
    decidedAt: "2026-07-27T10:01:00.000Z"
  });

  assert.throws(
    () =>
      transitionControlledWriteOperation(operation, {
        ...approvalAction(operation, "approve"),
        planDigest: digest("f")
      }),
    hasCode("CONTROLLED_WRITE_APPROVAL_MISMATCH")
  );
  assert.throws(
    () =>
      transitionControlledWriteOperation(operation, {
        ...approvalAction(operation, "approve"),
        actor: {
          type: "agent",
          id: "untrusted"
        }
      }),
    hasCode("CONTROLLED_WRITE_INVALID")
  );
});

test("rejected operations are terminal", () => {
  const operation = createControlledWriteOperation(input());
  const rejected = transitionControlledWriteOperation(
    operation,
    approvalAction(operation, "reject")
  );

  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.approval?.decision, "rejected");
  assert.throws(
    () =>
      transitionControlledWriteOperation(rejected, {
        type: "begin_submission",
        occurredAt: "2026-07-27T10:02:00.000Z"
      }),
    hasCode("CONTROLLED_WRITE_TRANSITION_INVALID")
  );
});

test("approved operation reaches a redacted created receipt", () => {
  const operation = createControlledWriteOperation(input());
  const approved = transitionControlledWriteOperation(
    operation,
    approvalAction(operation, "approve")
  );
  const submitting = transitionControlledWriteOperation(
    approved,
    {
      type: "begin_submission",
      occurredAt: "2026-07-27T10:02:00.000Z"
    }
  );
  assert.throws(
    () =>
      transitionControlledWriteOperation(submitting, {
        type: "submission_created",
        occurredAt: "2026-07-27T10:03:00.000Z",
        observedTeamId:
          "22222222-2222-4222-8222-222222222222",
        issue: {
          ...issue(),
          id: "55555555-5555-4555-8555-555555555555"
        }
      }),
    hasCode("CONTROLLED_WRITE_TRANSITION_INVALID")
  );
  assert.throws(
    () =>
      transitionControlledWriteOperation(submitting, {
        type: "submission_created",
        occurredAt: "2026-07-27T10:03:00.000Z",
        observedTeamId:
          "66666666-6666-4666-8666-666666666666",
        issue: issue()
      }),
    hasCode("CONTROLLED_WRITE_TRANSITION_INVALID")
  );
  const created = transitionControlledWriteOperation(
    submitting,
    {
      type: "submission_created",
      occurredAt: "2026-07-27T10:03:00.000Z",
      observedTeamId:
        "22222222-2222-4222-8222-222222222222",
      issue: issue()
    }
  );

  assert.equal(submitting.status, "submitting");
  assert.equal(submitting.version, 3);
  assert.equal(submitting.submission.attempt, 1);
  assert.equal(created.status, "created");
  assert.equal(created.version, 4);
  assert.deepEqual(created.submission.issue, issue());
  assert.equal(created.diagnosticCode, null);
  assert.deepEqual(
    parseControlledWriteOperation(
      JSON.parse(JSON.stringify(created))
    ),
    created
  );
  assert.doesNotMatch(
    JSON.stringify(created),
    /token|authorization|rawResponse/i
  );
  assert.throws(
    () =>
      transitionControlledWriteOperation(created, {
        type: "begin_submission",
        occurredAt: "2026-07-27T10:04:00.000Z"
      }),
    hasCode("CONTROLLED_WRITE_TRANSITION_INVALID")
  );
});

test("outcome unknown is fenced until reconciliation finds the Issue", () => {
  const submitting = createSubmittingOperation();
  const unknown = transitionControlledWriteOperation(
    submitting,
    {
      type: "submission_outcome_unknown",
      occurredAt: "2026-07-27T10:03:00.000Z",
      diagnosticCode: "LINEAR_WRITE_OUTCOME_UNKNOWN"
    }
  );

  assert.equal(unknown.status, "outcome_unknown");
  assert.throws(
    () =>
      transitionControlledWriteOperation(unknown, {
        type: "begin_submission",
        occurredAt: "2026-07-27T10:04:00.000Z"
      }),
    hasCode("CONTROLLED_WRITE_TRANSITION_INVALID")
  );

  const reconciling = transitionControlledWriteOperation(
    unknown,
    {
      type: "begin_reconciliation",
      occurredAt: "2026-07-27T10:04:00.000Z"
    }
  );
  const reconciled = transitionControlledWriteOperation(
    reconciling,
    {
      type: "reconciliation_found",
      occurredAt: "2026-07-27T10:05:00.000Z",
      observedTeamId:
        "22222222-2222-4222-8222-222222222222",
      issue: issue()
    }
  );

  assert.equal(reconciling.status, "reconciling");
  assert.equal(reconciling.reconciliation?.attempt, 1);
  assert.equal(reconciled.status, "reconciled");
  assert.equal(reconciled.reconciliation?.result, "found");
  assert.deepEqual(
    reconciled.reconciliation?.issue,
    issue()
  );
  assert.throws(
    () =>
      transitionControlledWriteOperation(reconciling, {
        type: "reconciliation_found",
        occurredAt: "2026-07-27T10:05:00.000Z",
        observedTeamId:
          "66666666-6666-4666-8666-666666666666",
        issue: issue()
      }),
    hasCode("CONTROLLED_WRITE_TRANSITION_INVALID")
  );
});

test("reconciliation absent stays fenced but permits an explicit repeated query", () => {
  const reconciling = createReconcilingOperation();
  const absent = transitionControlledWriteOperation(
    reconciling,
    {
      type: "reconciliation_absent",
      occurredAt: "2026-07-27T10:05:00.000Z"
    }
  );

  assert.equal(absent.status, "reconciliation_absent");
  assert.equal(absent.reconciliation?.result, "absent");
  assert.equal(absent.reconciliation?.issue, null);
  assert.throws(
    () =>
      transitionControlledWriteOperation(absent, {
        type: "begin_submission",
        occurredAt: "2026-07-27T10:06:00.000Z"
      }),
    hasCode("CONTROLLED_WRITE_TRANSITION_INVALID")
  );
  const nextQuery = transitionControlledWriteOperation(
    absent,
    {
      type: "begin_reconciliation",
      occurredAt: "2026-07-27T10:06:00.000Z"
    }
  );
  assert.equal(nextQuery.status, "reconciling");
  assert.equal(nextQuery.reconciliation?.attempt, 2);
});

test("failed reconciliation preserves the unknown fence and permits another query", () => {
  const reconciling = createReconcilingOperation();
  const unknown = transitionControlledWriteOperation(
    reconciling,
    {
      type: "reconciliation_failed",
      occurredAt: "2026-07-27T10:05:00.000Z",
      diagnosticCode: "LINEAR_RECONCILIATION_FAILED"
    }
  );
  const nextReconciliation =
    transitionControlledWriteOperation(unknown, {
      type: "begin_reconciliation",
      occurredAt: "2026-07-27T10:06:00.000Z"
    });

  assert.equal(unknown.status, "outcome_unknown");
  assert.equal(unknown.reconciliation?.result, "failed");
  assert.equal(nextReconciliation.status, "reconciling");
  assert.equal(
    nextReconciliation.reconciliation?.attempt,
    2
  );
});

test("ambiguous reconciliation preserves the unknown fence with its own safe code", () => {
  const reconciling = createReconcilingOperation();
  const unknown = transitionControlledWriteOperation(
    reconciling,
    {
      type: "reconciliation_ambiguous",
      occurredAt: "2026-07-27T10:05:00.000Z",
      diagnosticCode:
        "LINEAR_RECONCILIATION_AMBIGUOUS"
    }
  );

  assert.equal(unknown.status, "outcome_unknown");
  assert.equal(
    unknown.reconciliation?.result,
    "ambiguous"
  );
});

test("known not-dispatched submission is terminal and stores only a safe code", () => {
  const submitting = createSubmittingOperation();
  const failed = transitionControlledWriteOperation(
    submitting,
    {
      type: "submission_not_dispatched",
      occurredAt: "2026-07-27T10:03:00.000Z",
      diagnosticCode: "LINEAR_WRITE_NOT_DISPATCHED"
    }
  );

  assert.equal(failed.status, "failed");
  assert.equal(
    failed.diagnosticCode,
    "LINEAR_WRITE_NOT_DISPATCHED"
  );
  assert.throws(
    () =>
      transitionControlledWriteOperation(
        submitting,
        {
          type: "submission_not_dispatched",
          occurredAt: "2026-07-27T10:03:00.000Z",
          diagnosticCode:
            "Bearer SECRET: upstream response"
        }
      ),
    hasCode("CONTROLLED_WRITE_INVALID")
  );
});

test("operation parser rejects semantic tampering, extra fields, and time regression", () => {
  const submitting = createSubmittingOperation();
  const invalidRecords = [
    {
      ...structuredClone(submitting),
      version: 99
    },
    {
      ...structuredClone(submitting),
      status: "created"
    },
    {
      ...structuredClone(submitting),
      extra: true
    }
  ];

  for (const value of invalidRecords) {
    assert.throws(
      () => parseControlledWriteOperation(value),
      hasCode("CONTROLLED_WRITE_INVALID")
    );
  }

  assert.throws(
    () =>
      transitionControlledWriteOperation(submitting, {
        type: "submission_created",
        occurredAt: "2026-07-27T10:01:59.000Z",
        observedTeamId:
          "22222222-2222-4222-8222-222222222222",
        issue: issue()
      }),
    hasCode("CONTROLLED_WRITE_TRANSITION_INVALID")
  );
});

test("adjacent snapshots preserve the exact state-machine history", () => {
  const initial = createControlledWriteOperation(input());
  const approved = transitionControlledWriteOperation(
    initial,
    approvalAction(initial, "approve")
  );
  const rejected = transitionControlledWriteOperation(
    initial,
    approvalAction(initial, "reject")
  );
  const submitting = transitionControlledWriteOperation(
    approved,
    {
      type: "begin_submission",
      occurredAt: "2026-07-27T10:02:00.000Z"
    }
  );
  const created = transitionControlledWriteOperation(
    submitting,
    {
      type: "submission_created",
      occurredAt: "2026-07-27T10:03:00.000Z",
      observedTeamId:
        "22222222-2222-4222-8222-222222222222",
      issue: issue()
    }
  );
  const notDispatched =
    transitionControlledWriteOperation(submitting, {
      type: "submission_not_dispatched",
      occurredAt: "2026-07-27T10:03:00.000Z",
      diagnosticCode: "LINEAR_WRITE_NOT_DISPATCHED"
    });
  const unknown = transitionControlledWriteOperation(
    submitting,
    {
      type: "submission_outcome_unknown",
      occurredAt: "2026-07-27T10:03:00.000Z",
      diagnosticCode: "LINEAR_WRITE_OUTCOME_UNKNOWN"
    }
  );
  const reconciling = transitionControlledWriteOperation(
    unknown,
    {
      type: "begin_reconciliation",
      occurredAt: "2026-07-27T10:04:00.000Z"
    }
  );
  const found = transitionControlledWriteOperation(
    reconciling,
    {
      type: "reconciliation_found",
      occurredAt: "2026-07-27T10:05:00.000Z",
      observedTeamId:
        "22222222-2222-4222-8222-222222222222",
      issue: issue()
    }
  );
  const absent = transitionControlledWriteOperation(
    reconciling,
    {
      type: "reconciliation_absent",
      occurredAt: "2026-07-27T10:05:00.000Z"
    }
  );
  const retrying = transitionControlledWriteOperation(
    absent,
    {
      type: "begin_reconciliation",
      occurredAt: "2026-07-27T10:06:00.000Z"
    }
  );
  const failed = transitionControlledWriteOperation(
    reconciling,
    {
      type: "reconciliation_failed",
      occurredAt: "2026-07-27T10:05:00.000Z",
      diagnosticCode: "LINEAR_RECONCILIATION_FAILED"
    }
  );
  const ambiguous = transitionControlledWriteOperation(
    reconciling,
    {
      type: "reconciliation_ambiguous",
      occurredAt: "2026-07-27T10:05:00.000Z",
      diagnosticCode:
        "LINEAR_RECONCILIATION_AMBIGUOUS"
    }
  );

  const legalPairs = [
    [initial, approved],
    [initial, rejected],
    [approved, submitting],
    [submitting, created],
    [submitting, notDispatched],
    [submitting, unknown],
    [unknown, reconciling],
    [reconciling, found],
    [reconciling, absent],
    [reconciling, failed],
    [reconciling, ambiguous],
    [absent, retrying]
  ] as const;

  for (const [previous, next] of legalPairs) {
    assert.deepEqual(
      validateControlledWriteOperationTransition(
        previous,
        next
      ),
      next
    );
  }

  const changedActor = parseControlledWriteOperation({
    ...structuredClone(submitting),
    approval: {
      ...structuredClone(submitting.approval),
      actor: {
        type: "human",
        id: "attacker"
      }
    }
  });
  const changedCreatedAt =
    parseControlledWriteOperation({
      ...structuredClone(submitting),
      createdAt: "2026-07-27T09:59:00.000Z"
    });
  const changedSubmission =
    parseControlledWriteOperation({
      ...structuredClone(reconciling),
      submission: {
        ...structuredClone(reconciling.submission),
        completedAt: "2026-07-27T10:02:30.000Z"
      }
    });
  const changedScopeInitial =
    createControlledWriteOperation(
      input({
        resolvedTarget: {
          organizationId:
            "11111111-1111-4111-8111-111111111111",
          teamId:
            "66666666-6666-4666-8666-666666666666"
        }
      })
    );
  const changedScopeApproved =
    transitionControlledWriteOperation(
      changedScopeInitial,
      approvalAction(changedScopeInitial, "approve")
    );
  const changedScopeSubmitting =
    transitionControlledWriteOperation(
      changedScopeApproved,
      {
        type: "begin_submission",
        occurredAt: "2026-07-27T10:02:00.000Z"
      }
    );

  for (const [previous, next] of [
    [approved, changedActor],
    [approved, changedCreatedAt],
    [approved, changedScopeSubmitting],
    [unknown, changedSubmission],
    [initial, submitting],
    [submitting, approved]
  ]) {
    assert.throws(
      () =>
        validateControlledWriteOperationTransition(
          previous,
          next
        ),
      hasCode("CONTROLLED_WRITE_TRANSITION_INVALID")
    );
  }
});

function createSubmittingOperation() {
  const operation = createControlledWriteOperation(input());
  const approved = transitionControlledWriteOperation(
    operation,
    approvalAction(operation, "approve")
  );
  return transitionControlledWriteOperation(approved, {
    type: "begin_submission",
    occurredAt: "2026-07-27T10:02:00.000Z"
  });
}

function createReconcilingOperation() {
  const submitting = createSubmittingOperation();
  const unknown = transitionControlledWriteOperation(
    submitting,
    {
      type: "submission_outcome_unknown",
      occurredAt: "2026-07-27T10:03:00.000Z",
      diagnosticCode: "LINEAR_WRITE_OUTCOME_UNKNOWN"
    }
  );
  return transitionControlledWriteOperation(unknown, {
    type: "begin_reconciliation",
    occurredAt: "2026-07-27T10:04:00.000Z"
  });
}

function approvalAction(
  operation: ReturnType<
    typeof createControlledWriteOperation
  >,
  type: "approve" | "reject"
) {
  return {
    type,
    actor: {
      type: "human" as const,
      id: "owner"
    },
    operationKey: operation.plan.operationKey,
    planDigest: operation.plan.planDigest,
    occurredAt: "2026-07-27T10:01:00.000Z"
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    configuredTarget: {
      kind: "team",
      key: "linear:team-ref:netpilot-z/netpilot"
    },
    resolvedTarget: {
      organizationId:
        "11111111-1111-4111-8111-111111111111",
      teamId:
        "22222222-2222-4222-8222-222222222222"
    },
    clientRequestId:
      "33333333-3333-4333-8333-333333333333",
    payload: {
      title: "Create the delivery ticket",
      description: "Reviewed TaskSeal work."
    },
    preparedAt: "2026-07-27T10:00:00.000Z",
    ...overrides
  };
}

function issue() {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    identifier: "NP-101"
  };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error: unknown) =>
    isRecord(error) && error.code === code;
}

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}
