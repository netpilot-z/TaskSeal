import assert from "node:assert/strict";
import test from "node:test";

import {
  collectProviderFactProvenanceClaims,
  computeProviderFactProvenanceClaimDigest
} from "../src/application/provider-fact-provenance.ts";
import type {
  ProviderFactProvenanceClaim,
  ProviderFactProvenanceVerificationResult
} from "../src/application/provider-fact-provenance.ts";
import {
  createReadOnlyProviderFactProvenanceVerifier
} from "../src/connectors/provider-fact-provenance-verifier.ts";
import {
  createWorkflow
} from "../src/domain/workflow.ts";
import {
  digestProviderFactContent
} from "../src/lib/provider-snapshot.ts";
import {
  createGitHubIssueSnapshot,
  createLinearImportPolicy,
  createLinearIssueSnapshot,
  createPreviewPlan
} from "../test-support/snapshot-import-fixtures.ts";

const GITHUB_SCOPE = {
  kind: "repository",
  key: "github:repository:netpilot-z/taskseal"
};
const LINEAR_ISSUE_ID =
  "11111111-1111-4111-8111-111111111111";
const LINEAR_TEAM_ID =
  "22222222-2222-4222-8222-222222222222";
const LINEAR_ORGANIZATION_ID =
  "33333333-3333-4333-8333-333333333333";
const LINEAR_PROJECT_ID =
  "55555555-5555-4555-8555-555555555555";

test("GitHub verifier binds Issue database ID, number, URL, revision, and content", async () => {
  const claim = githubIssueClaim();
  const calls: string[] = [];
  const verifier =
    createReadOnlyProviderFactProvenanceVerifier({
      github: {
        fetchImpl: async (url) => {
          calls.push(url);
          return jsonResponse({
            id: 501,
            number: 1,
            title:
              "Apply a provider snapshot safely",
            html_url: claim.url,
            created_at:
              "2026-07-26T08:00:00.000Z",
            updated_at: claim.sourceRevisionId
          });
        }
      }
    });

  const result = await verifier.verify([
    claim
  ]) as ProviderFactProvenanceVerificationResult[];

  assert.deepEqual(result, [
    {
      schemaVersion: 1,
      claimDigest: claim.claimDigest,
      outcome: "verified"
    }
  ]);
  assert.deepEqual(calls, [
    "https://api.github.com/repos/netpilot-z/taskseal/issues/1"
  ]);
});

test("GitHub verifier checks PR and Check Run through single-object endpoints", async () => {
  const pullRequest = githubPullRequestClaim();
  const check = githubCheckClaim();
  const calls: string[] = [];
  const responses = [
    jsonResponse({
      id: 601,
      number: 2,
      html_url: pullRequest.url,
      updated_at:
        pullRequest.sourceRevisionId,
      head: { sha: "abc123" }
    }),
    jsonResponse({
      id: 701,
      name: "tests",
      status: "completed",
      conclusion: "success",
      head_sha: "abc123",
      details_url: check.url,
      completed_at: check.sourceRevisionId
    })
  ];
  const verifier =
    createReadOnlyProviderFactProvenanceVerifier({
      github: {
        fetchImpl: async (url) => {
          calls.push(url);
          return responses.shift();
        }
      }
    });

  const result = await verifier.verify([
    pullRequest,
    check
  ]) as ProviderFactProvenanceVerificationResult[];

  assert.equal(
    result.every(
      (item) => item.outcome === "verified"
    ),
    true
  );
  assert.deepEqual(calls, [
    "https://api.github.com/repos/netpilot-z/taskseal/pulls/2",
    "https://api.github.com/repos/netpilot-z/taskseal/check-runs/701"
  ]);
});

