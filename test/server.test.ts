import assert from "node:assert/strict";
import { request as createHttpRequest } from "node:http";
import test from "node:test";
import type { TestContext } from "node:test";

import { loadDemoSteps } from "../src/demo/scenario.ts";
import { createTaskSealServer } from "../src/server.ts";
import type {
  PersistentServicePort,
  RunWorkItemOptions,
  TaskSealServer
} from "../src/server.ts";

interface RunCallObservation {
  workItemId: string;
  prompt: string;
  sandbox: "read-only" | "workspace-write";
  hasAbortSignal: boolean;
  hasTerminalization: boolean;
}

interface RawHttpResponse {
  statusCode: number;
  body: string;
}

type TestWorkItemStatus =
  | "planned"
  | "running"
  | "reviewing";

test("the local API exposes the workflow and can run the demo to acceptance", async (t) => {
  const steps = await loadDemoSteps();
  const server = createTaskSealServer({ steps, initialStep: 1 });
  const baseUrl = await listen(server, t);

  const pageResponse = await fetch(baseUrl);
  const page = await pageResponse.text();

  assert.equal(pageResponse.status, 200);
  assert.match(page, /TaskSeal Control Room/);
  assert.match(page, /Provider operations/);
  assert.match(
    page,
    /id="orchestration-panel"[\s\S]*aria-labelledby="orchestration-heading"/
  );
  assert.match(
    page,
    /id="orchestration-live-status"[\s\S]*role="status"/
  );
  assert.match(
    page,
    /id="orchestration-retirements"/
  );
  assert.match(
    page,
    /id="orchestration-retirement-count"/
  );
  assert.match(page, /id="work-item-select"/);
  assert.match(page, /id="codex-cancel-button"/);
  assert.match(
    page,
    /id="acceptance-accept-button"/
  );
  assert.match(
    page,
    /id="acceptance-linear-status"/
  );
  assert.match(
    page,
    /id="acceptance-audit"/
  );
  assert.match(
    page,
    /id="acceptance-reason"[\s\S]*required[\s\S]*aria-required="true"[\s\S]*aria-describedby="acceptance-reason-help"/
  );
  assert.match(
    page,
    /id="acceptance-reason-help"/
  );

  const providerStateResponse = await fetch(
    `${baseUrl}/provider-state.js`
  );
  assert.equal(providerStateResponse.status, 200);
  assert.match(
    providerStateResponse.headers.get("content-type") ?? "",
    /text\/javascript/
  );
  assert.match(
    await providerStateResponse.text(),
    /createProviderPanelModel/
  );
  const appResponse = await fetch(
    `${baseUrl}/app.js`
  );
  const appSource =
    await appResponse.text();
  assert.equal(appResponse.status, 200);
  assert.match(
    appSource,
    /crypto\.randomUUID/
  );
  assert.match(
    appSource,
    /refreshAcceptanceTruth/
  );
  assert.match(
    appSource,
    /api\/provider-operations/
  );
  assert.match(
    appSource,
    /api\/decompositions/
  );

  const initialResponse = await fetch(`${baseUrl}/api/dashboard`);
  const initial: unknown = await initialResponse.json();

  assert.equal(initialResponse.status, 200);
  assert.equal(
    readJsonPath(initial, "workItems", 0, "status"),
    "planned"
  );

  const runResponse = await fetch(`${baseUrl}/api/demo/run-all`, {
    method: "POST"
  });
  const completed: unknown = await runResponse.json();

  assert.equal(runResponse.status, 200);
  assert.equal(
    readJsonPath(completed, "workItems", 0, "status"),
    "accepted"
  );
  assert.equal(
    readJsonPath(completed, "demo", "currentStep"),
    steps.length
  );
});

test("a failed demo step does not commit partial server state", async (t) => {
  const steps = await loadDemoSteps();
  const firstStep = steps[0];
  const thirdStep = steps[2];
  assert.ok(firstStep);
  assert.ok(thirdStep);
  const invalidSteps = [firstStep, thirdStep];
  const server = createTaskSealServer({
    steps: invalidSteps,
    initialStep: 1
  });
  const baseUrl = await listen(server, t);
  const failedResponse = await fetch(`${baseUrl}/api/demo/next`, {
    method: "POST"
  });
  const dashboardResponse = await fetch(`${baseUrl}/api/dashboard`);
  const dashboard: unknown = await dashboardResponse.json();

  assert.equal(failedResponse.status, 422);
  assert.equal(dashboardResponse.status, 200);
  assert.equal(readJsonPath(dashboard, "demo", "currentStep"), 1);
  assert.equal(
    readJsonPath(dashboard, "workItems", 0, "status"),
    "planned"
  );
});

