import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";

import {
  getLinearBootstrapCoordinates,
  readProjectConfiguration
} from "../config/project-config.ts";

const DEFAULT_SOURCE =
  "docs/tickets/0006-linear-bootstrap-manifest.md";

type RequiredTicketField =
  | "状态"
  | "目的"
  | "范围"
  | "不包含"
  | "依赖"
  | "验收标准"
  | "验证";

const REQUIRED_FIELDS: readonly RequiredTicketField[] = [
  "状态",
  "目的",
  "范围",
  "不包含",
  "依赖",
  "验收标准",
  "验证"
];

interface LinearTicketDryRunOptions {
  cwd: string;
  source?: string | undefined;
}

interface ProjectSource {
  absolutePath: string;
  relativePath: string;
}

interface ParsedTicket {
  id: string;
  title: string;
  fields: Record<string, string>;
}

export interface LinearTicketDraft {
  sourceTicket: string;
  sourceStatus: string;
  title: string;
  description: string;
  dependsOnTickets: string[];
  externalTicketDependencies: string[];
  prerequisites: string[];
  idempotencyKey: string;
  payloadDigest: string;
}

export interface LinearTicketDryRunPlan {
  schemaVersion: 1;
  mode: "dry-run";
  provider: "linear";
  mutationReady: false;
  networkRequests: 0;
  externalWrites: 0;
  source: string;
  target: {
    project: string;
    workspace: string;
    team: string;
    resolved: false;
  };
  issueCount: number;
  drafts: LinearTicketDraft[];
}

interface CreateDraftOptions {
  ticket: ParsedTicket;
  ticketIds: ReadonlySet<string>;
  project: string;
  workspace: string;
  team: string;
  source: string;
}

interface RenderDescriptionOptions {
  ticket: ParsedTicket;
  source: string;
  dependsOnTickets: string[];
  prerequisites: string[];
}

type TicketDryRunErrorCode =
  | "TICKET_SOURCE_INVALID"
  | "TICKET_SOURCE_OUTSIDE_PROJECT";

export async function createLinearTicketDryRun({
  cwd,
  source = DEFAULT_SOURCE
}: LinearTicketDryRunOptions): Promise<
  LinearTicketDryRunPlan
> {
  const sourceFile = await resolveProjectSource({
    cwd,
    source
  });
  const configuration =
    await readProjectConfiguration({ cwd });
  const { workspace, team, project } =
    getLinearBootstrapCoordinates(configuration);
  let content: string;

  try {
    content = await readFile(
      sourceFile.absolutePath,
      "utf8"
    );
  } catch {
    throw dryRunError(
      "TICKET_SOURCE_INVALID",
      "Ticket source could not be read."
    );
  }

  const tickets = parseTickets(content).filter(
    (ticket) =>
      !isCompletedStatus(
        requireTicketField(ticket, "状态")
      )
  );
  const ticketIds = new Set(
    tickets.map((ticket) => ticket.id)
  );
  const drafts = tickets.map((ticket) =>
    createDraft({
      ticket,
      ticketIds,
      project,
      workspace,
      team,
      source: sourceFile.relativePath
    })
  );

  return {
    schemaVersion: 1,
    mode: "dry-run",
    provider: "linear",
    mutationReady: false,
    networkRequests: 0,
    externalWrites: 0,
    source: sourceFile.relativePath,
    target: {
      project,
      workspace,
      team,
      resolved: false
    },
    issueCount: drafts.length,
    drafts
  };
}

async function resolveProjectSource({
  cwd,
  source
}: {
  cwd: string;
  source: unknown;
}): Promise<ProjectSource> {
  if (
    typeof source !== "string" ||
    source.trim().length === 0 ||
    isAbsolute(source)
  ) {
    throw dryRunError(
      "TICKET_SOURCE_OUTSIDE_PROJECT",
      "Ticket source must be a relative path inside the project."
    );
  }

  let projectRoot: string;

  try {
    projectRoot = await realpath(cwd);
  } catch {
    throw dryRunError(
      "TICKET_SOURCE_INVALID",
      "Project root could not be resolved."
    );
  }

  const candidate = resolve(projectRoot, source);

  if (!isInside(projectRoot, candidate)) {
    throw dryRunError(
      "TICKET_SOURCE_OUTSIDE_PROJECT",
      "Ticket source must remain inside the project."
    );
  }

  let resolvedSource: string;

  try {
    resolvedSource = await realpath(candidate);
  } catch {
    throw dryRunError(
      "TICKET_SOURCE_INVALID",
      "Ticket source does not exist or is not accessible."
    );
  }

  if (!isInside(projectRoot, resolvedSource)) {
    throw dryRunError(
      "TICKET_SOURCE_OUTSIDE_PROJECT",
      "Ticket source resolves outside the project."
    );
  }

  return {
    absolutePath: resolvedSource,
    relativePath: toPortablePath(
      relative(projectRoot, resolvedSource)
    )
  };
}

