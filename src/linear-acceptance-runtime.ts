import {
  AcceptanceDeliveryCoordinator
} from "./application/acceptance-delivery-coordinator.ts";
import type {
  AcceptanceDeliveryCommandPort,
  AcceptanceDeliveryServicePort,
  AcceptanceDeliveryTransitionPort
} from "./application/acceptance-delivery-coordinator.ts";
import {
  LinearTransitionCoordinator
} from "./application/linear-transition-coordinator.ts";
import type {
  LinearTransitionWorkItemPort
} from "./application/linear-transition-coordinator.ts";
import {
  ProviderOperationJournal
} from "./application/provider-operation-journal.ts";
import type {
  ProviderOperationJournalQueryPort
} from "./application/provider-operation-journal.ts";
import {
  getLinearAcceptanceCoordinates,
  readProjectConfiguration
} from "./config/project-config.ts";
import {
  resolveLinearAcceptanceScope
} from "./connectors/linear-bootstrap-scope.ts";
import type {
  LinearBootstrapGraphqlRequest
} from "./connectors/linear-bootstrap-scope.ts";
import {
  createLinearGraphqlHttpExchange
} from "./connectors/linear-graphql-http-exchange.ts";
import {
  InjectedLinearTransitionTransport
} from "./connectors/linear-transition-transport.ts";
import {
  FileProviderOperationJournalStorage
} from "./storage/provider-operation-journal.ts";

export interface LocalLinearAcceptanceCapabilities {
  readonly decideAcceptance: boolean;
  readonly linearTransition: boolean;
  readonly reconcileLinearTransition: boolean;
}

export interface LocalLinearAcceptanceRuntime {
  readonly acceptance:
    | AcceptanceDeliveryCommandPort
    | null;
  readonly providerOperations:
    ProviderOperationJournalQueryPort;
  readonly capabilities:
    LocalLinearAcceptanceCapabilities;
  readonly operatorId: string | null;
}

export interface LocalLinearAcceptanceServicePort
  extends
    AcceptanceDeliveryServicePort,
    LinearTransitionWorkItemPort {}

interface CreateLocalLinearAcceptanceRuntimeOptions {
  readonly cwd: string;
  readonly service:
    LocalLinearAcceptanceServicePort;
  readonly environment?:
    | NodeJS.ProcessEnv
    | undefined;
  readonly fetchImpl?:
    | typeof globalThis.fetch
    | undefined;
  readonly clock?:
    | (() => unknown)
    | undefined;
  readonly providerOperationJournal?:
    | ProviderOperationJournal
    | undefined;
}

const ACTOR_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export async function createLocalLinearAcceptanceRuntime({
  cwd,
  service,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
  providerOperationJournal
}: CreateLocalLinearAcceptanceRuntimeOptions): Promise<LocalLinearAcceptanceRuntime> {
  const configuration =
    await readProjectConfiguration({
      cwd
    });
  const coordinates =
    configuration.linear === undefined
      ? null
      : getLinearAcceptanceCoordinates(
          configuration
        );
  const actor =
    normalizeOptionalActor(
      environment
        .TASKSEAL_HUMAN_ACTOR
    );

  if (
    coordinates?.enabled &&
    actor === null
  ) {
    throw runtimeError(
      "LINEAR_ACCEPTANCE_ACTOR_REQUIRED",
      "Enabled Linear acceptance requires TASKSEAL_HUMAN_ACTOR."
    );
  }

  const journal =
    providerOperationJournal ??
    await ProviderOperationJournal.open({
      storage:
        new FileProviderOperationJournalStorage({
          workspaceRoot: cwd
        })
    });

  if (actor === null) {
    return Object.freeze({
      acceptance: null,
      providerOperations:
        projectOperationQuery(journal),
      capabilities: Object.freeze({
        decideAcceptance: false,
        linearTransition: false,
        reconcileLinearTransition: false
      }),
      operatorId: null
    });
  }

  if (
    coordinates === null ||
    !coordinates.enabled
  ) {
    return Object.freeze({
      acceptance:
        new AcceptanceDeliveryCoordinator({
          acceptance: service,
          actor,
          transition: null
        }),
      providerOperations:
        projectOperationQuery(journal),
      capabilities: Object.freeze({
        decideAcceptance: true,
        linearTransition: false,
        reconcileLinearTransition: false
      }),
      operatorId: actor
    });
  }

  const exchange =
    createLinearGraphqlHttpExchange({
      apiKey: environment.LINEAR_API_KEY,
      accessToken:
        environment.LINEAR_ACCESS_TOKEN,
      fetchImpl
    });
  const scope =
    await resolveLinearAcceptanceScope({
      configuredTarget: {
        workspace:
          coordinates.workspace,
        team: coordinates.team,
        project: coordinates.project,
        expectedState:
          coordinates.expectedState,
        targetState:
          coordinates.targetState
      },
      exchange: (
        request:
          LinearBootstrapGraphqlRequest
      ) => exchange(request)
    });
  const transport =
    new InjectedLinearTransitionTransport({
      exchange: (request) =>
        exchange(request)
    });
  const transition =
    await LinearTransitionCoordinator.open({
      journal,
      transport,
      workItems: service,
      configuredTarget: {
        workspace:
          coordinates.workspace,
        team: coordinates.team,
        project: coordinates.project,
        expectedState:
          coordinates.expectedState,
        targetState:
          coordinates.targetState
      },
      resolvedTarget: {
        organizationId:
          scope.organizationId,
        teamId: scope.teamId,
        projectId: scope.projectId,
        expectedStateId:
          scope.expectedStateId,
        targetStateId:
          scope.targetStateId
      },
      clock
    });
  // Open once during startup to validate the current scope; each admitted
  // operation below resolves and pins its own configuration revision.
  void transition;
  const operationBoundTransition =
    createOperationBoundLinearTransition({
      cwd,
      environment,
      fetchImpl,
      journal,
      service,
      clock
    });

  return Object.freeze({
    acceptance:
      new AcceptanceDeliveryCoordinator({
        acceptance: service,
        actor,
        transition: operationBoundTransition
      }),
    providerOperations:
      projectOperationQuery(journal),
    capabilities: Object.freeze({
      decideAcceptance: true,
      linearTransition: true,
      reconcileLinearTransition: true
    }),
    operatorId: actor
  });
}

