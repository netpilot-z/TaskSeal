import assert from "node:assert/strict";
import test from "node:test";

import {
  ControlledWriteCoordinator
} from "../src/application/controlled-write-coordinator.ts";
import type {
  ControlledWriteOperation
} from "../src/application/controlled-write-operation.ts";
import {
  ProviderOperationJournal
} from "../src/application/provider-operation-journal.ts";
import type {
  ProviderOperationJournalFile,
  ProviderOperationJournalStoragePort
} from "../src/application/provider-operation-journal.ts";
import type {
  LinearWriteCreateInputV2,
  LinearWriteCreateResultV2,
  LinearWriteQueryInputV2,
  LinearWriteQueryResultV2,
  LinearWriteTransportPort,
  LinearWriteTransportV2Port
} from "../src/application/linear-write-transport.ts";

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
const OTHER_PROJECT_ID =
  "77777777-7777-4777-8777-777777777777";

const V2_INPUT = {
  configuredTarget: {
    kind: "project_state",
    key:
      "linear:project-state-ref:" +
      "netpilot-z/netpilot/TaskSeal/Todo",
    workspace: "netpilot-z",
    team: "netpilot",
    project: "TaskSeal",
    state: "Todo"
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
    title: "Add project-aware Linear writes",
    description:
      "Bind the reviewed TaskSeal ticket to its exact placement."
  }
} as const;

const EXPECTED_CREATE_INPUT = {
  clientRequestId: CLIENT_REQUEST_ID,
  organizationId: ORGANIZATION_ID,
  teamId: TEAM_ID,
  projectId: PROJECT_ID,
  stateId: STATE_ID,
  parentIssueId: PARENT_ISSUE_ID,
  title: V2_INPUT.payload.title,
  description: V2_INPUT.payload.description
} as const;

const EXPECTED_QUERY_INPUT = {
  clientRequestId: CLIENT_REQUEST_ID,
  organizationId: ORGANIZATION_ID,
  teamId: TEAM_ID,
  projectId: PROJECT_ID,
  stateId: STATE_ID,
  parentIssueId: PARENT_ISSUE_ID
} as const;

test("v2 prepare, approval, and submit grant one exact project-aware permit", async () => {
  const transportV2 =
    new RecordingLinearWriteTransportV2();
  const harness = await createHarness({
    transportV2
  });

  const prepared =
    await harness.coordinator.prepareV2(V2_INPUT);
  const approved =
    await harness.coordinator.approve(
      approvalInput(prepared)
    );
  const created =
    await harness.coordinator.submit(
      operationInput(prepared)
    );

  assert.equal(prepared.schemaVersion, 2);
  assert.equal(approved.status, "approved");
  assert.equal(created.status, "created");
  assert.deepEqual(
    transportV2.createInputs,
    [EXPECTED_CREATE_INPUT]
  );
  assert.equal(
    JSON.stringify(transportV2.createInputs).includes(
      "sourceIntent"
    ),
    false
  );
  assert.deepEqual(
    created.submission.issue,
    {
      id: CLIENT_REQUEST_ID,
      identifier: "NP-101",
      placement: V2_INPUT.resolvedTarget
    }
  );
  assert.deepEqual(
    (
      await harness.coordinator.history(
        prepared.plan.operationKey
      )
    ).map((operation) => operation.status),
    [
      "approval_required",
      "approved",
      "submitting",
      "created"
    ]
  );
});

test("v2 submit without a v2 port fails before journal advance or either transport", async () => {
  const v1 = new RecordingLinearWriteTransportV1();
  const harness = await createHarness({
    transport: v1
  });
  const prepared =
    await harness.coordinator.prepareV2(V2_INPUT);
  await harness.coordinator.approve(
    approvalInput(prepared)
  );
  const historyBefore =
    await harness.coordinator.history(
      prepared.plan.operationKey
    );

  await assert.rejects(
    harness.coordinator.submit(
      operationInput(prepared)
    ),
    hasCode(
      "CONTROLLED_WRITE_COORDINATOR_STATE_INVALID"
    )
  );

  assert.deepEqual(
    await harness.coordinator.history(
      prepared.plan.operationKey
    ),
    historyBefore
  );
  assert.equal(v1.callCount, 0);
});

