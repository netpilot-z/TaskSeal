import type { ConfigurationIntegrationView, ConfigurationView } from "./configuration-control.ts";
import type { ProviderSyncProjection } from "./provider-sync-projection.ts";

export type ConnectionProbeProvider = ConfigurationIntegrationView["id"];

export type ConnectionProbeStatus =
  | "not-configured"
  | "credential-missing"
  | "configuration-ready"
  | "connected"
  | "unauthorized"
  | "observed"
  | "observation-unavailable";

export interface ConnectionProbeResult {
  readonly schemaVersion: "connection-probe/v1";
  readonly provider: ConnectionProbeProvider;
  readonly checkedAt: string;
  readonly configurationRevision: string;
  readonly status: ConnectionProbeStatus;
  readonly basis:
    | "configuration-and-last-observation"
    | "configuration-and-network";
  readonly networkAttempted: boolean;
  readonly observedAt: string | null;
  readonly summary: string;
}

export interface ConnectionProbeInput {
  readonly provider: ConnectionProbeProvider;
  readonly expectedConfigurationRevision: string;
  readonly configuration: ConfigurationView;
  readonly providerSync: ProviderSyncProjection | null;
  readonly signal?: AbortSignal | undefined;
  readonly now?: Date | undefined;
}

export interface NetworkConnectionProbeResult {
  readonly status: "connected" | "unauthorized" | "unavailable";
  readonly summary: string;
  readonly observedAt?: string | null | undefined;
}

export type NetworkConnectionProbeAdapter = (
  input: ConnectionProbeInput
) => NetworkConnectionProbeResult | Promise<NetworkConnectionProbeResult>;

export interface ConnectionProbePort {
  probe(input: ConnectionProbeInput): ConnectionProbeResult | Promise<ConnectionProbeResult>;
}

export class ConnectionProbeError extends Error {
  readonly code:
    | "CONNECTION_REVISION_CONFLICT"
    | "CONNECTION_PROVIDER_NOT_FOUND";

  constructor(
    code: ConnectionProbeError["code"],
    message: string
  ) {
    super(message);
    this.name = "ConnectionProbeError";
    this.code = code;
  }
}

/**
 * Performs an explicit, bounded, local-only check. It deliberately does not
 * call a provider or persist an observation; a future network adapter can be
 * injected through ConnectionProbePort without changing the route contract.
 */
export function createConfigurationConnectionProbe(): ConnectionProbePort {
  return {
    probe(input) {
      return probeConfiguration(input);
    }
  };
}

export function createNetworkConnectionProbe({
  adapters
}: {
  readonly adapters: Partial<Record<ConnectionProbeProvider, NetworkConnectionProbeAdapter>>;
}): ConnectionProbePort {
  return {
    async probe(input) {
      const local = probeConfiguration(input);
      const adapter = adapters[input.provider];
      if (
        adapter === undefined ||
        local.status === "not-configured" ||
        local.status === "credential-missing"
      ) {
        return local;
      }
      try {
        const network = await adapter(input);
        return {
          ...local,
          status: network.status === "unavailable"
            ? "observation-unavailable"
            : network.status,
          basis: "configuration-and-network",
          networkAttempted: true,
          observedAt: network.observedAt ?? local.observedAt,
          summary: network.summary
        };
      } catch {
        return {
          ...local,
          status: "observation-unavailable",
          basis: "configuration-and-network",
          networkAttempted: true,
          summary: "The provider connection could not be verified within the bounded probe."
        };
      }
    }
  };
}

export function probeConfiguration({
  provider,
  expectedConfigurationRevision,
  configuration,
  providerSync,
  now = new Date()
}: ConnectionProbeInput): ConnectionProbeResult {
  if (expectedConfigurationRevision !== configuration.revision) {
    throw new ConnectionProbeError(
      "CONNECTION_REVISION_CONFLICT",
      "Connection configuration changed; refresh before probing again."
    );
  }

  const integration = configuration.integrations.find(
    (candidate) => candidate.id === provider
  );
  if (!integration) {
    throw new ConnectionProbeError(
      "CONNECTION_PROVIDER_NOT_FOUND",
      "The requested connection provider is not available."
    );
  }

  const observation = latestObservation(providerSync, provider);
  const status = statusFor(integration, observation?.status);

  return {
    schemaVersion: "connection-probe/v1",
    provider,
    checkedAt: now.toISOString(),
    configurationRevision: configuration.revision,
    status,
    basis: "configuration-and-last-observation",
    networkAttempted: false,
    observedAt: observation?.observedAt ?? null,
    summary: summaryFor(status, observation?.observedAt ?? null)
  };
}

function statusFor(
  integration: ConfigurationIntegrationView,
  observationStatus: string | undefined
): ConnectionProbeStatus {
  if (!integration.configured) return "not-configured";
  if (
    integration.credential.requirement === "required" &&
    integration.credential.status !== "present"
  ) {
    return "credential-missing";
  }
  if (observationStatus === "sync_failed" || observationStatus === "scope_mismatch") {
    return "observation-unavailable";
  }
  if (observationStatus) return "observed";
  return "configuration-ready";
}

function summaryFor(
  status: ConnectionProbeStatus,
  observedAt: string | null
): string {
  switch (status) {
    case "not-configured":
      return "No provider coordinates are configured.";
    case "credential-missing":
      return "Required credentials are not available to TaskSeal.";
    case "observation-unavailable":
      return "The last provider observation reported an unavailable connection.";
    case "observed":
      return observedAt
        ? `The last persisted provider observation was recorded at ${observedAt}.`
        : "A provider observation is available.";
    case "configuration-ready":
      return "Configuration is ready; no external network request was made.";
    case "connected":
      return "The provider accepted the bounded read-only connection check.";
    case "unauthorized":
      return "The provider rejected the configured credentials or scope.";
  }
}

function latestObservation(
  providerSync: ProviderSyncProjection | null,
  provider: ConnectionProbeProvider
): { status: string; observedAt: string } | null {
  let latest: { status: string; observedAt: string } | null = null;
  for (const observation of providerSync?.providers ?? []) {
    if (observation.provider !== provider) continue;
    if (
      latest === null ||
      Date.parse(observation.observedAt) > Date.parse(latest.observedAt)
    ) {
      latest = {
        status: observation.status,
        observedAt: observation.observedAt
      };
    }
  }
  return latest;
}
