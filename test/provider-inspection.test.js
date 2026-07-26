import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectGitHubIssueProvider,
  inspectGitHubProvider,
  inspectLinearProvider
} from "../src/application/provider-inspection.js";
import { normalizeCodexRun } from "../src/connectors/codex.js";
import { applyEvent, createWorkflow } from "../src/domain/workflow.js";

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
  }
};

test("GitHub issue inspection emits one redacted read-only WorkItem snapshot", async (t) => {
  const cwd = await createConfiguredProject(t);
  const token = "github-issue-inspection-secret";
  const calls = [];

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
  assert.equal(
    calls[0].url,
    "https://api.github.com/repos/netpilot-z/TaskSeal/issues/1"
  );
  assert.equal(calls[0].options.method, "GET");

  const workflow = applyEvent(createWorkflow(), snapshot.events[0]);
  assert.equal(workflow.workItems["TS-1"].status, "planned");
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

  const started = normalizeCodexRun({
    id: "run-1",
    workItemId: "TS-1",
    agentId: "codex-product-engineer",
    status: "started",
    startedAt: "2026-07-26T08:01:00.000Z"
  });
  const completed = normalizeCodexRun({
    id: "run-1",
    workItemId: "TS-1",
    status: "completed",
    completedAt: "2026-07-26T08:02:00.000Z"
  });
  const replayEvents = [
    snapshot.events[0],
    started,
    completed,
    ...snapshot.events.slice(1)
  ];
  const workflow = replayEvents.reduce(applyEvent, createWorkflow());

  assert.equal(workflow.workItems["TS-1"].status, "reviewing");
  assert.equal(workflow.workItems["TS-1"].evidence[0].outcome, "passed");
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
  assert.equal(workflow.workItems["TS-1"].status, "planned");
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(apiKey));
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    new RegExp(escapeRegExp(cwd))
  );
});

async function createConfiguredProject(t) {
  const cwd = await mkdtemp(join(tmpdir(), "taskseal-inspection-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({
      project: "TaskSeal",
      github: { repository: "netpilot-z/TaskSeal" },
      linear: { workspace: "TaskSeal", team: "netpilot" }
    })
  );
  return cwd;
}

function jsonResponse(body, { status = 200 } = {}) {
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
