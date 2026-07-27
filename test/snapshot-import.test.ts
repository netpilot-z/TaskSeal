import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEvent,
  createWorkflow
} from "../src/domain/workflow.ts";
import type {
  AttemptStartedEvent,
  ManagedField,
  WorkItemCreatedEvent,
  Workflow
} from "../src/domain/workflow.ts";
import {
  digestProviderFactContent
} from "../src/lib/provider-snapshot.ts";
import type {
  ProviderCheckFact,
  ProviderFact,
  ProviderIssueFact,
  ProviderObjectType,
  ProviderPullRequestFact,
  ProviderSnapshotV2
} from "../src/lib/provider-snapshot.ts";
import {
  computeImportPlanDigest,
  deriveImportEventId
} from "../src/application/import-plan.ts";
import type {
  ImportPlan,
  ImportPlanEvent
} from "../src/application/import-plan.ts";
import type {
  NormalizedImportPolicy
} from "../src/application/import-policy.ts";
import {
  parseProviderSnapshotJson,
  previewSnapshotImport
} from "../src/application/snapshot-import.ts";
import {
  normalizeLinearIssueFact
} from "../src/connectors/linear.ts";

test("preview plans a deterministic first import without mutating its inputs", () => {
  const snapshot = createGitHubIssueSnapshot();
  const workflow = createWorkflow();
  const importPolicy = createImportPolicy();
  const originalInputs = structuredClone({
    snapshot,
    workflow,
    importPolicy
  });

  const first = previewSnapshotImport({
    snapshot,
    workflow,
    importPolicy
  });
  const second = previewSnapshotImport({
    snapshot,
    workflow,
    importPolicy
  });

  assert.deepEqual(first, second);
  assert.deepEqual(
    { snapshot, workflow, importPolicy },
    originalInputs
  );
  assert.deepEqual(first.summary, {
    create: 1,
    link: 0,
    refresh: 0,
    update: 0,
    skip: 0,
    conflict: 0
  });
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.mode, "preview");
  const firstAction = required(first.actions[0]);
  const firstEvent = required(first.events[0]);
  assert.equal(firstAction.reasonCode, "NEW_WORK_ITEM");
  assert.equal(first.events.length, 1);
  assert.equal(firstEvent.type, "work_item.created");
  assert.equal(
    firstEvent.eventId,
    deriveImportEventId({
      eventType: "work_item.created",
      workItemId: "TS-1",
      providerObjectKey: "github:issue:501",
      sourceRevisionId:
        "2026-07-26T08:01:00.000Z",
      semanticTarget: "work-item"
    })
  );
  assert.equal(
    computeImportPlanDigest(first),
    first.planDigest
  );
  const tamperedPlan = structuredClone(first);
  required(tamperedPlan.events[0]).payload.title =
    "Tampered";
  assert.notEqual(
    computeImportPlanDigest(tamperedPlan),
    first.planDigest
  );
  assert.deepEqual(
    firstEvent.payload.externalLink,
    {
      providerObjectKey: "github:issue:501",
      provider: "github",
      objectType: "issue",
      externalId: "501",
      scopeRef: {
        kind: "repository",
        key: "github:repository:netpilot-z/taskseal"
      },
      url: "https://github.com/netpilot-z/TaskSeal/issues/1",
      managedFields: ["title"],
      lastObservation: {
        revisionId: "2026-07-26T08:01:00.000Z",
        occurredAt: "2026-07-26T08:01:00.000Z",
        contentDigest:
          snapshot.facts[0].revision.contentDigest,
        title: "Import provider facts safely"
      }
    }
  );

  const digestFields: Array<
    | "snapshotDigest"
    | "mappingDigest"
    | "policyDigest"
    | "baseWorkflowDigest"
    | "planDigest"
  > = [
    "snapshotDigest",
    "mappingDigest",
    "policyDigest",
    "baseWorkflowDigest",
    "planDigest"
  ];
  for (const field of digestFields) {
    assert.match(first[field], /^sha256:[0-9a-f]{64}$/, field);
  }
});

test("preview recognizes an exact provider revision as a no-op", () => {
  const snapshot = createGitHubIssueSnapshot();
  const createdPlan = previewSnapshotImport({
    snapshot,
    workflow: createWorkflow(),
    importPolicy: createImportPolicy()
  });
  const workflow = createdPlan.events.reduce(
    applyEvent,
    createWorkflow()
  );
  const duplicate = previewSnapshotImport({
    snapshot,
    workflow,
    importPolicy: createImportPolicy()
  });

  assert.deepEqual(duplicate.summary, {
    create: 0,
    link: 0,
    refresh: 0,
    update: 0,
    skip: 1,
    conflict: 0
  });
  assert.equal(
    required(duplicate.actions[0]).reasonCode,
    "EXACT_DUPLICATE"
  );
  assert.deepEqual(duplicate.events, []);
  assert.deepEqual(duplicate.conflicts, []);
});

