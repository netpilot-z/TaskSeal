import assert from "node:assert/strict";

import {
  registerProviderAdapterContract
} from "../src/sdk/testing/provider-v1.ts";

const calls: unknown[] = [];

registerProviderAdapterContract({
  name: "memory provider",
  createAdapter() {
    return {
      manifest: {
        schemaVersion: 1,
        apiVersion:
          "taskseal.provider/v1",
        providerId:
          "example.memory",
        capabilities: [
          "provider.health",
          "work-item.read"
        ],
        configuration: {
          schemaVersion: 1,
          fields: [
            {
              key: "namespace",
              type: "string",
              required: true,
              secret: false
            }
          ]
        },
        credential: {
          mode: "none"
        },
        scopes: [
          {
            kind: "namespace",
            objectTypes: [
              "work-item"
            ]
          }
        ]
      },
      ports: {
        async "provider.health"(
          request
        ) {
          calls.push(request);
          return {
            status: "ready"
          };
        },
        async "work-item.read"(
          request
        ) {
          calls.push(request);
          return {
            title: "Contract item"
          };
        }
      }
    };
  },
  healthRequest: {
    namespace: "contract"
  },
  workItemRequest: {
    id: "contract-item"
  },
  assertHealthResult(result) {
    assert.deepEqual(result, {
      status: "ready"
    });
  },
  assertWorkItemResult(result) {
    assert.deepEqual(result, {
      title: "Contract item"
    });
  }
});