test("GitHub readable ID, URL, revision, or content drift is a mismatch", async () => {
  const claim = githubIssueClaim();
  const verifier =
    createReadOnlyProviderFactProvenanceVerifier({
      github: {
        fetchImpl: async () =>
          jsonResponse({
            id: 999,
            number: 1,
            title: "Different current title",
            html_url: claim.url,
            created_at:
              "2026-07-26T08:00:00.000Z",
            updated_at:
              "2026-07-26T09:00:00.000Z"
          })
      }
    });

  assert.deepEqual(
    await verifier.verify([claim]),
    [
      {
        schemaVersion: 1,
        claimDigest: claim.claimDigest,
        outcome: "mismatch"
      }
    ]
  );
});

test("GitHub Issue rejects each independently drifted identity, locator, revision, or content field", async (t) => {
  const claim = githubIssueClaim();
  const base = githubIssueResponse(claim);
  const cases = [
    ["database ID", { ...base, id: 999 }],
    ["number", { ...base, number: 2 }],
    [
      "URL",
      {
        ...base,
        html_url:
          "https://github.com/netpilot-z/TaskSeal/issues/2"
      }
    ],
    [
      "revision",
      {
        ...base,
        updated_at:
          "2026-07-26T09:00:00.000Z"
      }
    ],
    [
      "title content",
      {
        ...base,
        title: "Different title"
      }
    ],
    [
      "created content",
      {
        ...base,
        created_at:
          "2026-07-25T08:00:00.000Z"
      }
    ]
  ] as const;

  for (const [name, response] of cases) {
    await t.test(name, async () => {
      assert.equal(
        await verifyOneGitHubClaim(
          claim,
          response
        ),
        "mismatch"
      );
    });
  }
});

test("GitHub PR and Check reject each independently drifted remote field", async (t) => {
  const pullRequest = githubPullRequestClaim();
  const pullRequestBase =
    githubPullRequestResponse(pullRequest);
  const pullRequestCases = [
    ["database ID", { ...pullRequestBase, id: 999 }],
    ["number", { ...pullRequestBase, number: 3 }],
    [
      "URL",
      {
        ...pullRequestBase,
        html_url:
          "https://github.com/netpilot-z/TaskSeal/pull/3"
      }
    ],
    [
      "revision",
      {
        ...pullRequestBase,
        updated_at:
          "2026-07-26T09:00:00.000Z"
      }
    ],
    [
      "head content",
      {
        ...pullRequestBase,
        head: { sha: "different" }
      }
    ]
  ] as const;

  for (const [name, response] of pullRequestCases) {
    await t.test(`PR ${name}`, async () => {
      assert.equal(
        await verifyOneGitHubClaim(
          pullRequest,
          response
        ),
        "mismatch"
      );
    });
  }

  const check = githubCheckClaim();
  const checkBase = githubCheckResponse(check);
  const checkCases = [
    ["database ID", { ...checkBase, id: 999 }],
    [
      "details URL",
      {
        ...checkBase,
        details_url:
          "https://github.com/netpilot-z/TaskSeal/actions/runs/8"
      }
    ],
    [
      "revision",
      {
        ...checkBase,
        completed_at:
          "2026-07-26T09:00:00.000Z"
      }
    ],
    [
      "status",
      {
        ...checkBase,
        status: "in_progress",
        conclusion: null,
        completed_at: null
      }
    ],
    [
      "outcome content",
      {
        ...checkBase,
        conclusion: "failure"
      }
    ],
    [
      "head content",
      {
        ...checkBase,
        head_sha: "different"
      }
    ]
  ] as const;

  for (const [name, response] of checkCases) {
    await t.test(`Check ${name}`, async () => {
      assert.equal(
        await verifyOneGitHubClaim(
          check,
          response
        ),
        "mismatch"
      );
    });
  }
});

test("GitHub verifier treats an unknown Check conclusion as unavailable instead of failed evidence", async () => {
  const check = githubCheckClaim();
  const verifier =
    createReadOnlyProviderFactProvenanceVerifier({
      github: {
        fetchImpl: async () =>
          jsonResponse({
            ...githubCheckResponse(check),
            conclusion:
              "not-a-github-conclusion"
          })
      }
    });

  await assert.rejects(
    verifier.verify([check])
  );
});

