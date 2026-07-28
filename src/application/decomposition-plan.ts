import {
  assertJsonWithinLimits,
  digestCanonicalJson
} from "../lib/canonical-json.ts";
import {
  parseRunnerManifest
} from "../runners/runner-contract.ts";
import type {
  RunnerCapabilityManifest,
  RunnerHandoffKind,
  RunnerWorkspaceAccess
} from "../runners/runner-contract.ts";

const MAX_PROFILES = 32;
const MAX_NODES = 32;
const MAX_EDGES = 128;
const MAX_SET_VALUES = 16;
const MAX_ID_LENGTH = 128;
const MAX_INSTRUCTION_LENGTH = 32_768;
const MAX_DESCRIPTION_LENGTH = 2_048;
const MAX_TIMEOUT_MS =
  24 * 60 * 60 * 1_000;
const MAX_BACKOFF_MS = 60 * 60 * 1_000;
const MAX_PLAN_BYTES = 1024 * 1024;
const ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REVISION_PATTERN =
  /^sha256:[0-9a-f]{64}$/;

export interface DigitalEmployeeProfile {
  readonly runnerId: string;
  readonly displayName: string;
  readonly profileRevision: string;
  readonly skillTags: readonly string[];
  readonly allowedWorkspaceAccess:
    readonly RunnerWorkspaceAccess[];
  readonly handoffKinds:
    readonly RunnerHandoffKind[];
  readonly manifest: RunnerCapabilityManifest;
}

export interface PreparedDecompositionCriterion {
  readonly key: string;
  readonly description: string;
}

export interface PreparedDecompositionNode {
  readonly nodeId: string;
  readonly workItemId: string;
  readonly instruction: string;
  readonly dependsOn: readonly string[];
  readonly owner: {
    readonly runnerId: string;
    readonly profileRevision: string;
  };
  readonly requirements: {
    readonly skillTags: readonly string[];
    readonly handoffKinds:
      readonly RunnerHandoffKind[];
  };
  readonly execution: {
    readonly workspaceAccess:
      RunnerWorkspaceAccess;
    readonly timeoutMs: number;
  };
  readonly acceptanceCriteria:
    readonly PreparedDecompositionCriterion[];
  readonly retryPolicy: {
    readonly maxAttempts: number;
    readonly backoffMs: number;
    readonly retryOn: readonly ["failed"];
  };
}

export interface PreparedDecompositionPlan {
  readonly schemaVersion: "1";
  readonly planId: string;
  readonly rootWorkItemId: string;
  readonly dispatch: {
    readonly maxParallelism: number;
    readonly maxQueuedNodes: number;
  };
  readonly nodes:
    readonly PreparedDecompositionNode[];
  readonly topologicalOrder:
    readonly string[];
}

export interface DecompositionPlanPreview {
  readonly plan: PreparedDecompositionPlan;
  readonly planDigest: string;
}

export interface DecompositionWorkItemReference {
  readonly id: string;
  readonly requiredEvidence:
    readonly string[];
}

export interface PrepareDecompositionPlanOptions {
  readonly registry: DigitalEmployeeRegistry;
  readonly getWorkItem: (
    workItemId: string
  ) => DecompositionWorkItemReference | null;
}

export class DigitalEmployeeRegistry {
  readonly #profiles:
    ReadonlyMap<string, DigitalEmployeeProfile>;

  constructor(
    profiles: readonly DigitalEmployeeProfile[]
  ) {
    this.#profiles = new Map(
      profiles.map((profile) => [
        profile.runnerId,
        profile
      ])
    );
  }

  get(
    runnerId: string
  ): DigitalEmployeeProfile | null {
    return this.#profiles.get(runnerId) ?? null;
  }

  matches(
    node: PreparedDecompositionNode
  ): boolean {
    const profile = this.get(
      node.owner.runnerId
    );
    return (
      profile !== null &&
      profile.profileRevision ===
        node.owner.profileRevision &&
      node.requirements.skillTags.every(
        (tag) =>
          profile.skillTags.includes(tag)
      ) &&
      node.requirements.handoffKinds.every(
        (kind) =>
          profile.handoffKinds.includes(kind)
      ) &&
      profile.allowedWorkspaceAccess.includes(
        node.execution.workspaceAccess
      )
    );
  }

  list(): readonly DigitalEmployeeProfile[] {
    return Object.freeze(
      [...this.#profiles.values()].toSorted(
        (left, right) =>
          compareStrings(
            left.runnerId,
            right.runnerId
          )
      )
    );
  }
}

