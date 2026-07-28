import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, {
  type TestContext
} from "node:test";

import {
  executeLocalGitHubReconciliation
} from "../src/github-reconciliation-runtime.ts";

const LINEAR_ISSUE_ID =
  "4f3ce2c1-5415-403b-9129-698cac96d987";

test("disabled GitHub reconciliation performs zero network calls and does not require an index", async (t) => {
  const cwd =
    await createTemporaryDirectory(t);
  await writeConfiguration(cwd, {
    enabled: false,
    mappingIndex:
      "config/missing-delivery-map.json"
  });
  let fetchCalls = 0;

  await assert.rejects(
    executeLocalGitHubReconciliation(
      {
        cwd,
        mode: "preview",
        workItemId: "TS-NP-6"
      },
      {
        environment: {
          GITHUB_TOKEN:
            "test-only-token"
        },
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error(
            "must not fetch"
          );
        }
      }
    ),
    hasCode(
      "GITHUB_RECONCILE_DISABLED"
    )
  );
  assert.equal(fetchCalls, 0);
});

test("repository target drift and an absent explicit binding fail before GitHub reads", async (t) => {
  for (const scenario of [
    {
      target: "foreign/repository",
      entries: [],
      code:
        "GITHUB_RECONCILE_TARGET_MISMATCH"
    },
    {
      target: "netpilot-z/TaskSeal",
      entries: [],
      code:
        "GITHUB_DELIVERY_BINDING_NOT_FOUND"
    }
  ]) {
    const cwd =
      await createTemporaryDirectory(t);
    await writeConfiguration(cwd, {
      enabled: true,
      mappingIndex:
        "config/github-delivery-map.json"
    });
    await writeDeliveryIndex(cwd, {
      target: scenario.target,
      entries: scenario.entries
    });
    let fetchCalls = 0;

    await assert.rejects(
      executeLocalGitHubReconciliation(
        {
          cwd,
          mode: "preview",
          workItemId: "TS-NP-6"
        },
        {
          environment: {
            GITHUB_TOKEN:
              "test-only-token"
          },
          fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error(
              "must not fetch"
            );
          }
        }
      ),
      hasCode(scenario.code)
    );
    assert.equal(fetchCalls, 0);
  }
});

test("preview composes the safe index, local workflow, and read-only GitHub APIs without changing the journal", async (t) => {
  const cwd =
    await createTemporaryDirectory(t);
  await writeConfiguration(cwd, {
    enabled: true,
    mappingIndex:
      "config/github-delivery-map.json"
  });
  await writeDeliveryIndex(cwd, {
    target: "netpilot-z/TaskSeal",
    entries: [createIndexEntry()]
  });
  await writeWorkflowJournal(cwd);
  const journalPath = join(
    cwd,
    ".taskseal",
    "events.jsonl"
  );
  const before = await readFile(
    journalPath,
    "utf8"
  );
  const calls: string[] = [];

  const result =
    await executeLocalGitHubReconciliation(
      {
        cwd,
        mode: "preview",
        workItemId: "TS-NP-6"
      },
      {
        environment: {
          GITHUB_TOKEN:
            "test-only-token"
        },
        fetchImpl:
          createGitHubFetch(calls),
        clock: () =>
          new Date(
            "2026-07-28T10:06:00.000Z"
          )
      }
    ) as {
      schemaVersion: number;
      mode: string;
      provider: string;
      githubWrites: number;
      linearWrites: number;
      resolution: string;
      workItemId: string;
      headRevision: string;
      plan: {
        events: Array<{
          type: string;
        }>;
      };
    };

  assert.deepEqual(
    {
      schemaVersion:
        result.schemaVersion,
      mode: result.mode,
      provider: result.provider,
      githubWrites:
        result.githubWrites,
      linearWrites:
        result.linearWrites,
      resolution:
        result.resolution,
      workItemId:
        result.workItemId,
      headRevision:
        result.headRevision
    },
    {
      schemaVersion: 1,
      mode: "preview",
      provider: "github",
      githubWrites: 0,
      linearWrites: 0,
      resolution: "plan",
      workItemId: "TS-NP-6",
      headRevision: "abc123"
    }
  );
  assert.deepEqual(
    result.plan.events.map(
      (event) => event.type
    ),
    [
      "artifact.linked",
      "evidence.recorded",
      "evidence.recorded"
    ]
  );
  assert.equal(calls.length, 4);
  assert.equal(
    await readFile(journalPath, "utf8"),
    before
  );
});

