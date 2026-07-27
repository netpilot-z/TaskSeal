import { readFile } from "node:fs/promises";

import { normalizeCodexRun } from "../connectors/codex.ts";
import {
  normalizeGitHubCheck,
  normalizeGitHubPullRequest
} from "../connectors/github.ts";
import { normalizeLinearIssue } from "../connectors/linear.ts";
import { applyEvent, createWorkflow } from "../domain/workflow.ts";

export async function loadDemoSteps() {
  const [
    linearIssue,
    codexRunStarted,
    codexRunCompleted,
    pullRequest,
    check
  ] = await Promise.all([
    loadJson("../../fixtures/linear/issue.created.json"),
    loadJson("../../fixtures/codex/run.started.json"),
    loadJson("../../fixtures/codex/run.completed.json"),
    loadJson("../../fixtures/github/pull-request.opened.json"),
    loadJson("../../fixtures/github/check.completed.json")
  ]);

  return [
    {
      source: "Linear",
      label: "Work item created",
      event: normalizeLinearIssue(linearIssue, {
        workItemId: "TS-1",
        requiredEvidence: ["tests"]
      })
    },
    {
      source: "Codex",
      label: "Agent attempt started",
      event: normalizeCodexRun(codexRunStarted)
    },
    {
      source: "Codex",
      label: "Agent attempt completed",
      event: normalizeCodexRun(codexRunCompleted)
    },
    {
      source: "GitHub",
      label: "Pull request linked",
      event: normalizeGitHubPullRequest(pullRequest, {
        workItemId: "TS-1",
        attemptId: "run-1"
      })
    },
    {
      source: "GitHub Actions",
      label: "Required tests passed",
      event: normalizeGitHubCheck(check, {
        workItemId: "TS-1",
        attemptId: "run-1",
        artifactId: "pr-1001",
        criterionKey: "tests"
      })
    },
    {
      source: "TaskSeal",
      label: "Owner accepted delivery",
      event: {
        eventId: "taskseal:TS-1:accepted",
        workItemId: "TS-1",
        type: "acceptance.decided",
        occurredAt: "2026-07-26T08:05:00.000Z",
        payload: {
          decision: "accepted",
          actor: "owner",
          reason: "Artifact and required evidence verified"
        }
      }
    }
  ];
}

export function replayDemoSteps(steps, stepCount) {
  return steps
    .slice(0, stepCount)
    .reduce((workflow, step) => applyEvent(workflow, step.event), createWorkflow());
}

async function loadJson(relativePath) {
  const content = await readFile(new URL(relativePath, import.meta.url), "utf8");
  return JSON.parse(content);
}
