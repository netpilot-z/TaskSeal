import assert from "node:assert/strict";
import {
  mkdtemp,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

import {
  createImportBatchRecord
} from "../src/application/import-batch.ts";
import type {
  ImportBatchRecord
} from "../src/application/import-batch.ts";
import {
  TaskSealService
} from "../src/application/taskseal-service.ts";
import type {
  EventJournal,
  SnapshotImportApplyResult
} from "../src/application/taskseal-service.ts";
import {
  computeImportPlanDigest
} from "../src/application/import-plan.ts";
import type {
  ImportPlan
} from "../src/application/import-plan.ts";
import {
  previewSnapshotImport
} from "../src/application/snapshot-import.ts";
import {
  applyEvent,
  createWorkflow
} from "../src/domain/workflow.ts";
import type {
  CanonicalEvent,
  ExternalLinkLinkedEvent,
  WorkItemCreatedEvent
} from "../src/domain/workflow.ts";
import {
  FileEventJournal
} from "../src/storage/event-journal.ts";
import {
  createActor,
  createGitHubDeliverySnapshot,
  createGitHubIssueSnapshot,
  createImportPolicy,
  createPreviewPlan
} from "../test-support/snapshot-import-fixtures.ts";

const APPLIED_AT = "2026-07-26T08:05:00.000Z";

test("service atomically applies a plan, returns one immutable receipt, and replays it", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const journal = new FileEventJournal({
    filePath: join(directory, "events.jsonl")
  });
  const service = await openService(journal);
  const plan = createPreviewPlan();

  const committed = await service.applySnapshotImport({
    plan,
    expectedPlanDigest: plan.planDigest,
    actor: createActor()
  });
  const idempotent = await service.applySnapshotImport({
    plan,
    expectedPlanDigest: plan.planDigest,
    actor: {
      type: "human",
      id: "different-retry-actor"
    }
  });

  assert.equal(committed.resolution, "committed");
  assert.equal(idempotent.resolution, "idempotent");
  assert.deepEqual(
    idempotent.receipt,
    committed.receipt
  );
  assert.equal(
    required(service.getWorkItem("TS-1")).title,
    "Apply a provider snapshot safely"
  );
  assert.equal((await journal.readAll()).length, 1);

  const reopened = await TaskSealService.open({
    journal: new FileEventJournal({
      filePath: join(directory, "events.jsonl")
    })
  });

  assert.deepEqual(
    reopened.getImportReceipt({
      planDigest: plan.planDigest
    }),
    committed.receipt
  );
  assert.deepEqual(
    reopened.getWorkflow(),
    service.getWorkflow()
  );
});

test("no-op imports still commit one recoverable receipt", async () => {
  const journal = new MemoryJournal();
  const service = await openService(journal);
  const initialPlan = createPreviewPlan();
  await applyPlan(service, initialPlan);
  const noOpPlan = createPreviewPlan({
    workflow: service.getWorkflow()
  });

  const committed = await applyPlan(service, noOpPlan);
  const retried = await applyPlan(service, noOpPlan);

  assert.equal(noOpPlan.events.length, 0);
  assert.equal(committed.receipt.eventIds.length, 0);
  assert.equal(retried.resolution, "idempotent");
  assert.equal(journal.commitCalls, 2);
});

