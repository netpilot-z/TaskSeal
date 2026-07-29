import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

import {
  inspectGiteeHealthProvider,
  inspectGiteeProvider,
  inspectGitHubIssueProvider,
  inspectGitHubProvider,
  inspectLinearProvider
} from "../src/application/provider-inspection.ts";
import type {
  FetchRequestOptions
} from "../src/connectors/github-read-client.ts";
import type {
  AttemptFinishedEvent,
  AttemptStartedEvent
} from "../src/domain/workflow.ts";
import { applyEvent, createWorkflow } from "../src/domain/workflow.ts";
import {
  digestProviderFactContent
} from "../src/lib/provider-snapshot.ts";

const GITHUB_ISSUE = {
  id: 501,
  number: 1,
  title: "Prove the delivery evidence loop",
  html_url: "https://github.com/netpilot-z/TaskSeal/issues/1",
  created_at: "2026-07-26T08:00:00.000Z",
  updated_at: "2026-07-26T08:00:00.000Z"
};

const GITHUB_PULL_REQUEST = {
  id: 1001,
  number: 1,
  html_url: "https://github.com/netpilot-z/TaskSeal/pull/1",
  updated_at: "2026-07-26T08:03:00.000Z",
  head: { sha: "abc123" }
};

const GITHUB_CHECK = {
  id: 2001,
  name: "tests",
  status: "completed",
  conclusion: "success",
  head_sha: "abc123",
  details_url: "https://github.com/netpilot-z/TaskSeal/actions/runs/1",
  completed_at: "2026-07-26T08:04:00.000Z"
};

const LINEAR_ORGANIZATION = {
  id: "organization-1",
  name: "TaskSeal",
  urlKey: "taskseal"
};

const LINEAR_TEAM = {
  id: "team-1",
  name: "netpilot",
  key: "NET"
};

const LINEAR_ISSUE = {
  id: "linear-issue-1",
  identifier: "NET-7",
  title: "Prove the delivery evidence loop",
  description: "Validate the provider contract.",
  url: "https://linear.app/taskseal/issue/NET-7",
  createdAt: "2026-07-26T08:00:00.000Z",
  updatedAt: "2026-07-26T08:01:00.000Z",
  team: {
    id: "team-1",
    key: "NET"
  },
  project: {
    id: "project-1",
    name: "TaskSeal"
  }
};

const GITEE_REPOSITORY = {
  id: 1_322_341,
  full_name: "oschina/git-osc"
};

const GITEE_ISSUE = {
  id: 2_614,
  number: "I4",
  title: "Git push crashes",
  html_url: "https://gitee.com/oschina/git-osc/issues/I4",
  created_at: "2013-04-12T12:15:08+08:00",
  updated_at: "2022-07-22T05:01:31+08:00",
  state: "open",
  repository: {
    full_name: "oschina/git-osc"
  }
};

test("Gitee health inspection returns only normalized public scope state", async (t) => {
  const cwd = await createConfiguredProject(t);
  const snapshot = await inspectGiteeHealthProvider({
    cwd,
    now: () => new Date("2026-07-27T08:00:00.000Z"),
    fetchImpl: async () => textResponse(GITEE_REPOSITORY)
  });

  assert.deepEqual(snapshot, {
    provider: "gitee",
    status: "ready",
    checkedAt: "2026-07-27T08:00:00.000Z",
    scope: {
      kind: "repository",
      key: "gitee:repository:oschina/git-osc"
    }
  });
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    new RegExp(escapeRegExp(cwd))
  );
});

test("Gitee inspection emits one display-only v2 Issue fact", async (t) => {
  const cwd = await createConfiguredProject(t);
  const snapshot = await inspectGiteeProvider({
    cwd,
    issueReference: "I4",
    workItemId: "TS-GITEE-I4",
    requiredEvidence: ["tests"],
    snapshotVersion: 2,
    managedFields: [],
    now: () => new Date("2026-07-27T08:00:00.000Z"),
    fetchImpl: async () => textResponse(GITEE_ISSUE)
  });

  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.mode, "read-only");
  assert.equal(snapshot.provider, "gitee");
  assert.deepEqual(snapshot.scope, {
    kind: "repository",
    key: "gitee:repository:oschina/git-osc"
  });
  assert.deepEqual(snapshot.mapping, {
    workItemId: "TS-GITEE-I4",
    requiredEvidence: ["tests"],
    managedFields: []
  });
  assert.equal(snapshot.facts.length, 1);
  assert.equal(
    snapshot.facts[0]?.sourceObject.providerObjectKey,
    "gitee:issue:oschina/git-osc#I4"
  );
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /"id":2614|"state":"open"/
  );
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    new RegExp(escapeRegExp(cwd))
  );
});

