import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEvent,
  classifyProcessedEvent,
  createWorkflow
} from "../src/domain/workflow.js";

test("the domain exposes the single processed-event classification contract", () => {
  const event = createLegacyWorkItemEvent();
  const workflow = applyEvent(createWorkflow(), event);

  assert.equal(
    classifyProcessedEvent(workflow, structuredClone(event)),
    "EXACT_EVENT_DUPLICATE"
  );
  assert.equal(
    classifyProcessedEvent(workflow, {
      ...event,
      occurredAt: "2026-07-26T08:02:00.000Z"
    }),
    "EVENT_ID_CONFLICT"
  );
  assert.equal(
    classifyProcessedEvent(workflow, {
      ...event,
      eventId: "github:issue-502:created"
    }),
    null
  );
});

test("legacy GitHub work item links receive a deterministic compatibility identity", () => {
  const workflow = applyEvent(
    createWorkflow(),
    createLegacyWorkItemEvent()
  );

  assert.deepEqual(workflow.workItems["TS-1"].externalLinks, [
    {
      providerObjectKey: "github:issue:501",
      provider: "github",
      objectType: "issue",
      externalId: "501",
      scopeRef: null,
      url: "https://github.com/netpilot-z/TaskSeal/issues/1",
      managedFields: null,
      lastObservation: null,
      legacy: true
    }
  ]);
});

test("legacy journals with duplicate provider references remain replayable", () => {
  const events = [
    createLegacyWorkItemEvent(),
    createLegacyWorkItemEvent({
      eventId: "github:issue-501:created-again",
      workItemId: "TS-2"
    })
  ];
  const workflow = events.reduce(applyEvent, createWorkflow());

  assert.equal(
    workflow.workItems["TS-1"].externalLinks[0]
      .providerObjectKey,
    "github:issue:501"
  );
  assert.equal(
    workflow.workItems["TS-2"].externalLinks[0]
      .providerObjectKey,
    "github:issue:501"
  );
  assert.throws(
    () =>
      applyEvent(workflow, {
        ...createBaselineEvent(),
        eventId:
          "taskseal:import:v1:observe:github-501-ambiguous",
        workItemId: "TS-2"
      }),
    hasCode("PROVIDER_OBJECT_ALREADY_LINKED")
  );
});

test("a legacy GitHub link accepts exactly one explicit v2 baseline", () => {
  const initial = applyEvent(
    createWorkflow(),
    createLegacyWorkItemEvent()
  );
  const baselined = applyEvent(initial, {
    eventId: "taskseal:import:v1:observe:github-501-baseline",
    workItemId: "TS-1",
    type: "external_link.observed",
    occurredAt: "2026-07-26T08:01:00.000Z",
    payload: {
      providerObjectKey: "github:issue:501",
      expectedRevisionId: null,
      baseline: {
        providerObjectKey: "github:issue:501",
        objectType: "issue",
        scopeRef: {
          kind: "repository",
          key: "github:repository:netpilot-z/taskseal"
        },
        managedFields: ["title"]
      },
      observation: {
        revisionId: "2026-07-26T08:01:00.000Z",
        occurredAt: "2026-07-26T08:01:00.000Z",
        contentDigest: `sha256:${"a".repeat(64)}`,
        url: "https://github.com/netpilot-z/TaskSeal/issues/1",
        title: "Import provider facts safely"
      }
    }
  });

  assert.deepEqual(
    baselined.workItems["TS-1"].externalLinks[0],
    {
      ...createRichGitHubLink(),
      lastObservation: {
        ...createRichGitHubLink().lastObservation,
        url: "https://github.com/netpilot-z/TaskSeal/issues/1"
      }
    }
  );
});

test("an import event links a new provider object without changing delivery state", () => {
  const initial = applyEvent(
    createWorkflow(),
    createLocalWorkItemEvent()
  );
  const link = createRichGitHubLink();
  const linked = applyEvent(initial, {
    eventId: "taskseal:import:v1:link:github-501",
    workItemId: "TS-1",
    type: "external_link.linked",
    occurredAt: "2026-07-26T08:01:00.000Z",
    payload: { link }
  });

  assert.equal(linked.workItems["TS-1"].status, "planned");
  assert.equal(
    linked.workItems["TS-1"].title,
    initial.workItems["TS-1"].title
  );
  assert.deepEqual(
    linked.workItems["TS-1"].externalLinks,
    [...initial.workItems["TS-1"].externalLinks, link]
  );
});

