import assert from "node:assert/strict";
import test from "node:test";

import {
  previewSnapshotImport
} from "../src/application/snapshot-import.ts";
import {
  applyEvent,
  createWorkflow
} from "../src/domain/workflow.ts";
import {
  normalizeGitHubCheckFact,
  normalizeGitHubPullRequestFact,
  normalizeGitHubPullRequestReviewFact
} from "../src/connectors/github.ts";
import type {
  ProviderSnapshotV2
} from "../src/lib/provider-snapshot.ts";
import {
  digestProviderFactContent
} from "../src/lib/provider-snapshot.ts";

const DELIVERY_BINDING_DIGEST =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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

const CHECK = {
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

test("delivery facts bind one PR and multiple evidence criteria to the same attempt and head", () => {
  const snapshot =
    createDeliverySnapshot();
  const workflow =
    createRunningWorkflow();
  const plan = previewSnapshotImport({
    snapshot,
    workflow,
    importPolicy: createPolicy()
  });

  assert.equal(plan.conflicts.length, 0);
  assert.deepEqual(
    plan.events.map((event) => [
      event.type,
      event.type ===
        "evidence.recorded"
        ? event.payload.criterionKey
        : event.payload.revision
    ]),
    [
      ["artifact.linked", "abc123"],
      ["evidence.recorded", "review"],
      ["evidence.recorded", "tests"]
    ]
  );
  assert.equal(
    new Set(
      plan.events.map(
        (event) => event.eventId
      )
    ).size,
    3
  );
  assert.equal(
    snapshot.facts.every((fact) =>
      fact.candidateEvent.eventId.startsWith(
        "github:delivery:"
      )
    ),
    true
  );
});

test("same PR head event identity is stable across unrelated PR metadata updates", () => {
  const first =
    normalizeGitHubPullRequestFact(
      PULL_REQUEST,
      artifactMapping()
    );
  const second =
    normalizeGitHubPullRequestFact(
      {
        ...PULL_REQUEST,
        updated_at:
          "2026-07-28T10:06:00.000Z"
      },
      artifactMapping()
    );

  assert.equal(
    first.candidateEvent.eventId,
    second.candidateEvent.eventId
  );
  assert.notEqual(
    first.revision.id,
    second.revision.id
  );
});

test("review evidence rejects comments, foreign heads, and the wrong mapped reviewer", () => {
  for (const review of [
    {
      ...REVIEW,
      state: "COMMENTED"
    },
    {
      ...REVIEW,
      commit_id: "old-head"
    },
    {
      ...REVIEW,
      user: {
        id: 9999,
        login: "other"
      }
    }
  ]) {
    assert.throws(
      () =>
        normalizeGitHubPullRequestReviewFact(
          review,
          PULL_REQUEST,
          evidenceMapping({
            criterionKey: "review",
            reviewerId: "9001"
          })
        )
    );
  }
});

test("multi-evidence snapshot rejects unmapped or duplicate criterion bindings", () => {
  const snapshot =
    createDeliverySnapshot();
  const first =
    snapshot.mapping.evidenceBindings?.[0];
  assert.ok(first);
  snapshot.mapping.evidenceBindings = [
    first,
    {
      ...first,
      providerObjectKey:
        "github:check:701"
    }
  ];

  assert.throws(
    () =>
      previewSnapshotImport({
        snapshot,
        workflow:
          createRunningWorkflow(),
        importPolicy: createPolicy()
      }),
    hasCode("SNAPSHOT_INVALID")
  );
});

test("delivery snapshot binds PR and review locators to the mapped pull request number", () => {
  for (const objectType of [
    "pull_request",
    "pull_request_review"
  ] as const) {
    const snapshot =
      createDeliverySnapshot();
    const fact = snapshot.facts.find(
      (candidate) =>
        candidate.sourceObject
          .objectType === objectType
    );
    assert.ok(fact);
    const badUrl =
      objectType === "pull_request"
        ? "https://github.com/netpilot-z/TaskSeal/pull/59"
        : "https://github.com/netpilot-z/TaskSeal/pull/59#pullrequestreview-801";
    fact.sourceObject.url = badUrl;
    if (
      fact.candidateEvent.type ===
        "artifact.linked" ||
      fact.candidateEvent.type ===
        "evidence.recorded"
    ) {
      fact.candidateEvent.payload.url =
        badUrl;
    } else {
      assert.fail(
        "expected delivery candidate"
      );
    }
    fact.revision.contentDigest =
      digestProviderFactContent(
        fact
      );

    assert.throws(
      () =>
        previewSnapshotImport({
          snapshot,
          workflow:
            createRunningWorkflow(),
          importPolicy:
            createPolicy()
        }),
      hasCode("SNAPSHOT_INVALID")
    );
  }
});

test("delivery evidence facts and mappings bind the configured selector identity", () => {
  const snapshot =
    createDeliverySnapshot();
  const check = snapshot.facts.find(
    (fact) =>
      fact.sourceObject.objectType ===
      "check"
  );
  assert.ok(check);
  assert.deepEqual(check.observed, {
    headRevision: "abc123",
    outcome: "passed",
    name: "tests",
    appId: "15368",
    pullRequestRevisionId:
      "2026-07-28T10:03:00.000Z"
  });
  assert.deepEqual(
    snapshot.mapping.evidenceBindings,
    [
      {
        providerObjectKey:
          "github:check:701",
        criterionKey: "tests",
        source: {
          kind: "check_run",
          name: "tests",
          appId: "15368"
        }
      },
      {
        providerObjectKey:
          "github:pull_request_review:801",
        criterionKey: "review",
        source: {
          kind:
            "pull_request_review",
          reviewerId: "9001"
        }
      }
    ]
  );

  for (const mutation of [
    {
      index: 0,
      source: {
        kind: "check_run",
        name: "foreign",
        appId: "15368"
      }
    },
    {
      index: 1,
      source: {
        kind:
          "pull_request_review",
        reviewerId: "9002"
      }
    }
  ] as const) {
    const forged =
      structuredClone(snapshot);
    const binding =
      forged.mapping
        .evidenceBindings?.[
          mutation.index
        ];
    assert.ok(binding);
    Object.assign(
      binding,
      {
        source:
          structuredClone(
            mutation.source
          )
      }
    );

    assert.throws(
      () =>
        previewSnapshotImport({
          snapshot: forged,
          workflow:
            createRunningWorkflow(),
          importPolicy:
            createPolicy()
        }),
      hasCode("SNAPSHOT_INVALID")
    );
  }

  const forgedRevision =
    structuredClone(snapshot);
  const forgedCheck =
    forgedRevision.facts.find(
      (fact) =>
        fact.sourceObject.objectType ===
        "check"
    );
  assert.ok(
    forgedCheck?.sourceObject
      .objectType === "check"
  );
  assert.ok(
    "pullRequestRevisionId" in
      forgedCheck.observed
  );
  forgedCheck.observed
    .pullRequestRevisionId =
    "2026-07-28T10:06:00.000Z";
  assert.throws(
    () =>
      previewSnapshotImport({
        snapshot: forgedRevision,
        workflow:
          createRunningWorkflow(),
        importPolicy:
          createPolicy()
      }),
    hasCode("SNAPSHOT_INVALID")
  );
});

function createDeliverySnapshot():
  ProviderSnapshotV2 {
  const pullRequest =
    normalizeGitHubPullRequestFact(
      PULL_REQUEST,
      artifactMapping()
    );
  const check = normalizeGitHubCheckFact(
    CHECK,
    evidenceMapping({
      criterionKey: "tests"
    })
  );
  const review =
    normalizeGitHubPullRequestReviewFact(
      REVIEW,
      PULL_REQUEST,
      evidenceMapping({
        criterionKey: "review",
        reviewerId: "9001"
      })
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
      requiredEvidence: [
        "tests",
        "review"
      ],
      managedFields: [],
      attemptId: "attempt-1",
      artifactId: "pr-601",
      artifactRevision: "abc123",
      deliveryBindingDigest:
        DELIVERY_BINDING_DIGEST,
      pullRequestNumber: 58,
      evidenceBindings: [
        {
          providerObjectKey:
            check.sourceObject
              .providerObjectKey,
          criterionKey: "tests",
          source: {
            kind: "check_run",
            name: "tests",
            appId: "15368"
          }
        },
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
      "2026-07-28T10:06:00.000Z",
    facts: [
      pullRequest,
      check,
      review
    ]
  };
}

function artifactMapping() {
  return {
    workItemId: "TS-NP-6",
    attemptId: "attempt-1",
    deliveryBindingDigest:
      DELIVERY_BINDING_DIGEST
  };
}

function evidenceMapping({
  criterionKey,
  reviewerId
}: {
  criterionKey: string;
  reviewerId?: string;
}) {
  return {
    workItemId: "TS-NP-6",
    attemptId: "attempt-1",
    artifactId: "pr-601",
    criterionKey,
    deliveryBindingDigest:
      DELIVERY_BINDING_DIGEST,
    pullRequestNumber: 58,
    ...(reviewerId === undefined
      ? {
          checkName: "tests",
          checkAppId: "15368",
          pullRequestRevisionId:
            "2026-07-28T10:03:00.000Z"
        }
      : {}),
    ...(reviewerId === undefined
      ? {}
      : { reviewerId })
  };
}

function createRunningWorkflow() {
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
        title: "Collect delivery facts",
        requiredEvidence: [
          "tests",
          "review"
        ],
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

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}
