import {
  applyConfigurationDraftPlan,
  applyConfigurationPlan,
  inspectConfiguration,
  previewConfigurationChange,
  previewConfigurationDraft,
  readConfigurationDraft
} from "./configuration-control.ts";
import {
  readControlRoomInstance
} from "./control-room-lock.ts";
import type {
  ConfigurationChangeInput,
  ConfigurationDraft,
  ConfigurationReceipt,
  ConfigurationView,
  EditableConfigurationScope,
  InspectConfigurationOptions
} from "./configuration-control.ts";
import type {
  ControlRoomInstance
} from "./control-room-lock.ts";

const MAXIMUM_RESPONSE_BYTES = 1024 * 1024;

export interface ConfigurationAuthority {
  readonly kind: "local" | "running-instance";
  inspect(): Promise<ConfigurationView>;
  readDraft(scope: EditableConfigurationScope): Promise<ConfigurationDraft>;
  applyChange(
    change: ConfigurationChangeInput,
    expectedRevision: string
  ): Promise<ConfigurationReceipt>;
  applyDraft(
    scope: EditableConfigurationScope,
    document: Readonly<Record<string, unknown>>,
    expectedRevision: string
  ): Promise<ConfigurationReceipt>;
}

export class ConfigurationAuthorityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConfigurationAuthorityError";
    this.code = code;
  }
}

export async function resolveConfigurationAuthority(
  context: InspectConfigurationOptions,
  options: {
    readonly fetch?: typeof fetch;
  } = {}
): Promise<ConfigurationAuthority> {
  const instance = await readControlRoomInstance({ cwd: context.cwd });
  if (instance === null) {
    return createLocalConfigurationAuthority(context);
  }
  return createRunningConfigurationAuthority(
    instance,
    options.fetch ?? globalThis.fetch
  );
}

export function createLocalConfigurationAuthority(
  context: InspectConfigurationOptions
): ConfigurationAuthority {
  const authority: ConfigurationAuthority = {
    kind: "local" as const,
    inspect: () => inspectConfiguration(context),
    readDraft: (scope: EditableConfigurationScope) =>
      readConfigurationDraft(context, scope),
    async applyChange(change, expectedRevision) {
      const plan = await previewConfigurationChange(
        context,
        change,
        expectedRevision
      );
      return applyConfigurationPlan(context, plan);
    },
    async applyDraft(scope, document, expectedRevision) {
      const plan = await previewConfigurationDraft(
        context,
        { scope, document },
        expectedRevision
      );
      return applyConfigurationDraftPlan(context, plan);
    }
  };
  return Object.freeze(authority);
}

async function createRunningConfigurationAuthority(
  instance: ControlRoomInstance,
  executeFetch: typeof fetch
): Promise<ConfigurationAuthority> {
  const baseUrl = controlRoomBaseUrl(instance);
  const envelope = await readInstanceEnvelope(
    executeFetch,
    `${baseUrl}/api/configuration`,
    instance.instanceId
  );

  const authority: ConfigurationAuthority = {
    kind: "running-instance" as const,
    async inspect() {
      return envelope.configuration;
    },
    async readDraft(scope) {
      const response = await requestJson(
        executeFetch,
        `${baseUrl}/api/configuration/drafts/${scope}`,
        { method: "GET" }
      );
      if (
        !isRecord(response) ||
        response.instanceId !== instance.instanceId ||
        !isConfigurationDraft(response.draft)
      ) {
        throw handoffUnavailable();
      }
      return response.draft;
    },
    async applyChange(change, expectedRevision) {
      return requestConfigurationReceipt(
        executeFetch,
        `${baseUrl}/api/configuration/change`,
        envelope.csrfToken,
        { expectedRevision, change }
      );
    },
    async applyDraft(scope, document, expectedRevision) {
      return requestConfigurationReceipt(
        executeFetch,
        `${baseUrl}/api/configuration/draft`,
        envelope.csrfToken,
        { expectedRevision, scope, document }
      );
    }
  };
  return Object.freeze(authority);
}

async function readInstanceEnvelope(
  executeFetch: typeof fetch,
  url: string,
  expectedInstanceId: string
): Promise<{
  readonly csrfToken: string;
  readonly configuration: ConfigurationView;
}> {
  const value = await requestJson(executeFetch, url, { method: "GET" });
  if (
    !isRecord(value) ||
    value.schemaVersion !== "control-room-configuration/v1" ||
    value.instanceId !== expectedInstanceId ||
    typeof value.csrfToken !== "string" ||
    value.csrfToken.length < 16 ||
    value.csrfToken.length > 256 ||
    !isConfigurationView(value.configuration)
  ) {
    throw handoffUnavailable();
  }
  return {
    csrfToken: value.csrfToken,
    configuration: value.configuration
  };
}

async function requestConfigurationReceipt(
  executeFetch: typeof fetch,
  url: string,
  csrfToken: string,
  body: unknown
): Promise<ConfigurationReceipt> {
  const value = await requestJson(executeFetch, url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-taskseal-csrf-token": csrfToken
    },
    body: JSON.stringify(body)
  });
  if (!isConfigurationReceipt(value)) {
    throw handoffUnavailable();
  }
  return value;
}

async function requestJson(
  executeFetch: typeof fetch,
  url: string,
  init: RequestInit
): Promise<unknown> {
  let response: Response;
  try {
    response = await executeFetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(3_000)
    });
  } catch {
    throw handoffUnavailable();
  }
  const value = await readBoundedJson(response);
  if (!response.ok) {
    const code = isRecord(value) &&
      typeof value.error === "string" &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(value.error)
      ? value.error
      : "CONTROL_ROOM_HANDOFF_UNAVAILABLE";
    throw new ConfigurationAuthorityError(
      code,
      "The running Control Room rejected the configuration request."
    );
  }
  return value;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (
    contentType === null ||
    !/^application\/json(?:\s*;|$)/i.test(contentType) ||
    response.body === null
  ) {
    throw handoffUnavailable();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAXIMUM_RESPONSE_BYTES) {
        throw handoffUnavailable();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")
    );
  } catch {
    throw handoffUnavailable();
  }
}

function controlRoomBaseUrl(instance: ControlRoomInstance): string {
  const host = instance.host === "::1" ? "[::1]" : instance.host;
  return `http://${host}:${instance.port}`;
}

function isConfigurationView(value: unknown): value is ConfigurationView {
  return isRecord(value) &&
    value.schemaVersion === "configuration-view/v1" &&
    isDigest(value.revision) &&
    Array.isArray(value.fields) &&
    Array.isArray(value.integrations) &&
    Array.isArray(value.diagnostics) &&
    typeof value.ready === "boolean";
}

function isConfigurationDraft(value: unknown): value is ConfigurationDraft {
  return isRecord(value) &&
    value.schemaVersion === "configuration-draft/v1" &&
    isDigest(value.revision) &&
    isRecord(value.document) &&
    isRecord(value.target);
}

function isConfigurationReceipt(value: unknown): value is ConfigurationReceipt {
  return isRecord(value) &&
    value.schemaVersion === "configuration-receipt/v1" &&
    isDigest(value.planDigest) &&
    isDigest(value.previousRevision) &&
    isDigest(value.revision) &&
    typeof value.applied === "boolean" &&
    typeof value.replayed === "boolean" &&
    typeof value.restartRequired === "boolean";
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function handoffUnavailable(): ConfigurationAuthorityError {
  return new ConfigurationAuthorityError(
    "CONTROL_ROOM_HANDOFF_UNAVAILABLE",
    "The running Control Room instance could not be verified."
  );
}
