import { projectDashboard } from "../dashboard/projection.js";
import { applyEvent, createWorkflow } from "../domain/workflow.js";

export class TaskSealService {
  static async open({ journal }) {
    const events = await journal.readAll();
    let workflow = createWorkflow();

    for (const [index, event] of events.entries()) {
      try {
        workflow = applyEvent(workflow, event);
      } catch (error) {
        throw new TaskSealServiceError(
          "JOURNAL_CORRUPT",
          `TaskSeal could not replay event journal line ${index + 1}: ${error.message}`,
          { cause: error }
        );
      }
    }

    return new TaskSealService({ journal, workflow });
  }

  constructor({ journal, workflow }) {
    this.journal = journal;
    this.workflow = workflow;
    this.writeQueue = Promise.resolve();
  }

  append(event) {
    const operation = this.writeQueue.then(() => this.appendNow(event));
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  startAttemptIfIdle(event) {
    const operation = this.writeQueue.then(() => {
      const workItem = this.getWorkItem(event.workItemId);
      const activeAttempt = workItem?.attempts.find(
        (attempt) =>
          attempt.id === workItem.activeAttemptId &&
          attempt.status === "running"
      );

      if (activeAttempt) {
        throw new TaskSealServiceError(
          "ATTEMPT_ALREADY_ACTIVE",
          `TaskSeal work item ${event.workItemId} already has an active attempt.`
        );
      }

      return this.appendNow(event);
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  async appendNow(event) {
    const candidate = applyEvent(this.workflow, event);

    if (candidate === this.workflow) {
      return this.workflow;
    }

    try {
      await this.journal.append(event);
    } catch (error) {
      if (error.code === "JOURNAL_WRITE_FAILED") {
        throw error;
      }

      throw new TaskSealServiceError(
        "JOURNAL_WRITE_FAILED",
        "TaskSeal could not persist the event; in-memory state was not changed.",
        { cause: error }
      );
    }

    this.workflow = candidate;
    return this.workflow;
  }

  getWorkflow() {
    return this.workflow;
  }

  getWorkItem(workItemId) {
    return this.workflow.workItems[workItemId] ?? null;
  }

  async recoverRunningAttempts({
    occurredAt = new Date().toISOString()
  } = {}) {
    const runningAttempts = Object.values(this.workflow.workItems).flatMap(
      (workItem) =>
        workItem.attempts
          .filter((attempt) => attempt.status === "running")
          .map((attempt) => ({
            workItemId: workItem.id,
            attemptId: attempt.id
          }))
    );

    for (const { workItemId, attemptId } of runningAttempts) {
      await this.append({
        eventId: `taskseal:${workItemId}:${attemptId}:recovered-interrupted`,
        workItemId,
        type: "attempt.finished",
        occurredAt,
        payload: {
          attemptId,
          outcome: "interrupted",
          summary:
            "Recovered an unfinished attempt after TaskSeal restarted."
        }
      });
    }

    return runningAttempts.length;
  }

  snapshot() {
    return projectDashboard(this.workflow);
  }
}

export class TaskSealServiceError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "TaskSealServiceError";
    this.code = code;
  }
}