test("apply re-reads the reviewed plan, verifies exact provenance, commits once, and then previews up to date", async (t) => {
  const cwd =
    await createTemporaryDirectory(t);
  await writeConfiguration(cwd, {
    enabled: true,
    mappingIndex:
      "config/github-delivery-map.json"
  });
  await writeDeliveryIndex(cwd, {
    target: "netpilot-z/TaskSeal",
    entries: [createIndexEntry()]
  });
  await writeWorkflowJournal(cwd);
  const calls: string[] = [];
  const dependencies = {
    environment: {
      GITHUB_TOKEN:
        "test-only-token"
    },
    fetchImpl:
      createGitHubFetch(calls),
    clock: () =>
      new Date(
        "2026-07-28T10:06:00.000Z"
      )
  };
  const preview =
    await executeLocalGitHubReconciliation(
      {
        cwd,
        mode: "preview",
        workItemId: "TS-NP-6"
      },
      dependencies
    ) as {
      plan: {
        planDigest: string;
      };
    };
  const applied =
    await executeLocalGitHubReconciliation(
      {
        cwd,
        mode: "apply",
        workItemId: "TS-NP-6",
        expectedPlanDigest:
          preview.plan.planDigest
      },
      dependencies
    ) as {
      resolution: string;
      githubWrites: number;
      linearWrites: number;
      receipt: {
        planDigest: string;
        eventIds: string[];
      };
    };

  assert.equal(
    applied.resolution,
    "committed"
  );
  assert.equal(applied.githubWrites, 0);
  assert.equal(applied.linearWrites, 0);
  assert.equal(
    applied.receipt.planDigest,
    preview.plan.planDigest
  );
  assert.equal(
    applied.receipt.eventIds.length,
    3
  );
  const journalPath = join(
    cwd,
    ".taskseal",
    "events.jsonl"
  );
  const afterFirstApply =
    await readFile(
      journalPath,
      "utf8"
    );
  await writeConfiguration(cwd, {
    enabled: false,
    mappingIndex:
      "config/github-delivery-map.json"
  });
  let retryFetchCalls = 0;
  const retried =
    await executeLocalGitHubReconciliation(
      {
        cwd,
        mode: "apply",
        workItemId: "TS-NP-6",
        expectedPlanDigest:
          preview.plan.planDigest
      },
      {
        environment: {},
        fetchImpl: async () => {
          retryFetchCalls += 1;
          throw new Error(
            "receipt retry must stay offline"
          );
        }
      }
    ) as {
      resolution: string;
      receipt: {
        planDigest: string;
      };
    };

  assert.equal(
    retried.resolution,
    "idempotent"
  );
  assert.equal(
    retried.receipt.planDigest,
    preview.plan.planDigest
  );
  assert.equal(retryFetchCalls, 0);
  assert.equal(
    await readFile(
      journalPath,
      "utf8"
    ),
    afterFirstApply
  );

  await writeConfiguration(cwd, {
    enabled: true,
    mappingIndex:
      "config/github-delivery-map.json"
  });
  const current =
    await executeLocalGitHubReconciliation(
      {
        cwd,
        mode: "preview",
        workItemId: "TS-NP-6"
      },
      dependencies
    ) as {
      resolution: string;
      headRevision: string;
    };

  assert.equal(
    current.resolution,
    "up_to_date"
  );
  assert.equal(
    current.headRevision,
    "abc123"
  );
  assert.equal(
    calls.some((url) =>
      url.endsWith(
        "/check-runs/701"
      )
    ),
    true
  );
  assert.equal(
    calls.some((url) =>
      url.endsWith(
        "/reviews/801"
      )
    ),
    true
  );
});

