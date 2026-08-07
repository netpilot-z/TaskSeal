import assert from "node:assert/strict";
import test from "node:test";

import {
  createProjectOperationsQuery,
  collectProjectWorkItems
} from "../src/application/project-operations-query.ts";
import type { HomeSnapshot } from "../src/dashboard/home-projection.ts";

function home(projectRef: string): HomeSnapshot {
  return {
    schemaVersion: "home/v1",
    generatedAt: "2026-08-07T12:00:00.000Z",
    mode: "persistent",
    freshness: "fresh",
    project: { key: projectRef, name: projectRef.toUpperCase() },
    runtime: { maxConcurrentRuns: 1, activeCount: 0, availableSlots: 1 },
    summary: { running: 0, needsAttention: 1, nextUp: 0, verified: 0 },
    runningNow: [],
    needsAttention: [{
      ref: { projectKey: projectRef, workItemId: "TS-1" },
      name: "Review delivery evidence",
      externalIssue: null,
      status: { code: "awaiting_evidence", basis: "workflow" },
      elapsed: null,
      agentId: null,
      attemptId: null,
      deliveryGate: {
        passed: 0,
        failed: 0,
        missing: 1,
        total: 1,
        artifactPresent: false,
        factsReady: false
      },
      attention: {
        kind: "evidence_missing",
        priority: 2,
        reason: "Required evidence missing",
        since: "2026-08-07T11:00:00.000Z",
        nextAction: "补充证据",
        actionAvailable: true
      },
      nextStep: { code: "open", actionAvailable: true }
    }],
    nextUp: [],
    recentlyVerified: []
  };
}

test("project operations query keeps runtime state separate and selects a WorkItem", async () => {
  const result = await createProjectOperationsQuery({
    now: () => new Date("2026-08-07T12:01:00.000Z"),
    sources: [{
      projectRef: "alpha",
      runtime: "live",
      async read() { return home("alpha"); }
    }]
  }).snapshot({
    projectRef: "alpha",
    workItemId: "TS-1"
  });

  assert.equal(result.schemaVersion, "project-operations/v1");
  assert.deepEqual(result.runtime, {
    mode: "live",
    freshness: "fresh",
    source: "control-room"
  });
  assert.equal(result.selected?.workItem?.name, "Review delivery evidence");
});

test("project work item collection de-duplicates category projections", () => {
  const snapshot = home("alpha");
  const project = {
    projectRef: "alpha",
    availability: "fresh" as const,
    snapshot,
    errorCode: null
  };
  assert.equal(collectProjectWorkItems(project).length, 1);
});
