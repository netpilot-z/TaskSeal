import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  normalizeLinearIssue,
  normalizeLinearIssueFact
} from "../src/connectors/linear.ts";

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

test("Linear issue URLs are canonicalized before event and fact construction", () => {
  const rawUrl =
    "https://linear.app/netpilot-z/issue/NP-43/dogfood-taskseal-自驱动项目交付闭环";
  const canonicalUrl = new URL(rawUrl).href;
  const issue = {
    id: "35b6ee7b-8d9d-4fec-b57e-8eebaa3b8020",
    identifier: "NP-43",
    title: "[Dogfood] TaskSeal 自驱动项目交付闭环",
    url: rawUrl,
    createdAt: "2026-07-29T09:21:12.166Z",
    updatedAt: "2026-07-29T09:21:12.166Z"
  };
  const mapping = {
    workItemId: "TS-43",
    requiredEvidence: ["tests"]
  };

  const event = normalizeLinearIssue(issue, mapping);
  const fact = normalizeLinearIssueFact(issue, mapping);

  assert.equal(
    event.payload.externalLink.url,
    canonicalUrl
  );
  assert.equal(fact.sourceObject.url, canonicalUrl);
  assert.equal(
    fact.candidateEvent.payload.externalLink.url,
    canonicalUrl
  );
});