test("a newer managed title plans observation before canonical update", () => {
  const initialSnapshot = createGitHubIssueSnapshot();
  const initialPlan = previewSnapshotImport({
    snapshot: initialSnapshot,
    workflow: createWorkflow(),
    importPolicy: createImportPolicy()
  });
  const workflow = initialPlan.events.reduce(
    applyEvent,
    createWorkflow()
  );
  const renamedSnapshot = createGitHubIssueSnapshot({
    title: "Renamed provider issue",
    revisionId: "2026-07-26T08:02:00.000Z",
    revisionOccurredAt: "2026-07-26T08:02:00.000Z"
  });
  const plan = previewSnapshotImport({
    snapshot: renamedSnapshot,
    workflow,
    importPolicy: createImportPolicy()
  });

  assert.deepEqual(plan.summary, {
    create: 0,
    link: 0,
    refresh: 1,
    update: 1,
    skip: 0,
    conflict: 0
  });
  assert.deepEqual(
    plan.events.map((event) => event.type),
    ["external_link.observed", "work_item.updated"]
  );

  const projected = plan.events.reduce(applyEvent, workflow);
  assert.equal(
    required(projected.workItems["TS-1"]).title,
    "Renamed provider issue"
  );
});

test("a reference link refreshes its observation without changing canonical title", () => {
  const initialSnapshot = createGitHubIssueSnapshot({
    managedFields: []
  });
  const initialPlan = previewSnapshotImport({
    snapshot: initialSnapshot,
    workflow: createWorkflow(),
    importPolicy: createImportPolicy()
  });
  const workflow = initialPlan.events.reduce(
    applyEvent,
    createWorkflow()
  );
  const renamedSnapshot = createGitHubIssueSnapshot({
    managedFields: [],
    title: "Renamed reference issue",
    revisionId: "2026-07-26T08:02:00.000Z",
    revisionOccurredAt: "2026-07-26T08:02:00.000Z"
  });
  const plan = previewSnapshotImport({
    snapshot: renamedSnapshot,
    workflow,
    importPolicy: createImportPolicy()
  });

  assert.deepEqual(plan.summary, {
    create: 0,
    link: 0,
    refresh: 1,
    update: 0,
    skip: 0,
    conflict: 0
  });
  assert.deepEqual(
    plan.events.map((event) => event.type),
    ["external_link.observed"]
  );

  const projected = plan.events.reduce(applyEvent, workflow);
  const projectedWorkItem = required(
    projected.workItems["TS-1"]
  );
  const projectedLink = required(
    projectedWorkItem.externalLinks[0]
  );
  assert.equal(
    projectedWorkItem.title,
    "Import provider facts safely"
  );
  assert.equal(
    required(projectedLink.lastObservation).title,
    "Renamed reference issue"
  );
});

test("preview blocks mapping drift and provider objects already owned elsewhere", () => {
  const snapshot = createGitHubIssueSnapshot();
  const initialPlan = previewSnapshotImport({
    snapshot,
    workflow: createWorkflow(),
    importPolicy: createImportPolicy()
  });
  const workflow = initialPlan.events.reduce(
    applyEvent,
    createWorkflow()
  );
  const mappingConflict = previewSnapshotImport({
    snapshot: createGitHubIssueSnapshot({
      requiredEvidence: ["lint"]
    }),
    workflow,
    importPolicy: createImportPolicy()
  });
  const ownerConflict = previewSnapshotImport({
    snapshot: createGitHubIssueSnapshot({
      workItemId: "TS-2"
    }),
    workflow,
    importPolicy: createImportPolicy()
  });

  assert.equal(mappingConflict.summary.conflict, 1);
  assert.equal(
    required(mappingConflict.conflicts[0]).code,
    "WORK_ITEM_MAPPING_CONFLICT"
  );
  assert.equal(ownerConflict.summary.conflict, 1);
  assert.equal(
    required(ownerConflict.conflicts[0]).code,
    "PROVIDER_OBJECT_ALREADY_LINKED"
  );
  assert.deepEqual(mappingConflict.events, []);
  assert.deepEqual(ownerConflict.events, []);
});

test("preview distinguishes stale, ambiguous, and conflicting source revisions", () => {
  const currentSnapshot = createGitHubIssueSnapshot({
    revisionId: "provider-revision-current",
    revisionOccurredAt: "2026-07-26T08:02:00.000Z"
  });
  const initialPlan = previewSnapshotImport({
    snapshot: currentSnapshot,
    workflow: createWorkflow(),
    importPolicy: createImportPolicy()
  });
  const workflow = initialPlan.events.reduce(
    applyEvent,
    createWorkflow()
  );
  const stale = previewSnapshotImport({
    snapshot: createGitHubIssueSnapshot({
      title: "Stale title",
      revisionId: "provider-revision-old",
      revisionOccurredAt: "2026-07-26T08:01:00.000Z"
    }),
    workflow,
    importPolicy: createImportPolicy()
  });
  const ambiguous = previewSnapshotImport({
    snapshot: createGitHubIssueSnapshot({
      title: "Ambiguous title",
      revisionId: "provider-revision-other",
      revisionOccurredAt: "2026-07-26T08:02:00.000Z"
    }),
    workflow,
    importPolicy: createImportPolicy()
  });
  const conflicting = previewSnapshotImport({
    snapshot: createGitHubIssueSnapshot({
      title: "Conflicting title",
      revisionId: "provider-revision-current",
      revisionOccurredAt: "2026-07-26T08:02:00.000Z"
    }),
    workflow,
    importPolicy: createImportPolicy()
  });

  const staleAction = required(stale.actions[0]);
  assert.equal(staleAction.kind, "skip");
  assert.equal(
    staleAction.reasonCode,
    "STALE_SOURCE_REVISION"
  );
  assert.deepEqual(stale.warnings, [
    {
      actionId: staleAction.actionId,
      code: "STALE_SOURCE_REVISION"
    }
  ]);
  assert.equal(
    required(ambiguous.conflicts[0]).code,
    "SOURCE_REVISION_ORDER_AMBIGUOUS"
  );
  assert.equal(
    required(conflicting.conflicts[0]).code,
    "SOURCE_REVISION_CONTENT_CONFLICT"
  );
});