test("committed receipt retry rejects current delivery mapping drift without GitHub reads", async (t) => {
  const cwd =
    await createTemporaryDirectory(t);
  await writeConfiguration(cwd, {
    enabled: true,
    mappingIndex:
      "config/github-delivery-map.json"
  });
  await writeDeliveryIndex(cwd, {
    target: "netpilot-z/TaskSeal",
    entries: [createIndexEntry()]
  });
  await writeWorkflowJournal(cwd);
  const dependencies = {
    environment: {
      GITHUB_TOKEN:
        "test-only-token"
    },
    fetchImpl:
      createGitHubFetch([]),
    clock: () =>
      new Date(
        "2026-07-28T10:06:00.000Z"
      )
  };
  const preview =
    await executeLocalGitHubReconciliation(
      {
        cwd,
        mode: "preview",
        workItemId: "TS-NP-6"
      },
      dependencies
    ) as {
      plan: {
        planDigest: string;
      };
    };
  await executeLocalGitHubReconciliation(
    {
      cwd,
      mode: "apply",
      workItemId: "TS-NP-6",
      expectedPlanDigest:
        preview.plan.planDigest
    },
    dependencies
  );
  const journalPath = join(
    cwd,
    ".taskseal",
    "events.jsonl"
  );
  const committed = await readFile(
    journalPath,
    "utf8"
  );
  const driftedEntry =
    createIndexEntry();
  const checkBinding =
    driftedEntry.evidence.find(
      (entry) =>
        entry.source.kind ===
        "check_run"
    );
  assert.ok(checkBinding);
  delete checkBinding.source.appId;
  await writeDeliveryIndex(cwd, {
    target: "netpilot-z/TaskSeal",
    entries: [driftedEntry]
  });
  let fetchCalls = 0;

  await assert.rejects(
    executeLocalGitHubReconciliation(
      {
        cwd,
        mode: "apply",
        workItemId: "TS-NP-6",
        expectedPlanDigest:
          preview.plan.planDigest
      },
      {
        environment: {},
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error(
            "mapping drift must fail offline"
          );
        }
      }
    ),
    hasCode(
      "GITHUB_DELIVERY_PLAN_STALE"
    )
  );
  assert.equal(fetchCalls, 0);
  assert.equal(
    await readFile(
      journalPath,
      "utf8"
    ),
    committed
  );
});

test("an older committed head becomes stale after a newer head commits while the current receipt still replays offline", async (t) => {
  const cwd =
    await createTemporaryDirectory(t);
  await writeConfiguration(cwd, {
    enabled: true,
    mappingIndex:
      "config/github-delivery-map.json"
  });
  await writeDeliveryIndex(cwd, {
    target: "netpilot-z/TaskSeal",
    entries: [createIndexEntry()]
  });
  await writeWorkflowJournal(cwd);
  let fixture =
    createGitHubFixture();
  const calls: string[] = [];
  const dependencies = {
    environment: {
      GITHUB_TOKEN:
        "test-only-token"
    },
    fetchImpl:
      createGitHubFetch(
        calls,
        () => fixture
      ),
    clock: () =>
      new Date(
        "2026-07-28T10:06:00.000Z"
      )
  };
  const firstPreview =
    await executeLocalGitHubReconciliation(
      {
        cwd,
        mode: "preview",
        workItemId: "TS-NP-6"
      },
      dependencies
    ) as {
      plan: {
        planDigest: string;
      };
    };
  await executeLocalGitHubReconciliation(
    {
      cwd,
      mode: "apply",
      workItemId: "TS-NP-6",
      expectedPlanDigest:
        firstPreview.plan.planDigest
    },
    dependencies
  );

  fixture = createGitHubFixture({
    headRevision: "def456",
    pullRequestUpdatedAt:
      "2026-07-28T11:03:00.000Z",
    checkId: 702,
    checkCompletedAt:
      "2026-07-28T11:04:00.000Z",
    reviewId: 802,
    reviewSubmittedAt:
      "2026-07-28T11:05:00.000Z"
  });
  const secondPreview =
    await executeLocalGitHubReconciliation(
      {
        cwd,
        mode: "preview",
        workItemId: "TS-NP-6"
      },
      dependencies
    ) as {
      plan: {
        planDigest: string;
      };
    };
  await executeLocalGitHubReconciliation(
    {
      cwd,
      mode: "apply",
      workItemId: "TS-NP-6",
      expectedPlanDigest:
        secondPreview.plan.planDigest
    },
    dependencies
  );
  assert.notEqual(
    firstPreview.plan.planDigest,
    secondPreview.plan.planDigest
  );

  const journalPath = join(
    cwd,
    ".taskseal",
    "events.jsonl"
  );
  const committed = await readFile(
    journalPath,
    "utf8"
  );
  await writeConfiguration(cwd, {
    enabled: false,
    mappingIndex:
      "config/github-delivery-map.json"
  });
  let retryFetchCalls = 0;
  const offlineDependencies = {
    environment: {},
    fetchImpl: async () => {
      retryFetchCalls += 1;
      throw new Error(
        "receipt retry must stay offline"
      );
    }
  };

  await assert.rejects(
    executeLocalGitHubReconciliation(
      {
        cwd,
        mode: "apply",
        workItemId: "TS-NP-6",
        expectedPlanDigest:
          firstPreview.plan.planDigest
      },
      offlineDependencies
    ),
    hasCode(
      "GITHUB_DELIVERY_PLAN_STALE"
    )
  );
  const currentRetry =
    await executeLocalGitHubReconciliation(
      {
        cwd,
        mode: "apply",
        workItemId: "TS-NP-6",
        expectedPlanDigest:
          secondPreview.plan.planDigest
      },
      offlineDependencies
    ) as {
      resolution: string;
      headRevision: string;
      receipt: {
        planDigest: string;
      };
    };

  assert.equal(
    currentRetry.resolution,
    "idempotent"
  );
  assert.equal(
    currentRetry.headRevision,
    "def456"
  );
  assert.equal(
    currentRetry.receipt.planDigest,
    secondPreview.plan.planDigest
  );
  assert.equal(retryFetchCalls, 0);
  assert.equal(
    await readFile(
      journalPath,
      "utf8"
    ),
    committed
  );
});

