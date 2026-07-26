import { spawn } from "node:child_process";

const DEFAULT_LINE_LIMIT_BYTES = 10 * 1024 * 1024;
const BLOCKED_ENVIRONMENT_KEYS = [
  /^GH_TOKEN$/i,
  /^GITHUB_TOKEN$/i,
  /^LINEAR_/i,
  /^GITEE_/i,
  /^FEISHU_/i,
  /^LARK_/i
];

export class CodexAppServerClient {
  constructor({
    invocation,
    environment = process.env,
    requestTimeoutMs = 30_000,
    turnTimeoutMs = 10 * 60_000,
    shutdownGraceMs = 1_000,
    lineLimitBytes = DEFAULT_LINE_LIMIT_BYTES,
    onObservation = () => {},
    spawnProcess = spawn
  }) {
    if (
      !invocation ||
      typeof invocation.command !== "string" ||
      !Array.isArray(invocation.argsPrefix)
    ) {
      throw new TypeError(
        "Codex App Server invocation requires command and argsPrefix."
      );
    }

    this.invocation = invocation;
    this.environment = buildRunnerEnvironment(environment);
    this.requestTimeoutMs = requestTimeoutMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.shutdownGraceMs = shutdownGraceMs;
    this.lineLimitBytes = lineLimitBytes;
    this.onObservation = onObservation;
    this.spawnProcess = spawnProcess;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.notificationWaiters = new Set();
    this.stdoutBuffer = "";
    this.stderr = "";
    this.child = null;
    this.stopping = false;
    this.failure = null;
  }

