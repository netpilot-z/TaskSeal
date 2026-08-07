import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { join } from "node:path";

import {
  readControlRoomInstance
} from "./control-room-lock.ts";
import {
  TaskSealService
} from "./taskseal-service.ts";
import {
  projectHomeSnapshot
} from "../dashboard/home-projection.ts";
import type {
  HomeSnapshot
} from "../dashboard/home-projection.ts";
import type {
  ProjectHubSource
} from "../dashboard/project-hub.ts";
import {
  inspectConfiguration,
  resolveUserConfigurationPath
} from "./configuration-control.ts";
import {
  FileEventJournal
} from "../storage/event-journal.ts";

export interface ProjectRegistryPort {
  list(): Promise<readonly ProjectHubSource[]>;
}

interface ProjectRegistryEntry {
  readonly projectRef: string;
  readonly workspace: string;
  readonly name?: string | undefined;
}

interface ProjectRegistryFile {
  readonly schemaVersion: "project-registry/v1";
  readonly projects: readonly ProjectRegistryEntry[];
}

/**
 * Reads additional local workspaces without opening their writers. A registry
 * entry is either served from its verified loopback Control Room or replayed
 * from its durable event journal, so a broken project cannot hide the others.
 */
export function createLocalProjectRegistry({
  cwd,
  now = () => new Date(),
  environment = process.env
}: {
  readonly cwd: string;
  readonly now?: () => Date;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}): ProjectRegistryPort {
  return {
    async list(): Promise<readonly ProjectHubSource[]> {
      const entries = await readRegistryFile({ cwd });
      return entries.projects.map((entry) => ({
        projectRef: entry.projectRef,
        async read() {
          return readProjectHome({
            cwd,
            entry,
            now,
            environment
          });
        }
      }));
    }
  };
}

async function readRegistryFile({
  cwd
}: {
  readonly cwd: string;
}): Promise<ProjectRegistryFile> {
  const filePath = join(cwd, "config", "projects.json");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { schemaVersion: "project-registry/v1", projects: [] };
    }
    throw registryError();
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw registryError();
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== "project-registry/v1" ||
    !Array.isArray(value.projects)
  ) {
    throw registryError();
  }
  const projects: ProjectRegistryEntry[] = [];
  const seen = new Set<string>();
  for (const project of value.projects) {
    if (
      !isRecord(project) ||
      !isSafeRef(project.projectRef) ||
      project.projectRef === "current" ||
      !isSafeWorkspace(project.workspace) ||
      (project.name !== undefined && !isSafeName(project.name))
    ) {
      throw registryError();
    }
    if (seen.has(project.projectRef)) {
      throw registryError();
    }
    seen.add(project.projectRef);
    projects.push({
      projectRef: project.projectRef,
      workspace: project.workspace,
      ...(project.name === undefined ? {} : { name: project.name })
    });
  }
  return {
    schemaVersion: "project-registry/v1",
    projects
  };
}

async function readProjectHome({
  cwd,
  entry,
  now,
  environment
}: {
  readonly cwd: string;
  readonly entry: ProjectRegistryEntry;
  readonly now: () => Date;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<HomeSnapshot> {
  const workspace = resolveWorkspace({ cwd, workspace: entry.workspace });
  const instance = await readControlRoomInstance({ cwd: workspace }).catch(() => null);
  if (instance !== null) {
    try {
      const response = await fetch(
        `http://${instance.host}:${instance.port}/api/home`,
        { signal: AbortSignal.timeout(1_500) }
      );
      const value: unknown = await response.json().catch(() => null);
      if (response.ok && isHomeSnapshot(value)) {
        return {
          ...value,
          project: {
            key: entry.projectRef,
            name: value.project.name
          }
        };
      }
    } catch {
      // The journal remains the authoritative fallback for a stopped project.
    }
  }

  let projectName = entry.name ?? entry.projectRef;
  try {
    const configuration = await inspectConfiguration({
      cwd: workspace,
      environment,
      userConfigurationPath: resolveUserConfigurationPath({ environment })
    });
    projectName = configuration.effective?.project ?? projectName;
  } catch {
    // The registry name is sufficient for an offline project card.
  }
  const service = await TaskSealService.open({
    journal: new FileEventJournal({
      filePath: join(workspace, ".taskseal", "events.jsonl")
    })
  });
  return projectHomeSnapshot({
    dashboard: service.snapshot(),
    mode: "persistent",
    project: {
      key: entry.projectRef,
      name: projectName
    },
    freshness: "stale",
    runtime: {
      maxConcurrentRuns: 0,
      activeCount: 0,
      availableSlots: 0,
      runs: [],
      errors: {}
    },
    now: now()
  });
}

function resolveWorkspace({
  cwd,
  workspace
}: {
  readonly cwd: string;
  readonly workspace: string;
}): string {
  const resolved = resolve(cwd, workspace);
  const boundary = relative(cwd, resolved);
  if (
    isAbsolute(workspace) ||
    boundary === ".." ||
    boundary.startsWith(`..${sep}`)
  ) {
    throw registryError();
  }
  return resolved;
}

function isHomeSnapshot(value: unknown): value is HomeSnapshot {
  return isRecord(value) &&
    value.schemaVersion === "home/v1" &&
    isRecord(value.project) &&
    typeof value.project.key === "string" &&
    typeof value.project.name === "string" &&
    Array.isArray(value.runningNow) &&
    Array.isArray(value.needsAttention) &&
    Array.isArray(value.nextUp) &&
    Array.isArray(value.recentlyVerified);
}

function isSafeRef(value: unknown): value is string {
  return typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value);
}

function isSafeWorkspace(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 240 &&
    !value.includes("\0");
}

function isSafeName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160;
}

function registryError(): Error {
  return Object.assign(
    new Error("TaskSeal project registry is invalid."),
    { code: "PROJECT_REGISTRY_INVALID" }
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