test("provider re-reads use at most four concurrent requests", async () => {
  const claims = Array.from(
    { length: 5 },
    (_, index) =>
      githubIssueClaimFor(index + 1)
  );
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  let releaseReads = (): void => {};
  const readsReleased = new Promise<void>(
    (resolve) => {
      releaseReads = resolve;
    }
  );
  const verifier =
    createReadOnlyProviderFactProvenanceVerifier({
      github: {
        fetchImpl: async (url) => {
          calls += 1;
          active += 1;
          maximumActive = Math.max(
            maximumActive,
            active
          );
          const issueNumber = Number(
            /\/issues\/([1-9]\d*)$/.exec(url)?.[1]
          );
          await readsReleased;
          active -= 1;
          return jsonResponse(
            githubIssueResponse(
              githubIssueClaimFor(issueNumber)
            )
          );
        }
      }
    });
  const verification = verifier.verify(claims);

  try {
    await new Promise<void>((resolve) =>
      setImmediate(resolve)
    );
    assert.equal(calls, 4);
    assert.equal(maximumActive, 4);
  } finally {
    releaseReads();
  }

  const results =
    await verification as ProviderFactProvenanceVerificationResult[];
  assert.equal(calls, 5);
  assert.equal(
    results.every(
      (result) => result.outcome === "verified"
    ),
    true
  );
});

test("provider re-reads reject request timeouts above the bounded budget", async () => {
  let calls = 0;
  const verifier =
    createReadOnlyProviderFactProvenanceVerifier({
      github: {
        timeoutMs: 15_001,
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse({});
        }
      }
    });

  await assert.rejects(
    verifier.verify([githubIssueClaim()])
  );
  assert.equal(calls, 0);
});

test("provider re-reads have a verifier-wide deadline even when an injected fetch ignores AbortSignal", async () => {
  let calls = 0;
  const verifier =
    createReadOnlyProviderFactProvenanceVerifier({
      totalTimeoutMs: 10,
      github: {
        fetchImpl: async () => {
          calls += 1;
          return new Promise<never>(() => {});
        }
      }
    });

  await assert.rejects(
    verifier.verify([githubIssueClaim()])
  );
  assert.equal(calls, 1);

  const invalidBudget =
    createReadOnlyProviderFactProvenanceVerifier({
      totalTimeoutMs: 30_001,
      github: {
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse({});
        }
      }
    });
  await assert.rejects(
    invalidBudget.verify([githubIssueClaim()])
  );
  assert.equal(calls, 1);
});

test("Linear verifier binds Organization, Team, UUID, identifier, URL, revision, and content in one query", async () => {
  const claim = linearIssueClaim();
  const calls: Array<{
    url: string;
    body: unknown;
  }> = [];
  const verifier =
    createReadOnlyProviderFactProvenanceVerifier({
      linear: {
        apiKey: "linear-secret",
        expectedProjectId:
          LINEAR_PROJECT_ID,
        fetchImpl: async (url, options) => {
          calls.push({
            url,
            body: JSON.parse(options.body)
          });
          return jsonResponse({
            data: {
              organization: {
                id: LINEAR_ORGANIZATION_ID
              },
              issue: {
                id: LINEAR_ISSUE_ID,
                identifier: "NET-7",
                title:
                  "Import a Linear issue safely",
                description: null,
                url: claim.url,
                createdAt:
                  "2026-07-26T08:00:00.000Z",
                updatedAt:
                  claim.sourceRevisionId,
                team: {
                  id: LINEAR_TEAM_ID,
                  key: "NET"
                },
                project: {
                  id: LINEAR_PROJECT_ID,
                  name: "TaskSeal"
                }
              }
            }
          });
        }
      }
    });

  const result = await verifier.verify([
    claim
  ]) as ProviderFactProvenanceVerificationResult[];

  assert.equal(result[0]?.outcome, "verified");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    "https://api.linear.app/graphql"
  );
  assert.equal(
    readVariables(calls[0]?.body).id,
    LINEAR_ISSUE_ID
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /linear-secret/
  );
});

