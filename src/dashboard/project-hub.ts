import type { HomeSnapshot } from "./home-projection.ts";

export interface ProjectHubSource {
  readonly projectRef: string;
  read(): Promise<HomeSnapshot>;
}

export interface ProjectHubQueryPort {
  read(): Promise<ProjectHubSnapshot>;
}

export interface ProjectHubProject {
  readonly projectRef: string;
  readonly availability: "fresh" | "stale" | "unavailable";
  readonly snapshot: HomeSnapshot | null;
  readonly errorCode: "PROJECT_UNAVAILABLE" | null;
}

export interface ProjectHubSnapshot {
  readonly schemaVersion: "project-hub/v1";
  readonly generatedAt: string;
  readonly summary: {
    readonly projects: number;
    readonly running: number;
    readonly needsAttention: number;
    readonly nextUp: number;
  };
  readonly projects: readonly ProjectHubProject[];
}

/**
 * Aggregates read-only project snapshots. A single fenced/offline project is
 * represented as unavailable and never prevents other projects from being
 * rendered; this module owns no locks, journals, or mutation ports.
 */
export async function projectHubSnapshot({
  sources,
  now = new Date()
}: {
  readonly sources: readonly ProjectHubSource[];
  readonly now?: Date;
}): Promise<ProjectHubSnapshot> {
  const refs = new Set<string>();
  for (const source of sources) {
    if (refs.has(source.projectRef)) {
      throw new Error("PROJECT_REF_DUPLICATE");
    }
    refs.add(source.projectRef);
  }
  const projects = await Promise.all(sources.map(async (source): Promise<ProjectHubProject> => {
    try {
      const snapshot = await source.read();
      if (snapshot.project.key !== source.projectRef) {
        return unavailable(source.projectRef);
      }
      return {
        projectRef: source.projectRef,
        availability: snapshot.freshness,
        snapshot,
        errorCode: null
      };
    } catch {
      return unavailable(source.projectRef);
    }
  }));
  const available = projects.flatMap((project) =>
    project.snapshot === null || project.availability === "unavailable"
      ? []
      : [project.snapshot]
  );
  return {
    schemaVersion: "project-hub/v1",
    generatedAt: now.toISOString(),
    summary: {
      projects: projects.length,
      running: available.reduce((total, snapshot) => total + snapshot.summary.running, 0),
      needsAttention: available.reduce((total, snapshot) => total + snapshot.summary.needsAttention, 0),
      nextUp: available.reduce((total, snapshot) => total + snapshot.summary.nextUp, 0)
    },
    projects
  };
}

function unavailable(projectRef: string): ProjectHubProject {
  return {
    projectRef,
    availability: "unavailable",
    snapshot: null,
    errorCode: "PROJECT_UNAVAILABLE"
  };
}
