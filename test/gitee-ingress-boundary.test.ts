import assert from "node:assert/strict";
import test from "node:test";

import {
  createProviderIngressRegistry
} from "../src/application/provider-ingress-registry.ts";
import {
  computePolicyDigest
} from "../src/application/import-policy.ts";
import {
  deriveImportActionId,
  deriveImportEventId,
  computeImportPlanDigest
} from "../src/application/import-plan.ts";
import {
  previewSnapshotImport
} from "../src/application/snapshot-import.ts";
import { TaskSealService } from "../src/application/taskseal-service.ts";
import {
  normalizeGiteeIssueFact
} from "../src/connectors/gitee.ts";
import {
  applyEvent,
  createWorkflow
} from "../src/domain/workflow.ts";
import type {
  ImportBatchRecord
} from "../src/application/import-batch.ts";
import type {
  EventJournal
} from "../src/application/taskseal-service.ts";
import {
  createPreviewPlan
} from "../test-support/snapshot-import-fixtures.ts";

const GITEE_ISSUE = {
  id: 2_614,
  number: "I4",
  title: "Git push crashes",
  htmlUrl: "https://gitee.com/oschina/git-osc/issues/I4",
  createdAt: "2013-04-12T12:15:08+08:00",
  updatedAt: "2022-07-22T05:01:31+08:00",
  repository: "oschina/git-osc"
};

test("Gitee import preview requires an explicit per-scope preview grant", () => {
  const plan = previewSnapshotImport({
    snapshot: createGiteeSnapshot(),
    workflow: createWorkflow(),
    importPolicy: createGiteeImportPolicy({
      applyAllowed: false
    })
  });

  assert.equal(plan.policyBinding.provider, "gitee");
  assert.equal(plan.policyBinding.schemaVersion, 2);
  assert.equal(plan.policyBinding.applyAllowed, false);
  assert.deepEqual(plan.policyBinding.scopeRef, {
    kind: "repository",
    key: "gitee:repository:oschina/git-osc"
  });
  assert.deepEqual(plan.policyBinding.requiredObjectTypes, [
    "issue"
  ]);
  assert.equal(plan.summary.create, 1);
  assert.equal(plan.events[0]?.type, "work_item.created");
});

test("a registry revocation blocks Gitee before policy access", () => {
  let policyReads = 0;
  const importPolicy = new Proxy({}, {
    ownKeys() {
      policyReads += 1;
      return [];
    }
  });

  assert.throws(
    () =>
      previewSnapshotImport({
        snapshot: createGiteeSnapshot(),
        workflow: createWorkflow(),
        importPolicy,
        providerIngressRegistry:
          createProviderIngressRegistry([])
      }),
    hasCode("PROVIDER_INGRESS_FORBIDDEN")
  );
  assert.equal(policyReads, 0);
});

test("a revoked per-scope preview capability blocks Gitee before planning", () => {
  assert.throws(
    () =>
      previewSnapshotImport({
        snapshot: createGiteeSnapshot(),
        workflow: createWorkflow(),
        importPolicy: createGiteeImportPolicy({
          previewAllowed: false,
          applyAllowed: false
        })
      }),
    hasCode("IMPORT_PREVIEW_FORBIDDEN")
  );
});

test("Gitee apply commits only with an explicit scope apply grant and still replays after revocation", async () => {
  const policy = createGiteeImportPolicy();
  const plan = previewSnapshotImport({
    snapshot: createGiteeSnapshot(),
    workflow: createWorkflow(),
    importPolicy: policy
  });
  const journal = new MemoryJournal();
  const service = await TaskSealService.open({
    journal,
    importPolicyProvider: () => policy
  });

  const result = await service.applySnapshotImport({
    plan,
    expectedPlanDigest: plan.planDigest,
    actor: {
      type: "human",
      id: "operator"
    }
  });

  assert.equal(result.resolution, "committed");
  assert.equal(journal.appendCalls, 0);
  assert.equal(journal.commitCalls, 1);
  assert.equal(
    service.getWorkItem("TS-GITEE-I4")?.title,
    GITEE_ISSUE.title
  );

  const reopened = await TaskSealService.open({
    journal,
    providerIngressRegistry:
      createProviderIngressRegistry([])
  });
  assert.equal(
    reopened.getWorkItem("TS-GITEE-I4")?.externalLinks[0]
      ?.provider,
    "gitee"
  );
  assert.deepEqual(
    reopened.getImportReceipt({
      planDigest: plan.planDigest
    }),
    result.receipt
  );
});

