import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRunnerExecutionOutput,
  parseRunnerManifest
} from "../src/runners/runner-contract.ts";
import type {
  DigitalEmployeeAdapter,
  RunnerExecutionInput
} from "../src/runners/runner-contract.ts";

export interface RunnerAdapterContractFactory {
  name: string;
  createAdapter(
    scenario: "completed" | "cancel"
  ): DigitalEmployeeAdapter;
}

const contractInput: RunnerExecutionInput =
  Object.freeze({
  schemaVersion: "1",
  attemptId: "contract-attempt",
  workItemId: "TS-CONTRACT",
  instruction: "Return the contract result.",
  workspace: Object.freeze({
    root: "contract-workspace",
    cwd: "contract-workspace",
    access: "read-only"
  }),
  deadlineAt: "2026-07-28T12:00:00.000Z"
});

export function registerRunnerAdapterContract({
  name,
  createAdapter
}: RunnerAdapterContractFactory): void {
  test(`${name} exposes a valid v1 capability manifest`, () => {
    const adapter = createAdapter("completed");
    assert.deepEqual(
      parseRunnerManifest(adapter.manifest),
      adapter.manifest
    );
  });

  test(`${name} returns a decodable output bound to the host attempt`, async () => {
    const adapter = createAdapter("completed");
    const manifest = parseRunnerManifest(
      adapter.manifest
    );
    const output = parseRunnerExecutionOutput(
      await adapter.execute(contractInput, {
        signal: new AbortController().signal
      }),
      {
        manifest,
        expectedAttemptId:
          contractInput.attemptId
      }
    );

    assert.equal(
      output.attemptId,
      contractInput.attemptId
    );
    assert.equal(output.outcome, "completed");
  });

  test(`${name} settles after the host aborts execution`, async () => {
    const adapter = createAdapter("cancel");
    const controller = new AbortController();
    const execution = Promise.resolve(
      adapter.execute(contractInput, {
        signal: controller.signal
      })
    ).then(
      () => "fulfilled" as const,
      () => "rejected" as const
    );

    controller.abort(
      new Error("Contract cancellation.")
    );
    const status = await Promise.race([
      execution,
      new Promise<"timed-out">((resolve) => {
        const timer = setTimeout(
          () => resolve("timed-out"),
          250
        );
        timer.unref();
      })
    ]);

    assert.notEqual(status, "timed-out");
  });
}
