import assert from "node:assert/strict";
import test from "node:test";

import type {
  ImportBatchRecord
} from "../src/application/import-batch.ts";
import {
  ObservedSnapshotImportFacade
} from "../src/application/observed-snapshot-import.ts";
import {
  ProviderObservationCoordinator
} from "../src/application/provider-observation-coordinator.ts";
import {
  ProviderObservationReadModel
} from "../src/application/provider-observation.ts";
import type {
  ProviderObservationCommandPort,
  ProviderObservationFile,
  ProviderObservationInput,
  ProviderObservationStoragePort
} from "../src/application/provider-observation.ts";
import {
  previewSnapshotImport
} from "../src/application/snapshot-import.ts";
import {
  TaskSealService
} from "../src/application/taskseal-service.ts";
import type {
  EventJournal
} from "../src/application/taskseal-service.ts";
import {
  createWorkflow
} from "../src/domain/workflow.ts";
import type {
  CanonicalEvent
} from "../src/domain/workflow.ts";
import {
  createActor,
  createGitHubIssueSnapshot,
  createImportPolicy,
  createLinearImportPolicy,
  createLinearIssueSnapshot
} from "../test-support/snapshot-import-fixtures.ts";

const TARGET = {
  kind: "repository" as const,
  key: "github:repository:netpilot-z/taskseal"
};

test("observed snapshot import facade composes real preview and service apply including idempotent retry", async () => {
  const observationStorage =
    new MemoryObservationStorage();
  const observations =
    await ProviderObservationReadModel.open({
      storage: observationStorage
    });
  const times = [
    "2026-07-27T10:00:00.000Z",
    "2026-07-27T10:00:00.100Z",
    "2026-07-27T10:01:00.000Z",
    "2026-07-27T10:01:00.100Z",
    "2026-07-27T10:02:00.000Z",
    "2026-07-27T10:02:00.100Z"
  ];
  const coordinator = new ProviderObservationCoordinator({
    observations,
    clock: () => new Date(requireNext(times))
  });
  const journal = new MemoryJournal();
  const policy = createImportPolicy();
  const service = await TaskSealService.open({
    journal,
    importPolicyProvider: async () =>
      structuredClone(policy),
    clock: () =>
      new Date("2026-07-27T10:01:00.050Z")
  });
  const facade = new ObservedSnapshotImportFacade({
    provider: "github",
    configuredTarget: TARGET,
    boundScope: {
      kind: "repository",
      key: TARGET.key,
      parentKey: null
    },
    coordinator,
    imports: service
  });
  const snapshot = createGitHubIssueSnapshot();
  const workflow = createWorkflow();
  const expected = previewSnapshotImport({
    snapshot,
    workflow,
    importPolicy: policy
  });

  const plan = await facade.previewSnapshotImport({
    snapshot,
    workflow,
    importPolicy: policy
  });
  assert.deepEqual(plan, expected);
  assert.equal(journal.commitCalls, 0);
  let observation = (await observations.list()).providers[0];
  assert.equal(observation?.operation, "snapshot.preview");
  assert.equal(
    observation?.snapshotDigest,
    plan.snapshotDigest
  );
  assert.equal(
    observation?.mappingDigest,
    plan.mappingDigest
  );
  assert.equal(observation?.planDigest, plan.planDigest);

  const committed = await facade.applySnapshotImport({
    plan,
    expectedPlanDigest: plan.planDigest,
    actor: createActor()
  });
  assert.equal(committed.resolution, "committed");
  assert.equal(journal.commitCalls, 1);
  observation = (await observations.list()).providers[0];
  assert.equal(observation?.operation, "snapshot.import");
  assert.equal(observation?.resolution, "committed");

  const idempotent = await facade.applySnapshotImport({
    plan,
    expectedPlanDigest: plan.planDigest,
    actor: {
      type: "human",
      id: "retry-operator"
    }
  });
  assert.equal(idempotent.resolution, "idempotent");
  assert.deepEqual(idempotent.receipt, committed.receipt);
  assert.equal(journal.commitCalls, 1);
  observation = (await observations.list()).providers[0];
  assert.equal(observation?.resolution, "idempotent");
});

test("observed snapshot import facade preserves a real apply rejection and records only its safe code", async () => {
  const observations =
    await ProviderObservationReadModel.open({
      storage: new MemoryObservationStorage()
    });
  const coordinator = new ProviderObservationCoordinator({
    observations,
    clock: sequenceClock([
      "2026-07-27T10:00:00.000Z",
      "2026-07-27T10:00:00.100Z"
    ])
  });
  const journal = new MemoryJournal();
  const service = await TaskSealService.open({
    journal,
    importPolicyProvider: async () =>
      createImportPolicy({ applyAllowed: false }),
    clock: () =>
      new Date("2026-07-27T10:00:00.050Z")
  });
  const facade = new ObservedSnapshotImportFacade({
    provider: "github",
    configuredTarget: TARGET,
    boundScope: {
      kind: "repository",
      key: TARGET.key,
      parentKey: null
    },
    coordinator,
    imports: service
  });
  const plan = previewSnapshotImport({
    snapshot: createGitHubIssueSnapshot(),
    workflow: createWorkflow(),
    importPolicy: createImportPolicy()
  });

  await assert.rejects(
    facade.applySnapshotImport({
      plan,
      expectedPlanDigest: plan.planDigest,
      actor: createActor()
    }),
    hasCode("IMPORT_APPLY_FORBIDDEN")
  );
  assert.equal(journal.commitCalls, 0);
  const observation = (await observations.list()).providers[0];
  assert.equal(observation?.status, "sync_failed");
  assert.equal(
    observation?.diagnosticCode,
    "IMPORT_APPLY_FORBIDDEN"
  );
  assert.equal(observation?.snapshotDigest, null);
  assert.equal(observation?.resolution, null);
});

