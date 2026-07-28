import { join } from "node:path";

import {
  findLinearReadyWorkReceiptRetry,
  LinearReadyWorkCoordinator,
  listLinearReadyWorkCandidates
} from "./application/linear-ready-work.ts";
import {
  TaskSealService
} from "./application/taskseal-service.ts";
import {
  getLinearReadyWorkCoordinates,
  readProjectConfiguration
} from "./config/project-config.ts";
import {
  resolveLinearReadyWorkScope
} from "./connectors/linear-bootstrap-scope.ts";
import type {
  LinearBootstrapGraphqlRequest
} from "./connectors/linear-bootstrap-scope.ts";
import {
  readLinearDependencyIndex
} from "./connectors/linear-dependency-index.ts";
import {
  createLinearGraphqlHttpExchange
} from "./connectors/linear-graphql-http-exchange.ts";
import {
  listLinearReadyWorkIssues,
  readLinearReadyWorkIssueStates
} from "./connectors/linear-ready-work-reader.ts";
import type {
  LinearReadyWorkGraphqlRequest
} from "./connectors/linear-ready-work-reader.ts";
import {
  createReadOnlyProviderFactProvenanceVerifier
} from "./connectors/provider-fact-provenance-verifier.ts";
import { FileEventJournal } from "./storage/event-journal.ts";

export type LinearReadyWorkCommandOptions =
  | {
      readonly cwd: string;
      readonly mode: "list";
    }
  | {
      readonly cwd: string;
      readonly mode: "preview";
      readonly issueId: string;
      readonly workItemId: string;
      readonly requiredEvidence:
        readonly string[];
    }
  | {
      readonly cwd: string;
      readonly mode: "apply";
      readonly issueId: string;
      readonly workItemId: string;
      readonly requiredEvidence:
        readonly string[];
      readonly expectedPlanDigest: string;
    };

interface ExecuteLocalLinearReadyWorkOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly clock?: () => unknown;
}

export async function executeLocalLinearReadyWork(
  command: LinearReadyWorkCommandOptions,
  {
    environment = process.env,
    fetchImpl = globalThis.fetch,
    clock = () => new Date()
  }: ExecuteLocalLinearReadyWorkOptions = {}
): Promise<unknown> {
  if (command.mode === "apply") {
    const replayService =
      await TaskSealService.open({
        journal: createWorkflowJournal(
          command.cwd
        )
      });
    const retry =
      findLinearReadyWorkReceiptRetry({
        selection: {
          issueId: command.issueId,
          workItemId: command.workItemId,
          requiredEvidence:
            command.requiredEvidence,
          expectedPlanDigest:
            command.expectedPlanDigest,
          actor: {
            type: "human",
            id: "local-operator"
          }
        },
        workflow: replayService,
        imports: replayService
      });

    if (retry !== null) {
      return projectApplyResult(retry);
    }
  }

  const configuration =
    await readProjectConfiguration({
      cwd: command.cwd
    });
  const coordinates =
    getLinearReadyWorkCoordinates(
      configuration
    );

  if (!coordinates.enabled) {
    throw runtimeError(
      "LINEAR_READY_DISABLED",
      "Linear ready-work intake is disabled."
    );
  }

  const credentialOptions = {
    apiKey: environment.LINEAR_API_KEY,
    accessToken:
      environment.LINEAR_ACCESS_TOKEN,
    fetchImpl
  };
  const exchange =
    createLinearGraphqlHttpExchange(
      credentialOptions
    );
  const scope =
    await resolveLinearReadyWorkScope({
      configuredTarget: {
        workspace: coordinates.workspace,
        team: coordinates.team,
        project: coordinates.project,
        readyState: coordinates.readyState,
        completedState:
          coordinates.completedState
      },
      exchange: (
        request: LinearBootstrapGraphqlRequest
      ) =>
        exchange(request)
    });
  const dependencyIndex =
    await readLinearDependencyIndex({
      workspaceRoot: command.cwd,
      repositoryPath:
        coordinates.dependencyIndex
    });
  const reader = {
    listIssues: () =>
      listLinearReadyWorkIssues({
        scope,
        exchange: (
          request:
            LinearReadyWorkGraphqlRequest
        ) =>
          exchange(request)
      }),
    readIssueStates: (
      issueIds: readonly string[]
    ) =>
      readLinearReadyWorkIssueStates({
        scope,
        issueIds,
        exchange: (
          request:
            LinearReadyWorkGraphqlRequest
        ) =>
          exchange(request)
      })
  };

  if (command.mode === "list") {
    return {
      schemaVersion: 1,
      mode: "list",
      provider: "linear",
      mutationReady: false,
      candidates: (
        await listLinearReadyWorkCandidates({
          scope,
          reader,
          dependencyIndex
        })
      ).map(projectCandidate)
    };
  }

  const importPolicy =
    createLinearReadyWorkImportPolicy(scope);
  const journal =
    createWorkflowJournal(command.cwd);
  const service = await TaskSealService.open({
    journal,
    importPolicyProvider: async () =>
      structuredClone(importPolicy),
    providerFactProvenanceVerifier:
      createReadOnlyProviderFactProvenanceVerifier({
        linear: credentialOptions
      }),
    clock
  });
  const coordinator =
    new LinearReadyWorkCoordinator({
      scope,
      reader,
      dependencyIndex,
      workflow: service,
      imports: service,
      importPolicy,
      clock
    });

  if (command.mode === "preview") {
    const preview =
      await coordinator.previewSelection({
        issueId: command.issueId,
        workItemId: command.workItemId,
        requiredEvidence:
          command.requiredEvidence
      });

    return {
      schemaVersion: 1,
      mode: "preview",
      provider: "linear",
      mutationReady: false,
      candidate: projectCandidate(
        preview.candidate
      ),
      ...(preview.kind === "plan"
        ? {
            resolution: "plan",
            plan: preview.plan
          }
        : {
            resolution: "already_linked",
            workItemId:
              preview.workItemId
          })
    };
  }

  const result =
    await coordinator.applySelection({
      issueId: command.issueId,
      workItemId: command.workItemId,
      requiredEvidence:
        command.requiredEvidence,
      expectedPlanDigest:
        command.expectedPlanDigest,
      actor: {
        type: "human",
        id: "local-operator"
      }
    });

  return projectApplyResult(result);
}

