#!/usr/bin/env node

import {
  TASKSEAL_MINIMUM_NODE_VERSION,
  TASKSEAL_SUPPORTED_NODE_MAJOR
} from "../sdk/plugin-manifest.ts";

const currentVersion =
  parseNodeVersion(
    process.versions.node
  );
const minimumVersion =
  parseNodeVersion(
    TASKSEAL_MINIMUM_NODE_VERSION
  )!;

if (
  currentVersion === null ||
  currentVersion[0] !==
    TASKSEAL_SUPPORTED_NODE_MAJOR ||
  compareVersions(
    currentVersion,
    minimumVersion
  ) < 0
) {
  process.stderr.write(
    `TASKSEAL_NODE_UNSUPPORTED: TaskSeal requires Node.js >=${TASKSEAL_MINIMUM_NODE_VERSION} <25.\n`
  );
  process.exitCode = 1;
} else {
  const {
    runTaskSealCli
  } = await import("../cli.ts");
  process.exitCode =
    await runTaskSealCli();
}

function parseNodeVersion(
  value: string
):
  | readonly [
      number,
      number,
      number
    ]
  | null {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/.exec(
      value
    );
  if (!match) {
    return null;
  }
  return [
    Number(match[1]!),
    Number(match[2]!),
    Number(match[3]!)
  ];
}

function compareVersions(
  left:
    readonly [
      number,
      number,
      number
    ],
  right:
    readonly [
      number,
      number,
      number
    ]
): number {
  for (
    let index = 0;
    index < 3;
    index += 1
  ) {
    const difference =
      left[index]! -
      right[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