test("registry revocation after preview blocks apply before policy and journal access", async () => {
  const policy = createGiteeImportPolicy();
  const plan = previewSnapshotImport({
    snapshot: createGiteeSnapshot(),
    workflow: createWorkflow(),
    importPolicy: policy
  });
  let policyCalls = 0;
  const journal = new MemoryJournal();
  const service = await TaskSealService.open({
    journal,
    providerIngressRegistry:
      createProviderIngressRegistry([]),
    importPolicyProvider: () => {
      policyCalls += 1;
      return policy;
    }
  });

  await assert.rejects(
    service.applySnapshotImport({
      plan,
      expectedPlanDigest: plan.planDigest,
      actor: {
        type: "human",
        id: "operator"
      }
    }),
    hasCode("PROVIDER_INGRESS_FORBIDDEN")
  );
  assert.equal(policyCalls, 0);
  assert.equal(journal.appendCalls, 0);
  assert.equal(journal.commitCalls, 0);
});

test("a preview-only Gitee scope cannot apply and performs zero writes", async () => {
  const policy = createGiteeImportPolicy({
    applyAllowed: false
  });
  const plan = previewSnapshotImport({
    snapshot: createGiteeSnapshot(),
    workflow: createWorkflow(),
    importPolicy: policy
  });
  const journal = new MemoryJournal();
  const service = await TaskSealService.open({
    journal,
    importPolicyProvider: () => policy
  });

  await assert.rejects(
    service.applySnapshotImport({
      plan,
      expectedPlanDigest: plan.planDigest,
      actor: {
        type: "human",
        id: "operator"
      }
    }),
    hasCode("IMPORT_APPLY_FORBIDDEN")
  );
  assert.equal(journal.appendCalls, 0);
  assert.equal(journal.commitCalls, 0);
  assert.equal(service.getWorkItem("TS-GITEE-I4"), null);
});

test("a forged cross-provider plan is rejected before policy or journal access", async () => {
  const forged = structuredClone(createPreviewPlan());
  forged.policyBinding = {
    schemaVersion: 2,
    capability: "snapshot.import.apply",
    applyAllowed: true,
    provider: "gitee",
    scopeRef: {
      kind: "repository",
      key: "gitee:repository:oschina/git-osc"
    },
    requiredObjectTypes: ["issue"]
  };
  forged.policyDigest = computePolicyDigest(
    forged.policyBinding
  );
  forged.planDigest = computeImportPlanDigest(forged);

  let policyCalls = 0;
  const journal = new MemoryJournal();
  const service = await TaskSealService.open({
    journal,
    importPolicyProvider: () => {
      policyCalls += 1;
      return createGiteeImportPolicy();
    }
  });

  await assert.rejects(
    service.applySnapshotImport({
      plan: forged,
      expectedPlanDigest: forged.planDigest,
      actor: {
        type: "human",
        id: "operator"
      }
    }),
    hasCode("IMPORT_PLAN_TAMPERED")
  );
  assert.equal(policyCalls, 0);
  assert.equal(journal.appendCalls, 0);
  assert.equal(journal.commitCalls, 0);
});

test("a Gitee rich candidate cannot bypass import through direct append", async () => {
  const fact = createGiteeFact();
  const journal = new MemoryJournal();
  const service = await TaskSealService.open({ journal });

  await assert.rejects(
    service.append(fact.candidateEvent),
    hasCode("PROVIDER_INGRESS_FORBIDDEN")
  );
  assert.equal(journal.appendCalls, 0);
  assert.equal(journal.commitCalls, 0);
  assert.equal(service.getWorkItem("TS-GITEE-I4"), null);
});