test("raw snapshot parsing enforces the pre-parse byte limit and schema version", () => {
  const snapshot = createGitHubIssueSnapshot();

  assert.deepEqual(
    parseProviderSnapshotJson(JSON.stringify(snapshot)),
    snapshot
  );
  assert.throws(
    () =>
      parseProviderSnapshotJson(
        JSON.stringify({
          ...snapshot,
          padding: "x".repeat(1024 * 1024)
        })
      ),
    hasCode("SNAPSHOT_LIMIT_EXCEEDED")
  );
  assert.throws(
    () =>
      previewSnapshotImport({
        snapshot: {
          ...snapshot,
          schemaVersion: 1
        },
        workflow: createWorkflow(),
        importPolicy: createImportPolicy()
      }),
    hasCode("SNAPSHOT_SCHEMA_NOT_IMPORTABLE")
  );
});

test("delivery facts plan a stable external link, artifact, and evidence chain", () => {
  const workflow = createRunningWorkflow();
  const snapshot = createGitHubDeliverySnapshot();
  const reversed = {
    ...snapshot,
    facts: [...snapshot.facts].reverse()
  };
  const importPolicy = createImportPolicy({
    objectTypes: ["check", "issue", "pull_request"]
  });
  const plan = previewSnapshotImport({
    snapshot,
    workflow,
    importPolicy
  });
  const reversedPlan = previewSnapshotImport({
    snapshot: reversed,
    workflow,
    importPolicy
  });

  assert.deepEqual(plan, reversedPlan);
  assert.deepEqual(plan.summary, {
    create: 0,
    link: 2,
    refresh: 0,
    update: 1,
    skip: 0,
    conflict: 0
  });
  assert.deepEqual(
    plan.events.map((event) => event.type),
    [
      "external_link.linked",
      "artifact.linked",
      "evidence.recorded"
    ]
  );

  const projected = plan.events.reduce(applyEvent, workflow);
  const projectedDelivery = required(
    projected.workItems["TS-1"]
  );
  assert.equal(projectedDelivery.artifacts.length, 1);
  assert.equal(projectedDelivery.evidence.length, 1);
});

test("multiple issue facts create one work item then link the remaining provider objects", () => {
  const snapshot = createGitHubIssueSnapshot({
    managedFields: []
  });
  const secondFact = structuredClone(snapshot.facts[0]);
  secondFact.sourceObject.providerObjectKey =
    "github:issue:502";
  secondFact.sourceObject.externalId = "502";
  secondFact.sourceObject.url =
    "https://github.com/netpilot-z/TaskSeal/issues/2";
  secondFact.revision.id =
    "2026-07-26T08:02:00.000Z";
  secondFact.revision.occurredAt =
    "2026-07-26T08:02:00.000Z";
  secondFact.observed.title = "Second provider reference";
  secondFact.observed.createdAt =
    "2026-07-26T08:00:30.000Z";
  secondFact.candidateEvent.eventId =
    "github:issue-502:created";
  secondFact.candidateEvent.occurredAt =
    "2026-07-26T08:00:30.000Z";
  secondFact.candidateEvent.payload.title =
    secondFact.observed.title;
  secondFact.candidateEvent.payload.externalLink.externalId =
    "502";
  secondFact.candidateEvent.payload.externalLink.url =
    secondFact.sourceObject.url;
  secondFact.revision.contentDigest =
    digestProviderFactContent(secondFact);
  const multiSnapshot: ProviderSnapshotV2 = snapshot;
  multiSnapshot.facts = [secondFact, snapshot.facts[0]];

  const plan = previewSnapshotImport({
    snapshot: multiSnapshot,
    workflow: createWorkflow(),
    importPolicy: createImportPolicy()
  });

  assert.deepEqual(plan.summary, {
    create: 1,
    link: 1,
    refresh: 0,
    update: 0,
    skip: 0,
    conflict: 0
  });
  assert.deepEqual(
    plan.events.map((event) => event.type),
    ["work_item.created", "external_link.linked"]
  );

  const projected = plan.events.reduce(
    applyEvent,
    createWorkflow()
  );
  const projectedWorkItem = required(
    projected.workItems["TS-1"]
  );
  assert.deepEqual(
    projectedWorkItem.externalLinks.map(
      (link) => link.providerObjectKey
    ),
    ["github:issue:501", "github:issue:502"]
  );
});

