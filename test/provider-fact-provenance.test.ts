import assert from "node:assert/strict";
import test from "node:test";

import {
  collectProviderFactProvenanceClaims,
  computeProviderFactProvenanceClaimDigest,
  verifyProviderFactProvenance
} from "../src/application/provider-fact-provenance.ts";
import type {
  ProviderFactProvenanceClaim,
  ProviderFactProvenanceVerifier
} from "../src/application/provider-fact-provenance.ts";
import {
  applyEvent,
  createWorkflow
} from "../src/domain/workflow.ts";
import type {
  CanonicalEvent
} from "../src/domain/workflow.ts";
import {
  createGitHubDeliverySnapshot,
  createGitHubIssueSnapshot,
  createImportPolicy,
  createLinearImportPolicy,
  createLinearIssueSnapshot,
  createPreviewPlan
} from "../test-support/snapshot-import-fixtures.ts";

test("collects one versioned GitHub Issue claim from the exact planned event", () => {
  const snapshot = createGitHubIssueSnapshot();
  const plan = createPreviewPlan({ snapshot });
  const claims = collectProviderFactProvenanceClaims({
    plan,
    baseWorkflow: createWorkflow()
  });

  assert.equal(claims.length, 1);
  assert.deepEqual(
    withoutDigest(required(claims[0])),
    {
      schemaVersion: 1,
      provider: "github",
      objectType: "issue",
      providerObjectKey: "github:issue:501",
      externalId: "501",
      scopeRef: {
        kind: "repository",
        key: "github:repository:netpilot-z/taskseal"
      },
      url:
        "https://github.com/netpilot-z/TaskSeal/issues/1",
      sourceRevisionId:
        "2026-07-26T08:01:00.000Z",
      sourceOccurredAt:
        "2026-07-26T08:01:00.000Z",
      eventType: "work_item.created",
      eventOccurredAt:
        "2026-07-26T08:00:00.000Z",
      contentDigest:
        snapshot.facts[0].revision.contentDigest,
      content: {
        kind: "issue",
        title:
          "Apply a provider snapshot safely"
      },
      locator: {
        kind: "github.issue",
        number: 1
      }
    }
  );
  assert.match(
    required(claims[0]).claimDigest,
    /^sha256:[0-9a-f]{64}$/
  );
});

test("collects a Linear UUID and identifier claim without persisting workspace credentials", () => {
  const snapshot = createLinearIssueSnapshot();
  const plan = createPreviewPlan({
    snapshot,
    importPolicy: createLinearImportPolicy()
  });
  const claims = collectProviderFactProvenanceClaims({
    plan,
    baseWorkflow: createWorkflow()
  });

  assert.deepEqual(
    withoutDigest(required(claims[0])),
    {
      schemaVersion: 1,
      provider: "linear",
      objectType: "issue",
      providerObjectKey:
        "linear:issue:11111111-1111-4111-8111-111111111111",
      externalId:
        "11111111-1111-4111-8111-111111111111",
      scopeRef: {
        kind: "team",
        key:
          "linear:team:22222222-2222-4222-8222-222222222222",
        parentKey:
          "linear:organization:33333333-3333-4333-8333-333333333333"
      },
      url:
        "https://linear.app/taskseal/issue/NET-7/example",
      sourceRevisionId:
        "2026-07-26T08:01:00.000Z",
      sourceOccurredAt:
        "2026-07-26T08:01:00.000Z",
      eventType: "work_item.created",
      eventOccurredAt:
        "2026-07-26T08:00:00.000Z",
      contentDigest:
        snapshot.facts[0].revision.contentDigest,
      content: {
        kind: "issue",
        title:
          "Import a Linear issue safely"
      },
      locator: {
        kind: "linear.issue",
        id:
          "11111111-1111-4111-8111-111111111111",
        identifier: "NET-7"
      }
    }
  );
});

