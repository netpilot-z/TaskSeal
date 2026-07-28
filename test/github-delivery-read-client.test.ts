import assert from "node:assert/strict";
import test from "node:test";

import {
  readGitHubHeadChecks,
  readGitHubMappedPullRequest,
  readGitHubPullRequestReview,
  readGitHubPullRequestReviews
} from "../src/connectors/github-read-client.ts";
import type {
  FetchLike,
  FetchRequestOptions
} from "../src/connectors/github-read-client.ts";

interface RequestCall {
  url: string;
  options: FetchRequestOptions;
}

const PULL_REQUEST = {
  id: 601,
  number: 58,
  html_url:
    "https://github.com/netpilot-z/TaskSeal/pull/58",
  updated_at:
    "2026-07-28T10:03:00.000Z",
  head: {
    sha: "abc123",
    ref: "feature/np-6-github-evidence",
    repo: {
      full_name: "netpilot-z/TaskSeal"
    }
  }
};

const TESTS_CHECK = {
  id: 701,
  name: "tests",
  status: "completed",
  conclusion: "success",
  head_sha: "abc123",
  details_url:
    "https://github.com/netpilot-z/TaskSeal/actions/runs/701",
  completed_at:
    "2026-07-28T10:04:00.000Z",
  app: {
    id: 15368
  }
};

const REVIEW = {
  id: 801,
  html_url:
    "https://github.com/netpilot-z/TaskSeal/pull/58#pullrequestreview-801",
  state: "APPROVED",
  submitted_at:
    "2026-07-28T10:05:00.000Z",
  commit_id: "abc123",
  user: {
    id: 9001,
    login: "reviewer"
  }
};

test("mapped PR reads the exact number and verifies head repository and branch", async () => {
  const calls: RequestCall[] = [];

  const result =
    await readGitHubMappedPullRequest({
      repository: "netpilot-z/TaskSeal",
      pullRequestNumber: 58,
      headRepository:
        "netpilot-z/TaskSeal",
      branch:
        "feature/np-6-github-evidence",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse(PULL_REQUEST);
      }
    });

  assert.deepEqual(result, PULL_REQUEST);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    "https://api.github.com/repos/netpilot-z/TaskSeal/pulls/58"
  );
  assert.equal(calls[0]?.options.method, "GET");

  await assert.rejects(
    readGitHubMappedPullRequest({
      repository: "netpilot-z/TaskSeal",
      pullRequestNumber: 58,
      headRepository: "fork-owner/TaskSeal",
      branch:
        "feature/np-6-github-evidence",
      fetchImpl: async () =>
        jsonResponse(PULL_REQUEST)
    }),
    hasCode(
      "GITHUB_PULL_REQUEST_MAPPING_MISMATCH"
    )
  );
});

test("head checks resolve every explicit selector without guessing missing or incomplete results", async () => {
  const calls: RequestCall[] = [];
  const pending = {
    ...TESTS_CHECK,
    id: 702,
    name: "lint",
    status: "in_progress",
    conclusion: null,
    completed_at: null
  };

  const result = await readGitHubHeadChecks({
    repository: "netpilot-z/TaskSeal",
    headSha: "abc123",
    selectors: [
      {
        name: "tests",
        appId: "15368"
      },
      {
        name: "lint"
      },
      {
        name: "security"
      }
    ],
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        total_count: 2,
        check_runs: [
          TESTS_CHECK,
          pending
        ]
      });
    }
  });

  assert.deepEqual(result, [
    {
      selector: {
        name: "tests",
        appId: "15368"
      },
      check: TESTS_CHECK
    },
    {
      selector: {
        name: "lint"
      },
      check: pending
    },
    {
      selector: {
        name: "security"
      },
      check: null
    }
  ]);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    "https://api.github.com/repos/netpilot-z/TaskSeal/commits/abc123/check-runs?filter=latest&per_page=100"
  );
});