export function createDigitalEmployeeRegistry(
  value: unknown
): DigitalEmployeeRegistry {
  try {
    const entries = readArray(
      value,
      "digital employee profiles",
      1,
      MAX_PROFILES
    );
    const profiles = entries.map(
      decodeDigitalEmployeeProfile
    );
    const runnerIds = new Set(
      profiles.map(
        (profile) => profile.runnerId
      )
    );
    if (runnerIds.size !== profiles.length) {
      throw invalidInput(
        "Digital employee runner IDs must be unique."
      );
    }

    return new DigitalEmployeeRegistry(
      profiles
    );
  } catch (error) {
    throw normalizeError(error);
  }
}

export function prepareDecompositionPlan(
  value: unknown,
  {
    registry,
    getWorkItem
  }: PrepareDecompositionPlanOptions
): DecompositionPlanPreview {
  try {
    if (
      !(registry instanceof
        DigitalEmployeeRegistry) ||
      typeof getWorkItem !== "function"
    ) {
      throw invalidInput(
        "Decomposition preparation requires a trusted registry and WorkItem query."
      );
    }

    const draft = readExactRecord(
      value,
      [
        "schemaVersion",
        "planId",
        "rootWorkItemId",
        "dispatch",
        "nodes"
      ],
      "decomposition plan"
    );
    if (draft.schemaVersion !== "1") {
      throw invalidInput(
        "Decomposition schemaVersion must be 1."
      );
    }
    const planId = readIdentifier(
      draft.planId,
      "planId"
    );
    const rootWorkItemId = readIdentifier(
      draft.rootWorkItemId,
      "rootWorkItemId"
    );
    const dispatch = decodeDispatch(
      draft.dispatch
    );
    const rawNodes = readArray(
      draft.nodes,
      "decomposition nodes",
      1,
      MAX_NODES
    );
    if (
      rawNodes.length >
      dispatch.maxQueuedNodes
    ) {
      throw invalidInput(
        "The approved queue bound must cover every decomposition node."
      );
    }
    if (!getWorkItem(rootWorkItemId)) {
      throw planError(
        "DECOMPOSITION_WORK_ITEM_NOT_FOUND",
        "The decomposition root WorkItem does not exist."
      );
    }

    const nodes = rawNodes.map((rawNode) =>
      decodeDraftNode(rawNode, {
        registry,
        getWorkItem,
        rootWorkItemId
      })
    );
    validateUniqueNodes(nodes);
    const topologicalOrder =
      computeTopologicalOrder(nodes);
    const plan = freezePlan({
      schemaVersion: "1",
      planId,
      rootWorkItemId,
      dispatch,
      nodes: nodes.toSorted(
        (left, right) =>
          compareStrings(
            left.nodeId,
            right.nodeId
          )
      ),
      topologicalOrder
    });

    assertJsonWithinLimits(plan, {
      maxDepth: 12,
      maxBytes: MAX_PLAN_BYTES,
      maxArrayLength: MAX_NODES,
      maxObjectKeys: 16
    });

    return Object.freeze({
      plan,
      planDigest:
        digestCanonicalJson(plan, {
          maxDepth: 12
        })
    });
  } catch (error) {
    throw normalizeError(error);
  }
}

