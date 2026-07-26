import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function readProjectConfiguration({ cwd }) {
  let parsed;

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
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !isNonEmptyString(parsed.project)
  ) {
    throw configError(
      "PROJECT_CONFIG_INVALID",
      "TaskSeal project configuration requires a project name."
    );
  }

  return {
    project: parsed.project,
    ...(parsed.github ? { github: { ...parsed.github } } : {}),
    ...(parsed.linear ? { linear: { ...parsed.linear } } : {}),
    ...(isNonEmptyString(parsed.mode) ? { mode: parsed.mode } : {})
  };
}

export function getGitHubCoordinates(configuration) {
  const repository = configuration?.github?.repository;
  const parts =
    typeof repository === "string" ? repository.split("/") : [];

  if (
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

export function getLinearCoordinates(configuration) {
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

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function configError(code, message) {
  const error = new Error(message);
  error.name = "ProjectConfigError";
  error.code = code;
  return error;
}
