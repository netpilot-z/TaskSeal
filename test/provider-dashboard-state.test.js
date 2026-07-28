import assert from "node:assert/strict";
import test from "node:test";

import {
  createProviderAccessibleSummary,
  createProviderContentRenderKey,
  createProviderPanelModel,
  createProviderPanelState,
  reduceProviderPanelState,
  shouldPollProviders
} from "../public/provider-state.js";

test("Provider panel maps all five observation states without inventing approval", () => {
  const model = createProviderPanelModel({
    schemaVersion: 1,
    revision: digest("f"),
    providers: [
      observation({
        provider: "github",
        status: "configured"
      }),
      observation({
        provider: "linear",
        status: "scope_mismatch",
        observedScope: {
          kind: "team",
          key:
            "linear:team:11111111-1111-4111-8111-111111111111",
          parentKey:
            "linear:organization:22222222-2222-4222-8222-222222222222"
        },
        diagnosticCode:
          "PROVIDER_OBSERVATION_SCOPE_MISMATCH"
      }),
      observation({
        provider: "gitee",
        status: "sample_missing",
        diagnosticCode: "GITEE_NOT_FOUND"
      }),
      observation({
        provider: "linear",
        status: "snapshot_ready",
        configuredTarget: {
          kind: "team",
          key:
            "linear:team-ref:netpilot-z/platform"
        },
        operation: "snapshot.preview",
        planDigest: digest("a"),
        snapshotDigest: digest("b"),
        mappingDigest: digest("c"),
        missingEvidence: ["tests"]
      }),
      observation({
        provider: "github",
        status: "sync_failed",
        configuredTarget: {
          kind: "repository",
          key:
            "github:repository:netpilot-z/control-room"
        },
        operation: "snapshot.import",
        diagnosticCode: "IMPORT_PLAN_STALE"
      })
    ]
  });

  assert.deepEqual(
    model.cards.map((card) => [
      card.status,
      card.statusLabel,
      card.statusIcon
    ]),
    [
      ["configured", "Configured", "○"],
      ["scope_mismatch", "Scope mismatch", "!"],
      ["sample_missing", "Sample missing", "?"],
      ["snapshot_ready", "Snapshot ready", "✓"],
      ["sync_failed", "Sync failed", "×"]
    ]
  );
  assert.deepEqual(model.summary, {
    total: 5,
    ready: 1,
    attention: 4,
    operations: 0,
    approvalRequired: 0,
    uncertain: 0,
    syncFailed: 0
  });
  assert.equal(
    model.cards[3]?.approvalLabel,
    "Operation journal not connected"
  );
});

test("Provider panel v2 maps every controlled operation state without mixing observation status", () => {
  const statuses = [
    "approval_required",
    "approved",
    "rejected",
    "submitting",
    "created",
    "outcome_unknown",
    "reconciling",
    "reconciliation_absent",
    "reconciled",
    "sync_failed"
  ];
  const model = createProviderPanelModel({
    schemaVersion: 2,
    revision: digest("f"),
    observationRevision: digest("e"),
    operationRevision: digest("d"),
    providers: [
      observation({
        provider: "linear",
        status: "snapshot_ready",
        snapshotDigest: digest("b"),
        mappingDigest: digest("c")
      })
    ],
    operations: statuses.map(
      (status, index) =>
        controlledOperation({
          status,
          operationKey: digest(
            index.toString(16)
          ),
          version: index + 1,
          updatedAt:
            `2026-07-27T10:00:${String(
              index
            ).padStart(2, "0")}.000Z`
        })
    )
  });

  assert.equal(model.cards[0]?.status, "snapshot_ready");
  assert.equal(
    model.cards[0]?.controlledOperations.length,
    10
  );
  assert.equal(
    model.cards[0]?.approvalLabel,
    "Outcome unknown"
  );
  assert.deepEqual(
    Object.fromEntries(
      model.operations.map((operation) => [
        operation.status,
        [
          operation.statusLabel,
          operation.tone
        ]
      ])
    ),
    {
      approval_required: [
        "Approval required",
        "warning"
      ],
      approved: ["Approved", "neutral"],
      rejected: ["Rejected", "neutral"],
      submitting: ["Submitting", "active"],
      created: ["Created", "ready"],
      outcome_unknown: [
        "Outcome unknown",
        "danger"
      ],
      reconciling: ["Reconciling", "active"],
      reconciliation_absent: [
        "Not found; decision required",
        "warning"
      ],
      reconciled: [
        "Reconciled",
        "ready"
      ],
      sync_failed: ["Sync failed", "danger"]
    }
  );
  assert.deepEqual(model.summary, {
    total: 1,
    ready: 1,
    attention: 0,
    operations: 10,
    approvalRequired: 1,
    uncertain: 2,
    syncFailed: 1
  });
  assert.equal(
    JSON.stringify(model).includes(
      "SECRET_ACTOR"
    ),
    false
  );
});

