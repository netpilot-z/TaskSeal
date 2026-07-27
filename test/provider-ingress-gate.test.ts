import assert from "node:assert/strict";
import test from "node:test";

import { TaskSealService } from "../src/application/taskseal-service.ts";
import type {
  EventJournal
} from "../src/application/taskseal-service.ts";
import type {
  CanonicalEvent,
  ExternalLinkLinkedEvent,
  ExternalLinkObservedEvent,
  WorkItemCreatedEvent,
  WorkItemUpdatedEvent
} from "../src/domain/workflow.ts";

const CONTENT_DIGEST =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEXT_CONTENT_DIGEST =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("generic append rejects provider-backed rich creation while replay remains compatible", async () => {
  const liveJournal = new MemoryJournal();
  const liveService = await TaskSealService.open({
    journal: liveJournal
  });

  await assert.rejects(
    liveService.append(createRichWorkItem()),
    hasCode("PROVIDER_INGRESS_FORBIDDEN")
  );
  assert.equal(liveJournal.appendCalls, 0);
  assert.equal(liveService.getWorkItem("TS-1"), null);

  const replayJournal = new MemoryJournal([
    createRichWorkItem()
  ]);
  const replayed = await TaskSealService.open({
    journal: replayJournal
  });
  assert.equal(
    replayed.getWorkItem("TS-1")?.externalLinks[0]
      ?.provider,
    "github"
  );
  assert.equal(replayJournal.appendCalls, 0);
});

test("historical rich links with opaque stable keys remain replayable", async () => {
  const historical = createRichWorkItem();
  historical.payload.externalLink.providerObjectKey =
    "github:opaque-stable-key";
  const service = await TaskSealService.open({
    journal: new MemoryJournal([historical])
  });

  assert.equal(
    service.getWorkItem("TS-1")?.externalLinks[0]
      ?.providerObjectKey,
    "github:opaque-stable-key"
  );
});

test("direct ingress fails with the fixed gate error before unrelated domain status can leak", async () => {
  const existing = createRichWorkItem();
  const duplicateJournal = new MemoryJournal([existing]);
  const duplicateService = await TaskSealService.open({
    journal: duplicateJournal
  });

  await duplicateService.append(existing);
  assert.equal(duplicateJournal.appendCalls, 0);

  const conflicting = structuredClone(existing);
  conflicting.payload.title = "Conflicting reuse";
  await assert.rejects(
    duplicateService.append(conflicting),
    hasCode("EVENT_ID_CONFLICT")
  );

  const missingLink: ExternalLinkLinkedEvent = {
    eventId: "github:missing:linked",
    workItemId: "MISSING",
    type: "external_link.linked",
    occurredAt: "2026-07-27T08:01:00.000Z",
    payload: {
      link: createGitHubLink()
    }
  };
  const duplicateCreate = createRichWorkItem();
  duplicateCreate.eventId = "github:TS-1:created-again";
  const service = await TaskSealService.open({
    journal: new MemoryJournal([createLocalWorkItem()])
  });

  for (const event of [missingLink, duplicateCreate]) {
    await assert.rejects(
      service.append(event),
      hasCode("PROVIDER_INGRESS_FORBIDDEN")
    );
  }
});