test("provider updates and additional links apply as complete replayable batches", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const filePath = join(directory, "events.jsonl");
  const service = await openService(
    new FileEventJournal({ filePath })
  );
  await applyPlan(service, createPreviewPlan());

  const updatePlan = createPreviewPlan({
    workflow: service.getWorkflow(),
    snapshot: createGitHubIssueSnapshot({
      title: "Updated provider title",
      revisionId: "2026-07-26T08:02:00.000Z",
      capturedAt: "2026-07-26T08:02:01.000Z"
    })
  });
  const updated = await applyPlan(service, updatePlan);

  assert.equal(updatePlan.events.length, 2);
  assert.equal(updated.receipt.eventIds.length, 2);
  assert.equal(
    required(service.getWorkItem("TS-1")).title,
    "Updated provider title"
  );

  const linkPlan = createPreviewPlan({
    workflow: service.getWorkflow(),
    snapshot: createGitHubIssueSnapshot({
      title: "Reference provider issue",
      managedFields: [],
      revisionId: "2026-07-26T08:03:00.000Z",
      capturedAt: "2026-07-26T08:03:01.000Z",
      externalId: "502",
      issueNumber: "2"
    })
  });
  await applyPlan(service, linkPlan);

  assert.equal(linkPlan.events.length, 1);
  assert.equal(
    required(service.getWorkItem("TS-1"))
      .externalLinks.length,
    2
  );

  const reopened = await TaskSealService.open({
    journal: new FileEventJournal({ filePath })
  });
  assert.deepEqual(
    reopened.getWorkflow(),
    service.getWorkflow()
  );
  assert.equal(
    required(
      reopened.getImportReceipt({
        planDigest: updatePlan.planDigest
      })
    ).eventIds.length,
    2
  );
  assert.equal(
    required(
      reopened.getImportReceipt({
        planDigest: linkPlan.planDigest
      })
    ).eventIds.length,
    1
  );
});

test("tampered, forbidden, blocked, and stale plans perform zero batch writes", async () => {
  const tamperedJournal = new MemoryJournal();
  const tamperedService = await openService(
    tamperedJournal
  );
  const original = createPreviewPlan();
  const tampered = structuredClone(original);
  required(tampered.events[0]).payload.title =
    "Tampered";

  await assert.rejects(
    applyPlan(tamperedService, tampered),
    hasCode("IMPORT_PLAN_TAMPERED")
  );
  assert.equal(tamperedJournal.commitCalls, 0);

  const forbiddenJournal = new MemoryJournal();
  const revokedPolicy = createImportPolicy({
    applyAllowed: false
  });
  const forbiddenService = await openService(
    forbiddenJournal,
    revokedPolicy
  );

  await assert.rejects(
    applyPlan(forbiddenService, original),
    hasCode("IMPORT_APPLY_FORBIDDEN")
  );
  assert.equal(forbiddenJournal.commitCalls, 0);

  const staleJournal = new MemoryJournal();
  const staleService = await openService(staleJournal);
  await staleService.append(createLocalWorkItemEvent("local"));

  await assert.rejects(
    applyPlan(staleService, original),
    hasCode("IMPORT_PLAN_STALE")
  );
  assert.equal(staleJournal.commitCalls, 0);

  const ownerPlan = createPreviewPlan({
    snapshot: createGitHubIssueSnapshot({
      workItemId: "TS-2",
      managedFields: []
    })
  });
  const ownerWorkflow = ownerPlan.events.reduce(
    applyEvent,
    createWorkflow()
  );
  const blockedPlan = createPreviewPlan({
    workflow: ownerWorkflow,
    snapshot: createGitHubIssueSnapshot({
      workItemId: "TS-1",
      managedFields: []
    })
  });
  const blockedJournal = new MemoryJournal(
    ownerPlan.events
  );
  const blockedService = await openService(
    blockedJournal
  );

  await assert.rejects(
    applyPlan(blockedService, blockedPlan),
    hasCode("IMPORT_PLAN_BLOCKED")
  );
  assert.equal(blockedJournal.commitCalls, 0);
});

test("apply rejects artifact and evidence URLs outside the bound repository before policy or journal access", async () => {
  const baseEvents: CanonicalEvent[] = [
    createLocalWorkItemEvent("TS-1"),
    {
      eventId: "local:TS-1:run-1:started",
      workItemId: "TS-1",
      type: "attempt.started",
      occurredAt: "2026-07-26T08:02:30.000Z",
      payload: {
        attemptId: "run-1",
        agentId: "codex"
      }
    }
  ];
  const workflow = baseEvents.reduce(
    (current, event) => applyEvent(current, event),
    createWorkflow()
  );
  const policy = createImportPolicy({
    objectTypes: ["check", "pull_request"]
  });
  const original = previewSnapshotImport({
    snapshot: createGitHubDeliverySnapshot(),
    workflow,
    importPolicy: policy
  });

  for (const type of [
    "artifact.linked",
    "evidence.recorded"
  ] as const) {
    const forged = structuredClone(original);
    const event = forged.events.find(
      (candidate) => candidate.type === type
    );
    assert.ok(event);
    event.payload.url =
      type === "artifact.linked"
        ? "https://github.com/foreign/repo/pull/2"
        : "https://github.com/foreign/repo/actions/runs/7";
    forged.planDigest = computeImportPlanDigest(forged);

    let policyCalls = 0;
    const journal = new MemoryJournal(baseEvents);
    const service = await TaskSealService.open({
      journal,
      importPolicyProvider: () => {
        policyCalls += 1;
        return policy;
      },
      clock: () => new Date(APPLIED_AT)
    });

    await assert.rejects(
      applyPlan(service, forged),
      hasCode("IMPORT_PLAN_TAMPERED")
    );
    assert.equal(policyCalls, 0);
    assert.equal(journal.commitCalls, 0);
  }
});

