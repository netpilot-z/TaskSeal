import assert from "node:assert/strict";
import test from "node:test";

import {
  AttemptRunCoordinator
} from "../src/application/attempt-run-coordinator.ts";
import {
  DecompositionDispatcherError
} from "../src/application/decomposition-dispatcher.ts";
import {
  DecompositionPlanJournal
} from "../src/application/decomposition-plan-journal.ts";
import {
  DecompositionControl,
  DecompositionControlError
} from "../src/decomposition-runtime.ts";
import type {
  WorkItem
} from "../src/domain/workflow.ts";
import type {
  DecompositionPlanStorage
} from "../src/storage/decomposition-plan-store.ts";
import {
  createDecompositionFixture
} from "../test-support/decomposition-fixtures.ts";

test("control exposes retirement only through its single lifecycle dispatcher", async () => {
  const fixture =
    createDecompositionFixture();
  const storage =
    new MemoryDecompositionStorage();
  const journal =
    await DecompositionPlanJournal.open({
      storage
    });
  const workItems = createWorkItems();
  const control =
    new DecompositionControl({
      service: {
        getWorkItem: (workItemId) =>
          workItems.get(workItemId) ??
          null
      },
      journal,
      registry: fixture.registry,
      operatorId:
        "operator.jeffrey",
      now: () =>
        new Date(
          "2026-07-28T13:00:00.000Z"
        )
    });

  assert.equal(
    "retire" in control,
    false
  );
  const dispatcher =
    control.createDispatcher({
      attemptRuns:
        new AttemptRunCoordinator(),
      execute: () => undefined
    });
  assert.throws(
    () =>
      control.createDispatcher({
        attemptRuns:
          new AttemptRunCoordinator(),
        execute: () => undefined
      }),
    hasControlCode(
      "DECOMPOSITION_DISPATCHER_ALREADY_CREATED"
    )
  );

  const approved =
    await control.approve({
      draft: fixture.draft,
      expectedPlanDigest:
        fixture.preview.planDigest
    });
  assert.throws(
    () =>
      control.assertManualRunAllowed(
        "API"
      ),
    hasDispatcherCode(
      "DECOMPOSITION_MANAGED_WORK_ITEM"
    )
  );

  const retired =
    await dispatcher.retireOnce({
      planId: "plan-alpha",
      expectedPlanDigest:
        approved.record.planDigest,
      reasonCode:
        "operator_rollback",
      note:
        "Return to the reviewed serial workflow."
    });

  assert.equal(
    (
      retired as {
        resolution: string;
      }
    ).resolution,
    "committed"
  );
  assert.doesNotThrow(() =>
    control.assertManualRunAllowed(
      "API"
    )
  );
  assert.equal(
    control.listRetirements()[0]
      ?.retiredBy,
    "operator.jeffrey"
  );
  assert.deepEqual(
    workItems.get("API")?.attempts,
    []
  );
});

test("actor-disabled control fails closed if its dispatcher retirement is invoked directly", async () => {
  const fixture =
    createDecompositionFixture();
  const journal =
    await DecompositionPlanJournal.open({
      storage:
        new MemoryDecompositionStorage()
    });
  const workItems = createWorkItems();
  await journal.approve({
    plan: fixture.preview.plan,
    expectedPlanDigest:
      fixture.preview.planDigest,
    approvedBy:
      "operator.jeffrey",
    approvedAt:
      "2026-07-28T13:00:00.000Z"
  });
  const control =
    new DecompositionControl({
      service: {
        getWorkItem: (workItemId) =>
          workItems.get(workItemId) ??
          null
      },
      journal,
      registry: fixture.registry,
      operatorId: null
    });
  const dispatcher =
    control.createDispatcher({
      attemptRuns:
        new AttemptRunCoordinator(),
      execute: () => undefined
    });

  assert.equal(
    control.capabilities.retire,
    false
  );
  await assert.rejects(
    dispatcher.retireOnce({
      planId: "plan-alpha",
      expectedPlanDigest:
        fixture.preview.planDigest,
      reasonCode:
        "operator_rollback",
      note:
        "This command must not commit."
    }),
    hasControlCode(
      "DECOMPOSITION_RETIREMENT_DISABLED"
    )
  );
  assert.equal(
    journal.list().length,
    1
  );
  assert.deepEqual(
    journal.listRetirements(),
    []
  );
});

