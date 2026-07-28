import assert from "node:assert/strict";
import test from "node:test";

import type {
  ImportBatchRecord
} from "../src/application/import-batch.ts";
import {
  LinearReadyWorkCoordinator,
  listLinearReadyWorkCandidates
} from "../src/application/linear-ready-work.ts";
import type {
  LinearReadyWorkReadPort
} from "../src/application/linear-ready-work.ts";
import {
  TaskSealService
} from "../src/application/taskseal-service.ts";
import type {
  EventJournal
} from "../src/application/taskseal-service.ts";
import type {
  CanonicalEvent
} from "../src/domain/workflow.ts";

const ORGANIZATION_ID =
  "11111111-1111-4111-8111-111111111111";
const TEAM_ID =
  "22222222-2222-4222-8222-222222222222";
const PROJECT_ID =
  "33333333-3333-4333-8333-333333333333";
const READY_STATE_ID =
  "44444444-4444-4444-8444-444444444444";
const COMPLETED_STATE_ID =
  "55555555-5555-4555-8555-555555555555";
const READY_ISSUE_ID =
  "66666666-6666-4666-8666-666666666666";
const BLOCKED_ISSUE_ID =
  "77777777-7777-4777-8777-777777777777";
const UNKNOWN_ISSUE_ID =
  "88888888-8888-4888-8888-888888888888";
const UNINDEXED_ISSUE_ID =
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DONE_DEPENDENCY_ID =
  "99999999-9999-4999-8999-999999999999";
const TODO_DEPENDENCY_ID =
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const SCOPE = Object.freeze({
  organizationId: ORGANIZATION_ID,
  teamId: TEAM_ID,
  teamKey: "NP",
  projectId: PROJECT_ID,
  readyStateId: READY_STATE_ID,
  completedStateId: COMPLETED_STATE_ID
});
const DEPENDENCY_TARGET = Object.freeze({
  organizationId: ORGANIZATION_ID,
  teamId: TEAM_ID,
  projectId: PROJECT_ID,
  stateId:
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
});

