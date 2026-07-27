import assert from "node:assert/strict";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

import {
  ProviderObservationReadModel
} from "../src/application/provider-observation.ts";
import type {
  ProviderObservationInput
} from "../src/application/provider-observation.ts";
import {
  FileProviderObservationStorage
} from "../src/storage/provider-observation-store.ts";

test("file Provider observations persist a bounded stable snapshot and recover on reopen", async (t) => {
  const { filePath } = await temporaryStore(t);
  const storage = new FileProviderObservationStorage({
    workspaceRoot: dirname(dirname(filePath)),
    filePath
  });
  const model =
    await ProviderObservationReadModel.open({ storage });

  assert.deepEqual(await model.list(), {
    schemaVersion: 1,
    revision:
      "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    providers: []
  });

  await Promise.all([
    model.record(
      observation({
        provider: "linear",
        configuredTarget: {
          kind: "team",
          key: "linear:team-ref:netpilot-z/netpilot"
        },
        observedScope: {
          kind: "team",
          key: "linear:team:11111111-1111-4111-8111-111111111111",
          parentKey:
            "linear:organization:22222222-2222-4222-8222-222222222222"
        }
      })
    ),
    model.record(observation())
  ]);

  const reopened = await ProviderObservationReadModel.open({
    storage: new FileProviderObservationStorage({
      workspaceRoot: dirname(dirname(filePath)),
      filePath
    })
  });
  const projection = await reopened.list();

  assert.deepEqual(
    projection.providers.map(
      (provider) => provider.provider
    ),
    ["github", "linear"]
  );
  assert.match(
    await readFile(filePath, "utf8"),
    /"schemaVersion":1/
  );
  assert.equal(
    (await readFile(filePath, "utf8")).endsWith("\n"),
    true
  );
});

test("file Provider observations fail closed for corrupt, duplicate, and oversized state", async (t) => {
  const scenarios: Array<{
    name: string;
    content: string;
  }> = [
    {
      name: "invalid JSON",
      content: "{"
    },
    {
      name: "extra envelope field",
      content: JSON.stringify({
        schemaVersion: 1,
        observations: [],
        rawPayload: "forbidden"
      })
    },
    {
      name: "oversized file",
      content: " ".repeat(256 * 1024 + 1)
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const { filePath } = await temporaryStore(t);
      await writeFile(filePath, scenario.content, "utf8");

      await assert.rejects(
        ProviderObservationReadModel.open({
          storage: new FileProviderObservationStorage({
            workspaceRoot: dirname(dirname(filePath)),
            filePath
          })
        }),
        hasCode("PROVIDER_OBSERVATION_STORE_CORRUPT")
      );
    });
  }

  await t.test("duplicate identity", async (t) => {
    const { filePath } = await temporaryStore(t);
    const model = await ProviderObservationReadModel.open({
      storage: new FileProviderObservationStorage({
        workspaceRoot: dirname(dirname(filePath)),
        filePath
      })
    });
    await model.record(observation());
    const persisted = JSON.parse(
      await readFile(filePath, "utf8")
    ) as {
      observations: unknown[];
    };
    persisted.observations.push(
      structuredClone(persisted.observations[0])
    );
    await writeFile(
      filePath,
      JSON.stringify(persisted),
      "utf8"
    );

    await assert.rejects(
      model.list(),
      hasCode("PROVIDER_OBSERVATION_STORE_CORRUPT")
    );
  });
});

