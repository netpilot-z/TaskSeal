import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderObservationReadModel,
  projectProviderFailure,
  projectProviderSnapshot
} from "../src/application/provider-observation.ts";
import type {
  ProviderObservationFile,
  ProviderObservationInput,
  ProviderObservationStoragePort
} from "../src/application/provider-observation.ts";

const TARGET = {
  kind: "repository" as const,
  key: "github:repository:netpilot-z/taskseal"
};

test("Provider observation projects an opaque Feishu table record snapshot", () => {
  const scope = {
    kind: "table" as const,
    key:
      "feishu:table:sha256:" +
      "a".repeat(64),
    parentKey:
      "feishu:base:sha256:" +
      "b".repeat(64)
  };
  const projected = projectProviderSnapshot({
    operation: "inspection",
    configuredTarget: {
      kind: "table",
      key: scope.key
    },
    startedAt: "2026-07-29T08:00:00.000Z",
    observedAt: "2026-07-29T08:00:01.000Z",
    snapshot: {
      schemaVersion: 2,
      mode: "read-only",
      provider: "feishu",
      scope,
      mapping: {
        workItemId: "NP-18",
        requiredEvidence: ["tests"],
        managedFields: []
      },
      capturedAt: "2026-07-29T08:00:00.500Z",
      facts: [
        {
          sourceObject: {
            objectType: "record"
          },
          revision: {
            id: "2026-07-28T02:00:00.000Z",
            occurredAt:
              "2026-07-28T02:00:00.000Z",
            contentDigest: digest("f")
          },
          candidateEvent: {
            type: "work_item.created"
          }
        }
      ]
    }
  });

  assert.equal(projected.provider, "feishu");
  assert.equal(projected.status, "snapshot_ready");
  assert.deepEqual(projected.observedScope, {
    ...scope
  });
  assert.deepEqual(projected.sourceRevisions, [
    {
      objectType: "record",
      id: "2026-07-28T02:00:00.000Z",
      occurredAt: "2026-07-28T02:00:00.000Z",
      contentDigest: digest("f")
    }
  ]);
});

test("Provider observation projects five safe states and rejects stale completion", async () => {
  const storage = new MemoryObservationStorage();
  const model =
    await ProviderObservationReadModel.open({ storage });

  assert.equal(
    (
      await model.record(
        observation({
          operation: "configuration",
          status: "configured",
          startedAt: "2026-07-27T09:00:00.000Z",
          observedAt: "2026-07-27T09:00:00.010Z"
        })
      )
    ).resolution,
    "committed"
  );

  await model.record(
    observation({
      status: "scope_mismatch",
      startedAt: "2026-07-27T09:01:00.000Z",
      observedAt: "2026-07-27T09:01:00.020Z",
      diagnosticCode: "SNAPSHOT_SCOPE_MISMATCH"
    })
  );
  assert.equal(
    (await model.list()).providers[0]?.status,
    "scope_mismatch"
  );

  await model.record(
    observation({
      status: "sample_missing",
      startedAt: "2026-07-27T09:02:00.000Z",
      observedAt: "2026-07-27T09:02:00.020Z",
      diagnosticCode: "GITHUB_NOT_FOUND"
    })
  );
  assert.equal(
    (await model.list()).providers[0]?.status,
    "sample_missing"
  );

  await model.record(
    observation({
      status: "snapshot_ready",
      startedAt: "2026-07-27T09:04:00.000Z",
      observedAt: "2026-07-27T09:04:00.020Z",
      snapshotDigest: digest("a"),
      mappingDigest: digest("b")
    })
  );
  assert.equal(
    (await model.list()).providers[0]?.status,
    "snapshot_ready"
  );

  const stale = await model.record(
    observation({
      status: "sync_failed",
      startedAt: "2026-07-27T09:03:00.000Z",
      observedAt: "2026-07-27T09:05:00.000Z",
      diagnosticCode: "GITHUB_REQUEST_FAILED"
    })
  );
  assert.equal(stale.resolution, "ignored-stale");
  assert.equal(
    (await model.list()).providers[0]?.status,
    "snapshot_ready"
  );

  await model.record(
    observation({
      status: "sync_failed",
      startedAt: "2026-07-27T09:05:00.000Z",
      observedAt: "2026-07-27T09:05:00.010Z",
      diagnosticCode: "GITHUB_REQUEST_FAILED"
    })
  );
  const projection = await model.list();
  assert.equal(projection.providers[0]?.status, "sync_failed");
  assert.match(projection.revision, /^sha256:[0-9a-f]{64}$/);
});

