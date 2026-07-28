import {
  digestCanonicalJson
} from "../lib/canonical-json.ts";
import type {
  Attempt,
  WorkItem
} from "../domain/workflow.ts";

const MAX_ATTEMPT_COUNT =
  1_000_000;
const ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN =
  /^sha256:[0-9a-f]{64}$/;

export interface DecompositionAttemptBaseline {
  readonly workItemId: string;
  readonly attemptCount: number;
  readonly attemptIdsDigest: string;
}

export type DecompositionAttemptWindow =
  | {
      readonly matched: true;
      readonly attempts:
        readonly Attempt[];
    }
  | {
      readonly matched: false;
      readonly attempts:
        readonly [];
    };

export function captureDecompositionAttemptBaseline(
  workItem: WorkItem
): DecompositionAttemptBaseline {
  const workItemId =
    readIdentifier(workItem?.id);
  if (
    !Array.isArray(
      workItem?.attempts
    ) ||
    workItem.attempts.length >
      MAX_ATTEMPT_COUNT
  ) {
    throw new TypeError(
      "Decomposition attempt baseline requires bounded canonical attempts."
    );
  }
  const attemptIds =
    workItem.attempts.map(
      (attempt) =>
        readIdentifier(
          attempt?.id
        )
    );
  if (
    new Set(attemptIds).size !==
    attemptIds.length
  ) {
    throw new TypeError(
      "Decomposition attempt baseline requires unique attempt IDs."
    );
  }
  return freezeBaseline({
    workItemId,
    attemptCount:
      attemptIds.length,
    attemptIdsDigest:
      digestAttemptIds(
        workItemId,
        attemptIds
      )
  });
}

export function resolveDecompositionAttemptWindow(
  baseline:
    DecompositionAttemptBaseline,
  workItem: WorkItem
): DecompositionAttemptWindow {
  if (
    !isBaseline(baseline) ||
    !workItem ||
    workItem.id !==
      baseline.workItemId ||
    !Array.isArray(
      workItem.attempts
    ) ||
    workItem.attempts.length <
      baseline.attemptCount
  ) {
    return unmatchedWindow();
  }
  const prefixIds =
    workItem.attempts
      .slice(
        0,
        baseline.attemptCount
      )
      .map((attempt) =>
        typeof attempt?.id ===
          "string"
          ? attempt.id
          : ""
      );
  if (
    prefixIds.some(
      (attemptId) =>
        !ID_PATTERN.test(attemptId)
    ) ||
    digestAttemptIds(
      baseline.workItemId,
      prefixIds
    ) !==
      baseline.attemptIdsDigest
  ) {
    return unmatchedWindow();
  }
  return Object.freeze({
    matched: true as const,
    attempts: Object.freeze([
      ...workItem.attempts.slice(
        baseline.attemptCount
      )
    ])
  });
}

export function parseDecompositionAttemptBaselines(
  value: unknown,
  expectedWorkItemIds:
    readonly string[]
):
  readonly DecompositionAttemptBaseline[] {
  if (
    !Array.isArray(value) ||
    value.length !==
      expectedWorkItemIds.length
  ) {
    throw new TypeError(
      "Decomposition approval baselines must cover every owned WorkItem."
    );
  }
  const baselines =
    value.map(parseBaseline);
  const expected =
    [...expectedWorkItemIds]
      .map(readIdentifier)
      .toSorted(compareStrings);
  const actual =
    baselines
      .map(
        (baseline) =>
          baseline.workItemId
      )
      .toSorted(compareStrings);
  if (
    new Set(actual).size !==
      actual.length ||
    expected.some(
      (workItemId, index) =>
        actual[index] !==
        workItemId
    )
  ) {
    throw new TypeError(
      "Decomposition approval baselines do not match plan ownership."
    );
  }
  return Object.freeze(
    baselines.toSorted(
      (left, right) =>
        compareStrings(
          left.workItemId,
          right.workItemId
        )
    )
  );
}

