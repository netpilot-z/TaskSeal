import type {
  ConnectionProbeProvider
} from "./connection-probe.ts";
import {
  createNetworkConnectionProbe
} from "./connection-probe.ts";
import type {
  ConnectionProbePort,
  ConnectionProbeInput,
  NetworkConnectionProbeAdapter
} from "./connection-probe.ts";
import {
  inspectFeishuHealthProvider,
  inspectGiteeHealthProvider
} from "./provider-inspection.ts";

export interface ConnectionProbeFetchResponse {
  readonly ok: boolean;
  readonly status: number;
}

export type ConnectionProbeFetch = (
  url: string,
  options: {
    readonly method: "GET" | "POST";
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly redirect: "error";
    readonly signal: AbortSignal;
  }
) => Promise<ConnectionProbeFetchResponse>;

export function createProviderConnectionProbe({
  cwd,
  environment = process.env,
  fetchImpl = globalThis.fetch as unknown as ConnectionProbeFetch,
  timeoutMs = 3_000
}: {
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly fetchImpl?: ConnectionProbeFetch | undefined;
  readonly timeoutMs?: number | undefined;
}): ConnectionProbePort {
  const adapters: Partial<Record<ConnectionProbeProvider, NetworkConnectionProbeAdapter>> = {
    github: (input) => probeGitHub({
      input,
      environment,
      fetchImpl,
      timeoutMs
    }),
    linear: (input) => probeLinear({
      input,
      environment,
      fetchImpl,
      timeoutMs
    }),
    gitee: async () => {
      const result = await inspectGiteeHealthProvider({
        cwd,
        fetchImpl: fetchImpl as never
      });
      return {
        status: "connected",
        summary: `Gitee repository scope verified (${result.scope.key}).`,
        observedAt: result.checkedAt
      };
    },
    feishu: async (input) => {
      const result = await inspectFeishuHealthProvider({
        cwd,
        configuration: input.configuration.effective ?? undefined,
        environment,
        fetchImpl: fetchImpl as never
      });
      return {
        status: "connected",
        summary: `Feishu table scope verified (${result.tableName}, ${result.recordCount} records).`,
        observedAt: result.checkedAt
      };
    }
  };
  return createNetworkConnectionProbe({ adapters });
}

async function probeGitHub({
  input,
  environment,
  fetchImpl,
  timeoutMs
}: {
  readonly input: ConnectionProbeInput;
  readonly environment: NodeJS.ProcessEnv;
  readonly fetchImpl: ConnectionProbeFetch;
  readonly timeoutMs: number;
}) {
  const repository = readString(input.configuration.effective?.github, "repository");
  if (repository === null) {
    return {
      status: "unavailable" as const,
      summary: "GitHub repository coordinates are not configured."
    };
  }
  const token = nonEmpty(environment.GITHUB_TOKEN) ?? nonEmpty(environment.GH_TOKEN);
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}`,
    {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token === null ? {} : { Authorization: `Bearer ${token}` })
      },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs)
    }
  );
  if (response.status === 401 || response.status === 403) {
    return {
      status: "unauthorized" as const,
      summary: "GitHub rejected the configured credentials or repository scope."
    };
  }
  if (!response.ok) {
    return {
      status: "unavailable" as const,
      summary: `GitHub returned HTTP ${response.status} for the configured repository.`
    };
  }
  return {
    status: "connected" as const,
    summary: "GitHub repository scope verified by a read-only request."
  };
}

async function probeLinear({
  input,
  environment,
  fetchImpl,
  timeoutMs
}: {
  readonly input: ConnectionProbeInput;
  readonly environment: NodeJS.ProcessEnv;
  readonly fetchImpl: ConnectionProbeFetch;
  readonly timeoutMs: number;
}) {
  const linear = input.configuration.effective?.linear;
  const workspace = readString(linear, "workspace");
  const team = readString(linear, "team");
  const project = readString(linear, "project");
  const token = nonEmpty(environment.LINEAR_API_KEY) ?? nonEmpty(environment.LINEAR_ACCESS_TOKEN);
  if (workspace === null || team === null || project === null || token === null) {
    return {
      status: "unavailable" as const,
      summary: "Linear coordinates or credentials are incomplete."
    };
  }
  const response = await fetchImpl(
    "https://api.linear.app/graphql",
    {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: `query TaskSealProbe($workspace: String!, $team: String!, $project: String!) { organization { id urlKey } teams(first: 1, filter: { key: { eq: $team } }) { nodes { id key } } }`,
        variables: { workspace, team, project }
      }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs)
    }
  );
  if (response.status === 401 || response.status === 403) {
    return {
      status: "unauthorized" as const,
      summary: "Linear rejected the configured credentials or scope."
    };
  }
  if (!response.ok) {
    return {
      status: "unavailable" as const,
      summary: `Linear returned HTTP ${response.status} for the configured scope.`
    };
  }
  return {
    status: "connected" as const,
    summary: "Linear workspace and team scope accepted by a read-only request."
  };
}

function readString(
  value: Readonly<Record<string, unknown>> | undefined,
  key: string
): string | null {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate
    : null;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : null;
}
