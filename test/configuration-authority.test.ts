import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  resolveConfigurationAuthority
} from "../src/application/configuration-authority.ts";
import {
  acquireControlRoomLock
} from "../src/application/control-room-lock.ts";
import {
  inspectConfiguration
} from "../src/application/configuration-control.ts";
import {
  runCli
} from "../src/cli.ts";

test("configuration authority hands a running instance the exact revision-bound change", async (t) => {
  const cwd = await createProject(t);
  const view = await inspectConfiguration({ cwd, environment: {} });
  const instanceId = "55555555-5555-4555-8555-555555555555";
  const submitted: unknown[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/api/configuration") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        schemaVersion: "control-room-configuration/v1",
        instanceId,
        csrfToken: "csrf-test-token-123",
        configuration: view
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/configuration/change") {
      assert.equal(
        request.headers["x-taskseal-csrf-token"],
        "csrf-test-token-123"
      );
      submitted.push({
        route: "change",
        body: JSON.parse(await readRequestBody(request))
      });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        schemaVersion: "configuration-receipt/v1",
        planDigest: `sha256:${"a".repeat(64)}`,
        previousRevision: view.revision,
        revision: `sha256:${"b".repeat(64)}`,
        applied: true,
        replayed: false,
        restartRequired: true
      }));
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/api/configuration/drafts/project"
    ) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        instanceId,
        draft: {
          schemaVersion: "configuration-draft/v1",
          revision: view.revision,
          target: {
            scope: "project",
            path: "config/project.json",
            revision: view.source.revision
          },
          document: { project: "TaskSeal" }
        }
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/configuration/draft") {
      submitted.push({
        route: "draft",
        body: JSON.parse(await readRequestBody(request))
      });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        schemaVersion: "configuration-receipt/v1",
        planDigest: `sha256:${"a".repeat(64)}`,
        previousRevision: view.revision,
        revision: `sha256:${"b".repeat(64)}`,
        applied: true,
        replayed: false,
        restartRequired: true
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await listen(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const lock = await acquireControlRoomLock({
    cwd,
    nonce: instanceId,
    endpoint: { host: "127.0.0.1", port: address.port }
  });
  t.after(() => lock.release());

  const output = createOutput();
  const exitCode = await runCli({
    args: ["config", "set", "runtime.port", "7400", "--json"],
    cwd,
    environment: {},
    output
  });
  const receipt = JSON.parse(output.text()) as {
    applied?: unknown;
  };

  assert.equal(exitCode, 0);
  assert.equal(receipt.applied, true);
  assert.deepEqual(submitted, [{
    route: "change",
    body: {
      expectedRevision: view.revision,
      change: {
        operation: "set",
        key: "runtime.port",
        value: 7400
      }
    }
  }]);

  const editOutput = createOutput();
  assert.equal(
    await runCli({
      args: ["config", "edit", "project", "--json"],
      cwd,
      environment: {},
      output: editOutput,
      configurationEditor: async ({ filePath }) => {
        await writeFile(
          filePath,
          JSON.stringify({ project: "TaskSeal", mode: "persistent" })
        );
        return 0;
      }
    }),
    0
  );
  assert.equal(JSON.parse(editOutput.text()).applied, true);
  assert.deepEqual(submitted[1], {
    route: "draft",
    body: {
      expectedRevision: view.revision,
      scope: "project",
      document: { project: "TaskSeal", mode: "persistent" }
    }
  });
  await assert.rejects(
    readFile(join(cwd, ".taskseal", "config.local.json")),
    hasFileCode("ENOENT")
  );
});

test("configuration authority rejects a lock endpoint that cannot prove its instance identity", async (t) => {
  const cwd = await createProject(t);
  const view = await inspectConfiguration({ cwd, environment: {} });
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      schemaVersion: "control-room-configuration/v1",
      instanceId: "different-instance",
      csrfToken: "csrf-test-token-123",
      configuration: view
    }));
  });
  await listen(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const lock = await acquireControlRoomLock({
    cwd,
    nonce: "66666666-6666-4666-8666-666666666666",
    endpoint: { host: "127.0.0.1", port: address.port }
  });
  t.after(() => lock.release());

  await assert.rejects(
    resolveConfigurationAuthority({ cwd, environment: {} }),
    hasCode("CONTROL_ROOM_HANDOFF_UNAVAILABLE")
  );
});

async function createProject(t: TestContext): Promise<string> {
  const cwd = await createTemporaryDirectory(t);
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({ project: "TaskSeal" })
  );
  return cwd;
}

async function createTemporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taskseal-authority-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function readRequestBody(request: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === code;
}

function hasFileCode(code: string): (error: unknown) => boolean {
  return hasCode(code);
}

function createOutput(): {
  write(value: string): void;
  text(): string;
} {
  let value = "";
  return {
    write(chunk) { value += chunk; },
    text() { return value; }
  };
}
