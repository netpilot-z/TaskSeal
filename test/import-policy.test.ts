import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPolicyBinding,
  normalizeImportPolicy,
  normalizePolicyBinding
} from "../src/application/import-policy.ts";

test("import policies normalize per-scope capabilities and object types deterministically", () => {
  const first = createPolicy({
    allowedScopes: [
      createLinearScope(),
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
      allowedScopes: [createGitHubScope()]
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
  assert.equal(withUnrelatedScope.previewAllowed, true);
  assert.deepEqual(withUnrelatedScope, targetOnly);
  assert.match(
    withUnrelatedScope.policyDigest,
    /^sha256:[0-9a-f]{64}$/
  );
});

test("preview and apply capabilities are isolated per exact scope", () => {
  const policy = createPolicy({
    allowedScopes: [
      createGitHubScope(),
      createGitHubScope({
        key: "github:repository:netpilot-z/preview-only",
        applyAllowed: false
      }),
      createGitHubScope({
        key: "github:repository:netpilot-z/revoked",
        previewAllowed: false,
        applyAllowed: false
      })
    ]
  });
  const bind = (key: string) =>
    buildPolicyBinding({
      importPolicy: policy,
      provider: "github",
      scopeRef: {
        kind: "repository",
        key
      },
      requiredObjectTypes: ["issue"]
    });

  const enabled = bind(
    "github:repository:netpilot-z/taskseal"
  );
  const previewOnly = bind(
    "github:repository:netpilot-z/preview-only"
  );
  const revoked = bind(
    "github:repository:netpilot-z/revoked"
  );

  assert.equal(enabled.previewAllowed, true);
  assert.equal(enabled.policyBinding.applyAllowed, true);
  assert.equal(previewOnly.previewAllowed, true);
  assert.equal(
    previewOnly.policyBinding.applyAllowed,
    false
  );
  assert.equal(revoked.previewAllowed, false);
  assert.equal(revoked.policyBinding.applyAllowed, false);
  assert.notEqual(
    enabled.policyDigest,
    previewOnly.policyDigest
  );
});

test("Gitee repository scopes are explicit and case-normalized without widening object types", () => {
  const bound = buildPolicyBinding({
    importPolicy: createPolicy({
      allowedScopes: [
        createGiteeScope({
          key: "gitee:repository:OSChina/Git-Osc"
        })
      ]
    }),
    provider: "gitee",
    scopeRef: {
      kind: "repository",
      key: "gitee:repository:oschina/git-osc"
    },
    requiredObjectTypes: ["issue"]
  });

  assert.equal(bound.previewAllowed, true);
  assert.equal(bound.policyBinding.schemaVersion, 2);
  assert.deepEqual(bound.policyBinding.scopeRef, {
    kind: "repository",
    key: "gitee:repository:oschina/git-osc"
  });
  assert.throws(
    () =>
      buildPolicyBinding({
        importPolicy: createPolicy({
          allowedScopes: [createGiteeScope()]
        }),
        provider: "gitee",
        scopeRef: {
          kind: "repository",
          key: "gitee:repository:oschina/git-osc"
        },
        requiredObjectTypes: ["pull_request"]
      }),
    hasCode("SNAPSHOT_SCOPE_MISMATCH")
  );
});

test("PolicyBinding versions keep legacy providers on v1, Gitee on v2, and review evidence on an explicit v3 fence", () => {
  assert.equal(
    buildPolicyBinding({
      importPolicy: createPolicy(),
      provider: "github",
      scopeRef: {
        kind: "repository",
        key: "github:repository:netpilot-z/taskseal"
      },
      requiredObjectTypes: ["issue"]
    }).policyBinding.schemaVersion,
    1
  );
  const reviewBinding =
    buildPolicyBinding({
      importPolicy: createPolicy({
        allowedScopes: [
          createGitHubScope({
            objectTypes: [
              "check",
              "pull_request",
              "pull_request_review"
            ]
          })
        ]
      }),
      provider: "github",
      scopeRef: {
        kind: "repository",
        key: "github:repository:netpilot-z/taskseal"
      },
      requiredObjectTypes: [
        "pull_request",
        "pull_request_review"
      ]
    }).policyBinding;
  assert.equal(
    reviewBinding.schemaVersion,
    3
  );
  assert.deepEqual(
    normalizePolicyBinding(
      reviewBinding
    ),
    reviewBinding
  );

  for (const binding of [
    {
      schemaVersion: 1,
      capability: "snapshot.import.apply",
      applyAllowed: true,
      provider: "gitee",
      scopeRef: {
        kind: "repository",
        key: "gitee:repository:oschina/git-osc"
      },
      requiredObjectTypes: ["issue"]
    },
    {
      schemaVersion: 2,
      capability: "snapshot.import.apply",
      applyAllowed: true,
      provider: "github",
      scopeRef: {
        kind: "repository",
        key: "github:repository:netpilot-z/taskseal"
      },
      requiredObjectTypes: ["issue"]
    },
    {
      schemaVersion: 1,
      capability: "snapshot.import.apply",
      applyAllowed: true,
      provider: "github",
      scopeRef: {
        kind: "repository",
        key: "github:repository:netpilot-z/taskseal"
      },
      requiredObjectTypes: [
        "pull_request_review"
      ]
    },
    {
      schemaVersion: 3,
      capability: "snapshot.import.apply",
      applyAllowed: true,
      provider: "github",
      scopeRef: {
        kind: "repository",
        key: "github:repository:netpilot-z/taskseal"
      },
      requiredObjectTypes: ["issue"]
    }
  ]) {
    assert.throws(
      () => normalizePolicyBinding(binding),
      hasCode("IMPORT_POLICY_INVALID")
    );
  }
});

test("import policy rejects v1 global grants, invalid capability matrices, and malformed scopes", () => {
  const sparseScopes = new Array(1);
  const sparseObjectTypes = new Array(1);
  const invalidPolicies = [
    {
      schemaVersion: 1,
      capabilities: {
        "snapshot.import.apply": true
      },
      allowedScopes: [createGitHubScope()]
    },
    {
      ...createPolicy(),
      token: "not-allowed"
    },
    createPolicy({
      allowedScopes: [
        createGitHubScope({
          previewAllowed: false,
          applyAllowed: true
        })
      ]
    }),
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
    createPolicy({ allowedScopes: sparseScopes }),
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
  allowedScopes = [
    createGitHubScope(),
    createLinearScope()
  ]
}: {
  allowedScopes?: unknown[];
} = {}) {
  return {
    schemaVersion: 2,
    allowedScopes
  };
}

function createGitHubScope({
  key = "github:repository:netpilot-z/taskseal",
  objectTypes = ["check", "issue", "pull_request"],
  previewAllowed = true,
  applyAllowed = true
}: {
  key?: string;
  objectTypes?: unknown[];
  previewAllowed?: boolean;
  applyAllowed?: boolean;
} = {}) {
  return {
    provider: "github",
    scopeRef: {
      kind: "repository",
      key
    },
    objectTypes,
    capabilities: {
      "snapshot.import.preview": previewAllowed,
      "snapshot.import.apply": applyAllowed
    }
  };
}

function createLinearScope({
  key =
    "linear:team:22222222-2222-4222-8222-222222222222",
  parentKey =
    "linear:organization:33333333-3333-4333-8333-333333333333",
  objectTypes = ["issue"],
  previewAllowed = true,
  applyAllowed = true
}: {
  key?: string;
  parentKey?: string;
  objectTypes?: unknown[];
  previewAllowed?: boolean;
  applyAllowed?: boolean;
} = {}) {
  return {
    provider: "linear",
    scopeRef: {
      kind: "team",
      key,
      parentKey
    },
    objectTypes,
    capabilities: {
      "snapshot.import.preview": previewAllowed,
      "snapshot.import.apply": applyAllowed
    }
  };
}

function createGiteeScope({
  key = "gitee:repository:oschina/git-osc",
  previewAllowed = true,
  applyAllowed = true
}: {
  key?: string;
  previewAllowed?: boolean;
  applyAllowed?: boolean;
} = {}) {
  return {
    provider: "gitee",
    scopeRef: {
      kind: "repository",
      key
    },
    objectTypes: ["issue"],
    capabilities: {
      "snapshot.import.preview": previewAllowed,
      "snapshot.import.apply": applyAllowed
    }
  };
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}