test("observed snapshot import facade keeps real preview and apply outcomes when the observation sink fails", async () => {
  const coordinator = new ProviderObservationCoordinator({
    observations: new ThrowingObservationCommand(),
    clock: sequenceClock([
      "2026-07-27T10:00:00.000Z",
      "2026-07-27T10:00:00.100Z",
      "2026-07-27T10:01:00.000Z",
      "2026-07-27T10:01:00.100Z"
    ])
  });
  const journal = new MemoryJournal();
  const policy = createImportPolicy();
  const service = await TaskSealService.open({
    journal,
    importPolicyProvider: async () =>
      structuredClone(policy),
    clock: () =>
      new Date("2026-07-27T10:01:00.050Z")
  });
  const facade = new ObservedSnapshotImportFacade({
    provider: "github",
    configuredTarget: TARGET,
    boundScope: {
      kind: "repository",
      key: TARGET.key,
      parentKey: null
    },
    coordinator,
    imports: service
  });
  const plan = await facade.previewSnapshotImport({
    snapshot: createGitHubIssueSnapshot(),
    workflow: createWorkflow(),
    importPolicy: policy
  });
  const result = await facade.applySnapshotImport({
    plan,
    expectedPlanDigest: plan.planDigest,
    actor: createActor()
  });

  assert.equal(result.resolution, "committed");
  assert.equal(journal.commitCalls, 1);
});

test("observed snapshot import facade rejects a cross-provider plan before the real service can commit", async () => {
  const observations =
    await ProviderObservationReadModel.open({
      storage: new MemoryObservationStorage()
    });
  const coordinator = new ProviderObservationCoordinator({
    observations,
    clock: sequenceClock([
      "2026-07-27T10:00:00.000Z",
      "2026-07-27T10:00:00.100Z"
    ])
  });
  const journal = new MemoryJournal();
  const linearPolicy = createLinearImportPolicy();
  const service = await TaskSealService.open({
    journal,
    importPolicyProvider: async () =>
      structuredClone(linearPolicy),
    clock: () =>
      new Date("2026-07-27T10:00:00.050Z")
  });
  const facade = new ObservedSnapshotImportFacade({
    provider: "github",
    configuredTarget: TARGET,
    boundScope: {
      kind: "repository",
      key: TARGET.key,
      parentKey: null
    },
    coordinator,
    imports: service
  });
  const plan = previewSnapshotImport({
    snapshot: createLinearIssueSnapshot(),
    workflow: createWorkflow(),
    importPolicy: linearPolicy
  });

  await assert.rejects(
    facade.applySnapshotImport({
      plan,
      expectedPlanDigest: plan.planDigest,
      actor: createActor()
    }),
    hasCode("SNAPSHOT_SCOPE_MISMATCH")
  );
  assert.equal(journal.commitCalls, 0);
  const observation = (await observations.list()).providers[0];
  assert.equal(observation?.status, "scope_mismatch");
  assert.equal(observation?.resolution, null);
});

test("observed snapshot import facade rejects a cross-provider snapshot before preview reads policy", async () => {
  const observations =
    await ProviderObservationReadModel.open({
      storage: new MemoryObservationStorage()
    });
  const coordinator = new ProviderObservationCoordinator({
    observations,
    clock: sequenceClock([
      "2026-07-27T10:00:00.000Z",
      "2026-07-27T10:00:00.100Z"
    ])
  });
  const facade = new ObservedSnapshotImportFacade({
    provider: "github",
    configuredTarget: TARGET,
    boundScope: {
      kind: "repository",
      key: TARGET.key,
      parentKey: null
    },
    coordinator,
    imports: {
      async applySnapshotImport() {
        throw new Error("not called");
      }
    }
  });
  let policyReads = 0;
  const importPolicy = {};
  Object.defineProperty(importPolicy, "schemaVersion", {
    enumerable: true,
    get() {
      policyReads += 1;
      return 1;
    }
  });

  await assert.rejects(
    facade.previewSnapshotImport({
      snapshot: createLinearIssueSnapshot(),
      workflow: createWorkflow(),
      importPolicy
    }),
    hasCode("SNAPSHOT_SCOPE_MISMATCH")
  );
  assert.equal(policyReads, 0);
  assert.equal(
    (await observations.list()).providers[0]?.status,
    "scope_mismatch"
  );
});