test("Provider observation is idempotent at one version and fails closed on ambiguity", async () => {
  const storage = new MemoryObservationStorage();
  const model =
    await ProviderObservationReadModel.open({ storage });
  const input = observation({
    status: "snapshot_ready",
    snapshotDigest: digest("a"),
    mappingDigest: digest("b")
  });

  assert.equal(
    (await model.record(input)).resolution,
    "committed"
  );
  assert.equal(
    (await model.record(structuredClone(input))).resolution,
    "idempotent"
  );
  assert.equal(storage.replaceCalls, 1);

  await assert.rejects(
    model.record({
      ...input,
      status: "sync_failed",
      diagnosticCode: "GITHUB_REQUEST_FAILED",
      snapshotDigest: null,
      mappingDigest: null
    }),
    hasCode("PROVIDER_OBSERVATION_VERSION_CONFLICT")
  );
  assert.equal(storage.replaceCalls, 1);

  await assert.rejects(
    model.record(
      Object.assign(structuredClone(input), {
        rawProviderBody: "forbidden"
      })
    ),
    hasCode("PROVIDER_OBSERVATION_INVALID")
  );
  assert.equal(storage.replaceCalls, 1);
});

test("Provider observation target cardinality is bounded without evicting existing state", async () => {
  const storage = new MemoryObservationStorage();
  const model =
    await ProviderObservationReadModel.open({ storage });

  for (let index = 0; index < 64; index += 1) {
    await model.record(
      observation({
        operation: "configuration",
        configuredTarget: {
          kind: "repository",
          key: `github:repository:owner/repository-${index}`
        },
        observedScope: null
      })
    );
  }

  await assert.rejects(
    model.record(
      observation({
        operation: "configuration",
        configuredTarget: {
          kind: "repository",
          key: "github:repository:owner/repository-64"
        },
        observedScope: null
      })
    ),
    hasCode("PROVIDER_OBSERVATION_LIMIT_EXCEEDED")
  );
  assert.equal((await model.list()).providers.length, 64);
  assert.equal(storage.replaceCalls, 64);
});

test("Provider observation canonicalizes equivalent RFC3339 timestamps before freshness comparison", async () => {
  const storage = new MemoryObservationStorage();
  const model =
    await ProviderObservationReadModel.open({ storage });
  const input = observation({
    startedAt: "2026-07-27T10:00:00.000Z",
    observedAt: "2026-07-27T10:00:00.100Z"
  });

  assert.equal(
    (await model.record(input)).resolution,
    "committed"
  );
  assert.equal(
    (
      await model.record({
        ...input,
        startedAt: "2026-07-27T18:00:00+08:00",
        observedAt: "2026-07-27T18:00:00.100+08:00"
      })
    ).resolution,
    "idempotent"
  );
  assert.equal(storage.replaceCalls, 1);
  assert.equal(
    (await model.list()).providers[0]?.startedAt,
    "2026-07-27T10:00:00.000Z"
  );
});

test("Provider observation rejects executable array prototypes and non-RFC3339 timestamp text", async () => {
  const storage = new MemoryObservationStorage();
  const model =
    await ProviderObservationReadModel.open({ storage });
  let customMapCalls = 0;
  const sourceRevisions: ProviderObservationInput["sourceRevisions"] =
    [];
  Object.setPrototypeOf(sourceRevisions, {
    map() {
      customMapCalls += 1;
      return [];
    }
  });

  await assert.rejects(
    model.record(
      observation({
        sourceRevisions
      })
    ),
    hasCode("PROVIDER_OBSERVATION_INVALID")
  );
  assert.equal(customMapCalls, 0);

  const secret = "secret-token";
  await assert.rejects(
    model.record(
      observation({
        sourceRevisions: [
          {
            objectType: "issue",
            id: "revision-1",
            occurredAt:
              `Thu, 01 Jan 1970 00:00:00 GMT (${secret})`,
            contentDigest: digest("c")
          }
        ]
      })
    ),
    hasCode("PROVIDER_OBSERVATION_INVALID")
  );
  assert.doesNotMatch(
    JSON.stringify(await model.list()),
    new RegExp(secret)
  );
});