test("Provider panel treats operation-only v2 content as ready and accessible", () => {
  const model = createProviderPanelModel({
    schemaVersion: 2,
    revision: digest("f"),
    observationRevision: digest("e"),
    operationRevision: digest("d"),
    providers: [],
    operations: [
      controlledOperation({
        status: "approval_required"
      })
    ]
  });
  const ready = reduceProviderPanelState(
    createProviderPanelState(),
    {
      type: "success",
      model
    }
  );

  assert.equal(ready.phase, "ready");
  assert.equal(model.cards.length, 0);
  assert.equal(model.operations.length, 1);
  assert.equal(
    createProviderContentRenderKey(ready),
    `provider-status:${digest("f")}`
  );
  assert.match(
    createProviderAccessibleSummary(ready),
    /1 controlled operations/
  );
  assert.match(
    createProviderAccessibleSummary(ready),
    /1 require approval/
  );
});

test("Provider panel keeps only validated safe projection fields and sorts latest observations", () => {
  const older = observation({
    provider: "github",
    observedAt: "2026-07-27T09:00:00.000Z",
    startedAt: "2026-07-27T09:00:00.000Z"
  });
  const newer = observation({
    provider: "linear",
    observedAt: "2026-07-27T10:00:00.000Z",
    startedAt: "2026-07-27T10:00:00.000Z",
    sourceRevisions: [
      {
        objectType: "issue",
        id: "revision-1",
        occurredAt: "2026-07-27T09:59:00.000Z",
        contentDigest: digest("d")
      }
    ]
  });
  const model = createProviderPanelModel({
    schemaVersion: 1,
    revision: digest("e"),
    providers: [older, newer]
  });

  assert.deepEqual(
    model.latest.map((card) => card.provider),
    ["linear", "github"]
  );
  assert.equal(model.cards[1]?.sourceRevisionCount, 1);
  assert.equal("rawPayload" in model.cards[1], false);
});

test("Provider panel state covers loading, empty, first error, and stale last-known data", () => {
  const initial = createProviderPanelState();
  const loading = reduceProviderPanelState(initial, {
    type: "request"
  });
  const firstError = reduceProviderPanelState(loading, {
    type: "failure"
  });
  const emptyModel = createProviderPanelModel({
    schemaVersion: 1,
    revision: digest("0"),
    providers: []
  });
  const empty = reduceProviderPanelState(loading, {
    type: "success",
    model: emptyModel
  });
  const refreshingEmpty = reduceProviderPanelState(empty, {
    type: "request"
  });
  const staleEmpty = reduceProviderPanelState(
    refreshingEmpty,
    { type: "failure" }
  );
  const readyModel = createProviderPanelModel({
    schemaVersion: 1,
    revision: digest("1"),
    providers: [observation()]
  });
  const ready = reduceProviderPanelState(loading, {
    type: "success",
    model: readyModel
  });
  const refreshing = reduceProviderPanelState(ready, {
    type: "request"
  });
  const stale = reduceProviderPanelState(refreshing, {
    type: "failure"
  });
  const recovered = reduceProviderPanelState(stale, {
    type: "success",
    model: readyModel
  });

  assert.equal(loading.phase, "loading");
  assert.equal(firstError.phase, "error");
  assert.equal(empty.phase, "empty");
  assert.equal(refreshingEmpty.phase, "refreshing");
  assert.equal(staleEmpty.phase, "stale");
  assert.equal(staleEmpty.model, emptyModel);
  assert.equal(ready.phase, "ready");
  assert.equal(refreshing.phase, "refreshing");
  assert.equal(stale.phase, "stale");
  assert.equal(stale.model, readyModel);
  assert.equal(recovered.phase, "ready");
  assert.equal(recovered.message, null);
});

