export const RUNNER_CONTRACT_VERSION = "1" as const;

const MAX_RUNNER_ID_LENGTH = 64;
const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_ID_LENGTH = 160;
const MAX_INSTRUCTION_LENGTH = 32_768;
const MAX_PATH_LENGTH = 4_096;
const MAX_SUMMARY_LENGTH = 2_000;
const MAX_RUNTIME_REFERENCE_LENGTH = 512;
const MAX_HANDOFF_CLAIMS = 32;
const MAX_CLAIM_VALUE_LENGTH = 512;
const MAX_LOCATOR_LENGTH = 2_048;

export type RunnerWorkspaceAccess =
  | "read-only"
  | "workspace-write";

export type RunnerHandoffKind =
  | "artifact"
  | "evidence";

export interface RunnerCapabilities {
  readonly workspaceAccess:
    readonly RunnerWorkspaceAccess[];
  readonly cancellation: true;
  readonly timeout: true;
  readonly handoffKinds:
    readonly RunnerHandoffKind[];
}

export interface RunnerCapabilityManifest {
  readonly schemaVersion:
    typeof RUNNER_CONTRACT_VERSION;
  readonly runnerId: string;
  readonly displayName: string;
  readonly capabilities: RunnerCapabilities;
}

export interface RunnerWorkspace {
  readonly root: string;
  readonly cwd: string;
  readonly access: RunnerWorkspaceAccess;
}

export interface RunnerExecutionInput {
  readonly schemaVersion:
    typeof RUNNER_CONTRACT_VERSION;
  readonly attemptId: string;
  readonly workItemId: string;
  readonly instruction: string;
  readonly workspace: RunnerWorkspace;
  readonly deadlineAt: string;
}

export interface RunnerRuntimeReferences {
  readonly sessionId?: string | undefined;
  readonly executionId?: string | undefined;
}

export interface RunnerArtifactHandoffClaim {
  readonly kind: "artifact";
  readonly artifactKind: string;
  readonly revision: string;
  readonly locator: string;
}

export interface RunnerEvidenceHandoffClaim {
  readonly kind: "evidence";
  readonly criterionKey: string;
  readonly outcome: "passed" | "failed";
  readonly artifactRevision: string;
  readonly locator: string;
}

export type RunnerHandoffClaim =
  | RunnerArtifactHandoffClaim
  | RunnerEvidenceHandoffClaim;

export interface RunnerExecutionOutput {
  readonly schemaVersion:
    typeof RUNNER_CONTRACT_VERSION;
  readonly attemptId: string;
  readonly outcome:
    | "completed"
    | "failed"
    | "interrupted";
  readonly summary?:
    | string
    | null
    | undefined;
  readonly runtimeRefs?:
    | RunnerRuntimeReferences
    | undefined;
  readonly handoffClaims?:
    | readonly RunnerHandoffClaim[]
    | undefined;
}

export interface RunnerExecutionContext {
  signal: AbortSignal;
}

export interface DigitalEmployeeAdapter {
  readonly manifest: unknown;
  execute(
    input: RunnerExecutionInput,
    context: RunnerExecutionContext
  ): unknown | Promise<unknown>;
}

export class RunnerContractError extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "RunnerContractError";
    this.code = code;
  }
}

export class RunnerExecutionError extends Error {
  readonly code: string;
  readonly publicSummary: string;

  constructor(
    code: string,
    publicSummary: string,
    options?: ErrorOptions
  ) {
    const summary = decodeBoundedString(
      publicSummary,
      "publicSummary",
      MAX_SUMMARY_LENGTH,
      "RUNNER_INPUT_INVALID"
    );
    super(summary, options);
    this.name = "RunnerExecutionError";
    this.code = code;
    this.publicSummary = summary;
  }
}

