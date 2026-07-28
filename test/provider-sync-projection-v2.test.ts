import assert from "node:assert/strict";
import test from "node:test";

import {
  createControlledWriteOperationV2
} from "../src/application/controlled-write-operation.ts";
import {
  projectProviderOperations
} from "../src/application/provider-sync-projection.ts";

test("the v1 operation projection safely represents a v2 target without leaking placement or source", () => {
  const operation = createControlledWriteOperationV2({
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
      organizationId:
        "11111111-1111-4111-8111-111111111111",
      teamId:
        "22222222-2222-4222-8222-222222222222",
      projectId:
        "33333333-3333-4333-8333-333333333333",
      stateId:
        "44444444-4444-4444-8444-444444444444",
      parentIssueId: null
    },
    clientRequestId:
      "55555555-5555-4555-8555-555555555555",
    sourceIntent: {
      kind: "taskseal.linear-ticket-draft",
      source: "docs/tickets/0005-linear-productization-milestone.md",
      sourceTicket: "T15.2",
      idempotencyKey: digest("a"),
      draftPayloadDigest: digest("b")
    },
    payload: {
      title: "Project v2 safely",
      description: "Do not expose source or UUIDs."
    },
    preparedAt: "2026-07-27T10:00:00.000Z"
  });

  const projected = projectProviderOperations([
    operation
  ]);
  assert.deepEqual(
    projected.operations[0]?.configuredTarget,
    {
      kind: "project_state",
      key:
        "linear:project-state-ref:" +
        "netpilot-z/netpilot/TaskSeal/Backlog"
    }
  );
  assert.doesNotMatch(
    JSON.stringify(projected),
    /organizationId|teamId|projectId|stateId|parentIssueId|sourceIntent|idempotencyKey/
  );
});

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
