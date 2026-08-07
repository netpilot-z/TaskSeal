import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createFeishuTableScope
} from "../lib/feishu-identity.ts";

export interface ProjectConfiguration {
  readonly project: string;
  readonly github?: Readonly<Record<string, unknown>>;
  readonly gitee?: Readonly<Record<string, unknown>>;
  readonly feishu?: Readonly<Record<string, unknown>>;
  readonly linear?: Readonly<Record<string, unknown>>;
  readonly mode?: string;
}

export interface FeishuReadEnvironment {
  readonly TASKSEAL_FEISHU_APP_TOKEN?: string | undefined;
  readonly TASKSEAL_FEISHU_TABLE_ID?: string | undefined;
  readonly TASKSEAL_FEISHU_RECORD_ID?: string | undefined;
  readonly TASKSEAL_FEISHU_TITLE_FIELD?: string | undefined;
  readonly TASKSEAL_FEISHU_STATUS_FIELD?: string | undefined;
  readonly TASKSEAL_FEISHU_UPDATED_AT_FIELD?: string | undefined;
}

export interface FeishuReadCoordinates {
  readonly appToken: string;
  readonly tableId: string;
  readonly recordId: string;
  readonly fieldMapping: {
    readonly title: string;
    readonly status: string;
    readonly updatedAt: string;
  };
  readonly tableScopeKey: string;
}

export interface FeishuConfiguration {
  readonly enabled: true;
  readonly tableScopeKey: string;
}

export interface LinearBootstrapCoordinates {
  readonly workspace: string;
  readonly team: string;
  readonly project: string;
  readonly backlogState: string;
}

export interface LinearProjectCoordinates {
  readonly workspace: string;
  readonly team: string;
  readonly project: string;
}

export interface GitHubDeliveryCoordinates {
  readonly repository: string;
  readonly enabled: boolean;
  readonly mappingIndex: string;
}

export interface LinearReadyWorkCoordinates {
  readonly workspace: string;
  readonly team: string;
  readonly project: string;
  readonly readyState: string;
  readonly completedState: string;
  readonly dependencyIndex: string;
  readonly enabled: boolean;
}

export type LinearAcceptanceCoordinates =
  | {
      readonly workspace: string;
      readonly team: string;
      readonly project: string;
      readonly enabled: false;
      readonly expectedState: null;
      readonly targetState: null;
    }
  | {
      readonly workspace: string;
      readonly team: string;
      readonly project: string;
      readonly enabled: true;
      readonly expectedState: string;
      readonly targetState: string;
    };

export type ProjectConfigErrorCode =
  | "PROJECT_CONFIG_INVALID"
  | "GITHUB_CONFIG_INVALID"
  | "GITEE_CONFIG_INVALID"
  | "FEISHU_CONFIG_INVALID"
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

  try {
    return parseProjectConfiguration(parsed);
  } catch {
    throw configError(
      "PROJECT_CONFIG_INVALID",
      "TaskSeal project configuration requires a project name."
    );
  }
}

