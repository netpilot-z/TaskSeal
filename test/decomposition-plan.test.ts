import assert from "node:assert/strict";
import test from "node:test";

import {
  createDigitalEmployeeRegistry,
  DecompositionPlanError,
  parsePreparedDecompositionPlan,
  prepareDecompositionPlan
} from "../src/application/decomposition-plan.ts";

const manifest = {
  schemaVersion: "1",
  runnerId: "codex-app-server",
  displayName: "Codex App Server",
  capabilities: {
    workspaceAccess: [
      "read-only",
      "workspace-write"
    ],
    cancellation: true,
    timeout: true,
    handoffKinds: [
      "artifact",
      "evidence"
    ]
  }
};

test("decomposition preview binds a stable DAG to existing work, evidence, and a trusted owner profile", () => {
  const registry =
    createDigitalEmployeeRegistry([
      {
        manifest,
        allowedWorkspaceAccess: [
          "read-only",
          "workspace-write"
        ],
        skillTags: [
          "backend",
          "testing"
        ]
      }
    ]);
  const workItems = new Map([
    [
      "ROOT",
      {
        id: "ROOT",
        requiredEvidence: ["tests"]
      }
    ],
    [
      "API",
      {
        id: "API",
        requiredEvidence: [
          "contract",
          "tests"
        ]
      }
    ],
    [
      "QA",
      {
        id: "QA",
        requiredEvidence: ["tests"]
      }
    ]
  ]);
  const first = prepareDecompositionPlan(
    validDraft(),
    {
      registry,
      getWorkItem: (workItemId) =>
        workItems.get(workItemId) ?? null
    }
  );
  const reordered = prepareDecompositionPlan(
    {
      ...validDraft(),
      nodes: [
        {
          ...validDraft().nodes[1],
          dependsOn: ["api"],
          requirements: {
            skillTags: ["testing"],
            handoffKinds: [
              "evidence",
              "artifact"
            ]
          }
        },
        {
          ...validDraft().nodes[0],
          acceptanceCriteria: [
            {
              key: "tests",
              description:
                "The test suite passes."
            },
            {
              key: "contract",
              description:
                "The API contract is verified."
            }
          ],
          requirements: {
            skillTags: [
              "testing",
              "backend"
            ],
            handoffKinds: [
              "evidence",
              "artifact"
            ]
          }
        }
      ]
    },
    {
      registry,
      getWorkItem: (workItemId) =>
        workItems.get(workItemId) ?? null
    }
  );

  assert.equal(
    first.planDigest,
    reordered.planDigest
  );
  assert.deepEqual(
    first.plan.topologicalOrder,
    ["api", "qa"]
  );
  assert.deepEqual(
    first.plan.nodes.map((node) => ({
      nodeId: node.nodeId,
      owner: node.owner,
      evidence:
        node.acceptanceCriteria.map(
          (criterion) => criterion.key
        )
    })),
    [
      {
        nodeId: "api",
        owner: {
          runnerId: "codex-app-server",
          profileRevision:
            registry.get(
              "codex-app-server"
            )?.profileRevision
        },
        evidence: [
          "contract",
          "tests"
        ]
      },
      {
        nodeId: "qa",
        owner: {
          runnerId: "codex-app-server",
          profileRevision:
            registry.get(
              "codex-app-server"
            )?.profileRevision
        },
        evidence: ["tests"]
      }
    ]
  );
  assert.equal(
    parsePreparedDecompositionPlan(
      structuredClone(first.plan)
    ).planId,
    "plan-alpha"
  );
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.plan));
  assert.ok(Object.isFrozen(first.plan.nodes));
});

