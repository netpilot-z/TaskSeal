import type {
  DashboardProjection,
  DashboardWorkItem
} from "./projection.ts";
import type { AttemptRunView } from "../application/attempt-run-coordinator.ts";

export type HomeFreshness = "fresh" | "stale" | "unavailable";
export type HomeMode = "persistent" | "demo";

export interface HomeProjectionInput {
  readonly dashboard: DashboardProjection;
  readonly now?: string | Date | undefined;
  readonly mode?: HomeMode | undefined;
  readonly project?:
    | {
        readonly key: string;
        readonly name: string;
      }
    | undefined;
  readonly freshness?: HomeFreshness | undefined;
  readonly runtime?:
    | {
        readonly maxConcurrentRuns: number;
        readonly activeCount: number;
        readonly availableSlots: number;
        readonly runs: readonly AttemptRunView[];
        readonly errors?: Readonly<Record<string, RuntimeErrorView>> | undefined;
      }
    | undefined;
}

export interface RuntimeErrorView {
  readonly code: string;
  readonly message: string;
  readonly recordedAt: string;
}

export type HomeTaskStatusCode =
  | "planned"
  | "running"
  | "cancelling"
  | "terminalizing"
  | "awaiting_artifact"
  | "awaiting_evidence"
  | "awaiting_acceptance"
  | "blocked"
  | "accepted"
  | "unknown";

export type HomeAttentionKind =
  | "ready_for_acceptance"
  | "artifact_missing"
  | "evidence_missing"
  | "evidence_failed"
  | "attempt_interrupted"
  | "blocked"
  | "runtime_error";

export interface HomeTask {
  readonly ref: {
    readonly projectKey: string;
    readonly workItemId: string;
  };
  readonly name: string;
  readonly externalIssue: {
    readonly provider: string;
    readonly id: string;
    readonly url: string;
  } | null;
  readonly status: {
    readonly code: HomeTaskStatusCode;
    readonly basis:
      | "runtime"
      | "workflow"
      | "last_known";
  };
  readonly elapsed: {
    readonly startedAt: string;
    readonly asOf: string;
    readonly elapsedMs: number;
    readonly mode: "live" | "frozen";
  } | null;
  readonly agentId: string | null;
  readonly attemptId: string | null;
  readonly deliveryGate: {
    readonly passed: number;
    readonly failed: number;
    readonly missing: number;
    readonly total: number;
    readonly artifactPresent: boolean;
    readonly factsReady: boolean;
  };
  readonly attention: {
    readonly kind: HomeAttentionKind;
    readonly priority: number;
    readonly reason: string;
    readonly since: string;
    readonly nextAction: string;
    readonly actionAvailable: boolean;
  } | null;
  readonly nextStep: {
    readonly code: "dispatch" | "open" | "review" | "resolve";
    readonly actionAvailable: boolean;
  } | null;
}

export interface HomeRuntimeView {
  readonly maxConcurrentRuns: number;
  readonly activeCount: number;
  readonly availableSlots: number;
}

export interface HomeSnapshot {
  readonly schemaVersion: "home/v1";
  readonly generatedAt: string;
  readonly mode: HomeMode;
  readonly freshness: HomeFreshness;
  readonly project: {
    readonly key: string;
    readonly name: string;
  };
  readonly runtime: HomeRuntimeView;
  readonly summary: {
    readonly running: number;
    readonly needsAttention: number;
    readonly nextUp: number;
    readonly verified: number;
  };
  readonly runningNow: readonly HomeTask[];
  readonly needsAttention: readonly HomeTask[];
  readonly nextUp: readonly HomeTask[];
  readonly recentlyVerified: readonly HomeTask[];
}