test("candidate event replay is skipped exactly and conflicting reuse is blocked", () => {
  const snapshot = createGitHubDeliverySnapshot({
    includeIssue: false,
    includeCheck: false
  });
  const candidate =
    findFact(snapshot, "pull_request").candidateEvent;
  const running = createRunningWorkflow();
  const withCandidate = applyEvent(running, candidate);
  const importPolicy = createImportPolicy({
    objectTypes: ["pull_request"]
  });
  const duplicate = previewSnapshotImport({
    snapshot,
    workflow: withCandidate,
    importPolicy
  });
  const conflictingCandidate = {
    ...candidate,
    payload: {
      ...candidate.payload,
      url: "https://github.com/netpilot-z/TaskSeal/pull/99"
    }
  };
  const conflictingWorkflow = applyEvent(
    running,
    conflictingCandidate
  );
  const conflict = previewSnapshotImport({
    snapshot,
    workflow: conflictingWorkflow,
    importPolicy
  });

  assert.equal(
    required(duplicate.actions[0]).kind,
    "skip"
  );
  assert.equal(
    required(duplicate.actions[0]).reasonCode,
    "EXACT_EVENT_DUPLICATE"
  );
  assert.deepEqual(duplicate.events, []);
  assert.equal(
    required(conflict.actions[0]).kind,
    "conflict"
  );
  assert.equal(
    required(conflict.conflicts[0]).code,
    "EVENT_ID_CONFLICT"
  );
});

test("candidate domain failures become blocking conflicts with the cause code", () => {
  const snapshot = createGitHubDeliverySnapshot({
    includeIssue: false,
    includeCheck: false
  });
  const workflow = applyEvent(
    createWorkflow(),
    createLocalWorkItemEvent()
  );
  const plan = previewSnapshotImport({
    snapshot,
    workflow,
    importPolicy: createImportPolicy({
      objectTypes: ["pull_request"]
    })
  });

  assert.equal(plan.summary.conflict, 1);
  assert.deepEqual(
    Object.keys(required(plan.actions[0])),
    [
      "actionId",
      "kind",
      "workItemId",
      "sourceObjectKey",
      "sourceRevisionId",
      "semanticTarget",
      "reasonCode",
      "eventIds"
    ]
  );
  assert.deepEqual(plan.conflicts, [
    {
      actionId: required(plan.actions[0]).actionId,
      code: "DOMAIN_INVARIANT_VIOLATION",
      domainCode: "ATTEMPT_RELATION_INVALID"
    }
  ]);
  assert.deepEqual(plan.events, []);
});

test("check evidence must remain bound to the explicitly selected artifact revision", () => {
  const snapshot = createGitHubDeliverySnapshot();
  const checkFact = findFact(snapshot, "check");

  checkFact.candidateEvent.payload.artifactId = "pr-999";

  assert.throws(
    () =>
      previewSnapshotImport({
        snapshot,
        workflow: createRunningWorkflow(),
        importPolicy: createImportPolicy({
          objectTypes: ["check", "issue", "pull_request"]
        })
      }),
    hasCode("SNAPSHOT_INVALID")
  );
});

test("provider candidates cannot rewrite provider identity or revision time", () => {
  const deliveryMutations: Array<
    (snapshot: ProviderSnapshotV2) => void
  > = [
    (snapshot) => {
      findFact(snapshot, "pull_request")
        .candidateEvent.occurredAt =
        "2099-01-01T00:00:00.000Z";
    },
    (snapshot) => {
      findFact(snapshot, "check")
        .candidateEvent.occurredAt =
        "2099-01-01T00:00:00.000Z";
    },
    (snapshot) => {
      findFact(snapshot, "pull_request")
        .candidateEvent.eventId = "github:forged-pr";
    },
    (snapshot) => {
      findFact(snapshot, "check")
        .candidateEvent.eventId = "github:forged-check";
    },
    (snapshot) => {
      findFact(snapshot, "check")
        .candidateEvent.payload.evidenceId =
        "check-forged";
    }
  ];

  for (const mutate of deliveryMutations) {
    const snapshot = createGitHubDeliverySnapshot();
    mutate(snapshot);
    assert.throws(
      () =>
        previewSnapshotImport({
          snapshot,
          workflow: createRunningWorkflow(),
          importPolicy: createImportPolicy({
            objectTypes: [
              "check",
              "issue",
              "pull_request"
            ]
          })
        }),
      hasCode("SNAPSHOT_INVALID")
    );
  }

  const githubIssue = createGitHubIssueSnapshot();
  githubIssue.facts[0].candidateEvent.eventId =
    "github:forged-issue";
  assert.throws(
    () =>
      previewSnapshotImport({
        snapshot: githubIssue,
        workflow: createWorkflow(),
        importPolicy: createImportPolicy()
      }),
    hasCode("SNAPSHOT_INVALID")
  );

  const linearIssue = createLinearIssueSnapshot();
  linearIssue.facts[0].candidateEvent.eventId =
    "linear:forged-issue";
  assert.throws(
    () =>
      previewSnapshotImport({
        snapshot: linearIssue,
        workflow: createWorkflow(),
        importPolicy: createLinearImportPolicy()
      }),
    hasCode("SNAPSHOT_INVALID")
  );
});