export function parseRunnerManifest(
  value: unknown
): RunnerCapabilityManifest {
  try {
    const manifest = decodeExactRecord(
      value,
      [
        "schemaVersion",
        "runnerId",
        "displayName",
        "capabilities"
      ],
      [
        "schemaVersion",
        "runnerId",
        "displayName",
        "capabilities"
      ],
      "RUNNER_MANIFEST_INVALID"
    );
    const capabilities = decodeExactRecord(
      manifest.capabilities,
      [
        "workspaceAccess",
        "cancellation",
        "timeout",
        "handoffKinds"
      ],
      [
        "workspaceAccess",
        "cancellation",
        "timeout",
        "handoffKinds"
      ],
      "RUNNER_MANIFEST_INVALID"
    );

    if (
      manifest.schemaVersion !==
      RUNNER_CONTRACT_VERSION
    ) {
      throw invalidManifest(
        "Runner manifest schemaVersion is unsupported."
      );
    }

    const runnerId = decodeBoundedString(
      manifest.runnerId,
      "runnerId",
      MAX_RUNNER_ID_LENGTH,
      "RUNNER_MANIFEST_INVALID"
    );

    if (
      !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(
        runnerId
      )
    ) {
      throw invalidManifest(
        "Runner manifest runnerId is invalid."
      );
    }

    const displayName = decodeBoundedString(
      manifest.displayName,
      "displayName",
      MAX_DISPLAY_NAME_LENGTH,
      "RUNNER_MANIFEST_INVALID"
    );
    const workspaceAccess = decodeEnumArray(
      capabilities.workspaceAccess,
      ["read-only", "workspace-write"] as const,
      2,
      "RUNNER_MANIFEST_INVALID"
    );
    const handoffKinds = decodeEnumArray(
      capabilities.handoffKinds,
      ["artifact", "evidence"] as const,
      2,
      "RUNNER_MANIFEST_INVALID",
      true
    );

    if (
      capabilities.cancellation !== true ||
      capabilities.timeout !== true
    ) {
      throw new RunnerContractError(
        "RUNNER_CAPABILITY_MISSING",
        "Managed runners must support cancellation and timeout."
      );
    }

    return Object.freeze({
      schemaVersion: RUNNER_CONTRACT_VERSION,
      runnerId,
      displayName,
      capabilities: Object.freeze({
        workspaceAccess:
          Object.freeze(workspaceAccess),
        cancellation: true,
        timeout: true,
        handoffKinds:
          Object.freeze(handoffKinds)
      })
    });
  } catch (error) {
    throw normalizeDecoderError(
      error,
      "RUNNER_MANIFEST_INVALID",
      "Runner manifest is not a valid v1 capability manifest."
    );
  }
}

export function parseRunnerExecutionInput(
  value: unknown
): RunnerExecutionInput {
  try {
    const input = decodeExactRecord(
      value,
      [
        "schemaVersion",
        "attemptId",
        "workItemId",
        "instruction",
        "workspace",
        "deadlineAt"
      ],
      [
        "schemaVersion",
        "attemptId",
        "workItemId",
        "instruction",
        "workspace",
        "deadlineAt"
      ],
      "RUNNER_INPUT_INVALID"
    );
    const workspace = decodeExactRecord(
      input.workspace,
      ["root", "cwd", "access"],
      ["root", "cwd", "access"],
      "RUNNER_INPUT_INVALID"
    );

    if (
      input.schemaVersion !==
      RUNNER_CONTRACT_VERSION
    ) {
      throw invalidInput(
        "Runner input schemaVersion is unsupported."
      );
    }

    const deadlineAt = decodeBoundedString(
      input.deadlineAt,
      "deadlineAt",
      40,
      "RUNNER_INPUT_INVALID"
    );

    if (
      !isCanonicalIsoTimestamp(deadlineAt)
    ) {
      throw invalidInput(
        "Runner input deadlineAt must be a canonical ISO-8601 timestamp."
      );
    }

    return Object.freeze({
      schemaVersion: RUNNER_CONTRACT_VERSION,
      attemptId: decodeBoundedString(
        input.attemptId,
        "attemptId",
        MAX_ID_LENGTH,
        "RUNNER_INPUT_INVALID"
      ),
      workItemId: decodeBoundedString(
        input.workItemId,
        "workItemId",
        MAX_ID_LENGTH,
        "RUNNER_INPUT_INVALID"
      ),
      instruction: decodeBoundedString(
        input.instruction,
        "instruction",
        MAX_INSTRUCTION_LENGTH,
        "RUNNER_INPUT_INVALID"
      ),
      workspace: Object.freeze({
        root: decodeBoundedString(
          workspace.root,
          "workspace.root",
          MAX_PATH_LENGTH,
          "RUNNER_INPUT_INVALID"
        ),
        cwd: decodeBoundedString(
          workspace.cwd,
          "workspace.cwd",
          MAX_PATH_LENGTH,
          "RUNNER_INPUT_INVALID"
        ),
        access: decodeWorkspaceAccess(
          workspace.access,
          "RUNNER_INPUT_INVALID"
        )
      }),
      deadlineAt
    });
  } catch (error) {
    throw normalizeDecoderError(
      error,
      "RUNNER_INPUT_INVALID",
      "Runner input is not a valid v1 execution envelope."
    );
  }
}

