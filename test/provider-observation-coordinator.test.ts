import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderObservationCoordinator,
  configuredTargetForProvider
} from "../src/application/provider-observation-coordinator.ts";
import {
  ProviderObservationReadModel
} from "../src/application/provider-observation.ts";
import type {
  ProviderObservationCommandPort,
  ProviderObservationFile,
  ProviderObservationInput,
  ProviderObservationStoragePort
} from "../src/application/provider-observation.ts";

test("Provider observation coordinator records inspection success and code-only failure", async () => {
  const storage = new MemoryObservationStorage();
  const model =
    await ProviderObservationReadModel.open({ storage });
  const times = [
    "2026-07-27T10:00:00.000Z",
    "2026-07-27T10:00:00.100Z",
    "2026-07-27T10:01:00.000Z",
    "2026-07-27T10:01:00.100Z"
  ];
  const coordinator = new ProviderObservationCoordinator({
    observations: model,
    clock: () => new Date(requireNext(times))
  });
  const target = {
    kind: "repository" as const,
    key: "github:repository:netpilot-z/taskseal"
  };
  const snapshot = createSnapshot("ready");

  assert.equal(
    await coordinator.inspect({
      provider: "github",
      configuredTarget: target,
      kind: "snapshot",
      execute: async () => snapshot
    }),
    snapshot
  );
  assert.equal(
    (await model.list()).providers[0]?.status,
    "snapshot_ready"
  );

  const secret = "provider-error-secret";
  const original = Object.assign(
    new Error(`Do not persist ${secret}`),
    {
      code: "GITHUB_NOT_FOUND",
      rawBody: secret
    }
  );

  await assert.rejects(
    coordinator.inspect({
      provider: "github",
      configuredTarget: target,
      kind: "snapshot",
      missingEvidence: ["tests"],
      execute: async () => {
        throw original;
      }
    }),
    (error) => error === original
  );
  const failure = (await model.list()).providers[0];
  assert.equal(failure?.status, "sample_missing");
  assert.equal(failure?.diagnosticCode, "GITHUB_NOT_FOUND");
  assert.doesNotMatch(
    JSON.stringify(failure),
    new RegExp(secret)
  );
});

test("Provider observation coordinator preserves successful provider outcomes while recording scope mismatch", async () => {
  const storage = new MemoryObservationStorage();
  const model =
    await ProviderObservationReadModel.open({ storage });
  const times = [
    "2026-07-27T10:00:00.000Z",
    "2026-07-27T10:00:00.100Z",
    "2026-07-27T10:01:00.000Z",
    "2026-07-27T10:01:00.100Z",
    "2026-07-27T10:02:00.000Z",
    "2026-07-27T10:02:00.100Z"
  ];
  const coordinator = new ProviderObservationCoordinator({
    observations: model,
    clock: () => new Date(requireNext(times))
  });
  const configuredTarget = {
    kind: "repository" as const,
    key: "github:repository:netpilot-z/taskseal"
  };
  const otherScope = {
    kind: "repository" as const,
    key: "github:repository:netpilot-z/other"
  };
  const snapshot = {
    ...createSnapshot("wrong-snapshot"),
    scope: otherScope
  };

  assert.equal(
    await coordinator.inspect({
      provider: "github",
      configuredTarget,
      kind: "snapshot",
      execute: async () => snapshot
    }),
    snapshot
  );
  assert.equal(
    (await model.list()).providers[0]?.status,
    "scope_mismatch"
  );

  const health = {
    provider: "github",
    status: "ready",
    scope: otherScope
  };
  assert.equal(
    await coordinator.inspect({
      provider: "github",
      configuredTarget,
      kind: "health",
      execute: async () => health
    }),
    health
  );
  assert.equal(
    (await model.list()).providers[0]?.status,
    "scope_mismatch"
  );

  const plan = {
    schemaVersion: 1,
    mode: "preview",
    snapshotDigest: digest("e"),
    mappingDigest: digest("f"),
    planDigest: digest("1"),
    policyBinding: {
      provider: "github",
      scopeRef: otherScope
    }
  };
  const result = {
    receipt: { receiptId: "receipt-1" },
    resolution: "committed" as const
  };
  assert.equal(
    await coordinator.apply({
      provider: "github",
      configuredTarget,
      plan,
      execute: async () => result
    }),
    result
  );
  const observation = (await model.list()).providers[0];
  assert.equal(observation?.status, "scope_mismatch");
  assert.equal(
    observation?.diagnosticCode,
    "PROVIDER_OBSERVATION_SCOPE_MISMATCH"
  );
  assert.equal(observation?.resolution, null);
});