export function parsePreparedDecompositionPlan(
  value: unknown
): PreparedDecompositionPlan {
  try {
    const plan = readExactRecord(
      value,
      [
        "schemaVersion",
        "planId",
        "rootWorkItemId",
        "dispatch",
        "nodes",
        "topologicalOrder"
      ],
      "prepared decomposition plan"
    );
    if (plan.schemaVersion !== "1") {
      throw invalidInput(
        "Prepared decomposition schemaVersion must be 1."
      );
    }
    const nodes = readArray(
      plan.nodes,
      "prepared decomposition nodes",
      1,
      MAX_NODES
    ).map(decodePreparedNode);
    validateUniqueNodes(nodes);
    const rootWorkItemId =
      readIdentifier(
        plan.rootWorkItemId,
        "rootWorkItemId"
      );
    if (
      nodes.some(
        (node) =>
          node.workItemId ===
          rootWorkItemId
      )
    ) {
      throw graphInvalid(
        "The root WorkItem cannot be a decomposition node."
      );
    }
    const expectedOrder =
      computeTopologicalOrder(nodes);
    const suppliedOrder =
      readIdentifierSequence(
      plan.topologicalOrder,
      "topologicalOrder",
      nodes.length
    );

    if (
      suppliedOrder.length !==
        expectedOrder.length ||
      suppliedOrder.some(
        (nodeId, index) =>
          nodeId !== expectedOrder[index]
      )
    ) {
      throw graphInvalid(
        "Prepared topological order does not match the DAG."
      );
    }

    const normalized = freezePlan({
      schemaVersion: "1",
      planId: readIdentifier(
        plan.planId,
        "planId"
      ),
      rootWorkItemId,
      dispatch: decodeDispatch(
        plan.dispatch
      ),
      nodes: nodes.toSorted(
        (left, right) =>
          compareStrings(
            left.nodeId,
            right.nodeId
          )
      ),
      topologicalOrder: expectedOrder
    });

    if (
      normalized.nodes.length >
      normalized.dispatch.maxQueuedNodes
    ) {
      throw invalidInput(
        "The prepared queue bound does not cover every node."
      );
    }
    assertJsonWithinLimits(normalized, {
      maxDepth: 12,
      maxBytes: MAX_PLAN_BYTES,
      maxArrayLength: MAX_NODES,
      maxObjectKeys: 16
    });
    return normalized;
  } catch (error) {
    throw normalizeError(error);
  }
}

function decodeDigitalEmployeeProfile(
  value: unknown
): DigitalEmployeeProfile {
  const entry = readExactRecord(
    value,
    [
      "manifest",
      "allowedWorkspaceAccess",
      "skillTags"
    ],
    "digital employee profile"
  );
  const manifest = parseRunnerManifest(
    entry.manifest
  );
  const allowedWorkspaceAccess =
    readEnumSet(
      entry.allowedWorkspaceAccess,
      "allowedWorkspaceAccess",
      [
        "read-only",
        "workspace-write"
      ] as const,
      1,
      2
    );
  if (
    allowedWorkspaceAccess.some(
      (access) =>
        !manifest.capabilities
          .workspaceAccess
          .includes(access)
    )
  ) {
    throw invalidInput(
      "Host workspace permission cannot exceed the Runner manifest."
    );
  }
  const skillTags = readStringSet(
    entry.skillTags,
    "skillTags",
    1,
    MAX_SET_VALUES
  );
  const handoffKinds = Object.freeze([
    ...manifest.capabilities
      .handoffKinds
  ]);
  const profileRevision =
    digestCanonicalJson({
      runnerId: manifest.runnerId,
      manifest,
      allowedWorkspaceAccess,
      skillTags
    });

  return Object.freeze({
    runnerId: manifest.runnerId,
    displayName: manifest.displayName,
    profileRevision,
    skillTags,
    allowedWorkspaceAccess,
    handoffKinds,
    manifest
  });
}

function decodeDispatch(value: unknown) {
  const dispatch = readExactRecord(
    value,
    [
      "maxParallelism",
      "maxQueuedNodes"
    ],
    "dispatch policy"
  );
  const maxParallelism = readInteger(
    dispatch.maxParallelism,
    "maxParallelism",
    1,
    8
  );
  const maxQueuedNodes = readInteger(
    dispatch.maxQueuedNodes,
    "maxQueuedNodes",
    1,
    MAX_NODES
  );
  return Object.freeze({
    maxParallelism,
    maxQueuedNodes
  });
}