test("collects and deduplicates GitHub PR and Check claims from their exact planned events", () => {
  const baseEvents: CanonicalEvent[] = [
    {
      eventId: "local:TS-1:created",
      workItemId: "TS-1",
      type: "work_item.created",
      occurredAt: "2026-07-26T08:00:00.000Z",
      payload: {
        title: "Local delivery",
        requiredEvidence: ["tests"],
        externalLink: {
          provider: "taskseal",
          externalId: "TS-1",
          url:
            "http://127.0.0.1/work-items/TS-1"
        }
      }
    },
    {
      eventId: "local:TS-1:run-1:started",
      workItemId: "TS-1",
      type: "attempt.started",
      occurredAt: "2026-07-26T08:02:00.000Z",
      payload: {
        attemptId: "run-1",
        agentId: "codex"
      }
    }
  ];
  const initial = baseEvents.reduce(
    applyEvent,
    createWorkflow()
  );
  const snapshot = createGitHubDeliverySnapshot();
  const policy = createImportPolicy({
    objectTypes: ["check", "pull_request"]
  });
  const plan = createPreviewPlan({
    workflow: initial,
    snapshot,
    importPolicy: policy
  });
  const claims = collectProviderFactProvenanceClaims({
    plan,
    baseWorkflow: initial
  });
  const candidate = plan.events.reduce(
    applyEvent,
    initial
  );
  const noOpPlan = createPreviewPlan({
    workflow: candidate,
    snapshot,
    importPolicy: policy
  });

  assert.deepEqual(
    claims.map((claim) => ({
      objectType: claim.objectType,
      locator: claim.locator
    })).sort((left, right) =>
      JSON.stringify(left).localeCompare(
        JSON.stringify(right)
      )
    ),
    [
      {
        objectType: "pull_request",
        locator: {
          kind: "github.pull_request",
          number: 2
        }
      },
      {
        objectType: "check",
        locator: {
          kind: "github.check_run",
          id: "701"
        }
      }
    ].sort((left, right) =>
      JSON.stringify(left).localeCompare(
        JSON.stringify(right)
      )
    )
  );
  assert.equal(noOpPlan.events.length, 0);
  assert.throws(
    () =>
      collectProviderFactProvenanceClaims({
        plan: noOpPlan,
        baseWorkflow: candidate
      }),
    hasCode(
      "PROVIDER_FACT_PROVENANCE_UNAVAILABLE"
    )
  );
});

test("binds PR and Check claims to the plan event even when the base contains newer history", () => {
  const initial = [
    {
      eventId: "local:TS-1:created",
      workItemId: "TS-1",
      type: "work_item.created",
      occurredAt: "2026-07-26T08:00:00.000Z",
      payload: {
        title: "Local delivery",
        requiredEvidence: ["tests"],
        externalLink: {
          provider: "taskseal",
          externalId: "TS-1",
          url:
            "http://127.0.0.1/work-items/TS-1"
        }
      }
    },
    {
      eventId: "local:TS-1:run-1:started",
      workItemId: "TS-1",
      type: "attempt.started",
      occurredAt: "2026-07-26T08:02:00.000Z",
      payload: {
        attemptId: "run-1",
        agentId: "codex"
      }
    }
  ].reduce(
    applyEvent,
    createWorkflow()
  );
  const snapshot = createGitHubDeliverySnapshot();
  const plan = createPreviewPlan({
    workflow: initial,
    snapshot,
    importPolicy: createImportPolicy({
      objectTypes: ["check", "pull_request"]
    })
  });
  const newerHistory = [
    ...plan.events,
    {
      eventId: "newer:artifact",
      workItemId: "TS-1",
      type: "artifact.linked",
      occurredAt: "2026-07-26T09:03:00.000Z",
      payload: {
        artifactId: "pr-601",
        attemptId: "run-1",
        kind: "pull_request",
        revision: "def456",
        url:
          "https://github.com/netpilot-z/TaskSeal/pull/2"
      }
    },
    {
      eventId: "newer:evidence",
      workItemId: "TS-1",
      type: "evidence.recorded",
      occurredAt: "2026-07-26T09:04:00.000Z",
      payload: {
        evidenceId: "check-701",
        attemptId: "run-1",
        artifactId: "pr-601",
        revision: "def456",
        criterionKey: "tests",
        outcome: "failed",
        url:
          "https://github.com/netpilot-z/TaskSeal/actions/runs/7"
      }
    }
  ].reduce(
    applyEvent,
    initial
  );

  const claims = collectProviderFactProvenanceClaims({
    plan,
    baseWorkflow: newerHistory
  });
  const pullRequest = required(
    claims.find(
      (claim) =>
        claim.objectType === "pull_request"
    )
  );
  const check = required(
    claims.find(
      (claim) => claim.objectType === "check"
    )
  );

  assert.equal(
    pullRequest.sourceRevisionId,
    "2026-07-26T08:03:00.000Z"
  );
  assert.equal(
    check.sourceRevisionId,
    "2026-07-26T08:04:00.000Z"
  );
  assert.equal(
    pullRequest.contentDigest,
    snapshot.facts[0]?.revision.contentDigest
  );
  assert.equal(
    check.contentDigest,
    snapshot.facts[1]?.revision.contentDigest
  );
});