function parseTickets(content: string): ParsedTicket[] {
  const tickets: ParsedTicket[] = [];
  const seen = new Set<string>();
  let current: ParsedTicket | null = null;

  for (const line of content.split(/\r?\n/)) {
    const isLevelTwoHeading = /^##\s+/.test(line);
    const heading =
      /^##\s+(T\d+(?:\.\d+)?)\s+[—–-]\s+(.+?)\s*$/.exec(
        line
      );

    if (isLevelTwoHeading) {
      current = null;
    }

    const ticketId = heading?.[1];
    const ticketTitle = heading?.[2];

    if (ticketId && ticketTitle) {
      if (seen.has(ticketId)) {
        throw dryRunError(
          "TICKET_SOURCE_INVALID",
          `Ticket source contains duplicate ticket ${ticketId}.`
        );
      }

      current = {
        id: ticketId,
        title: ticketTitle,
        fields: {}
      };
      seen.add(current.id);
      tickets.push(current);
      continue;
    }

    if (!current) {
      continue;
    }

    const field =
      /^-\s+([^：:]+)[：:]\s*(.*?)\s*$/.exec(line);
    const fieldName = field?.[1]?.trim();
    const fieldValue = field?.[2]?.trim();

    if (
      fieldName !== undefined &&
      fieldValue !== undefined
    ) {
      if (Object.hasOwn(current.fields, fieldName)) {
        throw dryRunError(
          "TICKET_SOURCE_INVALID",
          `Ticket ${current.id} contains duplicate field ${fieldName}.`
        );
      }

      current.fields[fieldName] = fieldValue;
    }
  }

  if (tickets.length === 0) {
    throw dryRunError(
      "TICKET_SOURCE_INVALID",
      "Ticket source does not contain any T ticket headings."
    );
  }

  for (const ticket of tickets) {
    const missing = REQUIRED_FIELDS.filter((field) => {
      const value = ticket.fields[field];
      return (
        typeof value !== "string" ||
        value.length === 0
      );
    });

    if (missing.length > 0) {
      throw dryRunError(
        "TICKET_SOURCE_INVALID",
        `Ticket ${ticket.id} is missing required fields: ${missing.join(", ")}.`
      );
    }
  }

  return tickets;
}

function createDraft({
  ticket,
  ticketIds,
  project,
  workspace,
  team,
  source
}: CreateDraftOptions): LinearTicketDraft {
  const dependencies = parseDependencies(
    requireTicketField(ticket, "依赖")
  );
  const dependsOnTickets = dependencies.filter(
    (value) => /^T\d+(?:\.\d+)?$/.test(value)
  );
  const prerequisites = dependencies.filter(
    (value) => !/^T\d+(?:\.\d+)?$/.test(value)
  );
  const externalTicketDependencies =
    dependsOnTickets.filter(
      (ticketId) => !ticketIds.has(ticketId)
    );

  const title = `[${project} ${ticket.id}] ${ticket.title}`;
  const description = renderDescription({
    ticket,
    source,
    dependsOnTickets,
    prerequisites
  });
  const idempotencyKey = digest(
    [
      "taskseal.linear.issue-draft:v1",
      project,
      workspace,
      team,
      source,
      ticket.id
    ].join("\0")
  );
  const payloadDigest = digest(
    JSON.stringify({
      teamRef: team,
      title,
      description
    })
  );

  return {
    sourceTicket: ticket.id,
    sourceStatus: requireTicketField(ticket, "状态"),
    title,
    description,
    dependsOnTickets,
    externalTicketDependencies,
    prerequisites,
    idempotencyKey,
    payloadDigest
  };
}

function renderDescription({
  ticket,
  source,
  dependsOnTickets,
  prerequisites
}: RenderDescriptionOptions): string {
  const fields: Array<readonly [string, string]> = [
    ["来源", `${source}#${ticket.id}`],
    ["来源状态", requireTicketField(ticket, "状态")],
    ["目的", requireTicketField(ticket, "目的")],
    ["范围", requireTicketField(ticket, "范围")],
    ["不包含", requireTicketField(ticket, "不包含")],
    [
      "依赖票据",
      dependsOnTickets.length > 0
        ? dependsOnTickets.join(", ")
        : "无"
    ],
    [
      "前置条件",
      prerequisites.length > 0
        ? prerequisites.join(", ")
        : "无"
    ],
    ["验收标准", requireTicketField(ticket, "验收标准")],
    ["验证", requireTicketField(ticket, "验证")]
  ];

  return [
    "此草案由 TaskSeal 仓库 ticket 生成；dry-run 不会创建或更新 Linear Issue。",
    "",
    ...fields.map(
      ([label, value]) => `- ${label}：${value}`
    )
  ].join("\n");
}

function requireTicketField(
  ticket: ParsedTicket,
  field: RequiredTicketField
): string {
  const value = ticket.fields[field];

  if (typeof value !== "string" || value.length === 0) {
    throw dryRunError(
      "TICKET_SOURCE_INVALID",
      `Ticket ${ticket.id} is missing required field ${field}.`
    );
  }

  return value;
}

function parseDependencies(value: string): string[] {
  return value
    .split(/[、,，;；]/)
    .map(
      (item) =>
        item.trim().replace(/[。.]+$/g, "")
    )
    .filter(
      (item) =>
        item.length > 0 &&
        item !== "无" &&
        item.toLowerCase() !== "none"
    );
}

function isCompletedStatus(value: string): boolean {
  const normalized = value
    .trim()
    .replace(/[。.]+$/g, "")
    .toLowerCase();

  return (
    normalized.startsWith("已完成") ||
    normalized.startsWith("completed")
  );
}

function digest(value: string): string {
  return `sha256:${createHash("sha256")
    .update(value)
    .digest("hex")}`;
}

function isInside(
  root: string,
  candidate: string
): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) &&
      path !== ".." &&
      !isAbsolute(path))
  );
}

function toPortablePath(value: string): string {
  return value.split(sep).join("/");
}

class LinearTicketDryRunError extends Error {
  readonly code: TicketDryRunErrorCode;

  constructor(
    code: TicketDryRunErrorCode,
    message: string
  ) {
    super(message);
    this.name = "LinearTicketDryRunError";
    this.code = code;
  }
}

function dryRunError(
  code: TicketDryRunErrorCode,
  message: string
): LinearTicketDryRunError {
  return new LinearTicketDryRunError(code, message);
}