test("legacy provider links are baselined before their first managed update", () => {
  const legacySnapshot = createGitHubIssueSnapshot({
    title: "Legacy issue title",
    revisionId: "2026-07-26T08:00:00.000Z",
    revisionOccurredAt: "2026-07-26T08:00:00.000Z"
  });
  const workflow = applyEvent(
    createWorkflow(),
    legacySnapshot.facts[0].candidateEvent
  );
  const currentSnapshot = createGitHubIssueSnapshot({
    title: "Current issue title",
    revisionId: "2026-07-26T08:02:00.000Z",
    revisionOccurredAt: "2026-07-26T08:02:00.000Z"
  });
  const plan = previewSnapshotImport({
    snapshot: currentSnapshot,
    workflow,
    importPolicy: createImportPolicy()
  });

  assert.deepEqual(plan.summary, {
    create: 0,
    link: 0,
    refresh: 1,
    update: 1,
    skip: 0,
    conflict: 0
  });
  assert.equal(
    required(plan.events[0]).payload.expectedRevisionId,
    null
  );
  assert.deepEqual(required(plan.events[0]).payload.baseline, {
    providerObjectKey: "github:issue:501",
    objectType: "issue",
    scopeRef: {
      kind: "repository",
      key: "github:repository:netpilot-z/taskseal"
    },
    managedFields: ["title"]
  });

  const projected = plan.events.reduce(applyEvent, workflow);
  const projectedWorkItem = required(
    projected.workItems["TS-1"]
  );
  assert.equal(
    projectedWorkItem.title,
    "Current issue title"
  );
  assert.equal(
    required(projectedWorkItem.externalLinks[0]).legacy,
    undefined
  );
});

test("ambiguous duplicate legacy ownership fails closed during preview", () => {
  const firstSnapshot = createGitHubIssueSnapshot({
    workItemId: "TS-1"
  });
  const secondSnapshot = createGitHubIssueSnapshot({
    workItemId: "TS-2"
  });
  const secondEvent = {
    ...secondSnapshot.facts[0].candidateEvent,
    eventId: "github:issue-501:created-again"
  };
  const workflow = [
    firstSnapshot.facts[0].candidateEvent,
    secondEvent
  ].reduce(applyEvent, createWorkflow());
  const plan = previewSnapshotImport({
    snapshot: secondSnapshot,
    workflow,
    importPolicy: createImportPolicy()
  });

  assert.equal(plan.summary.conflict, 1);
  assert.equal(
    required(plan.conflicts[0]).code,
    "PROVIDER_OBJECT_ALREADY_LINKED"
  );
  assert.deepEqual(plan.events, []);
});

test("Linear UUID facts produce the same import contract as GitHub issues", () => {
  const snapshot = createLinearIssueSnapshot();
  const plan = previewSnapshotImport({
    snapshot,
    workflow: createWorkflow(),
    importPolicy: createLinearImportPolicy()
  });

  assert.equal(plan.summary.create, 1);
  const linearEvent = required(plan.events[0]);
  const linearLink = requireRecord(
    linearEvent.payload.externalLink
  );
  assert.deepEqual(
    linearLink.scopeRef,
    snapshot.scope
  );
  assert.equal(
    linearLink.providerObjectKey,
    "linear:issue:11111111-1111-4111-8111-111111111111"
  );
});

test("Linear v2 facts canonicalize uppercase UUIDs before preview", () => {
  const externalId =
    "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  const fact = normalizeLinearIssueFact(
    {
      id: externalId,
      identifier: "NP-1",
      title: "Canonicalize Linear identity",
      url:
        "https://linear.app/taskseal/issue/NP-1/canonicalize-linear-identity",
      createdAt: "2026-07-26T08:00:00.000Z",
      updatedAt: "2026-07-26T08:01:00.000Z"
    },
    {
      workItemId: "TS-1",
      requiredEvidence: ["tests"]
    }
  );
  const snapshot = {
    ...createLinearIssueSnapshot(),
    facts: [fact]
  };
  const plan = previewSnapshotImport({
    snapshot,
    workflow: createWorkflow(),
    importPolicy: createLinearImportPolicy()
  });
  const canonicalId = externalId.toLowerCase();

  assert.equal(plan.summary.create, 1);
  assert.equal(
    fact.candidateEvent.eventId,
    `linear:${canonicalId}:created`
  );
  assert.equal(
    fact.candidateEvent.payload.externalLink.externalId,
    canonicalId
  );
});

