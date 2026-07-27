import { createHash } from "node:crypto";

export function canonicalizeJson(value, {
  maxDepth = 16
} = {}) {
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new CanonicalJsonError(
      "CANONICAL_JSON_INVALID",
      "Canonical JSON requires a non-negative integer depth limit."
    );
  }

  return serializeJson(value, {
    depth: 0,
    maxDepth,
    ancestors: new Set()
  });
}

export function digestCanonicalJson(value, options) {
  const canonicalJson = canonicalizeJson(value, options);
  const digest = createHash("sha256")
    .update(canonicalJson, "utf8")
    .digest("hex");

  return `sha256:${digest}`;
}

function serializeJson(value, context) {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    requireWellFormedString(value);
    return JSON.stringify(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalidJson();
    }

    return JSON.stringify(value);
  }

  if (typeof value !== "object") {
    throw invalidJson();
  }

  const nextDepth = context.depth + 1;

  if (nextDepth > context.maxDepth) {
    throw new CanonicalJsonError(
      "CANONICAL_JSON_DEPTH_EXCEEDED",
      "Canonical JSON exceeds the configured nesting depth."
    );
  }

  if (context.ancestors.has(value)) {
    throw invalidJson();
  }

  context.ancestors.add(value);

  try {
    const nestedContext = {
      ...context,
      depth: nextDepth
    };

    return Array.isArray(value)
      ? serializeArray(value, nestedContext)
      : serializeObject(value, nestedContext);
  } finally {
    context.ancestors.delete(value);
  }
}

function serializeArray(value, context) {
  const ownKeys = Reflect.ownKeys(value);

  if (
    ownKeys.length !== value.length + 1 ||
    ownKeys.at(-1) !== "length" ||
    ownKeys
      .slice(0, -1)
      .some((key, index) => key !== String(index))
  ) {
    throw invalidJson();
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const items = [];

  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];

    if (
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalidJson();
    }

    items.push(serializeJson(descriptor.value, context));
  }

  return `[${items.join(",")}]`;
}

function serializeObject(value, context) {
  const prototype = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidJson();
  }

  const ownKeys = Reflect.ownKeys(value);

  if (ownKeys.some((key) => typeof key !== "string")) {
    throw invalidJson();
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = ownKeys.sort(compareUtf16CodeUnits);
  const entries = [];

  for (const key of keys) {
    requireWellFormedString(key);
    const descriptor = descriptors[key];

    if (
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalidJson();
    }

    entries.push(
      `${JSON.stringify(key)}:${serializeJson(descriptor.value, context)}`
    );
  }

  return `{${entries.join(",")}}`;
}

function compareUtf16CodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireWellFormedString(value) {
  if (!value.isWellFormed()) {
    throw invalidJson();
  }
}

function invalidJson() {
  return new CanonicalJsonError(
    "CANONICAL_JSON_INVALID",
    "Canonical JSON accepts only finite, acyclic JSON values."
  );
}

export class CanonicalJsonError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CanonicalJsonError";
    this.code = code;
  }
}
