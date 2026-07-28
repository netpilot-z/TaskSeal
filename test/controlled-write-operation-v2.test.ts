import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  classifyControlledWritePlan,
  createControlledWriteOperation,
  createControlledWriteOperationV2,
  parseControlledWriteOperation,
  transitionControlledWriteOperation,
  validateControlledWriteOperationTransition
} from "../src/application/controlled-write-operation.ts";

const ORGANIZATION_ID =
  "11111111-1111-4111-8111-111111111111";
const TEAM_ID =
  "22222222-2222-4222-8222-222222222222";
const CLIENT_REQUEST_ID =
  "33333333-3333-4333-8333-333333333333";
const PROJECT_ID =
  "44444444-4444-4444-8444-444444444444";
const STATE_ID =
  "55555555-5555-4555-8555-555555555555";
const PARENT_ISSUE_ID =
  "66666666-6666-4666-8666-666666666666";

test("the literal v1 record keeps its persisted serialization and digests", async () => {
  const raw = (
    await readFile(
      new URL(
        "../fixtures/linear/controlled-write-operation-v1.json",
        import.meta.url
      ),
      "utf8"
    )
  ).trim();
  const parsed = parseControlledWriteOperation(
    JSON.parse(raw)
  );

  assert.equal(parsed.schemaVersion, 1);
  assert.equal(JSON.stringify(parsed), raw);
  assert.deepEqual(
    parsed,
    createControlledWriteOperation(v1Input())
  );
});

test("v2 binds project, state, parent, source intent, and payload without changing operation identity", () => {
  const first = createControlledWriteOperationV2(
    v2Input()
  );
  const second = createControlledWriteOperationV2(
    v2Input()
  );
  const legacy = createControlledWriteOperation(
    v1Input()
  );

  assert.deepEqual(second, first);
  assert.equal(first.schemaVersion, 2);
  assert.equal(first.plan.schemaVersion, 2);
  assert.equal(
    first.plan.operationKey,
    legacy.plan.operationKey
  );
  assert.equal(
    first.plan.payloadDigest,
    legacy.plan.payloadDigest
  );
  assert.equal(
    classifyControlledWritePlan(
      legacy.plan,
      first.plan
    ),
    "conflict"
  );
  assert.deepEqual(
    {
      sourceIntentDigest:
        first.plan.sourceIntentDigest,
      planDigest: first.plan.planDigest
    },
    {
      sourceIntentDigest:
        "sha256:cdba95622c1462a8eb9b1a153a4e2f5efc4523b7c411bc0e2c4758006a3fbbea",
      planDigest:
        "sha256:e92c97e8cb32fe3b8e25b2f8b1eec35f2e6e4cd84c8bb1a6878bbecac0fce1e5"
    }
  );
  assert.equal(
    first.plan.configuredTarget.key,
    "linear:project-state-ref:netpilot-z/netpilot/TaskSeal/Backlog"
  );
  assert.equal(Object.isFrozen(first), true);
  assert.equal(
    Object.isFrozen(first.plan.sourceIntent),
    true
  );
});

test("v2 parser fails closed on placement, source, digest, version, and path drift", () => {
  const operation = createControlledWriteOperationV2(
    v2Input()
  );
  const tamperedValues = [
    mutate(operation, (value) => {
      value.plan.resolvedTarget.projectId =
        "77777777-7777-4777-8777-777777777777";
    }),
    mutate(operation, (value) => {
      value.plan.sourceIntent.sourceTicket = "T99";
    }),
    mutate(operation, (value) => {
      value.plan.sourceIntentDigest = digest("f");
    }),
    mutate(operation, (value) => {
      value.plan.configuredTarget.key =
        "linear:project-state-ref:wrong";
    }),
    mutate(operation, (value) => {
      value.schemaVersion = 1;
    }),
    {
      ...structuredClone(operation),
      extra: true
    }
  ];

  for (const value of tamperedValues) {
    assert.throws(
      () => parseControlledWriteOperation(value),
      hasCode("CONTROLLED_WRITE_INVALID")
    );
  }

  for (const source of [
    "volume:/ticket.md",
    "/docs/ticket.md",
    "../docs/ticket.md",
    "docs/../ticket.md",
    "docs\\ticket.md",
    "docs//ticket.md"
  ]) {
    assert.throws(
      () =>
        createControlledWriteOperationV2(
          v2Input({
            sourceIntent: {
              ...v2Input().sourceIntent,
              source
            }
          })
        ),
      hasCode("CONTROLLED_WRITE_INVALID")
    );
  }
});

