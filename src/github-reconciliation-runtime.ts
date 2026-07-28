import { join } from "node:path";

import {
  GitHubDeliveryReconciliationCoordinator
} from "./application/github-delivery-reconciliation.ts";
import type {
  GitHubDeliveryReconciliationPreview
} from "./application/github-delivery-reconciliation.ts";
import {
  TaskSealService
} from "./application/taskseal-service.ts";
import {
  getGitHubDeliveryCoordinates,
  readProjectConfiguration
} from "./config/project-config.ts";
import {
  readGitHubDeliveryIndex
} from "./connectors/github-delivery-index.ts";
import {
  readGitHubHeadChecks,
  readGitHubMappedPullRequest,
  readGitHubPullRequestReviews
} from "./connectors/github-read-client.ts";
import type {
  FetchLike
} from "./connectors/github-read-client.ts";
import {
  createReadOnlyProviderFactProvenanceVerifier
} from "./connectors/provider-fact-provenance-verifier.ts";
import {
  FileEventJournal
} from "./storage/event-journal.ts";

export type GitHubReconciliationCommandOptions =
  | {
      readonly cwd: string;
      readonly mode: "preview";
      readonly workItemId: string;
    }
  | {
      readonly cwd: string;
      readonly mode: "apply";
      readonly workItemId: string;
      readonly expectedPlanDigest: string;
    };

interface ExecuteLocalGitHubReconciliationOptions {
  readonly environment?:
    NodeJS.ProcessEnv;
  readonly fetchImpl?: FetchLike;
  readonly clock?: () => unknown;
}

export async function executeLocalGitHubReconciliation(
  command:
    GitHubReconciliationCommandOptions,
  {
    environment = process.env,
    fetchImpl = globalThis.fetch,
    clock = () => new Date()
  }: ExecuteLocalGitHubReconciliationOptions = {}
): Promise<unknown> {
  const configuration =
    await readProjectConfiguration({
      cwd: command.cwd
    });
  const coordinates =
    getGitHubDeliveryCoordinates(
      configuration
    );

  if (
    !coordinates.enabled &&
    command.mode === "preview"
  ) {
    throw runtimeError(
      "GITHUB_RECONCILE_DISABLED",
      "GitHub delivery reconciliation is disabled."
    );
  }

  const index =
    await readGitHubDeliveryIndex({
      workspaceRoot: command.cwd,
      repositoryPath:
        coordinates.mappingIndex
    });
  const repository =
    normalizeRepository(
      coordinates.repository
    );

  if (
    normalizeRepository(
      index.target.repository
    ) !== repository
  ) {
    throw runtimeError(
      "GITHUB_RECONCILE_TARGET_MISMATCH",
      "GitHub delivery index target does not match project configuration."
    );
  }

  if (
    index.byWorkItem(
      command.workItemId
    ) === null
  ) {
    throw runtimeError(
      "GITHUB_DELIVERY_BINDING_NOT_FOUND",
      "No explicit GitHub delivery binding exists for the selected WorkItem."
    );
  }

  const token =
    environment.GITHUB_TOKEN ??
    environment.GH_TOKEN;
  const readOptions = {
    token,
    fetchImpl
  };
  const importPolicy =
    createGitHubDeliveryImportPolicy(
      repository
    );
  const service =
    await TaskSealService.open({
      journal:
        createWorkflowJournal(
          command.cwd
        ),
      importPolicyProvider:
        async () =>
          structuredClone(
            importPolicy
          ),
      providerFactProvenanceVerifier:
        createReadOnlyProviderFactProvenanceVerifier({
          github: readOptions
        }),
      clock
    });
  const coordinator =
    new GitHubDeliveryReconciliationCoordinator({
      repository,
      index,
      reader: {
        readPullRequest: (options) =>
          readGitHubMappedPullRequest({
            ...options,
            ...readOptions
          }),
        readHeadChecks: (options) =>
          readGitHubHeadChecks({
            ...options,
            ...readOptions
          }),
        readReviews: (options) =>
          readGitHubPullRequestReviews({
            ...options,
            ...readOptions
          })
      },
      workflow: service,
      imports: service,
      importPolicy,
      clock
    });

  if (command.mode === "apply") {
    const receiptReplay =
      coordinator
        .replayCommittedReceipt({
          workItemId:
            command.workItemId,
          expectedPlanDigest:
            command
              .expectedPlanDigest
        });

    if (receiptReplay !== null) {
      return projectApplyResult(
        receiptReplay
      );
    }

    if (!coordinates.enabled) {
      throw runtimeError(
        "GITHUB_RECONCILE_DISABLED",
        "GitHub delivery reconciliation is disabled."
      );
    }
  }

  if (command.mode === "preview") {
    return projectPreview(
      await coordinator.preview({
        workItemId:
          command.workItemId
      })
    );
  }

  const result =
    await coordinator.apply({
      workItemId:
        command.workItemId,
      expectedPlanDigest:
        command.expectedPlanDigest,
      actor: {
        type: "human",
        id: "local-operator"
      }
    });

  return projectApplyResult(result);
}

function projectApplyResult(
  result: Awaited<
    ReturnType<
      GitHubDeliveryReconciliationCoordinator["apply"]
    >
  >
): unknown {
  return {
    schemaVersion: 1,
    mode: "apply",
    provider: "github",
    githubWrites: 0,
    linearWrites: 0,
    repository:
      result.repository,
    workItemId:
      result.workItemId,
    bindingDigest:
      result.bindingDigest,
    pullRequestNumber:
      result.pullRequestNumber,
    branch: result.branch,
    headRevision:
      result.headRevision,
    evidence:
      result.evidence,
    missingEvidence:
      result.missingEvidence,
    resolution:
      result.resolution,
    receipt: result.receipt
  };
}

function projectPreview(
  preview:
    GitHubDeliveryReconciliationPreview
): unknown {
  return {
    schemaVersion: 1,
    mode: "preview",
    provider: "github",
    githubWrites: 0,
    linearWrites: 0,
    repository:
      preview.repository,
    workItemId:
      preview.workItemId,
    bindingDigest:
      preview.bindingDigest,
    pullRequestNumber:
      preview.pullRequestNumber,
    branch: preview.branch,
    headRevision:
      preview.headRevision,
    evidence:
      preview.evidence,
    missingEvidence:
      preview.missingEvidence,
    ...(preview.kind === "plan"
      ? {
          resolution: "plan",
          plan: preview.plan
        }
      : {
          resolution: "up_to_date"
        })
  };
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

function createGitHubDeliveryImportPolicy(
  repository: string
): unknown {
  return {
    schemaVersion: 2,
    allowedScopes: [
      {
        provider: "github",
        scopeRef: {
          kind: "repository",
          key:
            `github:repository:${repository}`
        },
        objectTypes: [
          "pull_request",
          "check",
          "pull_request_review"
        ],
        capabilities: {
          "snapshot.import.preview": true,
          "snapshot.import.apply": true
        }
      }
    ]
  };
}

function normalizeRepository(
  value: string
): string {
  return value.toLowerCase();
}

class GitHubReconciliationRuntimeError
  extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string
  ) {
    super(message);
    this.name =
      "GitHubReconciliationRuntimeError";
    this.code = code;
  }
}

function runtimeError(
  code: string,
  message: string
): GitHubReconciliationRuntimeError {
  return new GitHubReconciliationRuntimeError(
    code,
    message
  );
}