  async runTurn({
    cwd,
    prompt,
    sandbox = "workspace-write",
    approvalPolicy = "never",
    signal
  }) {
    validateRunInput({ cwd, prompt, sandbox, approvalPolicy });

    let threadId;
    let turnId;
    let abortHandler;
    let abortTimer;
    let abortTriggered = false;
    let rejectAbort;
    const abortPromise = signal
      ? new Promise((_, reject) => {
          rejectAbort = reject;
        })
      : null;
    const waitForAbortable = (operation) =>
      abortPromise
        ? Promise.race([operation, abortPromise])
        : operation;

    if (signal) {
      abortHandler = () => {
        if (abortTriggered) {
          return;
        }

        abortTriggered = true;
        const error = new CodexAppServerError(
          "CODEX_INTERRUPTED",
          "Codex App Server run was interrupted."
        );

        if (!threadId || !turnId) {
          rejectAbort(error);
          return;
        }

        this.request("turn/interrupt", {
          threadId,
          turnId
        }).catch(() => undefined);
        abortTimer = setTimeout(() => {
          rejectAbort(
            new CodexAppServerError(
              "CODEX_INTERRUPTED",
              "Codex App Server did not acknowledge interruption before shutdown."
            )
          );
        }, this.shutdownGraceMs);
      };

      if (signal.aborted) {
        abortHandler();
      } else {
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    try {
      await waitForAbortable(this.start(cwd));
      await waitForAbortable(
        this.request("initialize", {
          clientInfo: {
            name: "taskseal",
            title: "TaskSeal",
            version: "0.0.0-experiment.2"
          }
        })
      );
      this.notify("initialized", {});

      const threadResponse = await waitForAbortable(
        this.request("thread/start", {
          cwd,
          sandbox,
          approvalPolicy,
          ephemeral: true
        })
      );
      threadId = threadResponse?.thread?.id;

      if (!isNonEmptyString(threadId)) {
        throw new CodexAppServerError(
          "CODEX_PROTOCOL_ERROR",
          "Codex thread/start response did not include a thread id."
        );
      }

      const completionPromise = this.waitForNotification(
        (message) =>
          message.method === "turn/completed" &&
          message.params?.threadId === threadId,
        this.turnTimeoutMs
      );
      completionPromise.catch(() => undefined);

      const turnResponse = await waitForAbortable(
        this.request("turn/start", {
          threadId,
          input: [
            {
              type: "text",
              text: prompt
            }
          ]
        })
      );
      turnId = turnResponse?.turn?.id;

      if (!isNonEmptyString(turnId)) {
        throw new CodexAppServerError(
          "CODEX_PROTOCOL_ERROR",
          "Codex turn/start response did not include a turn id."
        );
      }

      const completion = await waitForAbortable(completionPromise);
      return this.createRunResult({
        completion,
        threadId,
        turnId
      });
    } finally {
      if (abortTimer) {
        clearTimeout(abortTimer);
      }

      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }

      await this.stop();
    }
  }

  createRunResult({ completion, threadId, turnId }) {
    const completedTurn = completion.params?.turn;
    const outcome = completedTurn?.status;

    if (completedTurn?.id !== turnId) {
      throw new CodexAppServerError(
        "CODEX_PROTOCOL_ERROR",
        "Codex turn/completed did not match the active turn id."
      );
    }

    if (
      outcome !== "completed" &&
      outcome !== "failed" &&
      outcome !== "interrupted"
    ) {
      throw new CodexAppServerError(
        "CODEX_PROTOCOL_ERROR",
        "Codex turn/completed contained an unsupported terminal status."
      );
    }

    return {
      outcome,
      threadId,
      turnId,
      summary: extractTurnSummary(completedTurn)
    };
  }

  async start(cwd) {
    if (this.child) {
      throw new CodexAppServerError(
        "CODEX_PROTOCOL_ERROR",
        "Codex App Server client cannot be started twice."
      );
    }

    const args = [
      ...this.invocation.argsPrefix,
      "app-server",
      "--listen",
      "stdio://",
      "--strict-config"
    ];
    const child = this.spawnProcess(this.invocation.command, args, {
      cwd,
      env: this.environment,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.consumeStdout(chunk));
    child.stdout.on("error", (error) => this.handleStreamError(error));
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_192);
    });
    child.stderr.on("error", (error) => this.handleStreamError(error));
    child.stdin.on("error", (error) => this.handleStreamError(error));
    child.once("error", (error) => {
      this.fail(
        new CodexAppServerError(
          "CODEX_NOT_AVAILABLE",
          "TaskSeal could not start Codex App Server.",
          { cause: error }
        )
      );
    });
    child.once("close", (exitCode) => {
      if (!this.stopping && !this.failure) {
        this.fail(
          new CodexAppServerError(
            "CODEX_PROCESS_EXITED",
            `Codex App Server exited before turn completion with code ${
              exitCode ?? "unknown"
            }.`
          )
        );
      }
    });

    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    }).catch((error) => {
      throw new CodexAppServerError(
        "CODEX_NOT_AVAILABLE",
        "TaskSeal could not start Codex App Server.",
        { cause: error }
      );
    });
  }

  request(method, params) {
    if (this.failure) {
      return Promise.reject(this.failure);
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new CodexAppServerError(
            "CODEX_REQUEST_TIMEOUT",
            `Codex App Server request ${method} timed out.`
          )
        );
      }, this.requestTimeoutMs);
      this.pendingRequests.set(id, {
        method,
        resolve,
        reject,
        timer
      });

      try {
        this.writeMessage({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.writeMessage({ method, params });
  }

  waitForNotification(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: null
      };
      waiter.timer = setTimeout(() => {
        this.notificationWaiters.delete(waiter);
        reject(
          new CodexAppServerError(
            "CODEX_REQUEST_TIMEOUT",
            "Codex turn did not reach a terminal state before its deadline."
          )
        );
      }, timeoutMs);
      this.notificationWaiters.add(waiter);
    });
  }

  consumeStdout(chunk) {
    this.stdoutBuffer += chunk;

    if (
      !this.stdoutBuffer.includes("\n") &&
      Buffer.byteLength(this.stdoutBuffer, "utf8") > this.lineLimitBytes
    ) {
      this.fail(
        new CodexAppServerError(
          "CODEX_PROTOCOL_ERROR",
          "Codex App Server emitted a JSONL line larger than the configured limit."
        )
      );
      return;
    }

    let newlineIndex = this.stdoutBuffer.indexOf("\n");

    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      if (Buffer.byteLength(line, "utf8") > this.lineLimitBytes) {
        this.fail(
          new CodexAppServerError(
            "CODEX_PROTOCOL_ERROR",
            "Codex App Server emitted a JSONL line larger than the configured limit."
          )
        );
        return;
      }

      if (line.length > 0) {
        this.consumeLine(line);
      }

      if (this.failure) {
        return;
      }

      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  consumeLine(line) {
    let message;

    try {
      message = JSON.parse(line);
    } catch (error) {
      this.fail(
        new CodexAppServerError(
          "CODEX_PROTOCOL_ERROR",
          "Codex App Server emitted invalid JSON.",
          { cause: error }
        )
      );
      return;
    }

    if (
      message === null ||
      typeof message !== "object" ||
      Array.isArray(message)
    ) {
      this.fail(
        new CodexAppServerError(
          "CODEX_PROTOCOL_ERROR",
          "Codex App Server emitted a non-object protocol message."
        )
      );
      return;
    }

    try {
      if (message.method && message.id !== undefined) {
        this.handleServerRequest(message);
        return;
      }

      if (message.id !== undefined) {
        this.handleResponse(message);
        return;
      }

      if (message.method) {
        this.handleNotification(message);
        return;
      }

      this.fail(
        new CodexAppServerError(
          "CODEX_PROTOCOL_ERROR",
          "Codex App Server emitted an unrecognized protocol message."
        )
      );
    } catch (error) {
      this.fail(
        error instanceof CodexAppServerError
          ? error
          : new CodexAppServerError(
              "CODEX_PROTOCOL_ERROR",
              "Codex App Server message handling failed.",
              { cause: error }
            )
      );
    }
  }

  handleResponse(message) {
    const pending = this.pendingRequests.get(message.id);

    if (!pending) {
      this.fail(
        new CodexAppServerError(
          "CODEX_PROTOCOL_ERROR",
          `Codex App Server returned an unknown response id ${message.id}.`
        )
      );
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(message.id);

    if (message.error) {
      pending.reject(
        new CodexAppServerError(
          "CODEX_RESPONSE_ERROR",
          `Codex App Server rejected ${pending.method}: ${
            message.error.message ?? "unknown error"
          }`
        )
      );
      return;
    }

    pending.resolve(message.result);
  }

  handleNotification(message) {
    for (const waiter of this.notificationWaiters) {
      if (!waiter.predicate(message)) {
        continue;
      }

      clearTimeout(waiter.timer);
      this.notificationWaiters.delete(waiter);
      waiter.resolve(message);
    }
  }

  handleServerRequest(message) {
    if (
      message.method === "item/commandExecution/requestApproval" ||
      message.method === "item/fileChange/requestApproval"
    ) {
      this.onObservation({
        type: "approval.denied",
        method: message.method
      });
      this.writeMessage({
        id: message.id,
        result: {
          decision: "decline"
        }
      });
      return;
    }

    this.writeMessage({
      id: message.id,
      error: {
        code: -32601,
        message: "TaskSeal runner does not handle this server request."
      }
    });
  }

  writeMessage(message) {
    if (!this.child?.stdin?.writable) {
      throw new CodexAppServerError(
        "CODEX_PROCESS_EXITED",
        "Codex App Server stdin is not writable."
      );
    }

    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  fail(error) {
    if (this.failure) {
      return;
    }

    this.failure = error;
    this.rejectOutstanding(error);

    if (this.child && this.child.exitCode === null) {
      this.child.kill();
    }
  }

  rejectOutstanding(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();

    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.notificationWaiters.clear();
  }

  handleStreamError(error) {
    if (this.stopping) {
      return;
    }

    this.fail(
      new CodexAppServerError(
        "CODEX_PROCESS_EXITED",
        "Codex App Server stream failed.",
        { cause: error }
      )
    );
  }

  async stop() {
    const child = this.child;
    this.rejectOutstanding(
      new CodexAppServerError(
        "CODEX_CLIENT_STOPPED",
        "Codex App Server client stopped before the pending operation completed."
      )
    );

    if (!child || child.exitCode !== null) {
      return;
    }

    this.stopping = true;
    if (child.stdin.writable) {
      child.stdin.end();
    }

    const closed = await waitForClose(child, this.shutdownGraceMs);

    if (!closed && child.exitCode === null) {
      child.kill();
      await waitForClose(child, this.shutdownGraceMs);
    }
  }
}

function waitForClose(child, timeoutMs) {
  if (child.exitCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export function buildRunnerEnvironment(source) {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        !BLOCKED_ENVIRONMENT_KEYS.some((pattern) => pattern.test(key))
    )
  );
}

export class CodexAppServerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "CodexAppServerError";
    this.code = code;
  }
}

