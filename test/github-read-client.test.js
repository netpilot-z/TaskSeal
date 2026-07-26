import assert from "node:assert/strict";
import test from "node:test";

import {
  readGitHubDelivery,
  readGitHubIssue
} from "../src/connectors/github-read-client.js";

const ISSUE = {
  id: 501,
  number: 1,
  title: "Prove the delivery evidence loop",
  html_url: "https://github.com/netpilot-z/TaskSeal/issues/1",
  created_at: "2026-07-26T08:00:00.000Z",
  updated_at: "2026-07-26T08:00:00.000Z"
};

const PULL_REQUEST = {
  id: 1001,
  number: 1,
  html_url: "https://github.com/netpilot-z/TaskSeal/pull/1",
  updated_at: "2026-07-26T08:03:00.000Z",
  head: { sha: "abc123" }
};

const CHECK = {
  id: 2001,
  name: "tests",
  status: "completed",
  conclusion: "success",
  head_sha: "abc123",
  details_url: "https://github.com/netpilot-z/TaskSeal/actions/runs/1",
  completed_at: "2026-07-26T08:04:00.000Z"
};

test("GitHub issue inspection reads only the explicit issue", async () => {
  const calls = [];
  const token = "github-issue-secret";

  const result = await readGitHubIssue({
    repository: "netpilot-z/TaskSeal",
    issueNumber: 1,
    token,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(ISSUE);
    }
  });

  assert.deepEqual(result, ISSUE);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.github.com/repos/netpilot-z/TaskSeal/issues/1"
  );
  assert.equal(calls[0].options.method, "GET");
  assert.equal(
    calls[0].options.headers.Accept,
    "application/vnd.github+json"
  );
  assert.equal(
    calls[0].options.headers["X-GitHub-Api-Version"],
    "2026-03-10"
  );
  assert.equal(calls[0].options.headers["User-Agent"], "TaskSeal");
  assert.equal(
    calls[0].options.headers.Authorization,
    `Bearer ${token}`
  );
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
});

test("GitHub issue inspection fails closed for a PR or missing issue", async (t) => {
  await t.test("an issue-shaped PR is rejected", async () => {
    await assert.rejects(
      readGitHubIssue({
        repository: "netpilot-z/TaskSeal",
        issueNumber: 1,
        fetchImpl: async () =>
          jsonResponse({ ...ISSUE, pull_request: { url: "ignored" } })
      }),
      hasCode("GITHUB_ISSUE_IS_PULL_REQUEST")
    );
  });

  await t.test("a missing issue has a safe error", async () => {
    await assert.rejects(
      readGitHubIssue({
        repository: "netpilot-z/TaskSeal",
        issueNumber: 99,
        fetchImpl: async () =>
          jsonResponse({ message: "not found" }, { status: 404 })
      }),
      hasCode("GITHUB_NOT_FOUND")
    );
  });
});

test("GitHub delivery reads only the explicit issue, PR, and paginated head check", async () => {
  const calls = [];
  const responses = [
    jsonResponse(ISSUE),
    jsonResponse(PULL_REQUEST),
    jsonResponse(
      { total_count: 1, check_runs: [] },
      {
        headers: {
          link: '<https://api.github.com/repositories/1/commits/abc123/check-runs?check_name=tests&filter=latest&per_page=100&page=2>; rel="next"'
        }
      }
    ),
    jsonResponse({ total_count: 1, check_runs: [CHECK] })
  ];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return responses.shift();
  };

  const result = await readGitHubDelivery({
    repository: "netpilot-z/TaskSeal",
    issueNumber: 1,
    pullRequestNumber: 1,
    checkName: "tests",
    fetchImpl
  });

  assert.deepEqual(result, {
    issue: ISSUE,
    pullRequest: PULL_REQUEST,
    check: CHECK
  });
  assert.equal(calls.length, 4);
  assert.equal(
    calls[0].url,
    "https://api.github.com/repos/netpilot-z/TaskSeal/issues/1"
  );
  assert.equal(
    calls[1].url,
    "https://api.github.com/repos/netpilot-z/TaskSeal/pulls/1"
  );
  assert.equal(
    calls[2].url,
    "https://api.github.com/repos/netpilot-z/TaskSeal/commits/abc123/check-runs?check_name=tests&filter=latest&per_page=100"
  );
  assert.equal(calls[3].url.includes("page=2"), true);

  for (const call of calls) {
    assert.equal(call.options.method, "GET");
    assert.equal(
      call.options.headers.Accept,
      "application/vnd.github+json"
    );
    assert.equal(
      call.options.headers["X-GitHub-Api-Version"],
      "2026-03-10"
    );
    assert.equal(call.options.headers["User-Agent"], "TaskSeal");
    assert.equal("Authorization" in call.options.headers, false);
  }
});