function decodeDraftNode(
  value: unknown,
  {
    registry,
    getWorkItem,
    rootWorkItemId
  }: PrepareDecompositionPlanOptions & {
    rootWorkItemId: string;
  }
): PreparedDecompositionNode {
  const node = readExactRecord(
    value,
    [
      "nodeId",
      "workItemId",
      "instruction",
      "dependsOn",
      "ownerRunnerId",
      "requirements",
      "execution",
      "acceptanceCriteria",
      "retryPolicy"
    ],
    "decomposition node"
  );
  const nodeId = readIdentifier(
    node.nodeId,
    "nodeId"
  );
  const workItemId = readIdentifier(
    node.workItemId,
    "workItemId"
  );
  if (workItemId === rootWorkItemId) {
    throw graphInvalid(
      "The root WorkItem cannot also be a decomposition node."
    );
  }
  const workItem = getWorkItem(workItemId);
  if (!workItem) {
    throw planError(
      "DECOMPOSITION_WORK_ITEM_NOT_FOUND",
      "A decomposition node WorkItem does not exist."
    );
  }
  const ownerRunnerId = readIdentifier(
    node.ownerRunnerId,
    "ownerRunnerId"
  );
  const requirements =
    decodeRequirements(
      node.requirements
    );
  const execution = decodeExecution(
    node.execution
  );
  const owner = registry.get(
    ownerRunnerId
  );
  if (
    owner === null ||
    !requirements.skillTags.every(
      (tag) =>
        owner.skillTags.includes(tag)
    ) ||
    !requirements.handoffKinds.every(
      (kind) =>
        owner.handoffKinds.includes(kind)
    ) ||
    !owner.allowedWorkspaceAccess.includes(
      execution.workspaceAccess
    )
  ) {
    throw planError(
      "DECOMPOSITION_OWNER_UNAVAILABLE",
      "The assigned digital employee does not satisfy the approved capability and permission requirements."
    );
  }
  const acceptanceCriteria =
    decodeAcceptanceCriteria(
      node.acceptanceCriteria
    );
  assertEvidenceBinding(
    workItem.requiredEvidence,
    acceptanceCriteria
  );

  return freezeNode({
    nodeId,
    workItemId,
    instruction: readText(
      node.instruction,
      "instruction",
      MAX_INSTRUCTION_LENGTH
    ),
    dependsOn: readIdentifierSet(
      node.dependsOn,
      "dependsOn",
      MAX_NODES - 1
    ),
    owner: {
      runnerId: owner.runnerId,
      profileRevision:
        owner.profileRevision
    },
    requirements,
    execution,
    acceptanceCriteria,
    retryPolicy: decodeRetryPolicy(
      node.retryPolicy
    )
  });
}

function decodePreparedNode(
  value: unknown
): PreparedDecompositionNode {
  const node = readExactRecord(
    value,
    [
      "nodeId",
      "workItemId",
      "instruction",
      "dependsOn",
      "owner",
      "requirements",
      "execution",
      "acceptanceCriteria",
      "retryPolicy"
    ],
    "prepared decomposition node"
  );
  const owner = readExactRecord(
    node.owner,
    [
      "runnerId",
      "profileRevision"
    ],
    "prepared node owner"
  );
  const profileRevision = readText(
    owner.profileRevision,
    "profileRevision",
    80
  );
  if (
    !REVISION_PATTERN.test(
      profileRevision
    )
  ) {
    throw invalidInput(
      "Prepared owner profileRevision is invalid."
    );
  }

  return freezeNode({
    nodeId: readIdentifier(
      node.nodeId,
      "nodeId"
    ),
    workItemId: readIdentifier(
      node.workItemId,
      "workItemId"
    ),
    instruction: readText(
      node.instruction,
      "instruction",
      MAX_INSTRUCTION_LENGTH
    ),
    dependsOn: readIdentifierSet(
      node.dependsOn,
      "dependsOn",
      MAX_NODES - 1
    ),
    owner: {
      runnerId: readIdentifier(
        owner.runnerId,
        "runnerId"
      ),
      profileRevision
    },
    requirements:
      decodeRequirements(
        node.requirements
      ),
    execution: decodeExecution(
      node.execution
    ),
    acceptanceCriteria:
      decodeAcceptanceCriteria(
        node.acceptanceCriteria
      ),
    retryPolicy: decodeRetryPolicy(
      node.retryPolicy
    )
  });
}