export function parseRunnerExecutionOutput(
  value: unknown,
  {
    manifest,
    expectedAttemptId
  }: {
    manifest: RunnerCapabilityManifest;
    expectedAttemptId: string;
  }
): RunnerExecutionOutput {
  try {
    const output = decodeExactRecord(
      value,
      [
        "schemaVersion",
        "attemptId",
        "outcome",
        "summary",
        "runtimeRefs",
        "handoffClaims"
      ],
      [
        "schemaVersion",
        "attemptId",
        "outcome"
      ],
      "RUNNER_OUTPUT_INVALID"
    );

    if (
      output.schemaVersion !==
      RUNNER_CONTRACT_VERSION
    ) {
      throw invalidOutput(
        "Runner output schemaVersion is unsupported."
      );
    }

    const attemptId = decodeBoundedString(
      output.attemptId,
      "attemptId",
      MAX_ID_LENGTH,
      "RUNNER_OUTPUT_INVALID"
    );

    if (attemptId !== expectedAttemptId) {
      throw invalidOutput(
        "Runner output attemptId does not match the host attempt."
      );
    }

    if (
      output.outcome !== "completed" &&
      output.outcome !== "failed" &&
      output.outcome !== "interrupted"
    ) {
      throw invalidOutput(
        "Runner output outcome is unsupported."
      );
    }

    const summary =
      output.summary === undefined ||
      output.summary === null
        ? output.summary
        : decodeBoundedString(
            output.summary,
            "summary",
            MAX_SUMMARY_LENGTH,
            "RUNNER_OUTPUT_INVALID"
          );
    const runtimeRefs =
      output.runtimeRefs === undefined
        ? undefined
        : decodeRuntimeReferences(
            output.runtimeRefs
          );
    const handoffClaims =
      output.handoffClaims === undefined
        ? undefined
        : decodeHandoffClaims({
            value: output.handoffClaims,
            allowedKinds:
              manifest.capabilities
              .handoffKinds
          });

    if (
      output.outcome !== "completed" &&
      (handoffClaims?.length ?? 0) > 0
    ) {
      throw invalidOutput(
        "Only a completed runner output may include handoff claims."
      );
    }

    const frozenRuntimeRefs =
      runtimeRefs === undefined
        ? undefined
        : Object.freeze(runtimeRefs);
    const frozenHandoffClaims =
      handoffClaims === undefined
        ? undefined
        : Object.freeze(
            handoffClaims.map(
              (claim) =>
                Object.freeze(claim)
            )
          );

    return Object.freeze({
      schemaVersion: RUNNER_CONTRACT_VERSION,
      attemptId,
      outcome: output.outcome,
      ...(summary === undefined
        ? {}
        : { summary }),
      ...(frozenRuntimeRefs === undefined
        ? {}
        : {
            runtimeRefs:
              frozenRuntimeRefs
          }),
      ...(frozenHandoffClaims === undefined
        ? {}
        : {
            handoffClaims:
              frozenHandoffClaims
          })
    });
  } catch (error) {
    throw normalizeDecoderError(
      error,
      "RUNNER_OUTPUT_INVALID",
      "Runner returned an invalid output envelope."
    );
  }
}

function decodeRuntimeReferences(
  value: unknown
): RunnerRuntimeReferences {
  const references = decodeExactRecord(
    value,
    ["sessionId", "executionId"],
    [],
    "RUNNER_OUTPUT_INVALID"
  );
  const sessionId =
    references.sessionId === undefined
      ? undefined
      : decodeBoundedString(
          references.sessionId,
          "runtimeRefs.sessionId",
          MAX_RUNTIME_REFERENCE_LENGTH,
          "RUNNER_OUTPUT_INVALID"
        );
  const executionId =
    references.executionId === undefined
      ? undefined
      : decodeBoundedString(
          references.executionId,
          "runtimeRefs.executionId",
          MAX_RUNTIME_REFERENCE_LENGTH,
          "RUNNER_OUTPUT_INVALID"
        );

  return {
    ...(sessionId === undefined
      ? {}
      : { sessionId }),
    ...(executionId === undefined
      ? {}
      : { executionId })
  };
}

