import type {
  ImportActor
} from "./import-batch.ts";
import {
  deriveImportEventId
} from "./import-plan.ts";
import type {
  ImportPlan
} from "./import-plan.ts";
import {
  previewSnapshotImport
} from "./snapshot-import.ts";
import type {
  ImportReceiptContext,
  SnapshotImportApplyOptions,
  SnapshotImportApplyResult
} from "./taskseal-service.ts";
import {
  normalizeGitHubCheckFact,
  normalizeGitHubPullRequestFact,
  normalizeGitHubPullRequestReviewFact
} from "../connectors/github.ts";
import type {
  GitHubDeliveryBinding,
  GitHubDeliveryEvidenceBinding,
  GitHubDeliveryIndex
} from "../connectors/github-delivery-index.ts";
import type {
  GitHubHeadCheckMatch,
  GitHubHeadCheckSelector,
  GitHubPullRequest,
  GitHubPullRequestReview
} from "../connectors/github-read-client.ts";
import type {
  Workflow
} from "../domain/workflow.ts";
import type {
  ProviderFact,
  ProviderSnapshotMapping,
  ProviderSnapshotV2
} from "../lib/provider-snapshot.ts";
import {
  digestCanonicalJson
} from "../lib/canonical-json.ts";

const DIGEST_PATTERN =
  /^sha256:[0-9a-f]{64}$/;
const MAXIMUM_WORK_ITEM_ID_LENGTH = 256;
const WRITES = Object.freeze({
  github: 0 as const,
  linear: 0 as const
});
const DECISIVE_REVIEW_STATES =
  new Set([
    "APPROVED",
    "CHANGES_REQUESTED",
    "DISMISSED"
  ] as const);

interface ReadMappedPullRequestOptions {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly headRepository: string;
  readonly branch: string;
}

interface ReadHeadChecksOptions {
  readonly repository: string;
  readonly headSha: string;
  readonly selectors:
    readonly GitHubHeadCheckSelector[];
}

interface ReadReviewsOptions {
  readonly repository: string;
  readonly pullRequestNumber: number;
}

export interface GitHubDeliveryReadPort {
  readPullRequest(
    options: ReadMappedPullRequestOptions
  ): Promise<GitHubPullRequest>;
  readHeadChecks(
    options: ReadHeadChecksOptions
  ): Promise<
    readonly GitHubHeadCheckMatch[]
  >;
  readReviews(
    options: ReadReviewsOptions
  ): Promise<
    readonly GitHubPullRequestReview[]
  >;
}

export interface GitHubDeliveryWorkflowPort {
  getWorkflow(): Workflow;
}

export interface GitHubDeliveryImportPort {
  getImportReceiptContext(
    options: {
      readonly planDigest: string;
    }
  ): ImportReceiptContext | null;
  applySnapshotImport(
    options: SnapshotImportApplyOptions
  ): Promise<SnapshotImportApplyResult>;
}

export interface GitHubDeliveryEvidenceProjection {
  readonly criterionKey: string;
  readonly sourceKind:
    GitHubDeliveryEvidenceBinding["source"]["kind"];
  readonly state:
    | "observed"
    | "missing";
  readonly outcome?:
    | "passed"
    | "failed";
}

interface GitHubDeliveryReconciliationBase {
  readonly schemaVersion: 1;
  readonly provider: "github";
  readonly repository: string;
  readonly workItemId: string;
  readonly bindingDigest: string;
  readonly pullRequestNumber: number;
  readonly branch: string;
  readonly headRevision: string;
  readonly evidence:
    readonly GitHubDeliveryEvidenceProjection[];
  readonly missingEvidence:
    readonly string[];
  readonly writes: {
    readonly github: 0;
    readonly linear: 0;
  };
}

export interface GitHubDeliveryPlanPreview
  extends GitHubDeliveryReconciliationBase {
  readonly kind: "plan";
  readonly plan: ImportPlan;
}

export interface GitHubDeliveryUnchangedPreview
  extends GitHubDeliveryReconciliationBase {
  readonly kind: "unchanged";
}

export type GitHubDeliveryReconciliationPreview =
  | GitHubDeliveryPlanPreview
  | GitHubDeliveryUnchangedPreview;

export interface GitHubDeliveryApplyResult
  extends GitHubDeliveryReconciliationBase {
  readonly kind: "applied";
  readonly resolution:
    SnapshotImportApplyResult["resolution"];
  readonly receipt:
    SnapshotImportApplyResult["receipt"];
}

interface GitHubDeliveryReconciliationOptions {
  readonly repository: string;
  readonly index: GitHubDeliveryIndex;
  readonly reader: GitHubDeliveryReadPort;
  readonly workflow:
    GitHubDeliveryWorkflowPort;
  readonly imports:
    GitHubDeliveryImportPort;
  readonly importPolicy: unknown;
  readonly clock?: () => unknown;
}

interface PreviewOptions {
  readonly workItemId: string;
}

interface ApplyOptions
  extends PreviewOptions {
  readonly expectedPlanDigest: string;
  readonly actor: ImportActor;
}

interface GitHubDeliveryReceiptReplay {
  readonly receipt:
    SnapshotImportApplyResult["receipt"];
  readonly headRevision: string;
  readonly evidence:
    readonly GitHubDeliveryEvidenceProjection[];
}

interface CollectedEvidence {
  readonly facts: ProviderFact[];
  readonly bindings:
    NonNullable<
      ProviderSnapshotMapping["evidenceBindings"]
    >;
  readonly projection:
    GitHubDeliveryEvidenceProjection[];
}

