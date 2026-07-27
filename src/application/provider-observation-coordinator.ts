import {
  getGiteeCoordinates,
  getGitHubCoordinates,
  getLinearCoordinates
} from "../config/project-config.ts";
import type {
  ProjectConfiguration
} from "../config/project-config.ts";
import type {
  ProviderName
} from "../lib/provider-snapshot.ts";
import {
  providerObservationScopeMatchesTarget,
  projectProviderFailure,
  projectProviderSnapshot
} from "./provider-observation.ts";
import type {
  ProviderObservationCommandPort,
  ProviderObservationInput,
  ProviderObservationScope,
  ProviderObservationTarget
} from "./provider-observation.ts";

interface ProviderObservationCoordinatorOptions {
  observations: ProviderObservationCommandPort;
  clock?: (() => unknown) | undefined;
}

interface ObserveInspectionOptions<T> {
  provider: ProviderName;
  configuredTarget: ProviderObservationTarget;
  kind: "health" | "snapshot";
  execute: () => T | Promise<T>;
  missingEvidence?: string[] | undefined;
  verifiedLinearScopeBinding?: boolean | undefined;
}

interface ObservePreviewOptions<T> {
  provider: ProviderName;
  configuredTarget: ProviderObservationTarget;
  snapshot: unknown;
  boundScope?: ProviderObservationScope | undefined;
  observationSnapshot?: (() => unknown) | undefined;
  execute: () => T | Promise<T>;
}

interface ObserveApplyOptions<T> {
  provider: ProviderName;
  configuredTarget: ProviderObservationTarget;
  plan: unknown;
  boundScope?: ProviderObservationScope | undefined;
  observationPlan?: (() => unknown) | undefined;
  execute: () => T | Promise<T>;
}

export class ProviderObservationCoordinator {
  readonly #observations: ProviderObservationCommandPort;
  readonly #clock: () => unknown;

  constructor({
    observations,
    clock = () => new Date()
  }: ProviderObservationCoordinatorOptions) {
    this.#observations = observations;
    this.#clock = clock;
  }

  async inspect<T>({
    provider,
    configuredTarget,
    kind,
    execute,
    missingEvidence = [],
    verifiedLinearScopeBinding = false
  }: ObserveInspectionOptions<T>): Promise<T> {
    const startedAt = this.captureTimestamp();

    try {
      const result = await execute();
      if (startedAt !== null) {
        const observedAt =
          this.captureTimestamp() ?? startedAt;
        await this.recordBestEffort(() =>
          kind === "health"
            ? projectProviderHealth({
                provider,
                configuredTarget,
                startedAt,
                observedAt,
                health: result
              })
            : projectProviderSnapshot({
                operation: "inspection",
                configuredTarget,
                startedAt,
                observedAt,
                snapshot: result,
                verifiedLinearScopeBinding
              })
        );
      }
      return result;
    } catch (error) {
      if (startedAt !== null) {
        const observedAt =
          this.captureTimestamp() ?? startedAt;
        await this.recordBestEffort(() =>
          projectProviderFailure({
            operation: "inspection",
            provider,
            configuredTarget,
            startedAt,
            observedAt,
            error,
            missingEvidence
          })
        );
      }
      throw error;
    }
  }

  async preview<T>({
    provider,
    configuredTarget,
    snapshot,
    boundScope,
    observationSnapshot,
    execute
  }: ObservePreviewOptions<T>): Promise<T> {
    const startedAt = this.captureTimestamp();

    try {
      const result = await execute();
      if (startedAt !== null) {
        const observedAt =
          this.captureTimestamp() ?? startedAt;
        await this.recordBestEffort(() =>
          projectProviderSnapshot({
            operation: "snapshot.preview",
            configuredTarget,
            startedAt,
            observedAt,
            snapshot:
              observationSnapshot?.() ?? snapshot,
            snapshotDigest: readDigest(
              result,
              "snapshotDigest"
            ),
            mappingDigest: readDigest(
              result,
              "mappingDigest"
            ),
            planDigest: readDigest(result, "planDigest"),
            verifiedLinearScopeBinding:
              provider === "linear" &&
              boundScope !== undefined
          })
        );
      }
      return result;
    } catch (error) {
      if (startedAt !== null) {
        const observedAt =
          this.captureTimestamp() ?? startedAt;
        await this.recordBestEffort(() =>
          projectProviderFailure({
            operation: "snapshot.preview",
            provider,
            configuredTarget,
            startedAt,
            observedAt,
            error
          })
        );
      }
      throw error;
    }
  }

