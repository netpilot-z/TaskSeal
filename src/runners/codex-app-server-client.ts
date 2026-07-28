import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { AttemptTerminalOutcome } from "../domain/workflow.ts";

const DEFAULT_LINE_LIMIT_BYTES = 10 * 1024 * 1024;
const RESPONSE_ERROR_MESSAGE_LIMIT = 8_192;
const BLOCKED_ENVIRONMENT_KEYS = [
  /^GH_TOKEN$/i,
  /^GITHUB_TOKEN$/i,
  /^LINEAR_/i,
  /^GITEE_/i,
  /^FEISHU_/i,
  /^LARK_/i,
  /^TASKSEAL_HUMAN_ACTOR$/i
];

export type CodexSandbox =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export type CodexApprovalPolicy =
  | "untrusted"
  | "on-failure"
  | "on-request"
  | "never";

export interface CodexAppServerInvocation {
  command: string;
  argsPrefix: string[];
}

export interface CodexAppServerObservation {
  type: "approval.denied";
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval";
}

interface SpawnAppServerOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  windowsHide: true;
  stdio: ["pipe", "pipe", "pipe"];
}

interface AppServerChildProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

type SpawnAppServer = (
  command: string,
  args: string[],
  options: SpawnAppServerOptions
) => AppServerChildProcess;

export interface CodexAppServerClientOptions {
  invocation: CodexAppServerInvocation;
  environment?: NodeJS.ProcessEnv | undefined;
  requestTimeoutMs?: number | undefined;
  turnTimeoutMs?: number | undefined;
  shutdownGraceMs?: number | undefined;
  lineLimitBytes?: number | undefined;
  onObservation?:
    | ((observation: CodexAppServerObservation) => void)
    | undefined;
  spawnProcess?: SpawnAppServer | undefined;
}

export interface CodexRunTurnOptions {
  cwd: string;
  prompt: string;
  sandbox?: CodexSandbox | undefined;
  approvalPolicy?: CodexApprovalPolicy | undefined;
  signal?: AbortSignal | undefined;
}

export interface CodexRunResult {
  outcome: AttemptTerminalOutcome;
  threadId: string;
  turnId: string;
  summary: string | null;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

interface ProtocolNotification {
  kind: "notification";
  method: string;
  params: unknown;
}

interface ProtocolServerRequest {
  kind: "serverRequest";
  id: string | number;
  method: string;
  params: unknown;
}

interface ProtocolResultResponse {
  kind: "resultResponse";
  id: number;
  result: unknown;
}

interface ProtocolErrorResponse {
  kind: "errorResponse";
  id: number;
  error: {
    code: number;
    message: string;
  };
}

type ProtocolResponse =
  | ProtocolResultResponse
  | ProtocolErrorResponse;

type ProtocolMessage =
  | ProtocolNotification
  | ProtocolServerRequest
  | ProtocolResponse;

interface NotificationWaiter {
  predicate: (message: ProtocolNotification) => boolean;
  resolve: (message: ProtocolNotification) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout | undefined;
}

interface DecodedTurn {
  id: string;
  status: AttemptTerminalOutcome;
  items: unknown;
  error: unknown;
}

interface DecodedCompletion {
  threadId: string;
  turn: DecodedTurn;
}

export class CodexAppServerClient {
  readonly invocation: CodexAppServerInvocation;
  readonly environment: NodeJS.ProcessEnv;
  readonly requestTimeoutMs: number;
  readonly turnTimeoutMs: number;
  readonly shutdownGraceMs: number;
  readonly lineLimitBytes: number;
  readonly onObservation: (
    observation: CodexAppServerObservation
  ) => void;
  readonly spawnProcess: SpawnAppServer;
  nextRequestId: number;
  readonly pendingRequests: Map<number, PendingRequest>;
  readonly notificationWaiters: Set<NotificationWaiter>;
  stdoutBuffer: string;
  stderr: string;
  child: AppServerChildProcess | null;
  stopping: boolean;
  failure: CodexAppServerError | null;

