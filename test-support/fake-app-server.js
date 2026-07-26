import readline from "node:readline";

const scenario = process.env.FAKE_APP_SERVER_SCENARIO ?? "completed";
const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

input.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    if (scenario === "initialize-timeout") {
      return;
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
    return send({
      id: message.id,
      result: {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        cwd: message.params.cwd,
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
          cwd: message.params.cwd,
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
          message: "Fake turn/start rejected."
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
        threadId: message.params.threadId,
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

    if (scenario === "early-exit") {
      process.exit(7);
    }

    if (scenario === "timeout" || scenario === "uninterruptible") {
      return;
    }

    if (scenario === "approval") {
      send({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: message.params.threadId,
          turnId: "turn-1",
          itemId: "item-1",
          startedAtMs: 0
        }
      });
      return;
    }

    if (scenario === "mismatched-turn") {
      return sendCompletion(
        message.params.threadId,
        "completed",
        "turn-other"
      );
    }

    return sendCompletion(message.params.threadId, scenario);
  }

  if (message.id === "approval-1") {
    if (message.result?.decision !== "decline") {
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
    return sendCompletion(message.params.threadId, "interrupted");
  }
});

input.on("close", () => {
  process.exit(0);
});

function sendCompletion(threadId, status, turnId = "turn-1") {
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

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
