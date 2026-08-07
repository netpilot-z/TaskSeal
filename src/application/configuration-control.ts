import {
  createHash,
  randomUUID
} from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  join
} from "node:path";

import {
  getFeishuConfiguration,
  getGiteeCoordinates,
  getGitHubDeliveryCoordinates,
  getGitHubCoordinates,
  getLinearAcceptanceCoordinates,
  getLinearBootstrapCoordinates,
  getLinearCoordinates,
  getLinearProjectCoordinates,
  getLinearReadyWorkCoordinates,
  parseProjectConfiguration
} from "../config/project-config.ts";
import type {
  ProjectConfiguration,
  ProjectConfigErrorCode
} from "../config/project-config.ts";
import {
  digestCanonicalJson
} from "../lib/canonical-json.ts";

export const DEFAULT_CONTROL_ROOM_PORT = 7331;

export type ConfigurationCapabilityState =
  | "ready"
  | "disabled"
  | "invalid";

export type ConfigurationScope =
  | "built-in"
  | "user"
  | "project"
  | "local"
  | "environment"
  | "command";

export type ConfigurationScalar =
  | string
  | number
  | boolean
  | null;

export type ConfigurationDiagnosticCode =
  | ProjectConfigErrorCode
  | "USER_CONFIG_INVALID"
  | "LOCAL_CONFIG_INVALID"
  | "ENVIRONMENT_CONFIG_INVALID"
  | "COMMAND_CONFIG_INVALID";

export interface ConfigurationFieldView {
  readonly key: string;
  readonly value: ConfigurationScalar;
  readonly source: ConfigurationScope;
  readonly editableScopes: readonly ConfigurationScope[];
  readonly sensitive: boolean;
  readonly restartRequired: boolean;
}

export interface ConfigurationFieldDefinitionView {
  readonly key: string;
  readonly valueType: "string" | "boolean" | "number" | "enum";
  readonly required: boolean;
  readonly editableScopes: readonly EditableConfigurationScope[];
  readonly restartRequired: boolean;
  readonly options?: readonly string[];
}

export interface ConfigurationDiagnostic {
  readonly code: ConfigurationDiagnosticCode;
  readonly field:
    | "project"
    | "github"
    | "linear"
    | "gitee"
    | "feishu"
    | "ui"
    | "runtime";
  readonly messageKey:
    | "config.project.invalid"
    | "config.github.invalid"
    | "config.linear.invalid"
    | "config.gitee.invalid"
    | "config.feishu.invalid"
    | "config.user.invalid"
    | "config.local.invalid"
    | "config.environment.invalid"
    | "config.command.invalid";
}

export interface ConfigurationSourceView {
  readonly scope: "user" | "project" | "local";
  readonly path:
    | "platform:user-config"
    | "config/project.json"
    | ".taskseal/config.local.json";
  readonly status: "loaded" | "missing" | "invalid";
  readonly revision: string | null;
}

export interface ConfigurationIntegrationView {
  readonly id: "github" | "linear" | "feishu" | "gitee";
  readonly configured: boolean;
  readonly capability: ConfigurationCapabilityState;
  readonly credential: {
    readonly requirement: "none" | "optional" | "required";
    readonly status:
      | "not-configured"
      | "not-required"
      | "present"
      | "missing"
      | "conflict";
    readonly bindings: readonly string[];
  };
  readonly setupUrl: string;
}

export interface ConfigurationView {
  readonly schemaVersion: "configuration-view/v1";
  readonly revision: string;
  readonly runtimeRevision: string;
  readonly source: {
    readonly path: "config/project.json";
    readonly status: "loaded" | "missing" | "invalid";
    readonly revision: string | null;
  };
  readonly sources: readonly ConfigurationSourceView[];
  readonly effective: ProjectConfiguration | null;
  readonly fields: readonly ConfigurationFieldView[];
  readonly definitions: readonly ConfigurationFieldDefinitionView[];
  readonly integrations: readonly ConfigurationIntegrationView[];
  readonly diagnostics: readonly ConfigurationDiagnostic[];
  readonly capabilities: {
    readonly github: ConfigurationCapabilityState;
    readonly linear: ConfigurationCapabilityState;
    readonly gitee: ConfigurationCapabilityState;
    readonly feishu: ConfigurationCapabilityState;
  };
  readonly ready: boolean;
}

export interface ConfigurationCommandOverrides {
  readonly runtimePort?: unknown;
}

export interface InspectConfigurationOptions {
  readonly cwd: string;
  readonly userConfigurationPath?: string | null;
  readonly environment?: NodeJS.ProcessEnv;
  readonly command?: ConfigurationCommandOverrides;
}

export interface ResolveUserConfigurationPathOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
}

export type ConfigurationChangeInput =
  | {
      readonly operation: "set";
      readonly key: string;
      readonly value: unknown;
    }
  | {
      readonly operation: "unset";
      readonly key: string;
    };

export type ConfigurationChange =
  | {
      readonly operation: "set";
      readonly key: string;
      readonly value: ConfigurationScalar;
    }
  | {
      readonly operation: "unset";
      readonly key: string;
    };

export interface ConfigurationValueState {
  readonly present: boolean;
  readonly value: ConfigurationScalar;
}

export interface ConfigurationPlan {
  readonly schemaVersion: "configuration-plan/v1";
  readonly expectedRevision: string;
  readonly planDigest: string;
  readonly target: {
    readonly scope: "user" | "project" | "local";
    readonly path:
      | "platform:user-config"
      | "config/project.json"
      | ".taskseal/config.local.json";
    readonly revision: string | null;
    readonly desiredRevision: string;
  };
  readonly change: ConfigurationChange;
  readonly before: ConfigurationValueState;
  readonly after: ConfigurationValueState;
  readonly restartRequired: boolean;
}

export interface ConfigurationReceipt {
  readonly schemaVersion: "configuration-receipt/v1";
  readonly planDigest: string;
  readonly previousRevision: string;
  readonly revision: string;
  readonly applied: boolean;
  readonly replayed: boolean;
  readonly restartRequired: boolean;
}

export type EditableConfigurationScope =
  | "user"
  | "project"
  | "local";

export interface ConfigurationDraft {
  readonly schemaVersion: "configuration-draft/v1";
  readonly revision: string;
  readonly target: {
    readonly scope: EditableConfigurationScope;
    readonly path: ConfigurationPlan["target"]["path"];
    readonly revision: string | null;
  };
  readonly document: Readonly<Record<string, unknown>>;
}

