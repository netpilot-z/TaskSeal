import assert from "node:assert/strict";
import test from "node:test";

import {
  previewSnapshotImport
} from "../src/application/snapshot-import.ts";
import { TaskSealService } from "../src/application/taskseal-service.ts";
import {
  normalizeGiteeIssueFact
} from "../src/connectors/gitee.ts";
import {
  normalizeGitHubIssueFact
} from "../src/connectors/github.ts";
import {
  createWorkflow
} from "../src/domain/workflow.ts";
import type {
  EventJournal
} from "../src/application/taskseal-service.ts";
import type {
  ImportPlan
} from "../src/application/import-plan.ts";

const GITEE_ISSUE = {
  id: 2_614,
  number: "I4",
  title: "Git push crashes",
  htmlUrl: "https://gitee.com/oschina/git-osc/issues/I4",
  createdAt: "2013-04-12T12:15:08+08:00",
  updatedAt: "2022-07-22T05:01:31+08:00",
  repository: "oschina/git-osc"
};

test("Gitee display snapshot cannot enter import preview", () => {
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
        importPolicy
      }),
    hasCode("SNAPSHOT_PROVIDER_NOT_IMPORTABLE")
  );
  assert.equal(policyReads, 0);
});

test("a forged Gitee import plan is rejected before policy or journal access", async () => {
  const valid = createGitHubPlan();
  const forged = structuredClone(valid) as unknown as
    Record<string, unknown>;
  const policyBinding = readRecord(
    forged,
    "policyBinding"
  );
  policyBinding.provider = "gitee";
  policyBinding.scopeRef = {
    kind: "repository",
    key: "gitee:repository:oschina/git-osc"
  };

  let policyCalls = 0;
  const journal = new CountingJournal();
  const service = await TaskSealService.open({
    journal,
    importPolicyProvider: () => {
      policyCalls += 1;
      return createGitHubImportPolicy();
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
  assert.deepEqual(service.getWorkflow(), createWorkflow());
});

test("a Gitee rich candidate cannot bypass import through direct append", async () => {
  const fact = createGiteeFact();
  const journal = new CountingJournal();
  const service = await TaskSealService.open({ journal });

  await assert.rejects(
    service.append(fact.candidateEvent),
    hasCode("EVENT_PAYLOAD_INVALID")
  );
  assert.equal(journal.appendCalls, 0);
  assert.equal(journal.commitCalls, 0);
  assert.equal(service.getWorkItem("TS-GITEE-I4"), null);
  assert.equal(
    "legacy" in
      fact.candidateEvent.payload.externalLink,
    false
  );
});

function createGiteeSnapshot() {
  return {
    schemaVersion: 2,
    mode: "read-only",
    provider: "gitee",
    scope: {
      kind: "repository",
      key: "gitee:repository:oschina/git-osc"
    },
    mapping: {
      workItemId: "TS-GITEE-I4",
      requiredEvidence: ["tests"],
      managedFields: []
    },
    capturedAt: "2026-07-27T08:00:00.000Z",
    facts: [createGiteeFact()]
  };
}

function createGiteeFact() {
  return normalizeGiteeIssueFact(GITEE_ISSUE, {
    workItemId: "TS-GITEE-I4",
    requiredEvidence: ["tests"],
    managedFields: []
  });
}

function createGitHubPlan(): ImportPlan {
  const issue = {
    id: 501,
    number: 1,
    title: "Import safely",
    html_url:
      "https://github.com/netpilot-z/TaskSeal/issues/1",
    created_at: "2026-07-26T08:00:00.000Z",
    updated_at: "2026-07-26T08:01:00.000Z"
  };
  const fact = normalizeGitHubIssueFact(issue, {
    workItemId: "TS-1",
    requiredEvidence: ["tests"]
  });

  return previewSnapshotImport({
    snapshot: {
      schemaVersion: 2,
      mode: "read-only",
      provider: "github",
      scope: {
        kind: "repository",
        key: "github:repository:netpilot-z/taskseal"
      },
      mapping: {
        workItemId: "TS-1",
        requiredEvidence: ["tests"],
        managedFields: []
      },
      capturedAt: "2026-07-26T08:02:00.000Z",
      facts: [fact]
    },
    workflow: createWorkflow(),
    importPolicy: createGitHubImportPolicy()
  });
}

function createGitHubImportPolicy() {
  return {
    schemaVersion: 1,
    capabilities: {
      "snapshot.import.apply": true
    },
    allowedScopes: [
      {
        provider: "github",
        scopeRef: {
          kind: "repository",
          key:
            "github:repository:netpilot-z/taskseal"
        },
        objectTypes: ["issue"]
      }
    ]
  };
}

class CountingJournal implements EventJournal {
  appendCalls = 0;
  commitCalls = 0;

  async readAll(): Promise<unknown[]> {
    return [];
  }

  async append(): Promise<void> {
    this.appendCalls += 1;
  }

  async commitBatch(): Promise<void> {
    this.commitCalls += 1;
  }
}

function readRecord(
  value: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const property = value[key];
  if (
    property === null ||
    typeof property !== "object" ||
    Array.isArray(property)
  ) {
    throw new TypeError(`Expected ${key} to be an object.`);
  }
  return property as Record<string, unknown>;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}