test("GitHub issue inspection emits one redacted read-only WorkItem snapshot", async (t) => {
  const cwd = await createConfiguredProject(t);
  const token = "github-issue-inspection-secret";
  const calls: Array<{
    url: string;
    options: FetchRequestOptions;
  }> = [];

  const snapshot = await inspectGitHubIssueProvider({
    cwd,
    issueNumber: 1,
    workItemId: "TS-1",
    requiredEvidence: ["tests"],
    environment: { GITHUB_TOKEN: token },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(GITHUB_ISSUE);
    }
  });

  assert.equal(snapshot.mode, "read-only");
  assert.equal(snapshot.provider, "github");
  assert.deepEqual(snapshot.scope, {
    repository: "netpilot-z/TaskSeal"
  });
  assert.deepEqual(snapshot.mapping, {
    workItemId: "TS-1",
    requiredEvidence: ["tests"]
  });
  assert.deepEqual(snapshot.source, {
    issue: {
      id: "501",
      number: 1
    }
  });
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].type, "work_item.created");
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(
    call.url,
    "https://api.github.com/repos/netpilot-z/TaskSeal/issues/1"
  );
  assert.equal(call.options.method, "GET");

  const workflow = applyEvent(createWorkflow(), snapshot.events[0]);
  assert.equal(
    requireWorkItem(workflow.workItems, "TS-1").status,
    "planned"
  );
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(token));
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    new RegExp(escapeRegExp(cwd))
  );
});

test("GitHub inspection emits a replayable, redacted, read-only snapshot", async (t) => {
  const cwd = await createConfiguredProject(t);
  const token = "github-inspection-secret";
  const responses = [
    jsonResponse(GITHUB_ISSUE),
    jsonResponse(GITHUB_PULL_REQUEST),
    jsonResponse({
      total_count: 1,
      check_runs: [GITHUB_CHECK]
    })
  ];

  const snapshot = await inspectGitHubProvider({
    cwd,
    issueNumber: 1,
    pullRequestNumber: 1,
    checkName: "tests",
    workItemId: "TS-1",
    attemptId: "run-1",
    criterionKey: "tests",
    environment: { GITHUB_TOKEN: token },
    fetchImpl: async () => responses.shift()
  });

  assert.deepEqual(snapshot.scope, {
    repository: "netpilot-z/TaskSeal"
  });
  assert.deepEqual(snapshot.mapping, {
    association: "explicit",
    workItemId: "TS-1",
    attemptId: "run-1",
    criterionKey: "tests"
  });
  assert.equal(snapshot.mode, "read-only");
  assert.equal(snapshot.provider, "github");
  assert.deepEqual(
    snapshot.events.map((event) => event.type),
    ["work_item.created", "artifact.linked", "evidence.recorded"]
  );

  const started: AttemptStartedEvent = {
    eventId: "attempt:run-1:started",
    workItemId: "TS-1",
    type: "attempt.started",
    occurredAt: "2026-07-26T08:01:00.000Z",
    payload: {
      attemptId: "run-1",
      agentId: "product-engineer"
    }
  };
  const completed: AttemptFinishedEvent = {
    eventId: "attempt:run-1:finished",
    workItemId: "TS-1",
    type: "attempt.finished",
    occurredAt: "2026-07-26T08:02:00.000Z",
    payload: {
      attemptId: "run-1",
      outcome: "completed"
    }
  };
  const replayEvents = [
    snapshot.events[0],
    started,
    completed,
    ...snapshot.events.slice(1)
  ];
  const workflow = replayEvents.reduce(applyEvent, createWorkflow());

  const workItem = requireWorkItem(
    workflow.workItems,
    "TS-1"
  );
  assert.equal(workItem.status, "reviewing");
  assert.equal(workItem.evidence[0]?.outcome, "passed");
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(token));
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    new RegExp(escapeRegExp(cwd))
  );
});