export interface ConfigurationDraftPlan {
  readonly schemaVersion: "configuration-draft-plan/v1";
  readonly expectedRevision: string;
  readonly planDigest: string;
  readonly target: {
    readonly scope: EditableConfigurationScope;
    readonly path: ConfigurationPlan["target"]["path"];
    readonly revision: string | null;
    readonly desiredRevision: string;
  };
  readonly document: Readonly<Record<string, unknown>>;
  readonly restartRequired: boolean;
}

export type ConfigurationControlErrorCode =
  | "CONFIG_REVISION_CONFLICT"
  | "CONFIG_PLAN_INVALID"
  | "CONFIG_FIELD_NOT_EDITABLE"
  | "CONFIG_VALUE_INVALID"
  | "CONFIG_SOURCE_UNAVAILABLE"
  | "CONFIG_WRITE_LOCKED"
  | "CONFIG_WRITE_FAILED";

export class ConfigurationControlError extends Error {
  readonly code: ConfigurationControlErrorCode;

  constructor(
    code: ConfigurationControlErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ConfigurationControlError";
    this.code = code;
  }
}

interface UserConfiguration {
  readonly ui?: {
    readonly locale: "auto" | "en" | "zh-CN";
  };
}

interface LocalConfiguration {
  readonly runtime?: {
    readonly port: number;
  };
}

interface LoadedSource<Value> {
  readonly view: ConfigurationSourceView;
  readonly value: Value | null;
}

interface FieldDefinition {
  readonly key: string;
  readonly path: readonly string[];
  readonly type: "string" | "boolean";
  readonly required?: boolean;
}

const FIELD_DEFINITIONS: readonly FieldDefinition[] = [
  { key: "project", path: ["project"], type: "string", required: true },
  { key: "mode", path: ["mode"], type: "string" },
  { key: "github.repository", path: ["github", "repository"], type: "string" },
  { key: "github.delivery.enabled", path: ["github", "delivery", "enabled"], type: "boolean" },
  { key: "github.delivery.mappingIndex", path: ["github", "delivery", "mappingIndex"], type: "string" },
  { key: "gitee.repository", path: ["gitee", "repository"], type: "string" },
  { key: "feishu.enabled", path: ["feishu", "enabled"], type: "boolean" },
  { key: "feishu.tableScopeKey", path: ["feishu", "tableScopeKey"], type: "string" },
  { key: "linear.workspace", path: ["linear", "workspace"], type: "string" },
  { key: "linear.team", path: ["linear", "team"], type: "string" },
  { key: "linear.project", path: ["linear", "project"], type: "string" },
  { key: "linear.backlogState", path: ["linear", "backlogState"], type: "string" },
  { key: "linear.readyWork.enabled", path: ["linear", "readyWork", "enabled"], type: "boolean" },
  { key: "linear.readyWork.readyState", path: ["linear", "readyWork", "readyState"], type: "string" },
  { key: "linear.readyWork.completedState", path: ["linear", "readyWork", "completedState"], type: "string" },
  { key: "linear.readyWork.dependencyIndex", path: ["linear", "readyWork", "dependencyIndex"], type: "string" },
  { key: "linear.acceptance.enabled", path: ["linear", "acceptance", "enabled"], type: "boolean" },
  { key: "linear.acceptance.expectedState", path: ["linear", "acceptance", "expectedState"], type: "string" },
  { key: "linear.acceptance.targetState", path: ["linear", "acceptance", "targetState"], type: "string" }
];

const CONFIGURATION_FIELD_DEFINITIONS: readonly ConfigurationFieldDefinitionView[] = [
  {
    key: "ui.locale",
    valueType: "enum",
    required: true,
    editableScopes: ["user"],
    restartRequired: false,
    options: ["auto", "en", "zh-CN"]
  },
  {
    key: "runtime.port",
    valueType: "number",
    required: true,
    editableScopes: ["local"],
    restartRequired: true
  },
  ...FIELD_DEFINITIONS.map((definition) => ({
    key: definition.key,
    valueType: definition.type,
    required: definition.required === true,
    editableScopes: ["project" as const],
    restartRequired:
      definition.key === "project" || definition.key === "mode"
  }))
];

export function resolveUserConfigurationPath({
  environment = process.env,
  platform = process.platform,
  homeDirectory = homedir()
}: ResolveUserConfigurationPathOptions = {}): string {
  if (platform === "win32") {
    const base = nonEmpty(environment.APPDATA) ??
      join(homeDirectory, "AppData", "Roaming");
    return join(base, "TaskSeal", "config.json");
  }
  if (platform === "darwin") {
    return join(
      homeDirectory,
      "Library",
      "Application Support",
      "TaskSeal",
      "config.json"
    );
  }
  const base = nonEmpty(environment.XDG_CONFIG_HOME) ??
    join(homeDirectory, ".config");
  return join(base, "taskseal", "config.json");
}

export async function inspectConfiguration({
  cwd,
  userConfigurationPath = null,
  environment = process.env,
  command = {}
}: InspectConfigurationOptions): Promise<ConfigurationView> {
  const [userSource, projectSource, localSource] = await Promise.all([
    loadSource(
      userConfigurationPath,
      "user",
      "platform:user-config",
      parseUserConfiguration
    ),
    loadSource(
      join(cwd, "config", "project.json"),
      "project",
      "config/project.json",
      parseProjectConfiguration
    ),
    loadSource(
      join(cwd, ".taskseal", "config.local.json"),
      "local",
      ".taskseal/config.local.json",
      parseLocalConfiguration
    )
  ]);
  const sourceDiagnostics = collectSourceDiagnostics(
    userSource,
    projectSource,
    localSource,
    environment,
    command
  );
  const settings = settingsFields(
    userSource.value,
    localSource.value,
    environment,
    command
  );
  const sources = [
    userSource.view,
    projectSource.view,
    localSource.view
  ];
  const revision = configurationRevision(sources, settings);
  const runtimeRevision = configurationRuntimeRevision(settings);
  const projectSourceView = projectSource.view;

  if (projectSource.value === null) {
    return {
      schemaVersion: "configuration-view/v1",
      revision,
      runtimeRevision,
      source: {
        path: "config/project.json",
        status: projectSourceView.status,
        revision: projectSourceView.revision
      },
      sources,
      effective: null,
      fields: settings,
      definitions: CONFIGURATION_FIELD_DEFINITIONS,
      integrations: configurationIntegrations(
        null,
        invalidCapabilities(),
        environment
      ),
      diagnostics: sourceDiagnostics,
      capabilities: invalidCapabilities(),
      ready: false
    };
  }

  const configuration = projectSource.value;
  const inspections = [
    inspectCapability("github", configuration.github, "GITHUB_CONFIG_INVALID", "config.github.invalid", () => inspectGitHub(configuration)),
    inspectCapability("linear", configuration.linear, "LINEAR_CONFIG_INVALID", "config.linear.invalid", () => inspectLinear(configuration)),
    inspectCapability("gitee", configuration.gitee, "GITEE_CONFIG_INVALID", "config.gitee.invalid", () => getGiteeCoordinates(configuration)),
    inspectCapability("feishu", configuration.feishu, "FEISHU_CONFIG_INVALID", "config.feishu.invalid", () => getFeishuConfiguration(configuration))
  ] as const;
  const capabilities = {
    github: inspections[0].state,
    linear: inspections[1].state,
    gitee: inspections[2].state,
    feishu: inspections[3].state
  };
  const diagnostics = [
    ...sourceDiagnostics,
    ...inspections.flatMap((inspection) =>
      inspection.diagnostic === null ? [] : [inspection.diagnostic]
    )
  ];
  const ready = diagnostics.length === 0;

  return {
    schemaVersion: "configuration-view/v1",
    revision,
    runtimeRevision: configurationRuntimeRevision([
      ...projectFields(configuration),
      ...settings
    ]),
    source: {
      path: "config/project.json",
      status: projectSourceView.status,
      revision: projectSourceView.revision
    },
    sources,
    effective: ready ? configuration : null,
    fields: [
      ...projectFields(configuration),
      ...settings
    ],
    definitions: CONFIGURATION_FIELD_DEFINITIONS,
    integrations: configurationIntegrations(
      configuration,
      capabilities,
      environment
    ),
    diagnostics,
    capabilities,
    ready
  };
}