test("a provider object cannot be linked to two work items", () => {
  const first = applyEvent(
    createWorkflow(),
    createLocalWorkItemEvent()
  );
  const linked = applyEvent(first, {
    eventId: "taskseal:import:v1:link:github-501",
    workItemId: "TS-1",
    type: "external_link.linked",
    occurredAt: "2026-07-26T08:01:00.000Z",
    payload: { link: createRichGitHubLink() }
  });
  const withSecondWorkItem = applyEvent(
    linked,
    createLocalWorkItemEvent({ workItemId: "TS-2" })
  );

  assert.throws(
    () =>
      applyEvent(withSecondWorkItem, {
        eventId: "taskseal:import:v1:link:github-501-again",
        workItemId: "TS-2",
        type: "external_link.linked",
        occurredAt: "2026-07-26T08:02:00.000Z",
        payload: { link: createRichGitHubLink() }
      }),
    hasCode("PROVIDER_OBJECT_ALREADY_LINKED")
  );
});

test("a rich work item create also enforces provider object uniqueness", () => {
  const created = applyEvent(
    createWorkflow(),
    createRichWorkItemEvent()
  );

  assert.throws(
    () =>
      applyEvent(
        created,
        createRichWorkItemEvent({
          workItemId: "TS-2",
          eventId: "taskseal:import:v1:create:github-501-again"
        })
      ),
    hasCode("PROVIDER_OBJECT_ALREADY_LINKED")
  );
});

test("two external links cannot both manage the work item title", () => {
  const created = applyEvent(
    createWorkflow(),
    createRichWorkItemEvent()
  );

  assert.throws(
    () =>
      applyEvent(created, {
        eventId: "taskseal:import:v1:link:linear-1",
        workItemId: "TS-1",
        type: "external_link.linked",
        occurredAt: "2026-07-26T08:02:00.000Z",
        payload: { link: createRichLinearLink() }
      }),
    hasCode("FIELD_AUTHORITY_CONFLICT")
  );
});

test("a newer observation refreshes a reference link without changing the work item title", () => {
  const created = applyEvent(
    createWorkflow(),
    createLocalWorkItemEvent()
  );
  const linked = applyEvent(created, {
    eventId: "taskseal:import:v1:link:github-501",
    workItemId: "TS-1",
    type: "external_link.linked",
    occurredAt: "2026-07-26T08:01:00.000Z",
    payload: {
      link: createRichGitHubLink({ managedFields: [] })
    }
  });
  const refreshed = applyEvent(linked, {
    eventId: "taskseal:import:v1:observe:github-501-revision-2",
    workItemId: "TS-1",
    type: "external_link.observed",
    occurredAt: "2026-07-26T08:02:00.000Z",
    payload: {
      providerObjectKey: "github:issue:501",
      expectedRevisionId: "2026-07-26T08:01:00.000Z",
      observation: {
        revisionId: "2026-07-26T08:02:00.000Z",
        occurredAt: "2026-07-26T08:02:00.000Z",
        contentDigest: `sha256:${"b".repeat(64)}`,
        url: "https://github.com/netpilot-z/TaskSeal/issues/1",
        title: "Renamed provider issue"
      }
    }
  });

  const workItem = refreshed.workItems["TS-1"];
  const providerLink = workItem.externalLinks.find(
    (link) => link.providerObjectKey === "github:issue:501"
  );

  assert.equal(workItem.title, "Import provider facts safely");
  assert.equal(workItem.status, "planned");
  assert.equal(providerLink.lastObservation.revisionId, "2026-07-26T08:02:00.000Z");
  assert.equal(providerLink.lastObservation.title, "Renamed provider issue");
});

