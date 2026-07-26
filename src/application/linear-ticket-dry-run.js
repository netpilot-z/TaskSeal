import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";

import {
  getLinearCoordinates,
  readProjectConfiguration
} from "../config/project-config.ts";

const DEFAULT_SOURCE =
  "docs/tickets/0002-codex-runner-milestone.md";
const REQUIRED_FIELDS = [
  "状态",
  "目的",
  "范围",
  "不包含",
  "依赖",
  "验收标准",
  "验证"
];

export async function createLinearTicketDryRun({
  cwd,
  source = DEFAULT_SOURCE
}) {
  const sourceFile = await resolveProjectSource({ cwd, source });
  const configuration = await readProjectConfiguration({ cwd });
  const { workspace, team } = getLinearCoordinates(configuration);
  let content;

  try {
    content = await readFile(sourceFile.absolutePath, "utf8");
  } catch {
    throw dryRunError(
      "TICKET_SOURCE_INVALID",
      "Ticket source could not be read."
    );
  }

  const tickets = parseTickets(content);
  const ticketIds = new Set(tickets.map((ticket) => ticket.id));
  const drafts = tickets.map((ticket) =>
    createDraft({
      ticket,
      ticketIds,
      project: configuration.project,
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
      project: configuration.project,
      workspace,
      team,
      resolved: false
    },
    issueCount: drafts.length,
    drafts
  };
}

async function resolveProjectSource({ cwd, source }) {
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

  let projectRoot;

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

  let resolvedSource;

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
    relativePath: toPortablePath(relative(projectRoot, resolvedSource))
  };
}

function parseTickets(content) {
  const tickets = [];
  const seen = new Set();
  let current = null;

  for (const line of content.split(/\r?\n/)) {
    const isLevelTwoHeading = /^##\s+/.test(line);
    const heading =
      /^##\s+(T\d+(?:\.\d+)?)\s+[—–-]\s+(.+?)\s*$/.exec(line);

    if (isLevelTwoHeading) {
      current = null;
    }

    if (heading) {
      if (seen.has(heading[1])) {
        throw dryRunError(
          "TICKET_SOURCE_INVALID",
          `Ticket source contains duplicate ticket ${heading[1]}.`
        );
      }

      current = {
        id: heading[1],
        title: heading[2],
        fields: {}
      };
      seen.add(current.id);
      tickets.push(current);
      continue;
    }

    if (!current) {
      continue;
    }

    const field = /^-\s+([^：:]+)[：:]\s*(.*?)\s*$/.exec(line);

    if (field) {
      const name = field[1].trim();

      if (Object.hasOwn(current.fields, name)) {
        throw dryRunError(
          "TICKET_SOURCE_INVALID",
          `Ticket ${current.id} contains duplicate field ${name}.`
        );
      }

      current.fields[name] = field[2].trim();
    }
  }

  if (tickets.length === 0) {
    throw dryRunError(
      "TICKET_SOURCE_INVALID",
      "Ticket source does not contain any T ticket headings."
    );
  }

  for (const ticket of tickets) {
    const missing = REQUIRED_FIELDS.filter(
      (field) =>
        typeof ticket.fields[field] !== "string" ||
        ticket.fields[field].length === 0
    );

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
}) {
  const dependencies = parseDependencies(ticket.fields["依赖"]);
  const dependsOnTickets = dependencies.filter((value) =>
    /^T\d+(?:\.\d+)?$/.test(value)
  );
  const prerequisites = dependencies.filter(
    (value) => !/^T\d+(?:\.\d+)?$/.test(value)
  );
  const externalTicketDependencies = dependsOnTickets.filter(
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
    sourceStatus: ticket.fields["状态"],
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
}) {
  const fields = [
    ["来源", `${source}#${ticket.id}`],
    ["来源状态", ticket.fields["状态"]],
    ["目的", ticket.fields["目的"]],
    ["范围", ticket.fields["范围"]],
    ["不包含", ticket.fields["不包含"]],
    [
      "依赖票据",
      dependsOnTickets.length > 0 ? dependsOnTickets.join(", ") : "无"
    ],
    [
      "前置条件",
      prerequisites.length > 0 ? prerequisites.join(", ") : "无"
    ],
    ["验收标准", ticket.fields["验收标准"]],
    ["验证", ticket.fields["验证"]]
  ];

  return [
    "此草案由 TaskSeal 仓库 ticket 生成；dry-run 不会创建或更新 Linear Issue。",
    "",
    ...fields.map(([label, value]) => `- ${label}：${value}`)
  ].join("\n");
}

function parseDependencies(value) {
  return value
    .split(/[、,，;；]/)
    .map((item) => item.trim().replace(/[。.]+$/g, ""))
    .filter(
      (item) =>
        item.length > 0 &&
        item !== "无" &&
        item.toLowerCase() !== "none"
    );
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) &&
      path !== ".." &&
      !isAbsolute(path))
  );
}

function toPortablePath(value) {
  return value.split(sep).join("/");
}

function dryRunError(code, message) {
  const error = new Error(message);
  error.name = "LinearTicketDryRunError";
  error.code = code;
  return error;
}
