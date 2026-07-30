import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, {
  type TestContext
} from "node:test";

import {
  createLocalLinearAcceptanceRuntime
} from "../src/linear-acceptance-runtime.ts";

test("disabled acceptance transition opens local decision without reading credentials or network", async (t) => {
  const cwd = await createProject(
    t,
    { enabled: false }
  );
  const credentialReads: string[] = [];
  const environment = new Proxy(
    {
      TASKSEAL_HUMAN_ACTOR:
        "operator.jeffrey"
    } as NodeJS.ProcessEnv,
    {
      get(target, key, receiver) {
        if (
          key === "LINEAR_API_KEY" ||
          key === "LINEAR_ACCESS_TOKEN"
        ) {
          credentialReads.push(key);
        }
        return Reflect.get(
          target,
          key,
          receiver
        );
      }
    }
  );
  let fetchCalls = 0;

  const runtime =
    await createLocalLinearAcceptanceRuntime({
      cwd,
      service: servicePort(),
      environment,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error(
          "disabled runtime must not fetch"
        );
      }
    });

  assert.deepEqual(runtime.capabilities, {
    decideAcceptance: true,
    linearTransition: false,
    reconcileLinearTransition: false
  });
  assert.ok(runtime.acceptance);
  assert.deepEqual(credentialReads, []);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(
    await runtime.providerOperations
      .listLatest(),
    []
  );
});

test("local acceptance remains available when Linear is not configured", async (t) => {
  const cwd = await mkdtemp(
    join(
      tmpdir(),
      "taskseal-local-acceptance-"
    )
  );
  t.after(() =>
    rm(cwd, {
      recursive: true,
      force: true
    })
  );
  await mkdir(
    join(cwd, "config"),
    { recursive: true }
  );
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({
      project: "TaskSeal"
    })
  );
  let fetchCalls = 0;

  const runtime =
    await createLocalLinearAcceptanceRuntime({
      cwd,
      service: servicePort(),
      environment: {
        TASKSEAL_HUMAN_ACTOR:
          "operator.jeffrey"
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("must not fetch");
      }
    });

  assert.ok(runtime.acceptance);
  assert.deepEqual(runtime.capabilities, {
    decideAcceptance: true,
    linearTransition: false,
    reconcileLinearTransition: false
  });
  assert.equal(fetchCalls, 0);
});

test("missing local actor disables local decision when transition is disabled", async (t) => {
  const cwd = await createProject(
    t,
    { enabled: false }
  );
  const runtime =
    await createLocalLinearAcceptanceRuntime({
      cwd,
      service: servicePort(),
      environment: {},
      fetchImpl: async () => {
        throw new Error("must not fetch");
      }
    });

  assert.equal(runtime.acceptance, null);
  assert.deepEqual(runtime.capabilities, {
    decideAcceptance: false,
    linearTransition: false,
    reconcileLinearTransition: false
  });
});

test("enabled transition fails closed without actor before credential access", async (t) => {
  const cwd = await createProject(
    t,
    {
      enabled: true,
      expectedState: "In Progress",
      targetState: "Done"
    }
  );
  let credentialReads = 0;
  const environment = new Proxy(
    {} as NodeJS.ProcessEnv,
    {
      get(target, key, receiver) {
        if (
          key === "LINEAR_API_KEY" ||
          key === "LINEAR_ACCESS_TOKEN"
        ) {
          credentialReads += 1;
        }
        return Reflect.get(
          target,
          key,
          receiver
        );
      }
    }
  );

  await assert.rejects(
    createLocalLinearAcceptanceRuntime({
      cwd,
      service: servicePort(),
      environment,
      fetchImpl: async () => {
        throw new Error("must not fetch");
      }
    }),
    hasCode(
      "LINEAR_ACCEPTANCE_ACTOR_REQUIRED"
    )
  );
  assert.equal(credentialReads, 0);
});

test("enabled transition resolves exact acceptance scope and shares one operation journal", async (t) => {
  const cwd = await createProject(
    t,
    {
      enabled: true,
      expectedState: "In Progress",
      targetState: "Done"
    }
  );
  const operations: string[] = [];
  const runtime =
    await createLocalLinearAcceptanceRuntime({
      cwd,
      service: servicePort(),
      environment: {
        TASKSEAL_HUMAN_ACTOR:
          "operator.jeffrey",
        LINEAR_API_KEY: "test-key"
      },
      fetchImpl: async (
        _url: string | URL | Request,
        options?: RequestInit
      ) => {
        const body = JSON.parse(
          String(options?.body)
        );
        operations.push(body.query);
        return new Response(
          JSON.stringify({
            data:
              graphqlData(body.query)
          }),
          {
            status: 200,
            headers: {
              "content-type":
                "application/json"
            }
          }
        );
      }
    });

  assert.ok(runtime.acceptance);
  assert.deepEqual(runtime.capabilities, {
    decideAcceptance: true,
    linearTransition: true,
    reconcileLinearTransition: true
  });
  assert.equal(operations.length, 4);
  assert.deepEqual(
    await runtime.providerOperations
      .listLatest(),
    []
  );
});

function graphqlData(query: string) {
  if (
    query.includes(
      "TaskSealResolveBootstrapScope"
    )
  ) {
    return {
      organization: {
        id:
          "7eb4877f-0fa0-429c-9cd2-76dfffa0f20b",
        name: "NetPilot",
        urlKey: "netpilot-z"
      },
      teams: connection([{
        id:
          "658d1189-f63d-4245-b761-0f4f2c389663",
        name: "netpilot",
        key: "NP"
      }])
    };
  }
  if (
    query.includes(
      "TaskSealResolveBootstrapProjects"
    )
  ) {
    return {
      projects: connection([{
        id:
          "3e1b05e6-0a14-43d4-9fed-e1bee6ef0683",
        name: "TaskSeal"
      }])
    };
  }
  if (
    query.includes(
      "TaskSealResolveBootstrapProjectTeams"
    )
  ) {
    return {
      project: {
        id:
          "3e1b05e6-0a14-43d4-9fed-e1bee6ef0683",
        teams: connection([{
          id:
            "658d1189-f63d-4245-b761-0f4f2c389663"
        }])
      }
    };
  }
  return {
    team: {
      id:
        "658d1189-f63d-4245-b761-0f4f2c389663",
      states: connection([
        {
          id:
            "e3063543-b673-402a-924f-1516864d67f6",
          name: "In Progress",
          type: "started"
        },
        {
          id:
            "2d716bbd-be75-4718-95c9-27f184d19e56",
          name: "Done",
          type: "completed"
        }
      ])
    }
  };
}

function connection(nodes: unknown[]) {
  return {
    nodes,
    pageInfo: {
      hasNextPage: false,
      endCursor: null
    }
  };
}

function servicePort() {
  return {
    async decideAcceptance() {
      throw new Error(
        "not exercised by composition test"
      );
    },
    getWorkItem() {
      return null;
    }
  };
}

async function createProject(
  t: TestContext,
  acceptance: unknown
) {
  const cwd = await mkdtemp(
    join(
      tmpdir(),
      "taskseal-linear-acceptance-"
    )
  );
  t.after(() =>
    rm(cwd, {
      recursive: true,
      force: true
    })
  );
  await mkdir(
    join(cwd, "config"),
    { recursive: true }
  );
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({
      project: "TaskSeal",
      linear: {
        workspace: "netpilot-z",
        team: "netpilot",
        project: "TaskSeal",
        acceptance
      }
    })
  );
  return cwd;
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}