test("fails closed before verification when one plan exceeds the remote claim budget", () => {
  const snapshots = Array.from(
    { length: 9 },
    (_, index) =>
      createGitHubIssueSnapshot({
        externalId: String(501 + index),
        issueNumber: String(index + 1),
        managedFields: []
      })
  );
  const first = required(snapshots[0]);
  const plan = createPreviewPlan({
    snapshot: {
      ...first,
      facts: snapshots.map(
        (snapshot) => snapshot.facts[0]
      )
    }
  });

  assert.throws(
    () =>
      collectProviderFactProvenanceClaims({
        plan,
        baseWorkflow: createWorkflow()
      }),
    hasCode(
      "PROVIDER_FACT_PROVENANCE_UNAVAILABLE"
    )
  );
});

test("requires one valid verifier result for every exact claim digest", async () => {
  const claim = createClaim("501");
  const other = createClaim("502");

  await assert.rejects(
    verifyProviderFactProvenance({
      claims: [claim],
      verifier: undefined
    }),
    hasCode("PROVIDER_FACT_PROVENANCE_UNAVAILABLE")
  );
  await assert.rejects(
    verifyProviderFactProvenance({
      claims: [claim, other],
      verifier: verifierReturning([
        {
          schemaVersion: 1,
          claimDigest: claim.claimDigest,
          outcome: "verified"
        }
      ])
    }),
    hasCode("PROVIDER_FACT_PROVENANCE_UNAVAILABLE")
  );
  await assert.rejects(
    verifyProviderFactProvenance({
      claims: [claim],
      verifier: verifierReturning([
        {
          schemaVersion: 1,
          claimDigest: claim.claimDigest,
          outcome: "mismatch"
        }
      ])
    }),
    hasCode("PROVIDER_FACT_PROVENANCE_MISMATCH")
  );
  await assert.doesNotReject(
    verifyProviderFactProvenance({
      claims: [claim],
      verifier: verifierReturning([
        {
          schemaVersion: 1,
          claimDigest: claim.claimDigest,
          outcome: "verified"
        }
      ])
    })
  );
});

test("does not call a verifier when the provider requires no remote provenance", async () => {
  let calls = 0;
  const verifier: ProviderFactProvenanceVerifier = {
    async verify() {
      calls += 1;
      return [];
    }
  };

  await verifyProviderFactProvenance({
    claims: [],
    verifier
  });

  assert.equal(calls, 0);
});

test("rejects more than eight remote claims before calling a verifier", async () => {
  let calls = 0;
  const verifier: ProviderFactProvenanceVerifier = {
    async verify() {
      calls += 1;
      return [];
    }
  };

  await assert.rejects(
    verifyProviderFactProvenance({
      claims: Array.from(
        { length: 9 },
        (_, index) =>
          createClaim(String(501 + index))
      ),
      verifier
    }),
    hasCode(
      "PROVIDER_FACT_PROVENANCE_UNAVAILABLE"
    )
  );
  assert.equal(calls, 0);
});