export class GitHubDeliveryReconciliationCoordinator {
  readonly #repository: string;
  readonly #index:
    GitHubDeliveryIndex;
  readonly #reader:
    GitHubDeliveryReadPort;
  readonly #workflow:
    GitHubDeliveryWorkflowPort;
  readonly #imports:
    GitHubDeliveryImportPort;
  readonly #importPolicy: unknown;
  readonly #clock: () => unknown;

  constructor({
    repository,
    index,
    reader,
    workflow,
    imports,
    importPolicy,
    clock = () => new Date()
  }: GitHubDeliveryReconciliationOptions) {
    const normalizedRepository =
      normalizeRepository(repository);
    const indexRepository =
      normalizeRepository(
        index.target.repository
      );

    if (
      normalizedRepository !==
      indexRepository
    ) {
      throw deliveryError(
        "GITHUB_DELIVERY_TARGET_MISMATCH",
        "The GitHub delivery index target does not match the configured repository."
      );
    }

    this.#repository =
      normalizedRepository;
    this.#index = index;
    this.#reader = reader;
    this.#workflow = workflow;
    this.#imports = imports;
    this.#importPolicy =
      structuredClone(importPolicy);
    this.#clock = clock;
  }

  async preview(
    optionsValue: PreviewOptions
  ): Promise<GitHubDeliveryReconciliationPreview> {
    const workItemId =
      normalizeWorkItemId(
        optionsValue?.workItemId
      );
    const binding =
      this.readBinding(workItemId);
    const workflow =
      this.#workflow.getWorkflow();
    const {
      attemptId,
      requiredEvidence
    } = validateLocalBinding({
      workflow,
      binding
    });
    const pullRequest =
      await this.#reader.readPullRequest(
        createPullRequestReadOptions({
          repository:
            this.#repository,
          binding
        })
      );

    assertMappedPullRequest({
      pullRequest,
      binding
    });

    const pullRequestFact =
      normalizeGitHubPullRequestFact(
        pullRequest,
        {
          workItemId,
          attemptId,
          deliveryBindingDigest:
            binding.bindingDigest
        }
      );
    const artifactId =
      pullRequestFact.candidateEvent
        .payload.artifactId;

    assertArtifactOwnership({
      workflow,
      workItemId,
      artifactId
    });

    const checkBindings =
      binding.evidence.filter(
        isCheckBinding
      );
    const reviewBindings =
      binding.evidence.filter(
        isReviewBinding
      );
    const [
      checkMatches,
      reviews
    ] = await Promise.all([
      checkBindings.length === 0
        ? []
        : this.#reader.readHeadChecks({
            repository:
              this.#repository,
            headSha:
              pullRequest.head.sha,
            selectors:
              checkBindings.map(
                (entry) => ({
                  name:
                    entry.source.name,
                  ...(entry.source
                    .appId ===
                  undefined
                    ? {}
                    : {
                        appId:
                          entry.source
                            .appId
                      })
                })
              )
          }),
      reviewBindings.length === 0
        ? []
        : this.#reader.readReviews({
            repository:
              this.#repository,
            pullRequestNumber:
              binding.pullRequestNumber
          })
    ]);
    const collected =
      collectEvidence({
        binding,
        pullRequest,
        artifactId,
        attemptId,
        checkMatches,
        reviews
      });
    const finalPullRequest =
      await this.#reader.readPullRequest(
        createPullRequestReadOptions({
          repository:
            this.#repository,
          binding
        })
      );

    if (
      !samePullRequestFence(
        pullRequest,
        finalPullRequest
      )
    ) {
      throw deliveryError(
        "GITHUB_DELIVERY_REVISION_RACE",
        "The GitHub pull request changed while delivery evidence was being collected."
      );
    }

    const pendingFacts =
      filterRepresentedFacts({
        workflow,
        workItemId,
        attemptId,
        pullRequestFact,
        evidenceFacts:
          collected.facts,
        evidenceBindings:
          collected.bindings
      });
    const base =
      createResultBase({
        repository:
          this.#repository,
        binding,
        headRevision:
          pullRequest.head.sha,
        evidence:
          collected.projection
      });

    if (
      pendingFacts.facts.length === 0
    ) {
      return Object.freeze({
        ...base,
        kind: "unchanged"
      });
    }

    const snapshot:
      ProviderSnapshotV2 = {
        schemaVersion: 2,
        mode: "read-only",
        provider: "github",
        scope: {
          kind: "repository",
          key:
            `github:repository:${this.#repository}`
        },
        mapping: {
          workItemId,
          requiredEvidence:
            [...requiredEvidence],
          managedFields: [],
          attemptId,
          artifactId,
          artifactRevision:
            pullRequest.head.sha,
          deliveryBindingDigest:
            binding.bindingDigest,
          pullRequestNumber:
            binding.pullRequestNumber,
          evidenceBindings:
            pendingFacts
              .evidenceBindings
        },
        capturedAt:
          this.currentTimestamp(),
        facts: pendingFacts.facts
      };
    const plan = previewSnapshotImport({
      snapshot,
      workflow,
      importPolicy:
        this.#importPolicy
    });
    if (
      plan.events.length === 0 &&
      plan.conflicts.length === 0
    ) {
      return Object.freeze({
        ...base,
        kind: "unchanged"
      });
    }

    return Object.freeze({
      ...base,
      kind: "plan",
      plan
    });
  }

  async apply(
    optionsValue: ApplyOptions
  ): Promise<GitHubDeliveryApplyResult> {
    const expectedPlanDigest =
      normalizeDigest(
        optionsValue
          ?.expectedPlanDigest
      );
    const actor =
      normalizeActor(
        optionsValue?.actor
      );
    const receiptReplay =
      this.replayCommittedReceipt({
        workItemId:
          optionsValue?.workItemId,
        expectedPlanDigest
      });

    if (receiptReplay !== null) {
      return receiptReplay;
    }

    const preview =
      await this.preview({
        workItemId:
          optionsValue?.workItemId
      });

    if (
      preview.kind !== "plan" ||
      preview.plan.planDigest !==
        expectedPlanDigest
    ) {
      throw deliveryError(
        "GITHUB_DELIVERY_PLAN_STALE",
        "The GitHub delivery reconciliation plan changed after review."
      );
    }

    const result =
      await this.#imports
        .applySnapshotImport({
          plan: preview.plan,
          expectedPlanDigest,
          actor
        });

    return createApplyResult({
      preview,
      result
    });
  }

  replayCommittedReceipt({
    workItemId: workItemIdValue,
    expectedPlanDigest:
      expectedPlanDigestValue
  }: {
    readonly workItemId: string;
    readonly expectedPlanDigest: string;
  }): GitHubDeliveryApplyResult | null {
    const workItemId =
      normalizeWorkItemId(
        workItemIdValue
      );
    const expectedPlanDigest =
      normalizeDigest(
        expectedPlanDigestValue
      );
    const binding =
      this.readBinding(workItemId);
    const workflow =
      this.#workflow.getWorkflow();
    const {
      attemptId,
      requiredEvidence
    } = validateLocalBinding({
      workflow,
      binding
    });
    const replay =
      findReceiptRetry({
        expectedPlanDigest,
        repository:
          this.#repository,
        binding,
        workflow,
        attemptId,
        requiredEvidence,
        imports:
          this.#imports
      });

    if (replay === null) {
      return null;
    }

    const preview:
      GitHubDeliveryUnchangedPreview =
        Object.freeze({
          ...createResultBase({
            repository:
              this.#repository,
            binding,
            headRevision:
              replay.headRevision,
            evidence:
              replay.evidence
          }),
          kind: "unchanged"
        });

    return createApplyResult({
      preview,
      result: {
        resolution: "idempotent",
        receipt: replay.receipt
      }
    });
  }

  private readBinding(
    workItemId: string
  ): GitHubDeliveryBinding {
    const binding =
      this.#index.byWorkItem(
        workItemId
      );

    if (
      binding === null ||
      binding.workItemId !== workItemId
    ) {
      throw deliveryError(
        "GITHUB_DELIVERY_BINDING_NOT_FOUND",
        "No explicit GitHub delivery binding exists for the selected WorkItem."
      );
    }

    return binding;
  }

  private currentTimestamp(): string {
    const value = this.#clock();

    if (
      !(value instanceof Date) ||
      !Number.isFinite(
        value.getTime()
      )
    ) {
      throw deliveryError(
        "GITHUB_DELIVERY_CLOCK_INVALID",
        "GitHub delivery reconciliation clock returned an invalid timestamp."
      );
    }

    return value.toISOString();
  }
}

