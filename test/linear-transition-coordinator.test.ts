import assert from "node:assert/strict";
import test from "node:test";

import {
  LinearTransitionCoordinator
} from "../src/application/linear-transition-coordinator.ts";
import {
  acceptanceEventId,
  digestAcceptanceDecision
} from "../src/application/work-item-acceptance.ts";
import {
  ProviderOperationJournal
} from "../src/application/provider-operation-journal.ts";
import {
  applyEvent,
  computeAcceptanceReviewRevision,
  createWorkflow
} from "../src/domain/workflow.ts";
import type {
  Workflow,
  WorkItem
} from "../src/domain/workflow.ts";
import type {
  LinearTransitionReadResult,
  LinearTransitionTransportPort,
  LinearTransitionUpdateResult
} from "../src/application/linear-transition-transport.ts";
import type {
  ProviderOperationJournalFile
} from "../src/application/provider-operation-journal.ts";

const ISSUE_ID =
  "70cbe548-5e6c-4d35-b019-a570058a8cf2";
const DECISION_ID =
  "11111111-1111-4111-8111-111111111111";
const EXPECTED_STATE_ID =
  "3d2677e2-2192-48c1-8fb9-e6da2dedf95f";
const TARGET_STATE_ID =
  "2d716bbd-be75-4718-95c9-27f184d19e56";
const REVISION =
  "2026-07-28T00:05:00.000Z";

test("accepted delivery transitions the same Linear UUID after committed permit and exact readback", async () => {
  const fixture =
    acceptedWorkItemFixture();
  const transport = new FakeTransport([
    sourceRead(),
    sourceRead(),
    targetRead()
  ]);
  const coordinator =
    await createCoordinator({
      fixture,
      transport
    });

  const prepared =
    await coordinator.prepare(
      fixture.command
    );
  const approved =
    await coordinator.approve({
      operationKey:
        prepared.plan.operationKey,
      planDigest:
        prepared.plan.planDigest,
      actor: {
        type: "human",
        id: "operator.jeffrey"
      }
    });
  const transitioned =
    await coordinator.submit({
      operationKey:
        approved.plan.operationKey,
      planDigest:
        approved.plan.planDigest
    });

  assert.equal(
    transitioned.status,
    "transitioned"
  );
  assert.equal(transport.updateCalls, 1);
  assert.equal(transport.readCalls, 3);
  assert.deepEqual(
    transport.lastUpdate,
    {
      issueId: ISSUE_ID,
      stateId: TARGET_STATE_ID
    }
  );
  assert.equal(
    (
      await coordinator.get(
        transitioned.plan.operationKey
      )
    )?.version,
    4
  );
});

test("a started Linear source state can transition after the same exact precondition checks", async () => {
  const fixture =
    acceptedWorkItemFixture();
  const transport = new FakeTransport([
    sourceRead("started"),
    sourceRead("started"),
    targetRead()
  ]);
  const coordinator =
    await createCoordinator({
      fixture,
      transport
    });

  const prepared =
    await coordinator.prepare(
      fixture.command
    );
  const approved =
    await coordinator.approve({
      operationKey:
        prepared.plan.operationKey,
      planDigest:
        prepared.plan.planDigest,
      actor: {
        type: "human",
        id: "operator.jeffrey"
      }
    });
  const transitioned =
    await coordinator.submit({
      operationKey:
        approved.plan.operationKey,
      planDigest:
        approved.plan.planDigest
    });

  assert.equal(
    transitioned.status,
    "transitioned"
  );
  assert.equal(transport.updateCalls, 1);
});

test("stale local acceptance or Linear source facts fail before mutation and journal submission", async () => {
  const fixture =
    acceptedWorkItemFixture();
  const staleLocal = structuredClone(
    fixture.command
  );
  staleLocal.acceptanceDigest =
    `sha256:${"0".repeat(64)}`;
  const localTransport =
    new FakeTransport([sourceRead()]);
  const localCoordinator =
    await createCoordinator({
      fixture,
      transport: localTransport
    });

  await assert.rejects(
    localCoordinator.prepare(staleLocal),
    hasCode(
      "LINEAR_TRANSITION_ACCEPTANCE_STALE"
    )
  );
  assert.equal(localTransport.readCalls, 0);
  assert.equal(localTransport.updateCalls, 0);

  const remoteTransport =
    new FakeTransport([
      {
        kind: "found",
        issue: {
          ...sourceRead().issue,
          revisionId:
            "2026-07-28T00:05:01.000Z"
        }
      }
    ]);
  const remoteCoordinator =
    await createCoordinator({
      fixture,
      transport: remoteTransport
    });
  await assert.rejects(
    remoteCoordinator.prepare(
      fixture.command
    ),
    hasCode(
      "LINEAR_TRANSITION_PRECONDITION_STALE"
    )
  );
  assert.equal(
    remoteTransport.updateCalls,
    0
  );
});

