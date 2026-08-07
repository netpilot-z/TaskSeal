import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createLocalProjectRegistry
} from "../src/application/project-registry.ts";

test("local project registry replays additional workspaces without opening a writer", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "taskseal-registry-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const child = join(cwd, "child");
  await mkdir(join(child, "config"), { recursive: true });
  await mkdir(join(child, ".taskseal"), { recursive: true });
  await writeFile(
    join(child, "config", "project.json"),
    JSON.stringify({ project: "Child Project" })
  );
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(
    join(cwd, "config", "projects.json"),
    JSON.stringify({
      schemaVersion: "project-registry/v1",
      projects: [{ projectRef: "child", workspace: "child" }]
    })
  );

  const sources = await createLocalProjectRegistry({ cwd }).list();
  assert.equal(sources.length, 1);
  const snapshot = await sources[0]!.read();
  assert.equal(snapshot.project.key, "child");
  assert.equal(snapshot.project.name, "Child Project");
  assert.equal(snapshot.freshness, "stale");
});

test("project registry rejects paths that escape the workspace", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "taskseal-registry-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(
    join(cwd, "config", "projects.json"),
    JSON.stringify({
      schemaVersion: "project-registry/v1",
      projects: [{ projectRef: "escape", workspace: "../outside" }]
    })
  );
  const sources = await createLocalProjectRegistry({ cwd }).list();
  await assert.rejects(
    () => sources[0]!.read(),
    (error: unknown) =>
      error instanceof Error && error.message.includes("project registry")
  );
});
