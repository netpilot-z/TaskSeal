import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeGiteeIssueFact
} from "../src/connectors/gitee.ts";
import {
  applyEvent,
  createWorkflow
} from "../src/domain/workflow.ts";

test("the pure domain accepts a structurally consistent Gitee rich link", () => {
  const fact = normalizeGiteeIssueFact({
    id: 2_614,
    number: "I4",
    title: "Git push crashes",
    htmlUrl:
      "https://gitee.com/oschina/git-osc/issues/I4",
    createdAt: "2013-04-12T12:15:08+08:00",
    updatedAt: "2022-07-22T05:01:31+08:00",
    repository: "oschina/git-osc"
  }, {
    workItemId: "TS-GITEE-I4",
    requiredEvidence: ["tests"],
    managedFields: ["title"]
  });

  const workflow = applyEvent(
    createWorkflow(),
    fact.candidateEvent
  );
  const link =
    workflow.workItems["TS-GITEE-I4"]?.externalLinks[0];

  assert.equal(link?.provider, "gitee");
  assert.equal(
    link?.providerObjectKey,
    "gitee:issue:oschina/git-osc#I4"
  );
  assert.deepEqual(link?.scopeRef, {
    kind: "repository",
    key: "gitee:repository:oschina/git-osc"
  });
});

test("the pure domain preserves opaque historical provider object keys for replay", () => {
  const fact = normalizeGiteeIssueFact({
    id: 2_614,
    number: "I4",
    title: "Git push crashes",
    htmlUrl:
      "https://gitee.com/oschina/git-osc/issues/I4",
    createdAt: "2013-04-12T12:15:08+08:00",
    updatedAt: "2022-07-22T05:01:31+08:00",
    repository: "oschina/git-osc"
  }, {
    workItemId: "TS-GITEE-I4",
    requiredEvidence: ["tests"],
    managedFields: []
  });
  const event = structuredClone(
    fact.candidateEvent
  ) as unknown as Record<string, unknown>;
  const payload = readRecord(event, "payload");
  const link = readRecord(payload, "externalLink");
  link.providerObjectKey = "other:issue:oschina/git-osc#I4";

  const workflow = applyEvent(
    createWorkflow(),
    event
  );
  assert.equal(
    workflow.workItems["TS-GITEE-I4"]
      ?.externalLinks[0]?.providerObjectKey,
    "other:issue:oschina/git-osc#I4"
  );
});

function readRecord(
  value: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const property = value[key];
  if (
    property === null ||
    typeof property !== "object" ||
    Array.isArray(property)
  ) {
    throw new TypeError(`Expected ${key} to be an object.`);
  }
  return property as Record<string, unknown>;
}