function createOperationBoundLinearTransition({
  cwd,
  environment,
  fetchImpl,
  journal,
  service,
  clock
}: {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly journal: ProviderOperationJournal;
  readonly service: LocalLinearAcceptanceServicePort;
  readonly clock: () => unknown;
}): AcceptanceDeliveryTransitionPort {
  const bound = new Map<string, AcceptanceDeliveryTransitionPort>();
  const resolve = async (): Promise<AcceptanceDeliveryTransitionPort> => {
    const configuration = await readProjectConfiguration({ cwd });
    const coordinates = getLinearAcceptanceCoordinates(configuration);
    if (!coordinates.enabled) {
      throw runtimeError(
        "LINEAR_TRANSITION_DISABLED",
        "Linear acceptance is disabled for the current configuration."
      );
    }
    const exchange = createLinearGraphqlHttpExchange({
      apiKey: environment.LINEAR_API_KEY,
      accessToken: environment.LINEAR_ACCESS_TOKEN,
      fetchImpl
    });
    const scope = await resolveLinearAcceptanceScope({
      configuredTarget: {
        workspace: coordinates.workspace,
        team: coordinates.team,
        project: coordinates.project,
        expectedState: coordinates.expectedState,
        targetState: coordinates.targetState
      },
      exchange: (request: unknown) => exchange(request)
    });
    const transport = new InjectedLinearTransitionTransport({
      exchange: (request: unknown) => exchange(request)
    });
    return LinearTransitionCoordinator.open({
      journal,
      transport,
      workItems: service,
      configuredTarget: {
        workspace: coordinates.workspace,
        team: coordinates.team,
        project: coordinates.project,
        expectedState: coordinates.expectedState,
        targetState: coordinates.targetState
      },
      resolvedTarget: {
        organizationId: scope.organizationId,
        teamId: scope.teamId,
        projectId: scope.projectId,
        expectedStateId: scope.expectedStateId,
        targetStateId: scope.targetStateId
      },
      clock
    });
  };
  const transitionFor = async (operationKey: string) => {
    const existing = bound.get(operationKey);
    if (existing !== undefined) {
      return existing;
    }
    const created = await resolve();
    bound.set(operationKey, created);
    return created;
  };
  return {
    async prepare(input) {
      const transition = await resolve();
      const prepared = await transition.prepare(input);
      bound.set(prepared.plan.operationKey, transition);
      return prepared;
    },
    async approve(input) {
      return (await transitionFor(input.operationKey)).approve(input);
    },
    async submit(input) {
      const transition = await transitionFor(input.operationKey);
      try {
        return await transition.submit(input);
      } finally {
        bound.delete(input.operationKey);
      }
    },
    async reconcile(input) {
      return (await transitionFor(input.operationKey)).reconcile!(input);
    },
    async get(operationKey) {
      return (await resolve()).get!(operationKey);
    }
  };
}

function projectOperationQuery(
  journal: ProviderOperationJournal
): ProviderOperationJournalQueryPort {
  return Object.freeze({
    get: journal.get.bind(journal),
    history:
      journal.history.bind(journal),
    listLatest:
      journal.listLatest.bind(journal)
  });
}

function normalizeOptionalActor(
  value: unknown
): string | null {
  if (value === undefined) {
    return null;
  }
  if (
    typeof value !== "string" ||
    !ACTOR_PATTERN.test(value)
  ) {
    throw runtimeError(
      "LINEAR_ACCEPTANCE_ACTOR_INVALID",
      "TASKSEAL_HUMAN_ACTOR is invalid."
    );
  }
  return value;
}

function runtimeError(
  code: string,
  message: string
): LinearAcceptanceRuntimeError {
  return new LinearAcceptanceRuntimeError(
    code,
    message
  );
}

export class LinearAcceptanceRuntimeError
  extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name =
      "LinearAcceptanceRuntimeError";
    this.code = code;
  }
}
