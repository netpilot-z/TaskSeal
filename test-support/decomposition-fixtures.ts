import {
  createDigitalEmployeeRegistry,
  prepareDecompositionPlan
} from "../src/application/decomposition-plan.ts";
import type {
  DecompositionWorkItemReference
} from "../src/application/decomposition-plan.ts";

export function createDecompositionFixture() {
  const registry =
    createDigitalEmployeeRegistry([
      {
        manifest: {
          schemaVersion: "1",
          runnerId:
            "codex-app-server",
          displayName:
            "Codex App Server",
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
        },
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
  const workItems = new Map<
    string,
    DecompositionWorkItemReference
  >([
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
  const draft = {
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
  const preview =
    prepareDecompositionPlan(draft, {
      registry,
      getWorkItem: (workItemId) =>
        workItems.get(workItemId) ?? null
    });

  return {
    registry,
    workItems,
    draft,
    preview
  };
}