interface ChangeTarget {
  readonly scope: "user" | "project" | "local";
  readonly publicPath: ConfigurationPlan["target"]["path"];
  readonly filePath: string;
  readonly path: readonly string[];
  readonly restartRequired: boolean;
  readonly defaultMode: number;
  readonly definition?: FieldDefinition;
}

interface PreparedConfigurationPlan {
  readonly plan: ConfigurationPlan;
  readonly content: string;
  readonly target: ChangeTarget;
}

interface PreparedConfigurationDraftPlan {
  readonly plan: ConfigurationDraftPlan;
  readonly content: string;
  readonly target: ChangeTarget;
}

export async function readConfigurationDraft(
  context: InspectConfigurationOptions,
  scope: EditableConfigurationScope
): Promise<ConfigurationDraft> {
  const view = await inspectConfiguration(context);
  const target = resolveDraftTarget(context, scope);
  const document = await readTargetDocument(target);
  validateTargetDocument(document, target.scope);
  const source = view.sources.find(
    (candidate) => candidate.scope === target.scope
  );

  return {
    schemaVersion: "configuration-draft/v1",
    revision: view.revision,
    target: {
      scope: target.scope,
      path: target.publicPath,
      revision: source?.revision ?? null
    },
    document: cloneRecord(document)
  };
}

export async function previewConfigurationDraft(
  context: InspectConfigurationOptions,
  input: {
    readonly scope: EditableConfigurationScope;
    readonly document: Readonly<Record<string, unknown>>;
  },
  expectedRevision: string
): Promise<ConfigurationDraftPlan> {
  return (
    await prepareConfigurationDraft(
      context,
      input,
      expectedRevision
    )
  ).plan;
}

export async function applyConfigurationDraftPlan(
  context: InspectConfigurationOptions,
  plan: ConfigurationDraftPlan
): Promise<ConfigurationReceipt> {
  assertConfigurationDraftPlan(plan);
  const target = resolveDraftTarget(context, plan.target.scope);
  if (target.publicPath !== plan.target.path) {
    throw configurationError(
      "CONFIG_PLAN_INVALID",
      "Configuration draft plan target is invalid."
    );
  }

  return withConfigurationWriteLock(context.cwd, target, async () => {
    await assertWritableTarget(target.filePath);
    const currentTargetRevision = await readFileRevision(target.filePath);
    const currentView = await inspectConfiguration(context);

    if (currentTargetRevision === plan.target.desiredRevision) {
      const document = await readTargetDocument(target);
      validateTargetDocument(document, target.scope);
      if (
        digestCanonicalJson(document) !==
        digestCanonicalJson(plan.document)
      ) {
        throw configurationError(
          "CONFIG_PLAN_INVALID",
          "Configuration draft replay does not match the committed document."
        );
      }
      return {
        schemaVersion: "configuration-receipt/v1",
        planDigest: plan.planDigest,
        previousRevision: plan.expectedRevision,
        revision: currentView.revision,
        applied: false,
        replayed: true,
        restartRequired: plan.restartRequired
      };
    }

    if (currentView.revision !== plan.expectedRevision) {
      throw configurationError(
        "CONFIG_REVISION_CONFLICT",
        "Configuration changed after the draft was prepared."
      );
    }

    const prepared = await prepareConfigurationDraft(
      context,
      {
        scope: plan.target.scope,
        document: plan.document
      },
      plan.expectedRevision
    );
    if (prepared.plan.planDigest !== plan.planDigest) {
      throw configurationError(
        "CONFIG_PLAN_INVALID",
        "Configuration draft plan does not match the requested document."
      );
    }
    if (
      (await readFileRevision(prepared.target.filePath)) !==
      prepared.plan.target.revision
    ) {
      throw configurationError(
        "CONFIG_REVISION_CONFLICT",
        "Configuration changed before the draft could be committed."
      );
    }

    await atomicReplaceConfiguration(prepared.target, prepared.content);
    const committedRevision = await readFileRevision(prepared.target.filePath);
    if (committedRevision !== plan.target.desiredRevision) {
      throw configurationError(
        "CONFIG_WRITE_FAILED",
        "Configuration draft commit could not be confirmed."
      );
    }
    const nextView = await inspectConfiguration(context);
    return {
      schemaVersion: "configuration-receipt/v1",
      planDigest: plan.planDigest,
      previousRevision: plan.expectedRevision,
      revision: nextView.revision,
      applied: true,
      replayed: false,
      restartRequired: plan.restartRequired
    };
  });
}

export async function previewConfigurationChange(
  context: InspectConfigurationOptions,
  change: ConfigurationChangeInput,
  expectedRevision: string
): Promise<ConfigurationPlan> {
  return (
    await prepareConfigurationChange(
      context,
      change,
      expectedRevision
    )
  ).plan;
}

