import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type {
  IncomingMessage,
  ServerResponse
} from "node:http";

import {
  AttemptRunCoordinator,
  AttemptRunCoordinatorError
} from "./application/attempt-run-coordinator.ts";
import { projectDashboard } from "./dashboard/projection.ts";
import {
  projectHomeSnapshot
} from "./dashboard/home-projection.ts";
import type {
  HomeSnapshot
} from "./dashboard/home-projection.ts";
import { projectHubSnapshot } from "./dashboard/project-hub.ts";
import type { ProjectHubQueryPort } from "./dashboard/project-hub.ts";
import {
  collectProjectWorkItems,
  createProjectOperationsQuery
} from "./application/project-operations-query.ts";
import {
  projectOperationsViewFromHub
} from "./application/project-operations-query.ts";
import type {
  ProjectRegistryPort
} from "./application/project-registry.ts";
import { replayDemoSteps } from "./demo/scenario.ts";
import type {
  AcceptanceDeliveryLinearSync,
  AcceptanceDeliveryResult
} from "./application/acceptance-delivery-coordinator.ts";
import type {
  AttemptRunCoordinatorSnapshot,
  AttemptRunExecutionContext,
  AttemptRunStartResult,
  AttemptRunTerminalization,
  AttemptRunView
} from "./application/attempt-run-coordinator.ts";
import type {
  ProviderSyncQueryPort
} from "./application/provider-sync-projection.ts";
import {
  ConnectionProbeError,
  createConfigurationConnectionProbe
} from "./application/connection-probe.ts";
import type {
  ConnectionProbePort,
  ConnectionProbeProvider
} from "./application/connection-probe.ts";
import {
  projectConnections
} from "./application/connection-projection.ts";
import type {
  DecompositionExecutionOptions,
  DecompositionProjection
} from "./application/decomposition-dispatcher.ts";
import type {
  RetiredDecompositionRecord
} from "./application/decomposition-plan-journal.ts";
import type {
  ConfigurationAuthority
} from "./application/configuration-authority.ts";
import type {
  RuntimeReadiness
} from "./application/runtime-readiness.ts";
import type {
  ConfigurationChangeInput
} from "./application/configuration-control.ts";
import type { DashboardProjection } from "./dashboard/projection.ts";
import type { DemoStep } from "./demo/scenario.ts";
import {
  getPresentationCatalog,
  SUPPORTED_LOCALES
} from "./presentation/i18n.ts";
import type { SupportedLocale } from "./presentation/i18n.ts";

interface StaticFile {
  url: URL;
  contentType: string;
}

interface PersistentWorkItemReference {
  id: string;
}

export interface PersistentServicePort {
  snapshot(): DashboardProjection;
  getWorkItem(
    workItemId: string
  ): PersistentWorkItemReference | null;
  getHealth?(): unknown;
}

export interface PersistentAcceptancePort {
  decide(
    input: unknown
  ): Promise<AcceptanceDeliveryResult>;
  reconcile(
    input: unknown
  ): Promise<AcceptanceDeliveryLinearSync>;
}

export interface RunWorkItemOptions {
  workItemId: string;
  runnerId?: string | undefined;
  prompt: string;
  sandbox: "read-only" | "workspace-write";
  timeoutMs?: number | undefined;
  signal: AbortSignal;
  terminalization: AttemptRunTerminalization;
}

export type RunWorkItem = (
  options: RunWorkItemOptions
) => unknown | Promise<unknown>;

export interface PersistentConfigurationPort
  extends Omit<ConfigurationAuthority, "kind"> {
  readonly instanceId: string;
  readonly activeRuntimeRevision: string;
}

export interface PersistentDecompositionDispatcherPort {
  list(): readonly DecompositionProjection[];
  dispatchOnce(input: {
    planId: string;
    expectedPlanDigest: string;
  }): unknown | Promise<unknown>;
  retireOnce(input: {
    planId: string;
    expectedPlanDigest: string;
    reasonCode:
      | "interrupted"
      | "human_rejected"
      | "runner_profile_drift"
      | "operator_rollback";
    note: string;
  }): unknown | Promise<unknown>;
  assertManualRunAllowed(
    workItemId: string
  ): void;
  startManualRun(input: {
    workItemId: string;
    execute(
      context:
        AttemptRunExecutionContext
    ): unknown | Promise<unknown>;
  }): AttemptRunStartResult;
  decideAcceptanceOnce<T>(
    input: {
      workItemId: string;
      decision:
        | "accepted"
        | "rejected";
      decide: () =>
        T | Promise<T>;
    }
  ): Promise<T>;
}

export interface PersistentDecompositionControlPort {
  readonly capabilities: {
    readonly preview: boolean;
    readonly approve: boolean;
    readonly dispatch: boolean;
    readonly retire: boolean;
  };
  preview(draft: unknown): unknown;
  approve(input: {
    draft: unknown;
    expectedPlanDigest: unknown;
  }): unknown | Promise<unknown>;
  listRetirements():
    readonly RetiredDecompositionRecord[];
  assertManualRunAllowed(
    workItemId: string
  ): void;
  assertAcceptanceAllowed(
    workItemId: string,
    decision:
      | "accepted"
      | "rejected"
  ): void;
  createDispatcher(options: {
    attemptRuns: AttemptRunCoordinator;
    execute(
      options: DecompositionExecutionOptions
    ): unknown | Promise<unknown>;
  }): PersistentDecompositionDispatcherPort;
  getHealth?(): unknown;
}

export interface DemoTaskSealServerOptions {
  steps: readonly DemoStep[];
  initialStep?: number | undefined;
  service?: never;
  providerStatus?: never;
  runWorkItem?: never;
  maxConcurrentRuns?: never;
  decomposition?: never;
}

export interface SetupTaskSealServerOptions {
  readonly setup: true;
  readonly configuration: ConfigurationAuthority;
  readonly readiness: () => RuntimeReadiness | Promise<RuntimeReadiness>;
  readonly connectionProbe?: ConnectionProbePort | null | undefined;
  readonly networkConnectionProbe?: never;
  readonly service?: never;
  readonly providerStatus?: never;
  readonly acceptance?: never;
  readonly acceptanceCapabilities?: never;
  readonly operatorId?: never;
  readonly decomposition?: never;
  readonly runWorkItem?: never;
  readonly maxConcurrentRuns?: never;
  readonly projectHub?: never;
  readonly steps?: never;
  readonly initialStep?: never;
}

export interface PersistentTaskSealServerOptions {
  service: PersistentServicePort;
  providerStatus: ProviderSyncQueryPort;
  acceptance?:
    | PersistentAcceptancePort
    | null
    | undefined;
  acceptanceCapabilities?: {
    readonly decideAcceptance: boolean;
    readonly linearTransition: boolean;
    readonly reconcileLinearTransition: boolean;
  } | undefined;
  operatorId?:
    | string
    | null
    | undefined;
  decomposition?:
    | PersistentDecompositionControlPort
    | null
    | undefined;
  runWorkItem: RunWorkItem;
  maxConcurrentRuns?: number | undefined;
  configuration?: PersistentConfigurationPort | null | undefined;
  connectionProbe?: ConnectionProbePort | null | undefined;
  networkConnectionProbe?: ConnectionProbePort | null | undefined;
  projectHub?: ProjectHubQueryPort | null | undefined;
  projectRegistry?: ProjectRegistryPort | null | undefined;
  steps?: never;
  initialStep?: never;
}

export type TaskSealServerOptions =
  | DemoTaskSealServerOptions
  | PersistentTaskSealServerOptions
  | SetupTaskSealServerOptions;

export type TaskSealServer =
  ReturnType<typeof createServer> & {
    shutdown(): Promise<void>;
  };

interface DemoRuntime {
  mode: "demo";
  steps: readonly DemoStep[];
  currentStep: number;
}

interface PersistentRuntime {
  mode: "persistent";
  service: PersistentServicePort;
  providerStatus: ProviderSyncQueryPort;
  acceptance:
    | PersistentAcceptancePort
    | null;
  acceptanceCapabilities: {
    readonly decideAcceptance: boolean;
    readonly linearTransition: boolean;
    readonly reconcileLinearTransition: boolean;
  };
  operatorId: string | null;
  decomposition:
    | PersistentDecompositionControlPort
    | null;
  runWorkItem: RunWorkItem;
  maxConcurrentRuns: number;
  csrfToken: string;
  configuration: PersistentConfigurationPort | null;
  connectionProbe: ConnectionProbePort;
  networkConnectionProbe: ConnectionProbePort | null;
  projectHub: ProjectHubQueryPort | null;
  projectRegistry: ProjectRegistryPort | null;
}

interface SetupRuntime {
  mode: "setup";
  configuration: ConfigurationAuthority;
  readiness: () => RuntimeReadiness | Promise<RuntimeReadiness>;
  connectionProbe: ConnectionProbePort;
  csrfToken: string;
}

type ServerRuntime = DemoRuntime | PersistentRuntime | SetupRuntime;

interface RuntimeError {
  code: string;
  message: string;
  recordedAt: string;
}

interface RunRequestBody {
  prompt: string;
  readOnly?: boolean | undefined;
}

interface ConfigurationChangeRequestBody {
  readonly expectedRevision: string;
  readonly change: ConfigurationChangeInput;
}

interface ConfigurationDraftRequestBody {
  readonly expectedRevision: string;
  readonly scope: "user" | "project" | "local";
  readonly document: Readonly<Record<string, unknown>>;
}

interface ConnectionProbeRequestBody {
  readonly expectedConfigurationRevision: string;
}

interface DecompositionPreviewRequestBody {
  draft: unknown;
}

interface DecompositionApprovalRequestBody {
  draft: unknown;
  expectedPlanDigest: string;
}

