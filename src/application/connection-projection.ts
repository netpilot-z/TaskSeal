import type { ConfigurationIntegrationView, ConfigurationView } from "./configuration-control.ts";
import type { ProviderSyncProjection } from "./provider-sync-projection.ts";

export type ConnectionConnectivity =
  | "not-configured"
  | "not-probed"
  | "observed"
  | "unavailable";

export type ConnectionActivation =
  | "next-operation"
  | "restart-required";

export interface ConnectionView {
  readonly id: ConfigurationIntegrationView["id"];
  readonly configured: boolean;
  readonly capability: ConfigurationIntegrationView["capability"];
  readonly credential: ConfigurationIntegrationView["credential"];
  readonly connectivity: {
    readonly status: ConnectionConnectivity;
    readonly basis: "configuration" | "provider-observation" | "not-probed";
    readonly observedAt: string | null;
  };
  readonly activation: ConnectionActivation;
  readonly setupUrl: string;
}

export interface ConnectionsSnapshot {
  readonly schemaVersion: "connections/v1";
  readonly generatedAt: string;
  readonly configurationRevision: string;
  readonly runtimeRevision: string;
  readonly activeRuntimeRevision: string | null;
  readonly connections: readonly ConnectionView[];
}

/**
 * Projects configuration and the last persisted provider observations into a
 * deliberately narrow connection contract. It never performs network I/O and
 * never exposes credential values; an explicit probe can be added later at the
 * provider adapter seam without changing this UI contract.
 */
export function projectConnections({
  configuration,
  providerSync,
  activeRuntimeRevision = null,
  now = new Date()
}: {
  readonly configuration: ConfigurationView;
  readonly providerSync?: ProviderSyncProjection | null;
  readonly activeRuntimeRevision?: string | null;
  readonly now?: Date;
}): ConnectionsSnapshot {
  const observations = latestObservations(providerSync);
  return {
    schemaVersion: "connections/v1",
    generatedAt: now.toISOString(),
    configurationRevision: configuration.revision,
    runtimeRevision: configuration.runtimeRevision,
    activeRuntimeRevision,
    connections: configuration.integrations.map((integration) =>
      projectConnection(integration, observations.get(integration.id))
    )
  };
}

function projectConnection(
  integration: ConfigurationIntegrationView,
  observation: { status: string; observedAt: string } | undefined
): ConnectionView {
  const connectivity = !integration.configured
    ? {
        status: "not-configured" as const,
        basis: "configuration" as const,
        observedAt: null
      }
    : observation === undefined
      ? {
          status: "not-probed" as const,
          basis: "not-probed" as const,
          observedAt: null
        }
      : {
          status: observation.status === "sync_failed" || observation.status === "scope_mismatch"
            ? "unavailable" as const
            : "observed" as const,
          basis: "provider-observation" as const,
          observedAt: observation.observedAt
        };

  return {
    id: integration.id,
    configured: integration.configured,
    capability: integration.capability,
    credential: integration.credential,
    connectivity,
    // Coordinates and enablement are read on admission by the next provider
    // operation. Process-bound runtime fields remain restart-required.
    activation: activationFor(integration.id),
    setupUrl: integration.setupUrl
  };
}

function activationFor(
  id: ConfigurationIntegrationView["id"]
): ConnectionActivation {
  // Provider coordinates are admitted per operation. The process-bound
  // runtime fields (port, runner policy, storage) are intentionally absent
  // from this page and remain restart-required in ConfigurationView.
  void id;
  return "next-operation";
}

function latestObservations(
  providerSync: ProviderSyncProjection | null | undefined
): Map<string, { status: string; observedAt: string }> {
  const latest = new Map<string, { status: string; observedAt: string }>();
  for (const observation of providerSync?.providers ?? []) {
    const previous = latest.get(observation.provider);
    if (previous === undefined || Date.parse(observation.observedAt) > Date.parse(previous.observedAt)) {
      latest.set(observation.provider, {
        status: observation.status,
        observedAt: observation.observedAt
      });
    }
  }
  return latest;
}