test("v2 response loss reconciles by exact UUID and observed placement", async () => {
  const transportV2 =
    new RecordingLinearWriteTransportV2({
      createResult: {
        kind: "outcome_unknown",
        diagnosticCode:
          "LINEAR_WRITE_OUTCOME_UNKNOWN"
      }
    });
  const harness = await createHarness({
    transportV2
  });
  const prepared =
    await harness.coordinator.prepareV2(V2_INPUT);
  await harness.coordinator.approve(
    approvalInput(prepared)
  );

  const unknown =
    await harness.coordinator.submit(
      operationInput(prepared)
    );
  const reconciled =
    await harness.coordinator.reconcile(
      operationInput(prepared)
    );

  assert.equal(unknown.status, "outcome_unknown");
  assert.equal(reconciled.status, "reconciled");
  assert.deepEqual(
    transportV2.queryInputs,
    [EXPECTED_QUERY_INPUT]
  );
  assert.equal(
    JSON.stringify(transportV2.queryInputs).includes(
      "source"
    ),
    false
  );
});

test("v2 reconcile without a v2 port fails before journal advance", async () => {
  const transportV2 =
    new RecordingLinearWriteTransportV2({
      createResult: {
        kind: "outcome_unknown",
        diagnosticCode:
          "LINEAR_WRITE_OUTCOME_UNKNOWN"
      }
    });
  const first = await createHarness({
    transportV2
  });
  const prepared =
    await first.coordinator.prepareV2(V2_INPUT);
  await first.coordinator.approve(
    approvalInput(prepared)
  );
  await first.coordinator.submit(
    operationInput(prepared)
  );
  const historyBefore =
    await first.coordinator.history(
      prepared.plan.operationKey
    );
  const v1 =
    new RecordingLinearWriteTransportV1();
  const reopened =
    await ControlledWriteCoordinator.open({
      journal: first.journal,
      transport: v1,
      clock: monotonicClock()
    });

  await assert.rejects(
    reopened.reconcile(operationInput(prepared)),
    hasCode(
      "CONTROLLED_WRITE_COORDINATOR_STATE_INVALID"
    )
  );
  assert.deepEqual(
    await reopened.history(
      prepared.plan.operationKey
    ),
    historyBefore
  );
  assert.equal(v1.callCount, 0);
});

test("v2 placement drift becomes unknown on create and ambiguous on query", async () => {
  const driftedPlacement = {
    ...V2_INPUT.resolvedTarget,
    projectId: OTHER_PROJECT_ID
  };
  const transportV2 =
    new RecordingLinearWriteTransportV2({
      createResult: {
        kind: "created",
        issue: {
          id: CLIENT_REQUEST_ID,
          identifier: "NP-101"
        },
        observedPlacement: driftedPlacement
      },
      queryResult: {
        kind: "found",
        issue: {
          id: CLIENT_REQUEST_ID,
          identifier: "NP-101"
        },
        observedPlacement: driftedPlacement
      }
    });
  const harness = await createHarness({
    transportV2
  });
  const prepared =
    await harness.coordinator.prepareV2(V2_INPUT);
  await harness.coordinator.approve(
    approvalInput(prepared)
  );

  const unknown =
    await harness.coordinator.submit(
      operationInput(prepared)
    );
  const ambiguous =
    await harness.coordinator.reconcile(
      operationInput(prepared)
    );

  assert.equal(unknown.status, "outcome_unknown");
  assert.equal(
    unknown.diagnosticCode,
    "LINEAR_WRITE_OUTCOME_UNKNOWN"
  );
  assert.equal(ambiguous.status, "outcome_unknown");
  assert.equal(
    ambiguous.diagnosticCode,
    "LINEAR_RECONCILIATION_AMBIGUOUS"
  );
});

test("same-instance concurrent v2 submit consumes one create permit", async () => {
  const transportV2 =
    new RecordingLinearWriteTransportV2();
  const harness = await createHarness({
    transportV2
  });
  const prepared =
    await harness.coordinator.prepareV2(V2_INPUT);
  await harness.coordinator.approve(
    approvalInput(prepared)
  );

  const [first, second] = await Promise.all([
    harness.coordinator.submit(
      operationInput(prepared)
    ),
    harness.coordinator.submit(
      operationInput(prepared)
    )
  ]);

  assert.equal(first.status, "created");
  assert.deepEqual(second, first);
  assert.equal(transportV2.createInputs.length, 1);
});

