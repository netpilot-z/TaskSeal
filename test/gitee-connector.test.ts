import assert from "node:assert/strict";
import test from "node:test";

import {
  GITEE_ADAPTER_MANIFEST,
  createGiteeAdapter,
  normalizeGiteeIssueFact
} from "../src/connectors/gitee.ts";
import {
  normalizeProviderAdapterV1
} from "../src/connectors/provider-adapter.ts";
import {
  digestProviderFactContent
} from "../src/lib/provider-snapshot.ts";

const ISSUE = {
  id: 2_614,
  number: "I4",
  title: "Git push crashes",
  htmlUrl: "https://gitee.com/oschina/git-osc/issues/I4",
  createdAt: "2013-04-12T12:15:08+08:00",
  updatedAt: "2022-07-22T05:01:31+08:00",
  repository: "oschina/git-osc"
};

test("Gitee manifest exposes only anonymous health and work-item read", () => {
  assert.deepEqual(GITEE_ADAPTER_MANIFEST, {
    schemaVersion: 1,
    apiVersion: "taskseal.provider/v1",
    providerId: "gitee",
    capabilities: [
      "provider.health",
      "work-item.read"
    ],
    configuration: {
      schemaVersion: 1,
      fields: [
        {
          key: "repository",
          type: "repository-coordinate",
          required: true,
          secret: false
        }
      ]
    },
    credential: {
      mode: "none"
    },
    scopes: [
      {
        kind: "repository",
        objectTypes: ["issue"]
      }
    ]
  });

  const adapter = createGiteeAdapter({
    fetchImpl: async () => {
      throw new Error("not invoked");
    }
  });
  assert.doesNotThrow(() =>
    normalizeProviderAdapterV1(adapter)
  );
  assert.deepEqual(
    Reflect.ownKeys(adapter.ports),
    ["provider.health", "work-item.read"]
  );
});

test("Gitee Issue normalizer creates repository-scoped rich identity", () => {
  const fact = normalizeGiteeIssueFact(ISSUE, {
    workItemId: "TS-GITEE-I4",
    requiredEvidence: ["tests", "review"],
    managedFields: ["title"]
  });

  assert.deepEqual(fact.sourceObject, {
    providerObjectKey:
      "gitee:issue:oschina/git-osc#I4",
    provider: "gitee",
    objectType: "issue",
    externalId: "oschina/git-osc#I4",
    url: ISSUE.htmlUrl
  });
  assert.deepEqual(fact.revision, {
    id: ISSUE.updatedAt,
    occurredAt: ISSUE.updatedAt,
    contentDigest: digestProviderFactContent(fact)
  });
  assert.deepEqual(fact.observed, {
    title: ISSUE.title,
    createdAt: ISSUE.createdAt
  });
  assert.deepEqual(
    fact.candidateEvent.payload.requiredEvidence,
    ["review", "tests"]
  );
  assert.deepEqual(
    fact.candidateEvent.payload.externalLink,
    {
      providerObjectKey:
        "gitee:issue:oschina/git-osc#I4",
      provider: "gitee",
      objectType: "issue",
      externalId: "oschina/git-osc#I4",
      scopeRef: {
        kind: "repository",
        key:
          "gitee:repository:oschina/git-osc"
      },
      url: ISSUE.htmlUrl,
      managedFields: ["title"],
      lastObservation: {
        revisionId: ISSUE.updatedAt,
        occurredAt: ISSUE.updatedAt,
        contentDigest: fact.revision.contentDigest,
        title: ISSUE.title
      }
    }
  );
  assert.equal(
    "legacy" in fact.candidateEvent.payload.externalLink,
    false
  );
  assert.doesNotMatch(JSON.stringify(fact), /"id":2614/);
});

test("Gitee Issue references remain case-sensitive identities", () => {
  const upper = normalizeGiteeIssueFact(ISSUE, {
    workItemId: "TS-1",
    requiredEvidence: ["tests"],
    managedFields: []
  });
  const lower = normalizeGiteeIssueFact(
    {
      ...ISSUE,
      number: "i4",
      htmlUrl:
        "https://gitee.com/oschina/git-osc/issues/i4"
    },
    {
      workItemId: "TS-1",
      requiredEvidence: ["tests"],
      managedFields: []
    }
  );

  assert.notEqual(
    upper.sourceObject.providerObjectKey,
    lower.sourceObject.providerObjectKey
  );
});

test("Gitee adapter returns trimmed health and display-only v2 snapshot", async () => {
  const calls: string[] = [];
  const responses = [
    textResponse({
      id: 1_322_341,
      full_name: "oschina/git-osc"
    }),
    textResponse({
      id: ISSUE.id,
      number: ISSUE.number,
      title: ISSUE.title,
      html_url: ISSUE.htmlUrl,
      created_at: ISSUE.createdAt,
      updated_at: ISSUE.updatedAt,
      state: "open",
      repository: {
        full_name: ISSUE.repository
      }
    })
  ];
  const adapter = createGiteeAdapter({
    fetchImpl: async (url) => {
      calls.push(url);
      return responses.shift();
    },
    now: () => new Date("2026-07-27T08:00:00.000Z")
  });

  const health = await adapter.ports["provider.health"]({
    repository: "oschina/git-osc"
  });
  const snapshot = await adapter.ports["work-item.read"]({
    repository: "oschina/git-osc",
    issueReference: "I4",
    mapping: {
      workItemId: "TS-GITEE-I4",
      requiredEvidence: ["tests"],
      managedFields: []
    }
  });

  assert.deepEqual(health, {
    provider: "gitee",
    status: "ready",
    checkedAt: "2026-07-27T08:00:00.000Z",
    scope: {
      kind: "repository",
      key: "gitee:repository:oschina/git-osc"
    }
  });
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.mode, "read-only");
  assert.equal(snapshot.provider, "gitee");
  assert.deepEqual(snapshot.scope, health.scope);
  assert.deepEqual(snapshot.mapping, {
    workItemId: "TS-GITEE-I4",
    requiredEvidence: ["tests"],
    managedFields: []
  });
  assert.equal(snapshot.capturedAt, health.checkedAt);
  assert.equal(snapshot.facts.length, 1);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /"id":2614|"state":"open"/
  );
});

test("Gitee adapter rejects implicit or malformed local mapping", async () => {
  const adapter = createGiteeAdapter({
    fetchImpl: async () => textResponse({})
  });

  await assert.rejects(
    adapter.ports["work-item.read"]({
      repository: "oschina/git-osc",
      issueReference: "I4",
      mapping: {
        workItemId: "",
        requiredEvidence: [],
        managedFields: ["title", "title"]
      }
    }),
    hasCode("GITEE_MAPPING_INVALID")
  );
});

function textResponse(body: unknown) {
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

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}