export async function applyConfigurationPlan(
  context: InspectConfigurationOptions,
  plan: ConfigurationPlan
): Promise<ConfigurationReceipt> {
  assertConfigurationPlan(plan);
  const target = resolveChangeTarget(context, plan.change.key);
  if (
    target.scope !== plan.target.scope ||
    target.publicPath !== plan.target.path
  ) {
    throw configurationError(
      "CONFIG_PLAN_INVALID",
      "Configuration plan target is invalid."
    );
  }

  return withConfigurationWriteLock(context.cwd, target, async () => {
    await assertWritableTarget(target.filePath);
    const currentTargetRevision =
      await readFileRevision(target.filePath);
    const currentView = await inspectConfiguration(context);

    if (currentTargetRevision === plan.target.desiredRevision) {
      const normalizedChange = normalizeConfigurationChange(
        plan.change,
        target
      );
      if (
        digestCanonicalJson(normalizedChange) !==
        digestCanonicalJson(plan.change)
      ) {
        throw configurationError(
          "CONFIG_PLAN_INVALID",
          "Configuration plan change is invalid."
        );
      }
      const document = await readTargetDocument(target);
      validateTargetDocument(document, target.scope);
      const currentState = readAfterState(
        document,
        target,
        context.environment ?? process.env,
        context.command ?? {}
      );
      if (
        digestCanonicalJson(currentState) !==
        digestCanonicalJson(plan.after)
      ) {
        throw configurationError(
          "CONFIG_PLAN_INVALID",
          "Configuration replay does not match the committed value."
        );
      }
      return {
        schemaVersion: "configuration-receipt/v1",
        planDigest: plan.planDigest,
        previousRevision: plan.expectedRevision,
        revision: currentView.revision,
        applied: false,
        replayed: true,
        restartRequired: plan.restartRequired
      };
    }

    if (currentView.revision !== plan.expectedRevision) {
      throw configurationError(
        "CONFIG_REVISION_CONFLICT",
        "Configuration changed after the plan was prepared."
      );
    }

    const prepared = await prepareConfigurationChange(
      context,
      plan.change,
      plan.expectedRevision
    );
    if (prepared.plan.planDigest !== plan.planDigest) {
      throw configurationError(
        "CONFIG_PLAN_INVALID",
        "Configuration plan does not match the requested change."
      );
    }
    if (
      (await readFileRevision(prepared.target.filePath)) !==
      prepared.plan.target.revision
    ) {
      throw configurationError(
        "CONFIG_REVISION_CONFLICT",
        "Configuration changed before it could be committed."
      );
    }

    await atomicReplaceConfiguration(
      prepared.target,
      prepared.content
    );
    const committedRevision =
      await readFileRevision(prepared.target.filePath);
    if (committedRevision !== plan.target.desiredRevision) {
      throw configurationError(
        "CONFIG_WRITE_FAILED",
        "Configuration commit could not be confirmed."
      );
    }
    const nextView = await inspectConfiguration(context);

    return {
      schemaVersion: "configuration-receipt/v1",
      planDigest: plan.planDigest,
      previousRevision: plan.expectedRevision,
      revision: nextView.revision,
      applied: true,
      replayed: false,
      restartRequired: plan.restartRequired
    };
  });
}

async function prepareConfigurationChange(
  context: InspectConfigurationOptions,
  input: ConfigurationChangeInput,
  expectedRevision: string
): Promise<PreparedConfigurationPlan> {
  if (!isDigest(expectedRevision)) {
    throw configurationError(
      "CONFIG_REVISION_CONFLICT",
      "Configuration revision is invalid."
    );
  }
  const view = await inspectConfiguration(context);
  if (view.revision !== expectedRevision) {
    throw configurationError(
      "CONFIG_REVISION_CONFLICT",
      "Configuration changed after it was inspected."
    );
  }

  const target = resolveChangeTarget(context, input.key);
  const change = normalizeConfigurationChange(input, target);
  const document = await readTargetDocument(target);
  const nextDocument = cloneRecord(document);
  applyChange(nextDocument, change, target);
  validateTargetDocument(nextDocument, target.scope);
  const content = `${JSON.stringify(nextDocument, null, 2)}\n`;
  const before = readEffectiveState(view, change.key);
  const after = readAfterState(
    nextDocument,
    target,
    context.environment ?? process.env,
    context.command ?? {}
  );
  const source = view.sources.find(
    (candidate) => candidate.scope === target.scope
  );
  const planWithoutDigest = {
    schemaVersion: "configuration-plan/v1" as const,
    expectedRevision,
    target: {
      scope: target.scope,
      path: target.publicPath,
      revision: source?.revision ?? null,
      desiredRevision: digest(content)
    },
    change,
    before,
    after,
    restartRequired:
      target.scope === "project"
        ? projectDraftRequiresRestart(document, view)
        : target.restartRequired
  };
  const plan: ConfigurationPlan = {
    ...planWithoutDigest,
    planDigest: digestCanonicalJson(planWithoutDigest)
  };

  return { plan, content, target };
}

async function prepareConfigurationDraft(
  context: InspectConfigurationOptions,
  input: {
    readonly scope: EditableConfigurationScope;
    readonly document: Readonly<Record<string, unknown>>;
  },
  expectedRevision: string
): Promise<PreparedConfigurationDraftPlan> {
  if (!isDigest(expectedRevision)) {
    throw configurationError(
      "CONFIG_REVISION_CONFLICT",
      "Configuration revision is invalid."
    );
  }
  const view = await inspectConfiguration(context);
  if (view.revision !== expectedRevision) {
    throw configurationError(
      "CONFIG_REVISION_CONFLICT",
      "Configuration changed after it was inspected."
    );
  }

  const target = resolveDraftTarget(context, input.scope);
  let document: Record<string, unknown>;
  try {
    digestCanonicalJson(input.document);
    document = cloneRecord(input.document as Record<string, unknown>);
  } catch {
    throw invalidConfigurationValue();
  }
  validateTargetDocument(document, target.scope);
  const content = `${JSON.stringify(document, null, 2)}\n`;
  const source = view.sources.find(
    (candidate) => candidate.scope === target.scope
  );
  const planWithoutDigest = {
    schemaVersion: "configuration-draft-plan/v1" as const,
    expectedRevision,
    target: {
      scope: target.scope,
      path: target.publicPath,
      revision: source?.revision ?? null,
      desiredRevision: digest(content)
    },
    document,
    restartRequired:
      target.scope === "project"
        ? projectDraftRequiresRestart(document, view)
        : target.restartRequired
  };
  const plan: ConfigurationDraftPlan = {
    ...planWithoutDigest,
    planDigest: digestCanonicalJson(planWithoutDigest)
  };

  return { plan, content, target };
}

