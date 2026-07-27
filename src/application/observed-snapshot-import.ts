import type {
  Workflow
} from "../domain/workflow.ts";
import {
  validateImportPlanForApply
} from "./import-batch.ts";
import type {
  ImportPlan
} from "./import-plan.ts";
import type {
  ImportProvider
} from "./import-policy.ts";
import {
  previewSnapshotImport as previewSnapshotImportPlan
} from "./snapshot-import.ts";
import type {
  SnapshotImportApplyOptions,
  SnapshotImportApplyResult
} from "./taskseal-service.ts";
import type {
  ProviderObservationScope,
  ProviderObservationTarget
} from "./provider-observation.ts";
import {
  providerObservationScopeMatchesTarget
} from "./provider-observation.ts";
import {
  ProviderObservationCoordinator
} from "./provider-observation-coordinator.ts";

export interface SnapshotImportPreviewOptions {
  snapshot: unknown;
  workflow: Workflow;
  importPolicy: unknown;
}

export interface SnapshotImportApplyPort {
  applySnapshotImport(
    options: SnapshotImportApplyOptions
  ): Promise<SnapshotImportApplyResult>;
}

interface ObservedSnapshotImportFacadeOptions {
  provider: ImportProvider;
  configuredTarget: ProviderObservationTarget;
  boundScope: ProviderObservationScope;
  coordinator: ProviderObservationCoordinator;
  imports: SnapshotImportApplyPort;
}

export class ObservedSnapshotImportFacade {
  readonly #provider: ImportProvider;
  readonly #configuredTarget: ProviderObservationTarget;
  readonly #boundScope: ProviderObservationScope;
  readonly #coordinator: ProviderObservationCoordinator;
  readonly #imports: SnapshotImportApplyPort;

  constructor({
    provider,
    configuredTarget,
    boundScope,
    coordinator,
    imports
  }: ObservedSnapshotImportFacadeOptions) {
    if (
      provider !== "github" &&
      provider !== "linear"
    ) {
      throw new TypeError(
        "Observed snapshot import provider is invalid."
      );
    }
    const normalizedTarget = normalizeTarget(
      provider,
      configuredTarget
    );
    const normalizedScope = normalizeScope(
      provider,
      boundScope
    );
    if (
      !providerObservationScopeMatchesTarget({
      provider,
      configuredTarget: normalizedTarget,
      observedScope: normalizedScope,
      boundScope: normalizedScope
      })
    ) {
      throw new TypeError(
        "Observed snapshot import scope binding is invalid."
      );
    }
    if (
      !imports ||
      typeof imports.applySnapshotImport !== "function"
    ) {
      throw new TypeError(
        "Observed snapshot import apply port is invalid."
      );
    }

    this.#provider = provider;
    this.#configuredTarget = normalizedTarget;
    this.#boundScope = normalizedScope;
    this.#coordinator = coordinator;
    this.#imports = imports;
  }

  previewSnapshotImport(
    options: SnapshotImportPreviewOptions
  ): Promise<ImportPlan> {
    let normalizedSnapshot: unknown;

    return this.#coordinator.preview({
      provider: this.#provider,
      configuredTarget: this.#configuredTarget,
      snapshot: options.snapshot,
      boundScope: this.#boundScope,
      observationSnapshot: () => normalizedSnapshot,
      execute: () => {
        this.assertSnapshotBinding(options.snapshot);
        const plan = previewSnapshotImportPlan(options);
        this.assertPlanBinding(plan);
        normalizedSnapshot =
          createObservationSnapshot(
            options.snapshot,
            plan
          );
        return plan;
      }
    });
  }

  applySnapshotImport(
    options: SnapshotImportApplyOptions
  ): Promise<SnapshotImportApplyResult> {
    let normalizedPlan: ImportPlan | undefined;

    return this.#coordinator.apply({
      provider: this.#provider,
      configuredTarget: this.#configuredTarget,
      plan: options.plan,
      boundScope: this.#boundScope,
      observationPlan: () => normalizedPlan,
      execute: () => {
        normalizedPlan = validateImportPlanForApply(
          options.plan,
          options.expectedPlanDigest
        );
        this.assertPlanBinding(normalizedPlan);
        return this.#imports.applySnapshotImport({
          ...options,
          plan: normalizedPlan,
          expectedPlanDigest: normalizedPlan.planDigest
        });
      }
    });
  }

  private assertPlanBinding(plan: ImportPlan): void {
    if (
      plan.policyBinding.provider !== this.#provider ||
      !scopesEqual(
        plan.policyBinding.scopeRef,
        this.#boundScope
      )
    ) {
      throw new ObservedSnapshotImportBindingError();
    }
  }

  private assertSnapshotBinding(snapshot: unknown): void {
    if (!isPlainRecord(snapshot)) {
      return;
    }

    const provider = readOwnDataProperty(
      snapshot,
      "provider"
    );
    if (
      typeof provider === "string" &&
      provider !== this.#provider
    ) {
      throw new ObservedSnapshotImportBindingError();
    }
    if (provider !== this.#provider) {
      return;
    }

    const scope = tryNormalizeSnapshotScope(
      this.#provider,
      readOwnDataProperty(snapshot, "scope")
    );
    if (
      scope !== null &&
      !scopesEqual(scope, this.#boundScope)
    ) {
      throw new ObservedSnapshotImportBindingError();
    }
  }
}

