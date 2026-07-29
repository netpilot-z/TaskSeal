import assert from "node:assert/strict";
import test from "node:test";

import type {
  ImportBatchRecord
} from "../src/application/import-batch.ts";
import {
  computeImportPlanDigest
} from "../src/application/import-plan.ts";
import {
  createProviderIngressRegistry
} from "../src/application/provider-ingress-registry.ts";
import type {
  ProviderIngressRegistry
} from "../src/application/provider-ingress-registry.ts";
import type {
  ProviderFactProvenanceClaim,
  ProviderFactProvenanceVerifier
} from "../src/application/provider-fact-provenance.ts";
import {
  TaskSealService
} from "../src/application/taskseal-service.ts";
import type {
  EventJournal
} from "../src/application/taskseal-service.ts";
import type {
  CanonicalEvent
} from "../src/domain/workflow.ts";
import {
  applyEvent,
  createWorkflow
} from "../src/domain/workflow.ts";
import {
  createReadOnlyProviderFactProvenanceVerifier
} from "../src/connectors/provider-fact-provenance-verifier.ts";
import {
  createActor,
  createGitHubDeliverySnapshot,
  createGitHubIssueSnapshot,
  createImportPolicy,
  createLinearImportPolicy,
  createLinearIssueSnapshot,
  createPreviewPlan
} from "../test-support/snapshot-import-fixtures.ts";

const APPLIED_AT = "2026-07-28T01:00:00.000Z";

test("new GitHub and Linear applies fail closed when no provenance verifier is injected", async () => {
  const journal = new MemoryJournal();
  const service = await TaskSealService.open({
    journal,
    importPolicyProvider: createImportPolicy,
    clock: () => new Date(APPLIED_AT)
  });
  const plan = createPreviewPlan();

  await assert.rejects(
    service.applySnapshotImport({
      plan,
      expectedPlanDigest: plan.planDigest,
      actor: createActor()
    }),
    hasCode("IMPORT_PROVENANCE_UNAVAILABLE")
  );
  assert.equal(journal.commitCalls, 0);
});

test("verifies every projected claim before one atomic commit and skips verification for receipt retries", async () => {
  const journal = new MemoryJournal();
  const verifier = new RecordingVerifier();
  const service = await openService({
    journal,
    verifier
  });
  const plan = createPreviewPlan();

  const committed = await applyPlan(service, plan);
  const retried = await applyPlan(service, plan);

  assert.equal(committed.resolution, "committed");
  assert.equal(retried.resolution, "idempotent");
  assert.equal(verifier.calls.length, 1);
  assert.equal(verifier.calls[0]?.length, 1);
  assert.equal(
    verifier.calls[0]?.[0]?.providerObjectKey,
    "github:issue:501"
  );
  assert.equal(journal.commitCalls, 1);

  const reopened = await TaskSealService.open({
    journal
  });
  const replayedRetry = await applyPlan(
    reopened,
    plan
  );
  assert.deepEqual(
    reopened.getImportReceipt({
      planDigest: plan.planDigest
    }),
    committed.receipt
  );
  assert.equal(
    replayedRetry.resolution,
    "idempotent"
  );
});

test("mismatch, partial, and malformed verifier results never reach the journal", async () => {
  for (const mode of [
    "mismatch",
    "partial",
    "malformed"
  ] as const) {
    const journal = new MemoryJournal();
    const verifier = new RecordingVerifier(mode);
    const service = await openService({
      journal,
      verifier
    });
    const plan = createPreviewPlan({
      snapshot: createGitHubIssueSnapshot({
        externalId: "999",
        issueNumber: "1"
      })
    });

    await assert.rejects(
      applyPlan(service, plan),
      hasCode(
        mode === "mismatch"
          ? "IMPORT_PROVENANCE_MISMATCH"
          : "IMPORT_PROVENANCE_UNAVAILABLE"
      )
    );
    assert.equal(verifier.calls.length, 1);
    assert.equal(journal.commitCalls, 0);
    assert.equal(journal.records.length, 0);
  }
});