test("Linear inspection emits one explicit WorkItem snapshot without raw credentials", async (t) => {
  const cwd = await createConfiguredProject(t);
  const apiKey = "linear-inspection-secret";
  const responses = [
    jsonResponse({
      data: {
        organization: LINEAR_ORGANIZATION,
        teams: {
          nodes: [LINEAR_TEAM],
          pageInfo: {
            hasNextPage: false,
            endCursor: null
          }
        }
      }
    }),
    jsonResponse({
      data: {
        issue: LINEAR_ISSUE
      }
    })
  ];

  const snapshot = await inspectLinearProvider({
    cwd,
    issueReference: "NET-7",
    workItemId: "TS-1",
    requiredEvidence: ["tests"],
    environment: { LINEAR_API_KEY: apiKey },
    fetchImpl: async () => responses.shift()
  });

  assert.equal(snapshot.mode, "read-only");
  assert.equal(snapshot.provider, "linear");
  assert.deepEqual(snapshot.scope, {
    workspace: {
      configured: "TaskSeal",
      id: "organization-1",
      name: "TaskSeal",
      urlKey: "taskseal"
    },
    team: {
      configured: "netpilot",
      id: "team-1",
      name: "netpilot",
      key: "NET"
    }
  });
  assert.deepEqual(snapshot.mapping, {
    workItemId: "TS-1",
    requiredEvidence: ["tests"]
  });
  assert.equal(snapshot.events.length, 1);

  const workflow = applyEvent(createWorkflow(), snapshot.events[0]);
  assert.equal(
    requireWorkItem(workflow.workItems, "TS-1").status,
    "planned"
  );
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(apiKey));
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    new RegExp(escapeRegExp(cwd))
  );
});

test("GitHub issue inspection emits an explicitly managed importable v2 snapshot", async (t) => {
  const cwd = await createConfiguredProject(t);
  const snapshot = await inspectGitHubIssueProvider({
    cwd,
    issueNumber: 1,
    workItemId: "TS-1",
    requiredEvidence: ["tests", "lint"],
    snapshotVersion: 2,
    managedFields: ["title"],
    now: () => new Date("2026-07-26T08:01:00.000Z"),
    environment: { GITHUB_TOKEN: "redacted" },
    fetchImpl: async () => jsonResponse(GITHUB_ISSUE)
  });

  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.capturedAt, "2026-07-26T08:01:00.000Z");
  assert.deepEqual(snapshot.scope, {
    kind: "repository",
    key: "github:repository:netpilot-z/taskseal"
  });
  assert.deepEqual(snapshot.mapping, {
    workItemId: "TS-1",
    requiredEvidence: ["lint", "tests"],
    managedFields: ["title"]
  });
  assert.equal(snapshot.facts.length, 1);
  assert.equal(
    snapshot.facts[0].sourceObject.providerObjectKey,
    "github:issue:501"
  );
  assert.equal(
    snapshot.facts[0].revision.id,
    GITHUB_ISSUE.updated_at
  );
  assert.equal(
    snapshot.facts[0].revision.contentDigest,
    digestProviderFactContent(snapshot.facts[0])
  );
  assert.deepEqual(
    snapshot.facts[0].candidateEvent.payload.requiredEvidence,
    ["lint", "tests"]
  );
});

