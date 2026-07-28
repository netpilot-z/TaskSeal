import assert from "node:assert/strict";

import {
  registerProviderAdapterContract
} from "taskseal/testing/provider/v1";

import {
  createMemoryProviderAdapter
} from "./index.js";

registerProviderAdapterContract({
  name: "memory provider",
  createAdapter:
    createMemoryProviderAdapter,
  healthRequest: {
    namespace: "contract"
  },
  workItemRequest: {
    id: "contract-item"
  },
  assertHealthResult(result) {
    assert.deepEqual(result, {
      status: "ready",
      namespace: "contract"
    });
  },
  assertWorkItemResult(result) {
    assert.deepEqual(result, {
      id: "contract-item",
      title:
        "Memory work item"
    });
  }
});