test("concurrent submit consumes one transition permit", async () => {
  const fixture =
    acceptedWorkItemFixture();
  const transport = new FakeTransport([
    sourceRead(),
    sourceRead(),
    targetRead()
  ]);
  const coordinator =
    await createCoordinator({
      fixture,
      transport
    });
  const prepared =
    await coordinator.prepare(
      fixture.command
    );
  const approved =
    await coordinator.approve({
      operationKey:
        prepared.plan.operationKey,
      planDigest:
        prepared.plan.planDigest,
      actor: {
        type: "human",
        id: "operator.jeffrey"
      }
    });

  const [left, right] = await Promise.all([
    coordinator.submit({
      operationKey:
        approved.plan.operationKey,
      planDigest:
        approved.plan.planDigest
    }),
    coordinator.submit({
      operationKey:
        approved.plan.operationKey,
      planDigest:
        approved.plan.planDigest
    })
  ]);

  assert.equal(left.status, "transitioned");
  assert.equal(right.status, "transitioned");
  assert.equal(transport.updateCalls, 1);
});

test("response loss becomes unknown and explicit reconciliation reaches Done without a second mutation", async () => {
  const fixture =
    acceptedWorkItemFixture();
  const transport = new FakeTransport(
    [
      sourceRead(),
      sourceRead(),
      targetRead()
    ],
    {
      kind: "outcome_unknown",
      diagnosticCode:
        "LINEAR_WRITE_OUTCOME_UNKNOWN"
    }
  );
  const coordinator =
    await createCoordinator({
      fixture,
      transport
    });
  const prepared =
    await coordinator.prepare(
      fixture.command
    );
  const approved =
    await coordinator.approve({
      operationKey:
        prepared.plan.operationKey,
      planDigest:
        prepared.plan.planDigest,
      actor: {
        type: "human",
        id: "operator.jeffrey"
      }
    });
  const unknown =
    await coordinator.submit({
      operationKey:
        approved.plan.operationKey,
      planDigest:
        approved.plan.planDigest
    });
  assert.equal(
    unknown.status,
    "outcome_unknown"
  );

  const reconciled =
    await coordinator.reconcile({
      operationKey:
        approved.plan.operationKey,
      planDigest:
        approved.plan.planDigest
    });
  assert.equal(
    reconciled.status,
    "reconciled"
  );
  assert.equal(transport.updateCalls, 1);
});

async function createCoordinator({
  fixture,
  transport
}: {
  fixture: ReturnType<
    typeof acceptedWorkItemFixture
  >;
  transport: FakeTransport;
}) {
  const journal =
    await ProviderOperationJournal.open({
      storage: new MemoryStorage()
    });
  const times = [
    "2026-07-28T00:06:00.000Z",
    "2026-07-28T00:07:00.000Z",
    "2026-07-28T00:08:00.000Z",
    "2026-07-28T00:09:00.000Z",
    "2026-07-28T00:10:00.000Z",
    "2026-07-28T00:11:00.000Z"
  ];
  let index = 0;
  return LinearTransitionCoordinator.open({
    journal,
    transport,
    workItems: {
      getWorkItem(workItemId) {
        return workItemId ===
          fixture.workItem.id
          ? structuredClone(
              fixture.workItem
            )
          : null;
      }
    },
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
      expectedStateId:
        EXPECTED_STATE_ID,
      targetStateId:
        TARGET_STATE_ID
    },
    clock: () =>
      new Date(
        times[index++] ??
          "2026-07-28T00:11:00.000Z"
      )
  });
}

class FakeTransport
  implements LinearTransitionTransportPort {
  readonly reads: LinearTransitionReadResult[];
  readonly updateResult:
    LinearTransitionUpdateResult;
  readCalls = 0;
  updateCalls = 0;
  lastUpdate:
    | {
        issueId: string;
        stateId: string;
      }
    | null = null;

  constructor(
    reads: LinearTransitionReadResult[],
    updateResult:
      LinearTransitionUpdateResult = {
        kind: "dispatched"
      }
  ) {
    this.reads = structuredClone(reads);
    this.updateResult =
      structuredClone(updateResult);
  }

  async readIssue(): Promise<LinearTransitionReadResult> {
    const result =
      this.reads[this.readCalls];
    this.readCalls += 1;
    return structuredClone(
      result ?? {
        kind: "failed",
        diagnosticCode:
          "LINEAR_RECONCILIATION_FAILED"
      }
    );
  }

  async updateIssueState(input: {
    issueId: string;
    stateId: string;
  }): Promise<LinearTransitionUpdateResult> {
    this.updateCalls += 1;
    this.lastUpdate =
      structuredClone(input);
    return structuredClone(
      this.updateResult
    );
  }
}

class MemoryStorage {
  value: ProviderOperationJournalFile = {
    schemaVersion: 1,
    records: []
  };

  async load(): Promise<unknown> {
    return structuredClone(this.value);
  }

  async replace(
    value: ProviderOperationJournalFile
  ): Promise<void> {
    this.value = structuredClone(value);
  }
}