async function createTemporaryDirectory(
  t: TestContext
): Promise<string> {
  const directory = await mkdtemp(
    join(
      tmpdir(),
      "taskseal-github-reconcile-"
    )
  );
  t.after(() =>
    rm(directory, {
      recursive: true,
      force: true
    })
  );
  return directory;
}

async function writeConfiguration(
  cwd: string,
  delivery: {
    enabled: boolean;
    mappingIndex: string;
  }
): Promise<void> {
  await mkdir(join(cwd, "config"), {
    recursive: true
  });
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({
      project: "TaskSeal",
      github: {
        repository:
          "netpilot-z/TaskSeal",
        delivery
      }
    })
  );
}

async function writeDeliveryIndex(
  cwd: string,
  {
    target,
    entries
  }: {
    target: string;
    entries: unknown[];
  }
): Promise<void> {
  await writeFile(
    join(
      cwd,
      "config",
      "github-delivery-map.json"
    ),
    JSON.stringify({
      schemaVersion: 1,
      provider: "github",
      target: {
        repository: target
      },
      entries
    })
  );
}

function createIndexEntry() {
  return {
    linearIssueId:
      LINEAR_ISSUE_ID,
    workItemId: "TS-NP-6",
    headRepository:
      "netpilot-z/TaskSeal",
    branch:
      "feature/np-6-github-evidence",
    pullRequestNumber: 58,
    evidence: [
      {
        criterionKey: "review",
        source: {
          kind:
            "pull_request_review",
          reviewerId: "9001"
        }
      },
      {
        criterionKey: "tests",
        source: {
          kind: "check_run",
          name: "test",
          appId: "15368"
        }
      }
    ]
  };
}

async function writeWorkflowJournal(
  cwd: string
): Promise<void> {
  await mkdir(join(cwd, ".taskseal"), {
    recursive: true
  });
  const events = [
    {
      eventId:
        "taskseal:TS-NP-6:created",
      workItemId: "TS-NP-6",
      type: "work_item.created",
      occurredAt:
        "2026-07-28T09:00:00.000Z",
      payload: {
        title:
          "Collect GitHub delivery evidence",
        requiredEvidence: [
          "review",
          "tests"
        ],
        externalLink: {
          providerObjectKey:
            `linear:issue:${LINEAR_ISSUE_ID}`,
          provider: "linear",
          objectType: "issue",
          externalId:
            LINEAR_ISSUE_ID,
          scopeRef: {
            kind: "team",
            key:
              "linear:team:658d1189-f63d-4245-b761-0f4f2c389663",
            parentKey:
              "linear:organization:7eb4877f-0fa0-429c-9cd2-76dfffa0f20b"
          },
          url:
            "https://linear.app/netpilot/issue/NP-6",
          managedFields: [],
          lastObservation: {
            revisionId:
              "2026-07-28T09:00:00.000Z",
            occurredAt:
              "2026-07-28T09:00:00.000Z",
            contentDigest:
              "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            title:
              "Collect GitHub delivery evidence",
            url:
              "https://linear.app/netpilot/issue/NP-6"
          }
        }
      }
    },
    {
      eventId:
        "taskseal:TS-NP-6:attempt-1:started",
      workItemId: "TS-NP-6",
      type: "attempt.started",
      occurredAt:
        "2026-07-28T09:01:00.000Z",
      payload: {
        attemptId: "attempt-1",
        agentId: "codex"
      }
    }
  ];
  await writeFile(
    join(
      cwd,
      ".taskseal",
      "events.jsonl"
    ),
    `${events
      .map((event) =>
        JSON.stringify(event)
      )
      .join("\n")}\n`
  );
}