interface DecompositionDispatchRequestBody {
  expectedPlanDigest: string;
}

interface DecompositionRetirementRequestBody {
  expectedPlanDigest: string;
  reasonCode:
    | "interrupted"
    | "human_rejected"
    | "runner_profile_drift"
    | "operator_rollback";
  note: string;
}

interface ResponseFailure {
  statusCode: number;
  code: string;
  message: string;
}

interface FencedHealth {
  status: "fenced";
  code: string;
  planDigest: string | null;
}

interface DemoSnapshot extends DashboardProjection {
  mode: "demo";
  capabilities: {
    demo: true;
    runAttempt: false;
    cancelAttempt: false;
    previewDecomposition: false;
    approveDecomposition: false;
    dispatchDecomposition: false;
    retireDecomposition: false;
  };
  orchestration: readonly [];
  decompositionRetirements:
    readonly [];
  demo: {
    currentStep: number;
    totalSteps: number;
    complete: boolean;
    timeline: Array<{
      number: number;
      source: string;
      label: string;
      completed: boolean;
      active: boolean;
    }>;
  };
}

interface PersistentSnapshot extends DashboardProjection {
  mode: "persistent";
  capabilities: {
    demo: false;
    runAttempt: true;
    cancelAttempt: true;
    decideAcceptance: boolean;
    linearTransition: boolean;
    reconcileLinearTransition: boolean;
    previewDecomposition: boolean;
    approveDecomposition: boolean;
    dispatchDecomposition: boolean;
    retireDecomposition: boolean;
  };
  orchestration:
    readonly DecompositionProjection[];
  decompositionRetirements:
    readonly RetiredDecompositionRecord[];
  runtime: {
    activeWorkItemIds: string[];
    capacity: Omit<
      AttemptRunCoordinatorSnapshot,
      "runs"
    >;
    runs: Array<
      AttemptRunView & {
        attemptId: string | null;
      }
    >;
    errors: Record<string, RuntimeError>;
  };
  security: {
    csrfToken: string;
    operatorId: string | null;
  };
}

const STATIC_FILES = new Map<string, StaticFile>([
  [
    "/",
    {
      url: new URL("../public/index.html", import.meta.url),
      contentType: "text/html; charset=utf-8"
    }
  ],
  [
    "/app.js",
    {
      url: new URL("../public/app.js", import.meta.url),
      contentType: "text/javascript; charset=utf-8"
    }
  ],
  [
    "/home.js",
    {
      url: new URL("../public/home.js", import.meta.url),
      contentType: "text/javascript; charset=utf-8"
    }
  ],
  [
    "/connections",
    {
      url: new URL("../public/connections.html", import.meta.url),
      contentType: "text/html; charset=utf-8"
    }
  ],
  [
    "/connections.js",
    {
      url: new URL("../public/connections.js", import.meta.url),
      contentType: "text/javascript; charset=utf-8"
    }
  ],
  [
    "/projects",
    {
      url: new URL("../public/projects.html", import.meta.url),
      contentType: "text/html; charset=utf-8"
    }
  ],
  [
    "/projects.js",
    {
      url: new URL("../public/projects.js", import.meta.url),
      contentType: "text/javascript; charset=utf-8"
    }
  ],
  [
    "/ui-primitives.js",
    {
      url: new URL("../public/ui-primitives.js", import.meta.url),
      contentType: "text/javascript; charset=utf-8"
    }
  ],
  [
    "/presentation.js",
    {
      url: new URL("../public/presentation.js", import.meta.url),
      contentType: "text/javascript; charset=utf-8"
    }
  ],
  [
    "/settings",
    {
      url: new URL("../public/settings.html", import.meta.url),
      contentType: "text/html; charset=utf-8"
    }
  ],
  [
    "/setup",
    {
      url: new URL("../public/settings.html", import.meta.url),
      contentType: "text/html; charset=utf-8"
    }
  ],
  [
    "/settings.js",
    {
      url: new URL("../public/settings.js", import.meta.url),
      contentType: "text/javascript; charset=utf-8"
    }
  ],
  [
    "/dashboard-state.js",
    {
      url: new URL("../public/dashboard-state.js", import.meta.url),
      contentType: "text/javascript; charset=utf-8"
    }
  ],
  [
    "/provider-state.js",
    {
      url: new URL("../public/provider-state.js", import.meta.url),
      contentType: "text/javascript; charset=utf-8"
    }
  ],
  [
    "/styles.css",
    {
      url: new URL("../public/styles.css", import.meta.url),
      contentType: "text/css; charset=utf-8"
    }
  ]
]);

