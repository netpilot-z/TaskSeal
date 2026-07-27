import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPolicyBinding,
  normalizeImportPolicy
} from "../src/application/import-policy.js";

test("import policies normalize scopes and object types deterministically", () => {
  const first = createPolicy({
    allowedScopes: [
      createLinearScope({
        objectTypes: ["issue"]
      }),
      createGitHubScope({
        key: "github:repository:NetPilot-Z/TaskSeal",
        objectTypes: ["pull_request", "issue", "check"]
      })
    ]
  });
  const second = createPolicy({
    allowedScopes: [
      createGitHubScope({
        objectTypes: ["check", "issue", "pull_request"]
      }),
      createLinearScope({
        key:
          "linear:team:22222222-2222-4222-8222-222222222222",
        parentKey:
          "linear:organization:33333333-3333-4333-8333-333333333333"
      })
    ]
  });
  const snapshot = structuredClone(first);

  assert.deepEqual(
    normalizeImportPolicy(first),
    normalizeImportPolicy(second)
  );
  assert.deepEqual(first, snapshot);
});

test("policy bindings depend only on the selected target and required object types", () => {
  const target = {
    provider: "github",
    scopeRef: {
      kind: "repository",
      key: "github:repository:netpilot-z/taskseal"
    },
    requiredObjectTypes: ["issue", "check"]
  };
  const withUnrelatedScope = buildPolicyBinding({
    importPolicy: createPolicy(),
    ...target
  });
  const targetOnly = buildPolicyBinding({
    importPolicy: createPolicy({
      allowedScopes: [
        createGitHubScope()
      ]
    }),
    ...target
  });

  assert.deepEqual(
    withUnrelatedScope.policyBinding,
    {
      schemaVersion: 1,
      capability: "snapshot.import.apply",
      applyAllowed: true,
      provider: "github",
      scopeRef: {
        kind: "repository",
        key: "github:repository:netpilot-z/taskseal"
      },
      requiredObjectTypes: ["check", "issue"]
    }
  );
  assert.deepEqual(
    withUnrelatedScope,
    targetOnly
  );
  assert.match(
    withUnrelatedScope.policyDigest,
    /^sha256:[0-9a-f]{64}$/
  );
});

test("a disabled apply capability still produces a preview binding", () => {
  const enabled = buildPolicyBinding({
    importPolicy: createPolicy(),
    provider: "github",
    scopeRef: {
      kind: "repository",
      key: "github:repository:netpilot-z/taskseal"
    },
    requiredObjectTypes: ["issue"]
  });
  const disabled = buildPolicyBinding({
    importPolicy: createPolicy({
      applyAllowed: false
    }),
    provider: "github",
    scopeRef: {
      kind: "repository",
      key: "github:repository:netpilot-z/taskseal"
    },
    requiredObjectTypes: ["issue"]
  });

  assert.equal(disabled.policyBinding.applyAllowed, false);
  assert.notEqual(disabled.policyDigest, enabled.policyDigest);
});

test("import policy rejects unknown fields, duplicates, and malformed scopes", () => {
  const sparseScopes = new Array(1);
  const sparseObjectTypes = new Array(1);
  const invalidPolicies = [
    {
      ...createPolicy(),
      token: "not-allowed"
    },
    {
      ...createPolicy(),
      capabilities: {
        "snapshot.import.apply": true,
        "snapshot.import.force": true
      }
    },
    createPolicy({
      allowedScopes: [
        createGitHubScope(),
        createGitHubScope()
      ]
    }),
    createPolicy({
      allowedScopes: [
        createGitHubScope({
          objectTypes: ["issue", "issue"]
        })
      ]
    }),
    createPolicy({
      allowedScopes: [
        {
          ...createGitHubScope(),
          provider: "gitee"
        }
      ]
    }),
    createPolicy({
      allowedScopes: [
        createGitHubScope({
          key: "github:repository:not a coordinate"
        })
      ]
    }),
    createPolicy({
      allowedScopes: [
        createLinearScope({
          key: "linear:team:not-a-uuid"
        })
      ]
    }),
    createPolicy({
      allowedScopes: [
        createGitHubScope({
          objectTypes: ["issue", "deployment"]
        })
      ]
    }),
    createPolicy({
      allowedScopes: [
        {
          ...createGitHubScope(),
          label: "secret scope"
        }
      ]
    }),
    createPolicy({
      allowedScopes: sparseScopes
    }),
    createPolicy({
      allowedScopes: [
        createGitHubScope({
          objectTypes: sparseObjectTypes
        })
      ]
    })
  ];

  for (const policy of invalidPolicies) {
    assert.throws(
      () => normalizeImportPolicy(policy),
      hasCode("IMPORT_POLICY_INVALID")
    );
  }
});

test("binding fails closed when the scope or object type is not allowed", () => {
  const policy = createPolicy({
    allowedScopes: [
      createGitHubScope({
        objectTypes: ["issue"]
      })
    ]
  });

  assert.throws(
    () =>
      buildPolicyBinding({
        importPolicy: policy,
        provider: "github",
        scopeRef: {
          kind: "repository",
          key: "github:repository:netpilot-z/other"
        },
        requiredObjectTypes: ["issue"]
      }),
    hasCode("SNAPSHOT_SCOPE_MISMATCH")
  );
  assert.throws(
    () =>
      buildPolicyBinding({
        importPolicy: policy,
        provider: "github",
        scopeRef: {
          kind: "repository",
          key: "github:repository:netpilot-z/taskseal"
        },
        requiredObjectTypes: ["check", "issue"]
      }),
    hasCode("SNAPSHOT_SCOPE_MISMATCH")
  );
});

function createPolicy({
  applyAllowed = true,
  allowedScopes = [
    createGitHubScope(),
    createLinearScope()
  ]
} = {}) {
  return {
    schemaVersion: 1,
    capabilities: {
      "snapshot.import.apply": applyAllowed
    },
    allowedScopes
  };
}

function createGitHubScope({
  key = "github:repository:netpilot-z/taskseal",
  objectTypes = ["check", "issue", "pull_request"]
} = {}) {
  return {
    provider: "github",
    scopeRef: {
      kind: "repository",
      key
    },
    objectTypes
  };
}

function createLinearScope({
  key =
    "linear:team:22222222-2222-4222-8222-222222222222",
  parentKey =
    "linear:organization:33333333-3333-4333-8333-333333333333",
  objectTypes = ["issue"]
} = {}) {
  return {
    provider: "linear",
    scopeRef: {
      kind: "team",
      key,
      parentKey
    },
    objectTypes
  };
}

function hasCode(code) {
  return (error) => error?.code === code;
}
