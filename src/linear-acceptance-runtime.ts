import {
  AcceptanceDeliveryCoordinator
} from "./application/acceptance-delivery-coordinator.ts";
import type {
  AcceptanceDeliveryCommandPort,
  AcceptanceDeliveryServicePort
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
    getLinearAcceptanceCoordinates(
      configuration
    );
  const actor =
    normalizeOptionalActor(
      environment
        .TASKSEAL_HUMAN_ACTOR
    );

  if (
    coordinates.enabled &&
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

  if (!coordinates.enabled) {
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

  return Object.freeze({
    acceptance:
      new AcceptanceDeliveryCoordinator({
        acceptance: service,
        actor,
        transition
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
