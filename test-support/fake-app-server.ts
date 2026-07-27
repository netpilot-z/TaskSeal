import readline from "node:readline";

const scenario = process.env.FAKE_APP_SERVER_SCENARIO ?? "completed";
const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

input.on("line", (line: string) => {
  const parsed: unknown = JSON.parse(line);

  if (!isRecord(parsed)) {
    process.exit(9);
    return;
  }

  const message = parsed;
  const params = isRecord(message.params) ? message.params : {};

  if (message.method === "initialize") {
    if (scenario === "initialize-timeout") {
      return;
    }

    if (scenario === "invalid-response-envelope") {
      return send({
        id: message.id,
        result: {},
        error: {
          code: "invalid",
          message: ["untrusted"]
        }
      });
    }

    if (scenario === "malformed-initialize") {
      return send({
        id: message.id,
        result: null
      });
    }

    return send({
      id: message.id,
      result: {
        codexHome: "fake",
        platformFamily: "windows",
        platformOs: "windows",
        userAgent: "taskseal-fake"
      }
    });
  }

  if (message.method === "initialized") {
    return;
  }

  if (message.method === "thread/start") {
    if (scenario === "unknown-response-id") {
      return send({
        id: 999,
        result: {}
      });
    }

    if (scenario === "malformed-thread-start") {
      return send({
        id: message.id,
        result: {
          thread: null
        }
      });
    }

    return send({
      id: message.id,
      result: {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        cwd: params.cwd,
        model: "fake-model",
        modelProvider: "fake",
        sandbox: { type: "readOnly" },
        thread: {
          id: "thread-1",
          preview: "",
          modelProvider: "fake",
          createdAt: 0,
          updatedAt: 0,
          status: { type: "idle" },
          path: null,
          cwd: params.cwd,
          cliVersion: "fake",
          source: "appServer",
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: []
        }
      }
    });
  }

  if (message.method === "turn/start") {
    if (scenario === "turn-start-error") {
      return send({
        id: message.id,
        error: {
          code: -32602,
          message: "must-not-be-returned-secret"
        }
      });
    }

    if (scenario === "malformed-turn-start") {
      return send({
        id: message.id,
        result: {
          turn: null
        }
      });
    }

    send({
      id: message.id,
      result: {
        turn: {
          id: "turn-1",
          items: [],
          status: "inProgress"
        }
      }
    });
    send({
      method: "turn/started",
      params: {
        threadId: params.threadId,
        turn: {
          id: "turn-1",
          items: [],
          status: "inProgress"
        }
      }
    });

    if (scenario === "invalid-json") {
      process.stdout.write("{invalid-json}\n");
      return;
    }

    if (scenario === "invalid-envelope") {
      process.stdout.write("null\n");
      return;
    }

    if (scenario === "malformed-turn-completed") {
      return send({
        method: "turn/completed",
        params: null
      });
    }

    if (scenario === "early-exit") {
      process.exit(7);
    }

    if (scenario === "timeout" || scenario === "uninterruptible") {
      return;
    }

    if (scenario === "approval" || scenario === "file-approval") {
      send({
        id: "approval-1",
        method:
          scenario === "file-approval"
            ? "item/fileChange/requestApproval"
            : "item/commandExecution/requestApproval",
        params: {
          threadId: params.threadId,
          turnId: "turn-1",
          itemId: "item-1",
          startedAtMs: 0
        }
      });
      return;
    }

    if (scenario === "mismatched-turn") {
      return sendCompletion(
        requireString(params.threadId, "threadId"),
        "completed",
        "turn-other"
      );
    }

    if (scenario === "mismatched-thread") {
      return sendCompletion("thread-other", "completed");
    }

    return sendCompletion(
      requireString(params.threadId, "threadId"),
      scenario
    );
  }

  if (message.id === "approval-1") {
    if (
      !isRecord(message.result) ||
      message.result.decision !== "decline"
    ) {
      process.exit(8);
    }

    return sendCompletion("thread-1", "completed");
  }

  if (message.method === "turn/interrupt") {
    if (scenario === "uninterruptible") {
      return;
    }

    send({
      id: message.id,
      result: {}
    });
    return sendCompletion(
      requireString(params.threadId, "threadId"),
      "interrupted"
    );
  }
});

input.on("close", () => {
  process.exit(0);
});

function sendCompletion(
  threadId: string,
  status: string,
  turnId = "turn-1"
): void {
  send({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        items: [],
        status,
        error:
          status === "failed"
            ? {
                message: "Fake turn failed."
              }
            : null
      }
    }
  });
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Fake App Server ${field} must be a string.`);
  }

  return value;
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
