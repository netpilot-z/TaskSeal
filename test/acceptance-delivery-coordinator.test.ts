import assert from "node:assert/strict";
import test from "node:test";

import {
  AcceptanceDeliveryCoordinator
} from "../src/application/acceptance-delivery-coordinator.ts";
import type {
  ControlledTransitionOperation
} from "../src/application/controlled-transition-operation.ts";
import type {
  WorkItemAcceptanceResult
} from "../src/application/work-item-acceptance.ts";

const DECISION_ID =
  "00000000-0000-4000-8000-000000000007";
const REVIEW_REVISION =
  `sha256:${"1".repeat(64)}`;
const ACCEPTANCE_DIGEST =
  `sha256:${"2".repeat(64)}`;

test("rejected delivery is committed locally and never invokes Linear", async () => {
  const service =
    new FakeAcceptanceService("rejected");
  let transitionCalls = 0;
  const coordinator =
    new AcceptanceDeliveryCoordinator({
      acceptance: service,
      actor: "operator.jeffrey",
      transition: {
        async prepare() {
          transitionCalls += 1;
          throw new Error("must not prepare");
        },
        async approve() {
          transitionCalls += 1;
          throw new Error("must not approve");
        },
        async submit() {
          transitionCalls += 1;
          throw new Error("must not submit");
        }
      }
    });

  const result = await coordinator.decide(
    command("rejected")
  );

  assert.equal(
    result.local.decision.decision,
    "rejected"
  );
  assert.deepEqual(result.linearSync, {
    status: "not_applicable"
  });
  assert.equal(transitionCalls, 0);
  assert.equal(
    service.inputs[0]?.actor,
    "operator.jeffrey"
  );
});

test("disabled transition keeps accepted local truth and performs zero provider work", async () => {
  const service =
    new FakeAcceptanceService("accepted");
  const coordinator =
    new AcceptanceDeliveryCoordinator({
      acceptance: service,
      actor: "operator.jeffrey",
      transition: null
    });

  const result = await coordinator.decide(
    command("accepted")
  );

  assert.equal(
    result.local.decision.decision,
    "accepted"
  );
  assert.deepEqual(result.linearSync, {
    status: "disabled"
  });
});

test("accepted delivery binds one transition plan to the same human decision", async () => {
  const service =
    new FakeAcceptanceService("accepted");
  const calls: unknown[] = [];
  const prepared =
    transitionOperation(
      "approval_required",
      1
    );
  const approved =
    transitionOperation("approved", 2);
  const transitioned =
    transitionOperation("transitioned", 4);
  const coordinator =
    new AcceptanceDeliveryCoordinator({
      acceptance: service,
      actor: "operator.jeffrey",
      transition: {
        async prepare(input) {
          calls.push(["prepare", input]);
          return prepared;
        },
        async approve(input) {
          calls.push(["approve", input]);
          return approved;
        },
        async submit(input) {
          calls.push(["submit", input]);
          return transitioned;
        }
      }
    });

  const result = await coordinator.decide(
    command("accepted")
  );

  assert.deepEqual(calls, [
    [
      "prepare",
      {
        workItemId: "TS-7",
        decisionId: DECISION_ID,
        acceptanceDigest:
          ACCEPTANCE_DIGEST
      }
    ],
    [
      "approve",
      {
        operationKey:
          prepared.plan.operationKey,
        planDigest:
          prepared.plan.planDigest,
        actor: {
          type: "human",
          id: "operator.jeffrey"
        }
      }
    ],
    [
      "submit",
      {
        operationKey:
          approved.plan.operationKey,
        planDigest:
          approved.plan.planDigest
      }
    ]
  ]);
  assert.deepEqual(result.linearSync, {
    status: "transitioned",
    operationKey:
      transitioned.plan.operationKey,
    version: 4,
    diagnosticCode: null
  });
});