test("a title manager can update only the canonical title after its observation", () => {
  const created = applyEvent(
    createWorkflow(),
    createLocalWorkItemEvent()
  );
  const linked = applyEvent(created, {
    eventId: "taskseal:import:v1:link:github-501",
    workItemId: "TS-1",
    type: "external_link.linked",
    occurredAt: "2026-07-26T08:01:00.000Z",
    payload: { link: createRichGitHubLink() }
  });
  const observed = applyEvent(linked, {
    eventId: "taskseal:import:v1:observe:github-501-revision-2",
    workItemId: "TS-1",
    type: "external_link.observed",
    occurredAt: "2026-07-26T08:02:00.000Z",
    payload: {
      providerObjectKey: "github:issue:501",
      expectedRevisionId: "2026-07-26T08:01:00.000Z",
      observation: {
        revisionId: "2026-07-26T08:02:00.000Z",
        occurredAt: "2026-07-26T08:02:00.000Z",
        contentDigest: `sha256:${"b".repeat(64)}`,
        url: "https://github.com/netpilot-z/TaskSeal/issues/1",
        title: "Renamed provider issue"
      }
    }
  });
  const updated = applyEvent(observed, {
    eventId: "taskseal:import:v1:update-title:github-501-revision-2",
    workItemId: "TS-1",
    type: "work_item.updated",
    occurredAt: "2026-07-26T08:02:00.000Z",
    payload: {
      source: {
        providerObjectKey: "github:issue:501",
        revisionId: "2026-07-26T08:02:00.000Z",
        contentDigest: `sha256:${"b".repeat(64)}`
      },
      changes: {
        title: {
          before: "Import provider facts safely",
          after: "Renamed provider issue"
        }
      }
    }
  });

  assert.equal(updated.workItems["TS-1"].title, "Renamed provider issue");
  assert.equal(updated.workItems["TS-1"].status, "planned");
  assert.deepEqual(
    updated.workItems["TS-1"].requiredEvidence,
    ["tests"]
  );
});

test("observations reject duplicate, conflicting, stale, and ambiguous revisions", () => {
  const current = createWorkflowWithRichLink({
    managedFields: []
  });
  const scenarios = [
    {
      name: "exact revision",
      revisionId: "2026-07-26T08:01:00.000Z",
      occurredAt: "2026-07-26T08:01:00.000Z",
      contentDigest: `sha256:${"a".repeat(64)}`,
      code: "SOURCE_REVISION_NOT_ADVANCED"
    },
    {
      name: "conflicting revision content",
      revisionId: "2026-07-26T08:01:00.000Z",
      occurredAt: "2026-07-26T08:01:00.000Z",
      contentDigest: `sha256:${"b".repeat(64)}`,
      code: "SOURCE_REVISION_CONTENT_CONFLICT"
    },
    {
      name: "stale revision",
      revisionId: "2026-07-26T08:00:00.000Z",
      occurredAt: "2026-07-26T08:00:00.000Z",
      contentDigest: `sha256:${"b".repeat(64)}`,
      code: "SOURCE_REVISION_STALE"
    },
    {
      name: "ambiguous revision",
      revisionId: "provider-revision-2",
      occurredAt: "2026-07-26T08:01:00.000Z",
      contentDigest: `sha256:${"b".repeat(64)}`,
      code: "SOURCE_REVISION_ORDER_AMBIGUOUS"
    }
  ];

  for (const scenario of scenarios) {
    assert.throws(
      () =>
        applyEvent(current, {
          eventId: `taskseal:import:v1:observe:${scenario.name}`,
          workItemId: "TS-1",
          type: "external_link.observed",
          occurredAt: scenario.occurredAt,
          payload: {
            providerObjectKey: "github:issue:501",
            expectedRevisionId: "2026-07-26T08:01:00.000Z",
            observation: {
              revisionId: scenario.revisionId,
              occurredAt: scenario.occurredAt,
              contentDigest: scenario.contentDigest,
              title: "Import provider facts safely"
            }
          }
        }),
      hasCode(scenario.code),
      scenario.name
    );
  }
});

test("only an importable legacy provider issue accepts a null-revision baseline once", () => {
  const legacy = applyEvent(
    createWorkflow(),
    createLegacyWorkItemEvent()
  );
  const baselineEvent = createBaselineEvent();
  const baselined = applyEvent(legacy, baselineEvent);

  assert.throws(
    () =>
      applyEvent(baselined, {
        ...baselineEvent,
        eventId: "taskseal:import:v1:observe:github-501-baseline-again"
      }),
    hasCode("EXTERNAL_LINK_BASELINE_INVALID")
  );

  const rich = createWorkflowWithRichLink();
  assert.throws(
    () => applyEvent(rich, baselineEvent),
    hasCode("EXTERNAL_LINK_BASELINE_INVALID")
  );

  const local = applyEvent(
    createWorkflow(),
    createLocalWorkItemEvent()
  );
  assert.throws(
    () =>
      applyEvent(local, {
        ...baselineEvent,
        payload: {
          ...baselineEvent.payload,
          providerObjectKey: "legacy:taskseal:TS-1",
          baseline: {
            ...baselineEvent.payload.baseline,
            providerObjectKey: "legacy:taskseal:TS-1"
          }
        }
      }),
    hasCode("EXTERNAL_LINK_BASELINE_INVALID")
  );
});

