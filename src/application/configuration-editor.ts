import { spawn } from "node:child_process";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type {
  ConfigurationReceipt,
  EditableConfigurationScope,
  InspectConfigurationOptions
} from "./configuration-control.ts";
import {
  createLocalConfigurationAuthority
} from "./configuration-authority.ts";
import type {
  ConfigurationAuthority
} from "./configuration-authority.ts";

const MAX_DRAFT_BYTES = 256 * 1024;

export interface ConfigurationEditorRequest {
  readonly filePath: string;
  readonly scope: EditableConfigurationScope;
}

export type ConfigurationEditor = (
  request: ConfigurationEditorRequest
) => number | Promise<number>;

export interface LaunchConfigurationEditorOptions
  extends ConfigurationEditorRequest {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

export class ConfigurationEditorError extends Error {
  readonly code:
    | "CONFIG_EDITOR_FAILED"
    | "CONFIG_VALUE_INVALID";

  constructor(
    code: ConfigurationEditorError["code"],
    message: string
  ) {
    super(message);
    this.name = "ConfigurationEditorError";
    this.code = code;
  }
}

export async function editConfigurationDraft({
  context,
  scope,
  editor,
  authority = createLocalConfigurationAuthority(context)
}: {
  readonly context: InspectConfigurationOptions;
  readonly scope: EditableConfigurationScope;
  readonly editor: ConfigurationEditor;
  readonly authority?: ConfigurationAuthority | undefined;
}): Promise<ConfigurationReceipt> {
  const draft = await authority.readDraft(scope);
  const directory = await mkdtemp(
    join(tmpdir(), "taskseal-config-edit-")
  );
  const filePath = join(directory, `${scope}.json`);

  try {
    const handle = await open(filePath, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify(draft.document, null, 2)}\n`,
        "utf8"
      );
      await handle.sync();
    } finally {
      await handle.close();
    }

    let exitCode: number;
    try {
      exitCode = await editor({ filePath, scope });
    } catch {
      throw editorFailure();
    }
    if (exitCode !== 0) {
      throw editorFailure();
    }

    let raw: Buffer;
    try {
      const status = await lstat(filePath);
      if (!status.isFile() || status.isSymbolicLink()) {
        throw invalidDraft();
      }
      raw = await readFile(filePath);
      if (raw.byteLength > MAX_DRAFT_BYTES) {
        throw invalidDraft();
      }
    } catch (error) {
      if (error instanceof ConfigurationEditorError) {
        throw error;
      }
      throw invalidDraft();
    }

    let document: unknown;
    try {
      document = JSON.parse(raw.toString("utf8"));
    } catch {
      throw invalidDraft();
    }
    if (!isRecord(document)) {
      throw invalidDraft();
    }

    return await authority.applyDraft(
      scope,
      document,
      draft.revision
    );
  } finally {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      // Temp cleanup cannot change the authoritative commit outcome.
    }
  }
}

export async function launchConfigurationEditor({
  filePath,
  environment = process.env,
  platform = process.platform
}: LaunchConfigurationEditorOptions): Promise<number> {
  const configured =
    nonEmpty(environment.TASKSEAL_EDITOR) ??
    nonEmpty(environment.VISUAL) ??
    nonEmpty(environment.EDITOR) ??
    (platform === "win32" ? "notepad.exe" : "vi");
  const [executable, ...configuredArguments] =
    parseEditorCommand(configured);
  const editorName = basename(executable).toLowerCase();
  const waitArguments =
    ["code", "code.exe", "codium", "codium.exe"].includes(editorName) &&
    !configuredArguments.includes("--wait")
      ? ["--wait"]
      : [];

  return new Promise<number>((resolve, reject) => {
    const child = spawn(
      executable,
      [...configuredArguments, ...waitArguments, filePath],
      {
        shell: false,
        stdio: "inherit",
        windowsHide: false
      }
    );
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

function parseEditorCommand(value: string): [string, ...string[]] {
  const tokens: string[] = [];
  let token = "";
  let quote: "\"" | "'" | null = null;
  let tokenStarted = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote !== null) {
      if (character === quote) {
        quote = null;
        tokenStarted = true;
      } else if (
        character === "\\" &&
        value[index + 1] === quote
      ) {
        token += quote;
        tokenStarted = true;
        index += 1;
      } else {
        token += character;
        tokenStarted = true;
      }
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }
    token += character;
    tokenStarted = true;
  }

  if (quote !== null) {
    throw editorFailure();
  }
  if (tokenStarted) {
    tokens.push(token);
  }
  if (tokens.length === 0 || tokens[0] === "") {
    throw editorFailure();
  }
  return tokens as [string, ...string[]];
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function editorFailure(): ConfigurationEditorError {
  return new ConfigurationEditorError(
    "CONFIG_EDITOR_FAILED",
    "The configuration editor did not complete successfully."
  );
}

function invalidDraft(): ConfigurationEditorError {
  return new ConfigurationEditorError(
    "CONFIG_VALUE_INVALID",
    "The edited configuration draft is invalid."
  );
}