test("verifier exceptions are reduced to a fixed safe service error", async () => {
  const sentinel = "secret-token-in-cause";
  const journal = new MemoryJournal();
  const service = await openService({
    journal,
    verifier: {
      async verify() {
        throw new Error(sentinel);
      }
    }
  });
  const plan = createPreviewPlan();
  let caught: unknown;

  try {
    await applyPlan(service, plan);
  } catch (error) {
    caught = error;
  }

  assert.equal(
    caught instanceof Error &&
      "code" in caught &&
      caught.code,
    "IMPORT_PROVENANCE_UNAVAILABLE"
  );
  assert.equal(
    caught instanceof Error
      ? caught.message
      : null,
    "TaskSeal could not verify Provider fact provenance."
  );
  assert.doesNotMatch(
    caught instanceof Error ? caught.message : "",
    new RegExp(sentinel)
  );
  assert.equal(journal.commitCalls, 0);
});

test("mocked-real GitHub and Linear re-reads reject same-scope forged locator bindings", async (t) => {
  await t.test(
    "GitHub database ID does not match the reviewed Issue number",
    async () => {
      const journal = new MemoryJournal();
      const plan = createPreviewPlan({
        snapshot: createGitHubIssueSnapshot({
          externalId: "999",
          issueNumber: "1"
        })
      });
      const service = await openService({
        journal,
        verifier:
          createReadOnlyProviderFactProvenanceVerifier({
            github: {
              fetchImpl: async () =>
                jsonResponse({
                  id: 501,
                  number: 1,
                  title:
                    "Apply a provider snapshot safely",
                  html_url:
                    "https://github.com/netpilot-z/TaskSeal/issues/1",
                  created_at:
                    "2026-07-26T08:00:00.000Z",
                  updated_at:
                    "2026-07-26T08:01:00.000Z"
                })
            }
          })
      });

      await assert.rejects(
        applyPlan(service, plan),
        hasCode("IMPORT_PROVENANCE_MISMATCH")
      );
      assert.equal(journal.commitCalls, 0);
    }
  );

  await t.test(
    "Linear UUID does not match the reviewed identifier URL",
    async () => {
      const journal = new MemoryJournal();
      const policy = createLinearImportPolicy();
      const plan = createPreviewPlan({
        snapshot: createLinearIssueSnapshot(),
        importPolicy: policy
      });
      const service = await openService({
        journal,
        policy,
        verifier:
          createReadOnlyProviderFactProvenanceVerifier({
            linear: {
              apiKey: "test-only-key",
              expectedProjectId:
                "55555555-5555-4555-8555-555555555555",
              fetchImpl: async () =>
                jsonResponse({
                  data: {
                    organization: {
                      id:
                        "33333333-3333-4333-8333-333333333333"
                    },
                    issue: {
                      id:
                        "11111111-1111-4111-8111-111111111111",
                      identifier: "NET-8",
                      title:
                        "Import a Linear issue safely",
                      description: null,
                      url:
                        "https://linear.app/taskseal/issue/NET-8/example",
                      createdAt:
                        "2026-07-26T08:00:00.000Z",
                      updatedAt:
                        "2026-07-26T08:01:00.000Z",
                      team: {
                        id:
                          "22222222-2222-4222-8222-222222222222",
                        key: "NET"
                      },
                      project: {
                        id:
                          "55555555-5555-4555-8555-555555555555",
                        name: "TaskSeal"
                      }
                    }
                  }
                })
            }
          })
      });

      await assert.rejects(
        applyPlan(service, plan),
        hasCode("IMPORT_PROVENANCE_MISMATCH")
      );
      assert.equal(journal.commitCalls, 0);
    }
  );
});