test("Provider panel rejects source-local version regression and keeps the complete last-known v2 model", () => {
  const currentModel = createProviderPanelModel({
    schemaVersion: 2,
    revision: digest("1"),
    observationRevision: digest("2"),
    operationRevision: digest("3"),
    providers: [
      observation({
        provider: "linear",
        startedAt:
          "2026-07-27T10:00:00.000Z",
        observedAt:
          "2026-07-27T10:00:00.000Z"
      })
    ],
    operations: [
      controlledOperation({
        version: 4,
        status: "outcome_unknown"
      })
    ]
  });
  const ready = reduceProviderPanelState(
    createProviderPanelState(),
    {
      type: "success",
      model: currentModel
    }
  );
  const regressions = [
    {
      schemaVersion: 2,
      revision: digest("4"),
      observationRevision: digest("2"),
      operationRevision: digest("4"),
      providers: [
        observation({
          provider: "linear",
          startedAt:
            "2026-07-27T10:00:00.000Z",
          observedAt:
            "2026-07-27T10:00:00.000Z"
        })
      ],
      operations: [
        controlledOperation({
          version: 3,
          status: "submitting"
        })
      ]
    },
    {
      schemaVersion: 2,
      revision: digest("5"),
      observationRevision: digest("2"),
      operationRevision: digest("5"),
      providers: [
        observation({
          provider: "linear",
          startedAt:
            "2026-07-27T10:00:00.000Z",
          observedAt:
            "2026-07-27T10:00:00.000Z"
        })
      ],
      operations: []
    },
    {
      schemaVersion: 2,
      revision: digest("7"),
      observationRevision: digest("7"),
      operationRevision: digest("3"),
      providers: [
        observation({
          provider: "linear",
          startedAt:
            "2026-07-27T09:59:59.000Z",
          observedAt:
            "2026-07-27T09:59:59.000Z"
        })
      ],
      operations: [
        controlledOperation({
          version: 4,
          status: "outcome_unknown"
        })
      ]
    },
    {
      schemaVersion: 2,
      revision: digest("8"),
      observationRevision: digest("8"),
      operationRevision: digest("3"),
      providers: [
        observation({
          provider: "linear",
          status: "sample_missing",
          diagnosticCode:
            "LINEAR_ISSUE_NOT_FOUND",
          startedAt:
            "2026-07-27T10:00:00.000Z",
          observedAt:
            "2026-07-27T10:00:00.000Z"
        })
      ],
      operations: [
        controlledOperation({
          version: 4,
          status: "outcome_unknown"
        })
      ]
    },
    {
      schemaVersion: 2,
      revision: digest("9"),
      observationRevision: digest("2"),
      operationRevision: digest("9"),
      providers: [
        observation({
          provider: "linear",
          startedAt:
            "2026-07-27T10:00:00.000Z",
          observedAt:
            "2026-07-27T10:00:00.000Z"
        })
      ],
      operations: [
        controlledOperation({
          version: 4,
          status: "reconciliation_absent"
        })
      ]
    },
    {
      schemaVersion: 1,
      revision: digest("6"),
      providers: [
        observation({
          provider: "linear"
        })
      ]
    }
  ];

  for (const projection of regressions) {
    const incoming =
      createProviderPanelModel(projection);
    const stale = reduceProviderPanelState(
      ready,
      {
        type: "success",
        model: incoming
      }
    );
    assert.equal(stale.phase, "stale");
    assert.equal(stale.model, currentModel);
    assert.match(stale.message, /older/i);
  }
});

test("Provider panel accepts semantically identical observations with reordered JSON fields", () => {
  const value = observation({
    provider: "linear"
  });
  const reordered = {
    status: value.status,
    provider: value.provider,
    schemaVersion: value.schemaVersion,
    configuredTarget: value.configuredTarget,
    observationId: value.observationId,
    operation: value.operation,
    observedScope: value.observedScope,
    observedAt: value.observedAt,
    startedAt: value.startedAt,
    sourceRevisions: value.sourceRevisions,
    mappingDigest: value.mappingDigest,
    snapshotDigest: value.snapshotDigest,
    missingEvidence: value.missingEvidence,
    diagnosticCode: value.diagnosticCode,
    planDigest: value.planDigest,
    resolution: value.resolution
  };
  assert.deepEqual(reordered, value);

  const current = createProviderPanelModel({
    schemaVersion: 2,
    revision: digest("1"),
    observationRevision: digest("2"),
    operationRevision: digest("3"),
    providers: [value],
    operations: []
  });
  const incoming = createProviderPanelModel({
    schemaVersion: 2,
    revision: digest("1"),
    observationRevision: digest("2"),
    operationRevision: digest("3"),
    providers: [reordered],
    operations: []
  });
  const ready = reduceProviderPanelState(
    createProviderPanelState(),
    {
      type: "success",
      model: current
    }
  );
  const refreshed = reduceProviderPanelState(
    ready,
    {
      type: "success",
      model: incoming
    }
  );

  assert.equal(refreshed.phase, "ready");
  assert.equal(refreshed.model, incoming);
});