test("file Provider observation failures preserve old state before rename and require reopen after rename", async (t) => {
  const { filePath } = await temporaryStore(t);
  const baselineStorage =
    new FileProviderObservationStorage({
      workspaceRoot: dirname(dirname(filePath)),
      filePath
    });
  const baseline =
    await ProviderObservationReadModel.open({
      storage: baselineStorage
    });
  await baseline.record(observation());
  const before = await readFile(filePath, "utf8");

  const preRename =
    await ProviderObservationReadModel.open({
      storage: new FileProviderObservationStorage({
        workspaceRoot: dirname(dirname(filePath)),
        filePath,
        failureInjector(stage) {
          if (stage === "after-temporary-sync") {
            throw new Error("simulated pre-rename failure");
          }
        }
      })
    });

  await assert.rejects(
    preRename.record(
      observation({
        startedAt: "2026-07-27T11:00:00.000Z",
        observedAt: "2026-07-27T11:00:00.100Z",
        status: "sync_failed",
        diagnosticCode: "GITHUB_REQUEST_FAILED"
      })
    ),
    hasCode("PROVIDER_OBSERVATION_WRITE_FAILED")
  );
  assert.equal(await readFile(filePath, "utf8"), before);
  await unlink(
    join(
      dirname(filePath),
      ".provider-observations.json.tmp"
    )
  );

  const postRename =
    await ProviderObservationReadModel.open({
      storage: new FileProviderObservationStorage({
        workspaceRoot: dirname(dirname(filePath)),
        filePath,
        failureInjector(stage) {
          if (stage === "after-rename") {
            throw new Error("simulated unknown outcome");
          }
        }
      })
    });

  await assert.rejects(
    postRename.record(
      observation({
        startedAt: "2026-07-27T12:00:00.000Z",
        observedAt: "2026-07-27T12:00:00.100Z",
        status: "sample_missing",
        diagnosticCode: "GITHUB_NOT_FOUND"
      })
    ),
    hasCode("PROVIDER_OBSERVATION_REOPEN_REQUIRED")
  );
  await assert.rejects(
    postRename.list(),
    hasCode("PROVIDER_OBSERVATION_REOPEN_REQUIRED")
  );

  const reopened = await ProviderObservationReadModel.open({
    storage: new FileProviderObservationStorage({
      workspaceRoot: dirname(dirname(filePath)),
      filePath
    })
  });
  assert.equal(
    (await reopened.list()).providers[0]?.status,
    "sample_missing"
  );
});

test("Provider observation queries reload a later atomic snapshot", async (t) => {
  const { filePath } = await temporaryStore(t);
  const first = await ProviderObservationReadModel.open({
    storage: new FileProviderObservationStorage({
      workspaceRoot: dirname(dirname(filePath)),
      filePath
    })
  });
  const second = await ProviderObservationReadModel.open({
    storage: new FileProviderObservationStorage({
      workspaceRoot: dirname(dirname(filePath)),
      filePath
    })
  });

  assert.equal((await first.list()).providers.length, 0);
  await second.record(observation());
  assert.equal((await first.list()).providers.length, 1);
});

test("file Provider observations reject a state directory symlink or Junction that escapes the workspace", async (t) => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "taskseal-provider-workspace-")
  );
  const outside = await mkdtemp(
    join(tmpdir(), "taskseal-provider-outside-")
  );
  t.after(() =>
    rm(workspaceRoot, { recursive: true, force: true })
  );
  t.after(() =>
    rm(outside, { recursive: true, force: true })
  );
  const stateDirectory = join(workspaceRoot, ".taskseal");
  await symlink(
    outside,
    stateDirectory,
    process.platform === "win32" ? "junction" : "dir"
  );
  assert.equal((await lstat(stateDirectory)).isSymbolicLink(), true);
  const filePath = join(
    stateDirectory,
    "provider-observations.json"
  );
  await assert.rejects(
    ProviderObservationReadModel.open({
      storage: new FileProviderObservationStorage({
        workspaceRoot,
        filePath
      })
    }),
    hasCode("PROVIDER_OBSERVATION_READ_FAILED")
  );
  await assert.rejects(
    readFile(
      join(outside, "provider-observations.json"),
      "utf8"
    ),
    (error) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
  );
});

test("file Provider observation reads remain bounded when the file grows after stat", async (t) => {
  const { filePath } = await temporaryStore(t);
  await writeFile(filePath, "{}", "utf8");
  let injected = false;
  const storage = new FileProviderObservationStorage({
    workspaceRoot: dirname(dirname(filePath)),
    filePath,
    async failureInjector(stage) {
      if (stage === "after-read-stat") {
        injected = true;
        await writeFile(
          filePath,
          " ".repeat(256 * 1024 + 1),
          "utf8"
        );
      }
    }
  });

  await assert.rejects(
    storage.load(),
    hasCode("PROVIDER_OBSERVATION_STORE_CORRUPT")
  );
  assert.equal(injected, true);
});