function findReceiptRetry({
  expectedPlanDigest,
  repository,
  binding: deliveryBinding,
  workflow,
  attemptId,
  requiredEvidence,
  imports
}: {
  readonly expectedPlanDigest: string;
  readonly repository: string;
  readonly binding:
    GitHubDeliveryBinding;
  readonly workflow: Workflow;
  readonly attemptId: string;
  readonly requiredEvidence:
    readonly string[];
  readonly imports:
    GitHubDeliveryImportPort;
}):
  GitHubDeliveryReceiptReplay | null {
  const context =
    imports.getImportReceiptContext({
      planDigest:
        expectedPlanDigest
    });

  if (context === null) {
    return null;
  }

  const policyBinding =
    context.policyBinding;
  const allowedObjectTypes =
    new Set([
      "pull_request",
      "check",
      "pull_request_review"
    ]);
  const eventIds =
    context.actions.flatMap(
      (action) =>
        action.eventIds
    );
  const workItem =
    workflow.workItems[
      deliveryBinding.workItemId
    ];
  const activeArtifact =
    workItem?.activeArtifact;
  const artifact =
    activeArtifact === null ||
    activeArtifact === undefined ||
    activeArtifact === undefined
      ? undefined
      : workItem?.artifacts.find(
          (candidate) =>
            candidate.id ===
              activeArtifact.artifactId &&
            candidate.revision ===
              activeArtifact.revision &&
            candidate.attemptId ===
              attemptId
        );

  if (
    context.receipt.planDigest !==
      expectedPlanDigest ||
    (
      policyBinding.schemaVersion !== 1 &&
      policyBinding.schemaVersion !== 3
    ) ||
    policyBinding.capability !==
      "snapshot.import.apply" ||
    policyBinding.applyAllowed !== true ||
    policyBinding.provider !== "github" ||
    policyBinding.scopeRef.kind !==
      "repository" ||
    policyBinding.scopeRef.key !==
      `github:repository:${repository}` ||
    policyBinding.scopeRef.parentKey !==
      undefined ||
    policyBinding.requiredObjectTypes.length ===
      0 ||
    policyBinding.requiredObjectTypes.some(
      (objectType) =>
        !allowedObjectTypes.has(
          objectType
        )
    ) ||
    context.actions.length === 0 ||
    context.actions.some(
      (action) =>
        action.workItemId !==
          deliveryBinding.workItemId ||
        (
          action.semanticTarget !==
            "artifact" &&
          action.semanticTarget !==
            "evidence"
        ) ||
        (
          action.kind !== "link" &&
          action.kind !== "update"
        ) ||
        action.eventIds.length !== 1 ||
        !/^github:(?:pull_request|check|pull_request_review):[1-9]\d*$/.test(
          action.sourceObjectKey
        )
    ) ||
    workItem === undefined ||
    artifact === undefined ||
    eventIds.length === 0 ||
    !sameStringSet(
      eventIds,
      context.receipt.eventIds
    ) ||
    eventIds.some(
      (eventId) =>
        workflow.processedEvents[
          eventId
        ] === undefined
      )
  ) {
    throw planStale();
  }

  const evidenceBindings:
    NonNullable<
      ProviderSnapshotMapping["evidenceBindings"]
    > = [];

  for (const action of context.actions) {
    const eventId =
      action.eventIds[0];
    const sourceIdentity =
      parseDeliverySourceIdentity(
        action.sourceObjectKey
      );

    if (
      eventId === undefined ||
      sourceIdentity === null ||
      deriveImportEventId({
        eventType:
          action.semanticTarget ===
          "artifact"
            ? "artifact.linked"
            : "evidence.recorded",
        workItemId:
          action.workItemId,
        providerObjectKey:
          action.sourceObjectKey,
        sourceRevisionId:
          action.sourceRevisionId,
        semanticTarget:
          action.semanticTarget
      }) !== eventId
    ) {
      throw planStale();
    }

    if (
      action.semanticTarget ===
      "artifact"
    ) {
      if (
        sourceIdentity.objectType !==
          "pull_request" ||
        artifact.id !==
          `pr-${sourceIdentity.externalId}` ||
        action.sourceRevisionId !==
          artifact.linkedAt
      ) {
        throw planStale();
      }

      continue;
    }

    const evidence =
      workItem.evidence.find(
        (candidate) => {
          if (
            candidate.attemptId !==
              attemptId ||
            candidate.artifactId !==
              artifact.id ||
            candidate.revision !==
              artifact.revision ||
            !evidenceMatchesSource({
              evidenceId:
                candidate.id,
              sourceIdentity,
              pullRequestNumber:
                deliveryBinding
                  .pullRequestNumber
            }) ||
            !deliveryBinding
              .evidence.some(
                (configured) =>
                  configured
                    .criterionKey ===
                    candidate
                      .criterionKey &&
                  configured.source
                    .kind ===
                    (
                      sourceIdentity
                        .objectType ===
                      "check"
                        ? "check_run"
                        : "pull_request_review"
                    )
              )
          ) {
            return false;
          }

          return true;
        }
      );
    const configuredEvidence =
      evidence === undefined
        ? undefined
        : deliveryBinding.evidence.find(
            (configured) =>
              configured.criterionKey ===
                evidence.criterionKey &&
              configured.source.kind ===
                (
                  sourceIdentity.objectType ===
                    "check"
                    ? "check_run"
                    : "pull_request_review"
                )
          );

    if (
      evidence === undefined ||
      configuredEvidence === undefined
    ) {
      throw planStale();
    }

    evidenceBindings.push({
      providerObjectKey:
        action.sourceObjectKey,
      criterionKey:
        evidence.criterionKey,
      source:
        cloneDeliveryEvidenceSource(
          configuredEvidence.source
        )
    });
  }

  evidenceBindings.sort(
    (left, right) =>
      compareStrings(
        left.providerObjectKey,
        right.providerObjectKey
      )
  );
  const expectedMappingDigest =
    digestCanonicalJson({
      workItemId:
        deliveryBinding.workItemId,
      requiredEvidence: [
        ...requiredEvidence
      ].sort(compareStrings),
      managedFields: [],
      attemptId,
      artifactId: artifact.id,
      artifactRevision:
        artifact.revision,
      deliveryBindingDigest:
        deliveryBinding.bindingDigest,
      pullRequestNumber:
        deliveryBinding
          .pullRequestNumber,
      evidenceBindings
    });

  if (
    context.receipt.mappingDigest !==
      expectedMappingDigest
  ) {
    throw planStale();
  }

  return {
    receipt:
      structuredClone(
        context.receipt
      ),
    headRevision:
      artifact.revision,
    evidence:
      projectLocalEvidence({
        workItem,
        binding:
          deliveryBinding,
        attemptId,
        artifactId:
          artifact.id,
        artifactRevision:
          artifact.revision
      })
  };
}