test("persistent API exposes journal state and runs one work item asynchronously", async (t) => {
  let status: TestWorkItemStatus = "planned";
  let releaseRun = (): void => {};
  const runGate = new Promise<void>((resolve) => {
    releaseRun = () => resolve();
  });
  const calls: RunCallObservation[] = [];
  const service = createPersistentService(() => status);
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: async ({
      signal,
      terminalization,
      ...options
    }) => {
      calls.push({
        ...options,
        hasAbortSignal: signal instanceof AbortSignal,
        hasTerminalization:
          typeof terminalization.begin === "function"
      });
      status = "running";
      await runGate;
      status = "reviewing";
    }
  });

  const baseUrl = await listen(server, t);
  const initialResponse = await fetch(`${baseUrl}/api/dashboard`);
  const initial: unknown = await initialResponse.json();
  const csrfToken = readJsonString(
    initial,
    "security",
    "csrfToken"
  );

  assert.equal(initialResponse.status, 200);
  assert.equal(readJsonPath(initial, "mode"), "persistent");
  assert.equal(
    readJsonPath(initial, "capabilities", "runAttempt"),
    true
  );
  assert.equal(
    readJsonPath(initial, "workItems", 0, "status"),
    "planned"
  );
  assert.equal(readJsonPath(initial, "demo"), undefined);

  const runResponse = await fetch(`${baseUrl}/api/work-items/TS-1/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-taskseal-csrf-token": csrfToken
    },
    body: JSON.stringify({
      prompt: "Inspect the local work item.",
      readOnly: true
    })
  });
  const accepted: unknown = await runResponse.json();

  assert.equal(runResponse.status, 202);
  assert.equal(
    readJsonStringArray(
      accepted,
      "runtime",
      "activeWorkItemIds"
    ).includes("TS-1"),
    true
  );
  assert.deepEqual(calls, [
    {
      workItemId: "TS-1",
      prompt: "Inspect the local work item.",
      sandbox: "read-only",
      hasAbortSignal: true,
      hasTerminalization: true
    }
  ]);

  const duplicateResponse = await fetch(
    `${baseUrl}/api/work-items/TS-1/run`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-taskseal-csrf-token": csrfToken
      },
      body: JSON.stringify({ prompt: "Do not start twice." })
    }
  );
  assert.equal(duplicateResponse.status, 409);

  releaseRun();
  await waitFor(() => status === "reviewing");

  const completedResponse = await fetch(`${baseUrl}/api/dashboard`);
  const completed: unknown = await completedResponse.json();

  assert.equal(
    readJsonPath(completed, "workItems", 0, "status"),
    "reviewing"
  );
  assert.deepEqual(
    readJsonStringArray(
      completed,
      "runtime",
      "activeWorkItemIds"
    ),
    []
  );
});

test("persistent decomposition API previews, approves, dispatches, and blocks manual bypass", async (t) => {
  const planDigest =
    `sha256:${"9".repeat(64)}`;
  const draft = {
    planId: "PLAN-1"
  };
  const previewCalls: unknown[] = [];
  const approvalCalls: unknown[] = [];
  const dispatchCalls: unknown[] = [];
  const retirementCalls: unknown[] = [];
  let directRetirementCalls = 0;
  let activePlan = true;
  const retirementAudit: Array<{
    recordType: "decomposition.retired";
    schemaVersion: "1";
    planId: string;
    planDigest: string;
    retiredBy: string;
    retiredAt: string;
    reasonCode: "operator_rollback";
    note: string;
  }> = [];
  const runCalls: RunCallObservation[] = [];
  const orchestration = {
    planId: "PLAN-1",
    planDigest,
    rootWorkItemId: "ROOT-1",
    approvedBy: "operator.test",
    approvedAt: "2026-07-28T00:00:00.000Z",
    progress: {
      basis: "accepted-nodes",
      acceptedNodes: 0,
      totalNodes: 1,
      uncertainNodes: 1
    },
    countsByPhase: {
      unknown: 0,
      waiting_dependencies: 0,
      ready: 1,
      running: 0,
      awaiting_artifact: 0,
      awaiting_evidence: 0,
      awaiting_acceptance: 0,
      retry_backoff: 0,
      blocked: 0,
      accepted: 0
    },
    queue: {
      durability: "ephemeral",
      limit: 4,
      queuedCount: 1,
      nodeIds: ["NODE-1"]
    },
    topologicalOrder: ["NODE-1"],
    dispatch: {
      maxParallelism: 1
    },
    activeNodeIds: [],
    nodes: [
      {
        nodeId: "NODE-1",
        workItemId: "TS-1",
        phase: "ready",
        dependsOn: [],
        owner: {
          runnerId: "codex-app-server",
          profileRevision: planDigest,
          match: "matched"
        },
        actualAgentId: null,
        blockingReasons: [],
        retry: {
          attempts: 0,
          maxAttempts: 2,
          nextEligibleAt: null
        },
        evidence: {
          passed: 0,
          failed: 0,
          missing: 1,
          total: 1
        },
        attemptTrace: []
      }
    ]
  } as const;
  const decomposition = {
    capabilities: {
      preview: true,
      approve: true,
      dispatch: true,
      retire: true
    },
    preview(value: unknown) {
      previewCalls.push(value);
      return {
        planDigest,
        plan: value
      };
    },
    async approve(value: unknown) {
      approvalCalls.push(value);
      return {
        resolution: "committed",
        record: orchestration
      };
    },
    async retire() {
      directRetirementCalls += 1;
      return {};
    },
    listRetirements() {
      return retirementAudit;
    },
    assertManualRunAllowed() {},
    assertAcceptanceAllowed() {},
    createDispatcher({
      attemptRuns,
      execute
    }: {
      attemptRuns: {
        start(input: {
          workItemId: string;
          execute(options: {
            signal: AbortSignal;
            terminalization: RunWorkItemOptions["terminalization"];
          }): unknown;
        }): {
          execution: Promise<unknown>;
        };
      };
      execute(options: {
        workItemId: string;
        runnerId: string;
        instruction: string;
        workspaceAccess: "read-only" | "workspace-write";
        timeoutMs: number;
        signal: AbortSignal;
        terminalization: RunWorkItemOptions["terminalization"];
      }): unknown;
    }) {
      return {
        list() {
          return activePlan
            ? [orchestration]
            : [];
        },
        assertManualRunAllowed(workItemId: string) {
          if (workItemId === "TS-1") {
            throw Object.assign(
              new Error(
                "Managed WorkItems must use decomposition dispatch."
              ),
              {
                name:
                  "DecompositionDispatcherError",
                code:
                  "DECOMPOSITION_MANAGED_WORK_ITEM"
              }
            );
          }
        },
        startManualRun(input: {
          workItemId: string;
          execute(options: {
            signal: AbortSignal;
            terminalization: RunWorkItemOptions["terminalization"];
          }): unknown;
        }) {
          this.assertManualRunAllowed(
            input.workItemId
          );
          return attemptRuns.start(
            input
          );
        },
        async decideAcceptanceOnce<T>(
          input: {
            decide: () =>
              T | Promise<T>;
          }
        ) {
          return await input.decide();
        },
        dispatchOnce(value: unknown) {
          dispatchCalls.push(value);
          const run = attemptRuns.start({
            workItemId: "TS-1",
            execute: ({
              signal,
              terminalization
            }) =>
              execute({
                workItemId: "TS-1",
                runnerId:
                  "codex-app-server",
                instruction:
                  "Implement the approved node.",
                workspaceAccess:
                  "workspace-write",
                timeoutMs: 120_000,
                signal,
                terminalization
              })
          });
          void run.execution.catch(() => {});
          return {
            startedNodeIds: ["NODE-1"],
            queuedNodeIds: [],
            projection: orchestration
          };
        },
        retireOnce(value: {
          planId: string;
          expectedPlanDigest: string;
          reasonCode:
            "operator_rollback";
          note: string;
        }) {
          retirementCalls.push(value);
          const existing =
            retirementAudit[0];
          if (existing) {
            return {
              resolution:
                "idempotent",
              record: existing
            };
          }
          const record = {
            recordType:
              "decomposition.retired" as const,
            schemaVersion:
              "1" as const,
            planId: value.planId,
            planDigest:
              value.expectedPlanDigest,
            retiredBy:
              "operator.test",
            retiredAt:
              "2026-07-28T00:05:00.000Z",
            reasonCode:
              value.reasonCode,
            note: value.note
          };
          activePlan = false;
          retirementAudit.push(record);
          return {
            resolution: "committed",
            record
          };
        }
      };
    }
  };
  const server = createTaskSealServer({
    service:
      createPersistentService(
        () => "planned",
        ["ROOT-1", "TS-1"]
      ),
    providerStatus: createProviderStatus(),
    runWorkItem: async ({
      signal,
      terminalization,
      ...options
    }) => {
      runCalls.push({
        ...options,
        hasAbortSignal:
          signal instanceof AbortSignal,
        hasTerminalization:
          typeof terminalization.begin ===
          "function"
      });
    },
    ...({ decomposition } as object)
  });
  const baseUrl = await listen(server, t);
  const initial: unknown = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const csrfToken = readJsonString(
    initial,
    "security",
    "csrfToken"
  );
  const headers = {
    "content-type": "application/json",
    "x-taskseal-csrf-token": csrfToken
  };

  assert.equal(
    readJsonPath(
      initial,
      "capabilities",
      "previewDecomposition"
    ),
    true
  );
  assert.equal(
    readJsonPath(
      initial,
      "capabilities",
      "approveDecomposition"
    ),
    true
  );
  assert.equal(
    readJsonPath(
      initial,
      "orchestration",
      0,
      "progress",
      "basis"
    ),
    "accepted-nodes"
  );

  const unauthorized = await fetch(
    `${baseUrl}/api/decompositions/preview`,
    {
      method: "POST",
      headers: {
        "content-type":
          "application/json"
      },
      body: JSON.stringify({ draft })
    }
  );
  assert.equal(unauthorized.status, 403);

  const preview = await fetch(
    `${baseUrl}/api/decompositions/preview`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ draft })
    }
  );
  assert.equal(preview.status, 200);
  assert.deepEqual(previewCalls, [draft]);

  const injectedActor = await fetch(
    `${baseUrl}/api/decompositions/approve`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        draft,
        expectedPlanDigest: planDigest,
        approvedBy: "attacker"
      })
    }
  );
  assert.equal(injectedActor.status, 400);
  assert.deepEqual(approvalCalls, []);

  const approval = await fetch(
    `${baseUrl}/api/decompositions/approve`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        draft,
        expectedPlanDigest: planDigest
      })
    }
  );
  assert.equal(approval.status, 200);
  assert.deepEqual(approvalCalls, [
    {
      draft,
      expectedPlanDigest: planDigest
    }
  ]);

  const dispatch = await fetch(
    `${baseUrl}/api/decompositions/PLAN-1/dispatch`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedPlanDigest: planDigest
      })
    }
  );
  assert.equal(dispatch.status, 202);
  assert.deepEqual(dispatchCalls, [
    {
      planId: "PLAN-1",
      expectedPlanDigest: planDigest
    }
  ]);
  assert.deepEqual(runCalls, [
    {
      workItemId: "TS-1",
      runnerId:
        "codex-app-server",
      prompt:
        "Implement the approved node.",
      sandbox: "workspace-write",
      timeoutMs: 120_000,
      hasAbortSignal: true,
      hasTerminalization: true
    }
  ]);

  const bypass = await fetch(
    `${baseUrl}/api/work-items/TS-1/run`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "Bypass the plan."
      })
    }
  );
  const bypassFailure: unknown =
    await bypass.json();
  assert.equal(bypass.status, 409);
  assert.equal(
    readJsonPath(
      bypassFailure,
      "error"
    ),
    "DECOMPOSITION_MANAGED_WORK_ITEM"
  );
  assert.equal(runCalls.length, 1);

  const injectedRetirementActor =
    await fetch(
      `${baseUrl}/api/decompositions/PLAN-1/retire`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          expectedPlanDigest:
            planDigest,
          reasonCode:
            "operator_rollback",
          note:
            "Return to the reviewed serial workflow.",
          retiredBy: "attacker"
        })
      }
    );
  assert.equal(
    injectedRetirementActor.status,
    400
  );
  assert.deepEqual(
    retirementCalls,
    []
  );

  const retirement = await fetch(
    `${baseUrl}/api/decompositions/PLAN-1/retire`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedPlanDigest: planDigest,
        reasonCode:
          "operator_rollback",
        note:
          "Return to the reviewed serial workflow."
      })
    }
  );
  assert.equal(retirement.status, 200);
  assert.equal(
    readJsonPath(
      await retirement.json(),
      "resolution"
    ),
    "committed"
  );

  const retirementRetry =
    await fetch(
      `${baseUrl}/api/decompositions/PLAN-1/retire`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          expectedPlanDigest:
            planDigest,
          reasonCode:
            "operator_rollback",
          note:
            "Return to the reviewed serial workflow."
        })
      }
    );
  assert.equal(
    retirementRetry.status,
    200
  );
  assert.equal(
    readJsonPath(
      await retirementRetry.json(),
      "resolution"
    ),
    "idempotent"
  );
  assert.equal(
    directRetirementCalls,
    0
  );
  assert.equal(
    retirementCalls.length,
    2
  );

  const retiredDashboard: unknown =
    await (
      await fetch(
        `${baseUrl}/api/dashboard`
      )
    ).json();
  assert.deepEqual(
    readJsonPath(
      retiredDashboard,
      "orchestration"
    ),
    []
  );
  assert.equal(
    readJsonPath(
      retiredDashboard,
      "decompositionRetirements",
      0,
      "retiredBy"
    ),
    "operator.test"
  );
});

test("decomposition approval maps stale state to conflict and storage failure to a safe outage", async (t) => {
  const decomposition = {
    capabilities: {
      preview: true,
      approve: true,
      dispatch: true,
      retire: true
    },
    preview() {
      return {};
    },
    async approve(input: {
      draft: {
        failure: string;
      };
    }) {
      const code =
        input.draft.failure ===
          "stale"
          ? "DECOMPOSITION_APPROVAL_STALE"
          : "DECOMPOSITION_JOURNAL_WRITE_FAILED";
      throw Object.assign(
        new Error(
          "raw storage detail must not leak"
        ),
        {
          name:
            "DecompositionPlanJournalError",
          code
        }
      );
    },
    listRetirements() {
      return [];
    },
    assertManualRunAllowed() {},
    assertAcceptanceAllowed() {},
    createDispatcher() {
      return {
        list() {
          return [];
        },
        dispatchOnce() {
          return {};
        },
        retireOnce() {
          return {};
        },
        assertManualRunAllowed() {},
        startManualRun() {
          throw new Error(
            "not called"
          );
        },
        async decideAcceptanceOnce<T>(
          input: {
            decide: () =>
              T | Promise<T>;
          }
        ) {
          return await input.decide();
        }
      };
    }
  };
  const server = createTaskSealServer({
    service:
      createPersistentService(
        () => "planned"
      ),
    providerStatus:
      createProviderStatus(),
    runWorkItem: async () => {},
    ...({ decomposition } as object)
  });
  const baseUrl = await listen(
    server,
    t
  );
  const dashboard: unknown =
    await (
      await fetch(
        `${baseUrl}/api/dashboard`
      )
    ).json();
  const headers = {
    "content-type":
      "application/json",
    "x-taskseal-csrf-token":
      readJsonString(
        dashboard,
        "security",
        "csrfToken"
      )
  };

  const stale = await fetch(
    `${baseUrl}/api/decompositions/approve`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        draft: {
          failure: "stale"
        },
        expectedPlanDigest:
          `sha256:${"1".repeat(64)}`
      })
    }
  );
  const staleBody: unknown =
    await stale.json();
  assert.equal(stale.status, 409);
  assert.equal(
    readJsonPath(
      staleBody,
      "error"
    ),
    "DECOMPOSITION_APPROVAL_STALE"
  );

  const writeFailure = await fetch(
    `${baseUrl}/api/decompositions/approve`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        draft: {
          failure: "write"
        },
        expectedPlanDigest:
          `sha256:${"2".repeat(64)}`
      })
    }
  );
  const failureBody: unknown =
    await writeFailure.json();
  assert.equal(
    writeFailure.status,
    503
  );
  assert.equal(
    readJsonPath(
      failureBody,
      "error"
    ),
    "DECOMPOSITION_JOURNAL_WRITE_FAILED"
  );
  assert.doesNotMatch(
    JSON.stringify(failureBody),
    /raw storage detail/
  );
});

test("persistent acceptance cannot accept a decomposition root before all nodes are accepted", async (t) => {
  let decisions = 0;
  const decomposition = {
    capabilities: {
      preview: true,
      approve: true,
      dispatch: true,
      retire: true
    },
    preview() {
      return {};
    },
    async approve() {
      return {};
    },
    async retire() {
      return {};
    },
    listRetirements() {
      return [];
    },
    assertManualRunAllowed() {},
    assertAcceptanceAllowed(
      workItemId: string
    ) {
      if (workItemId === "ROOT-1") {
        throw Object.assign(
          new Error(
            "The decomposition root is not ready."
          ),
          {
            name:
              "DecompositionDispatcherError",
            code:
              "DECOMPOSITION_ROOT_NOT_READY"
          }
        );
      }
    },
    createDispatcher() {
      return {
        list() {
          return [];
        },
        async decideAcceptanceOnce<T>(
          input: {
            workItemId: string;
            decision:
              | "accepted"
              | "rejected";
            decide: () =>
              T | Promise<T>;
          }
        ) {
          decomposition
            .assertAcceptanceAllowed(
              input.workItemId
            );
          return await input.decide();
        },
        dispatchOnce() {
          return {};
        },
        assertManualRunAllowed() {}
      };
    }
  };
  const server = createTaskSealServer({
    service:
      createPersistentService(
        () => "reviewing",
        ["ROOT-1", "TS-1"]
      ),
    providerStatus:
      createProviderStatus(),
    acceptance: {
      async decide() {
        decisions += 1;
        return {} as never;
      },
      async reconcile() {
        return {
          status: "disabled"
        } as never;
      }
    },
    acceptanceCapabilities: {
      decideAcceptance: true,
      linearTransition: false,
      reconcileLinearTransition:
        false
    },
    operatorId: "operator.test",
    runWorkItem: async () => {},
    ...({ decomposition } as object)
  });
  const baseUrl = await listen(server, t);
  const dashboard: unknown = await (
    await fetch(
      `${baseUrl}/api/dashboard`
    )
  ).json();
  const response = await fetch(
    `${baseUrl}/api/work-items/ROOT-1/acceptance`,
    {
      method: "POST",
      headers: {
        "content-type":
          "application/json",
        "x-taskseal-csrf-token":
          readJsonString(
            dashboard,
            "security",
            "csrfToken"
          )
      },
      body: JSON.stringify({
        decisionId:
          "00000000-0000-4000-8000-000000000009",
        decision: "accepted",
        reason:
          "Do not accept before the graph completes.",
        expectedReviewRevision:
          `sha256:${"0".repeat(64)}`
      })
    }
  );

  assert.equal(response.status, 409);
  assert.equal(decisions, 0);
});

test("persistent acceptance uses a server-owned capability and exposes local and Linear truth separately", async (t) => {
  const decisions: unknown[] = [];
  const reconciliations: unknown[] = [];
  const operationKey =
    `sha256:${"3".repeat(64)}`;
  const server = createTaskSealServer({
    service:
      createPersistentService(
        () => "reviewing"
      ),
    providerStatus:
      createProviderStatus(),
    acceptance: {
      async decide(input) {
        decisions.push(input);
        return {
          local: {
            resolution: "committed",
            workItemId: "TS-1",
            eventId:
              "taskseal:acceptance:00000000-0000-4000-8000-000000000001",
            acceptanceDigest:
              `sha256:${"2".repeat(64)}`,
            decision: {
              decision: "accepted",
              actor:
                "operator.jeffrey",
              reason:
                "Evidence reviewed.",
              decidedAt:
                "2026-07-28T00:00:00.000Z",
              basis: {
                decisionId:
                  "00000000-0000-4000-8000-000000000001",
                reviewRevision:
                  `sha256:${"1".repeat(64)}`,
                attemptId: "attempt-1",
                artifactId: "artifact-1",
                artifactRevision:
                  "revision-1"
              }
            }
          },
          linearSync: {
            status: "sync_failed",
            diagnosticCode:
              "LINEAR_TRANSITION_PRECONDITION_STALE"
          }
        };
      },
      async reconcile(input) {
        reconciliations.push(input);
        return {
          status: "reconciled",
          operationKey,
          version: 6,
          diagnosticCode: null
        };
      }
    },
    acceptanceCapabilities: {
      decideAcceptance: true,
      linearTransition: true,
      reconcileLinearTransition: true
    },
    operatorId: "operator.jeffrey",
    runWorkItem: async () => {}
  });
  const baseUrl = await listen(server, t);
  const dashboardResponse = await fetch(
    `${baseUrl}/api/dashboard`
  );
  const dashboard: unknown =
    await dashboardResponse.json();
  const csrfToken = readJsonString(
    dashboard,
    "security",
    "csrfToken"
  );

  assert.equal(
    readJsonPath(
      dashboard,
      "capabilities",
      "decideAcceptance"
    ),
    true
  );
  assert.equal(
    readJsonPath(
      dashboard,
      "capabilities",
      "linearTransition"
    ),
    true
  );
  assert.equal(
    readJsonPath(
      dashboard,
      "security",
      "operatorId"
    ),
    "operator.jeffrey"
  );

  const response = await fetch(
    `${baseUrl}/api/work-items/TS-1/acceptance`,
    {
      method: "POST",
      headers: {
        "content-type":
          "application/json",
        "x-taskseal-csrf-token":
          csrfToken
      },
      body: JSON.stringify({
        decisionId:
          "00000000-0000-4000-8000-000000000001",
        decision: "accepted",
        reason: "Evidence reviewed.",
        expectedReviewRevision:
          `sha256:${"1".repeat(64)}`
      })
    }
  );
  const result: unknown =
    await response.json();

  assert.equal(response.status, 200);
  assert.equal(
    readJsonPath(
      result,
      "local",
      "decision",
      "decision"
    ),
    "accepted"
  );
  assert.equal(
    readJsonPath(
      result,
      "linearSync",
      "status"
    ),
    "sync_failed"
  );
  assert.deepEqual(decisions, [{
    workItemId: "TS-1",
    decisionId:
      "00000000-0000-4000-8000-000000000001",
    decision: "accepted",
    reason: "Evidence reviewed.",
    expectedReviewRevision:
      `sha256:${"1".repeat(64)}`
  }]);

  const reconcileResponse = await fetch(
    `${baseUrl}/api/provider-operations/${encodeURIComponent(
      operationKey
    )}/reconcile`,
    {
      method: "POST",
      headers: {
        "content-type":
          "application/json",
        "x-taskseal-csrf-token":
          csrfToken
      },
      body: "{}"
    }
  );
  assert.equal(
    reconcileResponse.status,
    200
  );
  assert.deepEqual(reconciliations, [{
    operationKey
  }]);
});

test("persistent acceptance rejects browser actor injection, stale reviews, and disabled capability", async (t) => {
  let decideCalls = 0;
  const createServer = (
    enabled: boolean
  ) =>
    createTaskSealServer({
      service:
        createPersistentService(
          () => "reviewing"
        ),
      providerStatus:
        createProviderStatus(),
      acceptance: enabled
        ? {
            async decide() {
              decideCalls += 1;
              throw Object.assign(
                new Error("stale"),
                {
                  name: "DomainError",
                  code:
                    "ACCEPTANCE_REVIEW_STALE"
                }
              );
            },
            async reconcile() {
              return {
                status:
                  "outcome_unknown" as const,
                operationKey:
                  `sha256:${"3".repeat(64)}`,
                version: 1,
                diagnosticCode:
                  "LINEAR_WRITE_OUTCOME_UNKNOWN" as const
              };
            }
          }
        : null,
      acceptanceCapabilities: {
        decideAcceptance: enabled,
        linearTransition: enabled,
        reconcileLinearTransition:
          enabled
      },
      operatorId:
        enabled
          ? "operator.jeffrey"
          : null,
      runWorkItem: async () => {}
    });

  const enabledServer =
    createServer(true);
  const enabledBase = await listen(
    enabledServer,
    t
  );
  const dashboard: unknown =
    await (
      await fetch(
        `${enabledBase}/api/dashboard`
      )
    ).json();
  const csrfToken = readJsonString(
    dashboard,
    "security",
    "csrfToken"
  );
  const body = {
    decisionId:
      "00000000-0000-4000-8000-000000000001",
    decision: "accepted",
    reason: "Evidence reviewed.",
    expectedReviewRevision:
      `sha256:${"1".repeat(64)}`
  };
  const injected = await fetch(
    `${enabledBase}/api/work-items/TS-1/acceptance`,
    {
      method: "POST",
      headers: {
        "content-type":
          "application/json",
        "x-taskseal-csrf-token":
          csrfToken
      },
      body: JSON.stringify({
        ...body,
        actor: "browser.attacker"
      })
    }
  );
  assert.equal(injected.status, 400);
  assert.equal(decideCalls, 0);

  const stale = await fetch(
    `${enabledBase}/api/work-items/TS-1/acceptance`,
    {
      method: "POST",
      headers: {
        "content-type":
          "application/json",
        "x-taskseal-csrf-token":
          csrfToken
      },
      body: JSON.stringify(body)
    }
  );
  assert.equal(stale.status, 409);

  const disabledServer =
    createServer(false);
  const disabledBase = await listen(
    disabledServer,
    t
  );
  const disabledDashboard: unknown =
    await (
      await fetch(
        `${disabledBase}/api/dashboard`
      )
    ).json();
  const disabledToken = readJsonString(
    disabledDashboard,
    "security",
    "csrfToken"
  );
  const disabled = await fetch(
    `${disabledBase}/api/work-items/TS-1/acceptance`,
    {
      method: "POST",
      headers: {
        "content-type":
          "application/json",
        "x-taskseal-csrf-token":
          disabledToken
      },
      body: JSON.stringify(body)
    }
  );
  assert.equal(disabled.status, 403);
});

test("persistent health exposes a fenced service and requires reopen", async (t) => {
  const service = {
    ...createPersistentService(() => "planned"),
    getHealth() {
      return {
        status: "fenced",
        code: "IMPORT_COMMIT_OUTCOME_UNKNOWN",
        planDigest: `sha256:${"a".repeat(64)}`
      };
    }
  };
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: async () => {}
  });
  const baseUrl = await listen(server, t);

  const response = await fetch(`${baseUrl}/health`);

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    status: "fenced",
    code: "IMPORT_COMMIT_OUTCOME_UNKNOWN",
    planDigest: `sha256:${"a".repeat(64)}`
  });
});

test("persistent health keeps the established ok response while ready", async (t) => {
  const service = {
    ...createPersistentService(() => "planned"),
    getHealth() {
      return { status: "ready" };
    }
  };
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: async () => {}
  });
  const baseUrl = await listen(server, t);

  const response = await fetch(`${baseUrl}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok"
  });
});