test("provider-driven title updates enforce authority, source, and before-value preconditions", () => {
  const referenceWorkflow = createWorkflowWithRichLink({
    managedFields: []
  });
  const source = {
    providerObjectKey: "github:issue:501",
    revisionId: "2026-07-26T08:01:00.000Z",
    contentDigest: `sha256:${"a".repeat(64)}`
  };
  const changes = {
    title: {
      before: "Import provider facts safely",
      after: "Renamed provider issue"
    }
  };

  assert.throws(
    () =>
      applyEvent(referenceWorkflow, {
        eventId: "taskseal:import:v1:update-title:reference",
        workItemId: "TS-1",
        type: "work_item.updated",
        occurredAt: "2026-07-26T08:02:00.000Z",
        payload: { source, changes }
      }),
    hasCode("FIELD_AUTHORITY_CONFLICT")
  );

  const managedWorkflow = createWorkflowWithRichLink();
  assert.throws(
    () =>
      applyEvent(managedWorkflow, {
        eventId: "taskseal:import:v1:update-title:wrong-source",
        workItemId: "TS-1",
        type: "work_item.updated",
        occurredAt: "2026-07-26T08:02:00.000Z",
        payload: {
          source: {
            ...source,
            contentDigest: `sha256:${"b".repeat(64)}`
          },
          changes
        }
      }),
    hasCode("SOURCE_REVISION_MISMATCH")
  );
  assert.throws(
    () =>
      applyEvent(managedWorkflow, {
        eventId: "taskseal:import:v1:update-title:wrong-before",
        workItemId: "TS-1",
        type: "work_item.updated",
        occurredAt: "2026-07-26T08:02:00.000Z",
        payload: {
          source,
          changes: {
            title: {
              before: "Stale local title",
              after: "Import provider facts safely"
            }
          }
        }
      }),
    hasCode("WORK_ITEM_UPDATE_PRECONDITION_FAILED")
  );
});

test("external metadata events preserve delivery and acceptance state", () => {
  const initial = createWorkflowWithRichLink();
  const workItem = initial.workItems["TS-1"];
  const protectedDeliveryState = {
    status: "accepted",
    activeAttemptId: null,
    activeArtifact: {
      id: "pr-1",
      attemptId: "run-1",
      kind: "pull_request",
      revision: "abc123",
      url: "https://github.com/netpilot-z/TaskSeal/pull/1",
      linkedAt: "2026-07-26T08:00:30.000Z"
    },
    attempts: [
      {
        id: "run-1",
        agentId: "codex",
        startedAt: "2026-07-26T08:00:00.000Z",
        finishedAt: "2026-07-26T08:00:20.000Z",
        outcome: "completed"
      }
    ],
    artifacts: [
      {
        id: "pr-1",
        attemptId: "run-1",
        kind: "pull_request",
        revision: "abc123",
        url: "https://github.com/netpilot-z/TaskSeal/pull/1",
        linkedAt: "2026-07-26T08:00:30.000Z"
      }
    ],
    evidence: [
      {
        id: "check-1",
        attemptId: "run-1",
        artifactId: "pr-1",
        revision: "abc123",
        criterionKey: "tests",
        outcome: "passed",
        url: "https://github.com/netpilot-z/TaskSeal/actions/runs/1",
        recordedAt: "2026-07-26T08:00:40.000Z"
      }
    ],
    acceptanceDecision: {
      decision: "accepted",
      actor: "owner",
      reason: "Evidence verified",
      decidedAt: "2026-07-26T08:00:50.000Z"
    }
  };
  const accepted = {
    ...initial,
    workItems: {
      ...initial.workItems,
      "TS-1": {
        ...workItem,
        ...protectedDeliveryState
      }
    }
  };
  const observed = applyEvent(accepted, {
    eventId: "taskseal:import:v1:observe:github-501-revision-2",
    workItemId: "TS-1",
    type: "external_link.observed",
    occurredAt: "2026-07-26T08:02:00.000Z",
    payload: {
      providerObjectKey: "github:issue:501",
      expectedRevisionId: "2026-07-26T08:01:00.000Z",
      observation: {
        revisionId: "2026-07-26T08:02:00.000Z",
        occurredAt: "2026-07-26T08:02:00.000Z",
        contentDigest: `sha256:${"b".repeat(64)}`,
        title: "Renamed provider issue"
      }
    }
  });
  const updated = applyEvent(observed, {
    eventId: "taskseal:import:v1:update-title:github-501-revision-2",
    workItemId: "TS-1",
    type: "work_item.updated",
    occurredAt: "2026-07-26T08:02:00.000Z",
    payload: {
      source: {
        providerObjectKey: "github:issue:501",
        revisionId: "2026-07-26T08:02:00.000Z",
        contentDigest: `sha256:${"b".repeat(64)}`
      },
      changes: {
        title: {
          before: "Import provider facts safely",
          after: "Renamed provider issue"
        }
      }
    }
  });

  for (const [key, value] of Object.entries(protectedDeliveryState)) {
    assert.deepEqual(updated.workItems["TS-1"][key], value, key);
  }
});