export function createTaskSealServer(
  options: TaskSealServerOptions
): TaskSealServer {
  const runtime = createServerRuntime(options);
  const attemptRuns =
    runtime.mode === "persistent"
      ? new AttemptRunCoordinator({
          maxConcurrentRuns:
            runtime.maxConcurrentRuns
        })
      : null;
  const decompositionDispatcher =
    runtime.mode === "persistent" &&
    runtime.decomposition !== null
      ? runtime.decomposition.createDispatcher({
          attemptRuns:
            requireAttemptRuns(
              attemptRuns
            ),
          execute: ({
            workItemId,
            runnerId,
            instruction,
            workspaceAccess,
            timeoutMs,
            signal,
            terminalization
          }) =>
            runtime.runWorkItem({
              workItemId,
              runnerId,
              prompt: instruction,
              sandbox:
                workspaceAccess,
              timeoutMs,
              signal,
              terminalization
            })
        })
      : null;
  const lastErrors = new Map<string, RuntimeError>();
  let shutdownPromise: Promise<void> | null = null;

  const readOperations = async (input: {
    readonly projectRef?: string | undefined;
    readonly workItemId?: string | undefined;
  } = {}) => {
    if (runtime.mode === "setup") {
      throw new HttpError(
        403,
        "CAPABILITY_DISABLED",
        "Project operations are unavailable in SetupRuntime."
      );
    }
    if (runtime.mode === "persistent" && runtime.projectHub) {
      return projectOperationsViewFromHub({
        projectHub: await runtime.projectHub.read(),
        runtime: {
          mode: "live",
          freshness: "fresh",
          source: "control-room"
        },
        input
      });
    }
    const snapshot = runtime.mode === "persistent"
      ? buildPersistentSnapshot(
          runtime.service,
          requireAttemptRuns(attemptRuns),
          lastErrors,
          runtime.csrfToken,
          runtime.acceptanceCapabilities,
          runtime.operatorId,
          decompositionDispatcher,
          runtime.decomposition
        )
      : buildDemoSnapshot(runtime.steps, runtime.currentStep);
    let projectName = "Current project";
    if (runtime.mode === "persistent" && runtime.configuration) {
      const configuration = await runtime.configuration.inspect();
      projectName = configuration.effective?.project ?? projectName;
    }
    const home = buildHomeServerResponse(snapshot, projectName);
    const registrySources =
      runtime.mode === "persistent" && runtime.projectRegistry
        ? await runtime.projectRegistry.list()
        : [];
    return createProjectOperationsQuery({
      sources: [
        {
          projectRef: home.project.key,
          runtime: runtime.mode === "persistent" ? "live" : "offline",
          async read() {
            return home;
          }
        },
        ...registrySources
      ]
    }).snapshot(input);
  };

  const server = createServer(async (request, response) => {
    try {
      const pathname = readRequestPathname(request.url);

      if (
        runtime.mode === "setup" &&
        isSetupForbiddenPath(request.method, pathname)
      ) {
        throw new HttpError(
          403,
          "CAPABILITY_DISABLED",
          "This operational capability is unavailable until the project is ready."
        );
      }

      if (request.method === "GET" && pathname === "/health") {
        const health = readFencedHealth(runtime);

        if (health) {
          return writeJson(response, 503, health);
        }

        return writeJson(response, 200, {
          status: "ok"
        });
      }

      if (request.method === "GET" && pathname === "/api/dashboard") {
        if (runtime.mode === "setup") {
          throw new HttpError(
            403,
            "CAPABILITY_DISABLED",
            "Dashboard data is unavailable in SetupRuntime."
          );
        }
        return writeJson(
          response,
          200,
          runtime.mode === "persistent"
            ? buildPersistentSnapshot(
                runtime.service,
                requireAttemptRuns(attemptRuns),
                lastErrors,
                runtime.csrfToken,
                runtime.acceptanceCapabilities,
                runtime.operatorId,
                decompositionDispatcher,
                runtime.decomposition
              )
            : buildDemoSnapshot(
                runtime.steps,
                runtime.currentStep
          )
        );
      }

      if (request.method === "GET" && pathname === "/api/home") {
        if (runtime.mode === "setup") {
          throw new HttpError(
            403,
            "CAPABILITY_DISABLED",
            "Operational task data is unavailable in SetupRuntime."
          );
        }
        const snapshot =
          runtime.mode === "persistent"
            ? buildPersistentSnapshot(
                runtime.service,
                requireAttemptRuns(attemptRuns),
                lastErrors,
                runtime.csrfToken,
                runtime.acceptanceCapabilities,
                runtime.operatorId,
                decompositionDispatcher,
                runtime.decomposition
              )
            : buildDemoSnapshot(
                runtime.steps,
                runtime.currentStep
              );
        let projectName = "Current project";
        if (runtime.mode === "persistent" && runtime.configuration) {
          const configuration = await runtime.configuration.inspect();
          projectName = configuration.effective?.project ?? projectName;
        }
        return writeJson(
          response,
          200,
          buildHomeServerResponse(snapshot, projectName)
        );
      }

      if (request.method === "GET" && pathname === "/api/status") {
        return writeJson(response, 200, await readOperations());
      }

      if (request.method === "GET" && pathname === "/api/work-items") {
        const operations = await readOperations();
        const projects = operations.projectHub.projects;
        const workItems = projects.flatMap((project) =>
          collectProjectWorkItems(project).map((workItem) => ({
            projectRef: project.projectRef,
            workItem
          }))
        );
        return writeJson(response, 200, {
          schemaVersion: "work-items/v1",
          generatedAt: operations.generatedAt,
          runtime: operations.runtime,
          workItems
        });
      }

      const workItemMatch =
        /^\/api\/work-items\/([^/]+)$/.exec(pathname);
      if (request.method === "GET" && workItemMatch) {
        const workItemId = decodePathSegment(workItemMatch[1]!);
        const operations = await readOperations({
          workItemId
        });
        const selected = operations.selected?.workItem ?? null;
        if (selected === null) {
          throw new HttpError(
            404,
            "WORK_ITEM_NOT_FOUND",
            `TaskSeal work item ${workItemId} does not exist.`
          );
        }
        return writeJson(response, 200, {
          schemaVersion: "work-item/v1",
          generatedAt: operations.generatedAt,
          runtime: operations.runtime,
          projectRef: operations.selected?.projectRef ?? "current",
          workItem: selected
        });
      }

      if (request.method === "GET" && pathname === "/api/project-hub") {
        if (runtime.mode === "setup") {
          throw new HttpError(
            403,
            "CAPABILITY_DISABLED",
            "Project operations are unavailable in SetupRuntime."
          );
        }
        if (runtime.mode === "persistent" && runtime.projectHub) {
          requireTrustedHost(request.headers.host);
          return writeJson(response, 200, await runtime.projectHub.read());
        }
        if (runtime.mode === "persistent" && runtime.projectRegistry) {
          requireTrustedHost(request.headers.host);
          const operations = await readOperations();
          return writeJson(response, 200, operations.projectHub);
        }
        const snapshot =
          runtime.mode === "persistent"
            ? buildPersistentSnapshot(
                runtime.service,
                requireAttemptRuns(attemptRuns),
                lastErrors,
                runtime.csrfToken,
                runtime.acceptanceCapabilities,
                runtime.operatorId,
                decompositionDispatcher,
                runtime.decomposition
              )
            : buildDemoSnapshot(runtime.steps, runtime.currentStep);
        let projectName = "Current project";
        if (runtime.mode === "persistent" && runtime.configuration) {
          const configuration = await runtime.configuration.inspect();
          projectName = configuration.effective?.project ?? projectName;
        }
        const home = buildHomeServerResponse(snapshot, projectName);
        return writeJson(
          response,
          200,
          await projectHubSnapshot({
            sources: [{
              projectRef: home.project.key,
              async read() { return home; }
            }]
          })
        );
      }

      if (
        request.method === "GET" &&
        pathname === "/api/connections"
      ) {
        requireTrustedHost(request.headers.host);
        if (runtime.mode === "demo") {
          return writeJson(response, 200, buildDemoConnectionsResponse());
        }
        const configuration = runtime.mode === "setup"
          ? runtime.configuration
          : requireConfiguration(runtime.configuration);
        const view = await configuration.inspect();
        let providerSync = null;
        if (runtime.mode === "persistent") {
          try {
            providerSync = await runtime.providerStatus.list();
          } catch {
            // A provider observation outage must not hide safe configuration truth.
          }
        }
        return writeJson(response, 200, {
          ...projectConnections({
            configuration: view,
            providerSync,
            activeRuntimeRevision:
              runtime.mode === "persistent"
                ? (configuration as PersistentConfigurationPort).activeRuntimeRevision
                : null
          }),
          security: {
            csrfToken: runtime.csrfToken
          },
          capabilities: {
            explicitProbe: true,
            networkProbe:
              runtime.mode === "persistent" &&
              runtime.networkConnectionProbe !== null
          }
        });
      }

      if (
        runtime.mode === "setup" &&
        request.method === "GET" &&
        pathname === "/api/readiness"
      ) {
        requireTrustedHost(request.headers.host);
        return writeJson(response, 200, {
          schemaVersion: "runtime-readiness/v1",
          readiness: await runtime.readiness()
        });
      }

      const connectionProbeMatch =
        (runtime.mode === "persistent" || runtime.mode === "setup") &&
        request.method === "POST" &&
        /^\/api\/connections\/(github|linear|gitee|feishu)\/(probe|verify)$/.exec(pathname);

      if (connectionProbeMatch && (runtime.mode === "persistent" || runtime.mode === "setup")) {
        const networkProbe =
          connectionProbeMatch[2] === "verify"
            ? runtime.mode === "persistent"
              ? runtime.networkConnectionProbe
              : null
            : runtime.connectionProbe;
        if (networkProbe === null) {
          throw new HttpError(
            503,
            "NETWORK_PROBE_UNAVAILABLE",
            "Network provider verification is not enabled for this runtime."
          );
        }
        validatePersistentWriteRequest(request, runtime.csrfToken);
        const configuration = runtime.mode === "setup"
          ? runtime.configuration
          : requireConfiguration(runtime.configuration);
        const body = validateConnectionProbeBody(
          await readJsonBody(request, 16 * 1024)
        );
        const view = await configuration.inspect();
        let providerSync = null;
        if (runtime.mode === "persistent") {
          try {
            providerSync = await runtime.providerStatus.list();
          } catch {
            // The explicit probe remains useful when persisted observations are unavailable.
          }
        }
        return writeJson(
          response,
          200,
          await networkProbe.probe({
            provider: connectionProbeMatch[1] as ConnectionProbeProvider,
            expectedConfigurationRevision: body.expectedConfigurationRevision,
            configuration: view,
            providerSync,
            signal: AbortSignal.timeout(5_000)
          })
        );
      }

      const presentationCatalogMatch =
        request.method === "GET" &&
        /^\/api\/presentation\/catalog\/(en|zh-CN)$/.exec(pathname);

      if (
        presentationCatalogMatch ||
        (request.method === "GET" && pathname === "/api/presentation/catalog")
      ) {
        const locale = presentationCatalogMatch
          ? presentationCatalogMatch[1]
          : readPresentationLocale(request.url);
        if (!SUPPORTED_LOCALES.includes(locale as SupportedLocale)) {
          throw new HttpError(
            404,
            "PRESENTATION_LOCALE_UNSUPPORTED",
            "The requested presentation locale is not supported."
          );
        }
        return writeJson(response, 200, {
          schemaVersion: "presentation-catalog/v1",
          locale,
          messages: getPresentationCatalog(locale as SupportedLocale)
        });
      }

      if (
        (runtime.mode === "persistent" || runtime.mode === "setup") &&
        request.method === "GET" &&
        pathname === "/api/configuration"
      ) {
        requireTrustedHost(request.headers.host);
        const configuration = runtime.mode === "setup"
          ? runtime.configuration
          : requireConfiguration(runtime.configuration);
        const view = await configuration.inspect();
        return writeJson(response, 200, {
          schemaVersion: "control-room-configuration/v1",
          instanceId: runtime.mode === "persistent"
            ? (configuration as PersistentConfigurationPort).instanceId
            : "setup-runtime",
          csrfToken: runtime.csrfToken,
          configuration: view,
          runtime: {
            activeRevision: runtime.mode === "persistent"
              ? (configuration as PersistentConfigurationPort).activeRuntimeRevision
              : null,
            desiredRevision: view.runtimeRevision,
            restartRequired:
              runtime.mode === "persistent"
                ? (configuration as PersistentConfigurationPort).activeRuntimeRevision !== view.runtimeRevision
                : false
          }
        });
      }

      const configurationDraftMatch =
        (runtime.mode === "persistent" || runtime.mode === "setup") &&
        request.method === "GET" &&
        /^\/api\/configuration\/drafts\/(user|project|local)$/.exec(
          pathname
        );

      if (
        configurationDraftMatch &&
        (runtime.mode === "persistent" || runtime.mode === "setup")
      ) {
        requireTrustedHost(request.headers.host);
        const configuration = runtime.mode === "setup"
          ? runtime.configuration
          : requireConfiguration(runtime.configuration);
        const scope = configurationDraftMatch[1] as
          | "user"
          | "project"
          | "local";
        return writeJson(response, 200, {
          instanceId: runtime.mode === "persistent"
            ? (configuration as PersistentConfigurationPort).instanceId
            : "setup-runtime",
          draft: await configuration.readDraft(scope)
        });
      }

      if (
        (runtime.mode === "persistent" || runtime.mode === "setup") &&
        request.method === "POST" &&
        pathname === "/api/configuration/change"
      ) {
        validatePersistentWriteRequest(request, runtime.csrfToken);
        const configuration = runtime.mode === "setup"
          ? runtime.configuration
          : requireConfiguration(runtime.configuration);
        const body = validateConfigurationChangeBody(
          await readJsonBody(request, 256 * 1024)
        );
        return writeJson(
          response,
          200,
          await configuration.applyChange(
            body.change,
            body.expectedRevision
          )
        );
      }

      if (
        (runtime.mode === "persistent" || runtime.mode === "setup") &&
        request.method === "POST" &&
        pathname === "/api/configuration/draft"
      ) {
        validatePersistentWriteRequest(request, runtime.csrfToken);
        const configuration = runtime.mode === "setup"
          ? runtime.configuration
          : requireConfiguration(runtime.configuration);
        const body = validateConfigurationDraftBody(
          await readJsonBody(request, 256 * 1024)
        );
        return writeJson(
          response,
          200,
          await configuration.applyDraft(
            body.scope,
            body.document,
            body.expectedRevision
          )
        );
      }

      if (
        runtime.mode === "persistent" &&
        request.method === "GET" &&
        pathname === "/api/providers"
      ) {
        return writeJson(
          response,
          200,
          await runtime.providerStatus.list()
        );
      }

      if (
        runtime.mode === "persistent" &&
        request.method === "POST" &&
        pathname ===
          "/api/decompositions/preview"
      ) {
        validatePersistentWriteRequest(
          request,
          runtime.csrfToken
        );
        const decomposition =
          requireDecompositionControl(
            runtime.decomposition
          );
        if (
          !decomposition.capabilities
            .preview
        ) {
          throw new HttpError(
            403,
            "DECOMPOSITION_PREVIEW_DISABLED",
            "TaskSeal decomposition preview is disabled."
          );
        }
        const body =
          validateDecompositionPreviewBody(
            await readJsonBody(
              request,
              1024 * 1024
            )
          );
        return writeJson(
          response,
          200,
          decomposition.preview(
            body.draft
          )
        );
      }

      if (
        runtime.mode === "persistent" &&
        request.method === "POST" &&
        pathname ===
          "/api/decompositions/approve"
      ) {
        validatePersistentWriteRequest(
          request,
          runtime.csrfToken
        );
        const decomposition =
          requireDecompositionControl(
            runtime.decomposition
          );
        if (
          !decomposition.capabilities
            .approve
        ) {
          throw new HttpError(
            403,
            "DECOMPOSITION_APPROVAL_DISABLED",
            "TaskSeal decomposition approval is disabled."
          );
        }
        const body =
          validateDecompositionApprovalBody(
            await readJsonBody(
              request,
              1024 * 1024
            )
          );
        return writeJson(
          response,
          200,
          await decomposition.approve(
            body
          )
        );
      }

      const decompositionDispatchMatch =
        runtime.mode === "persistent" &&
        request.method === "POST" &&
        /^\/api\/decompositions\/([^/]+)\/dispatch$/.exec(
          pathname
        );

      if (
        decompositionDispatchMatch &&
        runtime.mode === "persistent"
      ) {
        validatePersistentWriteRequest(
          request,
          runtime.csrfToken
        );
        const decomposition =
          requireDecompositionControl(
            runtime.decomposition
          );
        if (
          !decomposition.capabilities
            .dispatch
        ) {
          throw new HttpError(
            403,
            "DECOMPOSITION_DISPATCH_DISABLED",
            "TaskSeal decomposition dispatch is disabled."
          );
        }
        const dispatcher =
          requireDecompositionDispatcher(
            decompositionDispatcher
          );
        const planId =
          decodePathSegment(
            decompositionDispatchMatch[1]
          );
        const body =
          validateDecompositionDispatchBody(
            await readJsonBody(request)
          );
        return writeJson(
          response,
          202,
          await dispatcher.dispatchOnce({
            planId,
            expectedPlanDigest:
              body.expectedPlanDigest
          })
        );
      }

      const decompositionRetirementMatch =
        runtime.mode === "persistent" &&
        request.method === "POST" &&
        /^\/api\/decompositions\/([^/]+)\/retire$/.exec(
          pathname
        );

      if (
        decompositionRetirementMatch &&
        runtime.mode === "persistent"
      ) {
        validatePersistentWriteRequest(
          request,
          runtime.csrfToken
        );
        const decomposition =
          requireDecompositionControl(
            runtime.decomposition
          );
        const dispatcher =
          requireDecompositionDispatcher(
            decompositionDispatcher
          );
        if (
          !decomposition.capabilities
            .retire
        ) {
          throw new HttpError(
            403,
            "DECOMPOSITION_RETIREMENT_DISABLED",
            "TaskSeal decomposition retirement is disabled."
          );
        }
        const planId =
          decodePathSegment(
            decompositionRetirementMatch[1]
          );
        const body =
          validateDecompositionRetirementBody(
            await readJsonBody(request)
          );
        return writeJson(
          response,
          200,
          await dispatcher.retireOnce({
            planId,
            expectedPlanDigest:
              body.expectedPlanDigest,
            reasonCode:
              body.reasonCode,
            note: body.note
          })
        );
      }

      const acceptanceMatch =
        runtime.mode === "persistent" &&
        request.method === "POST" &&
        /^\/api\/work-items\/([^/]+)\/acceptance$/.exec(
          pathname
        );

      if (
        acceptanceMatch &&
        runtime.mode === "persistent"
      ) {
        validatePersistentWriteRequest(
          request,
          runtime.csrfToken
        );
        if (
          !runtime.acceptanceCapabilities
            .decideAcceptance ||
          runtime.acceptance === null
        ) {
          throw new HttpError(
            403,
            "ACCEPTANCE_DISABLED",
            "TaskSeal local acceptance is disabled."
          );
        }
        const workItemId =
          decodePathSegment(
            acceptanceMatch[1]
          );
        if (
          !runtime.service.getWorkItem(
            workItemId
          )
        ) {
          throw new HttpError(
            404,
            "WORK_ITEM_NOT_FOUND",
            `TaskSeal work item ${workItemId} does not exist.`
          );
        }
        const body =
          validateAcceptanceBody(
            await readJsonBody(request)
          );
        const decide = () =>
          runtime.acceptance!.decide({
            workItemId,
            ...body
          });
        return writeJson(
          response,
          200,
          decompositionDispatcher ===
            null
            ? (
                runtime.decomposition
                  ?.assertAcceptanceAllowed(
                    workItemId,
                    body.decision
                  ),
                await decide()
              )
            : await decompositionDispatcher
                .decideAcceptanceOnce({
                  workItemId,
                  decision:
                    body.decision,
                  decide
                })
        );
      }

      const reconciliationMatch =
        runtime.mode === "persistent" &&
        request.method === "POST" &&
        /^\/api\/provider-operations\/([^/]+)\/reconcile$/.exec(
          pathname
        );

      if (
        reconciliationMatch &&
        runtime.mode === "persistent"
      ) {
        validatePersistentWriteRequest(
          request,
          runtime.csrfToken
        );
        if (
          !runtime.acceptanceCapabilities
            .reconcileLinearTransition ||
          runtime.acceptance === null
        ) {
          throw new HttpError(
            403,
            "LINEAR_RECONCILIATION_DISABLED",
            "TaskSeal Linear reconciliation is disabled."
          );
        }
        const operationKey =
          decodePathSegment(
            reconciliationMatch[1]
          );
        validateReconciliationBody(
          await readJsonBody(request)
        );
        return writeJson(
          response,
          200,
          await runtime.acceptance.reconcile({
            operationKey
          })
        );
      }

      const runMatch =
        runtime.mode === "persistent" &&
        request.method === "POST" &&
        /^\/api\/work-items\/([^/]+)\/run$/.exec(pathname);

      if (runMatch && runtime.mode === "persistent") {
        validatePersistentWriteRequest(
          request,
          runtime.csrfToken
        );
        const workItemId = decodePathSegment(runMatch[1]);
        const workItem =
          runtime.service.getWorkItem(workItemId);

        if (!workItem) {
          throw new HttpError(
            404,
            "WORK_ITEM_NOT_FOUND",
            `TaskSeal work item ${workItemId} does not exist.`
          );
        }

        const body = validateRunBody(
          await readJsonBody(request)
        );
        lastErrors.delete(workItemId);
        const execute = ({
          signal,
          terminalization
        }: AttemptRunExecutionContext) =>
          runtime.runWorkItem({
            workItemId,
            prompt: body.prompt,
            sandbox:
              body.readOnly === false
                ? "workspace-write"
                : "read-only",
            signal,
            terminalization
          });
        const run =
          decompositionDispatcher ===
          null
            ? requireAttemptRuns(
                attemptRuns
              ).start({
                workItemId,
                execute
              })
            : decompositionDispatcher
                .startManualRun({
                  workItemId,
                  execute
                });
        void run.execution.catch((error) => {
          lastErrors.set(workItemId, {
            code: readSafeErrorCode(
              error,
              "RUNNER_FAILED"
            ),
            message: "TaskSeal run failed.",
            recordedAt: new Date().toISOString()
          });
        });

        return writeJson(
          response,
          202,
          buildPersistentSnapshot(
            runtime.service,
            requireAttemptRuns(attemptRuns),
            lastErrors,
            runtime.csrfToken,
            runtime.acceptanceCapabilities,
            runtime.operatorId,
            decompositionDispatcher,
            runtime.decomposition
          )
        );
      }

      const cancelMatch =
        runtime.mode === "persistent" &&
        request.method === "POST" &&
        /^\/api\/work-items\/([^/]+)\/cancel$/.exec(
          pathname
        );

      if (cancelMatch && runtime.mode === "persistent") {
        validatePersistentWriteRequest(
          request,
          runtime.csrfToken
        );
        const workItemId = decodePathSegment(
          cancelMatch[1]
        );
        const workItem =
          runtime.service.getWorkItem(workItemId);

        if (!workItem) {
          throw new HttpError(
            404,
            "WORK_ITEM_NOT_FOUND",
            `TaskSeal work item ${workItemId} does not exist.`
          );
        }

        validateCancelBody(
          await readJsonBody(request)
        );
        requireAttemptRuns(attemptRuns).cancel(
          workItemId
        );

        return writeJson(
          response,
          202,
          buildPersistentSnapshot(
            runtime.service,
            requireAttemptRuns(attemptRuns),
            lastErrors,
            runtime.csrfToken,
            runtime.acceptanceCapabilities,
            runtime.operatorId,
            decompositionDispatcher,
            runtime.decomposition
          )
        );
      }

      if (
        runtime.mode === "demo" &&
        request.method === "POST" &&
        pathname === "/api/demo/next"
      ) {
        const candidateStep = clampStep(
          runtime.currentStep + 1,
          runtime.steps.length
        );
        const snapshot = buildDemoSnapshot(
          runtime.steps,
          candidateStep
        );
        runtime.currentStep = candidateStep;
        return writeJson(response, 200, snapshot);
      }

      if (
        runtime.mode === "demo" &&
        request.method === "POST" &&
        pathname === "/api/demo/run-all"
      ) {
        const candidateStep = runtime.steps.length;
        const snapshot = buildDemoSnapshot(
          runtime.steps,
          candidateStep
        );
        runtime.currentStep = candidateStep;
        return writeJson(response, 200, snapshot);
      }

      if (
        runtime.mode === "demo" &&
        request.method === "POST" &&
        pathname === "/api/demo/reset"
      ) {
        const candidateStep = Math.min(
          1,
          runtime.steps.length
        );
        const snapshot = buildDemoSnapshot(
          runtime.steps,
          candidateStep
        );
        runtime.currentStep = candidateStep;
        return writeJson(response, 200, snapshot);
      }

      const staticFile = STATIC_FILES.get(pathname);

      if (request.method === "GET" && staticFile) {
        return writeStatic(response, staticFile);
      }

      return writeJson(response, 404, {
        error: "NOT_FOUND",
        message: "The requested resource does not exist."
      });
    } catch (error) {
      const failure = normalizeResponseError(error);
      return writeJson(response, failure.statusCode, {
        error: failure.code,
        message: failure.message
      });
    }
  });

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      const closePromise = server.listening
        ? new Promise<void>((resolve) =>
            server.close(() => resolve())
          )
        : Promise.resolve();

      if (attemptRuns) {
        await attemptRuns.shutdown();
      }

      server.closeAllConnections();
      await closePromise;
    })();

    return shutdownPromise;
  };

  return Object.assign(server, { shutdown });
}

