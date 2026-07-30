import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

import {
  ObservedSnapshotImportFacade
} from "../src/application/observed-snapshot-import.ts";
import {
  createProviderIngressRegistry
} from "../src/application/provider-ingress-registry.ts";
import {
  createLocalProviderObservationRuntime,
  runCli,
  startPersistentControlRoom
} from "../src/cli.ts";
import type {
  OutputPort
} from "../src/cli.ts";
import {
  createWorkflow
} from "../src/domain/workflow.ts";
import {
  createGitHubIssueSnapshot,
  createImportPolicy,
  createLinearImportPolicy,
  createLinearIssueSnapshot
} from "../test-support/snapshot-import-fixtures.ts";

test("local Provider observation runtime seeds configured targets and preserves newer state on reopen", async (t) => {
  const cwd = await temporaryProject(t);
  const first =
    await createLocalProviderObservationRuntime({
      cwd,
      clock: () =>
        new Date("2026-07-27T10:00:00.000Z")
    });
  const seeded = await first.readModel.list();

  assert.deepEqual(
    seeded.providers.map((provider) => [
      provider.provider,
      provider.status,
      provider.configuredTarget.key
    ]),
    [
      [
        "github",
        "configured",
        "github:repository:netpilot-z/taskseal"
      ],
      [
        "linear",
        "configured",
        "linear:team-ref:netpilot-z/netpilot"
      ]
    ]
  );
  assert.ok(
    (await first.createSnapshotImportFacade({
      provider: "github",
      imports: {
        async applySnapshotImport() {
          throw new Error("not called");
        }
      }
    })) instanceof ObservedSnapshotImportFacade
  );
  await assert.rejects(
    first.createSnapshotImportFacade({
      provider: "linear",
      imports: {
        async applySnapshotImport() {
          throw new Error("not called");
        }
      }
    }),
    /verified scope binding/
  );

  await first.coordinator.inspect({
    provider: "github",
    configuredTarget:
      seeded.providers[0]?.configuredTarget ?? {
        kind: "provider",
        key: "github:configuration"
      },
    kind: "snapshot",
    execute: async () => createSnapshot()
  });
  assert.equal(
    (await first.readModel.list()).providers[0]?.status,
    "snapshot_ready"
  );

  const reopened =
    await createLocalProviderObservationRuntime({
      cwd,
      clock: () =>
        new Date("2026-07-27T11:00:00.000Z")
    });
  assert.equal(
    (await reopened.readModel.list()).providers[0]?.status,
    "snapshot_ready"
  );
});

test("local observation composition forwards one custom ingress registry to preview", async (t) => {
  const cwd = await temporaryProject(t);
  const runtime =
    await createLocalProviderObservationRuntime({
      cwd,
      providerIngressRegistry:
        createProviderIngressRegistry([])
    });
  const facade =
    await runtime.createSnapshotImportFacade({
      provider: "github",
      imports: {
        async applySnapshotImport() {
          throw new Error("not called");
        }
      }
    });

  await assert.rejects(
    facade.previewSnapshotImport({
      snapshot: createGitHubIssueSnapshot(),
      workflow: createWorkflow(),
      importPolicy: createImportPolicy()
    }),
    hasCode("PROVIDER_INGRESS_FORBIDDEN")
  );
});

test("actual inspect composition records success and failure without changing CLI output contracts", async (t) => {
  const cwd = await temporaryProject(t);
  const output = createOutput();
  let runtime:
    | Awaited<
        ReturnType<
          typeof createLocalProviderObservationRuntime
        >
      >
    | undefined;
  const factory = async ({
    cwd,
    clock
  }: {
    cwd: string;
    clock: () => unknown;
  }) => {
    runtime = await createLocalProviderObservationRuntime({
      cwd,
      clock
    });
    return runtime.coordinator;
  };

  const successCode = await runCli({
    args: [
      "inspect",
      "github-issue",
      "--issue",
      "1",
      "--work-item",
      "TS-1",
      "--criterion",
      "tests",
      "--snapshot-version",
      "2",
      "--title-management",
      "none"
    ],
    cwd,
    output,
    now: () =>
      new Date("2026-07-27T10:00:00.000Z"),
    providerObservationCoordinatorFactory: factory,
    inspectGitHubIssue: async () => createSnapshot()
  });

  assert.equal(successCode, 0);
  assert.equal(
    JSON.parse(output.text()).provider,
    "github"
  );
  assert.ok(runtime);
  assert.equal(
    (await runtime.readModel.list()).providers[0]?.status,
    "snapshot_ready"
  );

  const error = Object.assign(
    new Error("The selected sample is unavailable."),
    {
      code: "GITHUB_NOT_FOUND",
      rawBody: "must-not-persist"
    }
  );
  const failureOutput = createOutput();
  const failureCode = await runCli({
    args: [
      "inspect",
      "github-issue",
      "--issue",
      "404",
      "--work-item",
      "TS-1",
      "--criterion",
      "tests"
    ],
    cwd,
    output: failureOutput,
    now: () =>
      new Date("2026-07-27T10:01:00.000Z"),
    providerObservationCoordinatorFactory: factory,
    inspectGitHubIssue: async () => {
      throw error;
    }
  });

  assert.equal(failureCode, 1);
  assert.match(failureOutput.text(), /\[GITHUB_NOT_FOUND\]/);
  assert.ok(runtime);
  const failure =
    (await runtime.readModel.list()).providers[0];
  assert.equal(failure?.status, "sample_missing");
  assert.doesNotMatch(
    JSON.stringify(failure),
    /must-not-persist/
  );
});