  async apply<T>({
    provider,
    configuredTarget,
    plan,
    boundScope,
    observationPlan,
    execute
  }: ObserveApplyOptions<T>): Promise<T> {
    const startedAt = this.captureTimestamp();

    try {
      const result = await execute();
      if (startedAt !== null) {
        const observedAt =
          this.captureTimestamp() ?? startedAt;
        await this.recordBestEffort(() =>
          projectProviderApply({
            provider,
            configuredTarget,
            plan: observationPlan?.() ?? plan,
            result,
            startedAt,
            observedAt,
            boundScope
          })
        );
      }
      return result;
    } catch (error) {
      if (startedAt !== null) {
        const observedAt =
          this.captureTimestamp() ?? startedAt;
        await this.recordBestEffort(() =>
          projectProviderFailure({
            operation: "snapshot.import",
            provider,
            configuredTarget,
            startedAt,
            observedAt,
            error
          })
        );
      }
      throw error;
    }
  }

  private captureTimestamp(): string | null {
    try {
      const value = this.#clock();
      return value instanceof Date &&
        Number.isFinite(value.getTime())
        ? value.toISOString()
        : null;
    } catch {
      return null;
    }
  }

  private async recordBestEffort(
    project: () => ProviderObservationInput
  ): Promise<void> {
    try {
      await this.#observations.record(project());
    } catch {
      // Observation persistence cannot replace the provider operation outcome.
    }
  }
}

export function configuredTargetForProvider(
  configuration: ProjectConfiguration,
  provider: ProviderName
): ProviderObservationTarget {
  if (provider === "github") {
    const { repository } =
      getGitHubCoordinates(configuration);
    return {
      kind: "repository",
      key: `github:repository:${repository.toLowerCase()}`
    };
  }

  if (provider === "gitee") {
    const { repository } =
      getGiteeCoordinates(configuration);
    return {
      kind: "repository",
      key: `gitee:repository:${repository}`
    };
  }

  const { workspace, team } =
    getLinearCoordinates(configuration);
  return {
    kind: "team",
    key:
      "linear:team-ref:" +
      `${encodeScopeReference(workspace)}/` +
      encodeScopeReference(team)
  };
}

export function fallbackConfiguredTarget(
  provider: ProviderName
): ProviderObservationTarget {
  return {
    kind: "provider",
    key: `${provider}:configuration`
  };
}

export function projectProviderConfiguration({
  provider,
  configuredTarget,
  observedAt
}: {
  provider: ProviderName;
  configuredTarget: ProviderObservationTarget;
  observedAt: string;
}): ProviderObservationInput {
  return {
    operation: "configuration",
    provider,
    configuredTarget,
    observedScope: null,
    status: "configured",
    startedAt: observedAt,
    observedAt,
    sourceRevisions: [],
    snapshotDigest: null,
    mappingDigest: null,
    planDigest: null,
    missingEvidence: [],
    diagnosticCode: null,
    resolution: null
  };
}

