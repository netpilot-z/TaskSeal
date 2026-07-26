import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

export class CodexRunner {
  constructor({
    service,
    projectRoot,
    clientFactory,
    idFactory = randomUUID,
    now = () => new Date()
  }) {
    if (
      !service ||
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
  }) {
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

    const runCwd = resolve(cwd);
    assertPathWithinProject(this.projectRoot, runCwd);

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

    let result;

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
  constructor(code, message, options) {
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
}) {
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

function assertPathWithinProject(projectRoot, candidate) {
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

function boundedMessage(error) {
  const message =
    typeof error?.message === "string" && error.message.length > 0
      ? error.message
      : "Codex runner failed.";
  return message.slice(0, 2_000);
}
