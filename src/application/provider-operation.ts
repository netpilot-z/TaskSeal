import {
  parseControlledTransitionOperation,
  validateControlledTransitionOperationTransition
} from "./controlled-transition-operation.ts";
import type {
  ControlledTransitionOperation
} from "./controlled-transition-operation.ts";
import {
  parseControlledWriteOperation,
  validateControlledWriteOperationTransition
} from "./controlled-write-operation.ts";
import type {
  ControlledWriteOperation
} from "./controlled-write-operation.ts";

export type ProviderOperation =
  | ControlledWriteOperation
  | ControlledTransitionOperation;

export function parseProviderOperation(
  value: unknown
): ProviderOperation {
  try {
    return parseControlledWriteOperation(
      value
    );
  } catch {
    try {
      return parseControlledTransitionOperation(
        value
      );
    } catch {
      throw invalidProviderOperation();
    }
  }
}

export function validateProviderOperationTransition(
  previousValue: unknown,
  nextValue: unknown
): ProviderOperation {
  const previous =
    parseProviderOperation(previousValue);
  const next =
    parseProviderOperation(nextValue);
  try {
    if (
      previous.schemaVersion === 3 &&
      next.schemaVersion === 3
    ) {
      return validateControlledTransitionOperationTransition(
        previous,
        next
      );
    }
    if (
      previous.schemaVersion !== 3 &&
      next.schemaVersion !== 3
    ) {
      return validateControlledWriteOperationTransition(
        previous,
        next
      );
    }
  } catch {
    throw invalidProviderOperationPair();
  }
  throw invalidProviderOperationPair();
}

export class ProviderOperationError
  extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProviderOperationError";
    this.code = code;
  }
}

function invalidProviderOperation(): ProviderOperationError {
  return new ProviderOperationError(
    "PROVIDER_OPERATION_INVALID",
    "The provider operation is invalid."
  );
}

function invalidProviderOperationPair(): ProviderOperationError {
  return new ProviderOperationError(
    "PROVIDER_OPERATION_PAIR_INVALID",
    "The provider operation transition is invalid."
  );
}