test("persistent health reports a fenced decomposition journal", async (t) => {
  const decomposition = {
    capabilities: {
      preview: true,
      approve: true,
      dispatch: true,
      retire: true
    },
    preview() {
      return {};
    },
    async approve() {
      return {};
    },
    async retire() {
      return {};
    },
    listRetirements() {
      return [];
    },
    assertManualRunAllowed() {},
    assertAcceptanceAllowed() {},
    getHealth() {
      return {
        status: "fenced",
        code:
          "DECOMPOSITION_COMMIT_OUTCOME_UNKNOWN"
      };
    },
    createDispatcher() {
      return {
        list() {
          return [];
        },
        dispatchOnce() {
          return {};
        },
        assertManualRunAllowed() {}
      };
    }
  };
  const server = createTaskSealServer({
    service:
      createPersistentService(
        () => "planned"
      ),
    providerStatus:
      createProviderStatus(),
    runWorkItem: async () => {},
    ...({ decomposition } as object)
  });
  const baseUrl = await listen(server, t);
  const response = await fetch(
    `${baseUrl}/health`
  );
  const body: unknown =
    await response.json();

  assert.equal(response.status, 503);
  assert.equal(
    readJsonPath(body, "status"),
    "fenced"
  );
  assert.equal(
    readJsonPath(body, "code"),
    "DECOMPOSITION_COMMIT_OUTCOME_UNKNOWN"
  );
});