test("workflow drift is classified as stale before projected ingress simulation", async () => {
  const plan = createPreviewPlan();
  const journal = new MemoryJournal([
    createLocalWorkItemEvent("TS-1")
  ]);
  let policyCalls = 0;
  const policy = createImportPolicy();
  const service = await TaskSealService.open({
    journal,
    importPolicyProvider: () => {
      policyCalls += 1;
      return policy;
    },
    clock: () => new Date(APPLIED_AT)
  });

  await assert.rejects(
    applyPlan(service, plan),
    hasCode("IMPORT_PLAN_STALE")
  );
  assert.equal(policyCalls, 1);
  assert.equal(journal.commitCalls, 0);
});

test("legacy baseline and managed title update apply as one authorized batch", async () => {
  const legacyEvent = createLegacyGitHubWorkItemEvent();
  const workflow = applyEvent(
    createWorkflow(),
    legacyEvent
  );
  const policy = createImportPolicy();
  const plan = previewSnapshotImport({
    snapshot: createGitHubIssueSnapshot({
      title: "Current issue title",
      revisionId: "2026-07-26T08:02:00.000Z",
      revisionOccurredAt:
        "2026-07-26T08:02:00.000Z"
    }),
    workflow,
    importPolicy: policy
  });
  const journal = new MemoryJournal([legacyEvent]);
  const service = await openService(journal, policy);

  const result = await applyPlan(service, plan);
  const workItem = service.getWorkItem("TS-1");

  assert.equal(result.resolution, "committed");
  assert.equal(journal.commitCalls, 1);
  assert.equal(workItem?.title, "Current issue title");
  assert.equal(
    workItem?.externalLinks[0]?.legacy,
    undefined
  );
});