function decodeHandoffClaims({
  value,
  allowedKinds
}: {
  value: unknown;
  allowedKinds: readonly RunnerHandoffKind[];
}): RunnerHandoffClaim[] {
  const values = decodeDenseArray(
    value,
    MAX_HANDOFF_CLAIMS,
    "RUNNER_OUTPUT_INVALID"
  );

  return values.map((candidate) => {
    const kind = readRecordDiscriminator(
      candidate,
      "kind",
      "RUNNER_OUTPUT_INVALID"
    );

    if (
      kind !== "artifact" &&
      kind !== "evidence"
    ) {
      throw invalidOutput(
        "Runner handoff claim kind is unsupported."
      );
    }

    if (!allowedKinds.includes(kind)) {
      throw invalidOutput(
        `Runner output contains undeclared ${kind} handoff claims.`
      );
    }

    if (kind === "artifact") {
      const claim = decodeExactRecord(
        candidate,
        [
          "kind",
          "artifactKind",
          "revision",
          "locator"
        ],
        [
          "kind",
          "artifactKind",
          "revision",
          "locator"
        ],
        "RUNNER_OUTPUT_INVALID"
      );
      return {
        kind,
        artifactKind: decodeBoundedString(
          claim.artifactKind,
          "artifactKind",
          MAX_CLAIM_VALUE_LENGTH,
          "RUNNER_OUTPUT_INVALID"
        ),
        revision: decodeBoundedString(
          claim.revision,
          "revision",
          MAX_CLAIM_VALUE_LENGTH,
          "RUNNER_OUTPUT_INVALID"
        ),
        locator: decodeBoundedString(
          claim.locator,
          "locator",
          MAX_LOCATOR_LENGTH,
          "RUNNER_OUTPUT_INVALID"
        )
      };
    }

    const claim = decodeExactRecord(
      candidate,
      [
        "kind",
        "criterionKey",
        "outcome",
        "artifactRevision",
        "locator"
      ],
      [
        "kind",
        "criterionKey",
        "outcome",
        "artifactRevision",
        "locator"
      ],
      "RUNNER_OUTPUT_INVALID"
    );

    if (
      claim.outcome !== "passed" &&
      claim.outcome !== "failed"
    ) {
      throw invalidOutput(
        "Runner evidence claim outcome is unsupported."
      );
    }

    return {
      kind,
      criterionKey: decodeBoundedString(
        claim.criterionKey,
        "criterionKey",
        MAX_CLAIM_VALUE_LENGTH,
        "RUNNER_OUTPUT_INVALID"
      ),
      outcome: claim.outcome,
      artifactRevision: decodeBoundedString(
        claim.artifactRevision,
        "artifactRevision",
        MAX_CLAIM_VALUE_LENGTH,
        "RUNNER_OUTPUT_INVALID"
      ),
      locator: decodeBoundedString(
        claim.locator,
        "locator",
        MAX_LOCATOR_LENGTH,
        "RUNNER_OUTPUT_INVALID"
      )
    };
  });
}

function decodeWorkspaceAccess(
  value: unknown,
  code: string
): RunnerWorkspaceAccess {
  if (
    value !== "read-only" &&
    value !== "workspace-write"
  ) {
    throw new RunnerContractError(
      code,
      "Runner workspace access is unsupported."
    );
  }

  return value;
}

function decodeEnumArray<
  Value extends string
>(
  value: unknown,
  allowed: readonly Value[],
  maximumLength: number,
  code: string,
  allowEmpty = false
): Value[] {
  const entries = decodeDenseArray(
    value,
    maximumLength,
    code
  );

  if (!allowEmpty && entries.length === 0) {
    throw new RunnerContractError(
      code,
      "Runner capability arrays must not be empty."
    );
  }

  const result: Value[] = [];
  for (const entry of entries) {
    if (
      typeof entry !== "string" ||
      !allowed.includes(entry as Value) ||
      result.includes(entry as Value)
    ) {
      throw new RunnerContractError(
        code,
        "Runner capability arrays contain unsupported or duplicate values."
      );
    }
    result.push(entry as Value);
  }
  return result;
}

