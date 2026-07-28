import assert from "node:assert/strict";
import test from "node:test";

import {
  createControlledTransitionOperation,
  transitionControlledTransitionOperation
} from "../src/application/controlled-transition-operation.ts";
import {
  projectProviderOperations
} from "../src/application/provider-sync-projection.ts";

const START =
  "2026-07-28T00:05:00.000Z";

test("transition operations expose only work-item correlation and safe sync state", () => {
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
          id: "SECRET_OPERATOR"
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
        issue: {
          id:
            "70cbe548-5e6c-4d35-b019-a570058a8cf2",
          identifier: "NP-7",
          revisionId:
            "2026-07-28T00:08:00.000Z",
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
        }
      }
    );

  const projection =
    projectProviderOperations([
      transitioned
    ]);
  assert.deepEqual(
    projection.operations,
    [
      {
        schemaVersion: 2,
        provider: "linear",
        action: "work-item.transition",
        workItemId: "TS-7",
        acceptanceDecisionId:
          "00000000-0000-4000-8000-000000000007",
        operationKey:
          transitioned.plan.operationKey,
        configuredTarget: {
          kind: "issue_state",
          key:
            transitioned.plan
              .configuredTarget.key
        },
        version: 4,
        status: "transitioned",
        approval: {
          decision: "approved",
          decidedAt:
            "2026-07-28T00:06:00.000Z"
        },
        diagnosticCode: null,
        createdAt: START,
        updatedAt:
          "2026-07-28T00:08:00.000Z"
      }
    ]
  );

  const serialized =
    JSON.stringify(projection);
  for (const forbidden of [
    "SECRET_OPERATOR",
    "reviewRevision",
    "acceptanceDigest",
    "resolvedTarget",
    "organizationId",
    "teamId",
    "projectId",
    "issueId",
    "stateId",
    "identifier",
    "planDigest"
  ]) {
    assert.doesNotMatch(
      serialized,
      new RegExp(forbidden)
    );
  }
});

test("legacy create operation projection remains schema version 1", async () => {
  const {
    createControlledWriteOperation
  } = await import(
    "../src/application/controlled-write-operation.ts"
  );
  const operation =
    createControlledWriteOperation({
      configuredTarget: {
        kind: "team",
        key:
          "linear:team-ref:taskseal/netpilot"
      },
      resolvedTarget: {
        organizationId:
          "7eb4877f-0fa0-429c-9cd2-76dfffa0f20b",
        teamId:
          "658d1189-f63d-4245-b761-0f4f2c389663"
      },
      clientRequestId:
        "00000000-0000-4000-8000-000000000007",
      payload: {
        title: "Title",
        description: "Description"
      },
      preparedAt: START
    });

  assert.equal(
    projectProviderOperations([
      operation
    ]).operations[0]?.schemaVersion,
    1
  );
});

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
      workItemId: "TS-7",
      decisionId:
        "00000000-0000-4000-8000-000000000007",
      reviewRevision:
        `sha256:${"1".repeat(64)}`,
      acceptanceDigest:
        `sha256:${"2".repeat(64)}`
    },
    preparedAt: START
  };
}
