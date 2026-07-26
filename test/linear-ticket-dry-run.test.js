import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLinearTicketDryRun } from "../src/application/linear-ticket-dry-run.js";

test("Linear ticket dry-run is deterministic, structured, and offline", async (t) => {
  const cwd = await createTemporaryProject(t);
  const source = "docs/tickets/sample.md";
  await mkdir(join(cwd, "docs", "tickets"), { recursive: true });
  await writeFile(
    join(cwd, "docs", "tickets", "sample.md"),
    `# Sample

## T01 — Build the first slice

- 状态：已完成。
- 目的：证明第一个切片。
- 范围：最小实现。
- 不包含：外部写入。
- 依赖：规格 0003。
- 验收标准：行为可验证。
- 验证：运行定向测试。

## T02 — Inspect the result

- 状态：待执行。
- 目的：检查输出。
- 范围：只读检查。
- 不包含：创建 Issue。
- 依赖：T01、操作者确认。
- 验收标准：输出可审查。
- 验证：运行快照测试。
`
  );

  const first = await createLinearTicketDryRun({ cwd, source });
  const second = await createLinearTicketDryRun({ cwd, source });

  assert.deepEqual(second, first);
  assert.deepEqual(
    {
      schemaVersion: first.schemaVersion,
      mode: first.mode,
      provider: first.provider,
      mutationReady: first.mutationReady,
      networkRequests: first.networkRequests,
      externalWrites: first.externalWrites,
      source: first.source,
      target: first.target,
      issueCount: first.issueCount
    },
    {
      schemaVersion: 1,
      mode: "dry-run",
      provider: "linear",
      mutationReady: false,
      networkRequests: 0,
      externalWrites: 0,
      source,
      target: {
        project: "TaskSeal",
        workspace: "TaskSeal",
        team: "netpilot",
        resolved: false
      },
      issueCount: 2
    }
  );
  assert.deepEqual(first.drafts[1].dependsOnTickets, ["T01"]);
  assert.deepEqual(first.drafts[1].prerequisites, ["操作者确认"]);
  assert.deepEqual(first.drafts[0].dependsOnTickets, []);
  assert.deepEqual(first.drafts[0].prerequisites, ["规格 0003"]);
  assert.match(first.drafts[0].title, /^\[TaskSeal T01\]/);
  assert.match(first.drafts[0].idempotencyKey, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.drafts[0].payloadDigest, /^sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(
    JSON.stringify(first),
    new RegExp(escapeRegExp(cwd))
  );
});

test("Linear ticket dry-run rejects paths outside the project and invalid tickets", async (t) => {
  const cwd = await createTemporaryProject(t);

  await assert.rejects(
    createLinearTicketDryRun({
      cwd,
      source: "../outside.md"
    }),
    hasCode("TICKET_SOURCE_OUTSIDE_PROJECT")
  );

  await mkdir(join(cwd, "docs"), { recursive: true });
  await writeFile(
    join(cwd, "docs", "invalid.md"),
    "## T01 — Missing fields\n\n- 状态：待执行。\n"
  );

  await assert.rejects(
    createLinearTicketDryRun({
      cwd,
      source: "docs/invalid.md"
    }),
    hasCode("TICKET_SOURCE_INVALID")
  );
});

test("non-ticket headings end a ticket and duplicate fields are rejected", async (t) => {
  const cwd = await createTemporaryProject(t);
  await mkdir(join(cwd, "docs"), { recursive: true });
  await writeFile(
    join(cwd, "docs", "appendix.md"),
    `## T01 — Stable ticket

- 状态：待执行。
- 目的：保持字段边界。
- 范围：一个 ticket。
- 不包含：外部写入。
- 依赖：规格 0003。
- 验收标准：附录不能覆盖字段。
- 验证：运行测试。

## 附录

- 状态：被附录污染。
- 验证：错误验证。
`
  );

  const plan = await createLinearTicketDryRun({
    cwd,
    source: "docs/appendix.md"
  });

  assert.equal(plan.drafts[0].sourceStatus, "待执行。");
  assert.match(plan.drafts[0].description, /验证：运行测试。/);
  assert.doesNotMatch(plan.drafts[0].description, /被附录污染/);

  await writeFile(
    join(cwd, "docs", "duplicate.md"),
    `## T01 — Duplicate field

- 状态：待执行。
- 状态：已完成。
- 目的：拒绝重复字段。
- 范围：一个 ticket。
- 不包含：外部写入。
- 依赖：规格 0003。
- 验收标准：重复字段失败。
- 验证：运行测试。
`
  );

  await assert.rejects(
    createLinearTicketDryRun({
      cwd,
      source: "docs/duplicate.md"
    }),
    hasCode("TICKET_SOURCE_INVALID")
  );
});

test("the repository milestone produces drafts for every current T ticket", async () => {
  const plan = await createLinearTicketDryRun({
    cwd: process.cwd()
  });

  assert.equal(plan.source, "docs/tickets/0002-codex-runner-milestone.md");
  assert.deepEqual(
    plan.drafts.map((draft) => draft.sourceTicket),
    ["T01", "T02", "T03", "T04", "T05.1", "T05.2", "T05.3", "T06"]
  );
  assert.equal(plan.issueCount, 8);
  assert.equal(plan.externalWrites, 0);

  const nextPlan = await createLinearTicketDryRun({
    cwd: process.cwd(),
    source: "docs/tickets/0003-controlled-provider-sync-milestone.md"
  });

  assert.deepEqual(
    nextPlan.drafts.map((draft) => draft.sourceTicket),
    ["T07.1", "T07.2", "T07.3", "T08", "T09", "T10", "T11"]
  );
  assert.equal(nextPlan.issueCount, 7);
  assert.deepEqual(
    nextPlan.drafts[0].externalTicketDependencies,
    ["T05.3"]
  );
});

async function createTemporaryProject(t) {
  const cwd = await mkdtemp(join(tmpdir(), "taskseal-dry-run-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({
      project: "TaskSeal",
      linear: {
        workspace: "TaskSeal",
        team: "netpilot"
      }
    })
  );
  return cwd;
}

function hasCode(code) {
  return (error) => error?.code === code;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