function parseDeliverySourceIdentity(
  providerObjectKey: string
): {
  objectType:
    | "pull_request"
    | "check"
    | "pull_request_review";
  externalId: string;
} | null {
  const match =
    /^github:(pull_request|check|pull_request_review):([1-9]\d*)$/.exec(
      providerObjectKey
    );

  if (match === null) {
    return null;
  }

  const objectType = match[1];
  const externalId = match[2];

  return (
    (
      objectType ===
        "pull_request" ||
      objectType === "check" ||
      objectType ===
        "pull_request_review"
    ) &&
    externalId !== undefined
  )
    ? {
        objectType,
        externalId
      }
    : null;
}

function evidenceMatchesSource({
  evidenceId,
  sourceIdentity,
  pullRequestNumber
}: {
  evidenceId: string;
  sourceIdentity: {
    objectType:
      | "pull_request"
      | "check"
      | "pull_request_review";
    externalId: string;
  };
  pullRequestNumber: number;
}): boolean {
  if (
    sourceIdentity.objectType ===
    "check"
  ) {
    const match =
      /^check-([1-9]\d*):pr-([1-9]\d*)$/.exec(
        evidenceId
      );
    return (
      match?.[1] ===
        sourceIdentity.externalId &&
      match[2] ===
        String(pullRequestNumber)
    );
  }

  if (
    sourceIdentity.objectType ===
    "pull_request_review"
  ) {
    const match =
      /^review-([1-9]\d*):reviewer-[1-9]\d*:(?:approved|changes_requested|dismissed)$/.exec(
        evidenceId
      );
    return (
      match?.[1] ===
      sourceIdentity.externalId
    );
  }

  return false;
}

