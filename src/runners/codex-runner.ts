import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  AttemptFinishedEvent,
  AttemptStartedEvent,
  AttemptTerminalOutcome,
  WorkItem
} from "../domain/workflow.ts";
import type {
  CodexApprovalPolicy,
  CodexSandbox
} from "./codex-app-server-client.ts";

interface CodexRunnerServicePort {
  getWorkItem(workItemId: string): WorkItem | null;
  startAttemptIfIdle(event: AttemptStartedEvent): Promise<unknown>;
  append(event: AttemptFinishedEvent): Promise<unknown>;
}

interface CodexRunnerClientResult {
  outcome: AttemptTerminalOutcome;
  threadId?: string | undefined;
  turnId?: string | undefined;
  summary?: string | null | undefined;
}

interface CodexRunnerClientPort {
  runTurn(options: {
    cwd: string;
    prompt: string;
    sandbox: CodexSandbox;
    approvalPolicy: CodexApprovalPolicy;
    signal?: AbortSignal | undefined;
  }): Promise<CodexRunnerClientResult>;
}

export interface CodexRunnerOptions {
  service: CodexRunnerServicePort;
  projectRoot: string;
  clientFactory: () => CodexRunnerClientPort;
  idFactory?: (() => string) | undefined;
  now?: (() => Date) | undefined;
}

export interface CodexRunnerRunOptions {
  workItemId: string;
  cwd?: string | undefined;
  prompt: string;
  sandbox?: CodexSandbox | undefined;
  approvalPolicy?: CodexApprovalPolicy | undefined;
  signal?: AbortSignal | undefined;
}

export interface CodexRunnerResult
  extends CodexRunnerClientResult {
  attemptId: string;
}

export class CodexRunner {
  readonly service: CodexRunnerServicePort;
  readonly projectRoot: string;
  readonly clientFactory: () => CodexRunnerClientPort;
  readonly idFactory: () => string;
  readonly now: () => Date;

  constructor({
    service,
    projectRoot,
    clientFactory,
    idFactory = () => randomUUID(),
    now = () => new Date()
  }: CodexRunnerOptions) {
    if (
      !service ||
      typeof service.getWorkItem !== "function" ||
      typeof service.append !== "function" ||
      typeof service.startAttemptIfIdle !== "function"
    ) {
      throw new TypeError("Codex runner requires a TaskSeal service.");
    }

    if (typeof clientFactory !== "function") {
      throw new TypeError("Codex runner requires a clientFactory.");
    }

    this.service = service;
    this.projectRoot = resolve(projectRoot);
    this.clientFactory = clientFactory;
    this.idFactory = idFactory;
    this.now = now;
  }

  async run({
    workItemId,
    cwd = this.projectRoot,
    prompt,
    sandbox = "workspace-write",
    approvalPolicy = "never",
    signal
  }: CodexRunnerRunOptions): Promise<CodexRunnerResult> {
    const workItem = this.service.getWorkItem(workItemId);

    if (!workItem) {
      throw new CodexRunnerError(
        "WORK_ITEM_NOT_FOUND",
        `TaskSeal work item ${workItemId} does not exist.`
      );
    }

    const activeAttempt = workItem.attempts.find(
      (attempt) =>
        attempt.id === workItem.activeAttemptId &&
        attempt.status === "running"
    );

    if (activeAttempt) {
      throw new CodexRunnerError(
        "ATTEMPT_ALREADY_ACTIVE",
        `TaskSeal work item ${workItemId} already has an active attempt.`
      );
    }

    const runCwd = await resolvePathWithinProject(
      this.projectRoot,
      resolve(cwd)
    );

    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new TypeError("Codex runner prompt must be a non-empty string.");
    }

    const attemptId = this.idFactory();
    await this.service.startAttemptIfIdle({
      eventId: `codex:${attemptId}:started`,
      workItemId,
      type: "attempt.started",
      occurredAt: this.now().toISOString(),
      payload: {
        attemptId,
        agentId: "codex-app-server"
      }
    });

    let result: CodexRunnerClientResult;

    try {
      const client = this.clientFactory();
      result = await client.runTurn({
        cwd: runCwd,
        prompt,
        sandbox,
        approvalPolicy,
        signal
      });
    } catch (error) {
      await this.service.append(
        createFinishedEvent({
          attemptId,
          workItemId,
          occurredAt: this.now().toISOString(),
          outcome: signal?.aborted ? "interrupted" : "failed",
          summary: boundedMessage(error)
        })
      );
      throw error;
    }

    await this.service.append(
      createFinishedEvent({
        attemptId,
        workItemId,
        occurredAt: this.now().toISOString(),
        ...result
      })
    );

    return {
      attemptId,
      ...result
    };
  }
}

export class CodexRunnerError extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CodexRunnerError";
    this.code = code;
  }
}

function createFinishedEvent({
  attemptId,
  workItemId,
  occurredAt,
  outcome,
  threadId,
  turnId,
  summary
}: {
  attemptId: string;
  workItemId: string;
  occurredAt: string;
  outcome: AttemptTerminalOutcome;
  threadId?: string | undefined;
  turnId?: string | undefined;
  summary?: string | null | undefined;
}): AttemptFinishedEvent {
  return {
    eventId: `codex:${attemptId}:finished`,
    workItemId,
    type: "attempt.finished",
    occurredAt,
    payload: {
      attemptId,
      outcome,
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(summary ? { summary: summary.slice(0, 2_000) } : {})
    }
  };
}

async function resolvePathWithinProject(
  projectRoot: string,
  candidate: string
): Promise<string> {
  assertLexicalPathWithinProject(projectRoot, candidate);

  let canonicalProjectRoot: string;
  let canonicalCandidate: string;

  try {
    [canonicalProjectRoot, canonicalCandidate] = await Promise.all([
      realpath(projectRoot),
      realpath(candidate)
    ]);
  } catch (error) {
    throw new CodexRunnerError(
      "RUNNER_CWD_UNAVAILABLE",
      "Codex runner could not resolve its project root or cwd.",
      { cause: error }
    );
  }

  assertLexicalPathWithinProject(
    canonicalProjectRoot,
    canonicalCandidate
  );
  return canonicalCandidate;
}

function assertLexicalPathWithinProject(
  projectRoot: string,
  candidate: string
): void {
  const pathFromRoot = relative(projectRoot, candidate);

  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new CodexRunnerError(
      "RUNNER_CWD_OUTSIDE_PROJECT",
      "Codex runner cwd must stay inside the TaskSeal project root."
    );
  }
}

function boundedMessage(error: unknown): string {
  const message =
    isRecord(error) &&
    typeof error.message === "string" &&
    error.message.length > 0
      ? error.message
      : "Codex runner failed.";
  return message.slice(0, 2_000);
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