test("persistent dashboard preserves a safe service reopen error", async (t) => {
  const service = {
    ...createPersistentService(() => "planned"),
    snapshot() {
      throw createServiceReopenError();
    }
  };
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: async () => {}
  });
  const baseUrl = await listen(server, t);

  const response = await fetch(`${baseUrl}/api/dashboard`);
  const body: unknown = await response.json();

  assert.deepEqual(body, {
    error: "SERVICE_REOPEN_REQUIRED",
    message: "TaskSeal service must be reopened before requests can continue."
  });
  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(body).includes("must-not-be-returned-secret"), false);
});

test("persistent run preserves a safe service reopen error", async (t) => {
  const service = {
    ...createPersistentService(() => "planned"),
    getWorkItem() {
      throw createServiceReopenError();
    }
  };
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: async () => {}
  });
  const baseUrl = await listen(server, t);
  const dashboard: unknown = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const csrfToken = readJsonString(
    dashboard,
    "security",
    "csrfToken"
  );

  const response = await fetch(
    `${baseUrl}/api/work-items/TS-1/run`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-taskseal-csrf-token": csrfToken
      },
      body: JSON.stringify({ prompt: "Do not expose the service error." })
    }
  );
  const body: unknown = await response.json();

  assert.deepEqual(body, {
    error: "SERVICE_REOPEN_REQUIRED",
    message: "TaskSeal service must be reopened before requests can continue."
  });
  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(body).includes("must-not-be-returned-secret"), false);
});

