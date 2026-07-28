import {
  ManagedAttemptRunner
} from "../src/application/managed-attempt-runner.ts";
import {
  FakeRunnerAdapter
} from "./fake-runner.ts";
import type {
  WorkItem
} from "../src/domain/workflow.ts";

const workItem: WorkItem = {
  id: "TS-CHILD",
  title: "Bound a handle-free runner",
  status: "planned",
  requiredEvidence: ["tests"],
  activeAttemptId: null,
  activeArtifact: null,
  attempts: [],
  artifacts: [],
  evidence: [],
  acceptanceDecision: null,
  acceptanceHistory: [],
  externalLinks: []
};
let terminalAppends = 0;
const runner = new ManagedAttemptRunner({
  service: {
    getWorkItem() {
      return workItem;
    },
    async startAttemptIfIdle() {},
    async append() {
      terminalAppends += 1;
    }
  },
  projectRoot: process.cwd(),
  adapter: new FakeRunnerAdapter({
    workspaceAccess: ["read-only"],
    behavior() {
      return new Promise<never>(() => {});
    }
  }),
  cleanupGraceMs: 10
});
const controller =
  new AbortController();
const cancellationMode =
  process.argv[2] === "cancel";

try {
  const execution = runner.run({
    workItemId: "TS-CHILD",
    cwd: process.cwd(),
    instruction:
      "Exercise a handle-free timeout.",
    workspaceAccess: "read-only",
    timeoutMs: 20,
    ...(cancellationMode
      ? {
          signal: controller.signal
        }
      : {})
  });
  if (cancellationMode) {
    queueMicrotask(() =>
      controller.abort(
        new Error("Cancel child runner.")
      )
    );
  }
  await execution;
  process.exitCode = 1;
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      code:
        error instanceof Error &&
        "code" in error
          ? error.code
          : null,
      terminalAppends
    })
  );
}