function createObservationSnapshot(
  snapshot: unknown,
  plan: ImportPlan
): unknown {
  return {
    ...(structuredClone(snapshot) as Record<
      string,
      unknown
    >),
    scope: structuredClone(
      plan.policyBinding.scopeRef
    )
  };
}

class ObservedSnapshotImportBindingError extends Error {
  readonly code = "SNAPSHOT_SCOPE_MISMATCH";

  constructor() {
    super(
      "Snapshot import does not match the configured Provider scope binding."
    );
    this.name = "ObservedSnapshotImportBindingError";
  }
}

function normalizeTarget(
  provider: ImportProvider,
  value: ProviderObservationTarget
): ProviderObservationTarget {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["kind", "key"]) ||
    (value.kind !== "repository" &&
      value.kind !== "team") ||
    typeof value.key !== "string" ||
    !value.key.startsWith(`${provider}:`)
  ) {
    throw new TypeError(
      "Observed snapshot import target is invalid."
    );
  }

  return {
    kind: value.kind,
    key: value.key
  };
}

function normalizeScope(
  provider: ImportProvider,
  value: ProviderObservationScope
): ProviderObservationScope {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "kind",
      "key",
      "parentKey"
    ]) ||
    (value.kind !== "repository" &&
      value.kind !== "team") ||
    typeof value.key !== "string" ||
    !value.key.startsWith(`${provider}:`) ||
    (value.parentKey !== null &&
      (typeof value.parentKey !== "string" ||
        !value.parentKey.startsWith(`${provider}:`)))
  ) {
    throw new TypeError(
      "Observed snapshot import resolved scope is invalid."
    );
  }

  return {
    kind: value.kind,
    key: value.key,
    parentKey: value.parentKey
  };
}

function scopesEqual(
  left: {
    kind: "repository" | "team";
    key: string;
    parentKey?: string | null | undefined;
  },
  right: ProviderObservationScope
): boolean {
  return (
    left.kind === right.kind &&
    left.key === right.key &&
    (left.parentKey ?? null) === right.parentKey
  );
}

function tryNormalizeSnapshotScope(
  provider: ImportProvider,
  value: unknown
): ProviderObservationScope | null {
  if (
    !isPlainRecord(value) ||
    typeof value.kind !== "string" ||
    typeof value.key !== "string"
  ) {
    return null;
  }

  if (
    provider === "github" &&
    hasExactKeys(value, ["kind", "key"]) &&
    value.kind === "repository"
  ) {
    return {
      kind: "repository",
      key: value.key.toLowerCase(),
      parentKey: null
    };
  }

  if (
    provider === "linear" &&
    hasExactKeys(value, [
      "kind",
      "key",
      "parentKey"
    ]) &&
    value.kind === "team" &&
    typeof value.parentKey === "string"
  ) {
    return {
      kind: "team",
      key: value.key.toLowerCase(),
      parentKey: value.parentKey.toLowerCase()
    };
  }

  return null;
}

function readOwnDataProperty(
  value: Record<string, unknown>,
  key: string
): unknown {
  const descriptor =
    Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function isPlainRecord(
  value: unknown
): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype ||
      prototype === null) &&
    Object.values(
      Object.getOwnPropertyDescriptors(value)
    ).every(
      (descriptor) =>
        "value" in descriptor &&
        descriptor.enumerable === true
    )
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every(
      (key, index) => key === expected[index]
    )
  );
}