test("observed Linear preview rejects a different resolved Team scope from the configured binding", async () => {
  const observations =
    await ProviderObservationReadModel.open({
      storage: new MemoryObservationStorage()
    });
  const coordinator = new ProviderObservationCoordinator({
    observations,
    clock: sequenceClock([
      "2026-07-27T10:00:00.000Z",
      "2026-07-27T10:00:00.100Z"
    ])
  });
  const original = createLinearIssueSnapshot();
  const foreign = structuredClone(original);
  foreign.scope = {
    kind: "team",
    key:
      "linear:team:44444444-4444-4444-8444-444444444444",
    parentKey:
      "linear:organization:55555555-5555-4555-8555-555555555555"
  };
  const foreignPolicy = createLinearImportPolicy();
  const allowed = foreignPolicy.allowedScopes[0];
  assert.ok(allowed);
  allowed.scopeRef = structuredClone(foreign.scope);
  const facade = new ObservedSnapshotImportFacade({
    provider: "linear",
    configuredTarget: {
      kind: "team",
      key: "linear:team-ref:netpilot-z/netpilot"
    },
    boundScope: {
      kind: "team",
      key: original.scope.key,
      parentKey: original.scope.parentKey ?? null
    },
    coordinator,
    imports: {
      async applySnapshotImport() {
        throw new Error("not called");
      }
    }
  });

  await assert.rejects(
    facade.previewSnapshotImport({
      snapshot: foreign,
      workflow: createWorkflow(),
      importPolicy: foreignPolicy
    }),
    hasCode("SNAPSHOT_SCOPE_MISMATCH")
  );
  const observation = (await observations.list()).providers[0];
  assert.equal(observation?.status, "scope_mismatch");
  assert.equal(observation?.snapshotDigest, null);
});

test("observed Linear preview records a canonical scope when the valid snapshot UUID uses uppercase hex", async () => {
  const observations =
    await ProviderObservationReadModel.open({
      storage: new MemoryObservationStorage()
    });
  const coordinator = new ProviderObservationCoordinator({
    observations,
    clock: sequenceClock([
      "2026-07-27T10:00:00.000Z",
      "2026-07-27T10:00:00.100Z"
    ])
  });
  const snapshot = createLinearIssueSnapshot();
  snapshot.scope = {
    kind: "team",
    key:
      "linear:team:AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
    parentKey:
      "linear:organization:ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF"
  };
  const policy = createLinearImportPolicy();
  const allowedScope = policy.allowedScopes[0];
  assert.ok(allowedScope);
  allowedScope.scopeRef = {
    kind: "team",
    key:
      "linear:team:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    parentKey:
      "linear:organization:abcdefab-cdef-4abc-8def-abcdefabcdef"
  };
  const boundScope = allowedScope.scopeRef;
  assert.ok(boundScope);
  const facade = new ObservedSnapshotImportFacade({
    provider: "linear",
    configuredTarget: {
      kind: "team",
      key: "linear:team-ref:netpilot-z/netpilot"
    },
    boundScope: {
      kind: boundScope.kind,
      key: boundScope.key,
      parentKey: boundScope.parentKey ?? null
    },
    coordinator,
    imports: {
      async applySnapshotImport() {
        throw new Error("not called");
      }
    }
  });

  const plan = await facade.previewSnapshotImport({
    snapshot,
    workflow: createWorkflow(),
    importPolicy: policy
  });

  assert.equal(
    plan.policyBinding.scopeRef.key,
    boundScope.key
  );
  const observation =
    (await observations.list()).providers[0];
  assert.equal(observation?.status, "snapshot_ready");
  assert.deepEqual(
    observation?.observedScope,
    {
      kind: boundScope.kind,
      key: boundScope.key,
      parentKey: boundScope.parentKey ?? null
    }
  );
});

class MemoryObservationStorage
  implements ProviderObservationStoragePort
{
  value: ProviderObservationFile = {
    schemaVersion: 1,
    observations: []
  };

  async load(): Promise<unknown> {
    return structuredClone(this.value);
  }

  async replace(
    value: ProviderObservationFile
  ): Promise<void> {
    this.value = structuredClone(value);
  }
}

class ThrowingObservationCommand
  implements ProviderObservationCommandPort
{
  async record(
    _observation: ProviderObservationInput
  ): Promise<never> {
    throw new Error("observation sink unavailable");
  }

  async ensure(
    observation: ProviderObservationInput
  ): Promise<never> {
    return this.record(observation);
  }
}

class MemoryJournal implements EventJournal {
  records: unknown[] = [];
  commitCalls = 0;

  async readAll(): Promise<unknown[]> {
    return structuredClone(this.records);
  }

  async append(event: CanonicalEvent): Promise<void> {
    this.records.push(structuredClone(event));
  }

  async commitBatch(
    record: ImportBatchRecord
  ): Promise<void> {
    this.commitCalls += 1;
    this.records.push(structuredClone(record));
  }
}

function sequenceClock(values: string[]): () => Date {
  return () => new Date(requireNext(values));
}

function requireNext(values: string[]): string {
  const value = values.shift();
  if (!value) {
    assert.fail("Missing clock value.");
  }
  return value;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}