test("Gitee Issue URL reference case drift is rejected before policy access", () => {
  const snapshot = createGiteeSnapshot();
  const fact = snapshot.facts[0];
  if (!fact) {
    throw new Error("Expected a Gitee fact.");
  }
  fact.sourceObject.url =
    "https://gitee.com/oschina/git-osc/issues/i4";
  let policyReads = 0;
  const importPolicy = new Proxy({}, {
    ownKeys() {
      policyReads += 1;
      return [];
    }
  });

  assert.throws(
    () =>
      previewSnapshotImport({
        snapshot,
        workflow: createWorkflow(),
        importPolicy
      }),
    hasCode("SNAPSHOT_INVALID")
  );
  assert.equal(policyReads, 0);
});

test("Gitee ingress rejects non-canonical paths in both source and candidate links", () => {
  for (const mutate of [
    (snapshot: ReturnType<typeof createGiteeSnapshot>) => {
      const fact = requireGiteeFact(snapshot);
      fact.sourceObject.url += "/";
    },
    (snapshot: ReturnType<typeof createGiteeSnapshot>) => {
      const fact = requireGiteeFact(snapshot);
      fact.candidateEvent.payload.externalLink.url =
        "https://gitee.com/oschina//git-osc/issues/I4";
    }
  ]) {
    const snapshot = createGiteeSnapshot();
    mutate(snapshot);
    let policyReads = 0;
    const importPolicy = new Proxy({}, {
      ownKeys() {
        policyReads += 1;
        return [];
      }
    });

    assert.throws(
      () =>
        previewSnapshotImport({
          snapshot,
          workflow: createWorkflow(),
          importPolicy
        }),
      hasCode("SNAPSHOT_INVALID")
    );
    assert.equal(policyReads, 0);
  }
});

test("the longest valid Gitee identity remains importable", async () => {
  const owner = "a".repeat(100);
  const repositoryName = "b".repeat(100);
  const repository = `${owner}/${repositoryName}`;
  const issueReference = `I${"9".repeat(63)}`;
  const issue = {
    ...GITEE_ISSUE,
    number: issueReference,
    repository,
    htmlUrl:
      `https://gitee.com/${repository}/issues/` +
      issueReference
  };
  const snapshot = createGiteeSnapshot(issue);
  const policy = createGiteeImportPolicy({
    key: `gitee:repository:${repository}`
  });
  const plan = previewSnapshotImport({
    snapshot,
    workflow: createWorkflow(),
    importPolicy: policy
  });

  assert.ok(
    requireGiteeFact(snapshot).sourceObject
      .providerObjectKey.length > 256
  );
  assert.equal(plan.summary.create, 1);

  const journal = new MemoryJournal();
  const service = await TaskSealService.open({
    journal,
    importPolicyProvider: () => policy
  });
  const result = await service.applySnapshotImport({
    plan,
    expectedPlanDigest: plan.planDigest,
    actor: {
      type: "human",
      id: "operator"
    }
  });
  assert.equal(result.resolution, "committed");
  assert.equal(journal.commitCalls, 1);
});

test("a forged same-provider URL is rejected before policy or journal access", async () => {
  const policy = createGiteeImportPolicy();
  const forged = structuredClone(
    previewSnapshotImport({
      snapshot: createGiteeSnapshot(),
      workflow: createWorkflow(),
      importPolicy: policy
    })
  );
  const event = forged.events.find(
    (candidate) =>
      candidate.type === "work_item.created"
  );
  assert.ok(event);
  const link = event.payload.externalLink as {
    url: string;
  };
  link.url = "https://evil.example/phish";
  forged.planDigest = computeImportPlanDigest(forged);

  let policyCalls = 0;
  const journal = new MemoryJournal();
  const service = await TaskSealService.open({
    journal,
    importPolicyProvider: () => {
      policyCalls += 1;
      return policy;
    }
  });

  await assert.rejects(
    service.applySnapshotImport({
      plan: forged,
      expectedPlanDigest: forged.planDigest,
      actor: {
        type: "human",
        id: "operator"
      }
    }),
    hasCode("IMPORT_PLAN_TAMPERED")
  );
  assert.equal(policyCalls, 0);
  assert.equal(journal.commitCalls, 0);
});