test("Provider observation sink failure never changes inspection, preview, or apply outcomes", async () => {
  const observations = new ThrowingObservationCommand();
  const times = Array.from(
    { length: 12 },
    (_, index) =>
      `2026-07-27T10:${String(index).padStart(2, "0")}:00.000Z`
  );
  const coordinator = new ProviderObservationCoordinator({
    observations,
    clock: () => new Date(requireNext(times))
  });
  const target = {
    kind: "repository" as const,
    key: "github:repository:netpilot-z/taskseal"
  };
  const snapshot = createSnapshot("safe");

  assert.equal(
    await coordinator.inspect({
      provider: "github",
      configuredTarget: target,
      kind: "snapshot",
      execute: async () => snapshot
    }),
    snapshot
  );

  const plan = {
    schemaVersion: 1,
    mode: "preview",
    snapshotDigest: digest("e"),
    mappingDigest: digest("f"),
    planDigest: digest("1"),
    policyBinding: {
      provider: "github",
      scopeRef: {
        kind: "repository",
        key: target.key
      }
    }
  };
  assert.equal(
    await coordinator.preview({
      provider: "github",
      configuredTarget: target,
      snapshot,
      execute: async () => plan
    }),
    plan
  );

  const applyResult = {
    receipt: { receiptId: "receipt-1" },
    resolution: "committed" as const
  };
  assert.equal(
    await coordinator.apply({
      provider: "github",
      configuredTarget: target,
      plan,
      execute: async () => applyResult
    }),
    applyResult
  );

  const original = Object.assign(new Error("apply failed"), {
    code: "IMPORT_PLAN_STALE"
  });
  await assert.rejects(
    coordinator.apply({
      provider: "github",
      configuredTarget: target,
      plan,
      execute: async () => {
        throw original;
      }
    }),
    (error) => error === original
  );
  assert.equal(observations.calls, 4);
});

test("Provider observation coordinator uses operation start freshness when requests complete out of order", async () => {
  const storage = new MemoryObservationStorage();
  const model =
    await ProviderObservationReadModel.open({ storage });
  const clockValues = [
    "2026-07-27T10:00:00.000Z",
    "2026-07-27T10:01:00.000Z",
    "2026-07-27T10:01:00.100Z",
    "2026-07-27T10:02:00.000Z"
  ];
  const coordinator = new ProviderObservationCoordinator({
    observations: model,
    clock: () => new Date(requireNext(clockValues))
  });
  const target = {
    kind: "repository" as const,
    key: "github:repository:netpilot-z/taskseal"
  };
  let releaseFirst = (): void => {};
  let releaseSecond = (): void => {};
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const first = coordinator.inspect({
    provider: "github",
    configuredTarget: target,
    kind: "snapshot",
    execute: async () => {
      await firstGate;
      return createSnapshot("older");
    }
  });
  const second = coordinator.inspect({
    provider: "github",
    configuredTarget: target,
    kind: "snapshot",
    execute: async () => {
      await secondGate;
      return createSnapshot("newer");
    }
  });

  releaseSecond();
  await second;
  releaseFirst();
  await first;

  const current = (await model.list()).providers[0];
  assert.equal(
    current?.startedAt,
    "2026-07-27T10:01:00.000Z"
  );
  assert.equal(
    current?.sourceRevisions[0]?.id,
    "newer"
  );
});

test("configured targets are stable and keep Linear configuration separate from resolved UUID scope", () => {
  assert.deepEqual(
    configuredTargetForProvider(
      {
        project: "TaskSeal",
        github: {
          repository: "NetPilot-Z/TaskSeal"
        }
      },
      "github"
    ),
    {
      kind: "repository",
      key: "github:repository:netpilot-z/taskseal"
    }
  );
  assert.deepEqual(
    configuredTargetForProvider(
      {
        project: "TaskSeal",
        linear: {
          workspace: "NetPilot-Z",
          team: "NetPilot"
        }
      },
      "linear"
    ),
    {
      kind: "team",
      key: "linear:team-ref:netpilot-z/netpilot"
    }
  );
  assert.deepEqual(
    configuredTargetForProvider(
      {
        project: "TaskSeal",
        gitee: {
          repository: "OSChina/Git-Osc"
        }
      },
      "gitee"
    ),
    {
      kind: "repository",
      key: "gitee:repository:oschina/git-osc"
    }
  );
});

function createSnapshot(revisionId: string) {
  return {
    schemaVersion: 2,
    mode: "read-only",
    provider: "github",
    scope: {
      kind: "repository",
      key: "github:repository:netpilot-z/taskseal"
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
          id: revisionId,
          occurredAt: "2026-07-27T09:59:00.000Z",
          contentDigest: digest("a")
        },
        observed: {
          title: "Safe",
          createdAt: "2026-07-27T09:00:00.000Z"
        },
        candidateEvent: {
          eventId: "event-1",
          workItemId: "TS-1",
          type: "work_item.created",
          occurredAt: "2026-07-27T09:59:00.000Z",
          payload: {
            title: "Safe",
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

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function requireNext(values: string[]): string {
  const value = values.shift();
  if (!value) {
    assert.fail("Missing clock value.");
  }
  return value;
}

class ThrowingObservationCommand
  implements ProviderObservationCommandPort
{
  calls = 0;

  async record(
    _observation: ProviderObservationInput
  ): Promise<never> {
    this.calls += 1;
    throw new Error("observation storage unavailable");
  }

  async ensure(
    _observation: ProviderObservationInput
  ): Promise<never> {
    return this.record(_observation);
  }
}

class MemoryObservationStorage
  implements ProviderObservationStoragePort
{
  value: ProviderObservationFile = {
    schemaVersion: 1,
    observations: []
  };

  async load(): Promise<unknown> {
    return structuredClone(this.value);
  }

  async replace(value: ProviderObservationFile): Promise<void> {
    this.value = structuredClone(value);
  }
}