test("observed Linear inspection uses one configuration snapshot for the stable target and resolved UUID scope", async (t) => {
  const cwd = await temporaryProject(t);
  const output = createOutput();
  let runtime:
    | Awaited<
        ReturnType<
          typeof createLocalProviderObservationRuntime
        >
      >
    | undefined;
  let receivedConfiguration: unknown;

  const exitCode = await runCli({
    args: [
      "inspect",
      "linear",
      "--issue",
      "NP-1",
      "--work-item",
      "TS-1",
      "--criterion",
      "tests",
      "--snapshot-version",
      "2",
      "--title-management",
      "none"
    ],
    cwd,
    output,
    now: () =>
      new Date("2026-07-27T10:00:00.000Z"),
    providerObservationCoordinatorFactory: async ({
      cwd,
      clock
    }) => {
      runtime = await createLocalProviderObservationRuntime({
        cwd,
        clock
      });
      return runtime.coordinator;
    },
    inspectLinear: async (options) => {
      receivedConfiguration = options.configuration;
      return createLinearSnapshot();
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(receivedConfiguration, {
    project: "TaskSeal",
    github: {
      repository: "netpilot-z/TaskSeal"
    },
    linear: {
      workspace: "netpilot-z",
      team: "netpilot"
    },
    mode: "persistent"
  });
  assert.ok(runtime);
  const observation =
    (await runtime.readModel.list()).providers.find(
      (provider) => provider.provider === "linear"
    );
  assert.equal(observation?.status, "snapshot_ready");
  assert.equal(
    observation?.configuredTarget.key,
    "linear:team-ref:netpilot-z/netpilot"
  );
  assert.equal(
    observation?.observedScope?.key,
    "linear:team:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
  );
  assert.ok(
    (await runtime.createSnapshotImportFacade({
      provider: "linear",
      imports: {
        async applySnapshotImport() {
          throw new Error("not called");
        }
      }
    })) instanceof ObservedSnapshotImportFacade
  );

  let tick = 0;
  const previewRuntime =
    await createLocalProviderObservationRuntime({
      cwd,
      clock: () =>
        new Date(
          Date.parse("2026-07-27T11:00:00.000Z") +
            tick++ * 100
        )
    });
  const previewFacade =
    await previewRuntime.createSnapshotImportFacade({
      provider: "linear",
      imports: {
        async applySnapshotImport() {
          throw new Error("not called");
        }
      }
    });
  const uppercaseSnapshot =
    createLinearIssueSnapshot();
  uppercaseSnapshot.scope = {
    kind: "team",
    key:
      "linear:team:AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
    parentKey:
      "linear:organization:ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF"
  };
  const policy = createLinearImportPolicy();
  const allowedScope = policy.allowedScopes[0];
  assert.ok(allowedScope);
  allowedScope.scopeRef = {
    kind: "team",
    key:
      "linear:team:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    parentKey:
      "linear:organization:abcdefab-cdef-4abc-8def-abcdefabcdef"
  };

  await previewFacade.previewSnapshotImport({
    snapshot: uppercaseSnapshot,
    workflow: createWorkflow(),
    importPolicy: policy
  });
  const canonicalObservation =
    (await previewRuntime.readModel.list()).providers.find(
      (provider) => provider.provider === "linear"
    );
  assert.equal(
    canonicalObservation?.status,
    "snapshot_ready"
  );
  assert.equal(
    canonicalObservation?.observedScope?.key,
    allowedScope.scopeRef.key
  );

  const finalReopen =
    await createLocalProviderObservationRuntime({
      cwd,
      clock: () =>
        new Date("2026-07-27T12:00:00.000Z")
    });
  assert.ok(
    (await finalReopen.createSnapshotImportFacade({
      provider: "linear",
      imports: {
        async applySnapshotImport() {
          throw new Error("not called");
        }
      }
    })) instanceof ObservedSnapshotImportFacade
  );
});

test("a corrupt observation store cannot change an inspect result but fails runtime opening", async (t) => {
  const cwd = await temporaryProject(t);
  const stateDirectory = join(cwd, ".taskseal");
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(
    join(
      stateDirectory,
      "provider-observations.json"
    ),
    "{",
    "utf8"
  );

  await assert.rejects(
    createLocalProviderObservationRuntime({ cwd }),
    hasCode("PROVIDER_OBSERVATION_STORE_CORRUPT")
  );

  let serverCreated = false;
  let commandCalls = 0;
  await assert.rejects(
    startPersistentControlRoom({
      cwd,
      output: createOutput(),
      initialize: async () => {},
      assessReadiness:
        async () =>
          readyRuntime(),
      commandRunner: async () => {
        commandCalls += 1;
        return {
          exitCode: 0,
          stdout: "",
          stderr: ""
        };
      },
      serverFactory: () => {
        serverCreated = true;
        throw new Error("server must not be created");
      },
      signalSource: new EventEmitter()
    }),
    hasCode("PROVIDER_OBSERVATION_STORE_CORRUPT")
  );
  assert.equal(serverCreated, false);
  assert.equal(commandCalls, 0);

  const output = createOutput();
  const snapshot = createSnapshot();
  const exitCode = await runCli({
    args: [
      "inspect",
      "github-issue",
      "--issue",
      "1",
      "--work-item",
      "TS-1",
      "--criterion",
      "tests",
      "--snapshot-version",
      "2",
      "--title-management",
      "none"
    ],
    cwd,
    output,
    providerObservationCoordinatorFactory: async ({
      cwd,
      clock
    }) =>
      (
        await createLocalProviderObservationRuntime({
          cwd,
          clock
        })
      ).coordinator,
    inspectGitHubIssue: async () => snapshot
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(output.text()), snapshot);
});

function readyRuntime() {
  return {
    node: {
      ready: true,
      version: "v24.12.0",
      failure: ""
    },
    project: {
      ready: true
    },
    capabilities: {
      github:
        "ready" as const,
      linear:
        "ready" as const,
      gitee:
        "disabled" as const,
      feishu:
        "disabled" as const
    },
    codex: {
      available: true,
      loggedIn: true,
      version: "codex-cli test"
    },
    ready: true
  };
}

function createSnapshot() {
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
          id: "revision-1",
          occurredAt: "2026-07-27T09:59:00.000Z",
          contentDigest: `sha256:${"a".repeat(64)}`
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

function createLinearSnapshot() {
  return {
    ...createSnapshot(),
    provider: "linear",
    scope: {
      kind: "team",
      key:
        "linear:team:" +
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      parentKey:
        "linear:organization:" +
        "abcdefab-cdef-4abc-8def-abcdefabcdef"
    },
    facts: createSnapshot().facts.map((fact) => ({
      ...fact,
      sourceObject: {
        ...fact.sourceObject,
        providerObjectKey: "linear:issue:1",
        provider: "linear",
        url: "https://linear.app/netpilot/issue/NP-1"
      },
      candidateEvent: {
        ...fact.candidateEvent,
        eventId: "linear:issue-1:created",
        payload: {
          ...fact.candidateEvent.payload,
          externalLink: {
            provider: "linear",
            externalId: "1",
            url: "https://linear.app/netpilot/issue/NP-1"
          }
        }
      }
    }))
  };
}

async function temporaryProject(
  t: TestContext
): Promise<string> {
  const cwd = await mkdtemp(
    join(tmpdir(), "taskseal-provider-runtime-")
  );
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({
      project: "TaskSeal",
      github: {
        repository: "netpilot-z/TaskSeal"
      },
      linear: {
        workspace: "netpilot-z",
        team: "netpilot"
      },
      mode: "persistent"
    }),
    "utf8"
  );
  return cwd;
}

function createOutput(): OutputPort & {
  text(): string;
} {
  const chunks: string[] = [];
  return {
    write(value: string) {
      chunks.push(value);
    },
    text() {
      return chunks.join("");
    }
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}
