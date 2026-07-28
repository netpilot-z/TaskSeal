import {
  registerRunnerAdapterContract
} from "taskseal/testing/runner/v1";

import {
  createEchoRunnerAdapter
} from "./index.js";

registerRunnerAdapterContract({
  name: "echo runner",
  createAdapter:
    createEchoRunnerAdapter
});