function decodeRequirements(value: unknown) {
  const requirements = readExactRecord(
    value,
    ["skillTags", "handoffKinds"],
    "node requirements"
  );
  return Object.freeze({
    skillTags: readStringSet(
      requirements.skillTags,
      "skillTags",
      1,
      MAX_SET_VALUES
    ),
    handoffKinds: readEnumSet(
      requirements.handoffKinds,
      "handoffKinds",
      ["artifact", "evidence"] as const,
      0,
      2
    )
  });
}

function decodeExecution(value: unknown) {
  const execution = readExactRecord(
    value,
    ["workspaceAccess", "timeoutMs"],
    "node execution"
  );
  const workspaceAccess =
    execution.workspaceAccess;
  if (
    workspaceAccess !== "read-only" &&
    workspaceAccess !==
      "workspace-write"
  ) {
    throw invalidInput(
      "Node workspaceAccess is invalid."
    );
  }
  return Object.freeze({
    workspaceAccess,
    timeoutMs: readInteger(
      execution.timeoutMs,
      "timeoutMs",
      1,
      MAX_TIMEOUT_MS
    )
  });
}

function decodeAcceptanceCriteria(
  value: unknown
): readonly PreparedDecompositionCriterion[] {
  const criteria = readArray(
    value,
    "acceptance criteria",
    1,
    MAX_SET_VALUES
  ).map((entry) => {
    const criterion = readExactRecord(
      entry,
      ["key", "description"],
      "acceptance criterion"
    );
    return Object.freeze({
      key: readIdentifier(
        criterion.key,
        "criterion key"
      ),
      description: readText(
        criterion.description,
        "criterion description",
        MAX_DESCRIPTION_LENGTH
      )
    });
  }).toSorted((left, right) =>
    compareStrings(left.key, right.key)
  );
  if (
    new Set(
      criteria.map(
        (criterion) => criterion.key
      )
    ).size !== criteria.length
  ) {
    throw invalidInput(
      "Acceptance criterion keys must be unique."
    );
  }
  return Object.freeze(criteria);
}

function decodeRetryPolicy(value: unknown) {
  const policy = readExactRecord(
    value,
    [
      "maxAttempts",
      "backoffMs",
      "retryOn"
    ],
    "retry policy"
  );
  const retryOn = readEnumSet(
    policy.retryOn,
    "retryOn",
    ["failed"] as const,
    1,
    1
  );
  if (
    retryOn.length !== 1 ||
    retryOn[0] !== "failed"
  ) {
    throw invalidInput(
      "The v1 retry policy supports failed attempts only."
    );
  }
  return Object.freeze({
    maxAttempts: readInteger(
      policy.maxAttempts,
      "maxAttempts",
      1,
      3
    ),
    backoffMs: readInteger(
      policy.backoffMs,
      "backoffMs",
      0,
      MAX_BACKOFF_MS
    ),
    retryOn:
      Object.freeze([
        "failed"
      ]) as readonly ["failed"]
  });
}

function assertEvidenceBinding(
  requiredEvidence:
    readonly string[],
  criteria:
    readonly PreparedDecompositionCriterion[]
): void {
  const expected = [
    ...requiredEvidence
  ].toSorted(compareStrings);
  const actual = criteria
    .map((criterion) => criterion.key)
    .toSorted(compareStrings);
  if (
    expected.length !== actual.length ||
    expected.some(
      (key, index) =>
        key !== actual[index]
    )
  ) {
    throw planError(
      "DECOMPOSITION_EVIDENCE_MISMATCH",
      "Node acceptance criteria must exactly match the referenced WorkItem evidence contract."
    );
  }
}

function validateUniqueNodes(
  nodes: readonly PreparedDecompositionNode[]
): void {
  const nodeIds = new Set<string>();
  const workItemIds = new Set<string>();
  let edgeCount = 0;
  for (const node of nodes) {
    if (
      nodeIds.has(node.nodeId) ||
      workItemIds.has(node.workItemId)
    ) {
      throw graphInvalid(
        "Node and WorkItem identities must be unique within a decomposition."
      );
    }
    nodeIds.add(node.nodeId);
    workItemIds.add(node.workItemId);
    edgeCount += node.dependsOn.length;
  }
  if (edgeCount > MAX_EDGES) {
    throw graphInvalid(
      "The decomposition exceeds the dependency edge limit."
    );
  }
}

