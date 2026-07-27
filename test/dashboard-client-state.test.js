import assert from "node:assert/strict";
import test from "node:test";

import {
  createAccessibleSnapshotState,
  DashboardRequestGate,
  semanticSnapshotKey,
  shouldPollDashboard
} from "../public/dashboard-state.js";

test("dashboard keeps polling until it identifies demo mode", () => {
  assert.equal(shouldPollDashboard(null, false), true);
  assert.equal(shouldPollDashboard("persistent", false), true);
  assert.equal(shouldPollDashboard("persistent", true), false);
  assert.equal(shouldPollDashboard("demo", false), false);
});

test("dashboard ignores an older response after a newer request starts", () => {
  const gate = new DashboardRequestGate();
  const older = gate.issue();
  const newer = gate.issue();

  assert.equal(gate.isLatest(older), false);
  assert.equal(gate.isLatest(newer), true);
});

test("dashboard and Provider request gates do not invalidate each other", () => {
  const dashboardGate = new DashboardRequestGate();
  const providerGate = new DashboardRequestGate();
  const dashboardSequence = dashboardGate.issue();
  const providerSequence = providerGate.issue();

  providerGate.issue();

  assert.equal(
    dashboardGate.isLatest(dashboardSequence),
    true
  );
  assert.equal(
    providerGate.isLatest(providerSequence),
    false
  );
});

test("semantic snapshot keys change only with rendered state", () => {
  const workItems = [{ id: "TS-1", status: "running" }];

  assert.equal(
    semanticSnapshotKey(workItems),
    semanticSnapshotKey([{ id: "TS-1", status: "running" }])
  );
  assert.notEqual(
    semanticSnapshotKey(workItems),
    semanticSnapshotKey([{ id: "TS-1", status: "reviewing" }])
  );
});

test("accessible snapshot state changes when evidence changes without a status change", () => {
  const baseSnapshot = {
    summary: {
      activeAgents: 0
    },
    demo: {
      currentStep: 4,
      totalSteps: 6,
      timeline: [
        {
          label: "Pull request linked",
          active: true
        }
      ]
    },
    workItems: [
      {
        id: "TS-1",
        status: "reviewing",
        requiredEvidence: ["tests"],
        activeArtifact: {
          kind: "pull_request",
          revision: "abc123"
        },
        currentEvidence: []
      }
    ]
  };
  const evidenceUpdatedSnapshot = {
    ...baseSnapshot,
    workItems: [
      {
        ...baseSnapshot.workItems[0],
        currentEvidence: [
          {
            criterionKey: "tests",
            outcome: "passed"
          }
        ]
      }
    ]
  };
  const demoUpdatedSnapshot = {
    ...baseSnapshot,
    demo: {
      ...baseSnapshot.demo,
      currentStep: 5,
      timeline: [
        {
          label: "Required tests passed",
          active: true
        }
      ]
    }
  };

  assert.notEqual(
    semanticSnapshotKey(createAccessibleSnapshotState(baseSnapshot)),
    semanticSnapshotKey(
      createAccessibleSnapshotState(evidenceUpdatedSnapshot)
    )
  );
  assert.notEqual(
    semanticSnapshotKey(createAccessibleSnapshotState(baseSnapshot)),
    semanticSnapshotKey(
      createAccessibleSnapshotState(demoUpdatedSnapshot)
    )
  );
});