test("new canonical events remain idempotent and detect event ID conflicts", () => {
  const initial = applyEvent(
    createWorkflow(),
    createLocalWorkItemEvent()
  );
  const event = {
    eventId: "taskseal:import:v1:link:github-501",
    workItemId: "TS-1",
    type: "external_link.linked",
    occurredAt: "2026-07-26T08:01:00.000Z",
    payload: { link: createRichGitHubLink() }
  };
  const linked = applyEvent(initial, event);

  assert.equal(applyEvent(linked, event), linked);
  assert.throws(
    () =>
      applyEvent(linked, {
        ...event,
        payload: {
          link: createRichGitHubLink({
            managedFields: []
          })
        }
      }),
    hasCode("EVENT_ID_CONFLICT")
  );
});

test("rich import events reject unknown link fields and forbidden create fields", () => {
  const richCreate = createRichWorkItemEvent();

  assert.throws(
    () =>
      applyEvent(createWorkflow(), {
        ...richCreate,
        payload: {
          ...richCreate.payload,
          status: "accepted"
        }
      }),
    hasCode("EVENT_PAYLOAD_INVALID")
  );

  const initial = applyEvent(
    createWorkflow(),
    createLocalWorkItemEvent()
  );
  assert.throws(
    () =>
      applyEvent(initial, {
        eventId: "taskseal:import:v1:link:github-501-with-secret",
        workItemId: "TS-1",
        type: "external_link.linked",
        occurredAt: "2026-07-26T08:01:00.000Z",
        payload: {
          link: {
            ...createRichGitHubLink(),
            token: "must-not-enter-workflow"
          }
        }
      }),
    hasCode("EVENT_PAYLOAD_INVALID")
  );
});

test("legacy baselines reject a scope that does not match the provider", () => {
  const legacy = applyEvent(
    createWorkflow(),
    createLegacyWorkItemEvent()
  );
  const baseline = createBaselineEvent();

  assert.throws(
    () =>
      applyEvent(legacy, {
        ...baseline,
        payload: {
          ...baseline.payload,
          baseline: {
            ...baseline.payload.baseline,
            scopeRef: {
              kind: "team",
              key:
                "linear:team:22222222-2222-4222-8222-222222222222",
              parentKey:
                "linear:organization:33333333-3333-4333-8333-333333333333"
            }
          }
        }
      }),
    hasCode("EXTERNAL_LINK_BASELINE_INVALID")
  );
});

test("legacy journals replay titles that predate the import title limit", () => {
  const legacyEvent = createLegacyWorkItemEvent();
  legacyEvent.payload.title = "x".repeat(513);

  const workflow = applyEvent(
    createWorkflow(),
    legacyEvent
  );

  assert.equal(
    workflow.workItems["TS-1"].title,
    legacyEvent.payload.title
  );
});

test("title limits count Unicode code points instead of UTF-16 code units", () => {
  const maximumTitle = "😀".repeat(512);
  const valid = createRichWorkItemEvent();
  const link = createRichGitHubLink();

  valid.payload.title = maximumTitle;
  valid.payload.externalLink = {
    ...link,
    lastObservation: {
      ...link.lastObservation,
      title: maximumTitle
    }
  };

  assert.equal(
    applyEvent(createWorkflow(), valid)
      .workItems["TS-1"].title,
    maximumTitle
  );

  const tooLong = createRichWorkItemEvent({
    eventId: "taskseal:import:v1:create:github-501-long-title"
  });
  const tooLongTitle = "😀".repeat(513);
  tooLong.payload.title = tooLongTitle;
  tooLong.payload.externalLink = {
    ...link,
    lastObservation: {
      ...link.lastObservation,
      title: tooLongTitle
    }
  };

  assert.throws(
    () => applyEvent(createWorkflow(), tooLong),
    hasCode("EVENT_PAYLOAD_INVALID")
  );
});

