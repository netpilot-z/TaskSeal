import assert from "node:assert/strict";
import test from "node:test";

import {
  loadDemoSteps,
  replayDemoSteps
} from "../src/demo/scenario.ts";
import { projectDashboard } from "../src/dashboard/projection.ts";

test("the complete fixture chain produces a reproducible accepted dashboard", async () => {
  const steps = await loadDemoSteps();
  const workflow = replayDemoSteps(steps, steps.length);
  const replayed = replayDemoSteps([...steps, ...steps], steps.length * 2);
  const dashboard = projectDashboard(workflow);

  assert.equal(steps.length, 6);
  assert.deepEqual(replayed, workflow);
  assert.deepEqual(dashboard.summary, {
    total: 1,
    planned: 0,
    running: 0,
    reviewing: 0,
    blocked: 0,
    accepted: 1,
    activeAgents: 0
  });
  const workItem = dashboard.workItems[0];
  assert.ok(workItem);
  const evidence = workItem.evidence[0];
  assert.ok(evidence);
  assert.deepEqual(
    workItem.progress,
    {
      basis:
        "acceptance-and-current-evidence",
      accepted: true,
      passedEvidence: 1,
      failedEvidence: 0,
      missingEvidence: 0,
      totalEvidence: 1,
      uncertainty: "verified"
    }
  );
  assert.equal(evidence.outcome, "passed");
});