test("an observed Gitee link cannot be rebound to another repository scope", async () => {
  const foreignIssue = {
    ...GITEE_ISSUE,
    number: "I9",
    repository: "foreign/repo",
    htmlUrl: "https://gitee.com/foreign/repo/issues/I9"
  };
  const foreignPolicy = createGiteeImportPolicy({
    key: "gitee:repository:foreign/repo"
  });
  const initialPlan = previewSnapshotImport({
    snapshot: createGiteeSnapshot(foreignIssue),
    workflow: createWorkflow(),
    importPolicy: foreignPolicy
  });
  const workflow = initialPlan.events.reduce(
    applyEvent,
    createWorkflow()
  );
  const refreshPlan = previewSnapshotImport({
    snapshot: createGiteeSnapshot({
      ...foreignIssue,
      title: "Updated foreign issue",
      updatedAt: "2026-07-27T09:00:00.000Z"
    }),
    workflow,
    importPolicy: foreignPolicy
  });
  assert.equal(
    refreshPlan.events[0]?.type,
    "external_link.observed"
  );

  const forged = structuredClone(refreshPlan);
  forged.policyBinding = {
    schemaVersion: 2,
    capability: "snapshot.import.apply",
    applyAllowed: true,
    provider: "gitee",
    scopeRef: {
      kind: "repository",
      key: "gitee:repository:oschina/git-osc"
    },
    requiredObjectTypes: ["issue"]
  };
  forged.policyDigest = computePolicyDigest(
    forged.policyBinding
  );
  forged.planDigest = computeImportPlanDigest(forged);

  let policyCalls = 0;
  const journal = new MemoryJournal(initialPlan.events);
  const service = await TaskSealService.open({
    journal,
    importPolicyProvider: () => {
      policyCalls += 1;
      return createGiteeImportPolicy();
    }
  });

  await assert.rejects(
    service.applySnapshotImport({
      plan: forged,
      expectedPlanDigest: forged.planDigest,
      actor: {
        type: "human",
        id: "operator"
      }
    }),
    hasCode("IMPORT_PLAN_TAMPERED")
  );
  assert.equal(policyCalls, 0);
  assert.equal(journal.commitCalls, 0);
});

