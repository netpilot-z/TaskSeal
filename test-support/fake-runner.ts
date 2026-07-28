import type {
  DigitalEmployeeAdapter,
  RunnerCapabilityManifest,
  RunnerExecutionContext,
  RunnerExecutionInput
} from "../src/runners/runner-contract.ts";

export type FakeRunnerBehavior = (
  input: RunnerExecutionInput,
  context: RunnerExecutionContext
) => unknown | Promise<unknown>;

export interface FakeRunnerOptions {
  runnerId?: string | undefined;
  workspaceAccess?:
    | readonly ("read-only" | "workspace-write")[]
    | undefined;
  handoffKinds?:
    | readonly ("artifact" | "evidence")[]
    | undefined;
  behavior: FakeRunnerBehavior;
}

export class FakeRunnerAdapter
  implements DigitalEmployeeAdapter
{
  readonly manifest: RunnerCapabilityManifest;
  readonly behavior: FakeRunnerBehavior;
  readonly inputs: RunnerExecutionInput[] = [];
  readonly signals: AbortSignal[] = [];

  constructor({
    runnerId = "fake-runner",
    workspaceAccess = [
      "read-only",
      "workspace-write"
    ],
    handoffKinds = [],
    behavior
  }: FakeRunnerOptions) {
    this.manifest = {
      schemaVersion: "1",
      runnerId,
      displayName: "Deterministic fake runner",
      capabilities: {
        workspaceAccess,
        cancellation: true,
        timeout: true,
        handoffKinds
      }
    };
    this.behavior = behavior;
  }

  execute(
    input: RunnerExecutionInput,
    context: RunnerExecutionContext
  ): unknown | Promise<unknown> {
    this.inputs.push(input);
    this.signals.push(context.signal);
    return this.behavior(input, context);
  }
}
