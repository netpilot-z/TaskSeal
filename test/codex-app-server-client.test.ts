import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CodexAppServerClient,
  buildRunnerEnvironment
} from "../src/runners/codex-app-server-client.ts";
import type {
  CodexAppServerObservation
} from "../src/runners/codex-app-server-client.ts";

interface ClientOverrides {
  requestTimeoutMs?: number | undefined;
  turnTimeoutMs?: number | undefined;
  shutdownGraceMs?: number | undefined;
  lineLimitBytes?: number | undefined;
  onObservation?:
    | ((observation: CodexAppServerObservation) => void)
    | undefined;
}

const fakeServerPath = fileURLToPath(
  new URL("../test-support/fake-app-server.ts", import.meta.url)
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

test("client rejects an invalid response envelope", async () => {
  await assert.rejects(
    createClient("invalid-response-envelope").runTurn({
      cwd: process.cwd(),
      prompt: "Reject an ambiguous response.",
      sandbox: "read-only"
    }),
    hasError(
      "CODEX_PROTOCOL_ERROR",
      "Codex App Server emitted an invalid response envelope."
    )
  );
});

test("client rejects a malformed initialize result", async () => {
  await assert.rejects(
    createClient("malformed-initialize").runTurn({
      cwd: process.cwd(),
      prompt: "Reject a malformed initialize result.",
      sandbox: "read-only"
    }),
    hasError(
      "CODEX_PROTOCOL_ERROR",
      "Codex App Server returned an invalid initialize result."
    )
  );
});

test("client rejects a malformed thread/start result", async () => {
  await assert.rejects(
    createClient("malformed-thread-start").runTurn({
      cwd: process.cwd(),
      prompt: "Reject a malformed thread.",
      sandbox: "read-only"
    }),
    hasError(
      "CODEX_PROTOCOL_ERROR",
      "Codex App Server returned an invalid thread/start result."
    )
  );
});

test("client rejects a malformed turn/start result", async () => {
  await assert.rejects(
    createClient("malformed-turn-start").runTurn({
      cwd: process.cwd(),
      prompt: "Reject a malformed turn.",
      sandbox: "read-only"
    }),
    hasError(
      "CODEX_PROTOCOL_ERROR",
      "Codex App Server returned an invalid turn/start result."
    )
  );
});

test("client fails closed on an unknown response id", async () => {
  await assert.rejects(
    createClient("unknown-response-id").runTurn({
      cwd: process.cwd(),
      prompt: "Reject an unknown response.",
      sandbox: "read-only"
    }),
    hasError(
      "CODEX_PROTOCOL_ERROR",
      "Codex App Server returned an unknown response id."
    )
  );
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
  const observations: CodexAppServerObservation[] = [];
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

test("client declines unexpected file change approvals instead of hanging", async () => {
  const observations: CodexAppServerObservation[] = [];
  const client = createClient("file-approval", {
    onObservation(observation) {
      observations.push(observation);
    }
  });

  const result = await client.runTurn({
    cwd: process.cwd(),
    prompt: "Request a file change approval.",
    sandbox: "read-only"
  });

  assert.equal(result.outcome, "completed");
  assert.deepEqual(observations, [
    {
      type: "approval.denied",
      method: "item/fileChange/requestApproval"
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
    hasCode("CODEX_PROTOCOL_ERROR")
  );

  await assert.rejects(
    createClient("invalid-envelope").runTurn({
      cwd: process.cwd(),
      prompt: "Emit a JSON scalar.",
      sandbox: "read-only"
    }),
    hasCode("CODEX_PROTOCOL_ERROR")
  );

  await assert.rejects(
    createClient("early-exit").runTurn({
      cwd: process.cwd(),
      prompt: "Exit early.",
      sandbox: "read-only"
    }),
    hasCode("CODEX_PROCESS_EXITED")
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
    hasError(
      "CODEX_RESPONSE_ERROR",
      "Codex App Server rejected turn/start with code -32602."
    )
  );

  assert.equal(client.notificationWaiters.size, 0);
  assert.equal(client.pendingRequests.size, 0);
});

test("client bounds abort cleanup when App Server ignores interrupt", async () => {
  const controller = new AbortController();
  const client = createClient("uninterruptible", {
    turnTimeoutMs: 2_000,
    shutdownGraceMs: 250
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
    hasCode("CODEX_INTERRUPTED")
  );
  assert.equal(client.notificationWaiters.size, 0);
  assert.equal(client.pendingRequests.size, 0);
});

test("client bounds abort cleanup before App Server initialization completes", async () => {
  const controller = new AbortController();
  const client = createClient("initialize-timeout", {
    requestTimeoutMs: 2_000,
    shutdownGraceMs: 250
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
    hasCode("CODEX_INTERRUPTED")
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
    hasCode("CODEX_PROTOCOL_ERROR")
  );
});

test("client immediately rejects a completion for a different thread id", async () => {
  await assert.rejects(
    createClient("mismatched-thread", {
      turnTimeoutMs: 50
    }).runTurn({
      cwd: process.cwd(),
      prompt: "Reject the wrong terminal thread.",
      sandbox: "read-only"
    }),
    hasError(
      "CODEX_PROTOCOL_ERROR",
      "Codex turn/completed did not match the active thread id."
    )
  );
});

test("client rejects a malformed turn/completed notification", async () => {
  await assert.rejects(
    createClient("malformed-turn-completed", {
      turnTimeoutMs: 50
    }).runTurn({
      cwd: process.cwd(),
      prompt: "Reject a malformed terminal notification.",
      sandbox: "read-only"
    }),
    hasError(
      "CODEX_PROTOCOL_ERROR",
      "Codex App Server emitted an invalid turn/completed notification."
    )
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
    hasCode("CODEX_REQUEST_TIMEOUT")
  );
});

test("runner environment removes external provider credentials", () => {
  const environment = buildRunnerEnvironment({
    PATH: "safe",
    CODEX_HOME: "codex-home",
    OPENAI_API_KEY: "runner-secret",
    GITHUB_TOKEN: "secret",
    GH_TOKEN: "secret",
    LINEAR_API_KEY: "secret",
    GITEE_TOKEN: "secret",
    FEISHU_APP_SECRET: "secret",
    LARK_APP_SECRET: "secret",
    AWS_SECRET_ACCESS_KEY: "secret",
    NPM_TOKEN: "secret",
    UNRELATED_SECRET: "secret",
    TASKSEAL_HUMAN_ACTOR:
      "operator.jeffrey"
  });

  assert.deepEqual(environment, {
    PATH: "safe",
    CODEX_HOME: "codex-home",
    OPENAI_API_KEY: "runner-secret"
  });
});

test("runner environment filters every non-allowlisted key before reading its value", () => {
  let sensitiveReads = 0;
  const source = {
    PATH: "safe"
  } as NodeJS.ProcessEnv;
  for (const key of [
    "LINEAR_API_KEY",
    "TASKSEAL_HUMAN_ACTOR",
    "AWS_SECRET_ACCESS_KEY",
    "UNRELATED_SECRET"
  ]) {
    Object.defineProperty(source, key, {
      enumerable: true,
      get() {
        sensitiveReads += 1;
        return "secret";
      }
    });
  }

  assert.deepEqual(
    buildRunnerEnvironment(source),
    { PATH: "safe" }
  );
  assert.equal(sensitiveReads, 0);
});

test("runner environment admits an explicit adapter-only test key without admitting other keys", () => {
  assert.deepEqual(
    buildRunnerEnvironment(
      {
        PATH: "safe",
        FAKE_APP_SERVER_SCENARIO:
          "completed",
        UNRELATED_SECRET: "secret"
      },
      ["FAKE_APP_SERVER_SCENARIO"]
    ),
    {
      PATH: "safe",
      FAKE_APP_SERVER_SCENARIO:
        "completed"
    }
  );
});

test("runner environment cannot explicitly allowlist a control-plane credential", () => {
  assert.throws(
    () =>
      buildRunnerEnvironment(
        {
          LINEAR_API_KEY: "secret"
        },
        ["LINEAR_API_KEY"]
      ),
    /control-plane key/
  );
});

test("client fails when bounded shutdown cannot confirm process exit", async () => {
  const child = new NeverClosingChildProcess();
  const client = new CodexAppServerClient({
    invocation: {
      command: "fake-codex",
      argsPrefix: []
    },
    environment: {},
    shutdownGraceMs: 10,
    spawnProcess: () => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }
  });

  await client.start(process.cwd());
  await assert.rejects(
    client.stop(),
    hasCode(
      "CODEX_PROCESS_CLEANUP_FAILED"
    )
  );

  assert.equal(child.killCalls, 1);
  assert.equal(child.listenerCount("close"), 1);
});

test("client rejects invalid timeout configuration before spawning", () => {
  for (const options of [
    { requestTimeoutMs: 0 },
    { turnTimeoutMs: -1 },
    { shutdownGraceMs: Number.NaN }
  ]) {
    assert.throws(
      () =>
        new CodexAppServerClient({
          invocation: {
            command: "fake-codex",
            argsPrefix: []
          },
          ...options
        }),
      /positive integer/
    );
  }
});

function createClient(
  scenario: string,
  overrides: ClientOverrides = {}
): CodexAppServerClient {
  return new CodexAppServerClient({
    invocation: {
      command: process.execPath,
      argsPrefix: [fakeServerPath]
    },
    environment: {
      ...process.env,
      FAKE_APP_SERVER_SCENARIO: scenario
    },
    environmentAllowlist: [
      "FAKE_APP_SERVER_SCENARIO"
    ],
    requestTimeoutMs: 2_000,
    turnTimeoutMs: 2_000,
    shutdownGraceMs: 100,
    ...overrides
  });
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}

function hasError(code: string, message: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code &&
    error.message === message;
}

class NeverClosingChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  killCalls = 0;

  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killCalls += 1;
    return true;
  }
}