test("Provider snapshot projection persists only revisions, digests, and missing evidence", () => {
  const secret = "raw-title-and-url-secret";
  const input = projectProviderSnapshot({
    operation: "inspection",
    configuredTarget: TARGET,
    startedAt: "2026-07-27T10:00:00.000Z",
    observedAt: "2026-07-27T10:00:00.100Z",
    snapshot: {
      schemaVersion: 2,
      mode: "read-only",
      provider: "github",
      scope: {
        kind: "repository",
        key: "github:repository:netpilot-z/taskseal"
      },
      mapping: {
        workItemId: "TS-1",
        requiredEvidence: ["review", "tests"],
        managedFields: []
      },
      capturedAt: "2026-07-27T10:00:00.090Z",
      facts: [
        {
          sourceObject: {
            providerObjectKey: "github:issue:1",
            provider: "github",
            objectType: "issue",
            externalId: "1",
            url: `https://example.test/${secret}`
          },
          revision: {
            id: "revision-1",
            occurredAt: "2026-07-27T09:59:00.000Z",
            contentDigest: digest("c")
          },
          observed: {
            title: secret,
            createdAt: "2026-07-27T09:00:00.000Z"
          },
          candidateEvent: {
            eventId: "event-1",
            workItemId: "TS-1",
            type: "work_item.created",
            occurredAt: "2026-07-27T09:59:00.000Z",
            payload: {
              title: secret,
              requiredEvidence: ["review", "tests"],
              externalLink: {
                provider: "github",
                externalId: "1",
                url: `https://example.test/${secret}`
              }
            }
          }
        },
        {
          sourceObject: {
            providerObjectKey: "github:check:2",
            provider: "github",
            objectType: "check",
            externalId: "2",
            url: `https://example.test/${secret}/check`
          },
          revision: {
            id: "revision-2",
            occurredAt: "2026-07-27T09:59:30.000Z",
            contentDigest: digest("d")
          },
          observed: {
            headRevision: "abc123",
            outcome: "passed"
          },
          candidateEvent: {
            eventId: "event-2",
            workItemId: "TS-1",
            type: "evidence.recorded",
            occurredAt: "2026-07-27T09:59:30.000Z",
            payload: {
              attemptId: "attempt-1",
              artifactId: "artifact-1",
              artifactRevision: "abc123",
              criterionKey: "tests",
              outcome: "passed",
              provider: "github"
            }
          }
        }
      ]
    }
  });
  const serialized = JSON.stringify(input);

  assert.equal(input.status, "snapshot_ready");
  assert.deepEqual(input.missingEvidence, ["review"]);
  assert.deepEqual(
    input.sourceRevisions.map((revision) => revision.objectType),
    ["check", "issue"]
  );
  assert.match(input.snapshotDigest ?? "", /^sha256:/);
  assert.match(input.mappingDigest ?? "", /^sha256:/);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, /providerObjectKey/);
  assert.doesNotMatch(serialized, /candidateEvent/);
});

test("Provider snapshot projection reports configured repository scope mismatch without retaining snapshot data", () => {
  const secret = "wrong-repository-secret";
  const snapshot = createGitHubSnapshot({
    scopeKey: "github:repository:netpilot-z/other",
    title: secret
  });
  const input = projectProviderSnapshot({
    operation: "inspection",
    configuredTarget: TARGET,
    startedAt: "2026-07-27T10:00:00.000Z",
    observedAt: "2026-07-27T10:00:00.100Z",
    snapshot
  });

  assert.equal(input.status, "scope_mismatch");
  assert.equal(
    input.diagnosticCode,
    "PROVIDER_OBSERVATION_SCOPE_MISMATCH"
  );
  assert.equal(input.snapshotDigest, null);
  assert.equal(input.mappingDigest, null);
  assert.deepEqual(input.sourceRevisions, []);
  assert.doesNotMatch(
    JSON.stringify(input),
    new RegExp(secret)
  );
});

test("Provider v1 snapshot projection derives the observed repository instead of trusting the configured target", () => {
  const input = projectProviderSnapshot({
    operation: "inspection",
    configuredTarget: TARGET,
    startedAt: "2026-07-27T10:00:00.000Z",
    observedAt: "2026-07-27T10:00:00.100Z",
    snapshot: {
      schemaVersion: 1,
      mode: "read-only",
      provider: "github",
      scope: {
        repository: "netpilot-z/other"
      },
      mapping: {
        workItemId: "TS-1",
        requiredEvidence: ["tests"]
      },
      events: []
    }
  });

  assert.equal(input.status, "scope_mismatch");
  assert.equal(
    input.observedScope?.key,
    "github:repository:netpilot-z/other"
  );
});