test("baseline, refresh, and title-update payload identities stay bound to their actions before policy access", async () => {
  const policy = createImportPolicy();
  const richInitialPlan = previewSnapshotImport({
    snapshot: createGitHubIssueSnapshot({
      title: "Initial issue title",
      revisionId: "2026-07-26T08:00:00.000Z",
      revisionOccurredAt:
        "2026-07-26T08:00:00.000Z"
    }),
    workflow: createWorkflow(),
    importPolicy: policy
  });
  const richWorkflow = richInitialPlan.events.reduce(
    applyEvent,
    createWorkflow()
  );
  const refreshPlan = previewSnapshotImport({
    snapshot: createGitHubIssueSnapshot({
      title: "Updated issue title",
      revisionId: "2026-07-26T08:02:00.000Z",
      revisionOccurredAt:
        "2026-07-26T08:02:00.000Z"
    }),
    workflow: richWorkflow,
    importPolicy: policy
  });
  const legacyEvent = createLegacyGitHubWorkItemEvent();
  const legacyWorkflow = applyEvent(
    createWorkflow(),
    legacyEvent
  );
  const baselinePlan = previewSnapshotImport({
    snapshot: createGitHubIssueSnapshot({
      managedFields: [],
      revisionId: "2026-07-26T08:02:00.000Z",
      revisionOccurredAt:
        "2026-07-26T08:02:00.000Z"
    }),
    workflow: legacyWorkflow,
    importPolicy: policy
  });

  const cases = [
    {
      plan: baselinePlan,
      records: [legacyEvent],
      mutate(plan: ImportPlan) {
        const event = plan.events.find(
          (candidate) =>
            candidate.type ===
            "external_link.observed"
        );
        assert.ok(event);
        const baseline = event.payload.baseline as {
          providerObjectKey: string;
        };
        baseline.providerObjectKey =
          "github:issue:999";
      }
    },
    {
      plan: refreshPlan,
      records: richInitialPlan.events,
      mutate(plan: ImportPlan) {
        const event = plan.events.find(
          (candidate) =>
            candidate.type ===
            "external_link.observed"
        );
        assert.ok(event);
        const observation =
          event.payload.observation as {
            revisionId: string;
          };
        observation.revisionId =
          "2026-07-26T09:00:00.000Z";
      }
    },
    {
      plan: refreshPlan,
      records: richInitialPlan.events,
      mutate(plan: ImportPlan) {
        const event = plan.events.find(
          (candidate) =>
            candidate.type === "work_item.updated"
        );
        assert.ok(event);
        const source = event.payload.source as {
          providerObjectKey: string;
          revisionId: string;
        };
        source.providerObjectKey =
          "github:issue:999";
        source.revisionId =
          "2026-07-26T09:00:00.000Z";
      }
    }
  ];

  for (const scenario of cases) {
    const forged = structuredClone(scenario.plan);
    scenario.mutate(forged);
    forged.planDigest = computeImportPlanDigest(forged);
    let policyCalls = 0;
    const journal = new MemoryJournal(
      scenario.records
    );
    const service = await TaskSealService.open({
      journal,
      importPolicyProvider: () => {
        policyCalls += 1;
        return policy;
      },
      clock: () => new Date(APPLIED_AT)
    });

    await assert.rejects(
      applyPlan(service, forged),
      hasCode("IMPORT_PLAN_TAMPERED")
    );
    assert.equal(policyCalls, 0);
    assert.equal(journal.commitCalls, 0);
  }
});

test("a previewed legacy baseline authority conflict reaches the blocked decision", async () => {
  const records = [
    createLegacyGitHubWorkItemEvent(),
    createLinearTitleManagerEvent()
  ];
  const journal = new MemoryJournal(records);
  const service = await openService(journal);
  const plan = createPreviewPlan({
    workflow: service.getWorkflow()
  });

  assert.equal(plan.conflicts.length > 0, true);
  assert.equal(
    plan.actions.some(
      (action) =>
        action.reasonCode ===
          "FIELD_AUTHORITY_CONFLICT" &&
        action.semanticTarget ===
          "external-link-observation"
    ),
    true
  );
  await assert.rejects(
    applyPlan(service, plan),
    hasCode("IMPORT_PLAN_BLOCKED")
  );
  assert.equal(journal.commitCalls, 0);
});

test("scope changes make a plan policy-stale without trusting caller policy", async () => {
  const journal = new MemoryJournal();
  const changedPolicy = createImportPolicy();
  required(changedPolicy.allowedScopes[0]).scopeRef.key =
    "github:repository:netpilot-z/other";
  const service = await openService(
    journal,
    changedPolicy
  );
  const plan = createPreviewPlan();

  await assert.rejects(
    applyPlan(service, plan),
    hasCode("IMPORT_POLICY_STALE")
  );
  assert.equal(journal.commitCalls, 0);
});

test("known pre-commit failures preserve state and remain retryable", async () => {
  const journal = new MemoryJournal();
  journal.commitError = codedError(
    "JOURNAL_WRITE_FAILED"
  );
  const service = await openService(journal);
  const plan = createPreviewPlan();

  await assert.rejects(
    applyPlan(service, plan),
    hasCode("JOURNAL_WRITE_FAILED")
  );
  assert.deepEqual(service.getWorkflow().workItems, {});
  assert.equal(
    service.getImportReceipt({
      planDigest: plan.planDigest
    }),
    null
  );
  assert.equal(service.getHealth().status, "ready");

  journal.commitError = null;
  const result = await applyPlan(service, plan);
  assert.equal(result.resolution, "committed");
});

