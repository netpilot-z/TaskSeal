import {
  mkdir,
  writeFile
} from "node:fs/promises";
import {
  basename,
  join,
  resolve
} from "node:path";

import {
  readProjectConfiguration
} from "../config/project-config.ts";
import type {
  WorkItemCreatedEvent
} from "../domain/workflow.ts";
import {
  FileEventJournal
} from "../storage/event-journal.ts";
import {
  TaskSealService
} from "./taskseal-service.ts";

export interface InitializeProjectResult {
  readonly configurationCreated:
    boolean;
  readonly project: string;
}

export interface InitializeDemoResult {
  readonly workItemCreated:
    boolean;
  readonly workItemId: "TS-1";
}

export async function initializeProject({
  cwd
}: {
  readonly cwd: string;
}): Promise<InitializeProjectResult> {
  const project =
    deriveProjectName(cwd);
  await mkdir(
    join(cwd, ".taskseal"),
    { recursive: true }
  );
  await mkdir(
    join(cwd, "config"),
    { recursive: true }
  );

  let configurationCreated = false;
  try {
    await writeFile(
      join(
        cwd,
        "config",
        "project.json"
      ),
      `${JSON.stringify(
        { project },
        null,
        2
      )}\n`,
      {
        encoding: "utf8",
        flag: "wx"
      }
    );
    configurationCreated = true;
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      )
    ) {
      throw error;
    }
  }

  const configuration =
    await readProjectConfiguration({
      cwd
    });
  return {
    configurationCreated,
    project: configuration.project
  };
}

export async function initializeDemo({
  cwd,
  now = () => new Date()
}: {
  readonly cwd: string;
  readonly now?: (() => Date) | undefined;
}): Promise<InitializeDemoResult> {
  await initializeProject({ cwd });
  const journal =
    new FileEventJournal({
      filePath: join(
        cwd,
        ".taskseal",
        "events.jsonl"
      )
    });
  const service =
    await TaskSealService.open({
      journal
    });
  const existing =
    service.getWorkItem("TS-1");

  if (existing) {
    return {
      workItemCreated: false,
      workItemId: "TS-1"
    };
  }

  const event:
    WorkItemCreatedEvent = {
      eventId:
        "taskseal:TS-1:local-created",
      workItemId: "TS-1",
      type: "work_item.created",
      occurredAt:
        now().toISOString(),
      payload: {
        title:
          "Run the first Codex App Server attempt",
        requiredEvidence: [
          "tests"
        ],
        externalLink: {
          provider: "taskseal",
          externalId: "TS-1",
          url:
            "http://127.0.0.1:4317/work-items/TS-1"
        }
      }
    };

  await service.append(event);
  return {
    workItemCreated: true,
    workItemId: "TS-1"
  };
}

function deriveProjectName(
  cwd: string
): string {
  const candidate =
    basename(resolve(cwd)).trim();
  if (candidate.length === 0) {
    return "TaskSeal";
  }
  return [
    ...candidate
  ].slice(0, 160).join("");
}