test("GitHub delivery inspection binds every v2 fact to its source object", async (t) => {
  const cwd = await createConfiguredProject(t);
  const responses = [
    jsonResponse(GITHUB_ISSUE),
    jsonResponse(GITHUB_PULL_REQUEST),
    jsonResponse({
      total_count: 1,
      check_runs: [GITHUB_CHECK]
    })
  ];
  const snapshot = await inspectGitHubProvider({
    cwd,
    issueNumber: 1,
    pullRequestNumber: 1,
    checkName: "tests",
    workItemId: "TS-1",
    attemptId: "run-1",
    criterionKey: "tests",
    snapshotVersion: 2,
    managedFields: [],
    now: () => new Date("2026-07-26T08:05:00.000Z"),
    environment: { GITHUB_TOKEN: "redacted" },
    fetchImpl: async () => responses.shift()
  });

  assert.equal(snapshot.schemaVersion, 2);
  assert.deepEqual(snapshot.mapping, {
    workItemId: "TS-1",
    requiredEvidence: ["tests"],
    managedFields: [],
    attemptId: "run-1",
    artifactId: "pr-1001",
    artifactRevision: "abc123",
    criterionKey: "tests"
  });
  assert.deepEqual(
    snapshot.facts.map(
      (fact) => [
        fact.sourceObject.objectType,
        fact.candidateEvent.type
      ]
    ),
    [
      ["issue", "work_item.created"],
      ["pull_request", "artifact.linked"],
      ["check", "evidence.recorded"]
    ]
  );

  for (const fact of snapshot.facts) {
    assert.equal(
      fact.revision.contentDigest,
      digestProviderFactContent(fact)
    );
  }
});

test("Linear inspection emits UUID-scoped v2 facts without display-only scope names", async (t) => {
  const cwd = await createConfiguredProject(t);
  const organization = {
    ...LINEAR_ORGANIZATION,
    id: "33333333-3333-4333-8333-333333333333"
  };
  const team = {
    ...LINEAR_TEAM,
    id: "22222222-2222-4222-8222-222222222222"
  };
  const issue = {
    ...LINEAR_ISSUE,
    id: "11111111-1111-4111-8111-111111111111",
    team: {
      ...LINEAR_ISSUE.team,
      id: team.id
    }
  };
  const responses = [
    jsonResponse({
      data: {
        organization,
        teams: {
          nodes: [team],
          pageInfo: {
            hasNextPage: false,
            endCursor: null
          }
        }
      }
    }),
    jsonResponse({
      data: { issue }
    })
  ];
  const snapshot = await inspectLinearProvider({
    cwd,
    issueReference: "NET-7",
    workItemId: "TS-1",
    requiredEvidence: ["tests"],
    snapshotVersion: 2,
    managedFields: [],
    now: () => new Date("2026-07-26T08:02:00.000Z"),
    environment: { LINEAR_API_KEY: "redacted" },
    fetchImpl: async () => responses.shift()
  });

  assert.equal(snapshot.schemaVersion, 2);
  assert.deepEqual(snapshot.scope, {
    kind: "team",
    key: `linear:team:${team.id}`,
    parentKey: `linear:organization:${organization.id}`
  });
  assert.deepEqual(snapshot.mapping, {
    workItemId: "TS-1",
    requiredEvidence: ["tests"],
    managedFields: []
  });
  assert.equal(
    snapshot.facts[0].sourceObject.providerObjectKey,
    `linear:issue:${issue.id}`
  );
  assert.equal(
    snapshot.facts[0].revision.contentDigest,
    digestProviderFactContent(snapshot.facts[0])
  );
  assert.doesNotMatch(
    JSON.stringify(snapshot.scope),
    /configured|name|urlKey/
  );
});

async function createConfiguredProject(
  t: TestContext
): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "taskseal-inspection-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({
      project: "TaskSeal",
      github: { repository: "netpilot-z/TaskSeal" },
      gitee: { repository: "oschina/git-osc" },
      linear: {
        workspace: "TaskSeal",
        team: "netpilot",
        project: "TaskSeal"
      }
    })
  );
  return cwd;
}

function textResponse(body: unknown): unknown {
  return {
    ok: true,
    status: 200,
    headers: {
      get() {
        return null;
      }
    },
    async text() {
      return JSON.stringify(body);
    }
  };
}

function jsonResponse(
  body: unknown,
  { status = 200 }: { status?: number } = {}
): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get() {
        return null;
      }
    },
    async json() {
      return body;
    }
  };
}

function requireWorkItem<T>(
  workItems: Record<string, T>,
  workItemId: string
): T {
  const workItem = workItems[workItemId];

  if (!workItem) {
    throw new Error(`Missing work item ${workItemId}.`);
  }

  return workItem;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