test("unknown commit outcome permanently fences the current service instance", async () => {
  const journal = new MemoryJournal();
  journal.commitError = codedError(
    "JOURNAL_COMMIT_OUTCOME_UNKNOWN"
  );
  const service = await openService(journal);
  const plan = createPreviewPlan();

  await assert.rejects(
    applyPlan(service, plan),
    hasCode("IMPORT_COMMIT_OUTCOME_UNKNOWN")
  );
  assert.deepEqual(service.getHealth(), {
    status: "fenced",
    code: "IMPORT_COMMIT_OUTCOME_UNKNOWN",
    planDigest: plan.planDigest
  });

  for (const read of [
    () => service.getWorkflow(),
    () => service.getWorkItem("TS-1"),
    () => service.snapshot(),
    () =>
      service.getImportReceipt({
        planDigest: plan.planDigest
      })
  ]) {
    assert.throws(read, hasCode("SERVICE_REOPEN_REQUIRED"));
  }

  await assert.rejects(
    service.append(createLocalWorkItemEvent("later")),
    hasCode("SERVICE_REOPEN_REQUIRED")
  );
  await assert.rejects(
    applyPlan(service, plan),
    hasCode("SERVICE_REOPEN_REQUIRED")
  );
  await assert.rejects(
    service.recoverRunningAttempts(),
    hasCode("SERVICE_REOPEN_REQUIRED")
  );
});

test("concurrent retries share the write queue and commit one batch", async () => {
  const journal = new MemoryJournal();
  const service = await openService(journal);
  const plan = createPreviewPlan();
  const [first, second] = await Promise.all([
    applyPlan(service, plan),
    applyPlan(service, plan)
  ]);

  assert.equal(first.resolution, "committed");
  assert.equal(second.resolution, "idempotent");
  assert.equal(journal.commitCalls, 1);
});

test("append and import apply are serialized in enqueue order", async () => {
  const staleJournal = new MemoryJournal();
  const staleService = await openService(staleJournal);
  const stalePlan = createPreviewPlan();
  const appended = staleService.append(
    createLocalWorkItemEvent("first")
  );
  const staleApply = applyPlan(
    staleService,
    stalePlan
  );

  await appended;
  await assert.rejects(
    staleApply,
    hasCode("IMPORT_PLAN_STALE")
  );
  assert.equal(staleJournal.commitCalls, 0);

  const committedJournal = new MemoryJournal();
  const committedService = await openService(
    committedJournal
  );
  const plan = createPreviewPlan();
  const applied = applyPlan(committedService, plan);
  const appendedAfter = committedService.append(
    createLocalWorkItemEvent("second")
  );

  assert.equal(
    (await applied).resolution,
    "committed"
  );
  await appendedAfter;
  assert.equal(
    required(
      committedService.getWorkItem("TS-1")
    ).status,
    "planned"
  );
  assert.equal(
    required(
      committedService.getWorkItem("second")
    ).status,
    "planned"
  );
  assert.equal(committedJournal.records.length, 2);
});

test("already queued writes fail closed after an unknown import outcome", async () => {
  const journal = new MemoryJournal();
  journal.commitError = codedError(
    "JOURNAL_COMMIT_OUTCOME_UNKNOWN"
  );
  const service = await openService(journal);
  const plan = createPreviewPlan();
  const applying = applyPlan(service, plan);
  const queuedAppend = service.append(
    createLocalWorkItemEvent("queued")
  );

  await assert.rejects(
    applying,
    hasCode("IMPORT_COMMIT_OUTCOME_UNKNOWN")
  );
  await assert.rejects(
    queuedAppend,
    hasCode("SERVICE_REOPEN_REQUIRED")
  );
});

test("replay skips identical seen batches before base checks and rejects changed duplicates", async () => {
  const plan = createPreviewPlan();
  const record = createImportBatchRecord({
    plan,
    actor: createActor(),
    appliedAt: APPLIED_AT
  });
  const laterEvent = createLocalWorkItemEvent("later");
  const valid = await TaskSealService.open({
    journal: new MemoryJournal([
      record,
      laterEvent,
      structuredClone(record)
    ])
  });

  assert.equal(
    required(valid.getWorkItem("TS-1")).status,
    "planned"
  );
  assert.equal(
    required(valid.getWorkItem("later")).status,
    "planned"
  );

  const changed = structuredClone(record);
  changed.actor.id = "forged";
  await assert.rejects(
    TaskSealService.open({
      journal: new MemoryJournal([record, changed])
    }),
    hasCode("JOURNAL_CORRUPT")
  );
  await assert.rejects(
    TaskSealService.open({
      journal: new MemoryJournal([
        createLocalWorkItemEvent("before"),
        record
      ])
    }),
    hasCode("JOURNAL_CORRUPT")
  );
});