test("preview can be reviewed while apply capability remains disabled", () => {
  const importPolicy = createImportPolicy({
    applyAllowed: false
  });
  const plan = previewSnapshotImport({
    snapshot: createGitHubIssueSnapshot(),
    workflow: createWorkflow(),
    importPolicy
  });

  assert.equal(plan.policyBinding.applyAllowed, false);
  assert.equal(plan.summary.create, 1);
  assert.equal(plan.conflicts.length, 0);
});

test("snapshot validation rejects semantic tampering, unsafe URLs, and unknown fields", () => {
  const unknownField = {
    ...createGitHubIssueSnapshot(),
    token: "must-not-be-returned"
  };
  const tampered = createGitHubIssueSnapshot();
  tampered.facts[0].observed.title = "Tampered title";
  const unsafeUrl = createGitHubIssueSnapshot();
  unsafeUrl.facts[0].sourceObject.url =
    "https://user:secret@github.com/netpilot-z/TaskSeal/issues/1?token=secret";
  unsafeUrl.facts[0].candidateEvent.payload.externalLink.url =
    unsafeUrl.facts[0].sourceObject.url;
  unsafeUrl.facts[0].revision.contentDigest =
    digestProviderFactContent(unsafeUrl.facts[0]);
  const unknownCandidate = createGitHubIssueSnapshot();
  const validUnknownCandidateFact =
    unknownCandidate.facts[0];
  const invalidUnknownCandidate: unknown = {
    ...unknownCandidate,
    facts: [
      {
        ...validUnknownCandidateFact,
        candidateEvent: {
          ...validUnknownCandidateFact.candidateEvent,
          type: "acceptance.decided"
        }
      }
    ]
  };

  for (const snapshot of [
    unknownField,
    tampered,
    unsafeUrl,
    invalidUnknownCandidate
  ]) {
    assert.throws(
      () =>
        previewSnapshotImport({
          snapshot,
          workflow: createWorkflow(),
          importPolicy: createImportPolicy()
        }),
      isSafeSnapshotInvalid
    );
  }
});

test("snapshot validation enforces fact, depth, field, string, and title limits", () => {
  const tooManyFacts: ProviderSnapshotV2 =
    createGitHubIssueSnapshot();
  tooManyFacts.facts = Array.from(
    { length: 101 },
    () =>
      structuredClone(
        required(tooManyFacts.facts[0])
      )
  );
  let tooDeep: unknown = "leaf";

  for (let index = 0; index < 17; index += 1) {
    tooDeep = { child: tooDeep };
  }

  const excessiveDepth = {
    ...createGitHubIssueSnapshot(),
    extra: tooDeep
  };
  const excessiveFields = {
    ...createGitHubIssueSnapshot(),
    extra: Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [
        `field${index}`,
        index
      ])
    )
  };
  const excessiveString = {
    ...createGitHubIssueSnapshot(),
    extra: "x".repeat(4097)
  };
  const excessiveTitle = createGitHubIssueSnapshot({
    title: "😀".repeat(513)
  });

  for (const snapshot of [
    tooManyFacts,
    excessiveDepth,
    excessiveFields,
    excessiveString
  ]) {
    assert.throws(
      () =>
        previewSnapshotImport({
          snapshot,
          workflow: createWorkflow(),
          importPolicy: createImportPolicy()
        }),
      hasCode("SNAPSHOT_LIMIT_EXCEEDED")
    );
  }

  assert.throws(
    () =>
      previewSnapshotImport({
        snapshot: excessiveTitle,
        workflow: createWorkflow(),
        importPolicy: createImportPolicy()
      }),
    hasCode("SNAPSHOT_INVALID")
  );
});

interface GitHubIssueSnapshotOptions {
  workItemId?: string | undefined;
  title?: string | undefined;
  requiredEvidence?: string[] | undefined;
  managedFields?: ManagedField[] | undefined;
  revisionId?: string | undefined;
  revisionOccurredAt?: string | undefined;
}

interface GitHubIssueSnapshot
  extends Omit<
    ProviderSnapshotV2,
    "provider" | "facts"
  > {
  provider: "github";
  facts: [ProviderIssueFact];
}

interface LinearIssueSnapshot
  extends Omit<
    ProviderSnapshotV2,
    "provider" | "facts"
  > {
  provider: "linear";
  facts: [ProviderIssueFact];
}