function createLegacyWorkItemEvent({
  eventId = "github:issue-501:created",
  workItemId = "TS-1"
} = {}) {
  return {
    eventId,
    workItemId,
    type: "work_item.created",
    occurredAt: "2026-07-26T08:00:00.000Z",
    payload: {
      title: "Import provider facts safely",
      requiredEvidence: ["tests"],
      externalLink: {
        provider: "github",
        externalId: "501",
        url: "https://github.com/netpilot-z/TaskSeal/issues/1"
      }
    }
  };
}

function createLocalWorkItemEvent({
  workItemId = "TS-1"
} = {}) {
  return {
    eventId: `taskseal:${workItemId}:local-created`,
    workItemId,
    type: "work_item.created",
    occurredAt: "2026-07-26T08:00:00.000Z",
    payload: {
      title: "Import provider facts safely",
      requiredEvidence: ["tests"],
      externalLink: {
        provider: "taskseal",
        externalId: workItemId,
        url: `http://127.0.0.1:4317/work-items/${workItemId}`
      }
    }
  };
}

function createRichWorkItemEvent({
  workItemId = "TS-1",
  eventId = "taskseal:import:v1:create:github-501"
} = {}) {
  return {
    eventId,
    workItemId,
    type: "work_item.created",
    occurredAt: "2026-07-26T08:01:00.000Z",
    payload: {
      title: "Import provider facts safely",
      requiredEvidence: ["tests"],
      externalLink: createRichGitHubLink()
    }
  };
}

function createWorkflowWithRichLink({
  managedFields = ["title"]
} = {}) {
  const created = applyEvent(
    createWorkflow(),
    createLocalWorkItemEvent()
  );

  return applyEvent(created, {
    eventId: "taskseal:import:v1:link:github-501",
    workItemId: "TS-1",
    type: "external_link.linked",
    occurredAt: "2026-07-26T08:01:00.000Z",
    payload: {
      link: createRichGitHubLink({ managedFields })
    }
  });
}

function createBaselineEvent() {
  return {
    eventId: "taskseal:import:v1:observe:github-501-baseline",
    workItemId: "TS-1",
    type: "external_link.observed",
    occurredAt: "2026-07-26T08:01:00.000Z",
    payload: {
      providerObjectKey: "github:issue:501",
      expectedRevisionId: null,
      baseline: {
        providerObjectKey: "github:issue:501",
        objectType: "issue",
        scopeRef: {
          kind: "repository",
          key: "github:repository:netpilot-z/taskseal"
        },
        managedFields: ["title"]
      },
      observation: {
        revisionId: "2026-07-26T08:01:00.000Z",
        occurredAt: "2026-07-26T08:01:00.000Z",
        contentDigest: `sha256:${"a".repeat(64)}`,
        url: "https://github.com/netpilot-z/TaskSeal/issues/1",
        title: "Import provider facts safely"
      }
    }
  };
}

function hasCode(code) {
  return (error) => error?.code === code;
}

function createRichGitHubLink({
  managedFields = ["title"]
} = {}) {
  return {
    providerObjectKey: "github:issue:501",
    provider: "github",
    objectType: "issue",
    externalId: "501",
    scopeRef: {
      kind: "repository",
      key: "github:repository:netpilot-z/taskseal"
    },
    url: "https://github.com/netpilot-z/TaskSeal/issues/1",
    managedFields,
    lastObservation: {
      revisionId: "2026-07-26T08:01:00.000Z",
      occurredAt: "2026-07-26T08:01:00.000Z",
      contentDigest: `sha256:${"a".repeat(64)}`,
      title: "Import provider facts safely"
    }
  };
}

function createRichLinearLink() {
  return {
    providerObjectKey:
      "linear:issue:11111111-1111-4111-8111-111111111111",
    provider: "linear",
    objectType: "issue",
    externalId: "11111111-1111-4111-8111-111111111111",
    scopeRef: {
      kind: "team",
      key: "linear:team:22222222-2222-4222-8222-222222222222",
      parentKey:
        "linear:organization:33333333-3333-4333-8333-333333333333"
    },
    url: "https://linear.app/taskseal/issue/NP-1/example",
    managedFields: ["title"],
    lastObservation: {
      revisionId: "2026-07-26T08:02:00.000Z",
      occurredAt: "2026-07-26T08:02:00.000Z",
      contentDigest: `sha256:${"c".repeat(64)}`,
      title: "Import provider facts safely"
    }
  };
}
