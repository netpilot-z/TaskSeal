import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  launchConfigurationEditor
} from "../src/application/configuration-editor.ts";

test("configuration editor launches a quoted executable with arguments and no shell contract", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const filePath = join(directory, "project.json");
  await writeFile(filePath, "{}\n");
  const script =
    "require('node:fs').appendFileSync(process.argv[1], 'edited')";

  assert.equal(
    await launchConfigurationEditor({
      filePath,
      scope: "project",
      environment: {
        TASKSEAL_EDITOR: `"${process.execPath}" -e "${script}"`,
        VISUAL: "must-not-run"
      }
    }),
    0
  );
  assert.equal(await readFile(filePath, "utf8"), "{}\nedited");
});

async function createTemporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taskseal-editor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