test("Provider snapshot projection rejects custom snapshot array prototypes without executing them", () => {
  let customIteratorCalls = 0;
  const facts = createGitHubSnapshot().facts;
  Object.setPrototypeOf(facts, {
    [Symbol.iterator]() {
      customIteratorCalls += 1;
      return [][Symbol.iterator]();
    }
  });

  assert.throws(
    () =>
      projectProviderSnapshot({
        operation: "inspection",
        configuredTarget: TARGET,
        startedAt: "2026-07-27T10:00:00.000Z",
        observedAt: "2026-07-27T10:00:00.100Z",
        snapshot: {
          ...createGitHubSnapshot(),
          facts
        }
      }),
    hasCode("CANONICAL_JSON_INVALID")
  );
  assert.equal(customIteratorCalls, 0);
});

test("Provider failure projection classifies safe codes and never persists error text", () => {
  const secret = "provider-body-secret";
  const mismatch = projectProviderFailure({
    operation: "inspection",
    provider: "linear",
    configuredTarget: {
      kind: "team",
      key: "linear:team-ref:netpilot-z/netpilot"
    },
    startedAt: "2026-07-27T10:00:00.000Z",
    observedAt: "2026-07-27T10:00:00.100Z",
    error: Object.assign(
      new Error(`Workspace mismatch: ${secret}`),
      {
        code: "LINEAR_WORKSPACE_MISMATCH",
        rawBody: secret
      }
    )
  });
  const unknown = projectProviderFailure({
    operation: "inspection",
    provider: "github",
    configuredTarget: TARGET,
    startedAt: "2026-07-27T10:01:00.000Z",
    observedAt: "2026-07-27T10:01:00.100Z",
    error: Object.assign(new Error(secret), {
      code: `UNSAFE_${secret}`
    })
  });

  assert.equal(mismatch.status, "scope_mismatch");
  assert.equal(
    mismatch.diagnosticCode,
    "LINEAR_WORKSPACE_MISMATCH"
  );
  assert.equal(unknown.status, "sync_failed");
  assert.equal(
    unknown.diagnosticCode,
    "PROVIDER_OPERATION_FAILED"
  );
  assert.doesNotMatch(JSON.stringify(mismatch), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(unknown), new RegExp(secret));
});

function observation(
  overrides: Partial<ProviderObservationInput> = {}
): ProviderObservationInput {
  return {
    operation: "inspection",
    provider: "github",
    configuredTarget: TARGET,
    observedScope: {
      kind: "repository",
      key: TARGET.key,
      parentKey: null
    },
    status: "configured",
    startedAt: "2026-07-27T09:00:00.000Z",
    observedAt: "2026-07-27T09:00:00.010Z",
    sourceRevisions: [],
    snapshotDigest: null,
    mappingDigest: null,
    planDigest: null,
    missingEvidence: [],
    diagnosticCode: null,
    resolution: null,
    ...overrides
  };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function createGitHubSnapshot({
  scopeKey = TARGET.key,
  title = "Safe"
}: {
  scopeKey?: string;
  title?: string;
} = {}) {
  return {
    schemaVersion: 2,
    mode: "read-only",
    provider: "github",
    scope: {
      kind: "repository",
      key: scopeKey
    },
    mapping: {
      workItemId: "TS-1",
      requiredEvidence: ["tests"],
      managedFields: []
    },
    capturedAt: "2026-07-27T09:59:59.000Z",
    facts: [
      {
        sourceObject: {
          providerObjectKey: "github:issue:1",
          provider: "github",
          objectType: "issue",
          externalId: "1",
          url: "https://example.test/issues/1"
        },
        revision: {
          id: "revision-1",
          occurredAt: "2026-07-27T09:59:00.000Z",
          contentDigest: digest("a")
        },
        observed: {
          title,
          createdAt: "2026-07-27T09:00:00.000Z"
        },
        candidateEvent: {
          eventId: "event-1",
          workItemId: "TS-1",
          type: "work_item.created",
          occurredAt: "2026-07-27T09:59:00.000Z",
          payload: {
            title,
            requiredEvidence: ["tests"],
            externalLink: {
              provider: "github",
              externalId: "1",
              url: "https://example.test/issues/1"
            }
          }
        }
      }
    ]
  };
}

class MemoryObservationStorage
  implements ProviderObservationStoragePort
{
  value: ProviderObservationFile | null = null;
  replaceCalls = 0;

  async load(): Promise<unknown> {
    return this.value === null
      ? {
          schemaVersion: 1,
          observations: []
        }
      : structuredClone(this.value);
  }

  async replace(value: ProviderObservationFile): Promise<void> {
    this.replaceCalls += 1;
    this.value = structuredClone(value);
  }
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}
