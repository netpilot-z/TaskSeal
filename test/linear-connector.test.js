import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeLinearIssue } from "../src/connectors/linear.js";

test("a Linear issue is normalized into a stable work item event", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../fixtures/linear/issue.created.json", import.meta.url),
      "utf8"
    )
  );

  const mapping = {
    workItemId: "TS-1",
    requiredEvidence: ["tests"]
  };
  const event = normalizeLinearIssue(fixture, mapping);

  assert.deepEqual(event, {
    eventId: "linear:linear-issue-1:created",
    workItemId: "TS-1",
    type: "work_item.created",
    occurredAt: "2026-07-26T08:00:00.000Z",
    payload: {
      title: "Prove the delivery evidence loop",
      requiredEvidence: ["tests"],
      externalLink: {
        provider: "linear",
        externalId: "linear-issue-1",
        url: "https://linear.app/taskseal/issue/TS-1"
      }
    }
  });

  const refreshed = normalizeLinearIssue({
    ...fixture,
    updatedAt: "2026-07-26T08:10:00.000Z"
  }, mapping);
  assert.equal(refreshed.eventId, event.eventId);

  assert.throws(
    () =>
      normalizeLinearIssue(
        { ...fixture, url: "javascript:alert(1)" },
        mapping
      ),
    /http or https URL/
  );
  assert.throws(
    () => normalizeLinearIssue(fixture),
    /mapping workItemId/
  );
});
