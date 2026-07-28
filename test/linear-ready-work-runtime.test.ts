import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, {
  type TestContext
} from "node:test";

import {
  LinearReadyWorkCoordinator
} from "../src/application/linear-ready-work.ts";
import {
  TaskSealService
} from "../src/application/taskseal-service.ts";
import {
  executeLocalLinearReadyWork
} from "../src/linear-ready-work-runtime.ts";
import {
  FileEventJournal
} from "../src/storage/event-journal.ts";

test("disabled ready-work composition performs zero network calls and leaves local fallback untouched", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  await mkdir(join(cwd, "config"), {
    recursive: true
  });
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({
      project: "TaskSeal",
      linear: {
        workspace: "netpilot-z",
        team: "netpilot",
        project: "TaskSeal",
        readyWork: {
          enabled: false,
          readyState: "Todo",
          completedState: "Done",
          dependencyIndex:
            "docs/tickets/0007-linear-bootstrap-map.json"
        }
      }
    })
  );
  let fetchCalls = 0;

  await assert.rejects(
    executeLocalLinearReadyWork(
      {
        cwd,
        mode: "list"
      },
      {
        environment: {
          LINEAR_API_KEY: "test-only-key"
        },
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error("must not fetch");
        }
      }
    ),
    hasCode("LINEAR_READY_DISABLED")
  );
  assert.equal(fetchCalls, 0);
});

test("list mode does not open or replay the local event journal", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  await mkdir(join(cwd, "config"), {
    recursive: true
  });
  await mkdir(
    join(cwd, "docs", "tickets"),
    { recursive: true }
  );
  await mkdir(join(cwd, ".taskseal"), {
    recursive: true
  });
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({
      project: "TaskSeal",
      linear: {
        workspace: "netpilot-z",
        team: "netpilot",
        project: "TaskSeal",
        readyWork: {
          enabled: true,
          readyState: "Todo",
          completedState: "Done",
          dependencyIndex:
            "docs/tickets/dependencies.json"
        }
      }
    })
  );
  await writeFile(
    join(
      cwd,
      "docs",
      "tickets",
      "dependencies.json"
    ),
    JSON.stringify({
      schemaVersion: 1,
      provider: "linear",
      target: {
        organizationId:
          "11111111-1111-4111-8111-111111111111",
        teamId:
          "22222222-2222-4222-8222-222222222222",
        projectId:
          "33333333-3333-4333-8333-333333333333",
        stateId:
          "77777777-7777-4777-8777-777777777777"
      },
      entries: [{
        sourceTicket: "T16",
        dependsOnTickets: [],
        linearIssue: {
          id:
            "66666666-6666-4666-8666-666666666666"
        }
      }],
      relations: []
    })
  );
  await writeFile(
    join(cwd, ".taskseal", "events.jsonl"),
    "{not-json}\n"
  );

  const result =
    await executeLocalLinearReadyWork(
      { cwd, mode: "list" },
      {
        environment: {
          LINEAR_API_KEY: "test-only-key"
        },
        fetchImpl: createLinearFetch()
      }
    );

  assert.deepEqual(result, {
    schemaVersion: 1,
    mode: "list",
    provider: "linear",
    mutationReady: false,
    candidates: []
  });
});

test("committed apply receipt retries before configuration, credentials, or network", async (t) => {
  const cwd = await createTemporaryDirectory(t);
  const planDigest =
    await seedCommittedLinearImport(cwd);
  let fetchCalls = 0;

  const result =
    await executeLocalLinearReadyWork(
      {
        cwd,
        mode: "apply",
        issueId:
          "66666666-6666-4666-8666-666666666666",
        workItemId: "TS-NP-5",
        requiredEvidence: ["tests"],
        expectedPlanDigest: planDigest
      },
      {
        environment: {},
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error(
            "network unavailable"
          );
        }
      }
    ) as {
      resolution: string;
      receiptReplay: boolean;
      issueId: string;
      receipt: {
        planDigest: string;
      };
    };

  assert.equal(fetchCalls, 0);
  assert.equal(
    result.resolution,
    "idempotent"
  );
  assert.equal(result.receiptReplay, true);
  assert.equal(
    result.issueId,
    "66666666-6666-4666-8666-666666666666"
  );
  assert.equal(
    result.receipt.planDigest,
    planDigest
  );
});

async function createTemporaryDirectory(
  t: TestContext
): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "taskseal-ready-runtime-")
  );
  t.after(() =>
    rm(directory, {
      recursive: true,
      force: true
    })
  );
  return directory;
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}