function decodeBoundedString(
  value: unknown,
  field: string,
  maximumLength: number,
  code: string
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength ||
    value.includes("\u0000")
  ) {
    throw new RunnerContractError(
      code,
      `Runner ${field} must be a non-empty bounded string.`
    );
  }

  return value;
}

function decodeExactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  code: string
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new RunnerContractError(
      code,
      "Runner contract value must be a plain object."
    );
  }

  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw new RunnerContractError(
      code,
      "Runner contract value must use a plain object prototype."
    );
  }

  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some(
      (key) => typeof key !== "string"
    )
  ) {
    throw new RunnerContractError(
      code,
      "Runner contract value must not contain symbol keys."
    );
  }

  const keys = ownKeys as string[];
  if (
    keys.some(
      (key) => !allowedKeys.includes(key)
    ) ||
    requiredKeys.some(
      (key) => !keys.includes(key)
    )
  ) {
    throw new RunnerContractError(
      code,
      "Runner contract value contains unknown or missing fields."
    );
  }

  const decoded: Record<string, unknown> =
    Object.create(null) as Record<
      string,
      unknown
    >;
  const descriptors =
    Object.getOwnPropertyDescriptors(value);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new RunnerContractError(
        code,
        "Runner contract fields must be enumerable data properties."
      );
    }
    decoded[key] = descriptor.value;
  }

  return decoded;
}

function readRecordDiscriminator(
  value: unknown,
  key: string,
  code: string
): unknown {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new RunnerContractError(
      code,
      "Runner union value must be a plain object."
    );
  }
  const prototype = Object.getPrototypeOf(value);
  const descriptor =
    Object.getOwnPropertyDescriptor(value, key);
  if (
    (prototype !== Object.prototype &&
      prototype !== null) ||
    !descriptor ||
    !descriptor.enumerable ||
    !("value" in descriptor)
  ) {
    throw new RunnerContractError(
      code,
      "Runner union discriminator is invalid."
    );
  }
  return descriptor.value;
}

function decodeDenseArray(
  value: unknown,
  maximumLength: number,
  code: string
): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !==
      Array.prototype ||
    value.length > maximumLength
  ) {
    throw new RunnerContractError(
      code,
      "Runner contract array is invalid or too large."
    );
  }

  const ownKeys = Reflect.ownKeys(value);
  const allowedKeys = new Set<string>([
    "length",
    ...Array.from(
      { length: value.length },
      (_unused, index) => String(index)
    )
  ]);
  if (
    ownKeys.some(
      (key) =>
        typeof key !== "string" ||
        !allowedKeys.has(key)
    )
  ) {
    throw new RunnerContractError(
      code,
      "Runner contract array contains sparse or extra fields."
    );
  }

  const descriptors =
    Object.getOwnPropertyDescriptors(value);
  const result: unknown[] = [];
  for (
    let index = 0;
    index < value.length;
    index += 1
  ) {
    const descriptor =
      descriptors[String(index)];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new RunnerContractError(
        code,
        "Runner contract array must be dense and contain data properties."
      );
    }
    result.push(descriptor.value);
  }
  return result;
}

function isCanonicalIsoTimestamp(
  value: string
): boolean {
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() ===
      value
  );
}

function invalidManifest(
  message: string
): RunnerContractError {
  return new RunnerContractError(
    "RUNNER_MANIFEST_INVALID",
    message
  );
}

function invalidInput(
  message: string
): RunnerContractError {
  return new RunnerContractError(
    "RUNNER_INPUT_INVALID",
    message
  );
}

function invalidOutput(
  message: string
): RunnerContractError {
  return new RunnerContractError(
    "RUNNER_OUTPUT_INVALID",
    message
  );
}

function normalizeDecoderError(
  error: unknown,
  code: string,
  message: string
): RunnerContractError {
  if (error instanceof RunnerContractError) {
    return error;
  }

  return new RunnerContractError(
    code,
    message,
    { cause: error }
  );
}