test("a rehashed plan cannot commit an Issue title that disagrees with the verified remote fact", async () => {
  const journal = new MemoryJournal();
  const plan = structuredClone(
    createPreviewPlan()
  );
  const event = plan.events.find(
    (candidate) =>
      candidate.type === "work_item.created"
  );
  assert.ok(event);
  const link = event.payload.externalLink as {
    lastObservation: {
      title: string;
    };
  };
  event.payload.title = "Forged local title";
  link.lastObservation.title =
    "Forged local title";
  plan.planDigest = computeImportPlanDigest(plan);
  const service = await openService({
    journal,
    verifier:
      createReadOnlyProviderFactProvenanceVerifier({
        github: {
          fetchImpl: async () =>
            jsonResponse({
              id: 501,
              number: 1,
              title:
                "Apply a provider snapshot safely",
              html_url:
                "https://github.com/netpilot-z/TaskSeal/issues/1",
              created_at:
                "2026-07-26T08:00:00.000Z",
              updated_at:
                "2026-07-26T08:01:00.000Z"
            })
        }
      })
  });

  await assert.rejects(
    applyPlan(service, plan),
    hasCode("IMPORT_PROVENANCE_MISMATCH")
  );
  assert.equal(journal.commitCalls, 0);
});

test("a rehashed plan cannot persist an unverified Issue observation URL", async (t) => {
  const scenarios = [
    {
      name: "work item create",
      baseEvents: [] as CanonicalEvent[],
      createPlan() {
        return createPreviewPlan();
      },
      readLink(plan: ReturnType<typeof createPreviewPlan>) {
        const event = required(
          plan.events.find(
            (candidate) =>
              candidate.type ===
              "work_item.created"
          )
        );
        return event.payload.externalLink;
      }
    },
    {
      name: "external link",
      baseEvents: [
        required(createLocalDeliveryEvents()[0])
      ],
      createPlan() {
        const workflow = this.baseEvents.reduce(
          applyEvent,
          createWorkflow()
        );
        return createPreviewPlan({
          workflow,
          snapshot: createGitHubIssueSnapshot({
            managedFields: []
          })
        });
      },
      readLink(plan: ReturnType<typeof createPreviewPlan>) {
        const event = required(
          plan.events.find(
            (candidate) =>
              candidate.type ===
              "external_link.linked"
          )
        );
        return event.payload.link;
      }
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const journal = new MemoryJournal(
        scenario.baseEvents
      );
      const plan = structuredClone(
        scenario.createPlan()
      );
      const link = scenario.readLink(plan) as {
        lastObservation: {
          url?: string | undefined;
        };
      };
      link.lastObservation.url =
        "https://attacker.example/forged-observation";
      plan.planDigest =
        computeImportPlanDigest(plan);
      const service = await openService({
        journal,
        verifier:
          createReadOnlyProviderFactProvenanceVerifier({
            github: {
              fetchImpl: async () =>
                jsonResponse({
                  id: 501,
                  number: 1,
                  title:
                    "Apply a provider snapshot safely",
                  html_url:
                    "https://github.com/netpilot-z/TaskSeal/issues/1",
                  created_at:
                    "2026-07-26T08:00:00.000Z",
                  updated_at:
                    "2026-07-26T08:01:00.000Z"
                })
            }
          })
      });

      await assert.rejects(
        applyPlan(service, plan),
        hasCode("IMPORT_PROVENANCE_MISMATCH")
      );
      assert.equal(journal.commitCalls, 0);
    });
  }
});

test("a rehashed plan cannot commit forged Issue event or observation timestamps", async (t) => {
  const cases = [
    {
      name: "create event timestamp",
      mutate(plan: ReturnType<typeof createPreviewPlan>) {
        const event = required(
          plan.events.find(
            (candidate) =>
              candidate.type ===
              "work_item.created"
          )
        );
        event.occurredAt =
          "2099-01-01T00:00:00.000Z";
      }
    },
    {
      name: "source observation timestamp",
      mutate(plan: ReturnType<typeof createPreviewPlan>) {
        const event = required(
          plan.events.find(
            (candidate) =>
              candidate.type ===
              "work_item.created"
          )
        );
        const link =
          event.payload.externalLink as {
            lastObservation: {
              occurredAt: string;
            };
          };
        link.lastObservation.occurredAt =
          "2099-01-01T00:00:00.000Z";
      }
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const journal = new MemoryJournal();
      const plan = structuredClone(
        createPreviewPlan()
      );
      scenario.mutate(plan);
      plan.planDigest =
        computeImportPlanDigest(plan);
      const service = await openService({
        journal,
        verifier:
          createReadOnlyProviderFactProvenanceVerifier({
            github: {
              fetchImpl: async () =>
                jsonResponse({
                  id: 501,
                  number: 1,
                  title:
                    "Apply a provider snapshot safely",
                  html_url:
                    "https://github.com/netpilot-z/TaskSeal/issues/1",
                  created_at:
                    "2026-07-26T08:00:00.000Z",
                  updated_at:
                    "2026-07-26T08:01:00.000Z"
                })
            }
          })
      });

      await assert.rejects(
        applyPlan(service, plan),
        hasCode("IMPORT_PROVENANCE_MISMATCH")
      );
      assert.equal(journal.commitCalls, 0);
    });
  }
});