test("normalizes hostile verifier results to the fixed unavailable contract", async () => {
  const claim = createClaim("501");
  const hostile = {};
  Object.defineProperty(hostile, "schemaVersion", {
    enumerable: true,
    get() {
      throw new Error("sensitive verifier detail");
    }
  });
  let caught: unknown;

  try {
    await verifyProviderFactProvenance({
      claims: [claim],
      verifier: verifierReturning([hostile])
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(
    caught instanceof Error &&
      "code" in caught &&
      caught.code,
    "PROVIDER_FACT_PROVENANCE_UNAVAILABLE"
  );
  assert.doesNotMatch(
    caught instanceof Error ? caught.message : "",
    /sensitive verifier detail/
  );
});

test("rejects duplicate, unknown, and malformed verifier result sets", async (t) => {
  const claim = createClaim("501");
  const other = createClaim("502");
  const verified = {
    schemaVersion: 1,
    claimDigest: claim.claimDigest,
    outcome: "verified"
  };
  const cases: Array<{
    name: string;
    claims?: ProviderFactProvenanceClaim[];
    result: unknown;
  }> = [
    {
      name: "non-array",
      result: verified
    },
    {
      name: "duplicate digest",
      claims: [claim, other],
      result: [verified, verified]
    },
    {
      name: "unknown digest",
      result: [
        {
          ...verified,
          claimDigest: other.claimDigest
        }
      ]
    },
    {
      name: "wrong schema version",
      result: [
        {
          ...verified,
          schemaVersion: 2
        }
      ]
    },
    {
      name: "unknown outcome",
      result: [
        {
          ...verified,
          outcome: "maybe"
        }
      ]
    },
    {
      name: "extra field",
      result: [
        {
          ...verified,
          detail: "not allowed"
        }
      ]
    },
    {
      name: "missing field",
      result: [
        {
          schemaVersion: 1,
          claimDigest: claim.claimDigest
        }
      ]
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      await assert.rejects(
        verifyProviderFactProvenance({
          claims: scenario.claims ?? [claim],
          verifier: verifierReturning(
            scenario.result
          )
        }),
        hasCode(
          "PROVIDER_FACT_PROVENANCE_UNAVAILABLE"
        )
      );
    });
  }
});

function createClaim(
  externalId: string
): ProviderFactProvenanceClaim {
  const content = {
    schemaVersion: 1,
    provider: "github",
    objectType: "issue",
    providerObjectKey: `github:issue:${externalId}`,
    externalId,
    scopeRef: {
      kind: "repository",
      key: "github:repository:netpilot-z/taskseal"
    },
    url:
      "https://github.com/netpilot-z/TaskSeal/issues/1",
    sourceRevisionId:
      "2026-07-26T08:01:00.000Z",
    sourceOccurredAt:
      "2026-07-26T08:01:00.000Z",
    eventType: "work_item.created",
    eventOccurredAt:
      "2026-07-26T08:00:00.000Z",
    contentDigest: "sha256:" + "c".repeat(64),
    content: {
      kind: "issue",
      title: "Issue title"
    },
    locator: {
      kind: "github.issue",
      number: 1
    }
  } as const;

  return {
    ...content,
    claimDigest:
      computeProviderFactProvenanceClaimDigest(
        content
      )
  };
}

function verifierReturning(
  result: unknown
): ProviderFactProvenanceVerifier {
  return {
    async verify() {
      return structuredClone(result);
    }
  };
}

function withoutDigest(
  claim: ProviderFactProvenanceClaim
): Omit<ProviderFactProvenanceClaim, "claimDigest"> {
  const { claimDigest: _claimDigest, ...rest } = claim;
  return rest;
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}

function required<T>(
  value: T | null | undefined
): T {
  if (value === null || value === undefined) {
    throw new Error("value is required");
  }

  return value;
}