function createServerRuntime(
  options: TaskSealServerOptions
): ServerRuntime {
  if ("setup" in options && options.setup === true) {
    if (
      !isValidConfigurationAuthority(options.configuration) ||
      typeof options.readiness !== "function" ||
      !isValidConnectionProbeRuntime(options.connectionProbe)
    ) {
      throw new TypeError(
        "Setup TaskSeal server requires configuration and readiness ports."
      );
    }
    return {
      mode: "setup",
      configuration: options.configuration,
      readiness: options.readiness,
      connectionProbe:
        options.connectionProbe ?? createConfigurationConnectionProbe(),
      csrfToken: randomBytes(32).toString("base64url")
    };
  }

  const service = options.service;
  const steps = options.steps;

  if (service !== undefined && steps !== undefined) {
    throw new TypeError(
      "TaskSeal server cannot use demo and persistent state together."
    );
  }

  if (service !== undefined) {
    const acceptance =
      options.acceptance ?? null;
    const acceptanceCapabilities =
      options.acceptanceCapabilities ?? {
        decideAcceptance: false,
        linearTransition: false,
        reconcileLinearTransition: false
      };
    const operatorId =
      options.operatorId ?? null;
    const decomposition =
      options.decomposition ?? null;
    const configuration = options.configuration ?? null;
    if (
      typeof service.snapshot !== "function" ||
      typeof service.getWorkItem !== "function" ||
      !isRecord(options.providerStatus) ||
      typeof options.providerStatus.list !== "function" ||
      typeof options.runWorkItem !== "function" ||
      !isValidAcceptanceRuntime(
        acceptance,
        acceptanceCapabilities,
        operatorId
      ) ||
      !isValidDecompositionRuntime(
        decomposition
      ) ||
      !isValidConfigurationRuntime(
        configuration
      ) ||
      !isValidConnectionProbeRuntime(options.connectionProbe) ||
      !isValidConnectionProbeRuntime(options.networkConnectionProbe) ||
      !isValidProjectHubRuntime(options.projectHub) ||
      !isValidProjectRegistryRuntime(options.projectRegistry)
    ) {
      throw new TypeError(
        "Persistent TaskSeal server requires a service and runWorkItem."
      );
    }

    return {
      mode: "persistent",
      service,
      providerStatus: options.providerStatus,
      acceptance,
      acceptanceCapabilities,
      operatorId,
      decomposition,
      runWorkItem: options.runWorkItem,
      maxConcurrentRuns:
        options.maxConcurrentRuns ?? 1,
      csrfToken: randomBytes(32).toString("base64url"),
      configuration,
      connectionProbe:
        options.connectionProbe ?? createConfigurationConnectionProbe(),
      networkConnectionProbe: options.networkConnectionProbe ?? null,
      projectHub: options.projectHub ?? null,
      projectRegistry: options.projectRegistry ?? null
    };
  }

  if (!Array.isArray(steps)) {
    throw new TypeError("Demo TaskSeal server requires steps.");
  }

  return {
    mode: "demo",
    steps,
    currentStep: clampStep(
      options.initialStep ?? 1,
      steps.length
    )
  };
}

