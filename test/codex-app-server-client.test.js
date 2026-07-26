import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CodexAppServerClient,
  buildRunnerEnvironment
} from "../src/runners/codex-app-server-client.js";

const fakeServerPath = fileURLToPath(
  new URL("../test-support/fake-app-server.js", import.meta.url)
);

test("client completes the App Server handshake and one turn", async () => {
  const client = createClient("completed");

  const result = await client.runTurn({
    cwd: process.cwd(),
    prompt: "Return a fixed test response.",
    sandbox: "read-only"
  });

  assert.deepEqual(result, {
    outcome: "completed",
    threadId: "thread-1",
    turnId: "turn-1",
    summary: null
  });
});

test("client maps failed and interrupted terminal turns", async () => {
  for (const scenario of ["failed", "interrupted"]) {
    const client = createClient(scenario);
    const result = await client.runTurn({
      cwd: process.cwd(),
      prompt: "Exercise a terminal state.",
      sandbox: "read-only"
    });

    assert.equal(result.outcome, scenario);
    assert.equal(result.threadId, "thread-1");
    assert.equal(result.turnId, "turn-1");

    if (scenario === "failed") {
      assert.equal(result.summary, "Fake turn failed.");
    }
  }
});

test("client declines unexpected command approvals instead of hanging", async () => {
  const observations = [];
  const client = createClient("approval", {
    onObservation(observation) {
      observations.push(observation);
    }
  });

  const result = await client.runTurn({
    cwd: process.cwd(),
    prompt: "Request an approval.",
    sandbox: "read-only"
  });

  assert.equal(result.outcome, "completed");
  assert.deepEqual(observations, [
    {
      type: "approval.denied",
      method: "item/commandExecution/requestApproval"
    }
  ]);
});

test("client fails closed on invalid JSON and early process exit", async () => {
  await assert.rejects(
    createClient("invalid-json").runTurn({
      cwd: process.cwd(),
      prompt: "Emit invalid JSON.",
      sandbox: "read-only"
    }),
    (error) => error.code === "CODEX_PROTOCOL_ERROR"
  );

  await assert.rejects(
    createClient("invalid-envelope").runTurn({
      cwd: process.cwd(),
      prompt: "Emit a JSON scalar.",
      sandbox: "read-only"
    }),
    (error) => error.code === "CODEX_PROTOCOL_ERROR"
  );

  await assert.rejects(
    createClient("early-exit").runTurn({
      cwd: process.cwd(),
      prompt: "Exit early.",
      sandbox: "read-only"
    }),
    (error) => error.code === "CODEX_PROCESS_EXITED"
  );
});

test("client clears notification waiters when turn/start is rejected", async () => {
  const client = createClient("turn-start-error", {
    turnTimeoutMs: 200
  });

  await assert.rejects(
    client.runTurn({
      cwd: process.cwd(),
      prompt: "Reject turn start.",
      sandbox: "read-only"
    }),
    (error) => error.code === "CODEX_RESPONSE_ERROR"
  );

  assert.equal(client.notificationWaiters.size, 0);
  assert.equal(client.pendingRequests.size, 0);
});

test("client bounds abort cleanup when App Server ignores interrupt", async () => {
  const controller = new AbortController();
  const client = createClient("uninterruptible", {
    turnTimeoutMs: 2_000,
    shutdownGraceMs: 40
  });
  const run = client.runTurn({
    cwd: process.cwd(),
    prompt: "Wait until interrupted.",
    sandbox: "read-only",
    signal: controller.signal
  });

  setTimeout(() => controller.abort(), 30);

  await assert.rejects(
    run,
    (error) => error.code === "CODEX_INTERRUPTED"
  );
  assert.equal(client.notificationWaiters.size, 0);
  assert.equal(client.pendingRequests.size, 0);
});

test("client bounds abort cleanup before App Server initialization completes", async () => {
  const controller = new AbortController();
  const client = createClient("initialize-timeout", {
    requestTimeoutMs: 2_000,
    shutdownGraceMs: 40
  });
  const run = client.runTurn({
    cwd: process.cwd(),
    prompt: "Abort during initialization.",
    sandbox: "read-only",
    signal: controller.signal
  });

  setTimeout(() => controller.abort(), 30);

  await assert.rejects(
    run,
    (error) => error.code === "CODEX_INTERRUPTED"
  );
  assert.equal(client.notificationWaiters.size, 0);
  assert.equal(client.pendingRequests.size, 0);
});

test("client rejects a completion for a different turn id", async () => {
  await assert.rejects(
    createClient("mismatched-turn").runTurn({
      cwd: process.cwd(),
      prompt: "Reject the wrong terminal turn.",
      sandbox: "read-only"
    }),
    (error) => error.code === "CODEX_PROTOCOL_ERROR"
  );
});

test("client times out a turn that never reaches a terminal notification", async () => {
  await assert.rejects(
    createClient("timeout", {
      turnTimeoutMs: 50
    }).runTurn({
      cwd: process.cwd(),
      prompt: "Never complete.",
      sandbox: "read-only"
    }),
    (error) => error.code === "CODEX_REQUEST_TIMEOUT"
  );
});

test("runner environment removes external provider credentials", () => {
  const environment = buildRunnerEnvironment({
    PATH: "safe",
    CODEX_HOME: "codex-home",
    GITHUB_TOKEN: "secret",
    GH_TOKEN: "secret",
    LINEAR_API_KEY: "secret",
    GITEE_TOKEN: "secret",
    FEISHU_APP_SECRET: "secret",
    LARK_APP_SECRET: "secret"
  });

  assert.deepEqual(environment, {
    PATH: "safe",
    CODEX_HOME: "codex-home"
  });
});

function createClient(scenario, overrides = {}) {
  return new CodexAppServerClient({
    invocation: {
      command: process.execPath,
      argsPrefix: [fakeServerPath]
    },
    environment: {
      ...process.env,
      FAKE_APP_SERVER_SCENARIO: scenario
    },
    requestTimeoutMs: 2_000,
    turnTimeoutMs: 2_000,
    shutdownGraceMs: 100,
    ...overrides
  });
}