function projectLocalEvidence({
  workItem,
  binding,
  attemptId,
  artifactId,
  artifactRevision
}: {
  workItem:
    Workflow["workItems"][string];
  binding: GitHubDeliveryBinding;
  attemptId: string;
  artifactId: string;
  artifactRevision: string;
}): GitHubDeliveryEvidenceProjection[] {
  return binding.evidence.map(
    (configured) => {
      const candidates =
        workItem.evidence
          .filter(
            (candidate) =>
              candidate.attemptId ===
                attemptId &&
              candidate.artifactId ===
                artifactId &&
              candidate.revision ===
                artifactRevision &&
              candidate.criterionKey ===
                configured
                  .criterionKey &&
              (
                configured.source
                  .kind ===
                "check_run"
                  ? /^check-[1-9]\d*:pr-[1-9]\d*$/.test(
                      candidate.id
                    )
                  : /^review-[1-9]\d*:reviewer-[1-9]\d*:(?:approved|changes_requested|dismissed)$/.test(
                      candidate.id
                    )
              )
          )
          .sort(
            (left, right) =>
              Date.parse(
                right.recordedAt
              ) -
                Date.parse(
                  left.recordedAt
                ) ||
              compareStrings(
                right.id,
                left.id
              )
          );
      const evidence =
        candidates[0];

      return evidence === undefined
        ? {
            criterionKey:
              configured
                .criterionKey,
            sourceKind:
              configured.source.kind,
            state: "missing" as const
          }
        : {
            criterionKey:
              configured
                .criterionKey,
            sourceKind:
              configured.source.kind,
            state: "observed" as const,
            outcome:
              evidence.outcome
          };
    }
  );
}

function createApplyResult({
  preview,
  result
}: {
  readonly preview:
    GitHubDeliveryReconciliationPreview;
  readonly result:
    SnapshotImportApplyResult;
}): GitHubDeliveryApplyResult {
  return Object.freeze({
    schemaVersion: 1,
    provider: "github",
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
    writes: WRITES,
    kind: "applied",
    resolution:
      result.resolution,
    receipt: result.receipt
  });
}

function filterRepresentedFacts({
  workflow,
  workItemId,
  attemptId,
  pullRequestFact,
  evidenceFacts,
  evidenceBindings
}: {
  readonly workflow: Workflow;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly pullRequestFact:
    ReturnType<
      typeof normalizeGitHubPullRequestFact
    >;
  readonly evidenceFacts:
    readonly ProviderFact[];
  readonly evidenceBindings:
    Readonly<
      NonNullable<
        ProviderSnapshotMapping["evidenceBindings"]
      >
    >;
}): {
  facts: ProviderFact[];
  evidenceBindings:
    NonNullable<
      ProviderSnapshotMapping["evidenceBindings"]
    >;
} {
  const workItem =
    workflow.workItems[workItemId];

  if (workItem === undefined) {
    throw deliveryError(
      "GITHUB_DELIVERY_WORK_ITEM_NOT_FOUND",
      "The mapped WorkItem does not exist."
    );
  }

  const artifact =
    pullRequestFact.candidateEvent
      .payload;
  const artifactRepresented =
    workItem.activeArtifact
      ?.artifactId ===
      artifact.artifactId &&
    workItem.activeArtifact
      .revision ===
      artifact.revision &&
    workItem.artifacts.some(
      (candidate) =>
        candidate.id ===
          artifact.artifactId &&
        candidate.attemptId ===
          attemptId &&
        candidate.revision ===
          artifact.revision &&
        candidate.kind ===
          artifact.kind &&
        candidate.url === artifact.url
    );
  const facts: ProviderFact[] =
    artifactRepresented
      ? []
      : [pullRequestFact];
  const pendingProviderObjects =
    new Set<string>();

  for (const fact of evidenceFacts) {
    const event =
      fact.candidateEvent;

    if (
      event.type !==
      "evidence.recorded"
    ) {
      throw deliveryError(
        "GITHUB_DELIVERY_EVIDENCE_INVALID",
        "GitHub delivery evidence fact is invalid."
      );
    }

    const payload = event.payload;
    const represented =
      workItem.evidence.some(
        (candidate) =>
          candidate.id ===
            payload.evidenceId &&
          candidate.attemptId ===
            attemptId &&
          candidate.artifactId ===
            payload.artifactId &&
          candidate.revision ===
            payload.revision &&
          candidate.criterionKey ===
            payload.criterionKey &&
          candidate.outcome ===
            payload.outcome &&
          candidate.url ===
            payload.url
      );

    if (!represented) {
      facts.push(fact);
      pendingProviderObjects.add(
        fact.sourceObject
          .providerObjectKey
      );
    }
  }

  return {
    facts,
    evidenceBindings:
      evidenceBindings.filter(
        (binding) =>
          pendingProviderObjects.has(
            binding.providerObjectKey
          )
      )
  };
}