export function projectHomeSnapshot(
  input: HomeProjectionInput
): HomeSnapshot {
  const now = normalizeDate(input.now ?? input.dashboard.generatedAt);
  const freshness = input.freshness ?? "fresh";
  const project = input.project ?? {
    key: "current",
    name: "Current project"
  };
  const runs = input.runtime?.runs ?? [];
  const errors = input.runtime?.errors ?? {};
  const tasks = input.dashboard.workItems.map((workItem) =>
    projectHomeTask({
      workItem,
      project,
      now,
      freshness,
      run: runs.find((candidate) => candidate.workItemId === workItem.id) ?? null,
      runtimeError: errors[workItem.id] ?? null
    })
  );

  const runningNow = tasks
    .filter((task) =>
      task.status.code === "running" ||
      task.status.code === "cancelling" ||
      task.status.code === "terminalizing"
    )
    .toSorted(compareTasks);
  const needsAttention = tasks
    .filter((task) => task.attention !== null)
    .toSorted(compareAttention);
  const nextUp = tasks
    .filter((task) => task.nextStep?.code === "dispatch")
    .toSorted(compareTasks);
  const recentlyVerified = tasks
    .filter((task) => task.status.code === "accepted")
    .toSorted(compareTasks)
    .slice(0, 5);
  const verifiedCount = tasks.filter(
    (task) => task.status.code === "accepted"
  ).length;

  return {
    schemaVersion: "home/v1",
    generatedAt: input.dashboard.generatedAt,
    mode: input.mode ?? "persistent",
    freshness,
    project,
    runtime: {
      maxConcurrentRuns: input.runtime?.maxConcurrentRuns ?? 0,
      activeCount: input.runtime?.activeCount ?? runningNow.length,
      availableSlots: input.runtime?.availableSlots ?? 0
    },
    summary: {
      running: runningNow.length,
      needsAttention: needsAttention.length,
      nextUp: nextUp.length,
      verified: verifiedCount
    },
    runningNow,
    needsAttention,
    nextUp,
    recentlyVerified
  };
}

function projectHomeTask({
  workItem,
  project,
  now,
  freshness,
  run,
  runtimeError
}: {
  readonly workItem: DashboardWorkItem;
  readonly project: { readonly key: string; readonly name: string };
  readonly now: Date;
  readonly freshness: HomeFreshness;
  readonly run: AttemptRunView | null;
  readonly runtimeError: RuntimeErrorView | null;
}): HomeTask {
  const activeAttempt = workItem.activeAttempt;
  const liveRun = run ?? null;
  const status = projectStatus(workItem, liveRun, freshness);
  const startedAt = liveRun?.startedAt ?? activeAttempt?.startedAt ?? null;
  const elapsed = startedAt
    ? {
        startedAt,
        asOf: now.toISOString(),
        elapsedMs: Math.max(0, now.getTime() - Date.parse(startedAt)),
        mode: liveRun && freshness === "fresh" ? "live" as const : "frozen" as const
      }
    : null;
  const deliveryGate = {
    passed: workItem.progress.passedEvidence,
    failed: workItem.progress.failedEvidence,
    missing: workItem.progress.missingEvidence,
    total: workItem.progress.totalEvidence,
    artifactPresent: workItem.activeArtifact !== null,
    factsReady:
      activeAttempt?.status === "completed" &&
      workItem.activeArtifact !== null &&
      workItem.progress.failedEvidence === 0 &&
      workItem.progress.missingEvidence === 0 &&
      workItem.acceptanceDecision === null
  };
  const attention = projectAttention({
    workItem,
    status,
    deliveryGate,
    runtimeError
  });
  const externalLink = workItem.externalLinks.find(
    (link) => link.provider === "linear" || link.provider === "github"
  );

  return {
    ref: {
      projectKey: project.key,
      workItemId: workItem.id
    },
    name: workItem.title,
    externalIssue: externalLink
      ? {
          provider: externalLink.provider,
          id: externalLink.externalId,
          url: externalLink.url
        }
      : null,
    status,
    elapsed,
    agentId: activeAttempt?.agentId ?? null,
    attemptId: activeAttempt?.id ?? null,
    deliveryGate,
    attention,
    nextStep: nextStepFor(workItem, attention)
  };
}

function projectStatus(
  workItem: DashboardWorkItem,
  run: AttemptRunView | null,
  freshness: HomeFreshness
): HomeTask["status"] {
  if (run) {
    return {
      code: run.phase,
      basis: freshness === "fresh" ? "runtime" : "last_known"
    };
  }
  if (workItem.status === "accepted") {
    return { code: "accepted", basis: "workflow" };
  }
  if (workItem.status === "planned") {
    return { code: "planned", basis: "workflow" };
  }
  if (workItem.status === "blocked") {
    return { code: "blocked", basis: "workflow" };
  }
  if (workItem.status === "running") {
    return {
      code: "running",
      basis: "last_known"
    };
  }
  if (workItem.activeArtifact === null) {
    return { code: "awaiting_artifact", basis: "workflow" };
  }
  if (workItem.progress.failedEvidence > 0 || workItem.progress.missingEvidence > 0) {
    return { code: "awaiting_evidence", basis: "workflow" };
  }
  return { code: "awaiting_acceptance", basis: "workflow" };
}