async function openService(
  journal: EventJournal,
  policy: unknown = createImportPolicy()
): Promise<TaskSealService> {
  return TaskSealService.open({
    journal,
    importPolicyProvider: async () =>
      structuredClone(policy),
    clock: () => new Date(APPLIED_AT)
  });
}

function applyPlan(
  service: TaskSealService,
  plan: ImportPlan
): Promise<SnapshotImportApplyResult> {
  return service.applySnapshotImport({
    plan,
    expectedPlanDigest: plan.planDigest,
    actor: createActor()
  });
}

class MemoryJournal {
  records: unknown[];
  commitCalls: number;
  commitError: Error | null;

  constructor(records: unknown[] = []) {
    this.records = structuredClone(records);
    this.commitCalls = 0;
    this.commitError = null;
  }

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
    this.commitCalls += 1;

    if (this.commitError) {
      throw this.commitError;
    }

    this.records.push(structuredClone(record));
  }
}

function createLocalWorkItemEvent(
  workItemId: string
): WorkItemCreatedEvent {
  return {
    eventId: `local:${workItemId}:created`,
    workItemId,
    type: "work_item.created",
    occurredAt: "2026-07-26T08:02:00.000Z",
    payload: {
      title: `Local ${workItemId}`,
      requiredEvidence: ["tests"],
      externalLink: {
        provider: "taskseal",
        externalId: workItemId,
        url:
          `http://127.0.0.1/work-items/${workItemId}`
      }
    }
  };
}

function createLegacyGitHubWorkItemEvent():
  WorkItemCreatedEvent {
  return {
    eventId: "github:issue-501:created",
    workItemId: "TS-1",
    type: "work_item.created",
    occurredAt: "2026-07-26T08:00:00.000Z",
    payload: {
      title: "Legacy provider issue",
      requiredEvidence: ["tests"],
      externalLink: {
        provider: "github",
        externalId: "501",
        url:
          "https://github.com/netpilot-z/TaskSeal/issues/1"
      }
    }
  };
}

function createLinearTitleManagerEvent():
  ExternalLinkLinkedEvent {
  return {
    eventId: "taskseal:import:v1:link:linear-1",
    workItemId: "TS-1",
    type: "external_link.linked",
    occurredAt: "2026-07-26T08:00:30.000Z",
    payload: {
      link: {
        providerObjectKey:
          "linear:issue:11111111-1111-4111-8111-111111111111",
        provider: "linear",
        objectType: "issue",
        externalId:
          "11111111-1111-4111-8111-111111111111",
        scopeRef: {
          kind: "team",
          key:
            "linear:team:22222222-2222-4222-8222-222222222222",
          parentKey:
            "linear:organization:33333333-3333-4333-8333-333333333333"
        },
        url:
          "https://linear.app/taskseal/issue/NP-1/example",
        managedFields: ["title"],
        lastObservation: {
          revisionId: "2026-07-26T08:00:30.000Z",
          occurredAt: "2026-07-26T08:00:30.000Z",
          contentDigest: `sha256:${"c".repeat(64)}`,
          title: "Legacy provider issue"
        }
      }
    }
  };
}

async function createTemporaryDirectory(
  t: TestContext
): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "taskseal-import-apply-")
  );
  t.after(() =>
    rm(directory, {
      recursive: true,
      force: true
    })
  );
  return directory;
}

class CodedError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CodedError";
    this.code = code;
  }
}

function codedError(code: string): CodedError {
  return new CodedError(code);
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}

function required<T>(
  value: T | null | undefined,
  label = "value"
): T {
  if (value === null || value === undefined) {
    throw new Error(`${label} is required.`);
  }

  return value;
}