function validateLocalBinding({
  workflow,
  binding
}: {
  readonly workflow: Workflow;
  readonly binding:
    GitHubDeliveryBinding;
}): {
  attemptId: string;
  requiredEvidence: string[];
} {
  const workItem =
    workflow.workItems[
      binding.workItemId
    ];

  if (workItem === undefined) {
    throw deliveryError(
      "GITHUB_DELIVERY_WORK_ITEM_NOT_FOUND",
      "The mapped WorkItem does not exist."
    );
  }

  const expectedProviderObjectKey =
    `linear:issue:${binding.linearIssueId}`;
  const owners = Object.values(
    workflow.workItems
  ).flatMap((candidate) =>
    candidate.externalLinks
      .filter(
        (link) =>
          link.providerObjectKey ===
          expectedProviderObjectKey
      )
      .map((link) => ({
        workItemId: candidate.id,
        link
      }))
  );
  const linearLinks =
    workItem.externalLinks.filter(
      (link) =>
        link.legacy !== true &&
        link.provider === "linear" &&
        link.objectType === "issue"
    );
  const owner = owners[0];

  if (
    owners.length !== 1 ||
    owner === undefined ||
    owner.workItemId !==
      binding.workItemId ||
    owner.link.legacy === true ||
    owner.link.provider !==
      "linear" ||
    owner.link.objectType !==
      "issue" ||
    owner.link.externalId !==
      binding.linearIssueId ||
    linearLinks.length !== 1 ||
    linearLinks[0]
      ?.providerObjectKey !==
      expectedProviderObjectKey
  ) {
    throw deliveryError(
      "GITHUB_DELIVERY_LINEAR_MAPPING_MISMATCH",
      "The explicit GitHub delivery binding does not match one owned Linear issue link."
    );
  }

  const requiredEvidence =
    [...workItem.requiredEvidence]
      .sort();
  const mappedEvidence =
    binding.evidence
      .map(
        (entry) =>
          entry.criterionKey
      )
      .sort();

  if (
    !sameStringArray(
      requiredEvidence,
      mappedEvidence
    )
  ) {
    throw deliveryError(
      "GITHUB_DELIVERY_EVIDENCE_MAPPING_MISMATCH",
      "The GitHub delivery binding must cover every required evidence criterion exactly once."
    );
  }

  const attemptId =
    workItem.activeAttemptId;
  const attempt =
    workItem.attempts.find(
      (candidate) =>
        candidate.id === attemptId
    );

  if (
    attemptId === null ||
    attempt === undefined ||
    (
      attempt.status !== "running" &&
      attempt.status !== "completed"
    )
  ) {
    throw deliveryError(
      "GITHUB_DELIVERY_ATTEMPT_INVALID",
      "GitHub delivery evidence requires one active running or completed Attempt."
    );
  }

  return {
    attemptId,
    requiredEvidence
  };
}

function collectEvidence({
  binding,
  pullRequest,
  artifactId,
  attemptId,
  checkMatches,
  reviews
}: {
  readonly binding:
    GitHubDeliveryBinding;
  readonly pullRequest:
    GitHubPullRequest;
  readonly artifactId: string;
  readonly attemptId: string;
  readonly checkMatches:
    readonly GitHubHeadCheckMatch[];
  readonly reviews:
    readonly GitHubPullRequestReview[];
}): CollectedEvidence {
  const checkBySelector =
    indexCheckMatches(checkMatches);
  const facts: ProviderFact[] = [];
  const bindings:
    CollectedEvidence["bindings"] = [];
  const projection:
    GitHubDeliveryEvidenceProjection[] =
      [];
  const providerObjects =
    new Set<string>();

  for (
    const entry of
      [...binding.evidence].sort(
        (left, right) =>
          compareStrings(
            left.criterionKey,
            right.criterionKey
          )
      )
  ) {
    if (
      entry.source.kind ===
      "check_run"
    ) {
      const check =
        checkBySelector.get(
          checkSelectorKey(
            entry.source
          )
        )?.check ?? null;

      if (
        check === null ||
        check.status !== "completed" ||
        check.conclusion === null ||
        check.completed_at === null
      ) {
        projection.push({
          criterionKey:
            entry.criterionKey,
          sourceKind: "check_run",
          state: "missing"
        });
        continue;
      }

      const fact =
        normalizeGitHubCheckFact(
          check,
          {
            workItemId:
              binding.workItemId,
            attemptId,
            artifactId,
            criterionKey:
              entry.criterionKey,
            deliveryBindingDigest:
              binding.bindingDigest,
            pullRequestNumber:
              binding.pullRequestNumber,
            pullRequestRevisionId:
              pullRequest.updated_at,
            checkName:
              entry.source.name,
            ...(entry.source.appId ===
            undefined
              ? {}
              : {
                  checkAppId:
                    entry.source.appId
                })
          }
        );
      addEvidenceFact({
        fact,
        criterionKey:
          entry.criterionKey,
        source: entry.source,
        facts,
        bindings,
        providerObjects
      });
      projection.push({
        criterionKey:
          entry.criterionKey,
        sourceKind: "check_run",
        state: "observed",
        outcome:
          fact.observed.outcome
      });
      continue;
    }

    const review =
      selectReview({
        reviews,
        reviewerId:
          entry.source.reviewerId,
        headRevision:
          pullRequest.head.sha
      });

    if (review === null) {
      projection.push({
        criterionKey:
          entry.criterionKey,
        sourceKind:
          "pull_request_review",
        state: "missing"
      });
      continue;
    }

    const fact =
      normalizeGitHubPullRequestReviewFact(
        review,
        pullRequest,
        {
          workItemId:
            binding.workItemId,
          attemptId,
          artifactId,
          criterionKey:
            entry.criterionKey,
          reviewerId:
            entry.source.reviewerId,
          deliveryBindingDigest:
            binding.bindingDigest,
          pullRequestNumber:
            binding.pullRequestNumber
        }
      );
    addEvidenceFact({
      fact,
      criterionKey:
        entry.criterionKey,
      source: entry.source,
      facts,
      bindings,
      providerObjects
    });
    projection.push({
      criterionKey:
        entry.criterionKey,
      sourceKind:
        "pull_request_review",
      state: "observed",
      outcome:
        fact.observed.outcome
    });
  }

  return {
    facts,
    bindings,
    projection
  };
}

