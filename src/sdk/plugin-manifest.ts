export const TASKSEAL_PLUGIN_API_VERSION =
  "taskseal.plugin/v1" as const;
export const TASKSEAL_RUNNER_CONTRACT_VERSION =
  "taskseal.runner/v1" as const;
export const TASKSEAL_PROVIDER_CONTRACT_VERSION =
  "taskseal.provider/v1" as const;
export const TASKSEAL_MINIMUM_NODE_VERSION =
  "24.12.0" as const;
export const TASKSEAL_SUPPORTED_NODE_MAJOR =
  24 as const;

const MANIFEST_KEYS = [
  "schemaVersion",
  "apiVersion",
  "pluginId",
  "pluginVersion",
  "pluginType",
  "contractVersion",
  "minimumNodeVersion",
  "entrypoint"
] as const;
const PLUGIN_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const SEMANTIC_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NODE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const WINDOWS_DEVICE_NAME_PATTERN =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const MAX_ENTRYPOINT_LENGTH = 256;

export type TaskSealPluginType =
  | "runner"
  | "provider";

export type TaskSealPluginContractVersion =
  | typeof TASKSEAL_RUNNER_CONTRACT_VERSION
  | typeof TASKSEAL_PROVIDER_CONTRACT_VERSION;

export interface TaskSealPluginManifestV1 {
  readonly schemaVersion: 1;
  readonly apiVersion:
    typeof TASKSEAL_PLUGIN_API_VERSION;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly pluginType:
    TaskSealPluginType;
  readonly contractVersion:
    TaskSealPluginContractVersion;
  readonly minimumNodeVersion: string;
  readonly entrypoint: string;
}

export interface ParseTaskSealPluginManifestOptions {
  readonly nodeVersion?:
    string | undefined;
}

export type PluginManifestErrorCode =
  | "PLUGIN_MANIFEST_INVALID"
  | "PLUGIN_API_UNSUPPORTED"
  | "PLUGIN_CONTRACT_UNSUPPORTED"
  | "PLUGIN_NODE_UNSUPPORTED";

export class PluginManifestError extends Error {
  readonly code:
    PluginManifestErrorCode;

  constructor(
    code: PluginManifestErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name =
      "PluginManifestError";
    this.code = code;
  }
}

export function parseTaskSealPluginManifest(
  value: unknown,
  {
    nodeVersion =
      process.versions.node
  }: ParseTaskSealPluginManifestOptions = {}
): TaskSealPluginManifestV1 {
  const manifest =
    readExactDataRecord(
      value,
      MANIFEST_KEYS
    );

  if (manifest.schemaVersion !== 1) {
    throw invalidManifest();
  }
  if (
    manifest.apiVersion !==
      TASKSEAL_PLUGIN_API_VERSION
  ) {
    throw new PluginManifestError(
      "PLUGIN_API_UNSUPPORTED",
      "The TaskSeal plugin API version is unsupported."
    );
  }
  if (
    typeof manifest.pluginId !==
      "string" ||
    !PLUGIN_ID_PATTERN.test(
      manifest.pluginId
    ) ||
    typeof manifest.pluginVersion !==
      "string" ||
    !SEMANTIC_VERSION_PATTERN.test(
      manifest.pluginVersion
    ) ||
    (
      manifest.pluginType !==
        "runner" &&
      manifest.pluginType !==
        "provider"
    )
  ) {
    throw invalidManifest();
  }

  const expectedContract =
    manifest.pluginType === "runner"
      ? TASKSEAL_RUNNER_CONTRACT_VERSION
      : TASKSEAL_PROVIDER_CONTRACT_VERSION;
  if (
    manifest.contractVersion !==
      expectedContract
  ) {
    throw new PluginManifestError(
      "PLUGIN_CONTRACT_UNSUPPORTED",
      "The TaskSeal plugin contract version is unsupported."
    );
  }

  if (
    typeof manifest.minimumNodeVersion !==
      "string" ||
    parseNodeVersion(
      manifest.minimumNodeVersion
    ) === null ||
    typeof manifest.entrypoint !==
      "string" ||
    !isSafeEntrypoint(
      manifest.entrypoint
    )
  ) {
    throw invalidManifest();
  }

  assertCompatibleNodeVersion({
    nodeVersion,
    minimumNodeVersion:
      manifest.minimumNodeVersion
  });

  return Object.freeze({
    schemaVersion: 1,
    apiVersion:
      TASKSEAL_PLUGIN_API_VERSION,
    pluginId: manifest.pluginId,
    pluginVersion:
      manifest.pluginVersion,
    pluginType:
      manifest.pluginType,
    contractVersion:
      expectedContract,
    minimumNodeVersion:
      manifest.minimumNodeVersion,
    entrypoint:
      manifest.entrypoint
  });
}

function assertCompatibleNodeVersion({
  nodeVersion,
  minimumNodeVersion
}: {
  nodeVersion: string;
  minimumNodeVersion: string;
}): void {
  const current =
    parseNodeVersion(nodeVersion);
  const required =
    parseNodeVersion(
      minimumNodeVersion
    );
  const taskSealMinimum =
    parseNodeVersion(
      TASKSEAL_MINIMUM_NODE_VERSION
    )!;

  if (
    current === null ||
    required === null ||
    current[0] !==
      TASKSEAL_SUPPORTED_NODE_MAJOR ||
    compareVersions(
      current,
      taskSealMinimum
    ) < 0 ||
    compareVersions(
      required,
      taskSealMinimum
    ) < 0 ||
    compareVersions(
      current,
      required
    ) < 0
  ) {
    throw new PluginManifestError(
      "PLUGIN_NODE_UNSUPPORTED",
      "The current Node.js version is not supported by this TaskSeal plugin."
    );
  }
}

function parseNodeVersion(
  value: string
): readonly [
  number,
  number,
  number
] | null {
  const match =
    NODE_VERSION_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  return [
    Number(match[1]!),
    Number(match[2]!),
    Number(match[3]!)
  ];
}

function compareVersions(
  left:
    readonly [
      number,
      number,
      number
    ],
  right:
    readonly [
      number,
      number,
      number
    ]
): number {
  for (
    let index = 0;
    index < 3;
    index += 1
  ) {
    const difference =
      left[index]! -
      right[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function isSafeEntrypoint(
  value: string
): boolean {
  if (
    value.length === 0 ||
    value.length >
      MAX_ENTRYPOINT_LENGTH ||
    !value.startsWith("./") ||
    value.includes("\\") ||
    !/\.(?:c|m)?js$/.test(value)
  ) {
    return false;
  }

  const segments =
    value.slice(2).split("/");
  return (
    segments.length > 0 &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.endsWith(".") &&
        !WINDOWS_DEVICE_NAME_PATTERN.test(
          segment
        ) &&
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(
          segment
        )
    )
  );
}

function readExactDataRecord(
  value: unknown,
  expectedKeys:
    readonly string[]
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw invalidManifest();
  }
  const prototype =
    Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw invalidManifest();
  }

  const descriptors =
    Object.getOwnPropertyDescriptors(
      value
    );
  const keys =
    Reflect.ownKeys(descriptors);
  if (
    keys.length !==
      expectedKeys.length ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !expectedKeys.includes(key)
    )
  ) {
    throw invalidManifest();
  }

  const record:
    Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor =
      descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalidManifest();
    }
    record[key] = descriptor.value;
  }
  return record;
}

function invalidManifest():
  PluginManifestError {
  return new PluginManifestError(
    "PLUGIN_MANIFEST_INVALID",
    "The TaskSeal plugin manifest is invalid."
  );
}