test("approval baselines survive reopen and let a replacement generation ignore old attempts", async () => {
  const fixture =
    createDecompositionFixture();
  const storage =
    new MemoryDecompositionStorage();
  const workItems = createWorkItems();
  const oldAttempt = {
    id: "attempt-old",
    agentId: "runner-old",
    status: "interrupted" as const,
    startedAt:
      "2026-07-28T12:00:00.000Z",
    completedAt:
      "2026-07-28T12:05:00.000Z",
    runtimeOutcome:
      "interrupted" as const
  };
  workItems.set(
    "API",
    {
      ...workItems.get("API")!,
      status: "blocked",
      activeAttemptId:
        oldAttempt.id,
      attempts: [oldAttempt]
    }
  );
  const firstJournal =
    await DecompositionPlanJournal.open({
      storage
    });
  const firstControl =
    new DecompositionControl({
      service: {
        getWorkItem: (workItemId) =>
          workItems.get(workItemId) ??
          null
      },
      journal: firstJournal,
      registry: fixture.registry,
      operatorId:
        "operator.jeffrey",
      now: () =>
        new Date(
          "2026-07-28T13:00:00.000Z"
        )
    });
  const firstDispatcher =
    firstControl.createDispatcher({
      attemptRuns:
        new AttemptRunCoordinator(),
      execute: () => undefined
    });

  const approved =
    await firstControl.approve({
      draft: fixture.draft,
      expectedPlanDigest:
        fixture.preview.planDigest
    });

  assert.equal(
    approved.record.schemaVersion,
    "2"
  );
  assert.equal(
    (
      storage.value as {
        schemaVersion: string;
      }
    ).schemaVersion,
    "3"
  );
  assert.equal(
    firstDispatcher
      .project("plan-alpha")
      .nodes[0]?.phase,
    "ready"
  );

  const reopenedJournal =
    await DecompositionPlanJournal.open({
      storage
    });
  const reopenedControl =
    new DecompositionControl({
      service: {
        getWorkItem: (workItemId) =>
          workItems.get(workItemId) ??
          null
      },
      journal: reopenedJournal,
      registry: fixture.registry,
      operatorId:
        "operator.jeffrey"
    });
  const reopenedDispatcher =
    reopenedControl.createDispatcher({
      attemptRuns:
        new AttemptRunCoordinator(),
      execute: () => undefined
    });
  const reopenedNode =
    reopenedDispatcher
      .project("plan-alpha")
      .nodes[0];

  assert.equal(
    reopenedNode?.phase,
    "ready"
  );
  assert.equal(
    reopenedNode?.retry.attempts,
    0
  );
  assert.deepEqual(
    reopenedNode?.attemptTrace,
    []
  );
});

function createWorkItems():
  Map<string, WorkItem> {
  return new Map(
    [
      ["ROOT", ["tests"]],
      [
        "API",
        ["contract", "tests"]
      ],
      ["QA", ["tests"]]
    ].map(
      ([id, requiredEvidence]) => [
        id as string,
        {
          id: id as string,
          title: id as string,
          status: "planned",
          requiredEvidence:
            requiredEvidence as string[],
          activeAttemptId: null,
          activeArtifact: null,
          attempts: [],
          artifacts: [],
          evidence: [],
          acceptanceDecision: null,
          acceptanceHistory: [],
          externalLinks: []
        } satisfies WorkItem
      ]
    )
  );
}

class MemoryDecompositionStorage
  implements DecompositionPlanStorage
{
  value: unknown = null;

  async read() {
    return structuredClone(this.value);
  }

  async write(value: unknown) {
    this.value =
      structuredClone(value);
  }
}

function hasControlCode(
  code: string
) {
  return (error: unknown) =>
    error instanceof
      DecompositionControlError &&
    error.code === code;
}

function hasDispatcherCode(
  code: string
) {
  return (error: unknown) =>
    error instanceof
      DecompositionDispatcherError &&
    error.code === code;
}