function createGitHubIssueSnapshot({
  workItemId = "TS-1",
  title = "Import provider facts safely",
  requiredEvidence = ["tests"],
  managedFields = ["title"],
  revisionId = "2026-07-26T08:01:00.000Z",
  revisionOccurredAt = "2026-07-26T08:01:00.000Z"
}: GitHubIssueSnapshotOptions = {}): GitHubIssueSnapshot {
  const candidateEvent:
    ProviderIssueFact["candidateEvent"] = {
    eventId: "github:issue-501:created",
    workItemId,
    type: "work_item.created",
    occurredAt: "2026-07-26T08:00:00.000Z",
    payload: {
      title,
      requiredEvidence: [...requiredEvidence],
      externalLink: {
        provider: "github",
        externalId: "501",
        url: "https://github.com/netpilot-z/TaskSeal/issues/1"
      }
    }
  };
  const sourceObject:
    ProviderIssueFact["sourceObject"] = {
      providerObjectKey: "github:issue:501",
      provider: "github",
      objectType: "issue",
      externalId: "501",
      url: "https://github.com/netpilot-z/TaskSeal/issues/1"
    };
  const observed: ProviderIssueFact["observed"] = {
    title,
    createdAt: "2026-07-26T08:00:00.000Z"
  };
  const fact: ProviderIssueFact = {
    sourceObject,
    revision: {
      id: revisionId,
      occurredAt: revisionOccurredAt,
      contentDigest: digestProviderFactContent({
        sourceObject,
        observed
      })
    },
    observed,
    candidateEvent
  };

  return {
    schemaVersion: 2,
    mode: "read-only",
    provider: "github",
    scope: {
      kind: "repository",
      key: "github:repository:netpilot-z/taskseal"
    },
    mapping: {
      workItemId,
      requiredEvidence: [...requiredEvidence],
      managedFields: [...managedFields]
    },
    capturedAt: "2026-07-26T08:01:01.000Z",
    facts: [fact]
  };
}

function createLinearIssueSnapshot(): LinearIssueSnapshot {
  const externalId =
    "11111111-1111-4111-8111-111111111111";
  const title = "Import a Linear issue safely";
  const candidateEvent:
    ProviderIssueFact["candidateEvent"] = {
    eventId: `linear:${externalId}:created`,
    workItemId: "TS-1",
    type: "work_item.created",
    occurredAt: "2026-07-26T08:00:00.000Z",
    payload: {
      title,
      requiredEvidence: ["tests"],
      externalLink: {
        provider: "linear",
        externalId,
        url: "https://linear.app/taskseal/issue/NET-7/example"
      }
    }
  };
  const sourceObject:
    ProviderIssueFact["sourceObject"] = {
      providerObjectKey: `linear:issue:${externalId}`,
      provider: "linear",
      objectType: "issue",
      externalId,
      url: "https://linear.app/taskseal/issue/NET-7/example"
    };
  const observed: ProviderIssueFact["observed"] = {
    title,
    createdAt: "2026-07-26T08:00:00.000Z"
  };
  const fact: ProviderIssueFact = {
    sourceObject,
    revision: {
      id: "2026-07-26T08:01:00.000Z",
      occurredAt: "2026-07-26T08:01:00.000Z",
      contentDigest: digestProviderFactContent({
        sourceObject,
        observed
      })
    },
    observed,
    candidateEvent
  };

  return {
    schemaVersion: 2,
    mode: "read-only",
    provider: "linear",
    scope: {
      kind: "team",
      key:
        "linear:team:22222222-2222-4222-8222-222222222222",
      parentKey:
        "linear:organization:33333333-3333-4333-8333-333333333333"
    },
    mapping: {
      workItemId: "TS-1",
      requiredEvidence: ["tests"],
      managedFields: ["title"]
    },
    capturedAt: "2026-07-26T08:01:01.000Z",
    facts: [fact]
  };
}

function createGitHubDeliverySnapshot({
  includeIssue = true,
  includeCheck = true
}: {
  includeIssue?: boolean | undefined;
  includeCheck?: boolean | undefined;
} = {}): ProviderSnapshotV2 {
  const issueSnapshot = createGitHubIssueSnapshot({
    managedFields: []
  });
  const pullRequestFact = createPullRequestFact({
    sourceObject: {
      providerObjectKey: "github:pull_request:601",
      provider: "github",
      objectType: "pull_request",
      externalId: "601",
      url: "https://github.com/netpilot-z/TaskSeal/pull/2"
    },
    revisionId: "2026-07-26T08:03:00.000Z",
    revisionOccurredAt: "2026-07-26T08:03:00.000Z",
    observed: {
      headRevision: "abc123"
    },
    candidateEvent: {
      eventId:
        "github:pr-601:abc123:2026-07-26T08:03:00.000Z",
      workItemId: "TS-1",
      type: "artifact.linked",
      occurredAt: "2026-07-26T08:03:00.000Z",
      payload: {
        artifactId: "pr-601",
        attemptId: "run-1",
        kind: "pull_request",
        revision: "abc123",
        url: "https://github.com/netpilot-z/TaskSeal/pull/2"
      }
    }
  });
  const checkFact = createCheckFact({
    sourceObject: {
      providerObjectKey: "github:check:701",
      provider: "github",
      objectType: "check",
      externalId: "701",
      url:
        "https://github.com/netpilot-z/TaskSeal/actions/runs/7"
    },
    revisionId: "2026-07-26T08:04:00.000Z",
    revisionOccurredAt: "2026-07-26T08:04:00.000Z",
    observed: {
      headRevision: "abc123",
      outcome: "passed"
    },
    candidateEvent: {
      eventId: "github:check-701:abc123",
      workItemId: "TS-1",
      type: "evidence.recorded",
      occurredAt: "2026-07-26T08:04:00.000Z",
      payload: {
        evidenceId: "check-701",
        attemptId: "run-1",
        artifactId: "pr-601",
        revision: "abc123",
        criterionKey: "tests",
        outcome: "passed",
        url:
          "https://github.com/netpilot-z/TaskSeal/actions/runs/7"
      }
    }
  });
  const facts = [
    ...(includeIssue ? issueSnapshot.facts : []),
    pullRequestFact,
    ...(includeCheck ? [checkFact] : [])
  ];

  return {
    ...issueSnapshot,
    mapping: {
      ...issueSnapshot.mapping,
      attemptId: "run-1",
      artifactId: "pr-601",
      artifactRevision: "abc123",
      criterionKey: "tests"
    },
    facts
  };
}