test("an observed payload cannot update a foreign Gitee link through an allowed action identity", async () => {
  const foreignIssue = {
    ...GITEE_ISSUE,
    number: "I9",
    repository: "foreign/repo",
    htmlUrl: "https://gitee.com/foreign/repo/issues/I9"
  };
  const allowedPolicy = createGiteeImportPolicy();
  const foreignPolicy = createGiteeImportPolicy({
    key: "gitee:repository:foreign/repo"
  });
  const allowedPlan = previewSnapshotImport({
    snapshot: createGiteeSnapshot(),
    workflow: createWorkflow(),
    importPolicy: allowedPolicy
  });
  const allowedWorkflow = allowedPlan.events.reduce(
    applyEvent,
    createWorkflow()
  );
  const foreignLinkPlan = previewSnapshotImport({
    snapshot: createGiteeSnapshot(foreignIssue),
    workflow: allowedWorkflow,
    importPolicy: foreignPolicy
  });
  const workflow = foreignLinkPlan.events.reduce(
    applyEvent,
    allowedWorkflow
  );
  const foreignRefreshPlan = previewSnapshotImport({
    snapshot: createGiteeSnapshot({
      ...foreignIssue,
      title: "Foreign refreshed",
      updatedAt: "2026-07-27T09:00:00.000Z"
    }),
    workflow,
    importPolicy: foreignPolicy
  });
  const forged = structuredClone(foreignRefreshPlan);
  const action = forged.actions[0];
  const event = forged.events[0];
  const allowedSourceObjectKey =
    allowedPlan.actions[0]?.sourceObjectKey;
  assert.ok(action);
  assert.ok(event);
  assert.ok(allowedSourceObjectKey);
  assert.equal(event.type, "external_link.observed");
  assert.notEqual(
    event.payload.providerObjectKey,
    allowedSourceObjectKey
  );

  forged.policyBinding =
    structuredClone(allowedPlan.policyBinding);
  forged.policyDigest = computePolicyDigest(
    forged.policyBinding
  );
  action.sourceObjectKey = allowedSourceObjectKey;
  action.actionId = deriveImportActionId({
    workItemId: action.workItemId,
    sourceObjectKey: action.sourceObjectKey,
    sourceRevisionId: action.sourceRevisionId,
    semanticTarget: action.semanticTarget
  });
  event.eventId = deriveImportEventId({
    eventType: event.type,
    workItemId: action.workItemId,
    providerObjectKey: action.sourceObjectKey,
    sourceRevisionId: action.sourceRevisionId,
    semanticTarget: action.semanticTarget
  });
  action.eventIds = [event.eventId];
  forged.planDigest = computeImportPlanDigest(forged);

  let policyCalls = 0;
  const journal = new MemoryJournal([
    ...allowedPlan.events,
    ...foreignLinkPlan.events
  ]);
  const service = await TaskSealService.open({
    journal,
    importPolicyProvider: () => {
      policyCalls += 1;
      return allowedPolicy;
    }
  });

  await assert.rejects(
    service.applySnapshotImport({
      plan: forged,
      expectedPlanDigest: forged.planDigest,
      actor: {
        type: "human",
        id: "operator"
      }
    }),
    hasCode("IMPORT_PLAN_TAMPERED")
  );
  assert.equal(policyCalls, 0);
  assert.equal(journal.commitCalls, 0);
});

test("a no-op Gitee action cannot persist a receipt under another repository scope", async () => {
  const foreignIssue = {
    ...GITEE_ISSUE,
    number: "I9",
    repository: "foreign/repo",
    htmlUrl: "https://gitee.com/foreign/repo/issues/I9"
  };
  const foreignPolicy = createGiteeImportPolicy({
    key: "gitee:repository:foreign/repo"
  });
  const initialPlan = previewSnapshotImport({
    snapshot: createGiteeSnapshot(foreignIssue),
    workflow: createWorkflow(),
    importPolicy: foreignPolicy
  });
  const workflow = initialPlan.events.reduce(
    applyEvent,
    createWorkflow()
  );
  const noOp = previewSnapshotImport({
    snapshot: createGiteeSnapshot(foreignIssue),
    workflow,
    importPolicy: foreignPolicy
  });
  assert.equal(noOp.summary.skip, 1);
  assert.equal(noOp.events.length, 0);

  const forged = structuredClone(noOp);
  forged.policyBinding = {
    schemaVersion: 2,
    capability: "snapshot.import.apply",
    applyAllowed: true,
    provider: "gitee",
    scopeRef: {
      kind: "repository",
      key: "gitee:repository:oschina/git-osc"
    },
    requiredObjectTypes: ["issue"]
  };
  forged.policyDigest = computePolicyDigest(
    forged.policyBinding
  );
  forged.planDigest = computeImportPlanDigest(forged);

  const journal = new MemoryJournal(initialPlan.events);
  const service = await TaskSealService.open({
    journal,
    importPolicyProvider: () =>
      createGiteeImportPolicy()
  });
  await assert.rejects(
    service.applySnapshotImport({
      plan: forged,
      expectedPlanDigest: forged.planDigest,
      actor: {
        type: "human",
        id: "operator"
      }
    }),
    hasCode("IMPORT_PLAN_TAMPERED")
  );
  assert.equal(journal.commitCalls, 0);

  const wrongWorkItem = structuredClone(noOp);
  const action = wrongWorkItem.actions[0];
  assert.ok(action);
  action.workItemId = "FORGED-WORK-ITEM";
  action.actionId = deriveImportActionId({
    workItemId: action.workItemId,
    sourceObjectKey: action.sourceObjectKey,
    sourceRevisionId: action.sourceRevisionId,
    semanticTarget: action.semanticTarget
  });
  wrongWorkItem.planDigest =
    computeImportPlanDigest(wrongWorkItem);
  const sameScopeJournal =
    new MemoryJournal(initialPlan.events);
  const sameScopeService = await TaskSealService.open({
    journal: sameScopeJournal,
    importPolicyProvider: () => foreignPolicy
  });

  await assert.rejects(
    sameScopeService.applySnapshotImport({
      plan: wrongWorkItem,
      expectedPlanDigest: wrongWorkItem.planDigest,
      actor: {
        type: "human",
        id: "operator"
      }
    }),
    hasCode("IMPORT_PLAN_TAMPERED")
  );
  assert.equal(sameScopeJournal.commitCalls, 0);
});