function acceptedWorkItemFixture(): {
  workItem: WorkItem;
  command: {
    workItemId: string;
    decisionId: string;
    acceptanceDigest: string;
  };
} {
  let workflow = deliveryWorkflow();
  const review =
    computeAcceptanceReviewRevision(
      requireWorkItem(workflow)
    );
  const eventId =
    acceptanceEventId(DECISION_ID);
  workflow = applyEvent(workflow, {
    eventId,
    workItemId: "TS-NP-7",
    type: "acceptance.decided",
    occurredAt:
      "2026-07-28T00:05:30.000Z",
    payload: {
      decision: "accepted",
      actor: "operator.jeffrey",
      reason: "Delivery evidence is complete.",
      decisionId: DECISION_ID,
      expectedReviewRevision: review
    }
  });
  const workItem =
    requireWorkItem(workflow);
  assert.ok(workItem.acceptanceDecision);
  return {
    workItem,
    command: {
      workItemId: workItem.id,
      decisionId: DECISION_ID,
      acceptanceDigest:
        digestAcceptanceDecision({
          workItemId: workItem.id,
          eventId,
          decision:
            workItem.acceptanceDecision
        })
    }
  };
}

function deliveryWorkflow(): Workflow {
  let workflow = createWorkflow();
  workflow = applyEvent(workflow, {
    eventId: "linear:np-7:created",
    workItemId: "TS-NP-7",
    type: "work_item.created",
    occurredAt:
      "2026-07-28T00:00:00.000Z",
    payload: {
      title:
        "Human acceptance and Linear Done",
      requiredEvidence: ["tests"],
      externalLink: linearLink()
    }
  });
  workflow = applyEvent(workflow, {
    eventId: "taskseal:attempt:started",
    workItemId: "TS-NP-7",
    type: "attempt.started",
    occurredAt:
      "2026-07-28T00:01:00.000Z",
    payload: {
      attemptId: "attempt-1",
      agentId: "codex"
    }
  });
  workflow = applyEvent(workflow, {
    eventId: "taskseal:attempt:finished",
    workItemId: "TS-NP-7",
    type: "attempt.finished",
    occurredAt:
      "2026-07-28T00:02:00.000Z",
    payload: {
      attemptId: "attempt-1",
      outcome: "completed"
    }
  });
  workflow = applyEvent(workflow, {
    eventId: "github:artifact:linked",
    workItemId: "TS-NP-7",
    type: "artifact.linked",
    occurredAt:
      "2026-07-28T00:03:00.000Z",
    payload: {
      artifactId: "pr-58",
      attemptId: "attempt-1",
      kind: "pull_request",
      revision: "head-1",
      url:
        "https://github.com/netpilot-z/TaskSeal/pull/58"
    }
  });
  return applyEvent(workflow, {
    eventId: "github:evidence:recorded",
    workItemId: "TS-NP-7",
    type: "evidence.recorded",
    occurredAt:
      "2026-07-28T00:04:00.000Z",
    payload: {
      evidenceId: "check-tests",
      attemptId: "attempt-1",
      artifactId: "pr-58",
      revision: "head-1",
      criterionKey: "tests",
      outcome: "passed",
      url:
        "https://github.com/netpilot-z/TaskSeal/actions/runs/1"
    }
  });
}

function linearLink() {
  return {
    providerObjectKey:
      `linear:issue:${ISSUE_ID}`,
    provider: "linear",
    objectType: "issue",
    externalId: ISSUE_ID,
    scopeRef: {
      kind: "team",
      key:
        "linear:team:658d1189-f63d-4245-b761-0f4f2c389663",
      parentKey:
        "linear:organization:7eb4877f-0fa0-429c-9cd2-76dfffa0f20b"
    },
    url:
      "https://linear.app/netpilot-z/issue/NP-7/human-acceptance",
    managedFields: ["title"],
    lastObservation: {
      revisionId: REVISION,
      occurredAt: REVISION,
      contentDigest:
        `sha256:${"3".repeat(64)}`,
      title:
        "Human acceptance and Linear Done"
    }
  };
}

function sourceRead(
  stateType:
    | "unstarted"
    | "started" = "unstarted"
) {
  return {
    kind: "found" as const,
    issue: {
      id: ISSUE_ID,
      identifier: "NP-7",
      revisionId: REVISION,
      stateType,
      placement: {
        organizationId:
          "7eb4877f-0fa0-429c-9cd2-76dfffa0f20b",
        teamId:
          "658d1189-f63d-4245-b761-0f4f2c389663",
        projectId:
          "3e1b05e6-0a14-43d4-9fed-e1bee6ef0683",
        stateId: EXPECTED_STATE_ID
      }
    }
  };
}

function targetRead() {
  return {
    kind: "found" as const,
    issue: {
      ...sourceRead().issue,
      revisionId:
        "2026-07-28T00:08:30.000Z",
      stateType: "completed",
      placement: {
        ...sourceRead().issue.placement,
        stateId: TARGET_STATE_ID
      }
    }
  };
}

function requireWorkItem(
  workflow: Workflow
): WorkItem {
  const workItem =
    workflow.workItems["TS-NP-7"];
  assert.ok(workItem);
  return workItem;
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