function parseBaseline(
  value: unknown
): DecompositionAttemptBaseline {
  const record =
    readExactDataRecord(
      value,
      [
        "workItemId",
        "attemptCount",
        "attemptIdsDigest"
      ]
    );
  if (
    typeof record.attemptCount !==
      "number" ||
    !Number.isSafeInteger(
      record.attemptCount
    ) ||
    record.attemptCount < 0 ||
    record.attemptCount >
      MAX_ATTEMPT_COUNT ||
    typeof record.attemptIdsDigest !==
      "string" ||
    !DIGEST_PATTERN.test(
      record.attemptIdsDigest
    )
  ) {
    throw new TypeError(
      "Decomposition approval baseline is invalid."
    );
  }
  return freezeBaseline({
    workItemId:
      readIdentifier(
        record.workItemId
      ),
    attemptCount:
      record.attemptCount,
    attemptIdsDigest:
      record.attemptIdsDigest
  });
}

function digestAttemptIds(
  workItemId: string,
  attemptIds:
    readonly string[]
): string {
  return digestCanonicalJson(
    {
      schemaVersion: "1",
      scope:
        "taskseal.decomposition.attempt-baseline",
      workItemId,
      attemptIds
    },
    { maxDepth: 4 }
  );
}

function isBaseline(
  value: unknown
): value is
  DecompositionAttemptBaseline {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (
      value as
        DecompositionAttemptBaseline
    ).workItemId === "string" &&
    ID_PATTERN.test(
      (
        value as
          DecompositionAttemptBaseline
      ).workItemId
    ) &&
    typeof (
      value as
        DecompositionAttemptBaseline
    ).attemptCount === "number" &&
    Number.isSafeInteger(
      (
        value as
          DecompositionAttemptBaseline
      ).attemptCount
    ) &&
    (
      value as
        DecompositionAttemptBaseline
    ).attemptCount >= 0 &&
    (
      value as
        DecompositionAttemptBaseline
    ).attemptCount <=
      MAX_ATTEMPT_COUNT &&
    typeof (
      value as
        DecompositionAttemptBaseline
    ).attemptIdsDigest ===
      "string" &&
    DIGEST_PATTERN.test(
      (
        value as
          DecompositionAttemptBaseline
      ).attemptIdsDigest
    )
  );
}

function freezeBaseline(
  baseline:
    DecompositionAttemptBaseline
): DecompositionAttemptBaseline {
  return Object.freeze({
    workItemId:
      baseline.workItemId,
    attemptCount:
      baseline.attemptCount,
    attemptIdsDigest:
      baseline.attemptIdsDigest
  });
}

function unmatchedWindow():
  DecompositionAttemptWindow {
  return Object.freeze({
    matched: false as const,
    attempts:
      Object.freeze([]) as
        readonly []
  });
}

function readIdentifier(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    !ID_PATTERN.test(value)
  ) {
    throw new TypeError(
      "Decomposition attempt baseline identifier is invalid."
    );
  }
  return value;
}

function readExactDataRecord(
  value: unknown,
  expectedKeys:
    readonly string[]
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TypeError(
      "Decomposition approval baseline must be a plain record."
    );
  }
  const prototype =
    Object.getPrototypeOf(value);
  if (
    prototype !==
      Object.prototype &&
    prototype !== null
  ) {
    throw new TypeError(
      "Decomposition approval baseline must be a plain record."
    );
  }
  const descriptors =
    Object.getOwnPropertyDescriptors(
      value
    );
  if (
    Reflect.ownKeys(value).length !==
      expectedKeys.length ||
    expectedKeys.some((key) => {
      const descriptor =
        descriptors[key];
      return (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      );
    })
  ) {
    throw new TypeError(
      "Decomposition approval baseline fields are invalid."
    );
  }
  return value as
    Record<string, unknown>;
}

function compareStrings(
  left: string,
  right: string
) {
  return left < right
    ? -1
    : left > right
      ? 1
      : 0;
}