  constructor({
    invocation,
    environment = process.env,
    requestTimeoutMs = 30_000,
    turnTimeoutMs = 10 * 60_000,
    shutdownGraceMs = 1_000,
    lineLimitBytes = DEFAULT_LINE_LIMIT_BYTES,
    onObservation = () => {},
    spawnProcess = spawnAppServer
  }: CodexAppServerClientOptions) {
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
  }: CodexRunTurnOptions): Promise<CodexRunResult> {
    validateRunInput({ cwd, prompt, sandbox, approvalPolicy });

    let threadId: string | undefined;
    let turnId: string | undefined;
    let abortHandler: (() => void) | undefined;
    let abortTimer: NodeJS.Timeout | undefined;
    let abortTriggered = false;
    let rejectAbort: ((reason?: unknown) => void) | undefined;
    const abortPromise: Promise<never> | null = signal
      ? new Promise<never>((_resolve, reject) => {
          rejectAbort = reject;
        })
      : null;
    const waitForAbortable = <Result>(
      operation: Promise<Result>
    ): Promise<Result> =>
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
          if (rejectAbort) {
            rejectAbort(error);
          }
          return;
        }

        this.request("turn/interrupt", {
          threadId,
          turnId
        }).catch(() => undefined);
        abortTimer = setTimeout(() => {
          if (rejectAbort) {
            rejectAbort(
              new CodexAppServerError(
                "CODEX_INTERRUPTED",
                "Codex App Server did not acknowledge interruption before shutdown."
              )
            );
          }
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
      const initializeResponse = await waitForAbortable(
        this.request("initialize", {
          clientInfo: {
            name: "taskseal",
            title: "TaskSeal",
            version: "0.0.0-experiment.2"
          }
        })
      );
      decodeInitializeResult(initializeResponse);
      this.notify("initialized", {});

      const threadResponse = await waitForAbortable(
        this.request("thread/start", {
          cwd,
          sandbox,
          approvalPolicy,
          ephemeral: true
        })
      );
      threadId = decodeThreadStartResult(threadResponse);

      const completionPromise = this.waitForNotification(
        (message) => message.method === "turn/completed",
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
      turnId = decodeTurnStartResult(turnResponse);

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

  createRunResult({
    completion,
    threadId,
    turnId
  }: {
    completion: ProtocolNotification;
    threadId: string;
    turnId: string;
  }): CodexRunResult {
    const decoded = decodeTurnCompletedNotification(completion);

    if (decoded.threadId !== threadId) {
      throw new CodexAppServerError(
        "CODEX_PROTOCOL_ERROR",
        "Codex turn/completed did not match the active thread id."
      );
    }

    if (decoded.turn.id !== turnId) {
      throw new CodexAppServerError(
        "CODEX_PROTOCOL_ERROR",
        "Codex turn/completed did not match the active turn id."
      );
    }

    return {
      outcome: decoded.turn.status,
      threadId,
      turnId,
      summary: extractTurnSummary(decoded.turn)
    };
  }

  async start(cwd: string): Promise<void> {
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
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stdout.on("error", (error: Error) =>
      this.handleStreamError(error)
    );
    child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_192);
    });
    child.stderr.on("error", (error: Error) =>
      this.handleStreamError(error)
    );
    child.stdin.on("error", (error: Error) =>
      this.handleStreamError(error)
    );
    child.once("error", (error: Error) => {
      this.fail(
        new CodexAppServerError(
          "CODEX_NOT_AVAILABLE",
          "TaskSeal could not start Codex App Server.",
          { cause: error }
        )
      );
    });
    child.once("close", (exitCode: number | null) => {
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

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    }).catch((error) => {
      throw new CodexAppServerError(
        "CODEX_NOT_AVAILABLE",
        "TaskSeal could not start Codex App Server.",
        { cause: error }
      );
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise<unknown>((resolve, reject) => {
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

  notify(method: string, params: unknown): void {
    this.writeMessage({ method, params });
  }

  waitForNotification(
    predicate: (message: ProtocolNotification) => boolean,
    timeoutMs: number
  ): Promise<ProtocolNotification> {
    return new Promise<ProtocolNotification>((resolve, reject) => {
      const waiter: NotificationWaiter = {
        predicate,
        resolve,
        reject,
        timer: undefined
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

  consumeStdout(chunk: string): void {
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

  consumeLine(line: string): void {
    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
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

    try {
      const message = decodeProtocolMessage(parsed);

      if (message.kind === "serverRequest") {
        this.handleServerRequest(message);
      } else if (
        message.kind === "resultResponse" ||
        message.kind === "errorResponse"
      ) {
        this.handleResponse(message);
      } else {
        this.handleNotification(message);
      }
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

  handleResponse(message: ProtocolResponse): void {
    const pending = this.pendingRequests.get(message.id);

    if (!pending) {
      this.fail(
        new CodexAppServerError(
          "CODEX_PROTOCOL_ERROR",
          "Codex App Server returned an unknown response id."
        )
      );
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(message.id);

    if (message.kind === "errorResponse") {
      pending.reject(
        new CodexAppServerError(
          "CODEX_RESPONSE_ERROR",
          `Codex App Server rejected ${pending.method} with code ${message.error.code}.`
        )
      );
      return;
    }

    pending.resolve(message.result);
  }

  handleNotification(message: ProtocolNotification): void {
    if (message.method === "turn/completed") {
      decodeTurnCompletedNotification(message);
    }

    for (const waiter of this.notificationWaiters) {
      if (!waiter.predicate(message)) {
        continue;
      }

      clearTimeout(waiter.timer);
      this.notificationWaiters.delete(waiter);
      waiter.resolve(message);
    }
  }

  handleServerRequest(message: ProtocolServerRequest): void {
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

  writeMessage(message: unknown): void {
    if (!this.child?.stdin?.writable) {
      throw new CodexAppServerError(
        "CODEX_PROCESS_EXITED",
        "Codex App Server stdin is not writable."
      );
    }

    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  fail(error: CodexAppServerError): void {
    if (this.failure) {
      return;
    }

    this.failure = error;
    this.rejectOutstanding(error);

    if (this.child && this.child.exitCode === null) {
      this.child.kill();
    }
  }

  rejectOutstanding(error: CodexAppServerError): void {
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

  handleStreamError(error: unknown): void {
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

  async stop(): Promise<void> {
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

function spawnAppServer(
  command: string,
  args: string[],
  options: SpawnAppServerOptions
): AppServerChildProcess {
  return spawn(command, args, options);
}

function waitForClose(
  child: AppServerChildProcess,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const handleClose = () => {
      if (timer) {
        clearTimeout(timer);
      }
      child.removeListener("close", handleClose);
      resolve(true);
    };

    child.once("close", handleClose);

    if (child.exitCode !== null) {
      handleClose();
      return;
    }

    timer = setTimeout(() => {
      child.removeListener("close", handleClose);
      resolve(false);
    }, timeoutMs);
  });
}

export function buildRunnerEnvironment(
  source: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.keys(source)
      .filter(
        (key) =>
          !BLOCKED_ENVIRONMENT_KEYS.some(
            (pattern) =>
              pattern.test(key)
          )
      )
      .map((key) => [
        key,
        source[key]
      ])
  );
}

export class CodexAppServerError extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CodexAppServerError";
    this.code = code;
  }
}

function validateRunInput({
  cwd,
  prompt,
  sandbox,
  approvalPolicy
}: {
  cwd: string;
  prompt: string;
  sandbox: CodexSandbox;
  approvalPolicy: CodexApprovalPolicy;
}): void {
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

function decodeProtocolMessage(value: unknown): ProtocolMessage {
  if (!isRecord(value)) {
    throw new CodexAppServerError(
      "CODEX_PROTOCOL_ERROR",
      "Codex App Server emitted a non-object protocol message."
    );
  }

  const hasId = hasOwn(value, "id");
  const hasMethod = hasOwn(value, "method");

  if (hasMethod) {
    if (!isNonEmptyString(value.method)) {
      throw invalidProtocolEnvelope();
    }

    if (hasId) {
      if (
        !isServerRequestId(value.id) ||
        hasOwn(value, "result") ||
        hasOwn(value, "error")
      ) {
        throw invalidProtocolEnvelope();
      }

      return {
        kind: "serverRequest",
        id: value.id,
        method: value.method,
        params: value.params
      };
    }

    if (hasOwn(value, "result") || hasOwn(value, "error")) {
      throw invalidProtocolEnvelope();
    }

    return {
      kind: "notification",
      method: value.method,
      params: value.params
    };
  }

  if (!hasId) {
    throw new CodexAppServerError(
      "CODEX_PROTOCOL_ERROR",
      "Codex App Server emitted an unrecognized protocol message."
    );
  }

  return decodeResponseEnvelope(value);
}

function decodeResponseEnvelope(
  value: Record<string, unknown>
): ProtocolResponse {
  const hasResult = hasOwn(value, "result");
  const hasError = hasOwn(value, "error");

  if (
    !isClientResponseId(value.id) ||
    hasResult === hasError
  ) {
    throw invalidResponseEnvelope();
  }

  if (hasResult) {
    return {
      kind: "resultResponse",
      id: value.id,
      result: value.result
    };
  }

  if (
    !isRecord(value.error) ||
    typeof value.error.code !== "number" ||
    !Number.isFinite(value.error.code) ||
    !Number.isInteger(value.error.code) ||
    typeof value.error.message !== "string" ||
    Buffer.byteLength(value.error.message, "utf8") >
      RESPONSE_ERROR_MESSAGE_LIMIT
  ) {
    throw invalidResponseEnvelope();
  }

  return {
    kind: "errorResponse",
    id: value.id,
    error: {
      code: value.error.code,
      message: value.error.message
    }
  };
}

function decodeInitializeResult(value: unknown): void {
  if (!isRecord(value)) {
    throw new CodexAppServerError(
      "CODEX_PROTOCOL_ERROR",
      "Codex App Server returned an invalid initialize result."
    );
  }
}

function decodeThreadStartResult(value: unknown): string {
  if (
    !isRecord(value) ||
    !isRecord(value.thread) ||
    !isNonEmptyString(value.thread.id)
  ) {
    throw new CodexAppServerError(
      "CODEX_PROTOCOL_ERROR",
      "Codex App Server returned an invalid thread/start result."
    );
  }

  return value.thread.id;
}

function decodeTurnStartResult(value: unknown): string {
  if (
    !isRecord(value) ||
    !isRecord(value.turn) ||
    !isNonEmptyString(value.turn.id)
  ) {
    throw new CodexAppServerError(
      "CODEX_PROTOCOL_ERROR",
      "Codex App Server returned an invalid turn/start result."
    );
  }

  return value.turn.id;
}

function decodeTurnCompletedNotification(
  message: ProtocolNotification
): DecodedCompletion {
  const params = message.params;

  if (
    message.method !== "turn/completed" ||
    !isRecord(params) ||
    !isNonEmptyString(params.threadId) ||
    !isRecord(params.turn) ||
    !isNonEmptyString(params.turn.id) ||
    !isAttemptTerminalOutcome(params.turn.status) ||
    (params.turn.items !== undefined &&
      !Array.isArray(params.turn.items))
  ) {
    throw new CodexAppServerError(
      "CODEX_PROTOCOL_ERROR",
      "Codex App Server emitted an invalid turn/completed notification."
    );
  }

  return {
    threadId: params.threadId,
    turn: {
      id: params.turn.id,
      status: params.turn.status,
      items: params.turn.items,
      error: params.turn.error
    }
  };
}

function extractAgentSummary(items: unknown): string | null {
  if (!Array.isArray(items)) {
    return null;
  }

  let summary: string | null = null;

  for (const item of items) {
    if (
      isRecord(item) &&
      item.type === "agentMessage" &&
      typeof item.text === "string" &&
      item.text.length > 0
    ) {
      summary = item.text.slice(0, 2_000);
    }
  }

  return summary;
}

function extractTurnSummary(turn: DecodedTurn): string | null {
  if (
    turn.status === "failed" &&
    isRecord(turn.error) &&
    isNonEmptyString(turn.error.message)
  ) {
    return turn.error.message.slice(0, 2_000);
  }

  return extractAgentSummary(turn.items);
}

function invalidProtocolEnvelope(): CodexAppServerError {
  return new CodexAppServerError(
    "CODEX_PROTOCOL_ERROR",
    "Codex App Server emitted an invalid protocol envelope."
  );
}

function invalidResponseEnvelope(): CodexAppServerError {
  return new CodexAppServerError(
    "CODEX_PROTOCOL_ERROR",
    "Codex App Server emitted an invalid response envelope."
  );
}

function isServerRequestId(
  value: unknown
): value is string | number {
  return (
    isNonEmptyString(value) ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      Number.isInteger(value))
  );
}

function isClientResponseId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function isAttemptTerminalOutcome(
  value: unknown
): value is AttemptTerminalOutcome {
  return (
    value === "completed" ||
    value === "failed" ||
    value === "interrupted"
  );
}

function hasOwn(
  value: Record<string, unknown>,
  key: string
): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
