import assert from "node:assert/strict";
import test from "node:test";

import {
  digestProviderFactContent
} from "../src/lib/provider-snapshot.js";

test("provider content digest is stable across local mapping and revision metadata", () => {
  const fact = createIssueFact();
  const remapped = structuredClone(fact);

  remapped.revision.id = "provider-revision-2";
  remapped.revision.occurredAt =
    "2026-07-26T09:00:00.000Z";
  remapped.candidateEvent.workItemId = "TS-2";
  remapped.candidateEvent.payload.requiredEvidence = [
    "lint",
    "tests"
  ];

  assert.equal(
    digestProviderFactContent(remapped),
    digestProviderFactContent(fact)
  );
});

test("provider content digest changes with provider identity or observed content", () => {
  const fact = createIssueFact();
  const renamed = structuredClone(fact);
  const moved = structuredClone(fact);

  renamed.observed.title = "Renamed provider issue";
  moved.sourceObject.url =
    "https://github.com/netpilot-z/TaskSeal/issues/2";

  assert.notEqual(
    digestProviderFactContent(renamed),
    digestProviderFactContent(fact)
  );
  assert.notEqual(
    digestProviderFactContent(moved),
    digestProviderFactContent(fact)
  );
});

function createIssueFact() {
  return {
    sourceObject: {
      providerObjectKey: "github:issue:501",
      provider: "github",
      objectType: "issue",
      externalId: "501",
      url: "https://github.com/netpilot-z/TaskSeal/issues/1"
    },
    revision: {
      id: "provider-revision-1",
      occurredAt: "2026-07-26T08:01:00.000Z"
    },
    observed: {
      title: "Import provider facts safely",
      createdAt: "2026-07-26T08:00:00.000Z"
    },
    candidateEvent: {
      eventId: "github:issue-501:created",
      workItemId: "TS-1",
      type: "work_item.created",
      occurredAt: "2026-07-26T08:00:00.000Z",
      payload: {
        title: "Import provider facts safely",
        requiredEvidence: ["tests"],
        externalLink: {
          provider: "github",
          externalId: "501",
          url:
            "https://github.com/netpilot-z/TaskSeal/issues/1"
        }
      }
    }
  };
}