test("v2 transitions persist and replay the exact observed placement", () => {
  const prepared = createControlledWriteOperationV2(
    v2Input()
  );
  const approved = transitionControlledWriteOperation(
    prepared,
    approvalAction(prepared)
  );
  const submitting =
    transitionControlledWriteOperation(approved, {
      type: "begin_submission",
      occurredAt: "2026-07-27T10:02:00.000Z"
    });
  const created = transitionControlledWriteOperation(
    submitting,
    {
      type: "submission_created",
      occurredAt: "2026-07-27T10:03:00.000Z",
      observedPlacement: placement(),
      issue: {
        id: CLIENT_REQUEST_ID,
        identifier: "NP-101"
      }
    }
  );

  assert.equal(created.schemaVersion, 2);
  assert.deepEqual(created.submission.issue, {
    id: CLIENT_REQUEST_ID,
    identifier: "NP-101",
    placement: placement()
  });
  assert.deepEqual(
    validateControlledWriteOperationTransition(
      submitting,
      created
    ),
    created
  );
  const placementDrifts = [
    ["organizationId", TEAM_ID],
    ["teamId", PROJECT_ID],
    ["projectId", STATE_ID],
    ["stateId", PARENT_ISSUE_ID],
    ["parentIssueId", null]
  ] as const;

  for (const [field, value] of placementDrifts) {
    assert.throws(
      () =>
        parseControlledWriteOperation(
          mutate(created, (draft) => {
            draft.submission.issue.placement[
              field
            ] = value;
          })
        ),
      hasCode("CONTROLLED_WRITE_INVALID")
    );
  }

  const unknown = transitionControlledWriteOperation(
    submitting,
    {
      type: "submission_outcome_unknown",
      occurredAt: "2026-07-27T10:03:00.000Z",
      diagnosticCode:
        "LINEAR_WRITE_OUTCOME_UNKNOWN"
    }
  );
  const reconciling =
    transitionControlledWriteOperation(unknown, {
      type: "begin_reconciliation",
      occurredAt: "2026-07-27T10:04:00.000Z"
    });
  const reconciled =
    transitionControlledWriteOperation(
      reconciling,
      {
        type: "reconciliation_found",
        occurredAt:
          "2026-07-27T10:05:00.000Z",
        observedPlacement: placement(),
        issue: {
          id: CLIENT_REQUEST_ID,
          identifier: "NP-101"
        }
      }
    );
  assert.throws(
    () =>
      parseControlledWriteOperation(
        mutate(reconciled, (value) => {
          value.reconciliation.issue.placement.stateId =
            PROJECT_ID;
        })
      ),
    hasCode("CONTROLLED_WRITE_INVALID")
  );

  for (const [field, value] of placementDrifts) {
    assert.throws(
      () =>
        transitionControlledWriteOperation(
          submitting,
          {
            type: "submission_created",
            occurredAt:
              "2026-07-27T10:03:00.000Z",
            observedPlacement: {
              ...placement(),
              [field]: value
            },
            issue: {
              id: CLIENT_REQUEST_ID,
              identifier: "NP-101"
            }
          }
        ),
      hasCode(
        "CONTROLLED_WRITE_TRANSITION_INVALID"
      )
    );
  }
});

function v1Input() {
  return {
    configuredTarget: {
      kind: "team",
      key: "linear:team-ref:netpilot-z/netpilot"
    },
    resolvedTarget: {
      organizationId: ORGANIZATION_ID,
      teamId: TEAM_ID
    },
    clientRequestId: CLIENT_REQUEST_ID,
    payload: {
      title: "Create the delivery ticket",
      description: "Reviewed TaskSeal work."
    },
    preparedAt: "2026-07-27T10:00:00.000Z"
  };
}

function v2Input(
  overrides: Record<string, unknown> = {}
) {
  return {
    configuredTarget: {
      kind: "project_state",
      key:
        "linear:project-state-ref:" +
        "netpilot-z/netpilot/TaskSeal/Backlog",
      workspace: "netpilot-z",
      team: "netpilot",
      project: "TaskSeal",
      state: "Backlog"
    },
    resolvedTarget: {
      organizationId: ORGANIZATION_ID,
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      stateId: STATE_ID,
      parentIssueId: PARENT_ISSUE_ID
    },
    clientRequestId: CLIENT_REQUEST_ID,
    sourceIntent: {
      kind: "taskseal.linear-ticket-draft",
      source:
        "docs/tickets/0005-linear-productization-milestone.md",
      sourceTicket: "T15.2",
      idempotencyKey: digest("a"),
      draftPayloadDigest: digest("b")
    },
    payload: {
      title: "Create the delivery ticket",
      description: "Reviewed TaskSeal work."
    },
    preparedAt: "2026-07-27T10:00:00.000Z",
    ...overrides
  };
}

function placement() {
  return {
    organizationId: ORGANIZATION_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    stateId: STATE_ID,
    parentIssueId: PARENT_ISSUE_ID
  };
}

function approvalAction(
  operation: ReturnType<
    typeof createControlledWriteOperationV2
  >
) {
  return {
    type: "approve",
    actor: {
      type: "human" as const,
      id: "owner"
    },
    operationKey: operation.plan.operationKey,
    planDigest: operation.plan.planDigest,
    occurredAt: "2026-07-27T10:01:00.000Z"
  };
}

function mutate<T>(
  value: T,
  change: (draft: any) => void
): unknown {
  const draft = structuredClone(value);
  change(draft);
  return draft;
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
