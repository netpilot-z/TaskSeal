import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ProjectConfiguration {
  readonly project: string;
  readonly github?: Readonly<Record<string, unknown>>;
  readonly gitee?: Readonly<Record<string, unknown>>;
  readonly linear?: Readonly<Record<string, unknown>>;
  readonly mode?: string;
}

type ProjectConfigErrorCode =
  | "PROJECT_CONFIG_INVALID"
  | "GITHUB_CONFIG_INVALID"
  | "GITEE_CONFIG_INVALID"
  | "LINEAR_CONFIG_INVALID";

export async function readProjectConfiguration({
  cwd
}: {
  cwd: string;
}): Promise<ProjectConfiguration> {
  let parsed: unknown;

  try {
    const content = await readFile(
      join(cwd, "config", "project.json"),
      "utf8"
    );
    parsed = JSON.parse(content);
  } catch {
    throw configError(
      "PROJECT_CONFIG_INVALID",
      "TaskSeal project configuration is missing or invalid."
    );
  }

  if (
    !isRecord(parsed) ||
    !isNonEmptyString(parsed.project)
  ) {
    throw configError(
      "PROJECT_CONFIG_INVALID",
      "TaskSeal project configuration requires a project name."
    );
  }

  return {
    project: parsed.project,
    ...(isRecord(parsed.github)
      ? { github: { ...parsed.github } }
      : {}),
    ...(isRecord(parsed.gitee)
      ? { gitee: { ...parsed.gitee } }
      : {}),
    ...(isRecord(parsed.linear)
      ? { linear: { ...parsed.linear } }
      : {}),
    ...(isNonEmptyString(parsed.mode) ? { mode: parsed.mode } : {})
  };
}

export function getGitHubCoordinates(
  configuration: ProjectConfiguration | null | undefined
): { repository: string } {
  const repository = configuration?.github?.repository;
  const parts =
    typeof repository === "string" ? repository.split("/") : [];

  if (
    typeof repository !== "string" ||
    parts.length !== 2 ||
    parts.some(
      (part) =>
        !/^[A-Za-z0-9_.-]+$/.test(part) ||
        part === "." ||
        part === ".."
    )
  ) {
    throw configError(
      "GITHUB_CONFIG_INVALID",
      "GitHub configuration requires repository in owner/name format."
    );
  }

  return { repository };
}

export function getLinearCoordinates(
  configuration: ProjectConfiguration | null | undefined
): { workspace: string; team: string } {
  const workspace = configuration?.linear?.workspace;
  const team = configuration?.linear?.team;

  if (!isNonEmptyString(workspace) || !isNonEmptyString(team)) {
    throw configError(
      "LINEAR_CONFIG_INVALID",
      "Linear configuration requires workspace and team references."
    );
  }

  return { workspace, team };
}

export function getGiteeCoordinates(
  configuration: ProjectConfiguration | null | undefined
): { repository: string } {
  const gitee = configuration?.gitee;
  const repository = gitee?.repository;
  const parts =
    typeof repository === "string" ? repository.split("/") : [];

  if (
    !gitee ||
    Object.keys(gitee).length !== 1 ||
    !Object.hasOwn(gitee, "repository") ||
    typeof repository !== "string" ||
    repository !== repository.trim() ||
    repository.length > 201 ||
    parts.length !== 2 ||
    parts.some(
      (part) =>
        part.length === 0 ||
        part.length > 100 ||
        !/^[A-Za-z0-9_.-]+$/.test(part) ||
        part === "." ||
        part === ".."
    )
  ) {
    throw configError(
      "GITEE_CONFIG_INVALID",
      "Gitee configuration requires only repository in owner/name format."
    );
  }

  return { repository };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

class ProjectConfigError extends Error {
  readonly code: ProjectConfigErrorCode;

  constructor(code: ProjectConfigErrorCode, message: string) {
    super(message);
    this.name = "ProjectConfigError";
    this.code = code;
  }
}

function configError(
  code: ProjectConfigErrorCode,
  message: string
): ProjectConfigError {
  return new ProjectConfigError(code, message);
}