function resolveDraftTarget(
  context: InspectConfigurationOptions,
  scope: EditableConfigurationScope
): ChangeTarget {
  if (scope === "user") {
    if (
      typeof context.userConfigurationPath !== "string" ||
      context.userConfigurationPath.length === 0
    ) {
      throw configurationError(
        "CONFIG_SOURCE_UNAVAILABLE",
        "User configuration is not available in this context."
      );
    }
    return {
      scope,
      publicPath: "platform:user-config",
      filePath: context.userConfigurationPath,
      path: [],
      restartRequired: false,
      defaultMode: 0o600
    };
  }
  if (scope === "local") {
    return {
      scope,
      publicPath: ".taskseal/config.local.json",
      filePath: join(context.cwd, ".taskseal", "config.local.json"),
      path: [],
      restartRequired: true,
      defaultMode: 0o600
    };
  }
  return {
    scope,
    publicPath: "config/project.json",
    filePath: join(context.cwd, "config", "project.json"),
    path: [],
    restartRequired: true,
    defaultMode: 0o644
  };
}

function projectDraftRequiresRestart(
  document: Readonly<Record<string, unknown>>,
  view: ConfigurationView
): boolean {
  const current = view.effective;
  if (current === null) {
    return true;
  }
  return current.project !== document.project || current.mode !== document.mode;
}

function resolveChangeTarget(
  context: InspectConfigurationOptions,
  key: string
): ChangeTarget {
  if (key === "ui.locale") {
    if (
      typeof context.userConfigurationPath !== "string" ||
      context.userConfigurationPath.length === 0
    ) {
      throw configurationError(
        "CONFIG_SOURCE_UNAVAILABLE",
        "User configuration is not available in this context."
      );
    }
    return {
      scope: "user",
      publicPath: "platform:user-config",
      filePath: context.userConfigurationPath,
      path: ["ui", "locale"],
      restartRequired: false,
      defaultMode: 0o600
    };
  }
  if (key === "runtime.port") {
    return {
      scope: "local",
      publicPath: ".taskseal/config.local.json",
      filePath: join(context.cwd, ".taskseal", "config.local.json"),
      path: ["runtime", "port"],
      restartRequired: true,
      defaultMode: 0o600
    };
  }

  const definition = FIELD_DEFINITIONS.find(
    (candidate) => candidate.key === key
  );
  if (definition === undefined) {
    throw configurationError(
      "CONFIG_FIELD_NOT_EDITABLE",
      "Configuration field is not editable."
    );
  }
  return {
    scope: "project",
    publicPath: "config/project.json",
    filePath: join(context.cwd, "config", "project.json"),
    path: definition.path,
    restartRequired:
      definition.key === "project" || definition.key === "mode",
    defaultMode: 0o644,
    definition
  };
}

function normalizeConfigurationChange(
  input: ConfigurationChangeInput,
  target: ChangeTarget
): ConfigurationChange {
  if (input.operation === "unset") {
    if (target.definition?.required === true) {
      throw configurationError(
        "CONFIG_VALUE_INVALID",
        "Required configuration fields cannot be removed."
      );
    }
    return { operation: "unset", key: input.key };
  }

  let value: ConfigurationScalar;
  if (input.key === "ui.locale") {
    if (
      input.value !== "auto" &&
      input.value !== "en" &&
      input.value !== "zh-CN"
    ) {
      throw invalidConfigurationValue();
    }
    value = input.value;
  } else if (input.key === "runtime.port") {
    if (
      typeof input.value !== "number" ||
      parsePort(input.value) === null
    ) {
      throw invalidConfigurationValue();
    }
    value = input.value;
  } else if (target.definition?.type === "boolean") {
    if (typeof input.value !== "boolean") {
      throw invalidConfigurationValue();
    }
    value = input.value;
  } else {
    if (
      typeof input.value !== "string" ||
      input.value.trim() === "" ||
      input.value !== input.value.trim()
    ) {
      throw invalidConfigurationValue();
    }
    value = input.value;
  }
  return {
    operation: "set",
    key: input.key,
    value
  };
}

function applyChange(
  document: Record<string, unknown>,
  change: ConfigurationChange,
  target: ChangeTarget
): void {
  if (change.operation === "set") {
    if (
      change.key === "linear.acceptance.enabled" &&
      change.value === false
    ) {
      document.linear = isRecord(document.linear)
        ? { ...document.linear, acceptance: { enabled: false } }
        : { acceptance: { enabled: false } };
      return;
    }
    setNestedValue(document, target.path, change.value);
    return;
  }
  deleteNestedValue(document, target.path);
}

function validateTargetDocument(
  document: Record<string, unknown>,
  scope: ChangeTarget["scope"]
): void {
  try {
    if (scope === "user") {
      parseUserConfiguration(document);
      return;
    }
    if (scope === "local") {
      parseLocalConfiguration(document);
      return;
    }
    const configuration = parseProjectConfiguration(document);
    if (configuration.github !== undefined) {
      inspectGitHub(configuration);
    }
    if (configuration.linear !== undefined) {
      inspectLinear(configuration);
    }
    if (configuration.gitee !== undefined) {
      getGiteeCoordinates(configuration);
    }
    if (configuration.feishu !== undefined) {
      getFeishuConfiguration(configuration);
    }
  } catch {
    throw invalidConfigurationValue();
  }
}

async function readTargetDocument(
  target: ChangeTarget
): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(
      await readFile(target.filePath, "utf8")
    );
    if (!isRecord(value)) {
      throw new TypeError("Configuration source must be an object.");
    }
    return { ...value };
  } catch (error) {
    if (
      target.scope !== "project" &&
      isFileMissing(error)
    ) {
      return {};
    }
    throw configurationError(
      "CONFIG_SOURCE_UNAVAILABLE",
      "Configuration source could not be read."
    );
  }
}