function createGitHubFetch(
  calls: string[],
  readFixture = createGitHubFixture
): typeof fetch {
  return async (input) => {
    const url = String(input);
    calls.push(url);
    const pathname =
      new URL(url).pathname
        .toLowerCase();
    const fixture = readFixture();

    if (
      pathname.endsWith(
        "/pulls/58"
      )
    ) {
      return jsonResponse({
        id: 601,
        number: 58,
        html_url:
          "https://github.com/netpilot-z/TaskSeal/pull/58",
        updated_at:
          fixture.pullRequestUpdatedAt,
        head: {
          sha: fixture.headRevision,
          ref:
            "feature/np-6-github-evidence",
          repo: {
            full_name:
              "netpilot-z/TaskSeal"
          }
        }
      });
    }

    if (
      pathname.endsWith(
        `/check-runs/${fixture.checkId}`
      )
    ) {
      return jsonResponse({
        id: fixture.checkId,
        name: "test",
        status: "completed",
        conclusion: "success",
        head_sha:
          fixture.headRevision,
        details_url:
          `https://github.com/netpilot-z/TaskSeal/actions/runs/${fixture.checkId}`,
        completed_at:
          fixture.checkCompletedAt,
        app: {
          id: 15368
        }
      });
    }

    if (
      pathname.endsWith(
        `/commits/${fixture.headRevision.toLowerCase()}/check-runs`
      )
    ) {
      return jsonResponse({
        total_count: 1,
        check_runs: [
          {
            id: fixture.checkId,
            name: "test",
            status: "completed",
            conclusion: "success",
            head_sha:
              fixture.headRevision,
            details_url:
              `https://github.com/netpilot-z/TaskSeal/actions/runs/${fixture.checkId}`,
            completed_at:
              fixture.checkCompletedAt,
            app: {
              id: 15368
            }
          }
        ]
      });
    }

    if (
      pathname.endsWith(
        `/pulls/58/reviews/${fixture.reviewId}`
      )
    ) {
      return jsonResponse({
        id: fixture.reviewId,
        html_url:
          `https://github.com/netpilot-z/TaskSeal/pull/58#pullrequestreview-${fixture.reviewId}`,
        state: "APPROVED",
        submitted_at:
          fixture.reviewSubmittedAt,
        commit_id:
          fixture.headRevision,
        user: {
          id: 9001,
          login: "reviewer"
        }
      });
    }

    if (
      pathname.endsWith(
        "/pulls/58/reviews"
      )
    ) {
      return jsonResponse([
        {
          id: fixture.reviewId,
          html_url:
            `https://github.com/netpilot-z/TaskSeal/pull/58#pullrequestreview-${fixture.reviewId}`,
          state: "APPROVED",
          submitted_at:
            fixture.reviewSubmittedAt,
          commit_id:
            fixture.headRevision,
          user: {
            id: 9001,
            login: "reviewer"
          }
        }
      ]);
    }

    throw new Error(
      `Unexpected GitHub URL: ${url}`
    );
  };
}

interface GitHubFixture {
  headRevision: string;
  pullRequestUpdatedAt: string;
  checkId: number;
  checkCompletedAt: string;
  reviewId: number;
  reviewSubmittedAt: string;
}

function createGitHubFixture(
  overrides: Partial<GitHubFixture> = {}
): GitHubFixture {
  return {
    headRevision: "abc123",
    pullRequestUpdatedAt:
      "2026-07-28T10:03:00.000Z",
    checkId: 701,
    checkCompletedAt:
      "2026-07-28T10:04:00.000Z",
    reviewId: 801,
    reviewSubmittedAt:
      "2026-07-28T10:05:00.000Z",
    ...overrides
  };
}

function jsonResponse(
  body: unknown
): Response {
  return new Response(
    JSON.stringify(body),
    {
      status: 200,
      headers: {
        "content-type":
          "application/json"
      }
    }
  );
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}