function projectProviderHealth({
  provider,
  configuredTarget,
  startedAt,
  observedAt,
  health
}: {
  provider: ProviderName;
  configuredTarget: ProviderObservationTarget;
  startedAt: string;
  observedAt: string;
  health: unknown;
}): ProviderObservationInput {
  if (
    !isPlainDataRecord(health) ||
    health.provider !== provider ||
    health.status !== "ready"
  ) {
    throw new TypeError(
      "Provider health result is invalid."
    );
  }

  const observedScope = readScope(
    health.scope,
    provider
  );
  if (
    !providerObservationScopeMatchesTarget({
      provider,
      configuredTarget,
      observedScope
    })
  ) {
    return projectProviderFailure({
      operation: "inspection",
      provider,
      configuredTarget,
      observedScope,
      startedAt,
      observedAt,
      error: {
        code: "PROVIDER_OBSERVATION_SCOPE_MISMATCH"
      }
    });
  }

  return {
    operation: "inspection",
    provider,
    configuredTarget,
    observedScope,
    status: "configured",
    startedAt,
    observedAt,
    sourceRevisions: [],
    snapshotDigest: null,
    mappingDigest: null,
    planDigest: null,
    missingEvidence: [],
    diagnosticCode: null,
    resolution: null
  };
}

function projectProviderApply({
  provider,
  configuredTarget,
  plan,
  result,
  startedAt,
  observedAt,
  boundScope
}: {
  provider: ProviderName;
  configuredTarget: ProviderObservationTarget;
  plan: unknown;
  result: unknown;
  startedAt: string;
  observedAt: string;
  boundScope?: ProviderObservationScope | undefined;
}): ProviderObservationInput {
  if (
    !isPlainDataRecord(plan) ||
    !isPlainDataRecord(plan.policyBinding) ||
    plan.policyBinding.provider !== provider ||
    !isPlainDataRecord(result) ||
    (result.resolution !== "committed" &&
      result.resolution !== "idempotent")
  ) {
    throw new TypeError(
      "Snapshot import observation result is invalid."
    );
  }

  const observedScope = readScope(
    plan.policyBinding.scopeRef,
    provider
  );
  if (
    !providerObservationScopeMatchesTarget({
      provider,
      configuredTarget,
      observedScope,
      boundScope
    })
  ) {
    return projectProviderFailure({
      operation: "snapshot.import",
      provider,
      configuredTarget,
      observedScope,
      startedAt,
      observedAt,
      error: {
        code: "PROVIDER_OBSERVATION_SCOPE_MISMATCH"
      }
    });
  }

  return {
    operation: "snapshot.import",
    provider,
    configuredTarget,
    observedScope,
    status: "snapshot_ready",
    startedAt,
    observedAt,
    sourceRevisions: [],
    snapshotDigest: requireDigest(
      plan.snapshotDigest
    ),
    mappingDigest: requireDigest(
      plan.mappingDigest
    ),
    planDigest: requireDigest(plan.planDigest),
    missingEvidence: [],
    diagnosticCode: null,
    resolution: result.resolution
  };
}

function readScope(
  value: unknown,
  provider: ProviderName
): ProviderObservationScope {
  if (
    !isPlainDataRecord(value) ||
    (value.kind !== "repository" && value.kind !== "team") ||
    typeof value.key !== "string" ||
    !value.key.startsWith(`${provider}:`) ||
    (value.parentKey !== undefined &&
      (typeof value.parentKey !== "string" ||
        !value.parentKey.startsWith(`${provider}:`)))
  ) {
    throw new TypeError("Provider scope is invalid.");
  }

  return {
    kind: value.kind,
    key: value.key,
    parentKey:
      typeof value.parentKey === "string"
        ? value.parentKey
        : null
  };
}

function readDigest(
  value: unknown,
  key: string
): string | null {
  return isPlainDataRecord(value)
    ? requireDigest(value[key])
    : null;
}

function requireDigest(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(value)
  ) {
    throw new TypeError(
      "Provider observation digest is invalid."
    );
  }
  return value;
}

function encodeScopeReference(value: string): string {
  return encodeURIComponent(
    value.trim().toLowerCase()
  );
}

function isPlainDataRecord(
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
  if (
    prototype !== Object.prototype &&
    prototype !== null
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
