import type { HomeSnapshot, HomeTask, HomeFreshness } from "../dashboard/home-projection.ts";
import {
  projectHubSnapshot
} from "../dashboard/project-hub.ts";
import type {
  ProjectHubProject,
  ProjectHubSnapshot,
  ProjectHubSource
} from "../dashboard/project-hub.ts";

export interface ProjectOperationsQueryInput {
  readonly projectRef?: string | undefined;
  readonly workItemId?: string | undefined;
}

export interface ProjectOperationsSource extends ProjectHubSource {
  readonly runtime?: "live" | "offline" | undefined;
}

export interface ProjectOperationsRuntimeView {
  readonly mode: "live" | "offline";
  readonly freshness: HomeFreshness;
  readonly source: "control-room" | "journal";
}

export interface ProjectOperationsView {
  readonly schemaVersion: "project-operations/v1";
  readonly generatedAt: string;
  readonly runtime: ProjectOperationsRuntimeView;
  readonly projectHub: ProjectHubSnapshot;
  readonly selected: {
    readonly projectRef: string;
    readonly workItem: HomeTask | null;
  } | null;
}

export interface ProjectOperationsQueryPort {
  snapshot(
    input?: ProjectOperationsQueryInput
  ): Promise<ProjectOperationsView>;
}

/**
 * Application-owned read model for the operator's current work. Sources are
 * intentionally read-only; they may be a live loopback endpoint or a local
 * journal replay, but never open a runner or a writer lock.
 */
export function createProjectOperationsQuery({
  sources,
  now = () => new Date()
}: {
  readonly sources: readonly ProjectOperationsSource[];
  readonly now?: () => Date;
}): ProjectOperationsQueryPort {
  return {
    async snapshot(input = {}): Promise<ProjectOperationsView> {
      const generatedAt = now().toISOString();
      const projectHub = await projectHubSnapshot({
        sources,
        now: new Date(generatedAt)
      });
      const selectedProject = selectProject({
        projects: projectHub.projects,
        projectRef: input.projectRef
      });
      const selectedWorkItem =
        selectedProject === null || input.workItemId === undefined
          ? null
          : findWorkItem(selectedProject, input.workItemId);
      const runtime = projectRuntime({
        projects: projectHub.projects,
        sources
      });

      return {
        schemaVersion: "project-operations/v1",
        generatedAt: projectHub.generatedAt,
        runtime,
        projectHub,
        selected: selectedProject === null
          ? null
          : {
              projectRef: selectedProject.projectRef,
              workItem: selectedWorkItem
            }
      };
    }
  };
}

export function collectProjectWorkItems(
  project: ProjectHubProject
): readonly HomeTask[] {
  if (project.snapshot === null) {
    return [];
  }
  const byId = new Map<string, HomeTask>();
  for (const task of [
    ...project.snapshot.runningNow,
    ...project.snapshot.needsAttention,
    ...project.snapshot.nextUp,
    ...project.snapshot.recentlyVerified
  ]) {
    byId.set(task.ref.workItemId, task);
  }
  return [...byId.values()].sort((left, right) =>
    left.ref.workItemId.localeCompare(right.ref.workItemId)
  );
}

export function projectOperationsViewFromHub({
  projectHub,
  runtime,
  input = {}
}: {
  readonly projectHub: ProjectHubSnapshot;
  readonly runtime: ProjectOperationsRuntimeView;
  readonly input?: ProjectOperationsQueryInput;
}): ProjectOperationsView {
  const selectedProject = selectProject({
    projects: projectHub.projects,
    projectRef: input.projectRef
  });
  return {
    schemaVersion: "project-operations/v1",
    generatedAt: projectHub.generatedAt,
    runtime,
    projectHub,
    selected: selectedProject === null
      ? null
      : {
          projectRef: selectedProject.projectRef,
          workItem: input.workItemId === undefined
            ? null
            : findWorkItem(selectedProject, input.workItemId)
        }
  };
}

function selectProject({
  projects,
  projectRef
}: {
  readonly projects: readonly ProjectHubProject[];
  readonly projectRef: string | undefined;
}): ProjectHubProject | null {
  if (projectRef !== undefined) {
    return projects.find((project) => project.projectRef === projectRef) ?? null;
  }
  return projects[0] ?? null;
}

function findWorkItem(
  project: ProjectHubProject | null,
  workItemId: string
): HomeTask | null {
  if (project === null) {
    return null;
  }
  return collectProjectWorkItems(project)
    .find((task) => task.ref.workItemId === workItemId) ?? null;
}

function projectRuntime({
  projects,
  sources
}: {
  readonly projects: readonly ProjectHubProject[];
  readonly sources: readonly ProjectOperationsSource[];
}): ProjectOperationsRuntimeView {
  const available = projects.filter((project) => project.snapshot !== null);
  const live = available.length > 0 && available.every((project) => {
    const source = sources.find((candidate) =>
      candidate.projectRef === project.projectRef
    );
    return source?.runtime === "live";
  });
  const freshness = available.some((project) => project.availability === "fresh")
    ? "fresh"
    : available.some((project) => project.availability === "stale")
      ? "stale"
      : "unavailable";
  return {
    mode: live ? "live" : "offline",
    freshness,
    source: live ? "control-room" : "journal"
  };
}