test("Gitee repository path case is canonicalized consistently through apply", async () => {
  const issue = {
    ...GITEE_ISSUE,
    repository: "OSChina/Git-Osc",
    htmlUrl:
      "https://gitee.com/OSChina/Git-Osc/issues/I4"
  };
  const policy = createGiteeImportPolicy();
  const plan = previewSnapshotImport({
    snapshot: createGiteeSnapshot(issue),
    workflow: createWorkflow(),
    importPolicy: policy
  });
  const journal = new MemoryJournal();
  const service = await TaskSealService.open({
    journal,
    importPolicyProvider: () => policy
  });

  const result = await service.applySnapshotImport({
    plan,
    expectedPlanDigest: plan.planDigest,
    actor: {
      type: "human",
      id: "operator"
    }
  });
  assert.equal(result.resolution, "committed");
  assert.equal(journal.commitCalls, 1);
});

function createGiteeSnapshot(
  issue: typeof GITEE_ISSUE = GITEE_ISSUE
) {
  return {
    schemaVersion: 2 as const,
    mode: "read-only" as const,
    provider: "gitee" as const,
    scope: {
      kind: "repository" as const,
      key:
        `gitee:repository:${issue.repository.toLowerCase()}`
    },
    mapping: {
      workItemId: "TS-GITEE-I4",
      requiredEvidence: ["tests"],
      managedFields: [] as []
    },
    capturedAt: "2026-07-27T08:00:00.000Z",
    facts: [createGiteeFact(issue)]
  };
}

function createGiteeFact(
  issue: typeof GITEE_ISSUE = GITEE_ISSUE
) {
  return normalizeGiteeIssueFact(issue, {
    workItemId: "TS-GITEE-I4",
    requiredEvidence: ["tests"],
    managedFields: []
  });
}

function createGiteeImportPolicy({
  previewAllowed = true,
  applyAllowed = true,
  key = "gitee:repository:oschina/git-osc"
}: {
  previewAllowed?: boolean;
  applyAllowed?: boolean;
  key?: string;
} = {}) {
  return {
    schemaVersion: 2,
    allowedScopes: [
      {
        provider: "gitee",
        scopeRef: {
          kind: "repository",
          key
        },
        objectTypes: ["issue"],
        capabilities: {
          "snapshot.import.preview": previewAllowed,
          "snapshot.import.apply": applyAllowed
        }
      }
    ]
  };
}

class MemoryJournal implements EventJournal {
  readonly records: unknown[];
  appendCalls = 0;
  commitCalls = 0;

  constructor(records: unknown[] = []) {
    this.records = structuredClone(records);
  }

  async readAll(): Promise<unknown[]> {
    return structuredClone(this.records);
  }

  async append(event: unknown): Promise<void> {
    this.appendCalls += 1;
    this.records.push(structuredClone(event));
  }

  async commitBatch(
    record: ImportBatchRecord
  ): Promise<void> {
    this.commitCalls += 1;
    this.records.push(structuredClone(record));
  }
}

function requireGiteeFact(
  snapshot: ReturnType<typeof createGiteeSnapshot>
) {
  const fact = snapshot.facts[0];
  if (!fact) {
    throw new Error("Expected a Gitee fact.");
  }
  return fact;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}