function validateRunInput({ cwd, prompt, sandbox, approvalPolicy }) {
  if (!isNonEmptyString(cwd) || !isNonEmptyString(prompt)) {
    throw new TypeError("Codex run requires non-empty cwd and prompt.");
  }

  if (
    sandbox !== "read-only" &&
    sandbox !== "workspace-write" &&
    sandbox !== "danger-full-access"
  ) {
    throw new TypeError("Codex run contains an unsupported sandbox.");
  }

  if (
    approvalPolicy !== "untrusted" &&
    approvalPolicy !== "on-failure" &&
    approvalPolicy !== "on-request" &&
    approvalPolicy !== "never"
  ) {
    throw new TypeError("Codex run contains an unsupported approval policy.");
  }
}

function extractAgentSummary(items) {
  if (!Array.isArray(items)) {
    return null;
  }

  const messages = items.filter(
    (item) =>
      item?.type === "agentMessage" &&
      typeof item.text === "string" &&
      item.text.length > 0
  );
  return messages.at(-1)?.text.slice(0, 2_000) ?? null;
}

function extractTurnSummary(turn) {
  if (
    turn?.status === "failed" &&
    isNonEmptyString(turn.error?.message)
  ) {
    return turn.error.message.slice(0, 2_000);
  }

  return extractAgentSummary(turn?.items);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