test("reusing one client UUID across v1 and v2 is a plan conflict", async () => {
  const harness = await createHarness({
    transportV2:
      new RecordingLinearWriteTransportV2()
  });
  await harness.coordinator.prepare({
    configuredTarget: {
      kind: "team",
      key: "linear:team-ref:netpilot-z/netpilot"
    },
    resolvedTarget: {
      organizationId: ORGANIZATION_ID,
      teamId: TEAM_ID
    },
    clientRequestId: CLIENT_REQUEST_ID,
    payload: V2_INPUT.payload
  });

  await assert.rejects(
    harness.coordinator.prepareV2(V2_INPUT),
    hasCode(
      "CONTROLLED_WRITE_COORDINATOR_PLAN_CONFLICT"
    )
  );
});

interface HarnessOptions {
  transport?: LinearWriteTransportPort;
  transportV2?: LinearWriteTransportV2Port;
}

async function createHarness({
  transport =
    new RecordingLinearWriteTransportV1(),
  transportV2
}: HarnessOptions): Promise<{
  coordinator: ControlledWriteCoordinator;
  journal: ProviderOperationJournal;
}> {
  const journal =
    await ProviderOperationJournal.open({
      storage: new MemoryOperationStorage()
    });
  const coordinator =
    await ControlledWriteCoordinator.open({
      journal,
      transport,
      ...(transportV2 === undefined
        ? {}
        : { transportV2 }),
      clock: monotonicClock()
    });
  return {
    coordinator,
    journal
  };
}

class RecordingLinearWriteTransportV1
  implements LinearWriteTransportPort
{
  callCount = 0;

  async createIssue(): Promise<never> {
    this.callCount += 1;
    throw new Error("Unexpected v1 create.");
  }

  async queryByClientUuid(): Promise<never> {
    this.callCount += 1;
    throw new Error("Unexpected v1 query.");
  }
}

interface V2TransportOptions {
  createResult?: LinearWriteCreateResultV2;
  queryResult?: LinearWriteQueryResultV2;
}

class RecordingLinearWriteTransportV2
  implements LinearWriteTransportV2Port
{
  readonly createInputs:
    LinearWriteCreateInputV2[] = [];
  readonly queryInputs:
    LinearWriteQueryInputV2[] = [];
  readonly #createResult:
    LinearWriteCreateResultV2 | undefined;
  readonly #queryResult:
    LinearWriteQueryResultV2 | undefined;

  constructor({
    createResult,
    queryResult
  }: V2TransportOptions = {}) {
    this.#createResult = createResult;
    this.#queryResult = queryResult;
  }

  async createIssueV2(
    input: LinearWriteCreateInputV2
  ): Promise<LinearWriteCreateResultV2> {
    this.createInputs.push(
      structuredClone(input)
    );
    return (
      this.#createResult ?? {
        kind: "created",
        issue: {
          id: input.clientRequestId,
          identifier: "NP-101"
        },
        observedPlacement: placementFrom(input)
      }
    );
  }

  async queryByClientUuidV2(
    input: LinearWriteQueryInputV2
  ): Promise<LinearWriteQueryResultV2> {
    this.queryInputs.push(
      structuredClone(input)
    );
    return (
      this.#queryResult ?? {
        kind: "found",
        issue: {
          id: input.clientRequestId,
          identifier: "NP-101"
        },
        observedPlacement: placementFrom(input)
      }
    );
  }
}

function placementFrom(
  input:
    | LinearWriteCreateInputV2
    | LinearWriteQueryInputV2
) {
  return {
    organizationId: input.organizationId,
    teamId: input.teamId,
    projectId: input.projectId,
    stateId: input.stateId,
    parentIssueId: input.parentIssueId
  };
}

function approvalInput(
  operation: ControlledWriteOperation
) {
  return {
    operationKey: operation.plan.operationKey,
    planDigest: operation.plan.planDigest,
    actor: {
      type: "human" as const,
      id: "owner"
    }
  };
}

function operationInput(
  operation: ControlledWriteOperation
) {
  return {
    operationKey: operation.plan.operationKey,
    planDigest: operation.plan.planDigest
  };
}

function monotonicClock(): () => Date {
  let current = Date.parse(
    "2026-07-27T12:00:00.000Z"
  );
  return () => {
    const value = new Date(current);
    current += 1_000;
    return value;
  };
}

class MemoryOperationStorage
  implements ProviderOperationJournalStoragePort
{
  #value: ProviderOperationJournalFile = {
    schemaVersion: 1,
    records: []
  };

  async load(): Promise<unknown> {
    return structuredClone(this.#value);
  }

  async replace(
    value: ProviderOperationJournalFile
  ): Promise<void> {
    this.#value = structuredClone(value);
  }
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