test("persistent run endpoint validates work item and request body", async (t) => {
  const service = createPersistentService(() => "planned");
  let invoked = false;
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: async () => {
      invoked = true;
    }
  });
  const baseUrl = await listen(server, t);
  const dashboard = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();

  const missingResponse = await fetch(
    `${baseUrl}/api/work-items/TS-404/run`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-taskseal-csrf-token": dashboard.security.csrfToken
      },
      body: JSON.stringify({ prompt: "Missing work." })
    }
  );
  const invalidResponse = await fetch(
    `${baseUrl}/api/work-items/TS-1/run`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-taskseal-csrf-token": dashboard.security.csrfToken
      },
      body: JSON.stringify({ prompt: "" })
    }
  );

  assert.equal(missingResponse.status, 404);
  assert.equal(invalidResponse.status, 400);
  assert.equal(invoked, false);
});

test("persistent run endpoint rejects cross-site and non-JSON requests", async (t) => {
  const service = createPersistentService(() => "planned");
  const calls: RunWorkItemOptions[] = [];
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: async (options) => {
      calls.push(options);
    }
  });
  const baseUrl = await listen(server, t);
  const dashboard: unknown = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const token = readJsonString(
    dashboard,
    "security",
    "csrfToken"
  );

  const textResponse = await fetch(`${baseUrl}/api/work-items/TS-1/run`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      "x-taskseal-csrf-token": token
    },
    body: JSON.stringify({ prompt: "Cross-site simple request." })
  });
  const originResponse = await fetch(
    `${baseUrl}/api/work-items/TS-1/run`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "origin": "https://attacker.invalid",
        "x-taskseal-csrf-token": token
      },
      body: JSON.stringify({ prompt: "Bad origin." })
    }
  );
  const tokenResponse = await fetch(
    `${baseUrl}/api/work-items/TS-1/run`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Missing token." })
    }
  );

  assert.equal(textResponse.status, 415);
  assert.equal(originResponse.status, 403);
  assert.equal(tokenResponse.status, 403);
  assert.equal(calls.length, 0);
});