interface HomeServerResponse extends HomeSnapshot {
  readonly capabilities: Record<string, boolean>;
  readonly security: {
    readonly csrfToken: string | null;
    readonly operatorId: string | null;
  };
}

function buildDemoConnectionsResponse() {
  const configurationRevision = `sha256:${"0".repeat(64)}`;
  const setupUrls: Record<ConnectionProbeProvider, string> = {
    github: "https://github.com/settings/tokens",
    linear: "https://linear.app/settings/api",
    gitee: "https://gitee.com/profile/personal_access_tokens",
    feishu: "https://open.feishu.cn/app"
  };
  return {
    schemaVersion: "connections/v1" as const,
    generatedAt: new Date().toISOString(),
    configurationRevision,
    runtimeRevision: configurationRevision,
    activeRuntimeRevision: null,
    connections: (Object.keys(setupUrls) as ConnectionProbeProvider[]).map((id) => ({
      id,
      configured: false,
      capability: "disabled" as const,
      credential: {
        requirement: "optional" as const,
        status: "not-configured" as const,
        bindings: [] as readonly string[]
      },
      connectivity: {
        status: "not-configured" as const,
        basis: "configuration" as const,
        observedAt: null
      },
      activation: "next-operation" as const,
      setupUrl: setupUrls[id]
    })),
    security: { csrfToken: null },
    capabilities: { explicitProbe: false, networkProbe: false }
  };
}

function isValidConfigurationRuntime(
  configuration: PersistentConfigurationPort | null
): boolean {
  return configuration === null ||
    (
      isRecord(configuration) &&
      typeof configuration.instanceId === "string" &&
      configuration.instanceId.length >= 1 &&
      configuration.instanceId.length <= 160 &&
      !/[\u0000-\u001f\u007f-\u009f]/.test(configuration.instanceId) &&
      typeof configuration.activeRuntimeRevision === "string" &&
      /^sha256:[0-9a-f]{64}$/.test(configuration.activeRuntimeRevision) &&
      typeof configuration.inspect === "function" &&
      typeof configuration.readDraft === "function" &&
      typeof configuration.applyChange === "function" &&
      typeof configuration.applyDraft === "function"
    );
}

function isValidConfigurationAuthority(
  configuration: ConfigurationAuthority
): boolean {
  return isRecord(configuration) &&
    (configuration.kind === "local" || configuration.kind === "running-instance") &&
    typeof configuration.inspect === "function" &&
    typeof configuration.readDraft === "function" &&
    typeof configuration.applyChange === "function" &&
    typeof configuration.applyDraft === "function";
}

function isValidConnectionProbeRuntime(
  probe: ConnectionProbePort | null | undefined
): boolean {
  return probe === null ||
    probe === undefined ||
    (isRecord(probe) && typeof probe.probe === "function");
}

function isValidProjectHubRuntime(
  projectHub: ProjectHubQueryPort | null | undefined
): boolean {
  return projectHub === null ||
    projectHub === undefined ||
    (isRecord(projectHub) && typeof projectHub.read === "function");
}

function isValidProjectRegistryRuntime(
  registry: ProjectRegistryPort | null | undefined
): boolean {
  return registry === null ||
    registry === undefined ||
    (isRecord(registry) && typeof registry.list === "function");
}

function isValidDecompositionRuntime(
  decomposition:
    | PersistentDecompositionControlPort
    | null
): boolean {
  if (decomposition === null) {
    return true;
  }
  const capabilities =
    decomposition.capabilities;
  return (
    isRecord(decomposition) &&
    isRecord(capabilities) &&
    hasExactKeys(capabilities, [
      "preview",
      "approve",
      "dispatch",
      "retire"
    ]) &&
    typeof capabilities.preview ===
      "boolean" &&
    typeof capabilities.approve ===
      "boolean" &&
    typeof capabilities.dispatch ===
      "boolean" &&
    typeof capabilities.retire ===
      "boolean" &&
    typeof decomposition.preview ===
      "function" &&
    typeof decomposition.approve ===
      "function" &&
    typeof decomposition
      .listRetirements ===
      "function" &&
    typeof decomposition
      .assertManualRunAllowed ===
      "function" &&
    typeof decomposition
      .assertAcceptanceAllowed ===
      "function" &&
    typeof decomposition
      .createDispatcher ===
      "function" &&
    (
      decomposition.getHealth ===
        undefined ||
      typeof decomposition.getHealth ===
        "function"
    )
  );
}

interface AcceptanceRequestBody {
  decisionId: string;
  decision: "accepted" | "rejected";
  reason: string;
  expectedReviewRevision: string;
}

function isValidAcceptanceRuntime(
  acceptance:
    | PersistentAcceptancePort
    | null,
  capabilities: unknown,
  operatorId: unknown
): capabilities is
  PersistentRuntime["acceptanceCapabilities"] {
  if (
    !isRecord(capabilities) ||
    Object.keys(capabilities).length !==
      3 ||
    typeof capabilities
      .decideAcceptance !== "boolean" ||
    typeof capabilities
      .linearTransition !== "boolean" ||
    typeof capabilities
      .reconcileLinearTransition !==
      "boolean" ||
    (
      capabilities
        .linearTransition &&
      !capabilities.decideAcceptance
    ) ||
    (
      capabilities
        .reconcileLinearTransition &&
      !capabilities.linearTransition
    ) ||
    (
      operatorId !== null &&
      (
        typeof operatorId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
          operatorId
        )
      )
    )
  ) {
    return false;
  }
  if (!capabilities.decideAcceptance) {
    return (
      acceptance === null &&
      operatorId === null
    );
  }
  return (
    acceptance !== null &&
    typeof acceptance === "object" &&
    typeof acceptance.decide ===
      "function" &&
    typeof acceptance.reconcile ===
      "function" &&
    typeof operatorId === "string"
  );
}