test("decomposition preview fails closed for cycles, dangling dependencies, duplicate work, and recursive roots", () => {
  const context = createContext();
  const invalidDrafts = [
    {
      ...validDraft(),
      nodes: validDraft().nodes.map(
        (node) => ({
          ...node,
          dependsOn:
            node.nodeId === "api"
              ? ["qa"]
              : ["api"]
        })
      )
    },
    {
      ...validDraft(),
      nodes: [
        {
          ...validDraft().nodes[0],
          dependsOn: ["missing"]
        },
        validDraft().nodes[1]
      ]
    },
    {
      ...validDraft(),
      nodes: [
        validDraft().nodes[0],
        {
          ...validDraft().nodes[1],
          workItemId: "API",
          acceptanceCriteria:
            validDraft().nodes[0]!
              .acceptanceCriteria
        }
      ]
    },
    {
      ...validDraft(),
      nodes: [
        {
          ...validDraft().nodes[0],
          workItemId: "ROOT"
        },
        validDraft().nodes[1]
      ]
    }
  ];

  for (const draft of invalidDrafts) {
    assert.throws(
      () =>
        prepareDecompositionPlan(
          draft,
          context
        ),
      hasCode(
        "DECOMPOSITION_GRAPH_INVALID"
      )
    );
  }
});

test("prepared plans preserve non-lexical topological order and recheck recursive roots", () => {
  const context = createContext();
  const draft = validDraft();
  const preview =
    prepareDecompositionPlan(
      {
        ...draft,
        nodes: [
          {
            ...draft.nodes[0],
            nodeId: "z-foundation"
          },
          {
            ...draft.nodes[1],
            nodeId: "a-verification",
            dependsOn: [
              "z-foundation"
            ]
          }
        ]
      },
      context
    );

  assert.deepEqual(
    preview.plan.topologicalOrder,
    [
      "z-foundation",
      "a-verification"
    ]
  );
  assert.deepEqual(
    parsePreparedDecompositionPlan(
      structuredClone(
        preview.plan
      )
    ).topologicalOrder,
    [
      "z-foundation",
      "a-verification"
    ]
  );

  assert.throws(
    () =>
      parsePreparedDecompositionPlan({
        ...structuredClone(
          preview.plan
        ),
        rootWorkItemId: "API"
      }),
    hasCode(
      "DECOMPOSITION_GRAPH_INVALID"
    )
  );
});

test("decomposition preview rejects stale work evidence and owner capability or permission mismatches", () => {
  const context = createContext();
  const invalidDrafts = [
    {
      ...validDraft(),
      nodes: [
        {
          ...validDraft().nodes[0],
          acceptanceCriteria: [
            {
              key: "tests",
              description:
                "The test suite passes."
            }
          ]
        },
        validDraft().nodes[1]
      ]
    },
    {
      ...validDraft(),
      nodes: [
        {
          ...validDraft().nodes[0],
          requirements: {
            ...validDraft().nodes[0]!
              .requirements,
            skillTags: ["frontend"]
          }
        },
        validDraft().nodes[1]
      ]
    },
    {
      ...validDraft(),
      nodes: [
        {
          ...validDraft().nodes[0],
          execution: {
            ...validDraft().nodes[0]!
              .execution,
            workspaceAccess:
              "workspace-write"
          }
        },
        validDraft().nodes[1]
      ]
    }
  ];
  const readOnlyRegistry =
    createDigitalEmployeeRegistry([
      {
        manifest,
        allowedWorkspaceAccess: [
          "read-only"
        ],
        skillTags: [
          "backend",
          "testing"
        ]
      }
    ]);

  assert.throws(
    () =>
      prepareDecompositionPlan(
        invalidDrafts[0],
        context
      ),
    hasCode(
      "DECOMPOSITION_EVIDENCE_MISMATCH"
    )
  );
  assert.throws(
    () =>
      prepareDecompositionPlan(
        invalidDrafts[1],
        context
      ),
    hasCode(
      "DECOMPOSITION_OWNER_UNAVAILABLE"
    )
  );
  assert.throws(
    () =>
      prepareDecompositionPlan(
        invalidDrafts[2],
        {
          ...context,
          registry: readOnlyRegistry
        }
      ),
    hasCode(
      "DECOMPOSITION_OWNER_UNAVAILABLE"
    )
  );
});