test("persistent run endpoint fails closed on non-object JSON bodies", async (t) => {
  const service = createPersistentService(() => "planned");
  const calls: RunWorkItemOptions[] = [];
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: async (options) => {
      calls.push(options);
    }
  });
  const baseUrl = await listen(server, t);
  const dashboard: unknown = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const csrfToken = readJsonString(
    dashboard,
    "security",
    "csrfToken"
  );
  const bodies = ["null", "[]", "1", "\"prompt\""];

  const responses = await Promise.all(
    bodies.map((body) =>
      fetch(`${baseUrl}/api/work-items/TS-1/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-taskseal-csrf-token": csrfToken
        },
        body
      })
    )
  );

  assert.deepEqual(
    responses.map((response) => response.status),
    [400, 400, 400, 400]
  );
  assert.equal(calls.length, 0);
});

test("persistent run endpoint rejects missing and malformed Host headers", async (t) => {
  const service = createPersistentService(() => "planned");
  const calls: RunWorkItemOptions[] = [];
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: async (options) => {
      calls.push(options);
    }
  });
  const baseUrl = await listen(server, t);
  const dashboard: unknown = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const token = readJsonString(
    dashboard,
    "security",
    "csrfToken"
  );
  const endpoint = `${baseUrl}/api/work-items/TS-1/run`;

  const responses = await Promise.all([
    sendRawRunRequest(endpoint, token),
    sendRawRunRequest(endpoint, token, "localhost:")
  ]);

  assert.deepEqual(
    responses.map((response) => response.statusCode),
    [400, 403]
  );
  assert.equal(calls.length, 0);
});

test("persistent run reservation is atomic and defaults to read-only", async (t) => {
  const service = createPersistentService(() => "planned");
  let releaseRun = (): void => {};
  const runGate = new Promise<void>((resolve) => {
    releaseRun = () => resolve();
  });
  const calls: RunWorkItemOptions[] = [];
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: async (options) => {
      calls.push(options);
      await runGate;
    }
  });
  const baseUrl = await listen(server, t);
  const dashboard: unknown = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const csrfToken = readJsonString(
    dashboard,
    "security",
    "csrfToken"
  );
  const request = () =>
    fetch(`${baseUrl}/api/work-items/TS-1/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-taskseal-csrf-token": csrfToken
      },
      body: JSON.stringify({ prompt: "Run once." })
    });

  const responses = await Promise.all([request(), request()]);
  const statuses = responses.map((response) => response.status).sort();

  assert.deepEqual(statuses, [202, 409]);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.sandbox, "read-only");
  assert.equal(call.signal instanceof AbortSignal, true);

  releaseRun();
});