test("Linear readable scope or locator drift is a mismatch while transport failures stay unavailable", async () => {
  const claim = linearIssueClaim();
  const mismatchVerifier =
    createReadOnlyProviderFactProvenanceVerifier({
      linear: {
        apiKey: "linear-secret",
        expectedProjectId:
          LINEAR_PROJECT_ID,
        fetchImpl: async () =>
          jsonResponse({
            data: {
              organization: {
                id: LINEAR_ORGANIZATION_ID
              },
              issue: {
                id: LINEAR_ISSUE_ID,
                identifier: "OTHER-7",
                title:
                  "Import a Linear issue safely",
                description: null,
                url: claim.url,
                createdAt:
                  "2026-07-26T08:00:00.000Z",
                updatedAt:
                  claim.sourceRevisionId,
                team: {
                  id: "44444444-4444-4444-8444-444444444444",
                  key: "OTHER"
                },
                project: {
                  id: LINEAR_PROJECT_ID,
                  name: "TaskSeal"
                }
              }
            }
          })
      }
    });
  const unavailableVerifier =
    createReadOnlyProviderFactProvenanceVerifier({
      linear: {
        apiKey: "linear-secret",
        expectedProjectId:
          LINEAR_PROJECT_ID,
        fetchImpl: async () => {
          throw new Error("network detail");
        }
      }
    });

  const mismatchResult =
    await mismatchVerifier.verify([
      claim
    ]) as ProviderFactProvenanceVerificationResult[];
  assert.equal(
    mismatchResult[0]?.outcome,
    "mismatch"
  );
  await assert.rejects(
    unavailableVerifier.verify([claim])
  );
});

test("Linear rejects each independently drifted scope, identity, locator, revision, or content field", async (t) => {
  const claim = linearIssueClaim();
  const base = linearIdentityResponse(claim);
  const baseIssue = required(
    base.data.issue
  );
  const cases: Array<{
    name: string;
    response: ReturnType<
      typeof linearIdentityResponse
    >;
  }> = [
    {
      name: "Organization ID",
      response: {
        ...base,
        data: {
          ...base.data,
          organization: {
            id:
              "44444444-4444-4444-8444-444444444444"
          }
        }
      }
    },
    {
      name: "Team ID",
      response: replaceLinearIssue(base, {
        ...baseIssue,
        team: {
          ...baseIssue.team,
          id:
            "44444444-4444-4444-8444-444444444444"
        }
      })
    },
    {
      name: "Project ID",
      response: replaceLinearIssue(base, {
        ...baseIssue,
        project: {
          ...baseIssue.project,
          id:
            "44444444-4444-4444-8444-444444444444"
        }
      })
    },
    {
      name: "Issue UUID",
      response: replaceLinearIssue(base, {
        ...baseIssue,
        id:
          "44444444-4444-4444-8444-444444444444"
      })
    },
    {
      name: "identifier",
      response: replaceLinearIssue(base, {
        ...baseIssue,
        identifier: "NET-8"
      })
    },
    {
      name: "Team key relation",
      response: replaceLinearIssue(base, {
        ...baseIssue,
        team: {
          ...baseIssue.team,
          key: "OTHER"
        }
      })
    },
    {
      name: "URL",
      response: replaceLinearIssue(base, {
        ...baseIssue,
        url:
          "https://linear.app/taskseal/issue/NET-8/example"
      })
    },
    {
      name: "revision",
      response: replaceLinearIssue(base, {
        ...baseIssue,
        updatedAt:
          "2026-07-26T09:00:00.000Z"
      })
    },
    {
      name: "title content",
      response: replaceLinearIssue(base, {
        ...baseIssue,
        title: "Different title"
      })
    },
    {
      name: "created content",
      response: replaceLinearIssue(base, {
        ...baseIssue,
        createdAt:
          "2026-07-25T08:00:00.000Z"
      })
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const verifier =
        createReadOnlyProviderFactProvenanceVerifier({
          linear: {
            apiKey: "linear-test-key",
            expectedProjectId:
              LINEAR_PROJECT_ID,
            fetchImpl: async () =>
              jsonResponse(scenario.response)
          }
        });
      const result = await verifier.verify([
        claim
      ]) as ProviderFactProvenanceVerificationResult[];

      assert.equal(
        result[0]?.outcome,
        "mismatch"
      );
    });
  }
});