test("GitHub delivery uses a bearer token without returning it", async () => {
  const token = "github-secret-value";
  const calls = [];
  const responses = [
    jsonResponse(ISSUE),
    jsonResponse(PULL_REQUEST),
    jsonResponse({ total_count: 1, check_runs: [CHECK] })
  ];

  const result = await readGitHubDelivery({
    repository: "netpilot-z/TaskSeal",
    issueNumber: 1,
    pullRequestNumber: 1,
    checkName: "tests",
    token,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    }
  });

  assert.equal(
    calls.every(
      ({ options }) => options.headers.Authorization === `Bearer ${token}`
    ),
    true
  );
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
});

test("GitHub delivery fails closed for provider and association errors", async (t) => {
  await t.test("an issue-shaped PR is rejected", async () => {
    await assert.rejects(
      readGitHubDelivery({
        repository: "netpilot-z/TaskSeal",
        issueNumber: 1,
        pullRequestNumber: 1,
        checkName: "tests",
        fetchImpl: createQueuedFetch([
          jsonResponse({ ...ISSUE, pull_request: { url: "ignored" } })
        ])
      }),
      hasCode("GITHUB_ISSUE_IS_PULL_REQUEST")
    );
  });

  await t.test("a missing resource has a safe error", async () => {
    const token = "must-not-leak";
    let error;

    try {
      await readGitHubDelivery({
        repository: "netpilot-z/TaskSeal",
        issueNumber: 99,
        pullRequestNumber: 99,
        checkName: "tests",
        token,
        fetchImpl: createQueuedFetch([
          jsonResponse({ message: `bad ${token}` }, { status: 404 })
        ])
      });
    } catch (caught) {
      error = caught;
    }

    assert.equal(error.code, "GITHUB_NOT_FOUND");
    assert.doesNotMatch(error.message, new RegExp(token));
  });

  await t.test("a foreign pagination URL is rejected", async () => {
    await assert.rejects(
      readGitHubDelivery({
        repository: "netpilot-z/TaskSeal",
        issueNumber: 1,
        pullRequestNumber: 1,
        checkName: "tests",
        fetchImpl: createQueuedFetch([
          jsonResponse(ISSUE),
          jsonResponse(PULL_REQUEST),
          jsonResponse(
            { total_count: 0, check_runs: [] },
            {
              headers: {
                link: '<https://example.test/steal>; rel="next"'
              }
            }
          )
        ])
      }),
      hasCode("GITHUB_PAGINATION_ORIGIN_INVALID")
    );
  });

  await t.test("ambiguous checks are not guessed", async () => {
    await assert.rejects(
      readGitHubDelivery({
        repository: "netpilot-z/TaskSeal",
        issueNumber: 1,
        pullRequestNumber: 1,
        checkName: "tests",
        fetchImpl: createQueuedFetch([
          jsonResponse(ISSUE),
          jsonResponse(PULL_REQUEST),
          jsonResponse({
            total_count: 2,
            check_runs: [CHECK, { ...CHECK, id: 2002 }]
          })
        ])
      }),
      hasCode("GITHUB_CHECK_AMBIGUOUS")
    );
  });

  await t.test("check evidence must match the PR revision", async () => {
    await assert.rejects(
      readGitHubDelivery({
        repository: "netpilot-z/TaskSeal",
        issueNumber: 1,
        pullRequestNumber: 1,
        checkName: "tests",
        fetchImpl: createQueuedFetch([
          jsonResponse(ISSUE),
          jsonResponse(PULL_REQUEST),
          jsonResponse({
            total_count: 1,
            check_runs: [{ ...CHECK, head_sha: "different" }]
          })
        ])
      }),
      hasCode("GITHUB_CHECK_REVISION_MISMATCH")
    );
  });
});

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([name, value]) => [
      name.toLowerCase(),
      value
    ])
  );

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return normalizedHeaders.get(name.toLowerCase()) ?? null;
      }
    },
    async json() {
      return body;
    }
  };
}

function createQueuedFetch(responses) {
  return async () => responses.shift();
}

function hasCode(code) {
  return (error) => error?.code === code;
}