function addEvidenceFact({
  fact,
  criterionKey,
  source,
  facts,
  bindings,
  providerObjects
}: {
  readonly fact: ProviderFact;
  readonly criterionKey: string;
  readonly source:
    GitHubDeliveryEvidenceBinding["source"];
  readonly facts: ProviderFact[];
  readonly bindings:
    CollectedEvidence["bindings"];
  readonly providerObjects:
    Set<string>;
}): void {
  const providerObjectKey =
    fact.sourceObject
      .providerObjectKey;

  if (
    providerObjects.has(
      providerObjectKey
    )
  ) {
    throw deliveryError(
      "GITHUB_DELIVERY_EVIDENCE_AMBIGUOUS",
      "One GitHub evidence object matched multiple configured criteria."
    );
  }

  providerObjects.add(providerObjectKey);
  facts.push(fact);
  bindings.push({
    providerObjectKey,
    criterionKey,
    source:
      cloneDeliveryEvidenceSource(source)
  });
}

function cloneDeliveryEvidenceSource(
  source:
    GitHubDeliveryEvidenceBinding["source"]
): NonNullable<
  ProviderSnapshotMapping["evidenceBindings"]
>[number]["source"] {
  if (source.kind === "check_run") {
    return {
      kind: "check_run",
      name: source.name,
      ...(source.appId === undefined
        ? {}
        : { appId: source.appId })
    };
  }

  return {
    kind: "pull_request_review",
    reviewerId: source.reviewerId
  };
}

function indexCheckMatches(
  matches:
    readonly GitHubHeadCheckMatch[]
): Map<
  string,
  GitHubHeadCheckMatch
> {
  const indexed = new Map<
    string,
    GitHubHeadCheckMatch
  >();

  for (const match of matches) {
    const key =
      checkSelectorKey(
        match.selector
      );

    if (indexed.has(key)) {
      throw deliveryError(
        "GITHUB_DELIVERY_CHECK_SET_INVALID",
        "GitHub returned duplicate configured check selectors."
      );
    }

    indexed.set(key, match);
  }

  return indexed;
}

function selectReview({
  reviews,
  reviewerId,
  headRevision
}: {
  readonly reviews:
    readonly GitHubPullRequestReview[];
  readonly reviewerId: string;
  readonly headRevision: string;
}): GitHubPullRequestReview | null {
  const candidates =
    reviews.filter((review) => {
      if (
        String(review.user.id) !==
          reviewerId ||
        review.commit_id !==
          headRevision ||
        review.submitted_at === null ||
        !DECISIVE_REVIEW_STATES.has(
          review.state as
            | "APPROVED"
            | "CHANGES_REQUESTED"
            | "DISMISSED"
        )
      ) {
        return false;
      }

      if (
        !Number.isFinite(
          Date.parse(
            review.submitted_at
          )
        ) ||
        !/^[1-9]\d*$/.test(
          String(review.id)
        )
      ) {
        throw deliveryError(
          "GITHUB_DELIVERY_REVIEW_INVALID",
          "GitHub returned invalid decisive review evidence."
        );
      }

      return true;
    });

  candidates.sort(
    compareReviewsNewestFirst
  );
  return candidates[0] ?? null;
}

function compareReviewsNewestFirst(
  left: GitHubPullRequestReview,
  right: GitHubPullRequestReview
): number {
  const timeDifference =
    Date.parse(right.submitted_at!) -
    Date.parse(left.submitted_at!);

  if (timeDifference !== 0) {
    return timeDifference;
  }

  return compareDecimalIds(
    String(right.id),
    String(left.id)
  );
}

function compareDecimalIds(
  left: string,
  right: string
): number {
  return (
    left.length - right.length ||
    compareStrings(left, right)
  );
}

function compareStrings(
  left: string,
  right: string
): number {
  return left < right
    ? -1
    : left > right
      ? 1
      : 0;
}

function assertMappedPullRequest({
  pullRequest,
  binding
}: {
  readonly pullRequest:
    GitHubPullRequest;
  readonly binding:
    GitHubDeliveryBinding;
}): void {
  const headRepository =
    pullRequest.head.repo
      ?.full_name;
  let normalizedHeadRepository:
    string | null = null;

  try {
    normalizedHeadRepository =
      typeof headRepository === "string"
        ? normalizeRepository(
            headRepository
          )
        : null;
  } catch {
    normalizedHeadRepository = null;
  }

  if (
    String(pullRequest.number) !==
      String(
        binding.pullRequestNumber
      ) ||
    pullRequest.head.ref !==
      binding.branch ||
    normalizedHeadRepository !==
      normalizeRepository(
        binding.headRepository
      ) ||
    typeof pullRequest.head.sha !==
      "string" ||
    pullRequest.head.sha.length === 0
  ) {
    throw deliveryError(
      "GITHUB_DELIVERY_PULL_REQUEST_MISMATCH",
      "The GitHub pull request does not match the explicit delivery binding."
    );
  }
}

function samePullRequestFence(
  left: GitHubPullRequest,
  right: GitHubPullRequest
): boolean {
  return (
    String(left.id) ===
      String(right.id) &&
    String(left.number) ===
      String(right.number) &&
    left.html_url ===
      right.html_url &&
    left.updated_at ===
      right.updated_at &&
    left.head.sha ===
      right.head.sha &&
    left.head.ref ===
      right.head.ref &&
    normalizeOptionalRepository(
      left.head.repo?.full_name
    ) ===
      normalizeOptionalRepository(
        right.head.repo?.full_name
      )
  );
}