function computeTopologicalOrder(
  nodes: readonly PreparedDecompositionNode[]
): readonly string[] {
  const byId = new Map(
    nodes.map((node) => [
      node.nodeId,
      node
    ])
  );
  const indegree = new Map(
    nodes.map((node) => [
      node.nodeId,
      node.dependsOn.length
    ])
  );
  const dependents = new Map<
    string,
    string[]
  >(
    nodes.map((node) => [
      node.nodeId,
      []
    ])
  );

  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (
        dependency === node.nodeId ||
        !byId.has(dependency)
      ) {
        throw graphInvalid(
          "Every dependency must reference another node in the same plan."
        );
      }
      dependents.get(dependency)?.push(
        node.nodeId
      );
    }
  }
  for (const values of dependents.values()) {
    values.sort(compareStrings);
  }

  const ready = nodes
    .filter(
      (node) =>
        indegree.get(node.nodeId) === 0
    )
    .map((node) => node.nodeId)
    .sort(compareStrings);
  const result: string[] = [];

  while (ready.length > 0) {
    const nodeId = ready.shift();
    if (nodeId === undefined) {
      break;
    }
    result.push(nodeId);
    for (
      const dependent of
        dependents.get(nodeId) ?? []
    ) {
      const next =
        (indegree.get(dependent) ?? 0) -
        1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort(compareStrings);
      }
    }
  }

  if (result.length !== nodes.length) {
    throw graphInvalid(
      "The decomposition dependency graph contains a cycle."
    );
  }
  return Object.freeze(result);
}

function freezePlan(
  plan: PreparedDecompositionPlan
): PreparedDecompositionPlan {
  return Object.freeze({
    schemaVersion: "1",
    planId: plan.planId,
    rootWorkItemId:
      plan.rootWorkItemId,
    dispatch: Object.freeze({
      maxParallelism:
        plan.dispatch.maxParallelism,
      maxQueuedNodes:
        plan.dispatch.maxQueuedNodes
    }),
    nodes: Object.freeze([
      ...plan.nodes
    ]),
    topologicalOrder: Object.freeze([
      ...plan.topologicalOrder
    ])
  });
}

function freezeNode(
  node: PreparedDecompositionNode
): PreparedDecompositionNode {
  return Object.freeze({
    nodeId: node.nodeId,
    workItemId: node.workItemId,
    instruction: node.instruction,
    dependsOn: Object.freeze([
      ...node.dependsOn
    ]),
    owner: Object.freeze({
      runnerId: node.owner.runnerId,
      profileRevision:
        node.owner.profileRevision
    }),
    requirements: Object.freeze({
      skillTags: Object.freeze([
        ...node.requirements.skillTags
      ]),
      handoffKinds: Object.freeze([
        ...node.requirements
          .handoffKinds
      ])
    }),
    execution: Object.freeze({
      workspaceAccess:
        node.execution.workspaceAccess,
      timeoutMs: node.execution.timeoutMs
    }),
    acceptanceCriteria:
      Object.freeze(
        node.acceptanceCriteria.map(
          (criterion) =>
            Object.freeze({
              key: criterion.key,
              description:
                criterion.description
            })
        )
      ),
    retryPolicy: Object.freeze({
      maxAttempts:
        node.retryPolicy.maxAttempts,
      backoffMs:
        node.retryPolicy.backoffMs,
      retryOn:
        Object.freeze([
          "failed"
        ]) as readonly ["failed"]
    })
  });
}

function readExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string
): Record<string, unknown> {
  if (
    !isPlainDataObject(value) ||
    Object.keys(value).length !==
      expectedKeys.length ||
    expectedKeys.some(
      (key) =>
        !Object.prototype.hasOwnProperty.call(
          value,
          key
        )
    )
  ) {
    throw invalidInput(
      `${label} must contain only the exact v1 fields.`
    );
  }
  return value;
}