function readRequestPathname(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(
      400,
      "INVALID_URL",
      "TaskSeal request URL is invalid."
    );
  }

  try {
    return new URL(value, "http://localhost").pathname;
  } catch {
    throw new HttpError(
      400,
      "INVALID_URL",
      "TaskSeal request URL is invalid."
    );
  }
}

function readFencedHealth(
  runtime: ServerRuntime
): FencedHealth | null {
  if (runtime.mode !== "persistent") {
    return null;
  }
  const healthValues = [
    typeof runtime.service
      .getHealth === "function"
      ? runtime.service.getHealth()
      : null,
    typeof runtime.decomposition
      ?.getHealth === "function"
      ? runtime.decomposition
          .getHealth()
      : null
  ];

  for (const health of healthValues) {
    if (
      !isRecord(health) ||
      health.status !== "fenced"
    ) {
      continue;
    }
    return {
      status: "fenced",
      code: readSafeErrorCode(
        health,
        "SERVICE_FENCED"
      ),
      planDigest:
        typeof health.planDigest ===
        "string"
          ? health.planDigest.slice(
              0,
              256
            )
          : null
    };
  }
  return null;
}

function buildDemoSnapshot(
  steps: readonly DemoStep[],
  currentStep: number
): DemoSnapshot {
  const workflow = replayDemoSteps(steps, currentStep);

  return {
    ...projectDashboard(workflow),
    mode: "demo",
    capabilities: {
      demo: true,
      runAttempt: false,
      cancelAttempt: false,
      previewDecomposition: false,
      approveDecomposition: false,
      dispatchDecomposition: false,
      retireDecomposition: false
    },
    orchestration: [],
    decompositionRetirements: [],
    demo: {
      currentStep,
      totalSteps: steps.length,
      complete: currentStep === steps.length,
      timeline: steps.map((step, index) => ({
        number: index + 1,
        source: step.source,
        label: step.label,
        completed: index < currentStep,
        active: index === currentStep - 1
      }))
    }
  };
}

function buildPersistentSnapshot(
  service: PersistentServicePort,
  attemptRuns: AttemptRunCoordinator,
  lastErrors: ReadonlyMap<string, RuntimeError>,
  csrfToken: string,
  acceptanceCapabilities:
    PersistentRuntime["acceptanceCapabilities"],
  operatorId: string | null,
  decompositionDispatcher:
    PersistentDecompositionDispatcherPort | null,
  decomposition:
    PersistentDecompositionControlPort | null
): PersistentSnapshot {
  const dashboard = service.snapshot();
  const coordination = attemptRuns.snapshot();
  const attemptIds = new Map(
    dashboard.workItems.map((workItem) => [
      workItem.id,
      workItem.activeAttempt?.status === "running"
        ? workItem.activeAttempt.id
        : null
    ])
  );

  return {
    ...dashboard,
    mode: "persistent",
    capabilities: {
      demo: false,
      runAttempt: true,
      cancelAttempt: true,
      decideAcceptance:
        acceptanceCapabilities
          .decideAcceptance,
      linearTransition:
        acceptanceCapabilities
          .linearTransition,
      reconcileLinearTransition:
        acceptanceCapabilities
          .reconcileLinearTransition,
      previewDecomposition:
        decomposition?.capabilities
          .preview ?? false,
      approveDecomposition:
        decomposition?.capabilities
          .approve ?? false,
      dispatchDecomposition:
        decomposition?.capabilities
          .dispatch ?? false,
      retireDecomposition:
        decomposition?.capabilities
          .retire ?? false
    },
    orchestration:
      decompositionDispatcher?.list() ??
      [],
    decompositionRetirements:
      decomposition?.listRetirements() ??
      [],
    runtime: {
      activeWorkItemIds: coordination.runs.map(
        (run) => run.workItemId
      ),
      capacity: {
        maxConcurrentRuns:
          coordination.maxConcurrentRuns,
        activeCount: coordination.activeCount,
        availableSlots:
          coordination.availableSlots
      },
      runs: coordination.runs.map((run) => ({
        ...run,
        attemptId:
          attemptIds.get(run.workItemId) ?? null
      })),
      errors: Object.fromEntries(lastErrors)
    },
    security: {
      csrfToken,
      operatorId
    }
  };
}

function buildHomeServerResponse(
  snapshot: DemoSnapshot | PersistentSnapshot,
  projectName: string
): HomeServerResponse {
  const home = projectHomeSnapshot({
    dashboard: snapshot,
    mode: snapshot.mode,
    project: {
      key: "current",
      name: projectName
    },
    freshness:
      snapshot.mode === "persistent" &&
      Object.keys(snapshot.runtime.errors).length > 0
        ? "stale"
        : "fresh",
    runtime:
      snapshot.mode === "persistent"
        ? {
            ...snapshot.runtime.capacity,
            runs: snapshot.runtime.runs,
            errors: snapshot.runtime.errors
          }
        : undefined
  });

  return {
    ...home,
    capabilities: snapshot.capabilities,
    security:
      snapshot.mode === "persistent"
        ? snapshot.security
        : {
            csrfToken: null,
            operatorId: null
          }
  };
}

function requireAttemptRuns(
  value: AttemptRunCoordinator | null
): AttemptRunCoordinator {
  if (!value) {
    throw new TypeError(
      "Persistent TaskSeal runtime requires execution control."
    );
  }

  return value;
}

function readPresentationLocale(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return new URL(value, "http://localhost").searchParams.get("locale");
  } catch {
    return null;
  }
}

function requireConfiguration(
  value: PersistentConfigurationPort | null
): PersistentConfigurationPort {
  if (value === null) {
    throw new HttpError(
      403,
      "CONFIGURATION_CONTROL_DISABLED",
      "TaskSeal configuration control is disabled."
    );
  }
  return value;
}

function requireDecompositionControl(
  value:
    | PersistentDecompositionControlPort
    | null
): PersistentDecompositionControlPort {
  if (!value) {
    throw new HttpError(
      403,
      "DECOMPOSITION_DISABLED",
      "TaskSeal decomposition control is disabled."
    );
  }
  return value;
}

function requireDecompositionDispatcher(
  value:
    | PersistentDecompositionDispatcherPort
    | null
): PersistentDecompositionDispatcherPort {
  if (!value) {
    throw new HttpError(
      403,
      "DECOMPOSITION_DISABLED",
      "TaskSeal decomposition dispatch is disabled."
    );
  }
  return value;
}

function clampStep(value: number, maximum: number): number {
  return Math.max(0, Math.min(value, maximum));
}

function isSetupForbiddenPath(
  method: string | undefined,
  pathname: string
): boolean {
  if (method === "GET" && pathname === "/health") return false;
  if (method === "GET" && pathname === "/api/configuration") return false;
  if (method === "GET" && pathname === "/api/connections") return false;
  if (method === "GET" && pathname === "/api/readiness") return false;
  if (method === "GET" && pathname.startsWith("/api/presentation/catalog")) return false;
  if (method === "GET" && pathname.startsWith("/api/configuration/drafts/")) return false;
  if (method === "POST" && pathname === "/api/configuration/change") return false;
  if (method === "POST" && pathname === "/api/configuration/draft") return false;
  if (method === "POST" && /^\/api\/connections\/(github|linear|gitee|feishu)\/probe$/.test(pathname)) return false;
  return pathname.startsWith("/api/");
}

async function readJsonBody(
  request: IncomingMessage,
  maximumBytes = 64 * 1024
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  let exceeded = false;
  const bodyStream: AsyncIterable<unknown> = request;

  for await (const rawChunk of bodyStream) {
    const chunk =
      typeof rawChunk === "string"
        ? Buffer.from(rawChunk)
        : Buffer.isBuffer(rawChunk)
          ? rawChunk
          : null;

    if (!chunk) {
      throw new HttpError(
        400,
        "INVALID_REQUEST_BODY",
        "TaskSeal run request body is invalid."
      );
    }

    size += chunk.length;

    if (size > maximumBytes) {
      exceeded = true;
      continue;
    }

    chunks.push(chunk);
  }

  if (exceeded) {
    throw new HttpError(
      413,
      "REQUEST_TOO_LARGE",
      "TaskSeal request body exceeds its size limit."
    );
  }

  try {
    const parsed: unknown = JSON.parse(
      Buffer.concat(chunks).toString("utf8")
    );
    return parsed;
  } catch {
    throw new HttpError(
      400,
      "INVALID_JSON",
      "TaskSeal run request must contain valid JSON."
    );
  }
}

function validateConnectionProbeBody(
  body: unknown
): ConnectionProbeRequestBody {
  if (
    !isRecord(body) ||
    !hasExactKeys(body, ["expectedConfigurationRevision"]) ||
    typeof body.expectedConfigurationRevision !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(body.expectedConfigurationRevision)
  ) {
    throw new HttpError(
      400,
      "INVALID_CONNECTION_PROBE_REQUEST",
      "Connection probes require the current configuration revision."
    );
  }
  return {
    expectedConfigurationRevision: body.expectedConfigurationRevision
  };
}