test("provider failure cannot erase a committed local acceptance", async () => {
  const service =
    new FakeAcceptanceService("accepted");
  const coordinator =
    new AcceptanceDeliveryCoordinator({
      acceptance: service,
      actor: "operator.jeffrey",
      transition: {
        async prepare() {
          throw Object.assign(
            new Error(
              "SECRET upstream response"
            ),
            {
              code:
                "LINEAR_TRANSITION_PRECONDITION_STALE"
            }
          );
        },
        async approve() {
          throw new Error("unreachable");
        },
        async submit() {
          throw new Error("unreachable");
        }
      }
    });

  const result = await coordinator.decide(
    command("accepted")
  );

  assert.equal(
    result.local.decision.decision,
    "accepted"
  );
  assert.deepEqual(result.linearSync, {
    status: "sync_failed",
    diagnosticCode:
      "LINEAR_TRANSITION_PRECONDITION_STALE"
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    /SECRET/
  );
});

test("acceptance command rejects browser-owned actor and unknown fields", async () => {
  const service =
    new FakeAcceptanceService("accepted");
  const coordinator =
    new AcceptanceDeliveryCoordinator({
      acceptance: service,
      actor: "operator.jeffrey",
      transition: null
    });

  await assert.rejects(
    coordinator.decide({
      ...command("accepted"),
      actor: "browser.attacker"
    }),
    hasCode(
      "ACCEPTANCE_DELIVERY_COMMAND_INVALID"
    )
  );
  assert.equal(service.inputs.length, 0);
});

test("reconciliation resolves the persisted plan digest instead of trusting the browser", async () => {
  const operation =
    transitionOperation(
      "outcome_unknown",
      4
    );
  const calls: unknown[] = [];
  const coordinator =
    new AcceptanceDeliveryCoordinator({
      acceptance:
        new FakeAcceptanceService(
          "accepted"
        ),
      actor: "operator.jeffrey",
      transition: {
        async prepare() {
          throw new Error("not called");
        },
        async approve() {
          throw new Error("not called");
        },
        async submit() {
          throw new Error("not called");
        },
        async get(operationKey) {
          calls.push([
            "get",
            operationKey
          ]);
          return operation;
        },
        async reconcile(input) {
          calls.push([
            "reconcile",
            input
          ]);
          return transitionOperation(
            "reconciled",
            6
          );
        }
      }
    });

  const result =
    await coordinator.reconcile({
      operationKey:
        operation.plan.operationKey
    });

  assert.equal(
    result.status,
    "reconciled"
  );
  assert.deepEqual(calls, [
    [
      "get",
      operation.plan.operationKey
    ],
    [
      "reconcile",
      {
        operationKey:
          operation.plan.operationKey,
        planDigest:
          operation.plan.planDigest
      }
    ]
  ]);
  await assert.rejects(
    coordinator.reconcile({
      operationKey:
        operation.plan.operationKey,
      planDigest:
        operation.plan.planDigest
    }),
    hasCode(
      "ACCEPTANCE_DELIVERY_COMMAND_INVALID"
    )
  );
});

function command(
  decision: "accepted" | "rejected"
) {
  return {
    workItemId: "TS-7",
    decisionId: DECISION_ID,
    decision,
    reason:
      decision === "accepted"
        ? "Evidence reviewed."
        : "Revision needs changes.",
    expectedReviewRevision:
      REVIEW_REVISION
  };
}

class FakeAcceptanceService {
  readonly inputs:
    Array<Record<string, unknown>> = [];
  readonly #decision:
    "accepted" | "rejected";

  constructor(
    decision: "accepted" | "rejected"
  ) {
    this.#decision = decision;
  }

  async decideAcceptance(
    input: Record<string, unknown>
  ): Promise<WorkItemAcceptanceResult> {
    this.inputs.push(
      structuredClone(input)
    );
    return {
      resolution: "committed",
      workItemId: "TS-7",
      eventId:
        `taskseal:acceptance:${DECISION_ID}`,
      acceptanceDigest:
        ACCEPTANCE_DIGEST,
      decision: {
        decision: this.#decision,
        actor: "operator.jeffrey",
        reason: String(input.reason),
        decidedAt:
          "2026-07-28T00:04:00.000Z",
        basis: {
          decisionId: DECISION_ID,
          reviewRevision:
            REVIEW_REVISION,
          attemptId: "attempt-7",
          artifactId: "artifact-7",
          artifactRevision: "revision-7"
        }
      }
    };
  }
}

function transitionOperation(
  status:
    | "approval_required"
    | "approved"
    | "transitioned"
    | "outcome_unknown"
    | "reconciled",
  version: number
): ControlledTransitionOperation {
  return {
    schemaVersion: 3,
    plan: {
      schemaVersion: 3,
      provider: "linear",
      capability: "acceptance.write",
      action: "work-item.transition",
      configuredTarget: {
        kind: "issue_state",
        key:
          "linear:issue-state-ref:netpilot-z/netpilot/TaskSeal/Todo/Done",
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
          "2026-07-28T00:03:00.000Z",
        targetStateId:
          "2d716bbd-be75-4718-95c9-27f184d19e56"
      },
      sourceIntent: {
        kind:
          "taskseal.acceptance-decision",
        workItemId: "TS-7",
        decisionId: DECISION_ID,
        reviewRevision:
          REVIEW_REVISION,
        acceptanceDigest:
          ACCEPTANCE_DIGEST
      },
      operationKey:
        `sha256:${"3".repeat(64)}`,
      planDigest:
        `sha256:${"4".repeat(64)}`
    },
    version,
    status,
    approval:
      status === "approval_required"
        ? null
        : {
            decision: "approved",
            actor: {
              type: "human",
              id: "operator.jeffrey"
            },
            operationKey:
              `sha256:${"3".repeat(64)}`,
            planDigest:
              `sha256:${"4".repeat(64)}`,
            decidedAt:
              "2026-07-28T00:05:00.000Z"
          },
    submission: {
      attempt:
        status === "transitioned" ? 1 : 0,
      startedAt:
        status === "transitioned"
          ? "2026-07-28T00:06:00.000Z"
          : null,
      completedAt:
        status === "transitioned"
          ? "2026-07-28T00:07:00.000Z"
          : null,
      issue: null
    },
    reconciliation: null,
    diagnosticCode: null,
    createdAt:
      "2026-07-28T00:04:00.000Z",
    updatedAt:
      "2026-07-28T00:07:00.000Z"
  };
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}
