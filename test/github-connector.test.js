import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  normalizeGitHubCheck,
  normalizeGitHubIssue,
  normalizeGitHubPullRequest
} from "../src/connectors/github.js";

test("a GitHub issue is normalized with an explicit TaskSeal mapping", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../fixtures/github/issue.open.json", import.meta.url),
      "utf8"
    )
  );

  const event = normalizeGitHubIssue(fixture, {
    workItemId: "TS-1",
    requiredEvidence: ["tests"]
  });

  assert.deepEqual(event, {
    eventId: "github:issue-501:created",
    workItemId: "TS-1",
    type: "work_item.created",
    occurredAt: "2026-07-26T08:00:00.000Z",
    payload: {
      title: "Prove the delivery evidence loop",
      requiredEvidence: ["tests"],
      externalLink: {
        provider: "github",
        externalId: "501",
        url: "https://github.com/netpilot-z/TaskSeal/issues/1"
      }
    }
  });

  assert.throws(
    () => normalizeGitHubIssue(fixture),
    /mapping workItemId/
  );
  assert.throws(
    () => normalizeGitHubIssue({ ...fixture, pull_request: {} }, {
      workItemId: "TS-1",
      requiredEvidence: ["tests"]
    }),
    /must not represent a pull request/
  );
});

test("a GitHub pull request is normalized into a revision-bound artifact", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../fixtures/github/pull-request.opened.json",
        import.meta.url
      ),
      "utf8"
    )
  );

  const mapping = {
    workItemId: "TS-1",
    attemptId: "run-1"
  };
  const event = normalizeGitHubPullRequest(fixture, mapping);

  assert.deepEqual(event, {
    eventId: "github:pr-1001:abc123:2026-07-26T08:03:00.000Z",
    workItemId: "TS-1",
    type: "artifact.linked",
    occurredAt: "2026-07-26T08:03:00.000Z",
    payload: {
      artifactId: "pr-1001",
      attemptId: "run-1",
      kind: "pull_request",
      revision: "abc123",
      url: "https://github.com/netpilot-z/TaskSeal/pull/1"
    }
  });

  assert.throws(
    () =>
      normalizeGitHubPullRequest({
        ...fixture,
        html_url: "javascript:alert(document.domain)"
      }, mapping),
    /http or https URL/
  );

  const refreshed = normalizeGitHubPullRequest({
    ...fixture,
    updated_at: "2026-07-26T08:10:00.000Z"
  }, mapping);
  assert.notEqual(refreshed.eventId, event.eventId);
  assert.throws(
    () => normalizeGitHubPullRequest(fixture),
    /mapping workItemId/
  );
});

test("a GitHub check is normalized into revision-bound evidence", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../fixtures/github/check.completed.json", import.meta.url),
      "utf8"
    )
  );

  const mapping = {
    workItemId: "TS-1",
    attemptId: "run-1",
    artifactId: "pr-1001",
    criterionKey: "tests"
  };
  const event = normalizeGitHubCheck(fixture, mapping);

  assert.deepEqual(event, {
    eventId: "github:check-2001:abc123",
    workItemId: "TS-1",
    type: "evidence.recorded",
    occurredAt: "2026-07-26T08:04:00.000Z",
    payload: {
      evidenceId: "check-2001",
      attemptId: "run-1",
      artifactId: "pr-1001",
      revision: "abc123",
      criterionKey: "tests",
      outcome: "passed",
      url: "https://github.com/netpilot-z/TaskSeal/actions/runs/1"
    }
  });

  assert.throws(
    () => normalizeGitHubCheck(fixture),
    /mapping workItemId/
  );
});
