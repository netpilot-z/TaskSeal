import assert from "node:assert/strict";
import test from "node:test";

import {
  collectProviderFactProvenanceClaims
} from "../src/application/provider-fact-provenance.ts";
import {
  previewSnapshotImport
} from "../src/application/snapshot-import.ts";
import {
  createReadOnlyProviderFactProvenanceVerifier
} from "../src/connectors/provider-fact-provenance-verifier.ts";
import {
  normalizeGitHubCheckFact,
  normalizeGitHubPullRequestFact,
  normalizeGitHubPullRequestReviewFact
} from "../src/connectors/github.ts";
import {
  applyEvent,
  createWorkflow
} from "../src/domain/workflow.ts";

const BINDING_DIGEST =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
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
const REVIEW = {
  id: 801,
  html_url:
    "https://github.com/netpilot-z/TaskSeal/pull/58#pullrequestreview-801",
  state: "APPROVED",
  submitted_at:
    "2026-07-28T10:02:00.000Z",
  commit_id: "abc123",
  user: {
    id: 9001,
    login: "reviewer"
  }
};
const CHECK = {
  id: 701,
  name: "test",
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

test("review provenance binds exact PR, review, reviewer, state, and current head", async () => {
  const baseWorkflow =
    createRunningWorkflow();
  const plan = previewSnapshotImport({
    snapshot: createSnapshot(),
    workflow: baseWorkflow,
    importPolicy: createPolicy()
  });
  const claims =
    collectProviderFactProvenanceClaims({
      plan,
      baseWorkflow
    });
  const review = claims.find(
    (claim) =>
      claim.objectType ===
      "pull_request_review"
  );

  assert.ok(review);
  assert.deepEqual(review.locator, {
    kind:
      "github.pull_request_review",
    pullRequestNumber: 58,
    id: "801"
  });
  assert.deepEqual(review.content, {
    kind: "pull_request_review",
    headRevision: "abc123",
    reviewerId: "9001",
    state: "approved",
    outcome: "passed"
  });
  assert.equal(
    review.sourceRevisionId,
    "2026-07-28T10:03:00.000Z:approved"
  );

  const calls: string[] = [];
  const verifier =
    createReadOnlyProviderFactProvenanceVerifier({
      github: {
        fetchImpl: async (url) => {
          calls.push(url);
          return jsonResponse(
            url.endsWith("/reviews/801")
              ? REVIEW
              : PULL_REQUEST
          );
        }
      }
    });
  const results =
    await verifier.verify(claims);
  assert.ok(Array.isArray(results));
  const typedResults = results as Array<{
    claimDigest: string;
    outcome: "verified" | "mismatch";
  }>;

  assert.equal(
    typedResults.every(
      (result) =>
        result.outcome === "verified"
    ),
    true
  );
  assert.equal(
    calls.every((url) =>
      url.startsWith(
        "https://api.github.com/repos/netpilot-z/taskseal/"
      )
    ),
    true
  );
});

test("review provenance reports mismatch for a stale review head", async () => {
  const baseWorkflow =
    createRunningWorkflow();
  const plan = previewSnapshotImport({
    snapshot: createSnapshot(),
    workflow: baseWorkflow,
    importPolicy: createPolicy()
  });
  const claims =
    collectProviderFactProvenanceClaims({
      plan,
      baseWorkflow
    });
  const verifier =
    createReadOnlyProviderFactProvenanceVerifier({
      github: {
        fetchImpl: async (url) =>
          jsonResponse(
            url.endsWith("/reviews/801")
              ? {
                  ...REVIEW,
                  commit_id: "old-head"
                }
              : PULL_REQUEST
          )
      }
    });
  const results =
    await verifier.verify(claims);
  assert.ok(Array.isArray(results));
  const typedResults = results as Array<{
    claimDigest: string;
    outcome: "verified" | "mismatch";
  }>;
  const reviewClaim = claims.find(
    (claim) =>
      claim.objectType ===
      "pull_request_review"
  );
  assert.ok(reviewClaim);
  assert.equal(
    typedResults.find(
      (result) =>
        result.claimDigest ===
        reviewClaim.claimDigest
    )?.outcome,
    "mismatch"
  );
});

test("review provenance reads the PR head after the exact review as its final fence", async () => {
  const baseWorkflow =
    createRunningWorkflow();
  const plan = previewSnapshotImport({
    snapshot: createSnapshot(),
    workflow: baseWorkflow,
    importPolicy: createPolicy()
  });
  const claims =
    collectProviderFactProvenanceClaims({
      plan,
      baseWorkflow
    });
  const reviewClaim = claims.find(
    (claim) =>
      claim.objectType ===
      "pull_request_review"
  );
  assert.ok(reviewClaim);

  let exactReviewRead = false;
  const verifier =
    createReadOnlyProviderFactProvenanceVerifier({
      github: {
        fetchImpl: async (url) => {
          if (
            url.endsWith("/reviews/801")
          ) {
            exactReviewRead = true;
            return jsonResponse(REVIEW);
          }

          return jsonResponse(
            exactReviewRead
              ? {
                  ...PULL_REQUEST,
                  updated_at:
                    "2026-07-28T10:06:00.000Z",
                  head: {
                    ...PULL_REQUEST.head,
                    sha: "new-head"
                  }
                }
              : PULL_REQUEST
          );
        }
      }
    });

  const results =
    await verifier.verify(claims);
  assert.ok(Array.isArray(results));
  const typedResults = results as Array<{
    claimDigest: string;
    outcome: "verified" | "mismatch";
  }>;
  assert.equal(
    typedResults.find(
      (result) =>
        result.claimDigest ===
        reviewClaim.claimDigest
    )?.outcome,
    "mismatch"
  );
});

test("delivery check provenance re-reads the mapped PR and rejects a newer current head", async () => {
  const baseWorkflow =
    createRunningWorkflow(["tests"]);
  const plan = previewSnapshotImport({
    snapshot: createCheckSnapshot(),
    workflow: baseWorkflow,
    importPolicy: createPolicy()
  });
  const claims =
    collectProviderFactProvenanceClaims({
      plan,
      baseWorkflow
    });
  const checkClaim = claims.find(
    (claim) =>
      claim.objectType === "check"
  );
  assert.ok(checkClaim);
  assert.deepEqual(
    checkClaim.locator,
    {
      kind: "github.check_run",
      id: "701",
      pullRequestNumber: 58
    }
  );

  const verifier =
    createReadOnlyProviderFactProvenanceVerifier({
      github: {
        fetchImpl: async (url) =>
          jsonResponse(
            url.endsWith(
              "/check-runs/701"
            )
              ? CHECK
              : {
                  ...PULL_REQUEST,
                  head: {
                    ...PULL_REQUEST.head,
                    sha: "new-head"
                  }
                }
          )
      }
    });
  const results =
    await verifier.verify(claims);
  assert.ok(Array.isArray(results));
  const typedResults = results as Array<{
    claimDigest: string;
    outcome: "verified" | "mismatch";
  }>;

  assert.equal(
    typedResults.find(
      (result) =>
        result.claimDigest ===
        checkClaim.claimDigest
    )?.outcome,
    "mismatch"
  );
});

test("delivery check provenance binds the selected check name and app identity", async () => {
  const baseWorkflow =
    createRunningWorkflow(["tests"]);
  const plan = previewSnapshotImport({
    snapshot: createCheckSnapshot(),
    workflow: baseWorkflow,
    importPolicy: createPolicy()
  });
  const claims =
    collectProviderFactProvenanceClaims({
      plan,
      baseWorkflow
    });
  const checkClaim = claims.find(
    (claim) =>
      claim.objectType === "check"
  );
  assert.ok(checkClaim);

  for (const changedCheck of [
    {
      ...CHECK,
      name: "renamed"
    },
    {
      ...CHECK,
      app: {
        id: 99999
      }
    }
  ]) {
    const verifier =
      createReadOnlyProviderFactProvenanceVerifier({
        github: {
          fetchImpl: async (url) =>
            jsonResponse(
              url.endsWith(
                "/check-runs/701"
              )
                ? changedCheck
                : PULL_REQUEST
            )
        }
      });
    const results =
      await verifier.verify(claims);
    assert.ok(Array.isArray(results));
    const typedResults =
      results as Array<{
        claimDigest: string;
        outcome:
          | "verified"
          | "mismatch";
      }>;

    assert.equal(
      typedResults.find(
        (result) =>
          result.claimDigest ===
          checkClaim.claimDigest
      )?.outcome,
      "mismatch"
    );
  }
});

test("delivery check provenance rejects a pull request head ABA across parallel claims", async () => {
  const baseWorkflow =
    createRunningWorkflow(["tests"]);
  const plan = previewSnapshotImport({
    snapshot: createCheckSnapshot(),
    workflow: baseWorkflow,
    importPolicy: createPolicy()
  });
  const claims =
    collectProviderFactProvenanceClaims({
      plan,
      baseWorkflow
    });
  const checkClaim = claims.find(
    (claim) =>
      claim.objectType === "check"
  );
  assert.ok(checkClaim);

  let releaseCheckRead:
    (() => void) | undefined;
  const artifactReadStarted =
    new Promise<void>((resolve) => {
      releaseCheckRead = resolve;
    });
  let pullRequestReads = 0;
  const verifier =
    createReadOnlyProviderFactProvenanceVerifier({
      github: {
        fetchImpl: async (url) => {
          if (
            url.endsWith(
              "/check-runs/701"
            )
          ) {
            await artifactReadStarted;
            return jsonResponse(CHECK);
          }

          pullRequestReads += 1;
          if (pullRequestReads === 1) {
            releaseCheckRead?.();
            return jsonResponse(
              PULL_REQUEST
            );
          }

          return jsonResponse({
            ...PULL_REQUEST,
            updated_at:
              "2026-07-28T10:06:00.000Z"
          });
        }
      }
    });
  const results =
    await verifier.verify(claims);
  assert.ok(Array.isArray(results));
  const typedResults =
    results as Array<{
      claimDigest: string;
      outcome:
        | "verified"
        | "mismatch";
    }>;

  assert.equal(pullRequestReads, 2);
  assert.equal(
    typedResults.find(
      (result) =>
        result.claimDigest ===
        checkClaim.claimDigest
    )?.outcome,
    "mismatch"
  );
});

test("delivery check provenance accepts same-head metadata drift when an evidence-only plan binds the current PR revision", async () => {
  const baseWorkflow = applyEvent(
    createRunningWorkflow(["tests"]),
    {
      eventId:
        "taskseal:TS-NP-6:artifact:abc123",
      workItemId: "TS-NP-6",
      type: "artifact.linked",
      occurredAt:
        "2026-07-28T10:03:00.000Z",
      payload: {
        artifactId: "pr-601",
        attemptId: "attempt-1",
        kind: "pull_request",
        revision: "abc123",
        url:
          "https://github.com/netpilot-z/TaskSeal/pull/58"
      }
    }
  );
  const currentPullRequest = {
    ...PULL_REQUEST,
    updated_at:
      "2026-07-28T10:06:00.000Z"
  };
  const snapshot = createCheckSnapshot(
    currentPullRequest
  );
  snapshot.facts =
    snapshot.facts.filter(
      (fact) =>
        fact.sourceObject.objectType ===
        "check"
    );
  const plan = previewSnapshotImport({
    snapshot,
    workflow: baseWorkflow,
    importPolicy: createPolicy()
  });
  assert.deepEqual(
    plan.events.map(
      (event) => event.type
    ),
    ["evidence.recorded"]
  );

  const claims =
    collectProviderFactProvenanceClaims({
      plan,
      baseWorkflow
    });
  const checkClaim = claims.find(
    (claim) =>
      claim.objectType === "check"
  );
  assert.ok(checkClaim);
  assert.deepEqual(
    checkClaim.locator,
    {
      kind: "github.check_run",
      id: "701",
      pullRequestNumber: 58
    }
  );
  const verifier =
    createReadOnlyProviderFactProvenanceVerifier({
      github: {
        fetchImpl: async (url) =>
          jsonResponse(
            url.endsWith(
              "/check-runs/701"
            )
              ? CHECK
              : currentPullRequest
          )
      }
    });
  const results =
    await verifier.verify(claims);
  assert.ok(Array.isArray(results));
  assert.equal(
    (
      results as Array<{
        claimDigest: string;
        outcome:
          | "verified"
          | "mismatch";
      }>
    ).find(
      (result) =>
        result.claimDigest ===
        checkClaim.claimDigest
    )?.outcome,
    "verified"
  );
});

function createSnapshot() {
  const artifact =
    normalizeGitHubPullRequestFact(
      PULL_REQUEST,
      {
        workItemId: "TS-NP-6",
        attemptId: "attempt-1",
        deliveryBindingDigest:
          BINDING_DIGEST
      }
    );
  const review =
    normalizeGitHubPullRequestReviewFact(
      REVIEW,
      PULL_REQUEST,
      {
        workItemId: "TS-NP-6",
        attemptId: "attempt-1",
        artifactId: "pr-601",
        criterionKey: "review",
        reviewerId: "9001",
        deliveryBindingDigest:
          BINDING_DIGEST,
        pullRequestNumber: 58
      }
    );

  return {
    schemaVersion: 2,
    mode: "read-only",
    provider: "github",
    scope: {
      kind: "repository",
      key:
        "github:repository:netpilot-z/taskseal"
    },
    mapping: {
      workItemId: "TS-NP-6",
      requiredEvidence: ["review"],
      managedFields: [],
      attemptId: "attempt-1",
      artifactId: "pr-601",
      artifactRevision: "abc123",
      deliveryBindingDigest:
        BINDING_DIGEST,
      pullRequestNumber: 58,
      evidenceBindings: [
        {
          providerObjectKey:
            review.sourceObject
              .providerObjectKey,
          criterionKey: "review",
          source: {
            kind:
              "pull_request_review",
            reviewerId: "9001"
          }
        }
      ]
    },
    capturedAt:
      "2026-07-28T10:04:00.000Z",
    facts: [artifact, review]
  };
}

function createCheckSnapshot(
  pullRequest = PULL_REQUEST
) {
  const artifact =
    normalizeGitHubPullRequestFact(
      pullRequest,
      {
        workItemId: "TS-NP-6",
        attemptId: "attempt-1",
        deliveryBindingDigest:
          BINDING_DIGEST
      }
    );
  const check =
    normalizeGitHubCheckFact(
      CHECK,
      {
        workItemId: "TS-NP-6",
        attemptId: "attempt-1",
        artifactId: "pr-601",
        criterionKey: "tests",
        deliveryBindingDigest:
          BINDING_DIGEST,
        pullRequestNumber: 58,
        checkName: "test",
        checkAppId: "15368",
        pullRequestRevisionId:
          pullRequest.updated_at
      }
    );

  return {
    schemaVersion: 2,
    mode: "read-only",
    provider: "github",
    scope: {
      kind: "repository",
      key:
        "github:repository:netpilot-z/taskseal"
    },
    mapping: {
      workItemId: "TS-NP-6",
      requiredEvidence: ["tests"],
      managedFields: [],
      attemptId: "attempt-1",
      artifactId: "pr-601",
      artifactRevision: "abc123",
      deliveryBindingDigest:
        BINDING_DIGEST,
      pullRequestNumber: 58,
      evidenceBindings: [
        {
          providerObjectKey:
            check.sourceObject
              .providerObjectKey,
          criterionKey: "tests",
          source: {
            kind: "check_run",
            name: "test",
            appId: "15368"
          }
        }
      ]
    },
    capturedAt:
      "2026-07-28T10:04:00.000Z",
    facts: [artifact, check]
  };
}

function createRunningWorkflow(
  requiredEvidence = ["review"]
) {
  const created = applyEvent(
    createWorkflow(),
    {
      eventId:
        "taskseal:TS-NP-6:created",
      workItemId: "TS-NP-6",
      type: "work_item.created",
      occurredAt:
        "2026-07-28T09:00:00.000Z",
      payload: {
        title: "Collect review",
        requiredEvidence,
        externalLink: {
          provider: "taskseal",
          externalId: "TS-NP-6",
          url:
            "http://127.0.0.1:4317/work-items/TS-NP-6"
        }
      }
    }
  );

  return applyEvent(created, {
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
  });
}

function createPolicy() {
  return {
    schemaVersion: 2,
    allowedScopes: [
      {
        provider: "github",
        scopeRef: {
          kind: "repository",
          key:
            "github:repository:netpilot-z/taskseal"
        },
        objectTypes: [
          "pull_request",
          "check",
          "pull_request_review"
        ],
        capabilities: {
          "snapshot.import.preview": true,
          "snapshot.import.apply": true
        }
      }
    ]
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
    async json(): Promise<unknown> {
      return body;
    }
  };
}