test("file Provider observation reads stay bound to the validated target file identity", async (t) => {
  const { filePath } = await temporaryStore(t);
  const outsidePath = join(
    dirname(dirname(filePath)),
    "replacement.json"
  );
  await writeFile(
    filePath,
    JSON.stringify({
      schemaVersion: 1,
      observations: []
    }),
    "utf8"
  );
  await writeFile(
    outsidePath,
    JSON.stringify({
      schemaVersion: 1,
      observations: []
    }),
    "utf8"
  );
  let injected = false;
  const storage = new FileProviderObservationStorage({
    workspaceRoot: dirname(dirname(filePath)),
    filePath,
    async failureInjector(stage) {
      if (stage === "before-read-open") {
        injected = true;
        await unlink(filePath);
        await link(outsidePath, filePath);
      }
    }
  });

  await assert.rejects(
    storage.load(),
    hasCode("PROVIDER_OBSERVATION_STORE_CORRUPT")
  );
  assert.equal(injected, true);
});

test("file Provider observation cleanup never follows a swapped state-directory Junction", async (t) => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "taskseal-provider-cleanup-workspace-")
  );
  const outside = await mkdtemp(
    join(tmpdir(), "taskseal-provider-cleanup-outside-")
  );
  t.after(() =>
    rm(workspaceRoot, { recursive: true, force: true })
  );
  t.after(() =>
    rm(outside, { recursive: true, force: true })
  );
  const stateDirectory = join(workspaceRoot, ".taskseal");
  const retainedDirectory = join(
    workspaceRoot,
    ".taskseal-retained"
  );
  const filePath = join(
    stateDirectory,
    "provider-observations.json"
  );
  await mkdir(stateDirectory);
  let victimPath = "";
  const storage = new FileProviderObservationStorage({
    workspaceRoot,
    filePath,
    async failureInjector(stage) {
      if (stage !== "after-temporary-sync") {
        return;
      }

      const temporaryName = (
        await readdir(stateDirectory)
      ).find((name) => name.endsWith(".tmp"));
      assert.ok(temporaryName);
      await rename(stateDirectory, retainedDirectory);
      await symlink(
        outside,
        stateDirectory,
        process.platform === "win32"
          ? "junction"
          : "dir"
      );
      victimPath = join(outside, temporaryName);
      await writeFile(
        victimPath,
        "outside file must survive",
        "utf8"
      );
    }
  });
  const model =
    await ProviderObservationReadModel.open({ storage });

  await assert.rejects(
    model.record(observation()),
    hasCode("PROVIDER_OBSERVATION_WRITE_FAILED")
  );
  assert.equal(
    await readFile(victimPath, "utf8"),
    "outside file must survive"
  );
});

test("file Provider observation write failures retain at most one bounded temporary slot", async (t) => {
  const { filePath } = await temporaryStore(t);
  const stateDirectory = dirname(filePath);
  const model =
    await ProviderObservationReadModel.open({
      storage: new FileProviderObservationStorage({
        workspaceRoot: dirname(stateDirectory),
        filePath,
        failureInjector(stage) {
          if (stage === "after-temporary-sync") {
            throw new Error("simulated write failure");
          }
        }
      })
    });

  await assert.rejects(
    model.record(observation()),
    hasCode("PROVIDER_OBSERVATION_WRITE_FAILED")
  );
  await assert.rejects(
    model.record(observation()),
    hasCode("PROVIDER_OBSERVATION_WRITE_FAILED")
  );

  assert.equal(
    (await readdir(stateDirectory)).filter(
      (name) => name.endsWith(".tmp")
    ).length,
    1
  );
});

function observation(
  overrides: Partial<ProviderObservationInput> = {}
): ProviderObservationInput {
  return {
    operation: "configuration",
    provider: "github",
    configuredTarget: {
      kind: "repository",
      key: "github:repository:netpilot-z/taskseal"
    },
    observedScope: null,
    status: "configured",
    startedAt: "2026-07-27T10:00:00.000Z",
    observedAt: "2026-07-27T10:00:00.100Z",
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

async function temporaryStore(
  t: TestContext
): Promise<{ filePath: string }> {
  const directory = await mkdtemp(
    join(tmpdir(), "taskseal-provider-observations-")
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateDirectory = join(directory, "state");
  await mkdir(stateDirectory, { recursive: true });
  return {
    filePath: join(
      stateDirectory,
      "provider-observations.json"
    )
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}