test("persistent execution control bounds unrelated work without a global item lock", async (t) => {
  const releases = new Map<string, () => void>();
  const calls: string[] = [];
  const service = createPersistentService(
    () => "running",
    ["TS-1", "TS-2", "TS-3"]
  );
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    maxConcurrentRuns: 2,
    runWorkItem: ({ workItemId }) => {
      calls.push(workItemId);
      return new Promise<void>((resolve) => {
        releases.set(workItemId, resolve);
      });
    }
  });
  const baseUrl = await listen(server, t);
  const dashboard: unknown = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const csrfToken = readJsonString(
    dashboard,
    "security",
    "csrfToken"
  );
  const dispatch = (workItemId: string) =>
    fetch(`${baseUrl}/api/work-items/${workItemId}/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-taskseal-csrf-token": csrfToken
      },
      body: JSON.stringify({
        prompt: `Run ${workItemId}.`
      })
    });

  const first = await dispatch("TS-1");
  const second = await dispatch("TS-2");
  const saturated = await dispatch("TS-3");
  const saturatedBody: unknown =
    await saturated.json();

  assert.deepEqual(
    [first.status, second.status, saturated.status],
    [202, 202, 429]
  );
  assert.equal(
    readJsonPath(saturatedBody, "error"),
    "RUN_CAPACITY_REACHED"
  );
  assert.deepEqual(calls, ["TS-1", "TS-2"]);

  const active: unknown = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  assert.deepEqual(
    readJsonPath(active, "runtime", "capacity"),
    {
      maxConcurrentRuns: 2,
      activeCount: 2,
      availableSlots: 0
    }
  );
  assert.deepEqual(
    readJsonPath(active, "runtime", "runs"),
    [
      {
        workItemId: "TS-1",
        phase: "running",
        attemptId: null,
        startedAt: readJsonPath(
          active,
          "runtime",
          "runs",
          0,
          "startedAt"
        ),
        cancelRequestedAt: null
      },
      {
        workItemId: "TS-2",
        phase: "running",
        attemptId: null,
        startedAt: readJsonPath(
          active,
          "runtime",
          "runs",
          1,
          "startedAt"
        ),
        cancelRequestedAt: null
      }
    ]
  );

  releases.get("TS-1")?.();
  await waitFor(async () => {
    const snapshot: unknown = await (
      await fetch(`${baseUrl}/api/dashboard`)
    ).json();
    return (
      readJsonPath(
        snapshot,
        "runtime",
        "capacity",
        "availableSlots"
      ) === 1
    );
  });
  const third = await dispatch("TS-3");
  assert.equal(third.status, 202);
  assert.deepEqual(calls, ["TS-1", "TS-2", "TS-3"]);

  releases.get("TS-2")?.();
  releases.get("TS-3")?.();
});

test("persistent cancel targets one work item and keeps cancellation visible until settlement", async (t) => {
  const signals = new Map<string, AbortSignal>();
  const releases = new Map<string, () => void>();
  const service = createPersistentService(
    () => "running",
    ["TS-1", "TS-2"]
  );
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    maxConcurrentRuns: 2,
    runWorkItem: ({ workItemId, signal }) => {
      signals.set(workItemId, signal);
      return new Promise<void>((resolve) => {
        releases.set(workItemId, resolve);
      });
    }
  });
  const baseUrl = await listen(server, t);
  const dashboard: unknown = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const csrfToken = readJsonString(
    dashboard,
    "security",
    "csrfToken"
  );
  const headers = {
    "content-type": "application/json",
    "x-taskseal-csrf-token": csrfToken
  };

  for (const workItemId of ["TS-1", "TS-2"]) {
    const response = await fetch(
      `${baseUrl}/api/work-items/${workItemId}/run`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: `Run ${workItemId}.`
        })
      }
    );
    assert.equal(response.status, 202);
  }

  const cancelled = await fetch(
    `${baseUrl}/api/work-items/TS-1/cancel`,
    {
      method: "POST",
      headers,
      body: "{}"
    }
  );
  const cancelling: unknown = await cancelled.json();

  assert.equal(cancelled.status, 202);
  assert.equal(signals.get("TS-1")?.aborted, true);
  assert.equal(signals.get("TS-2")?.aborted, false);
  assert.equal(
    readJsonPath(
      cancelling,
      "runtime",
      "runs",
      0,
      "phase"
    ),
    "cancelling"
  );
  assert.equal(
    readJsonPath(
      cancelling,
      "runtime",
      "capacity",
      "availableSlots"
    ),
    0
  );

  const repeated = await fetch(
    `${baseUrl}/api/work-items/TS-1/cancel`,
    {
      method: "POST",
      headers,
      body: "{}"
    }
  );
  assert.equal(repeated.status, 202);

  releases.get("TS-1")?.();
  await waitFor(async () => {
    const snapshot: unknown = await (
      await fetch(`${baseUrl}/api/dashboard`)
    ).json();
    return !readJsonStringArray(
      snapshot,
      "runtime",
      "activeWorkItemIds"
    ).includes("TS-1");
  });

  const inactive = await fetch(
    `${baseUrl}/api/work-items/TS-1/cancel`,
    {
      method: "POST",
      headers,
      body: "{}"
    }
  );
  const inactiveBody: unknown = await inactive.json();
  const settled: unknown = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();

  assert.equal(inactive.status, 409);
  assert.equal(
    readJsonPath(inactiveBody, "error"),
    "RUN_NOT_ACTIVE"
  );
  assert.deepEqual(
    readJsonPath(settled, "runtime", "errors"),
    {}
  );

  releases.get("TS-2")?.();
});

test("persistent cancel exposes a terminal persistence failure instead of swallowing it", async (t) => {
  const service = createPersistentService(() => "running");
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: ({ signal, terminalization }) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            terminalization.begin();
            reject(
              Object.assign(
                new Error("Terminal append failed."),
                { code: "JOURNAL_WRITE_FAILED" }
              )
            );
          },
          { once: true }
        );
      })
  });
  const baseUrl = await listen(server, t);
  const dashboard: unknown = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const csrfToken = readJsonString(
    dashboard,
    "security",
    "csrfToken"
  );
  const headers = {
    "content-type": "application/json",
    "x-taskseal-csrf-token": csrfToken
  };

  const run = await fetch(
    `${baseUrl}/api/work-items/TS-1/run`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "Wait for cancellation." })
    }
  );
  assert.equal(run.status, 202);

  const cancel = await fetch(
    `${baseUrl}/api/work-items/TS-1/cancel`,
    {
      method: "POST",
      headers,
      body: "{}"
    }
  );
  assert.equal(cancel.status, 202);

  await waitFor(async () => {
    const snapshot: unknown = await (
      await fetch(`${baseUrl}/api/dashboard`)
    ).json();
    return (
      readJsonPath(
        snapshot,
        "runtime",
        "errors",
        "TS-1",
        "code"
      ) === "JOURNAL_WRITE_FAILED"
    );
  });
});

test("persistent cancel uses the same JSON, origin, and CSRF boundary as run", async (t) => {
  const service = createPersistentService(() => "running");
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: async () => {}
  });
  const baseUrl = await listen(server, t);
  const dashboard: unknown = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const token = readJsonString(
    dashboard,
    "security",
    "csrfToken"
  );
  const endpoint =
    `${baseUrl}/api/work-items/TS-1/cancel`;

  const [textResponse, originResponse, tokenResponse] =
    await Promise.all([
      fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "x-taskseal-csrf-token": token
        },
        body: "{}"
      }),
      fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "origin": "https://attacker.invalid",
          "x-taskseal-csrf-token": token
        },
        body: "{}"
      }),
      fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: "{}"
      })
    ]);

  assert.deepEqual(
    [
      textResponse.status,
      originResponse.status,
      tokenResponse.status
    ],
    [415, 403, 403]
  );
});

test("server shutdown aborts active runs before closing", async (t) => {
  const service = createPersistentService(() => "running");
  let aborted = false;
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: ({ signal }) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            const error = Object.assign(
              new Error("Interrupted for shutdown."),
              { code: "CODEX_INTERRUPTED" }
            );
            reject(error);
          },
          { once: true }
        );
      })
  });
  const baseUrl = await listen(server, t);
  const dashboard: unknown = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const csrfToken = readJsonString(
    dashboard,
    "security",
    "csrfToken"
  );
  const runResponse = await fetch(
    `${baseUrl}/api/work-items/TS-1/run`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-taskseal-csrf-token": csrfToken
      },
      body: JSON.stringify({ prompt: "Wait for shutdown." })
    }
  );

  assert.equal(runResponse.status, 202);
  await server.shutdown();
  assert.equal(aborted, true);
});

test("server shutdown rejects a request stalled before run reservation", async (t) => {
  const calls: Array<
    Pick<RunWorkItemOptions, "workItemId" | "signal">
  > = [];
  let observeAbort = (): void => {};
  let releaseFirst = (): void => {};
  const abortObserved = new Promise<void>((resolve) => {
    observeAbort = () => resolve();
  });
  const firstRunGate = new Promise<void>((resolve) => {
    releaseFirst = () => resolve();
  });
  const service = createPersistentService(
    () => "running",
    ["TS-1", "TS-2"]
  );
  const server = createTaskSealServer({
    service,
    providerStatus: createProviderStatus(),
    runWorkItem: ({ workItemId, signal }) => {
      calls.push({
        workItemId,
        signal
      });

      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            observeAbort();
            firstRunGate.then(() => {
              const error = Object.assign(
                new Error("Interrupted for shutdown."),
                { code: "CODEX_INTERRUPTED" }
              );
              reject(error);
            });
          },
          { once: true }
        );
      });
    }
  });
  const baseUrl = await listen(server, t);
  const dashboard: unknown = await (
    await fetch(`${baseUrl}/api/dashboard`)
  ).json();
  const csrfToken = readJsonString(
    dashboard,
    "security",
    "csrfToken"
  );
  const headers = {
    "content-type": "application/json",
    "x-taskseal-csrf-token": csrfToken
  };
  const firstResponse = await fetch(
    `${baseUrl}/api/work-items/TS-1/run`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "Hold the first run open." })
    }
  );

  assert.equal(firstResponse.status, 202);

  let markStalledRequestReady = (): void => {};
  const stalledRequestReady = new Promise<void>((resolve) => {
    markStalledRequestReady = () => resolve();
  });
  let resolveStalledResponse = (
    _response: RawHttpResponse
  ): void => {};
  let rejectStalledResponse = (_reason?: unknown): void => {};
  const stalledResponse = new Promise<RawHttpResponse>((resolve, reject) => {
    resolveStalledResponse = resolve;
    rejectStalledResponse = reject;
  });
  const stalledRequest = createHttpRequest(
    `${baseUrl}/api/work-items/TS-2/run`,
    {
      method: "POST",
      headers: {
        ...headers,
        expect: "100-continue"
      }
    },
    (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () =>
        resolveStalledResponse({
          statusCode: response.statusCode ?? 0,
          body
        })
      );
    }
  );
  stalledRequest.on("error", rejectStalledResponse);
  stalledRequest.on("continue", () => {
    stalledRequest.write('{"prompt":"Finish after shutdown');
    markStalledRequestReady();
  });
  stalledRequest.flushHeaders();

  await stalledRequestReady;
  await new Promise<void>((resolve) =>
    setImmediate(() => resolve())
  );
  const shutdown = server.shutdown();
  await abortObserved;
  stalledRequest.end('."}');

  const rejected = await stalledResponse;
  assert.equal(rejected.statusCode, 503);
  const rejection: unknown = JSON.parse(rejected.body);
  assert.equal(
    readJsonPath(rejection, "error"),
    "SERVER_SHUTTING_DOWN"
  );
  assert.deepEqual(
    calls.map((call) => call.workItemId),
    ["TS-1"]
  );
  const firstCall = calls[0];
  assert.ok(firstCall);
  assert.equal(firstCall.signal.aborted, true);

  releaseFirst();
  await shutdown;
});

async function listen(
  server: TaskSealServer,
  t: TestContext
): Promise<string> {
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        if (!server.listening) {
          resolve();
          return;
        }

        server.close(() => resolve());
      })
  );
  const address = server.address();

  if (!address || typeof address === "string") {
    assert.fail("Expected TaskSeal to listen on a TCP port.");
  }

  return `http://127.0.0.1:${address.port}`;
}