test("ready-work coordinator classifies complete, blocked, and unknown dependencies", async () => {
  const coordinator =
    new LinearReadyWorkCoordinator({
      scope: SCOPE,
      reader: createReader(),
      dependencyIndex: {
        target: DEPENDENCY_TARGET,
        dependenciesOf(issueId) {
          if (issueId === READY_ISSUE_ID) {
            return {
              completeness: "complete",
              issueIds: [DONE_DEPENDENCY_ID]
            };
          }

          if (issueId === BLOCKED_ISSUE_ID) {
            return {
              completeness: "complete",
              issueIds: [TODO_DEPENDENCY_ID]
            };
          }

          if (issueId === UNINDEXED_ISSUE_ID) {
            return {
              completeness: "unindexed",
              issueIds: []
            };
          }

          return {
            completeness: "unknown",
            issueIds: []
          };
        }
      },
      workflow: {
        getWorkflow: () => ({
          processedEvents: {},
          processedEventIds: [],
          workItems: {}
        })
      },
      imports: {
        getImportReceiptContext() {
          return null;
        },
        async applySnapshotImport() {
          throw new Error("not used");
        }
      },
      importPolicy: createImportPolicy()
    });

  const candidates = await coordinator.list();

  assert.deepEqual(
    candidates.map((candidate) => ({
      issueId: candidate.issueId,
      readiness: candidate.readiness,
      blockingIssueIds:
        candidate.blockingIssueIds
    })),
    [
      {
        issueId: READY_ISSUE_ID,
        readiness: "ready",
        blockingIssueIds: []
      },
      {
        issueId: BLOCKED_ISSUE_ID,
        readiness: "blocked",
        blockingIssueIds: [
          TODO_DEPENDENCY_ID
        ]
      },
      {
        issueId: UNKNOWN_ISSUE_ID,
        readiness: "unknown",
        blockingIssueIds: []
      },
      {
        issueId: UNINDEXED_ISSUE_ID,
        readiness: "ready",
        blockingIssueIds: []
      }
    ]
  );

  let foreignReadCalls = 0;
  await assert.rejects(
    listLinearReadyWorkCandidates({
      scope: SCOPE,
      reader: {
        async listIssues() {
          foreignReadCalls += 1;
          return [];
        },
        async readIssueStates() {
          foreignReadCalls += 1;
          return [];
        }
      },
      dependencyIndex: {
        target: {
          ...DEPENDENCY_TARGET,
          organizationId:
            "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        },
        dependenciesOf() {
          return {
            completeness: "unindexed",
            issueIds: []
          };
        }
      }
    }),
    hasCode(
      "LINEAR_READY_DEPENDENCY_SCOPE_MISMATCH"
    )
  );
  assert.equal(foreignReadCalls, 0);
});

test("ready selection uses atomic snapshot import and replays one stable Linear UUID mapping", async () => {
  const journal = new MemoryJournal();
  const policy = createImportPolicy();
  const service = await openService(
    journal,
    policy
  );
  const coordinator = createCoordinator({
    service,
    policy
  });
  const selection = {
    issueId: READY_ISSUE_ID,
    workItemId: "TS-NP-5",
    requiredEvidence: ["zeta", "alpha"]
  } as const;
  const preview =
    await coordinator.previewSelection(
      selection
    );

  assert.equal(preview.kind, "plan");
  if (preview.kind !== "plan") {
    assert.fail("expected an import plan");
  }

  const applied = await coordinator.applySelection({
    ...selection,
    expectedPlanDigest:
      preview.plan.planDigest,
    actor: {
      type: "human",
      id: "local-operator"
    }
  });

  assert.equal(applied.resolution, "committed");
  assert.equal(journal.records.length, 1);
  const workItem = service.getWorkItem(
    "TS-NP-5"
  );
  assert.ok(workItem);
  assert.deepEqual(
    workItem.requiredEvidence,
    ["alpha", "zeta"]
  );
  assert.equal(
    workItem.externalLinks[0]
      ?.providerObjectKey,
    `linear:issue:${READY_ISSUE_ID}`
  );

  const repeated =
    await coordinator.previewSelection(
      selection
    );
  assert.equal(repeated.kind, "already_linked");
  assert.equal(
    repeated.workItemId,
    "TS-NP-5"
  );
  assert.equal(journal.records.length, 1);

  const changedEvidence =
    await coordinator.previewSelection({
      ...selection,
      requiredEvidence: ["review"]
    });
  assert.equal(changedEvidence.kind, "plan");
  if (changedEvidence.kind !== "plan") {
    assert.fail("expected a mapping conflict plan");
  }
  assert.ok(
    changedEvidence.plan.conflicts.some(
      (conflict) =>
        conflict.code ===
        "WORK_ITEM_MAPPING_CONFLICT"
    )
  );

  let offlineReadCalls = 0;
  const offlineCoordinator =
    new LinearReadyWorkCoordinator({
      scope: SCOPE,
      reader: {
        async listIssues() {
          offlineReadCalls += 1;
          throw new Error(
            "network unavailable"
          );
        },
        async readIssueStates() {
          offlineReadCalls += 1;
          throw new Error(
            "network unavailable"
          );
        }
      },
      dependencyIndex: {
        target: DEPENDENCY_TARGET,
        dependenciesOf() {
          throw new Error("not used");
        }
      },
      workflow: service,
      imports: service,
      importPolicy: policy
    });
  const retry =
    await offlineCoordinator.applySelection({
      ...selection,
      requiredEvidence: ["alpha", "zeta"],
      expectedPlanDigest:
        preview.plan.planDigest,
      actor: {
        type: "human",
        id: "local-operator"
      }
    });
  assert.equal(retry.resolution, "idempotent");
  assert.ok("receipt" in retry);
  assert.equal(
    "receipt" in retry
      ? retry.receipt.planDigest
      : null,
    preview.plan.planDigest
  );
  assert.equal(journal.records.length, 1);
  assert.equal(offlineReadCalls, 0);

  for (const mismatched of [
    {
      ...selection,
      issueId: BLOCKED_ISSUE_ID
    },
    {
      ...selection,
      workItemId: "TS-NP-OTHER"
    },
    {
      ...selection,
      requiredEvidence: ["other"]
    }
  ]) {
    await assert.rejects(
      offlineCoordinator.applySelection({
        ...mismatched,
        expectedPlanDigest:
          preview.plan.planDigest,
        actor: {
          type: "human",
          id: "local-operator"
        }
      }),
      hasCode("LINEAR_READY_PLAN_STALE")
    );
  }
  assert.equal(offlineReadCalls, 0);

  await assert.rejects(
    coordinator.applySelection({
      ...selection,
      expectedPlanDigest:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      actor: {
        type: "human",
        id: "local-operator"
      }
    }),
    hasCode("LINEAR_READY_PLAN_STALE")
  );
  assert.equal(journal.records.length, 1);

  const reopened = await openService(
    journal,
    policy
  );
  const replayed =
    await createCoordinator({
      service: reopened,
      policy
    }).previewSelection(selection);
  assert.equal(replayed.kind, "already_linked");
  assert.equal(journal.records.length, 1);
});

test("blocked or stale selections never reach local import", async () => {
  let applyCalls = 0;
  const coordinator =
    new LinearReadyWorkCoordinator({
      scope: SCOPE,
      reader: createReader(),
      dependencyIndex: {
        target: DEPENDENCY_TARGET,
        dependenciesOf(issueId) {
          return {
            completeness: "complete",
            issueIds:
              issueId === BLOCKED_ISSUE_ID
                ? [TODO_DEPENDENCY_ID]
                : [DONE_DEPENDENCY_ID]
          };
        }
      },
      workflow: {
        getWorkflow: () => ({
          processedEvents: {},
          processedEventIds: [],
          workItems: {}
        })
      },
      imports: {
        getImportReceiptContext() {
          return null;
        },
        async applySnapshotImport() {
          applyCalls += 1;
          throw new Error("must not apply");
        }
      },
      importPolicy: createImportPolicy()
    });

  await assert.rejects(
    coordinator.previewSelection({
      issueId: BLOCKED_ISSUE_ID,
      workItemId: "TS-NP-6",
      requiredEvidence: ["tests"]
    }),
    hasCode(
      "LINEAR_READY_DEPENDENCY_BLOCKED"
    )
  );

  const preview =
    await coordinator.previewSelection({
      issueId: READY_ISSUE_ID,
      workItemId: "TS-NP-5",
      requiredEvidence: ["tests"]
    });
  assert.equal(preview.kind, "plan");
  if (preview.kind !== "plan") {
    assert.fail("expected an import plan");
  }

  await assert.rejects(
    coordinator.applySelection({
      issueId: READY_ISSUE_ID,
      workItemId: "TS-NP-5",
      requiredEvidence: ["tests"],
      expectedPlanDigest:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      actor: {
        type: "human",
        id: "local-operator"
      }
    }),
    hasCode("LINEAR_READY_PLAN_STALE")
  );
  assert.equal(applyCalls, 0);
});

function createCoordinator({
  service,
  policy
}: {
  service: TaskSealService;
  policy: unknown;
}): LinearReadyWorkCoordinator {
  return new LinearReadyWorkCoordinator({
    scope: SCOPE,
    reader: createReader([readyIssue()]),
    dependencyIndex: {
      target: DEPENDENCY_TARGET,
      dependenciesOf() {
        return {
          completeness: "complete",
          issueIds: [DONE_DEPENDENCY_ID]
        };
      }
    },
    workflow: service,
    imports: service,
    importPolicy: policy,
    clock: () =>
      new Date("2026-07-28T03:00:00.000Z")
  });
}

function createReader(
  issues = [
    readyIssue(),
    readyIssue({
      id: BLOCKED_ISSUE_ID,
      identifier: "NP-6"
    }),
    readyIssue({
      id: UNKNOWN_ISSUE_ID,
      identifier: "NP-7"
    }),
    readyIssue({
      id: UNINDEXED_ISSUE_ID,
      identifier: "NP-8"
    })
  ]
): LinearReadyWorkReadPort {
  return {
    async listIssues() {
      return structuredClone(issues);
    },
    async readIssueStates(issueIds) {
      return issueIds.map((issueId) => ({
        issueId,
        stateId:
          issueId === TODO_DEPENDENCY_ID
            ? READY_STATE_ID
            : COMPLETED_STATE_ID,
        stateType:
          issueId === TODO_DEPENDENCY_ID
            ? "unstarted"
            : "completed"
      }));
    }
  };
}

function readyIssue({
  id = READY_ISSUE_ID,
  identifier = "NP-5"
}: {
  id?: string;
  identifier?: string;
} = {}) {
  return {
    id,
    identifier,
    title: `Title ${identifier}`,
    url:
      `https://linear.app/netpilot-z/issue/${identifier}/example`,
    createdAt: "2026-07-28T01:00:00.000Z",
    updatedAt: "2026-07-28T02:00:00.000Z",
    blockedByIssueIds: [],
    dependencyCompleteness:
      "complete" as const
  };
}

function createImportPolicy() {
  return {
    schemaVersion: 2,
    allowedScopes: [
      {
        provider: "linear",
        scopeRef: {
          kind: "team",
          key: `linear:team:${TEAM_ID}`,
          parentKey:
            `linear:organization:${ORGANIZATION_ID}`
        },
        objectTypes: ["issue"],
        capabilities: {
          "snapshot.import.preview": true,
          "snapshot.import.apply": true
        }
      }
    ]
  };
}

async function openService(
  journal: MemoryJournal,
  policy: unknown
): Promise<TaskSealService> {
  return TaskSealService.open({
    journal,
    importPolicyProvider: async () =>
      structuredClone(policy),
    providerFactProvenanceVerifier: {
      async verify(claims) {
        return claims.map((claim) => ({
          schemaVersion: 1 as const,
          claimDigest: claim.claimDigest,
          outcome: "verified" as const
        }));
      }
    },
    clock: () =>
      new Date("2026-07-28T03:01:00.000Z")
  });
}

class MemoryJournal implements EventJournal {
  records: unknown[] = [];

  async readAll(): Promise<unknown[]> {
    return structuredClone(this.records);
  }

  async append(
    event: CanonicalEvent
  ): Promise<void> {
    this.records.push(structuredClone(event));
  }

  async commitBatch(
    record: ImportBatchRecord
  ): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}