test("head checks reject ambiguous selectors and revision drift", async (t) => {
  await t.test(
    "same selector is ambiguous",
    async () => {
      await assert.rejects(
        readGitHubHeadChecks({
          repository:
            "netpilot-z/TaskSeal",
          headSha: "abc123",
          selectors: [
            { name: "tests" }
          ],
          fetchImpl: async () =>
            jsonResponse({
              total_count: 2,
              check_runs: [
                TESTS_CHECK,
                {
                  ...TESTS_CHECK,
                  id: 702
                }
              ]
            })
        }),
        hasCode("GITHUB_CHECK_AMBIGUOUS")
      );
    }
  );

  await t.test(
    "a selected check must match the head",
    async () => {
      await assert.rejects(
        readGitHubHeadChecks({
          repository:
            "netpilot-z/TaskSeal",
          headSha: "abc123",
          selectors: [
            {
              name: "tests",
              appId: "15368"
            }
          ],
          fetchImpl: async () =>
            jsonResponse({
              total_count: 1,
              check_runs: [
                {
                  ...TESTS_CHECK,
                  head_sha: "new-head"
                }
              ]
            })
        }),
        hasCode(
          "GITHUB_CHECK_REVISION_MISMATCH"
        )
      );
    }
  );
});

test("pull request reviews use bounded pagination and exact provenance reads", async () => {
  const calls: RequestCall[] = [];
  const responses = [
    jsonResponse(
      [REVIEW],
      {
        link:
          '<https://api.github.com/repos/netpilot-z/TaskSeal/pulls/58/reviews?per_page=100&page=2>; rel="next"'
      }
    ),
    jsonResponse([
      {
        ...REVIEW,
        id: 802,
        state: "COMMENTED"
      }
    ]),
    jsonResponse(REVIEW)
  ];
  const fetchImpl: FetchLike = async (
    url,
    options
  ) => {
    calls.push({ url, options });
    return responses.shift();
  };

  const reviews =
    await readGitHubPullRequestReviews({
      repository: "netpilot-z/TaskSeal",
      pullRequestNumber: 58,
      fetchImpl
    });
  const review =
    await readGitHubPullRequestReview({
      repository: "netpilot-z/TaskSeal",
      pullRequestNumber: 58,
      reviewId: "801",
      fetchImpl
    });

  assert.deepEqual(reviews, [
    REVIEW,
    {
      ...REVIEW,
      id: 802,
      state: "COMMENTED"
    }
  ]);
  assert.deepEqual(review, REVIEW);
  assert.equal(
    calls[0]?.url,
    "https://api.github.com/repos/netpilot-z/TaskSeal/pulls/58/reviews?per_page=100"
  );
  assert.equal(
    calls[2]?.url,
    "https://api.github.com/repos/netpilot-z/TaskSeal/pulls/58/reviews/801"
  );
  assert.equal(
    calls.every(
      (call) =>
        call.options.method === "GET"
    ),
    true
  );
});

test("pull request reviews reject unknown states and malformed identities", async () => {
  await assert.rejects(
    readGitHubPullRequestReviews({
      repository: "netpilot-z/TaskSeal",
      pullRequestNumber: 58,
      fetchImpl: async () =>
        jsonResponse([
          {
            ...REVIEW,
            state: "SUPER_APPROVED"
          }
        ])
    }),
    hasCode("GITHUB_RESPONSE_INVALID")
  );

  await assert.rejects(
    readGitHubPullRequestReview({
      repository: "netpilot-z/TaskSeal",
      pullRequestNumber: 58,
      reviewId: "not-a-number",
      fetchImpl: async () =>
        jsonResponse(REVIEW)
    }),
    hasCode("GITHUB_INPUT_INVALID")
  );
});

function jsonResponse(
  body: unknown,
  {
    status = 200,
    link = null
  }: {
    status?: number;
    link?: string | null;
  } = {}
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === "link"
          ? link
          : null;
      }
    },
    async json(): Promise<unknown> {
      return body;
    }
  };
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}