test("a rehashed delivery plan cannot commit forged PR or Check event timestamps", async (t) => {
  const baseEvents = createLocalDeliveryEvents();
  const baseWorkflow = baseEvents.reduce(
    applyEvent,
    createWorkflow()
  );
  const policy = createImportPolicy({
    objectTypes: ["check", "pull_request"]
  });

  for (const eventType of [
    "artifact.linked",
    "evidence.recorded"
  ] as const) {
    await t.test(eventType, async () => {
      const journal = new MemoryJournal(
        baseEvents
      );
      const plan = structuredClone(
        createPreviewPlan({
          workflow: baseWorkflow,
          snapshot:
            createGitHubDeliverySnapshot(),
          importPolicy: policy
        })
      );
      const event = required(
        plan.events.find(
          (candidate) =>
            candidate.type === eventType
        )
      );
      event.occurredAt =
        "2099-01-01T00:00:00.000Z";
      plan.planDigest =
        computeImportPlanDigest(plan);
      const service = await openService({
        journal,
        policy,
        verifier:
          createReadOnlyProviderFactProvenanceVerifier({
            github: {
              fetchImpl: async (url) => {
                if (url.includes("/pulls/")) {
                  return jsonResponse({
                    id: 601,
                    number: 2,
                    html_url:
                      "https://github.com/netpilot-z/TaskSeal/pull/2",
                    updated_at:
                      "2026-07-26T08:03:00.000Z",
                    head: {
                      sha: "abc123"
                    }
                  });
                }

                return jsonResponse({
                  id: 701,
                  name: "tests",
                  status: "completed",
                  conclusion: "success",
                  head_sha: "abc123",
                  details_url:
                    "https://github.com/netpilot-z/TaskSeal/actions/runs/7",
                  completed_at:
                    "2026-07-26T08:04:00.000Z"
                });
              }
            }
          })
      });

      await assert.rejects(
        applyPlan(service, plan),
        hasCode("IMPORT_PROVENANCE_MISMATCH")
      );
      assert.equal(journal.commitCalls, 0);
    });
  }
});

test("a rehashed update plan cannot commit forged observation or managed-update timestamps", async (t) => {
  const initialPlan = createPreviewPlan();
  const baseWorkflow = initialPlan.events.reduce(
    applyEvent,
    createWorkflow()
  );
  const cases = [
    {
      name: "observation event timestamp",
      mutate(plan: ReturnType<typeof createPreviewPlan>) {
        required(
          plan.events.find(
            (event) =>
              event.type ===
              "external_link.observed"
          )
        ).occurredAt =
          "2099-01-01T00:00:00.000Z";
      }
    },
    {
      name: "observation source timestamp",
      mutate(plan: ReturnType<typeof createPreviewPlan>) {
        const observation = required(
          plan.events.find(
            (event) =>
              event.type ===
              "external_link.observed"
          )
        ).payload.observation as {
          occurredAt: string;
        };
        observation.occurredAt =
          "2099-01-01T00:00:00.000Z";
      }
    },
    {
      name: "managed update event timestamp",
      mutate(plan: ReturnType<typeof createPreviewPlan>) {
        required(
          plan.events.find(
            (event) =>
              event.type ===
              "work_item.updated"
          )
        ).occurredAt =
          "2099-01-01T00:00:00.000Z";
      }
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const journal = new MemoryJournal(
        initialPlan.events
      );
      const plan = structuredClone(
        createPreviewPlan({
          workflow: baseWorkflow,
          snapshot: createGitHubIssueSnapshot({
            title: "Updated provider title",
            revisionId:
              "2026-07-26T08:02:00.000Z",
            capturedAt:
              "2026-07-26T08:02:01.000Z"
          })
        })
      );
      scenario.mutate(plan);
      plan.planDigest =
        computeImportPlanDigest(plan);
      const service = await openService({
        journal,
        verifier:
          createReadOnlyProviderFactProvenanceVerifier({
            github: {
              fetchImpl: async () =>
                jsonResponse({
                  id: 501,
                  number: 1,
                  title:
                    "Updated provider title",
                  html_url:
                    "https://github.com/netpilot-z/TaskSeal/issues/1",
                  created_at:
                    "2026-07-26T08:00:00.000Z",
                  updated_at:
                    "2026-07-26T08:02:00.000Z"
                })
            }
          })
      });

      await assert.rejects(
        applyPlan(service, plan),
        hasCode("IMPORT_PROVENANCE_MISMATCH")
      );
      assert.equal(journal.commitCalls, 0);
    });
  }
});