export function parseProjectConfiguration(
  parsed: unknown
): ProjectConfiguration {
  if (
    !isRecord(parsed) ||
    !isNonEmptyString(parsed.project) ||
    !Object.keys(parsed).every((key) =>
      [
        "project",
        "github",
        "gitee",
        "feishu",
        "linear",
        "mode"
      ].includes(key)
    ) ||
    ![
      parsed.github,
      parsed.gitee,
      parsed.feishu,
      parsed.linear
    ].every(
      (value) =>
        value === undefined ||
        isRecord(value)
    ) ||
    (
      parsed.mode !== undefined &&
      !isNonEmptyString(parsed.mode)
    )
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
    ...(isRecord(parsed.feishu)
      ? { feishu: { ...parsed.feishu } }
      : {}),
    ...(isRecord(parsed.linear)
      ? { linear: { ...parsed.linear } }
      : {}),
    ...(isNonEmptyString(parsed.mode)
      ? { mode: parsed.mode }
      : {})
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

export function getGitHubDeliveryCoordinates(
  configuration: ProjectConfiguration | null | undefined
): GitHubDeliveryCoordinates {
  const { repository } =
    getGitHubCoordinates(configuration);
  const delivery =
    configuration?.github?.delivery;

  if (
    !isRecord(delivery) ||
    !hasExactKeys(delivery, [
      "enabled",
      "mappingIndex"
    ]) ||
    typeof delivery.enabled !== "boolean" ||
    !isRepositoryRelativePath(
      delivery.mappingIndex
    )
  ) {
    throw configError(
      "GITHUB_CONFIG_INVALID",
      "GitHub delivery configuration requires an enabled flag and repository-relative mapping index."
    );
  }

  return {
    repository,
    enabled: delivery.enabled,
    mappingIndex: delivery.mappingIndex
  };
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

export function getLinearProjectCoordinates(
  configuration: ProjectConfiguration | null | undefined
): LinearProjectCoordinates {
  const { workspace, team } =
    getLinearCoordinates(configuration);
  const project = configuration?.linear?.project;

  if (!isNonEmptyTrimmedString(project)) {
    throw configError(
      "LINEAR_CONFIG_INVALID",
      "Linear project configuration requires a project reference."
    );
  }

  return { workspace, team, project };
}

export function getLinearBootstrapCoordinates(
  configuration: ProjectConfiguration | null | undefined
): LinearBootstrapCoordinates {
  const { workspace, team } =
    getLinearCoordinates(configuration);
  const project = configuration?.linear?.project;
  const backlogState =
    configuration?.linear?.backlogState;

  if (
    !isNonEmptyTrimmedString(workspace) ||
    !isNonEmptyTrimmedString(team) ||
    !isNonEmptyTrimmedString(project) ||
    !isNonEmptyTrimmedString(backlogState)
  ) {
    throw configError(
      "LINEAR_CONFIG_INVALID",
      "Linear bootstrap configuration requires project and backlogState references."
    );
  }

  return {
    workspace,
    team,
    project,
    backlogState
  };
}

export function getLinearReadyWorkCoordinates(
  configuration: ProjectConfiguration | null | undefined
): LinearReadyWorkCoordinates {
  const { workspace, team } =
    getLinearCoordinates(configuration);
  const project = configuration?.linear?.project;
  const readyWork =
    configuration?.linear?.readyWork;

  if (
    !isNonEmptyTrimmedString(workspace) ||
    !isNonEmptyTrimmedString(team) ||
    !isNonEmptyTrimmedString(project) ||
    !isRecord(readyWork) ||
    !hasExactKeys(readyWork, [
      "enabled",
      "readyState",
      "completedState",
      "dependencyIndex"
    ]) ||
    typeof readyWork.enabled !== "boolean" ||
    !isNonEmptyTrimmedString(
      readyWork.readyState
    ) ||
    !isNonEmptyTrimmedString(
      readyWork.completedState
    ) ||
    normalizeReference(readyWork.readyState) ===
      normalizeReference(
        readyWork.completedState
      ) ||
    !isRepositoryRelativePath(
      readyWork.dependencyIndex
    )
  ) {
    throw configError(
      "LINEAR_CONFIG_INVALID",
      "Linear ready-work configuration requires explicit states and a repository-relative dependency index."
    );
  }

  return {
    workspace,
    team,
    project,
    readyState: readyWork.readyState,
    completedState: readyWork.completedState,
    dependencyIndex:
      readyWork.dependencyIndex,
    enabled: readyWork.enabled
  };
}

export function getLinearAcceptanceCoordinates(
  configuration: ProjectConfiguration | null | undefined
): LinearAcceptanceCoordinates {
  const { workspace, team } =
    getLinearCoordinates(configuration);
  const project =
    configuration?.linear?.project;
  const acceptance =
    configuration?.linear?.acceptance;

  if (
    !isNonEmptyTrimmedString(workspace) ||
    !isNonEmptyTrimmedString(team) ||
    !isNonEmptyTrimmedString(project)
  ) {
    throw configError(
      "LINEAR_CONFIG_INVALID",
      "Linear acceptance configuration requires a project reference."
    );
  }

  if (acceptance === undefined) {
    return {
      workspace,
      team,
      project,
      enabled: false,
      expectedState: null,
      targetState: null
    };
  }

  if (
    isRecord(acceptance) &&
    hasExactKeys(acceptance, [
      "enabled"
    ]) &&
    acceptance.enabled === false
  ) {
    return {
      workspace,
      team,
      project,
      enabled: false,
      expectedState: null,
      targetState: null
    };
  }

  if (
    !isRecord(acceptance) ||
    !hasExactKeys(acceptance, [
      "enabled",
      "expectedState",
      "targetState"
    ]) ||
    acceptance.enabled !== true ||
    !isNonEmptyTrimmedString(
      acceptance.expectedState
    ) ||
    !isNonEmptyTrimmedString(
      acceptance.targetState
    ) ||
    normalizeReference(
      acceptance.expectedState
    ) ===
      normalizeReference(
        acceptance.targetState
      )
  ) {
    throw configError(
      "LINEAR_CONFIG_INVALID",
      "Linear acceptance configuration must be disabled explicitly or provide distinct expected and target states."
    );
  }

  return {
    workspace,
    team,
    project,
    enabled: true,
    expectedState:
      acceptance.expectedState,
    targetState:
      acceptance.targetState
  };
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

export function getFeishuReadCoordinates(
  configuration: ProjectConfiguration | null | undefined,
  environment: FeishuReadEnvironment
): FeishuReadCoordinates {
  const feishu = getFeishuConfiguration(
    configuration
  );
  const appToken = normalizeFeishuIdentifier(
    environment.TASKSEAL_FEISHU_APP_TOKEN
  );
  const tableId = normalizeFeishuIdentifier(
    environment.TASKSEAL_FEISHU_TABLE_ID
  );
  const recordId = normalizeFeishuIdentifier(
    environment.TASKSEAL_FEISHU_RECORD_ID
  );
  const fieldMapping = {
    title: normalizeFeishuFieldName(
      environment.TASKSEAL_FEISHU_TITLE_FIELD
    ),
    status: normalizeFeishuFieldName(
      environment.TASKSEAL_FEISHU_STATUS_FIELD
    ),
    updatedAt: normalizeFeishuFieldName(
      environment.TASKSEAL_FEISHU_UPDATED_AT_FIELD
    )
  };

  if (
    new Set(Object.values(fieldMapping)).size !== 3
  ) {
    throw feishuConfigError();
  }

  let derivedScopeKey: string;
  try {
    derivedScopeKey = createFeishuTableScope({
      appToken,
      tableId
    }).key;
  } catch {
    throw feishuConfigError();
  }
  if (derivedScopeKey !== feishu.tableScopeKey) {
    throw feishuConfigError();
  }

  return {
    appToken,
    tableId,
    recordId,
    fieldMapping,
    tableScopeKey: feishu.tableScopeKey
  };
}

export function getFeishuConfiguration(
  configuration: ProjectConfiguration | null | undefined
): FeishuConfiguration {
  const feishu = configuration?.feishu;
  if (
    !isRecord(feishu) ||
    !hasExactKeys(feishu, [
      "enabled",
      "tableScopeKey"
    ]) ||
    feishu.enabled !== true ||
    typeof feishu.tableScopeKey !== "string" ||
    !/^feishu:table:sha256:[0-9a-f]{64}$/.test(
      feishu.tableScopeKey
    )
  ) {
    throw feishuConfigError();
  }
  return {
    enabled: true,
    tableScopeKey: feishu.tableScopeKey
  };
}

function normalizeFeishuIdentifier(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(value)
  ) {
    throw feishuConfigError();
  }
  return value;
}

function normalizeFeishuFieldName(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    [...value].length > 100
  ) {
    throw feishuConfigError();
  }
  return value;
}

function feishuConfigError(): ProjectConfigError {
  return configError(
    "FEISHU_CONFIG_INVALID",
    "Feishu configuration requires an enabled opaque table scope and bounded environment coordinates."
  );
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

function isNonEmptyTrimmedString(
  value: unknown
): value is string {
  return (
    isNonEmptyString(value) &&
    value === value.trim()
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();

  return (
    actual.length === expected.length &&
    actual.every(
      (key, index) => key === expected[index]
    )
  );
}

function isRepositoryRelativePath(
  value: unknown
): value is string {
  if (
    !isNonEmptyTrimmedString(value) ||
    value.length > 512 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }

  const segments = value.split("/");

  return (
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment.length <= 100 &&
        segment !== "." &&
        segment !== ".." &&
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(
          segment
        ) &&
        !segment.endsWith(".") &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(
          segment
        )
    ) &&
    value.endsWith(".json")
  );
}

function normalizeReference(value: string): string {
  return value.toLowerCase();
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
