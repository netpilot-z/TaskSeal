const manifest = Object.freeze({
  schemaVersion: "1",
  runnerId: "example.echo",
  displayName: "Echo Runner",
  capabilities: Object.freeze({
    workspaceAccess: Object.freeze([
      "read-only",
      "workspace-write"
    ]),
    cancellation: true,
    timeout: true,
    handoffKinds: Object.freeze([])
  })
});

export function createEchoRunnerAdapter(
  scenario = "completed"
) {
  return {
    manifest,
    execute(input, { signal }) {
      if (scenario === "cancel") {
        return waitForCancellation(
          signal
        );
      }
      return {
        schemaVersion: "1",
        attemptId:
          input.attemptId,
        outcome: "completed",
        summary:
          `Echoed ${input.workItemId}.`
      };
    }
  };
}

function waitForCancellation(signal) {
  return new Promise(
    (_resolve, reject) => {
      if (signal.aborted) {
        reject(
          signal.reason
        );
        return;
      }
      signal.addEventListener(
        "abort",
        () =>
          reject(
            signal.reason
          ),
        { once: true }
      );
    }
  );
}