function validateConfigurationChangeBody(
  body: unknown
): ConfigurationChangeRequestBody {
  if (
    !isRecord(body) ||
    !hasExactKeys(body, ["expectedRevision", "change"]) ||
    typeof body.expectedRevision !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(body.expectedRevision) ||
    !isRecord(body.change) ||
    typeof body.change.key !== "string" ||
    !/^[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(
      body.change.key
    )
  ) {
    throw invalidConfigurationRequest();
  }
  if (
    body.change.operation === "unset" &&
    hasExactKeys(body.change, ["operation", "key"])
  ) {
    return {
      expectedRevision: body.expectedRevision,
      change: {
        operation: "unset",
        key: body.change.key
      }
    };
  }
  if (
    body.change.operation === "set" &&
    hasExactKeys(body.change, ["operation", "key", "value"])
  ) {
    return {
      expectedRevision: body.expectedRevision,
      change: {
        operation: "set",
        key: body.change.key,
        value: body.change.value
      }
    };
  }
  throw invalidConfigurationRequest();
}

function validateConfigurationDraftBody(
  body: unknown
): ConfigurationDraftRequestBody {
  if (
    !isRecord(body) ||
    !hasExactKeys(body, [
      "expectedRevision",
      "scope",
      "document"
    ]) ||
    typeof body.expectedRevision !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(body.expectedRevision) ||
    (body.scope !== "user" &&
      body.scope !== "project" &&
      body.scope !== "local") ||
    !isRecord(body.document)
  ) {
    throw invalidConfigurationRequest();
  }
  return {
    expectedRevision: body.expectedRevision,
    scope: body.scope,
    document: body.document
  };
}

function invalidConfigurationRequest(): HttpError {
  return new HttpError(
    400,
    "INVALID_CONFIGURATION_REQUEST",
    "TaskSeal configuration request is invalid."
  );
}

function validateDecompositionPreviewBody(
  body: unknown
): DecompositionPreviewRequestBody {
  if (
    !isRecord(body) ||
    !hasExactKeys(body, ["draft"])
  ) {
    throw new HttpError(
      400,
      "INVALID_DECOMPOSITION_PREVIEW_REQUEST",
      "TaskSeal decomposition preview request is invalid."
    );
  }
  return {
    draft: body.draft
  };
}

function validateDecompositionApprovalBody(
  body: unknown
): DecompositionApprovalRequestBody {
  if (
    !isRecord(body) ||
    !hasExactKeys(body, [
      "draft",
      "expectedPlanDigest"
    ]) ||
    typeof body.expectedPlanDigest !==
      "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(
      body.expectedPlanDigest
    )
  ) {
    throw new HttpError(
      400,
      "INVALID_DECOMPOSITION_APPROVAL_REQUEST",
      "TaskSeal decomposition approval request is invalid."
    );
  }
  return {
    draft: body.draft,
    expectedPlanDigest:
      body.expectedPlanDigest
  };
}

function validateDecompositionDispatchBody(
  body: unknown
): DecompositionDispatchRequestBody {
  if (
    !isRecord(body) ||
    !hasExactKeys(body, [
      "expectedPlanDigest"
    ]) ||
    typeof body.expectedPlanDigest !==
      "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(
      body.expectedPlanDigest
    )
  ) {
    throw new HttpError(
      400,
      "INVALID_DECOMPOSITION_DISPATCH_REQUEST",
      "TaskSeal decomposition dispatch request is invalid."
    );
  }
  return {
    expectedPlanDigest:
      body.expectedPlanDigest
  };
}

function validateDecompositionRetirementBody(
  body: unknown
): DecompositionRetirementRequestBody {
  if (
    !isRecord(body) ||
    !hasExactKeys(body, [
      "expectedPlanDigest",
      "reasonCode",
      "note"
    ]) ||
    typeof body.expectedPlanDigest !==
      "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(
      body.expectedPlanDigest
    ) ||
    (
      body.reasonCode !==
        "interrupted" &&
      body.reasonCode !==
        "human_rejected" &&
      body.reasonCode !==
        "runner_profile_drift" &&
      body.reasonCode !==
        "operator_rollback"
    ) ||
    typeof body.note !==
      "string" ||
    body.note !==
      body.note.trim() ||
    body.note.length === 0 ||
    !body.note.isWellFormed() ||
    [...body.note].length >
      2_048 ||
    Buffer.byteLength(
      body.note,
      "utf8"
    ) > 8_192 ||
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(
      body.note
    )
  ) {
    throw new HttpError(
      400,
      "INVALID_DECOMPOSITION_RETIREMENT_REQUEST",
      "TaskSeal decomposition retirement request is invalid."
    );
  }
  return {
    expectedPlanDigest:
      body.expectedPlanDigest,
    reasonCode:
      body.reasonCode,
    note: body.note
  };
}

function validatePersistentWriteRequest(
  request: IncomingMessage,
  csrfToken: string
): void {
  const contentType = request.headers["content-type"];

  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;|$)/i.test(contentType)
  ) {
    throw new HttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "TaskSeal run requests require application/json."
    );
  }

  const host = requireTrustedHost(request.headers.host);

  const origin = request.headers.origin;

  if (
    origin !== undefined &&
    (typeof origin !== "string" ||
      origin !== `http://${host}`)
  ) {
    throw new HttpError(
      403,
      "UNTRUSTED_ORIGIN",
      "TaskSeal rejected a cross-origin run request."
    );
  }

  const fetchSite = request.headers["sec-fetch-site"];

  if (
    fetchSite !== undefined &&
    (typeof fetchSite !== "string" ||
      (fetchSite !== "same-origin" &&
        fetchSite !== "none"))
  ) {
    throw new HttpError(
      403,
      "UNTRUSTED_ORIGIN",
      "TaskSeal rejected a cross-site run request."
    );
  }

  const suppliedToken = request.headers["x-taskseal-csrf-token"];

  if (!secureTokenEquals(suppliedToken, csrfToken)) {
    throw new HttpError(
      403,
      "CSRF_TOKEN_INVALID",
      "TaskSeal run request is missing its session token."
    );
  }
}

function requireTrustedHost(value: unknown): string {
  if (typeof value !== "string") {
    throw untrustedHost();
  }

  const host = value.toLowerCase();
  const nameOrIpv4 =
    /^(?:localhost|127\.0\.0\.1)(?::([0-9]+))?$/.exec(
      host
    );
  const ipv6 = /^\[::1\](?::([0-9]+))?$/.exec(host);
  const match = nameOrIpv4 ?? ipv6;

  if (!match) {
    throw untrustedHost();
  }

  const portText = match[1];

  if (portText !== undefined) {
    const port = Number(portText);

    if (
      !Number.isSafeInteger(port) ||
      port < 0 ||
      port > 65_535
    ) {
      throw untrustedHost();
    }
  }

  return value;
}

function untrustedHost(): HttpError {
  return new HttpError(
    403,
    "UNTRUSTED_HOST",
    "TaskSeal only accepts loopback requests."
  );
}

function secureTokenEquals(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }

  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function validateRunBody(body: unknown): RunRequestBody {
  if (
    !isRecord(body) ||
    typeof body.prompt !== "string" ||
    body.prompt.trim().length === 0
  ) {
    throw new HttpError(
      400,
      "INVALID_RUN_REQUEST",
      "TaskSeal run request requires a non-empty prompt."
    );
  }

  if (
    body.readOnly !== undefined &&
    typeof body.readOnly !== "boolean"
  ) {
    throw new HttpError(
      400,
      "INVALID_RUN_REQUEST",
      "TaskSeal readOnly must be a boolean."
    );
  }

  return {
    prompt: body.prompt,
    ...(body.readOnly === undefined
      ? {}
      : { readOnly: body.readOnly })
  };
}

function validateCancelBody(body: unknown): void {
  if (
    !isRecord(body) ||
    Object.keys(body).length !== 0
  ) {
    throw new HttpError(
      400,
      "INVALID_CANCEL_REQUEST",
      "TaskSeal cancel request must be an empty JSON object."
    );
  }
}

function validateAcceptanceBody(
  body: unknown
): AcceptanceRequestBody {
  if (
    !isRecord(body) ||
    !hasExactKeys(body, [
      "decisionId",
      "decision",
      "reason",
      "expectedReviewRevision"
    ]) ||
    typeof body.decisionId !==
      "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      body.decisionId
    ) ||
    (
      body.decision !== "accepted" &&
      body.decision !== "rejected"
    ) ||
    typeof body.reason !== "string" ||
    body.reason !== body.reason.trim() ||
    body.reason.length === 0 ||
    !body.reason.isWellFormed() ||
    [...body.reason].length > 2_048 ||
    Buffer.byteLength(
      body.reason,
      "utf8"
    ) > 8_192 ||
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(
      body.reason
    ) ||
    typeof body.expectedReviewRevision !==
      "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(
      body.expectedReviewRevision
    )
  ) {
    throw new HttpError(
      400,
      "INVALID_ACCEPTANCE_REQUEST",
      "TaskSeal acceptance request is invalid."
    );
  }
  return {
    decisionId: body.decisionId,
    decision: body.decision,
    reason: body.reason,
    expectedReviewRevision:
      body.expectedReviewRevision
  };
}

function validateReconciliationBody(
  body: unknown
): void {
  if (
    !isRecord(body) ||
    !hasExactKeys(body, [])
  ) {
    throw new HttpError(
      400,
      "INVALID_RECONCILIATION_REQUEST",
      "TaskSeal reconciliation request is invalid."
    );
  }
}

function decodePathSegment(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(
      400,
      "INVALID_PATH",
      "TaskSeal work item id is not valid URL encoding."
    );
  }

  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(
      400,
      "INVALID_PATH",
      "TaskSeal work item id is not valid URL encoding."
    );
  }
}