test("Provider content render key preserves interactive DOM across same-revision refreshes", () => {
  const model = createProviderPanelModel({
    schemaVersion: 1,
    revision: digest("9"),
    providers: [observation()]
  });
  const ready = reduceProviderPanelState(
    createProviderPanelState(),
    { type: "success", model }
  );
  const refreshing = reduceProviderPanelState(ready, {
    type: "request"
  });
  const stale = reduceProviderPanelState(refreshing, {
    type: "failure"
  });

  assert.equal(
    createProviderContentRenderKey(ready),
    createProviderContentRenderKey(refreshing)
  );
  assert.equal(
    createProviderContentRenderKey(ready),
    createProviderContentRenderKey(stale)
  );
});

test("Provider polling starts only for an idle persistent panel", () => {
  assert.equal(
    shouldPollProviders("persistent", "ready"),
    true
  );
  assert.equal(
    shouldPollProviders("persistent", "stale"),
    true
  );
  assert.equal(
    shouldPollProviders("persistent", "loading"),
    false
  );
  assert.equal(
    shouldPollProviders("persistent", "refreshing"),
    false
  );
  assert.equal(shouldPollProviders("demo", "ready"), false);
  assert.equal(shouldPollProviders(null, "idle"), false);
});

test("Provider panel accessible summary changes with status, missing evidence, and stale refresh", () => {
  const model = createProviderPanelModel({
    schemaVersion: 1,
    revision: digest("2"),
    providers: [
      observation({
        provider: "linear",
        status: "snapshot_ready",
        snapshotDigest: digest("5"),
        mappingDigest: digest("6"),
        missingEvidence: ["tests", "security-review"]
      })
    ]
  });
  const ready = reduceProviderPanelState(
    createProviderPanelState(),
    {
      type: "success",
      model
    }
  );
  const stale = reduceProviderPanelState(ready, {
    type: "failure"
  });

  assert.match(
    createProviderAccessibleSummary(ready),
    /Linear is Snapshot ready/
  );
  assert.match(
    createProviderAccessibleSummary(ready),
    /missing evidence: tests, security-review/
  );
  assert.match(
    createProviderAccessibleSummary(stale),
    /showing the last known observations/
  );
});

test("Provider panel rejects malformed or unknown observation projections", () => {
  assert.throws(
    () =>
      createProviderPanelModel({
        schemaVersion: 1,
        revision: digest("3"),
        providers: [
          {
            ...observation(),
            status: "approval_required"
          }
        ]
      }),
    /projection is invalid/
  );
  assert.throws(
    () =>
      createProviderPanelModel({
        schemaVersion: 1,
        revision: digest("4"),
        providers: [
          {
            ...observation(),
            missingEvidence: "tests"
          }
        ]
      }),
    /projection is invalid/
  );
  assert.throws(
    () =>
      createProviderPanelModel({
        schemaVersion: 1,
        revision: digest("7"),
        providers: [
          observation(),
          observation({
            configuredTarget: {
              kind: "provider",
              key: "github:repository:netpilot-z/taskseal"
            }
          })
        ]
      }),
    /projection is invalid/
  );
});

test("Provider panel accepts project and state controlled-operation targets", () => {
  const operation = controlledOperation({
    configuredTarget: {
      kind: "project_state",
      key:
        "linear:project-state-ref:netpilot-z/netpilot/TaskSeal/Todo"
    }
  });
  const model = createProviderPanelModel({
    schemaVersion: 2,
    revision: digest("1"),
    observationRevision: digest("3"),
    operationRevision: digest("2"),
    providers: [],
    operations: [operation]
  });

  assert.deepEqual(
    model.operations[0]?.configuredTarget,
    operation.configuredTarget
  );
});