function projectAttention({
  workItem,
  status,
  deliveryGate,
  runtimeError
}: {
  readonly workItem: DashboardWorkItem;
  readonly status: HomeTask["status"];
  readonly deliveryGate: HomeTask["deliveryGate"];
  readonly runtimeError: RuntimeErrorView | null;
}): HomeTask["attention"] {
  const latestAttempt = workItem.attempts.at(-1) ?? null;
  const since =
    latestAttempt?.completedAt ??
    latestAttempt?.startedAt ??
    workItem.acceptanceDecision?.decidedAt ??
    new Date(0).toISOString();

  if (runtimeError) {
    return {
      kind: "runtime_error",
      priority: 1,
      reason: runtimeError.code,
      since: runtimeError.recordedAt,
      nextAction: "查看运行错误",
      actionAvailable: true
    };
  }
  if (workItem.status === "blocked") {
    const interrupted =
      latestAttempt?.status === "failed" ||
      latestAttempt?.status === "interrupted";
    return {
      kind: interrupted ? "attempt_interrupted" : "blocked",
      priority: interrupted ? 2 : 4,
      reason: interrupted ? "执行未完成" : "工作项被阻塞",
      since,
      nextAction: interrupted ? "查看执行结果" : "查看阻塞原因",
      actionAvailable: true
    };
  }
  if (deliveryGate.factsReady) {
    return {
      kind: "ready_for_acceptance",
      priority: 1,
      reason: "证据门禁已满足，等待人工验收",
      since,
      nextAction: "审核交付",
      actionAvailable: true
    };
  }
  if (status.code === "awaiting_artifact") {
    return {
      kind: "artifact_missing",
      priority: 3,
      reason: "Attempt 已结束，但当前 Artifact 尚未提交",
      since,
      nextAction: "查看交付物",
      actionAvailable: true
    };
  }
  if (deliveryGate.failed > 0) {
    return {
      kind: "evidence_failed",
      priority: 2,
      reason: `${deliveryGate.failed} 项证据失败`,
      since,
      nextAction: "查看失败证据",
      actionAvailable: true
    };
  }
  if (deliveryGate.missing > 0 && workItem.status === "reviewing") {
    return {
      kind: "evidence_missing",
      priority: 3,
      reason: `${deliveryGate.missing} 项 Required Evidence 缺失`,
      since,
      nextAction: "补充证据",
      actionAvailable: true
    };
  }
  return null;
}

function nextStepFor(
  workItem: DashboardWorkItem,
  attention: HomeTask["attention"]
): HomeTask["nextStep"] {
  if (workItem.status === "planned") {
    return { code: "dispatch", actionAvailable: true };
  }
  if (attention) {
    return {
      code:
        attention.kind === "ready_for_acceptance"
          ? "review"
          : attention.kind === "blocked" || attention.kind === "runtime_error"
            ? "resolve"
            : "open",
      actionAvailable: attention.actionAvailable
    };
  }
  if (workItem.status === "accepted") {
    return { code: "open", actionAvailable: true };
  }
  return null;
}

function compareAttention(left: HomeTask, right: HomeTask): number {
  return (
    (left.attention?.priority ?? Number.MAX_SAFE_INTEGER) -
      (right.attention?.priority ?? Number.MAX_SAFE_INTEGER) ||
    Date.parse(left.attention?.since ?? "") -
      Date.parse(right.attention?.since ?? "") ||
    left.ref.workItemId.localeCompare(right.ref.workItemId)
  );
}

function compareTasks(left: HomeTask, right: HomeTask): number {
  return left.ref.workItemId.localeCompare(right.ref.workItemId);
}

function normalizeDate(value: string | Date): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("TaskSeal home projection requires a valid timestamp.");
  }
  return date;
}