function githubIssueClaim():
  ProviderFactProvenanceClaim {
  const plan = createPreviewPlan();
  return required(
    collectProviderFactProvenanceClaims({
      plan,
      baseWorkflow: createWorkflow()
    })[0]
  );
}

function githubIssueResponse(
  claim: ProviderFactProvenanceClaim
) {
  return {
    id: Number(claim.externalId),
    number:
      claim.locator.kind === "github.issue"
        ? claim.locator.number
        : 1,
    title: "Apply a provider snapshot safely",
    html_url: claim.url,
    created_at:
      "2026-07-26T08:00:00.000Z",
    updated_at: claim.sourceRevisionId
  };
}

function githubIssueClaimFor(
  issueNumber: number
): ProviderFactProvenanceClaim {
  const externalId = String(500 + issueNumber);
  const sourceObject = {
    providerObjectKey:
      `github:issue:${externalId}`,
    provider: "github" as const,
    objectType: "issue" as const,
    externalId,
    url:
      "https://github.com/netpilot-z/TaskSeal/issues/" +
      issueNumber
  };

  return withDigest({
    schemaVersion: 1,
    provider: "github",
    objectType: "issue",
    providerObjectKey:
      sourceObject.providerObjectKey,
    externalId,
    scopeRef: GITHUB_SCOPE,
    url: sourceObject.url,
    sourceRevisionId:
      "2026-07-26T08:01:00.000Z",
    sourceOccurredAt:
      "2026-07-26T08:01:00.000Z",
    eventType: "work_item.created",
    eventOccurredAt:
      "2026-07-26T08:00:00.000Z",
    contentDigest: digestProviderFactContent({
      sourceObject,
      observed: {
        title:
          "Apply a provider snapshot safely",
        createdAt:
          "2026-07-26T08:00:00.000Z"
      }
    }),
    content: {
      kind: "issue",
      title:
        "Apply a provider snapshot safely"
    },
    locator: {
      kind: "github.issue",
      number: issueNumber
    }
  });
}

function githubPullRequestResponse(
  claim: ProviderFactProvenanceClaim
) {
  return {
    id: 601,
    number: 2,
    html_url: claim.url,
    updated_at: claim.sourceRevisionId,
    head: { sha: "abc123" }
  };
}

function githubCheckResponse(
  claim: ProviderFactProvenanceClaim
) {
  return {
    id: 701,
    name: "tests",
    status: "completed",
    conclusion: "success",
    head_sha: "abc123",
    details_url: claim.url,
    completed_at: claim.sourceRevisionId
  };
}

async function verifyOneGitHubClaim(
  claim: ProviderFactProvenanceClaim,
  response: unknown
): Promise<"verified" | "mismatch"> {
  const verifier =
    createReadOnlyProviderFactProvenanceVerifier({
      github: {
        fetchImpl: async () =>
          jsonResponse(response)
      }
    });
  const result = await verifier.verify([
    claim
  ]) as ProviderFactProvenanceVerificationResult[];
  return required(result[0]).outcome;
}

function linearIssueClaim():
  ProviderFactProvenanceClaim {
  const plan = createPreviewPlan({
    snapshot: createLinearIssueSnapshot(),
    importPolicy: createLinearImportPolicy()
  });
  return required(
    collectProviderFactProvenanceClaims({
      plan,
      baseWorkflow: createWorkflow()
    })[0]
  );
}