test("Provider panel rejects malformed, duplicate, and semantically inconsistent operations", () => {
  const valid = controlledOperation();
  const invalidCases = [
    {
      ...valid,
      status: "unknown"
    },
    {
      ...valid,
      version: 0
    },
    {
      ...valid,
      rawPayload: "SECRET"
    },
    {
      ...valid,
      status: "rejected",
      approval: {
        decision: "approved",
        decidedAt:
          "2026-07-27T10:00:01.000Z"
      }
    },
    {
      ...valid,
      status: "sync_failed",
      diagnosticCode: null
    },
    {
      ...valid,
      configuredTarget: {
        kind: "team",
        key: "linear:not-a-team-ref"
      }
    },
    {
      ...valid,
      configuredTarget: {
        kind: "project_state",
        key:
          "linear:project-state-ref:netpilot-z/netpilot/TaskSeal"
      }
    }
  ];

  for (const operation of invalidCases) {
    assert.throws(
      () =>
        createProviderPanelModel({
          schemaVersion: 2,
          revision: digest("1"),
          observationRevision: digest("2"),
          operationRevision: digest("3"),
          providers: [],
          operations: [operation]
        }),
      /projection is invalid/
    );
  }

  assert.throws(
    () =>
      createProviderPanelModel({
        schemaVersion: 2,
        revision: digest("1"),
        observationRevision: digest("2"),
        operationRevision: digest("3"),
        providers: [],
        operations: [valid, valid]
      }),
    /projection is invalid/
  );
  assert.throws(
    () =>
      createProviderPanelModel({
        schemaVersion: 2,
        revision: digest("8"),
        observationRevision: digest("9"),
        operationRevision: null,
        providers: [],
        operations: []
      }),
    /projection is invalid/
  );
});

test("Provider panel fails closed for unsafe diagnostics and inconsistent observation semantics", () => {
  const unsafeCases = [
    {
      diagnosticCode:
        "Bearer SECRET: upstream error body",
      status: "sync_failed"
    },
    {
      diagnosticCode: "IMPORT_PLAN_STALE",
      status: "snapshot_ready"
    },
    {
      diagnosticCode: null,
      status: "sync_failed"
    },
    {
      operation: "configuration",
      resolution: "committed"
    },
    {
      observedAt: "2026-07-27T09:59:59.000Z"
    },
    {
      observedAt: "2099-07-27T10:00:00.000Z"
    },
    {
      observedAt: "July 27, 2026 10:00:00 UTC",
      startedAt: "July 27, 2026 10:00:00 UTC"
    },
    {
      status: "snapshot_ready",
      snapshotDigest: null,
      mappingDigest: null
    },
    {
      sourceRevisions: [
        {
          objectType: "issue",
          id: "revision-1",
          occurredAt: "2026-07-27T09:59:00.000Z",
          contentDigest: digest("d")
        },
        {
          objectType: "issue",
          id: "revision-1",
          occurredAt: "2026-07-27T09:59:01.000Z",
          contentDigest: digest("e")
        }
      ]
    }
  ];

  for (const unsafe of unsafeCases) {
    assert.throws(
      () =>
        createProviderPanelModel({
          schemaVersion: 1,
          revision: digest("8"),
          providers: [observation(unsafe)]
        }),
      /projection is invalid/
    );
  }
});

function observation(overrides = {}) {
  const provider = overrides.provider ?? "github";
  const target =
    provider === "linear"
      ? {
          kind: "team",
          key: "linear:team-ref:netpilot-z/netpilot"
        }
      : {
          kind: "repository",
          key:
            `${provider}:repository:` +
            (provider === "gitee"
              ? "netpilot-z/taskseal"
              : "netpilot-z/taskseal")
        };

  return {
    schemaVersion: 1,
    observationId: digest(
      provider === "github"
        ? "a"
        : provider === "linear"
          ? "b"
          : "c"
    ),
    operation: "configuration",
    provider,
    configuredTarget: target,
    observedScope: null,
    status: "configured",
    startedAt: "2026-07-27T10:00:00.000Z",
    observedAt: "2026-07-27T10:00:00.000Z",
    sourceRevisions: [],
    snapshotDigest: null,
    mappingDigest: null,
    planDigest: null,
    missingEvidence: [],
    diagnosticCode: null,
    resolution: null,
    ...overrides
  };
}

function controlledOperation(overrides = {}) {
  const status =
    overrides.status ?? "approval_required";
  const approval =
    status === "approval_required"
      ? null
      : {
          decision:
            status === "rejected"
              ? "rejected"
              : "approved",
          decidedAt:
            "2026-07-27T10:00:01.000Z"
        };
  const diagnosticCode =
    status === "sync_failed"
      ? "LINEAR_WRITE_NOT_DISPATCHED"
      : status === "outcome_unknown" ||
          status === "reconciling"
        ? "LINEAR_WRITE_OUTCOME_UNKNOWN"
        : null;

  return {
    schemaVersion: 1,
    provider: "linear",
    operationKey: digest("a"),
    configuredTarget: {
      kind: "team",
      key: "linear:team-ref:netpilot-z/netpilot"
    },
    version: 1,
    status,
    approval,
    diagnosticCode,
    createdAt:
      "2026-07-27T10:00:00.000Z",
    updatedAt:
      status === "approval_required"
        ? "2026-07-27T10:00:00.000Z"
        : "2026-07-27T10:00:01.000Z",
    ...overrides
  };
}

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}