test("policy and Workflow stale failures do not spend a verifier read", async () => {
  const plan = createPreviewPlan();

  const revokedVerifier = new RecordingVerifier();
  const revokedJournal = new MemoryJournal();
  const revokedService = await openService({
    journal: revokedJournal,
    verifier: revokedVerifier,
    policy: createImportPolicy({
      applyAllowed: false
    })
  });

  await assert.rejects(
    applyPlan(revokedService, plan),
    hasCode("IMPORT_APPLY_FORBIDDEN")
  );
  assert.equal(revokedVerifier.calls.length, 0);
  assert.equal(revokedJournal.commitCalls, 0);

  const staleVerifier = new RecordingVerifier();
  const staleJournal = new MemoryJournal([
    createLocalWorkItemEvent()
  ]);
  const staleService = await openService({
    journal: staleJournal,
    verifier: staleVerifier
  });

  await assert.rejects(
    applyPlan(staleService, plan),
    hasCode("IMPORT_PLAN_STALE")
  );
  assert.equal(staleVerifier.calls.length, 0);
  assert.equal(staleJournal.commitCalls, 0);
});

test("registry, ingress preflight, and blocked plans fail before any verifier read", async (t) => {
  await t.test("registry revocation", async () => {
    const journal = new MemoryJournal();
    const verifier = new RecordingVerifier();
    const service = await openService({
      journal,
      verifier,
      registry: createProviderIngressRegistry([])
    });
    const plan = createPreviewPlan();

    await assert.rejects(
      applyPlan(service, plan),
      hasCode("PROVIDER_INGRESS_FORBIDDEN")
    );
    assert.equal(verifier.calls.length, 0);
    assert.equal(journal.commitCalls, 0);
  });

  await t.test("ingress preflight", async () => {
    const journal = new MemoryJournal();
    const verifier = new RecordingVerifier();
    const service = await openService({
      journal,
      verifier
    });
    const plan = structuredClone(
      createPreviewPlan()
    );
    const event = plan.events.find(
      (candidate) =>
        candidate.type === "work_item.created"
    );
    assert.ok(event);
    const link = event.payload.externalLink as {
      url: string;
    };
    link.url =
      "https://github.com/foreign/repository/issues/1";
    plan.planDigest =
      computeImportPlanDigest(plan);

    await assert.rejects(
      applyPlan(service, plan),
      hasCode("IMPORT_PLAN_TAMPERED")
    );
    assert.equal(verifier.calls.length, 0);
    assert.equal(journal.commitCalls, 0);
  });

  await t.test("blocked conflict", async () => {
    const ownerPlan = createPreviewPlan({
      snapshot: createGitHubIssueSnapshot({
        workItemId: "TS-2",
        managedFields: []
      })
    });
    const ownerWorkflow = ownerPlan.events.reduce(
      applyEvent,
      createWorkflow()
    );
    const blockedPlan = createPreviewPlan({
      workflow: ownerWorkflow,
      snapshot: createGitHubIssueSnapshot({
        workItemId: "TS-1",
        managedFields: []
      })
    });
    const journal = new MemoryJournal(
      ownerPlan.events
    );
    const verifier = new RecordingVerifier();
    const service = await openService({
      journal,
      verifier
    });

    await assert.rejects(
      applyPlan(service, blockedPlan),
      hasCode("IMPORT_PLAN_BLOCKED")
    );
    assert.equal(verifier.calls.length, 0);
    assert.equal(journal.commitCalls, 0);
  });
});