function createLinearFetch(): typeof fetch {
  return async (_input, init) => {
    const request = JSON.parse(
      String(init?.body)
    ) as {
      operationName: string;
    };
    const data =
      linearData(request.operationName);

    return new Response(
      JSON.stringify({ data }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  };
}

async function seedCommittedLinearImport(
  cwd: string
): Promise<string> {
  const organizationId =
    "11111111-1111-4111-8111-111111111111";
  const teamId =
    "22222222-2222-4222-8222-222222222222";
  const projectId =
    "33333333-3333-4333-8333-333333333333";
  const readyStateId =
    "44444444-4444-4444-8444-444444444444";
  const completedStateId =
    "55555555-5555-4555-8555-555555555555";
  const issueId =
    "66666666-6666-4666-8666-666666666666";
  const policy = {
    schemaVersion: 2,
    allowedScopes: [{
      provider: "linear",
      scopeRef: {
        kind: "team",
        key: `linear:team:${teamId}`,
        parentKey:
          `linear:organization:${organizationId}`
      },
      objectTypes: ["issue"],
      capabilities: {
        "snapshot.import.preview": true,
        "snapshot.import.apply": true
      }
    }]
  };
  const journal = new FileEventJournal({
    filePath: join(
      cwd,
      ".taskseal",
      "events.jsonl"
    )
  });
  const service = await TaskSealService.open({
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
    }
  });
  const coordinator =
    new LinearReadyWorkCoordinator({
      scope: {
        organizationId,
        teamId,
        teamKey: "NP",
        projectId,
        readyStateId,
        completedStateId
      },
      reader: {
        async listIssues() {
          return [{
            id: issueId,
            identifier: "NP-5",
            title: "Ready work",
            url:
              "https://linear.app/netpilot-z/issue/NP-5/ready-work",
            createdAt:
              "2026-07-28T01:00:00.000Z",
            updatedAt:
              "2026-07-28T02:00:00.000Z",
            blockedByIssueIds: [],
            dependencyCompleteness:
              "complete" as const
          }];
        },
        async readIssueStates() {
          return [];
        }
      },
      dependencyIndex: {
        target: {
          organizationId,
          teamId,
          projectId,
          stateId:
            "77777777-7777-4777-8777-777777777777"
        },
        dependenciesOf() {
          return {
            completeness: "complete",
            issueIds: []
          };
        }
      },
      workflow: service,
      imports: service,
      importPolicy: policy,
      clock: () =>
        new Date(
          "2026-07-28T03:00:00.000Z"
        )
    });
  const selection = {
    issueId,
    workItemId: "TS-NP-5",
    requiredEvidence: ["tests"]
  } as const;
  const preview =
    await coordinator.previewSelection(
      selection
    );

  assert.equal(preview.kind, "plan");
  if (preview.kind !== "plan") {
    throw new Error("expected plan");
  }

  await coordinator.applySelection({
    ...selection,
    expectedPlanDigest:
      preview.plan.planDigest,
    actor: {
      type: "human",
      id: "local-operator"
    }
  });
  return preview.plan.planDigest;
}

function linearData(
  operationName: string
): unknown {
  const organizationId =
    "11111111-1111-4111-8111-111111111111";
  const teamId =
    "22222222-2222-4222-8222-222222222222";
  const projectId =
    "33333333-3333-4333-8333-333333333333";

  if (
    operationName ===
    "TaskSealResolveBootstrapScope"
  ) {
    return {
      organization: {
        id: organizationId,
        name: "NetPilot",
        urlKey: "netpilot-z"
      },
      teams: connection([{
        id: teamId,
        name: "netpilot",
        key: "NP"
      }])
    };
  }

  if (
    operationName ===
    "TaskSealResolveBootstrapProjects"
  ) {
    return {
      projects: connection([{
        id: projectId,
        name: "TaskSeal"
      }])
    };
  }

  if (
    operationName ===
    "TaskSealResolveBootstrapProjectTeams"
  ) {
    return {
      project: {
        id: projectId,
        teams: connection([{ id: teamId }])
      }
    };
  }

  if (
    operationName ===
    "TaskSealResolveBootstrapTeamStates"
  ) {
    return {
      team: {
        id: teamId,
        states: connection([
          {
            id:
              "44444444-4444-4444-8444-444444444444",
            name: "Todo",
            type: "unstarted"
          },
          {
            id:
              "55555555-5555-4555-8555-555555555555",
            name: "Done",
            type: "completed"
          }
        ])
      }
    };
  }

  if (
    operationName ===
    "TaskSealListLinearReadyIssues"
  ) {
    return {
      organization: { id: organizationId },
      issues: connection([])
    };
  }

  throw new Error(
    "unexpected Linear operation"
  );
}

function connection(
  nodes: readonly unknown[]
): unknown {
  return {
    nodes,
    pageInfo: {
      hasNextPage: false,
      endCursor: null
    }
  };
}