function createWorkflowJournal(
  cwd: string
): FileEventJournal {
  return new FileEventJournal({
    filePath: join(
      cwd,
      ".taskseal",
      "events.jsonl"
    )
  });
}

function projectApplyResult(
  result:
    Awaited<
      ReturnType<
        LinearReadyWorkCoordinator["applySelection"]
      >
    >
): unknown {
  return {
    schemaVersion: 1,
    mode: "apply",
    provider: "linear",
    linearWrites: 0,
    workItemId: result.workItemId,
    resolution: result.resolution,
    receipt: result.receipt,
    ...(result.kind === "applied"
      ? {
          candidate: projectCandidate(
            result.candidate
          )
        }
      : {
          issueId: result.issueId,
          receiptReplay: true
        })
  };
}

function createLinearReadyWorkImportPolicy(
  scope: {
    readonly organizationId: string;
    readonly teamId: string;
  }
): unknown {
  return {
    schemaVersion: 2,
    allowedScopes: [
      {
        provider: "linear",
        scopeRef: {
          kind: "team",
          key:
            `linear:team:${scope.teamId}`,
          parentKey:
            `linear:organization:${scope.organizationId}`
        },
        objectTypes: ["issue"],
        capabilities: {
          "snapshot.import.preview": true,
          "snapshot.import.apply": true
        }
      }
    ]
  };
}

function projectCandidate(candidate: {
  readonly issueId: string;
  readonly identifier: string;
  readonly title: string;
  readonly url: string;
  readonly readiness: string;
  readonly dependencyIssueIds:
    readonly string[];
  readonly blockingIssueIds:
    readonly string[];
}): unknown {
  return {
    issueId: candidate.issueId,
    identifier: candidate.identifier,
    title: candidate.title,
    url: candidate.url,
    readiness: candidate.readiness,
    dependencyIssueIds: [
      ...candidate.dependencyIssueIds
    ],
    blockingIssueIds: [
      ...candidate.blockingIssueIds
    ]
  };
}

class LinearReadyWorkRuntimeError
  extends Error
{
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name =
      "LinearReadyWorkRuntimeError";
    this.code = code;
  }
}

function runtimeError(
  code: string,
  message: string
): LinearReadyWorkRuntimeError {
  return new LinearReadyWorkRuntimeError(
    code,
    message
  );
}