function createPullRequestFact({
  sourceObject,
  revisionId,
  revisionOccurredAt,
  observed,
  candidateEvent
}: {
  sourceObject:
    ProviderPullRequestFact["sourceObject"];
  revisionId: string;
  revisionOccurredAt: string;
  observed: ProviderPullRequestFact["observed"];
  candidateEvent:
    ProviderPullRequestFact["candidateEvent"];
}): ProviderPullRequestFact {
  return {
    sourceObject,
    revision: {
      id: revisionId,
      occurredAt: revisionOccurredAt,
      contentDigest: digestProviderFactContent({
        sourceObject,
        observed
      })
    },
    observed,
    candidateEvent
  };
}

function createCheckFact({
  sourceObject,
  revisionId,
  revisionOccurredAt,
  observed,
  candidateEvent
}: {
  sourceObject: ProviderCheckFact["sourceObject"];
  revisionId: string;
  revisionOccurredAt: string;
  observed: ProviderCheckFact["observed"];
  candidateEvent: ProviderCheckFact["candidateEvent"];
}): ProviderCheckFact {
  return {
    sourceObject,
    revision: {
      id: revisionId,
      occurredAt: revisionOccurredAt,
      contentDigest: digestProviderFactContent({
        sourceObject,
        observed
      })
    },
    observed,
    candidateEvent
  };
}

function findFact(
  snapshot: ProviderSnapshotV2,
  objectType: "issue"
): ProviderIssueFact;
function findFact(
  snapshot: ProviderSnapshotV2,
  objectType: "pull_request"
): ProviderPullRequestFact;
function findFact(
  snapshot: ProviderSnapshotV2,
  objectType: "check"
): ProviderCheckFact;
function findFact(
  snapshot: ProviderSnapshotV2,
  objectType: ProviderObjectType
): ProviderFact {
  const fact = snapshot.facts.find(
    (fact) => fact.sourceObject.objectType === objectType
  );

  return required(fact, `${objectType} fact`);
}

function createRunningWorkflow(): Workflow {
  const created = applyEvent(
    createWorkflow(),
    createLocalWorkItemEvent()
  );

  const started: AttemptStartedEvent = {
    eventId: "codex:run-1:started",
    workItemId: "TS-1",
    type: "attempt.started",
    occurredAt: "2026-07-26T08:00:30.000Z",
    payload: {
      attemptId: "run-1",
      agentId: "codex"
    }
  };
  return applyEvent(created, started);
}

function createLocalWorkItemEvent(): WorkItemCreatedEvent {
  return {
    eventId: "taskseal:TS-1:created",
    workItemId: "TS-1",
    type: "work_item.created",
    occurredAt: "2026-07-26T08:00:00.000Z",
    payload: {
      title: "Import provider facts safely",
      requiredEvidence: ["tests"],
      externalLink: {
        provider: "taskseal",
        externalId: "TS-1",
        url: "http://127.0.0.1:4317/work-items/TS-1"
      }
    }
  };
}

function createImportPolicy({
  objectTypes = ["issue"],
  applyAllowed = true
}: {
  objectTypes?: ProviderObjectType[] | undefined;
  applyAllowed?: boolean | undefined;
} = {}): NormalizedImportPolicy {
  return {
    schemaVersion: 2,
    allowedScopes: [
      {
        provider: "github",
        scopeRef: {
          kind: "repository",
          key: "github:repository:netpilot-z/taskseal"
        },
        objectTypes,
        capabilities: {
          "snapshot.import.preview": true,
          "snapshot.import.apply": applyAllowed
        }
      }
    ]
  };
}

function createLinearImportPolicy():
  NormalizedImportPolicy {
  return {
    schemaVersion: 2,
    allowedScopes: [
      {
        provider: "linear",
        scopeRef: {
          kind: "team",
          key:
            "linear:team:22222222-2222-4222-8222-222222222222",
          parentKey:
            "linear:organization:33333333-3333-4333-8333-333333333333"
        },
        objectTypes: ["issue"],
        capabilities: {
          "snapshot.import.preview": true,
          "snapshot.import.apply": true
        }
      }
    ]
  };
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}

function required<T>(
  value: T | null | undefined,
  label = "value"
): T {
  if (value === null || value === undefined) {
    throw new Error(`${label} is required.`);
  }

  return value;
}

function requireRecord(
  value: unknown
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("A record value is required.");
  }

  return value;
}

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isSafeSnapshotInvalid(
  error: unknown
): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "SNAPSHOT_INVALID" &&
    !error.message.includes("secret") &&
    !error.message.includes("must-not-be-returned")
  );
}