function cloneRecord(
  value: Record<string, unknown>
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function readEffectiveState(
  view: ConfigurationView,
  key: string
): ConfigurationValueState {
  const field = view.fields.find((candidate) => candidate.key === key);
  return field === undefined
    ? { present: false, value: null }
    : { present: true, value: field.value };
}

function readAfterState(
  document: Record<string, unknown>,
  target: ChangeTarget,
  environment: NodeJS.ProcessEnv,
  command: ConfigurationCommandOverrides
): ConfigurationValueState {
  if (target.scope === "user") {
    const user = parseUserConfiguration(document);
    return {
      present: true,
      value: user.ui?.locale ?? "auto"
    };
  }
  if (target.scope === "local") {
    const local = parseLocalConfiguration(document);
    return {
      present: true,
      value:
        parsePort(command.runtimePort) ??
        parsePort(environment.PORT) ??
        local.runtime?.port ??
        DEFAULT_CONTROL_ROOM_PORT
    };
  }
  const value = readScalar(document, target.path);
  return value === undefined
    ? { present: false, value: null }
    : { present: true, value };
}

function setNestedValue(
  document: Record<string, unknown>,
  path: readonly string[],
  value: ConfigurationScalar
): void {
  let current = document;
  for (const segment of path.slice(0, -1)) {
    const nested = current[segment];
    if (!isRecord(nested)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[path.at(-1)!] = value;
}

function deleteNestedValue(
  document: Record<string, unknown>,
  path: readonly string[]
): void {
  const parents: Array<{
    readonly parent: Record<string, unknown>;
    readonly key: string;
  }> = [];
  let current = document;
  for (const segment of path.slice(0, -1)) {
    const nested = current[segment];
    if (!isRecord(nested)) {
      return;
    }
    parents.push({ parent: current, key: segment });
    current = nested as Record<string, unknown>;
  }
  delete current[path.at(-1)!];
  for (const { parent, key } of parents.reverse()) {
    const nested = parent[key];
    if (isRecord(nested) && Object.keys(nested).length === 0) {
      delete parent[key];
    }
  }
}

function assertConfigurationPlan(plan: ConfigurationPlan): void {
  try {
    if (
      !hasExactKeys(plan as unknown as Readonly<Record<string, unknown>>, [
        "schemaVersion",
        "expectedRevision",
        "planDigest",
        "target",
        "change",
        "before",
        "after",
        "restartRequired"
      ]) ||
      plan.schemaVersion !== "configuration-plan/v1" ||
      !isDigest(plan.expectedRevision) ||
      !isDigest(plan.planDigest) ||
      plan.planDigest !== configurationPlanDigest(plan)
    ) {
      throw new TypeError("Invalid configuration plan.");
    }
  } catch {
    throw configurationError(
      "CONFIG_PLAN_INVALID",
      "Configuration plan is invalid."
    );
  }
}

function assertConfigurationDraftPlan(
  plan: ConfigurationDraftPlan
): void {
  try {
    const value = plan as unknown as Readonly<Record<string, unknown>>;
    const target = value.target;
    if (
      !hasExactKeys(value, [
        "schemaVersion",
        "expectedRevision",
        "planDigest",
        "target",
        "document",
        "restartRequired"
      ]) ||
      plan.schemaVersion !== "configuration-draft-plan/v1" ||
      !isDigest(plan.expectedRevision) ||
      !isDigest(plan.planDigest) ||
      !isRecord(target) ||
      !hasExactKeys(target, [
        "scope",
        "path",
        "revision",
        "desiredRevision"
      ]) ||
      !["user", "project", "local"].includes(String(target.scope)) ||
      typeof target.path !== "string" ||
      (target.revision !== null && !isDigest(target.revision)) ||
      !isDigest(target.desiredRevision) ||
      !isRecord(plan.document) ||
      typeof plan.restartRequired !== "boolean" ||
      plan.planDigest !== configurationDraftPlanDigest(plan)
    ) {
      throw new TypeError("Invalid configuration draft plan.");
    }
  } catch {
    throw configurationError(
      "CONFIG_PLAN_INVALID",
      "Configuration draft plan is invalid."
    );
  }
}

function configurationPlanDigest(plan: ConfigurationPlan): string {
  return digestCanonicalJson({
    schemaVersion: plan.schemaVersion,
    expectedRevision: plan.expectedRevision,
    target: plan.target,
    change: plan.change,
    before: plan.before,
    after: plan.after,
    restartRequired: plan.restartRequired
  });
}

function configurationDraftPlanDigest(
  plan: ConfigurationDraftPlan
): string {
  return digestCanonicalJson({
    schemaVersion: plan.schemaVersion,
    expectedRevision: plan.expectedRevision,
    target: plan.target,
    document: plan.document,
    restartRequired: plan.restartRequired
  });
}

async function withConfigurationWriteLock<Value>(
  cwd: string,
  target: ChangeTarget,
  execute: () => Promise<Value>
): Promise<Value> {
  const workspaceLock = join(
    cwd,
    ".taskseal",
    "config-write.lock"
  );
  return withFileLock(
    workspaceLock,
    target.scope === "user"
      ? () => withFileLock(`${target.filePath}.lock`, execute)
      : execute
  );
}

async function withFileLock<Value>(
  lockPath: string,
  execute: () => Promise<Value>
): Promise<Value> {
  const directory = dirname(lockPath);
  await mkdir(directory, { recursive: true });
  await assertSafeDirectory(directory);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let ownsLock = false;
  try {
    try {
      handle = await open(lockPath, "wx", 0o600);
      ownsLock = true;
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        throw configurationError(
          "CONFIG_WRITE_LOCKED",
          "Another configuration writer is active."
        );
      }
      throw error;
    }
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.sync();
    return await execute();
  } finally {
    try {
      await handle?.close();
    } catch {
      // The safe public error is determined by the configuration operation.
    }
    if (ownsLock) {
      try {
        await unlink(lockPath);
      } catch {
        // A retained lock fails later writers closed.
      }
    }
  }
}

async function atomicReplaceConfiguration(
  target: ChangeTarget,
  content: string
): Promise<void> {
  const directory = dirname(target.filePath);
  await mkdir(directory, { recursive: true });
  await assertSafeDirectory(directory);
  const temporaryPath = join(
    directory,
    `.${basename(target.filePath)}.${randomUUID()}.tmp`
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let renamed = false;

  try {
    const existing = await lstatIfPresent(target.filePath);
    if (
      existing !== null &&
      (!existing.isFile() || existing.isSymbolicLink())
    ) {
      throw new TypeError("Configuration target is not a regular file.");
    }
    const mode = existing === null
      ? target.defaultMode
      : Number(existing.mode) & 0o777;
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, target.filePath);
    renamed = true;
  } catch (error) {
    if (error instanceof ConfigurationControlError) {
      throw error;
    }
    throw configurationError(
      "CONFIG_WRITE_FAILED",
      "Configuration could not be persisted."
    );
  } finally {
    try {
      await handle?.close();
    } catch {
      // Best-effort cleanup follows.
    }
    if (!renamed) {
      try {
        await unlink(temporaryPath);
      } catch {
        // The original target remains authoritative.
      }
    }
  }
}

async function readFileRevision(
  filePath: string
): Promise<string | null> {
  try {
    return digest(await readFile(filePath, "utf8"));
  } catch (error) {
    if (isFileMissing(error)) {
      return null;
    }
    throw configurationError(
      "CONFIG_SOURCE_UNAVAILABLE",
      "Configuration source could not be inspected."
    );
  }
}

async function lstatIfPresent(
  filePath: string
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (isFileMissing(error)) {
      return null;
    }
    throw error;
  }
}

async function assertWritableTarget(filePath: string): Promise<void> {
  const target = await lstatIfPresent(filePath);
  if (
    target !== null &&
    (!target.isFile() || target.isSymbolicLink())
  ) {
    throw configurationError(
      "CONFIG_SOURCE_UNAVAILABLE",
      "Configuration target is not a regular file."
    );
  }
}

async function assertSafeDirectory(directory: string): Promise<void> {
  const value = await lstat(directory);
  if (!value.isDirectory() || value.isSymbolicLink()) {
    throw configurationError(
      "CONFIG_WRITE_FAILED",
      "Configuration directory is not safe for atomic replacement."
    );
  }
}

async function loadSource<Value>(
  filePath: string | null,
  scope: ConfigurationSourceView["scope"],
  publicPath: ConfigurationSourceView["path"],
  parse: (value: unknown) => Value
): Promise<LoadedSource<Value>> {
  if (filePath === null) {
    return missingSource(scope, publicPath);
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    return isFileMissing(error)
      ? missingSource(scope, publicPath)
      : invalidSource(scope, publicPath, null);
  }

  const revision = digest(raw);
  try {
    return {
      view: { scope, path: publicPath, status: "loaded", revision },
      value: parse(JSON.parse(raw))
    };
  } catch {
    return invalidSource(scope, publicPath, revision);
  }
}

function missingSource<Value>(
  scope: ConfigurationSourceView["scope"],
  path: ConfigurationSourceView["path"]
): LoadedSource<Value> {
  return {
    view: { scope, path, status: "missing", revision: null },
    value: null
  };
}

function invalidSource<Value>(
  scope: ConfigurationSourceView["scope"],
  path: ConfigurationSourceView["path"],
  revision: string | null
): LoadedSource<Value> {
  return {
    view: { scope, path, status: "invalid", revision },
    value: null
  };
}

function collectSourceDiagnostics(
  user: LoadedSource<UserConfiguration>,
  project: LoadedSource<ProjectConfiguration>,
  local: LoadedSource<LocalConfiguration>,
  environment: NodeJS.ProcessEnv,
  command: ConfigurationCommandOverrides
): ConfigurationDiagnostic[] {
  const diagnostics: ConfigurationDiagnostic[] = [];
  if (user.view.status === "invalid") {
    diagnostics.push({
      code: "USER_CONFIG_INVALID",
      field: "ui",
      messageKey: "config.user.invalid"
    });
  }
  if (project.view.status !== "loaded") {
    diagnostics.push({
      code: "PROJECT_CONFIG_INVALID",
      field: "project",
      messageKey: "config.project.invalid"
    });
  }
  if (local.view.status === "invalid") {
    diagnostics.push({
      code: "LOCAL_CONFIG_INVALID",
      field: "runtime",
      messageKey: "config.local.invalid"
    });
  }
  if (environment.PORT !== undefined && parsePort(environment.PORT) === null) {
    diagnostics.push({
      code: "ENVIRONMENT_CONFIG_INVALID",
      field: "runtime",
      messageKey: "config.environment.invalid"
    });
  }
  if (command.runtimePort !== undefined && parsePort(command.runtimePort) === null) {
    diagnostics.push({
      code: "COMMAND_CONFIG_INVALID",
      field: "runtime",
      messageKey: "config.command.invalid"
    });
  }
  return diagnostics;
}

function settingsFields(
  user: UserConfiguration | null,
  local: LocalConfiguration | null,
  environment: NodeJS.ProcessEnv,
  command: ConfigurationCommandOverrides
): ConfigurationFieldView[] {
  const environmentPort = parsePort(environment.PORT);
  const commandPort = parsePort(command.runtimePort);
  const port = commandPort ??
    environmentPort ??
    local?.runtime?.port ??
    DEFAULT_CONTROL_ROOM_PORT;
  const portSource: ConfigurationScope =
    commandPort !== null
      ? "command"
      : environmentPort !== null
        ? "environment"
        : local?.runtime?.port !== undefined
          ? "local"
          : "built-in";
  const locale = user?.ui?.locale ?? "auto";

  return [
    {
      key: "ui.locale",
      value: locale,
      source: user?.ui === undefined ? "built-in" : "user",
      editableScopes: ["user"],
      sensitive: false,
      restartRequired: false
    },
    {
      key: "runtime.port",
      value: port,
      source: portSource,
      editableScopes: ["local"],
      sensitive: false,
      restartRequired: true
    }
  ];
}

function parseUserConfiguration(value: unknown): UserConfiguration {
  if (!isRecord(value) || !hasOnlyKeys(value, ["ui"])) {
    throw new TypeError("Invalid user configuration.");
  }
  if (value.ui === undefined) {
    return {};
  }
  if (
    !isRecord(value.ui) ||
    !hasOnlyKeys(value.ui, ["locale"]) ||
    !["auto", "en", "zh-CN"].includes(String(value.ui.locale))
  ) {
    throw new TypeError("Invalid user configuration.");
  }
  return {
    ui: {
      locale: value.ui.locale as "auto" | "en" | "zh-CN"
    }
  };
}

function parseLocalConfiguration(value: unknown): LocalConfiguration {
  if (!isRecord(value) || !hasOnlyKeys(value, ["runtime"])) {
    throw new TypeError("Invalid local configuration.");
  }
  if (value.runtime === undefined) {
    return {};
  }
  if (
    !isRecord(value.runtime) ||
    !hasOnlyKeys(value.runtime, ["port"]) ||
    typeof value.runtime.port !== "number" ||
    parsePort(value.runtime.port) === null
  ) {
    throw new TypeError("Invalid local configuration.");
  }
  return {
    runtime: { port: value.runtime.port }
  };
}

function parsePort(value: unknown): number | null {
  const parsed =
    typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : value;
  return typeof parsed === "number" &&
    Number.isInteger(parsed) &&
    parsed >= 0 &&
    parsed <= 65_535
    ? parsed
    : null;
}

function inspectCapability(
  field: "github" | "linear" | "gitee" | "feishu",
  configured: Readonly<Record<string, unknown>> | undefined,
  code: ProjectConfigErrorCode,
  messageKey:
    | "config.github.invalid"
    | "config.linear.invalid"
    | "config.gitee.invalid"
    | "config.feishu.invalid",
  inspect: () => unknown
): {
  readonly state: ConfigurationCapabilityState;
  readonly diagnostic: ConfigurationDiagnostic | null;
} {
  if (configured === undefined) {
    return { state: "disabled", diagnostic: null };
  }
  try {
    inspect();
    return { state: "ready", diagnostic: null };
  } catch {
    return { state: "invalid", diagnostic: { code, field, messageKey } };
  }
}

function inspectGitHub(configuration: ProjectConfiguration): void {
  assertOnlyKeys(configuration.github!, ["repository", "delivery"]);
  getGitHubCoordinates(configuration);
  if (configuration.github?.delivery !== undefined) {
    getGitHubDeliveryCoordinates(configuration);
  }
}

function inspectLinear(configuration: ProjectConfiguration): void {
  assertOnlyKeys(configuration.linear!, [
    "workspace",
    "team",
    "project",
    "backlogState",
    "readyWork",
    "acceptance"
  ]);
  getLinearCoordinates(configuration);
  if (configuration.linear?.project !== undefined) {
    getLinearProjectCoordinates(configuration);
  }
  if (configuration.linear?.backlogState !== undefined) {
    getLinearBootstrapCoordinates(configuration);
  }
  if (configuration.linear?.readyWork !== undefined) {
    getLinearReadyWorkCoordinates(configuration);
  }
  if (configuration.linear?.acceptance !== undefined) {
    getLinearAcceptanceCoordinates(configuration);
  }
}

function projectFields(configuration: ProjectConfiguration): ConfigurationFieldView[] {
  return FIELD_DEFINITIONS.flatMap((definition) => {
    const value = readScalar(
      configuration as unknown as Readonly<Record<string, unknown>>,
      definition.path
    );
    return value === undefined
      ? []
      : [{
          key: definition.key,
          value,
          source: "project" as const,
          editableScopes: ["project"] as const,
          sensitive: false,
          restartRequired:
            definition.key === "project" || definition.key === "mode"
        }];
  });
}

function configurationIntegrations(
  configuration: ProjectConfiguration | null,
  capabilities: ConfigurationView["capabilities"],
  environment: NodeJS.ProcessEnv
): readonly ConfigurationIntegrationView[] {
  const githubBindings = environmentBindings(environment, [
    "GITHUB_TOKEN",
    "GH_TOKEN"
  ]);
  const linearBindings = environmentBindings(environment, [
    "LINEAR_API_KEY",
    "LINEAR_ACCESS_TOKEN"
  ]);
  const feishuBindings = environmentBindings(environment, [
    "TASKSEAL_FEISHU_APP_ID",
    "TASKSEAL_FEISHU_APP_SECRET"
  ]);
  const githubConfigured = configuration?.github !== undefined;
  const linearConfigured = configuration?.linear !== undefined;
  const feishuConfigured = configuration?.feishu !== undefined;
  const giteeConfigured = configuration?.gitee !== undefined;

  return [
    {
      id: "github",
      configured: githubConfigured,
      capability: capabilities.github,
      credential: {
        requirement: "optional",
        status: !githubConfigured
          ? "not-configured"
          : githubBindings.length > 0
            ? "present"
            : "not-required",
        bindings: githubBindings
      },
      setupUrl: "https://github.com/settings/tokens?type=beta"
    },
    {
      id: "linear",
      configured: linearConfigured,
      capability: capabilities.linear,
      credential: {
        requirement: "required",
        status: !linearConfigured
          ? "not-configured"
          : linearBindings.length > 1
            ? "conflict"
            : linearBindings.length === 1
              ? "present"
              : "missing",
        bindings: linearBindings
      },
      setupUrl: "https://linear.app/settings/api"
    },
    {
      id: "feishu",
      configured: feishuConfigured,
      capability: capabilities.feishu,
      credential: {
        requirement: "required",
        status: !feishuConfigured
          ? "not-configured"
          : feishuBindings.length === 2
            ? "present"
            : "missing",
        bindings: feishuBindings
      },
      setupUrl: "https://open.feishu.cn/app"
    },
    {
      id: "gitee",
      configured: giteeConfigured,
      capability: capabilities.gitee,
      credential: {
        requirement: "none",
        status: giteeConfigured
          ? "not-required"
          : "not-configured",
        bindings: []
      },
      setupUrl: "https://gitee.com/profile/personal_access_tokens"
    }
  ];
}

function environmentBindings(
  environment: NodeJS.ProcessEnv,
  keys: readonly string[]
): string[] {
  return keys.flatMap((key) =>
    nonEmpty(environment[key]) === null
      ? []
      : [`env:${key}`]
  );
}

function readScalar(
  source: Readonly<Record<string, unknown>>,
  path: readonly string[]
): ConfigurationScalar | undefined {
  let current: unknown = source;
  for (const segment of path) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current === null ||
    typeof current === "string" ||
    typeof current === "number" ||
    typeof current === "boolean"
    ? current
    : undefined;
}

function invalidCapabilities(): ConfigurationView["capabilities"] {
  return {
    github: "invalid",
    linear: "invalid",
    gitee: "invalid",
    feishu: "invalid"
  };
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[]
): void {
  if (!hasOnlyKeys(value, allowed)) {
    throw new TypeError("TaskSeal project configuration contains unsupported fields.");
  }
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[]
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    keys.every((key) => expected.includes(key));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function digest(raw: string): string {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

function configurationRevision(
  sources: readonly ConfigurationSourceView[],
  fields: readonly ConfigurationFieldView[]
): string {
  return digest(JSON.stringify({
    sources: sources.map(({ scope, status, revision }) => ({
      scope,
      status,
      revision
    })),
    resolved: fields.map(({ key, value, source }) => ({
      key,
      value,
      source
    }))
  }));
}

function configurationRuntimeRevision(
  fields: readonly ConfigurationFieldView[]
): string {
  return digest(JSON.stringify({
    resolved: fields
      .filter(({ restartRequired }) => restartRequired)
      .map(({ key, value }) => ({ key, value }))
  }));
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== ""
    ? value
    : null;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error &&
    "code" in error &&
    error.code === code;
}

function invalidConfigurationValue(): ConfigurationControlError {
  return configurationError(
    "CONFIG_VALUE_INVALID",
    "Configuration value is invalid for the selected field."
  );
}

function configurationError(
  code: ConfigurationControlErrorCode,
  message: string
): ConfigurationControlError {
  return new ConfigurationControlError(code, message);
}