function assertArtifactOwnership({
  workflow,
  workItemId,
  artifactId
}: {
  readonly workflow: Workflow;
  readonly workItemId: string;
  readonly artifactId: string;
}): void {
  const foreignOwner =
    Object.values(
      workflow.workItems
    ).find(
      (workItem) =>
        workItem.id !== workItemId &&
        workItem.artifacts.some(
          (artifact) =>
            artifact.id ===
            artifactId
        )
    );

  if (foreignOwner !== undefined) {
    throw deliveryError(
      "GITHUB_DELIVERY_ARTIFACT_OWNERSHIP_CONFLICT",
      "The mapped GitHub pull request artifact is already owned by another WorkItem."
    );
  }
}

function createPullRequestReadOptions({
  repository,
  binding
}: {
  readonly repository: string;
  readonly binding:
    GitHubDeliveryBinding;
}): ReadMappedPullRequestOptions {
  return {
    repository,
    pullRequestNumber:
      binding.pullRequestNumber,
    headRepository:
      binding.headRepository,
    branch: binding.branch
  };
}

function createResultBase({
  repository,
  binding,
  headRevision,
  evidence
}: {
  readonly repository: string;
  readonly binding:
    GitHubDeliveryBinding;
  readonly headRevision: string;
  readonly evidence:
    readonly GitHubDeliveryEvidenceProjection[];
}): GitHubDeliveryReconciliationBase {
  return {
    schemaVersion: 1,
    provider: "github",
    repository,
    workItemId:
      binding.workItemId,
    bindingDigest:
      binding.bindingDigest,
    pullRequestNumber:
      binding.pullRequestNumber,
    branch: binding.branch,
    headRevision,
    evidence:
      evidence.map((entry) => ({
        ...entry
      })),
    missingEvidence:
      evidence
        .filter(
          (entry) =>
            entry.state ===
            "missing"
        )
        .map(
          (entry) =>
            entry.criterionKey
        ),
    writes: WRITES
  };
}

function checkSelectorKey(
  selector:
    GitHubHeadCheckSelector
): string {
  return [
    selector.name,
    selector.appId ?? ""
  ].join("\u0000");
}

function isCheckBinding(
  binding:
    GitHubDeliveryEvidenceBinding
): binding is Extract<
  GitHubDeliveryEvidenceBinding,
  {
    source: {
      kind: "check_run";
    };
  }
> {
  return binding.source.kind ===
    "check_run";
}

function isReviewBinding(
  binding:
    GitHubDeliveryEvidenceBinding
): binding is Extract<
  GitHubDeliveryEvidenceBinding,
  {
    source: {
      kind:
        "pull_request_review";
    };
  }
> {
  return (
    binding.source.kind ===
    "pull_request_review"
  );
}

function normalizeRepository(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length === 0
  ) {
    throw deliveryError(
      "GITHUB_DELIVERY_REPOSITORY_INVALID",
      "GitHub delivery repository is invalid."
    );
  }

  const parts = value.split("/");
  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        part.length === 0 ||
        !/^[A-Za-z0-9_.-]+$/.test(
          part
        )
    )
  ) {
    throw deliveryError(
      "GITHUB_DELIVERY_REPOSITORY_INVALID",
      "GitHub delivery repository is invalid."
    );
  }

  return value.toLowerCase();
}

function normalizeOptionalRepository(
  value: unknown
): string | null {
  try {
    return normalizeRepository(value);
  } catch {
    return null;
  }
}

function normalizeWorkItemId(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length >
      MAXIMUM_WORK_ITEM_ID_LENGTH ||
    value !== value.trim() ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw deliveryError(
      "GITHUB_DELIVERY_WORK_ITEM_INVALID",
      "GitHub delivery WorkItem ID is invalid."
    );
  }

  return value;
}

function normalizeDigest(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    !DIGEST_PATTERN.test(value)
  ) {
    throw deliveryError(
      "GITHUB_DELIVERY_PLAN_DIGEST_INVALID",
      "GitHub delivery expected plan digest is invalid."
    );
  }

  return value;
}

function normalizeActor(
  value: unknown
): ImportActor {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw deliveryError(
      "GITHUB_DELIVERY_ACTOR_INVALID",
      "GitHub delivery apply actor is invalid."
    );
  }

  const actor =
    value as Partial<ImportActor>;
  if (
    actor.type !== "human" &&
    actor.type !== "agent"
  ) {
    throw deliveryError(
      "GITHUB_DELIVERY_ACTOR_INVALID",
      "GitHub delivery apply actor is invalid."
    );
  }

  if (
    typeof actor.id !== "string" ||
    actor.id.length === 0 ||
    actor.id !== actor.id.trim()
  ) {
    throw deliveryError(
      "GITHUB_DELIVERY_ACTOR_INVALID",
      "GitHub delivery apply actor is invalid."
    );
  }

  return {
    type: actor.type,
    id: actor.id
  };
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) =>
        value === right[index]
    )
  );
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return sameStringArray(
    [...left].sort(),
    [...right].sort()
  );
}

function planStale():
  GitHubDeliveryReconciliationError {
  return deliveryError(
    "GITHUB_DELIVERY_PLAN_STALE",
    "The GitHub delivery reconciliation plan changed after review."
  );
}

export class GitHubDeliveryReconciliationError
  extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string
  ) {
    super(message);
    this.name =
      "GitHubDeliveryReconciliationError";
    this.code = code;
  }
}

function deliveryError(
  code: string,
  message: string
): GitHubDeliveryReconciliationError {
  return new GitHubDeliveryReconciliationError(
    code,
    message
  );
}
