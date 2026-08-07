import assert from "node:assert/strict";
import test from "node:test";

import { projectHubSnapshot } from "../src/dashboard/project-hub.ts";
import type { HomeSnapshot } from "../src/dashboard/home-projection.ts";

test("project hub isolates unavailable projects and aggregates operational counts", async () => {
  const base = {
    schemaVersion: "home/v1" as const,
    generatedAt: "2026-08-07T00:00:00.000Z",
    mode: "persistent" as const,
    freshness: "fresh" as const,
    project: { key: "alpha", name: "Alpha" },
    runtime: { maxConcurrentRuns: 2, activeCount: 1, availableSlots: 1 },
    summary: { running: 1, needsAttention: 2, nextUp: 3, verified: 0 },
    runningNow: [], needsAttention: [], nextUp: [], recentlyVerified: []
  } satisfies HomeSnapshot;

  const result = await projectHubSnapshot({
    now: new Date("2026-08-07T00:01:00.000Z"),
    sources: [
      { projectRef: "alpha", async read() { return base; } },
      { projectRef: "beta", async read() { throw new Error("FENCED"); } }
    ]
  });

  assert.equal(result.schemaVersion, "project-hub/v1");
  assert.deepEqual(result.summary, { projects: 2, running: 1, needsAttention: 2, nextUp: 3 });
  assert.equal(result.projects[1]?.availability, "unavailable");
  assert.equal(result.projects[1]?.snapshot, null);
});