test("generic append rejects link, observation, and managed update ingress with zero writes", async () => {
  const localCreated: WorkItemCreatedEvent = {
    eventId: "taskseal:TS-1:created",
    workItemId: "TS-1",
    type: "work_item.created",
    occurredAt: "2026-07-27T08:00:00.000Z",
    payload: {
      title: "Local item",
      requiredEvidence: ["tests"],
      externalLink: {
        provider: "taskseal",
        externalId: "TS-1",
        url: "http://127.0.0.1/work-items/TS-1"
      }
    }
  };
  const linked: ExternalLinkLinkedEvent = {
    eventId: "github:TS-1:linked",
    workItemId: "TS-1",
    type: "external_link.linked",
    occurredAt: "2026-07-27T08:01:00.000Z",
    payload: {
      link: createGitHubLink()
    }
  };
  const observed: ExternalLinkObservedEvent = {
    eventId: "github:TS-1:observed",
    workItemId: "TS-1",
    type: "external_link.observed",
    occurredAt: "2026-07-27T08:02:00.000Z",
    payload: {
      providerObjectKey: "github:issue:501",
      expectedRevisionId: "rev-1",
      observation: {
        revisionId: "rev-2",
        occurredAt: "2026-07-27T08:02:00.000Z",
        contentDigest: NEXT_CONTENT_DIGEST,
        title: "Updated title"
      }
    }
  };
  const updated: WorkItemUpdatedEvent = {
    eventId: "github:TS-1:updated",
    workItemId: "TS-1",
    type: "work_item.updated",
    occurredAt: "2026-07-27T08:02:00.000Z",
    payload: {
      source: {
        providerObjectKey: "github:issue:501",
        revisionId: "rev-2",
        contentDigest: NEXT_CONTENT_DIGEST
      },
      changes: {
        title: {
          before: "Old title",
          after: "Updated title"
        }
      }
    }
  };
  const updateHistory = createRichWorkItem();
  updateHistory.payload.title = "Old title";
  if (
    !(
      "lastObservation" in
      updateHistory.payload.externalLink
    )
  ) {
    throw new Error("Expected a rich external link.");
  }
  updateHistory.payload.externalLink.lastObservation = {
    revisionId: "rev-2",
    occurredAt: "2026-07-27T08:02:00.000Z",
    contentDigest: NEXT_CONTENT_DIGEST,
    title: "Updated title"
  };

  const linkJournal = new MemoryJournal([localCreated]);
  const linkService = await TaskSealService.open({
    journal: linkJournal
  });
  await assert.rejects(
    linkService.append(linked),
    hasCode("PROVIDER_INGRESS_FORBIDDEN")
  );
  assert.equal(linkJournal.appendCalls, 0);

  for (const {
    event,
    history,
    expectedTitle
  } of [
    {
      event: observed,
      history: createRichWorkItem(),
      expectedTitle: "Imported item"
    },
    {
      event: updated,
      history: updateHistory,
      expectedTitle: "Old title"
    }
  ]) {
    const journal = new MemoryJournal([
      history
    ]);
    const service = await TaskSealService.open({ journal });

    await assert.rejects(
      service.append(event),
      hasCode("PROVIDER_INGRESS_FORBIDDEN")
    );
    assert.equal(journal.appendCalls, 0);
    assert.equal(
      service.getWorkItem("TS-1")?.title,
      expectedTitle
    );
  }
});

test("generic append continues to allow local legacy and delivery events", async () => {
  const journal = new MemoryJournal();
  const service = await TaskSealService.open({ journal });
  const local = createLocalWorkItem();

  await service.append(local);
  await service.append({
    eventId: "taskseal:TS-LOCAL:attempt-1:started",
    workItemId: "TS-LOCAL",
    type: "attempt.started",
    occurredAt: "2026-07-27T08:01:00.000Z",
    payload: {
      attemptId: "attempt-1",
      agentId: "codex"
    }
  });

  assert.equal(journal.appendCalls, 2);
  assert.equal(
    service.getWorkItem("TS-LOCAL")?.status,
    "running"
  );
});

function createRichWorkItem(): WorkItemCreatedEvent {
  return {
    eventId: "github:TS-1:created",
    workItemId: "TS-1",
    type: "work_item.created",
    occurredAt: "2026-07-27T08:00:00.000Z",
    payload: {
      title: "Imported item",
      requiredEvidence: ["tests"],
      externalLink: createGitHubLink()
    }
  };
}

function createGitHubLink() {
  return {
    providerObjectKey: "github:issue:501",
    provider: "github",
    objectType: "issue",
    externalId: "501",
    scopeRef: {
      kind: "repository",
      key: "github:repository:netpilot-z/taskseal"
    },
    url:
      "https://github.com/netpilot-z/TaskSeal/issues/1",
    managedFields: ["title"] as ["title"],
    lastObservation: {
      revisionId: "rev-1",
      occurredAt: "2026-07-27T08:00:00.000Z",
      contentDigest: CONTENT_DIGEST,
      title: "Imported item"
    }
  };
}

function createLocalWorkItem(): WorkItemCreatedEvent {
  return {
    eventId: "taskseal:TS-LOCAL:created",
    workItemId: "TS-LOCAL",
    type: "work_item.created",
    occurredAt: "2026-07-27T08:00:00.000Z",
    payload: {
      title: "Local item",
      requiredEvidence: ["tests"],
      externalLink: {
        provider: "taskseal",
        externalId: "TS-LOCAL",
        url:
          "http://127.0.0.1/work-items/TS-LOCAL"
      }
    }
  };
}

class MemoryJournal implements EventJournal {
  readonly records: unknown[];
  appendCalls = 0;

  constructor(records: unknown[] = []) {
    this.records = structuredClone(records);
  }

  async readAll(): Promise<unknown[]> {
    return structuredClone(this.records);
  }

  async append(event: CanonicalEvent): Promise<void> {
    this.appendCalls += 1;
    this.records.push(structuredClone(event));
  }
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}