function sendRawRunRequest(
  url: string,
  token: string,
  host?: string
): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    const headers = {
      "content-type": "application/json",
      "x-taskseal-csrf-token": token,
      ...(host === undefined ? {} : { host })
    };
    const request = createHttpRequest(
      url,
      {
        method: "POST",
        setHost: host !== undefined,
        headers
      },
      (response) => {
        response.resume();
        response.once("end", () =>
          resolve({
            statusCode: response.statusCode ?? 0
          })
        );
      }
    );
    request.once("error", reject);
    request.end(JSON.stringify({ prompt: "Do not start." }));
  });
}

function createPersistentService(
  readStatus: () => TestWorkItemStatus,
  workItemIds: readonly string[] = ["TS-1"]
): PersistentServicePort {
  return {
    getWorkItem(workItemId) {
      return workItemIds.includes(workItemId)
        ? { id: workItemId }
        : null;
    },
    snapshot() {
      const status = readStatus();
      return {
        generatedAt: new Date().toISOString(),
        summary: {
          total: workItemIds.length,
          planned:
            status === "planned" ? workItemIds.length : 0,
          running:
            status === "running" ? workItemIds.length : 0,
          reviewing:
            status === "reviewing" ? workItemIds.length : 0,
          blocked: 0,
          accepted: 0,
          activeAgents:
            status === "running" ? workItemIds.length : 0
        },
        workItems: workItemIds.map((workItemId) => ({
            id: workItemId,
            title: "Persistent work",
            status,
            progress: {
              basis:
                "acceptance-and-current-evidence",
              accepted: false,
              passedEvidence: 0,
              failedEvidence: 0,
              missingEvidence: 1,
              totalEvidence: 1,
              uncertainty:
                "incomplete"
            },
            requiredEvidence: ["tests"],
            activeAttempt: null,
            activeArtifact: null,
            currentEvidence: [],
            attempts: [],
            artifacts: [],
            evidence: [],
            acceptanceDecision: null,
            acceptanceReviewRevision:
              `sha256:${"0".repeat(64)}`,
            acceptanceHistory: [],
            externalLinks: []
          }))
      };
    }
  };
}

function createProviderStatus() {
  return {
    async list() {
      return {
        schemaVersion: 2 as const,
        revision:
          `sha256:${"0".repeat(64)}`,
        observationRevision:
          `sha256:${"1".repeat(64)}`,
        operationRevision:
          `sha256:${"2".repeat(64)}`,
        providers: [],
        operations: []
      };
    }
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await predicate()) {
      return;
    }

    await new Promise<void>((resolve) =>
      setTimeout(() => resolve(), 10)
    );
  }

  assert.fail("Timed out waiting for the persistent run to settle.");
}

function readJsonPath(
  value: unknown,
  ...path: Array<string | number>
): unknown {
  let current = value;

  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) {
        throw new TypeError("Expected a JSON array.");
      }

      const values: readonly unknown[] = current;
      current = values[segment];
      continue;
    }

    if (!isRecord(current)) {
      throw new TypeError("Expected a JSON object.");
    }

    current = current[segment];
  }

  return current;
}

function readJsonString(
  value: unknown,
  ...path: Array<string | number>
): string {
  const candidate = readJsonPath(value, ...path);

  if (typeof candidate !== "string") {
    throw new TypeError("Expected a JSON string.");
  }

  return candidate;
}

function readJsonStringArray(
  value: unknown,
  ...path: Array<string | number>
): string[] {
  const candidate = readJsonPath(value, ...path);

  if (!Array.isArray(candidate)) {
    throw new TypeError("Expected a JSON array.");
  }

  const values: string[] = [];

  for (const item of candidate) {
    if (typeof item !== "string") {
      throw new TypeError("Expected a JSON string array.");
    }

    values.push(item);
  }

  return values;
}

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function createServiceReopenError(): Error & {
  code: string;
} {
  return Object.assign(
    new Error("must-not-be-returned-secret"),
    {
      name: "TaskSealServiceError",
      code: "SERVICE_REOPEN_REQUIRED"
    }
  );
}