test("a runner with no handoff claims can own nodes that require no handoff", () => {
  const noHandoffRegistry =
    createDigitalEmployeeRegistry([
      {
        manifest: {
          ...manifest,
          capabilities: {
            ...manifest.capabilities,
            handoffKinds: []
          }
        },
        allowedWorkspaceAccess: [
          "read-only"
        ],
        skillTags: [
          "backend",
          "testing"
        ]
      }
    ]);
  const draft = validDraft();

  const preview =
    prepareDecompositionPlan(
      {
        ...draft,
        nodes: draft.nodes.map(
          (node) => ({
            ...node,
            requirements: {
              ...node.requirements,
              handoffKinds: []
            }
          })
        )
      },
      {
        ...createContext(),
        registry:
          noHandoffRegistry
      }
    );

  assert.deepEqual(
    preview.plan.nodes.map(
      (node) =>
        node.requirements
          .handoffKinds
    ),
    [[], []]
  );
});

test("decomposition decoder rejects unknown fields and accessors without evaluating them", () => {
  const context = createContext();
  assert.throws(
    () =>
      prepareDecompositionPlan(
        {
          ...validDraft(),
          percentComplete: 40
        },
        context
      ),
    hasCode(
      "DECOMPOSITION_INPUT_INVALID"
    )
  );

  let accessed = false;
  const hostileNode = {
    ...validDraft().nodes[0]
  };
  Object.defineProperty(
    hostileNode,
    "instruction",
    {
      enumerable: true,
      get() {
        accessed = true;
        return "Never read this.";
      }
    }
  );

  assert.throws(
    () =>
      prepareDecompositionPlan(
        {
          ...validDraft(),
          nodes: [
            hostileNode,
            validDraft().nodes[1]
          ]
        },
        context
      ),
    hasCode(
      "DECOMPOSITION_INPUT_INVALID"
    )
  );
  assert.equal(accessed, false);
});

function createContext() {
  const registry =
    createDigitalEmployeeRegistry([
      {
        manifest,
        allowedWorkspaceAccess: [
          "read-only"
        ],
        skillTags: [
          "backend",
          "testing"
        ]
      }
    ]);
  const workItems = new Map([
    [
      "ROOT",
      {
        id: "ROOT",
        requiredEvidence: ["tests"]
      }
    ],
    [
      "API",
      {
        id: "API",
        requiredEvidence: [
          "contract",
          "tests"
        ]
      }
    ],
    [
      "QA",
      {
        id: "QA",
        requiredEvidence: ["tests"]
      }
    ]
  ]);

  return {
    registry,
    getWorkItem: (workItemId: string) =>
      workItems.get(workItemId) ?? null
  };
}

function validDraft() {
  return {
    schemaVersion: "1",
    planId: "plan-alpha",
    rootWorkItemId: "ROOT",
    dispatch: {
      maxParallelism: 2,
      maxQueuedNodes: 8
    },
    nodes: [
      {
        nodeId: "api",
        workItemId: "API",
        instruction:
          "Implement the bounded API.",
        dependsOn: [],
        ownerRunnerId:
          "codex-app-server",
        requirements: {
          skillTags: [
            "backend",
            "testing"
          ],
          handoffKinds: [
            "artifact",
            "evidence"
          ]
        },
        execution: {
          workspaceAccess: "read-only",
          timeoutMs: 60_000
        },
        acceptanceCriteria: [
          {
            key: "contract",
            description:
              "The API contract is verified."
          },
          {
            key: "tests",
            description:
              "The test suite passes."
          }
        ],
        retryPolicy: {
          maxAttempts: 2,
          backoffMs: 0,
          retryOn: ["failed"]
        }
      },
      {
        nodeId: "qa",
        workItemId: "QA",
        instruction:
          "Verify the completed API.",
        dependsOn: ["api"],
        ownerRunnerId:
          "codex-app-server",
        requirements: {
          skillTags: ["testing"],
          handoffKinds: [
            "artifact",
            "evidence"
          ]
        },
        execution: {
          workspaceAccess: "read-only",
          timeoutMs: 60_000
        },
        acceptanceCriteria: [
          {
            key: "tests",
            description:
              "The test suite passes."
          }
        ],
        retryPolicy: {
          maxAttempts: 1,
          backoffMs: 0,
          retryOn: ["failed"]
        }
      }
    ]
  };
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof
      DecompositionPlanError &&
    error.code === code;
}