function normalizeResponseError(
  error: unknown
): ResponseFailure {
  if (error instanceof HttpError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message
    };
  }

  if (error instanceof AttemptRunCoordinatorError) {
    return {
      statusCode:
        error.code === "RUN_CAPACITY_REACHED"
          ? 429
          : error.code === "SERVER_SHUTTING_DOWN"
            ? 503
            : 409,
      code: error.code,
      message: error.message
    };
  }

  if (
    isRecord(error) &&
    (
      error.name ===
        "DecompositionPlanError" ||
      error.name ===
        "DecompositionControlError" ||
      error.name ===
        "DecompositionPlanJournalError" ||
      error.name ===
        "DecompositionPlanStoreError" ||
      error.name ===
        "DecompositionDispatcherError"
    )
  ) {
    const code = readSafeErrorCode(
      error,
      "DECOMPOSITION_ERROR"
    );
    const statusCode =
      code ===
        "DECOMPOSITION_PLAN_NOT_FOUND"
        ? 404
        : code ===
              "DECOMPOSITION_APPROVAL_DISABLED" ||
            code ===
              "DECOMPOSITION_PREVIEW_DISABLED" ||
            code ===
              "DECOMPOSITION_DISPATCH_DISABLED"
              || code ===
                "DECOMPOSITION_RETIREMENT_DISABLED"
          ? 403
          : code ===
                "DECOMPOSITION_CAPACITY_REACHED" ||
              code ===
                "RUN_CAPACITY_REACHED"
            ? 429
            : code ===
                  "DECOMPOSITION_MANAGED_WORK_ITEM" ||
                code ===
                  "DECOMPOSITION_APPROVING" ||
                code ===
                  "DECOMPOSITION_ACCEPTING" ||
                code ===
                  "DECOMPOSITION_APPROVAL_ACTIVE" ||
                code ===
                  "DECOMPOSITION_APPROVAL_STALE" ||
                code ===
                  "DECOMPOSITION_ROOT_NOT_READY" ||
                code ===
                  "DECOMPOSITION_DEPENDENCY_NOT_ACCEPTED" ||
                code ===
                  "DECOMPOSITION_DISPATCH_STALE" ||
                code ===
                  "DECOMPOSITION_NOT_DISPATCHABLE" ||
                code ===
                  "DECOMPOSITION_PLAN_STALE" ||
                code ===
                  "DECOMPOSITION_PLAN_CONFLICT" ||
                code ===
                  "DECOMPOSITION_PLAN_OWNERSHIP_CONFLICT"
                || code ===
                  "DECOMPOSITION_RETIRING"
                || code ===
                  "DECOMPOSITION_RETIREMENT_ACTIVE"
                || code ===
                  "DECOMPOSITION_RETIREMENT_STALE"
                || code ===
                  "DECOMPOSITION_RETIREMENT_CONFLICT"
                || code ===
                  "DECOMPOSITION_PLAN_RETIRED"
                || code ===
                  "DECOMPOSITION_WORK_ITEM_REOPEN_REQUIRED"
                || code ===
                  "DECOMPOSITION_BASELINE_MISSING"
                || code ===
                  "DECOMPOSITION_WORK_ITEM_HISTORY_DRIFT"
                || code ===
                  "DECOMPOSITION_ATTEMPT_OUTSIDE_PLAN"
                || code ===
                  "DECOMPOSITION_OWNER_EXECUTION_DRIFT"
                || code ===
                  "DECOMPOSITION_RUNNER_PROFILE_DRIFT"
                || code ===
                  "DECOMPOSITION_ATTEMPT_NOT_COMPLETED"
              ? 409
              : code ===
                    "DECOMPOSITION_JOURNAL_WRITE_FAILED" ||
                  code ===
                    "DECOMPOSITION_CLOCK_INVALID" ||
                  code.includes(
                    "REOPEN"
                  ) ||
                  code.includes(
                    "COMMIT_OUTCOME_UNKNOWN"
                  ) ||
                  error.name ===
                    "DecompositionPlanStoreError"
                ? 503
                : 422;
    return {
      statusCode,
      code,
      message:
        statusCode === 503
          ? code.includes(
                "REOPEN"
              ) ||
              code.includes(
                "COMMIT_OUTCOME_UNKNOWN"
              )
            ? "TaskSeal decomposition control is unavailable and must be reopened."
            : "TaskSeal decomposition control is temporarily unavailable."
          : statusCode === 404
            ? "The TaskSeal decomposition plan does not exist."
            : statusCode === 403
              ? "TaskSeal decomposition capability is disabled."
              : statusCode === 429
                ? "TaskSeal decomposition execution capacity is full."
                : statusCode === 409
                  ? "TaskSeal decomposition request conflicts with current state."
                  : "TaskSeal rejected the decomposition request."
    };
  }

  if (
    isRecord(error) &&
    error.name === "TaskSealServiceError"
  ) {
    const code = readSafeErrorCode(
      error,
      "SERVICE_ERROR"
    );

    return {
      statusCode:
        code === "WORK_ITEM_NOT_FOUND"
          ? 404
          : code ===
                "ACCEPTANCE_REVIEW_STALE" ||
              code ===
                "ACCEPTANCE_DECISION_CONFLICT"
            ? 409
            : code ===
                  "SERVICE_REOPEN_REQUIRED" ||
                code ===
                  "ACCEPTANCE_COMMIT_INVALID"
              ? 503
              : 500,
      code,
      message:
        code === "WORK_ITEM_NOT_FOUND"
          ? "The TaskSeal work item does not exist."
          : code ===
                "ACCEPTANCE_REVIEW_STALE" ||
              code ===
                "ACCEPTANCE_DECISION_CONFLICT"
            ? "TaskSeal acceptance review is stale or conflicts with an existing decision."
            : code ===
                "SERVICE_REOPEN_REQUIRED"
          ? "TaskSeal service must be reopened before requests can continue."
          : "TaskSeal service request failed."
    };
  }

  if (error instanceof ConnectionProbeError) {
    return {
      statusCode:
        error.code === "CONNECTION_REVISION_CONFLICT" ? 409 : 404,
      code: error.code,
      message: error.message
    };
  }

  if (
    isRecord(error) &&
    (error.name === "ConfigurationControlError" ||
      error.name === "ConfigurationAuthorityError")
  ) {
    const code = readSafeErrorCode(error, "CONFIG_WRITE_FAILED");
    const statusCode =
      code === "CONFIG_REVISION_CONFLICT" ||
      code === "CONFIG_WRITE_LOCKED"
        ? 409
        : code === "CONFIG_SOURCE_UNAVAILABLE" ||
            code === "CONFIG_WRITE_FAILED" ||
            code === "CONTROL_ROOM_HANDOFF_UNAVAILABLE"
          ? 503
          : 422;
    return {
      statusCode,
      code,
      message:
        statusCode === 409
          ? "TaskSeal configuration changed concurrently."
          : statusCode === 503
            ? "TaskSeal configuration control is temporarily unavailable."
            : "TaskSeal rejected the configuration request."
    };
  }

  if (
    isRecord(error) &&
    (
      error.name ===
        "AcceptanceDeliveryCoordinatorError" ||
      error.name ===
        "WorkItemAcceptanceError"
    )
  ) {
    return {
      statusCode: 400,
      code: readSafeErrorCode(
        error,
        "INVALID_ACCEPTANCE_REQUEST"
      ),
      message:
        "TaskSeal acceptance request is invalid."
    };
  }

  if (
    isRecord(error) &&
    error.name ===
      "ProviderSyncProjectionError"
  ) {
    return {
      statusCode: 503,
      code:
        readProviderSyncProjectionErrorCode(
          error
        ),
      message:
        "TaskSeal provider status is unavailable and must be reopened."
    };
  }

  if (
    isRecord(error) &&
    error.name === "ProviderObservationError"
  ) {
    return {
      statusCode: 503,
      code: readSafeErrorCode(
        error,
        "PROVIDER_OBSERVATION_READ_FAILED"
      ),
      message:
        "TaskSeal provider observations are unavailable and must be reopened."
    };
  }

  if (isRecord(error) && error.name === "DomainError") {
    const code =
      readSafeErrorCode(
        error,
        "DOMAIN_ERROR"
      );
    return {
      statusCode:
        code ===
          "ACCEPTANCE_REVIEW_STALE" ||
        code ===
          "ACCEPTANCE_ALREADY_DECIDED"
          ? 409
          : 422,
      code,
      message:
        code ===
            "ACCEPTANCE_REVIEW_STALE" ||
          code ===
            "ACCEPTANCE_ALREADY_DECIDED"
          ? "TaskSeal acceptance review is stale."
          : "TaskSeal rejected the requested state transition."
    };
  }

  return {
    statusCode: 500,
    code: "INTERNAL_ERROR",
    message: "TaskSeal request failed."
  };
}

function readSafeErrorCode(
  error: unknown,
  fallback: string
): string {
  if (
    isRecord(error) &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
  ) {
    return error.code;
  }

  return fallback;
}

function readProviderSyncProjectionErrorCode(
  error: unknown
):
  | "PROVIDER_SYNC_PROJECTION_INVALID"
  | "PROVIDER_SYNC_PROJECTION_UNAVAILABLE" {
  if (
    isRecord(error) &&
    (error.code ===
      "PROVIDER_SYNC_PROJECTION_INVALID" ||
      error.code ===
        "PROVIDER_SYNC_PROJECTION_UNAVAILABLE")
  ) {
    return error.code;
  }
  return "PROVIDER_SYNC_PROJECTION_UNAVAILABLE";
}

class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(
    statusCode: number,
    code: string,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

async function writeStatic(
  response: ServerResponse,
  file: StaticFile
): Promise<void> {
  const content = await readFile(file.url);
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": file.contentType
  });
  response.end(content);
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown
): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const expected =
    [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every(
      (key, index) =>
        key === expected[index]
    )
  );
}