function isPlainDataObject(
  value: unknown
): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !==
      Object.prototype ||
    Object.getOwnPropertySymbols(value)
      .length > 0
  ) {
    return false;
  }
  return Object.values(
    Object.getOwnPropertyDescriptors(value)
  ).every(
    (descriptor) =>
      "value" in descriptor &&
      descriptor.enumerable === true
  );
}

function readArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !==
      Array.prototype ||
    Object.getOwnPropertySymbols(value)
      .length > 0 ||
    value.length < minimum ||
    value.length > maximum
  ) {
    throw invalidInput(
      `${label} has an invalid size or shape.`
    );
  }
  for (
    let index = 0;
    index < value.length;
    index += 1
  ) {
    const descriptor =
      Object.getOwnPropertyDescriptor(
        value,
        String(index)
      );
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw invalidInput(
        `${label} must be a dense data array.`
      );
    }
  }
  return value;
}

function readStringSet(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): readonly string[] {
  const values = readArray(
    value,
    label,
    minimum,
    maximum
  ).map((entry) =>
    readIdentifier(entry, label)
  );
  if (
    new Set(values).size !==
    values.length
  ) {
    throw invalidInput(
      `${label} must not contain duplicates.`
    );
  }
  return Object.freeze(
    values.toSorted(compareStrings)
  );
}

function readIdentifierSet(
  value: unknown,
  label: string,
  maximum: number
): readonly string[] {
  return readStringSet(
    value,
    label,
    0,
    maximum
  );
}

function readIdentifierSequence(
  value: unknown,
  label: string,
  maximum: number
): readonly string[] {
  const values = readArray(
    value,
    label,
    0,
    maximum
  ).map((entry) =>
    readIdentifier(entry, label)
  );
  if (
    new Set(values).size !==
    values.length
  ) {
    throw invalidInput(
      `${label} must not contain duplicates.`
    );
  }
  return Object.freeze(values);
}

function readEnumSet<
  Value extends string
>(
  value: unknown,
  label: string,
  allowed: readonly Value[],
  minimum: number,
  maximum: number
): readonly Value[] {
  const values = readArray(
    value,
    label,
    minimum,
    maximum
  );
  if (
    values.some(
      (entry) =>
        typeof entry !== "string" ||
        !allowed.includes(entry as Value)
    ) ||
    new Set(values).size !==
      values.length
  ) {
    throw invalidInput(
      `${label} contains an unsupported or duplicate value.`
    );
  }
  return Object.freeze(
    [...(values as Value[])].toSorted(
      compareStrings
    )
  );
}

function readIdentifier(
  value: unknown,
  label: string
): string {
  const text = readText(
    value,
    label,
    MAX_ID_LENGTH
  );
  if (!ID_PATTERN.test(text)) {
    throw invalidInput(
      `${label} is not a safe identifier.`
    );
  }
  return text;
}

function readText(
  value: unknown,
  label: string,
  maximumCodePoints: number
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !value.isWellFormed() ||
    [...value].length >
      maximumCodePoints ||
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(
      value
    )
  ) {
    throw invalidInput(
      `${label} is invalid or exceeds its boundary.`
    );
  }
  return value;
}

function readInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalidInput(
      `${label} must be an integer between ${minimum} and ${maximum}.`
    );
  }
  return value;
}

function compareStrings(
  left: string,
  right: string
): number {
  return left < right
    ? -1
    : left > right
      ? 1
      : 0;
}

function graphInvalid(
  message: string
): DecompositionPlanError {
  return planError(
    "DECOMPOSITION_GRAPH_INVALID",
    message
  );
}

function invalidInput(
  message: string
): DecompositionPlanError {
  return planError(
    "DECOMPOSITION_INPUT_INVALID",
    message
  );
}

function normalizeError(
  error: unknown
): DecompositionPlanError {
  if (
    error instanceof
    DecompositionPlanError
  ) {
    return error;
  }
  return invalidInput(
    "The decomposition plan is invalid."
  );
}

function planError(
  code: string,
  message: string,
  options?: ErrorOptions
): DecompositionPlanError {
  return new DecompositionPlanError(
    code,
    message,
    options
  );
}

export class DecompositionPlanError extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name =
      "DecompositionPlanError";
    this.code = code;
  }
}