function linearIdentityResponse(
  claim: ProviderFactProvenanceClaim
) {
  return {
    data: {
      organization: {
        id: LINEAR_ORGANIZATION_ID
      },
      issue: {
        id: LINEAR_ISSUE_ID,
        identifier: "NET-7",
        title: "Import a Linear issue safely",
        description: null,
        url: claim.url,
        createdAt:
          "2026-07-26T08:00:00.000Z",
        updatedAt: claim.sourceRevisionId,
        team: {
          id: LINEAR_TEAM_ID,
          key: "NET"
        },
        project: {
          id: LINEAR_PROJECT_ID,
          name: "TaskSeal"
        }
      }
    }
  };
}

function replaceLinearIssue(
  response: ReturnType<
    typeof linearIdentityResponse
  >,
  issue: ReturnType<
    typeof linearIdentityResponse
  >["data"]["issue"]
): ReturnType<typeof linearIdentityResponse> {
  return {
    ...response,
    data: {
      ...response.data,
      issue
    }
  };
}

function githubPullRequestClaim():
  ProviderFactProvenanceClaim {
  const sourceObject = {
    providerObjectKey: "github:pull_request:601",
    provider: "github" as const,
    objectType: "pull_request" as const,
    externalId: "601",
    url:
      "https://github.com/netpilot-z/TaskSeal/pull/2"
  };
  return withDigest({
    schemaVersion: 1,
    provider: "github",
    objectType: "pull_request",
    providerObjectKey:
      sourceObject.providerObjectKey,
    externalId: sourceObject.externalId,
    scopeRef: GITHUB_SCOPE,
    url: sourceObject.url,
    sourceRevisionId:
      "2026-07-26T08:03:00.000Z",
    sourceOccurredAt:
      "2026-07-26T08:03:00.000Z",
    eventType: "artifact.linked",
    eventOccurredAt:
      "2026-07-26T08:03:00.000Z",
    contentDigest: digestProviderFactContent({
      sourceObject,
      observed: {
        headRevision: "abc123"
      }
    }),
    content: {
      kind: "pull_request",
      headRevision: "abc123"
    },
    locator: {
      kind: "github.pull_request",
      number: 2
    }
  });
}

function githubCheckClaim():
  ProviderFactProvenanceClaim {
  const sourceObject = {
    providerObjectKey: "github:check:701",
    provider: "github" as const,
    objectType: "check" as const,
    externalId: "701",
    url:
      "https://github.com/netpilot-z/TaskSeal/actions/runs/7"
  };
  return withDigest({
    schemaVersion: 1,
    provider: "github",
    objectType: "check",
    providerObjectKey:
      sourceObject.providerObjectKey,
    externalId: sourceObject.externalId,
    scopeRef: GITHUB_SCOPE,
    url: sourceObject.url,
    sourceRevisionId:
      "2026-07-26T08:04:00.000Z",
    sourceOccurredAt:
      "2026-07-26T08:04:00.000Z",
    eventType: "evidence.recorded",
    eventOccurredAt:
      "2026-07-26T08:04:00.000Z",
    contentDigest: digestProviderFactContent({
      sourceObject,
      observed: {
        headRevision: "abc123",
        outcome: "passed"
      }
    }),
    content: {
      kind: "check",
      headRevision: "abc123",
      outcome: "passed"
    },
    locator: {
      kind: "github.check_run",
      id: "701"
    }
  });
}

function withDigest(
  content: Omit<
    ProviderFactProvenanceClaim,
    "claimDigest"
  >
): ProviderFactProvenanceClaim {
  return {
    ...content,
    claimDigest:
      computeProviderFactProvenanceClaimDigest(
        content
      )
  };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: {
      get(): null {
        return null;
      }
    },
    async json() {
      return body;
    }
  };
}

function readVariables(
  value: unknown
): Record<string, unknown> {
  if (
    value !== null &&
    typeof value === "object" &&
    "variables" in value &&
    value.variables !== null &&
    typeof value.variables === "object"
  ) {
    return value.variables as Record<
      string,
      unknown
    >;
  }

  throw new Error("GraphQL variables are required");
}

function required<T>(
  value: T | null | undefined
): T {
  if (value === null || value === undefined) {
    throw new Error("value is required");
  }

  return value;
}
