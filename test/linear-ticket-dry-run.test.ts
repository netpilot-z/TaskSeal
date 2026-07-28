import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

import { createLinearTicketDryRun } from "../src/application/linear-ticket-dry-run.ts";

test("Linear ticket dry-run is deterministic, structured, and offline", async (t) => {
  const cwd = await createTemporaryProject(t);
  const source = "docs/tickets/sample.md";
  await mkdir(join(cwd, "docs", "tickets"), { recursive: true });
  await writeFile(
    join(cwd, "docs", "tickets", "sample.md"),
    `# Sample

## T01 — Build the first slice

- 状态：待执行。
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
  const firstDraft = requireItem(first.drafts, 0);
  const secondDraft = requireItem(first.drafts, 1);
  assert.deepEqual(secondDraft.dependsOnTickets, ["T01"]);
  assert.deepEqual(secondDraft.prerequisites, ["操作者确认"]);
  assert.deepEqual(firstDraft.dependsOnTickets, []);
  assert.deepEqual(firstDraft.prerequisites, ["规格 0003"]);
  assert.match(firstDraft.title, /^\[TaskSeal T01\]/);
  assert.match(firstDraft.idempotencyKey, /^sha256:[0-9a-f]{64}$/);
  assert.match(firstDraft.payloadDigest, /^sha256:[0-9a-f]{64}$/);
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

  const draft = requireItem(plan.drafts, 0);
  assert.equal(draft.sourceStatus, "待执行。");
  assert.match(draft.description, /验证：运行测试。/);
  assert.doesNotMatch(draft.description, /被附录污染/);

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

test("completed tickets are excluded from bootstrap drafts", async (t) => {
  const cwd = await createTemporaryProject(t);
  await mkdir(join(cwd, "docs"), {
    recursive: true
  });
  await writeFile(
    join(cwd, "docs", "mixed.md"),
    `## T01 — Historical work

- 状态：已完成；保留历史。
- 目的：验证过滤。
- 范围：历史任务。
- 不包含：外部写入。
- 依赖：无。
- 验收标准：不生成草案。
- 验证：定向测试。

## T02 — Pending work

- 状态：待执行。
- 目的：验证未完成项。
- 范围：当前任务。
- 不包含：外部写入。
- 依赖：T01。
- 验收标准：只生成这一项。
- 验证：定向测试。
`
  );

  const plan = await createLinearTicketDryRun({
    cwd,
    source: "docs/mixed.md"
  });

  assert.deepEqual(
    plan.drafts.map((draft) => draft.sourceTicket),
    ["T02"]
  );
  assert.deepEqual(
    requireItem(
      plan.drafts,
      0
    ).externalTicketDependencies,
    ["T01"]
  );
});

test("the repository default uses only the current unmapped bootstrap manifest", async () => {
  const plan = await createLinearTicketDryRun({
    cwd: process.cwd()
  });

  assert.equal(
    plan.source,
    "docs/tickets/0006-linear-bootstrap-manifest.md"
  );
  assert.deepEqual(
    plan.drafts.map((draft) => draft.sourceTicket),
    [
      "T15.2",
      "T15.3",
      "T16",
      "T17",
      "T18",
      "T19",
      "T20",
      "T21",
      "T22",
      "T23",
      "T24"
    ]
  );
  assert.equal(plan.issueCount, 11);
  assert.equal(plan.externalWrites, 0);

  const historicalPlan =
    await createLinearTicketDryRun({
      cwd: process.cwd(),
      source:
        "docs/tickets/0002-codex-runner-milestone.md"
    });

  assert.equal(historicalPlan.issueCount, 0);

  const legacyGapPlan = await createLinearTicketDryRun({
    cwd: process.cwd(),
    source: "docs/tickets/0003-controlled-provider-sync-milestone.md"
  });

  assert.deepEqual(
    legacyGapPlan.drafts.map(
      (draft) => draft.sourceTicket
    ),
    ["T09", "T11.3"]
  );
});

async function createTemporaryProject(
  t: TestContext
): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "taskseal-dry-run-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(
    join(cwd, "config", "project.json"),
    JSON.stringify({
      project: "Local TaskSeal",
      linear: {
        workspace: "TaskSeal",
        team: "netpilot",
        project: "TaskSeal",
        backlogState: "Backlog"
      }
    })
  );
  return cwd;
}

function hasCode(
  code: string
): (error: unknown) => boolean {
  return (error: unknown) =>
    isRecord(error) && error.code === code;
}

function requireItem<T>(
  items: readonly T[],
  index: number
): T {
  const item = items[index];

  if (!item) {
    throw new Error(`Missing item at index ${index}.`);
  }

  return item;
}

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