async function openService({
  journal,
  verifier,
  policy = createImportPolicy(),
  registry
}: {
  journal: EventJournal;
  verifier: ProviderFactProvenanceVerifier;
  policy?: unknown;
  registry?: ProviderIngressRegistry;
}): Promise<TaskSealService> {
  return TaskSealService.open({
    journal,
    importPolicyProvider: async () =>
      structuredClone(policy),
    providerFactProvenanceVerifier: verifier,
    ...(registry
      ? { providerIngressRegistry: registry }
      : {}),
    clock: () => new Date(APPLIED_AT)
  });
}

function applyPlan(
  service: TaskSealService,
  plan: ReturnType<typeof createPreviewPlan>
) {
  return service.applySnapshotImport({
    plan,
    expectedPlanDigest: plan.planDigest,
    actor: createActor()
  });
}

class RecordingVerifier
  implements ProviderFactProvenanceVerifier {
  readonly calls: ProviderFactProvenanceClaim[][] =
    [];
  readonly mode:
      | "verified"
      | "mismatch"
      | "partial"
      | "malformed";

  constructor(
    mode:
      | "verified"
      | "mismatch"
      | "partial"
      | "malformed" = "verified"
  ) {
    this.mode = mode;
  }

  async verify(
    claims: readonly ProviderFactProvenanceClaim[]
  ): Promise<unknown> {
    this.calls.push(
      claims.map((claim) => structuredClone(claim))
    );

    if (this.mode === "partial") {
      return [];
    }

    return claims.map((claim) => ({
      schemaVersion: 1,
      claimDigest: claim.claimDigest,
      outcome:
        this.mode === "mismatch"
          ? "mismatch"
          : "verified",
      ...(this.mode === "malformed"
        ? { unexpected: true }
        : {})
    }));
  }
}

class MemoryJournal implements EventJournal {
  readonly records: unknown[];
  commitCalls = 0;

  constructor(records: unknown[] = []) {
    this.records = structuredClone(records);
  }

  async readAll(): Promise<unknown[]> {
    return structuredClone(this.records);
  }

  async append(
    event: CanonicalEvent
  ): Promise<void> {
    this.records.push(structuredClone(event));
  }

  async commitBatch(
    record: ImportBatchRecord
  ): Promise<void> {
    this.commitCalls += 1;
    this.records.push(structuredClone(record));
  }
}

function createLocalWorkItemEvent(): CanonicalEvent {
  return {
    eventId: "local:stale:created",
    workItemId: "local-stale",
    type: "work_item.created",
    occurredAt: "2026-07-28T00:00:00.000Z",
    payload: {
      title: "Local stale marker",
      requiredEvidence: ["tests"],
      externalLink: {
        provider: "taskseal",
        externalId: "local-stale",
        url:
          "http://127.0.0.1/work-items/local-stale"
      }
    }
  };
}

function createLocalDeliveryEvents():
  CanonicalEvent[] {
  return [
    {
      eventId: "local:TS-1:created",
      workItemId: "TS-1",
      type: "work_item.created",
      occurredAt:
        "2026-07-26T08:00:00.000Z",
      payload: {
        title: "Local delivery",
        requiredEvidence: ["tests"],
        externalLink: {
          provider: "taskseal",
          externalId: "TS-1",
          url:
            "http://127.0.0.1/work-items/TS-1"
        }
      }
    },
    {
      eventId: "local:TS-1:run-1:started",
      workItemId: "TS-1",
      type: "attempt.started",
      occurredAt:
        "2026-07-26T08:02:00.000Z",
      payload: {
        attemptId: "run-1",
        agentId: "codex"
      }
    }
  ];
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: {
      get(): null {
        return null;
      }
    },
    async json() {
      return body;
    }
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
  value: T | null | undefined
): T {
  if (value === null || value === undefined) {
    throw new Error("value is required");
  }

  return value;
}
