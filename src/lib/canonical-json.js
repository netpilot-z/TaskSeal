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

export function assertJsonWithinLimits(value, {
  maxDepth = 16,
  maxBytes,
  maxArrayLength,
  maxObjectKeys
} = {}) {
  for (const [name, limit] of [
    ["maxDepth", maxDepth],
    ["maxBytes", maxBytes],
    ["maxArrayLength", maxArrayLength],
    ["maxObjectKeys", maxObjectKeys]
  ]) {
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) || limit < 0)
    ) {
      throw new CanonicalJsonError(
        "CANONICAL_JSON_INVALID",
        `Canonical JSON ${name} must be a non-negative safe integer.`
      );
    }
  }

  inspectJson(value, {
    depth: 0,
    maxDepth,
    maxBytes: maxBytes ?? Number.MAX_SAFE_INTEGER,
    maxArrayLength:
      maxArrayLength ?? Number.MAX_SAFE_INTEGER,
    maxObjectKeys:
      maxObjectKeys ?? Number.MAX_SAFE_INTEGER,
    bytes: 0,
    ancestors: new Set()
  });
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

function inspectJson(value, context) {
  if (value === null) {
    consumeBytes(context, 4);
    return;
  }

  if (typeof value === "string") {
    requireWellFormedString(value);
    consumeBytes(context, jsonStringByteLength(value));
    return;
  }

  if (typeof value === "boolean") {
    consumeBytes(context, value ? 4 : 5);
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalidJson();
    }

    consumeBytes(
      context,
      Buffer.byteLength(JSON.stringify(value), "utf8")
    );
    return;
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
      depth: nextDepth,
      ancestors: context.ancestors
    };

    if (Array.isArray(value)) {
      inspectArray(value, nestedContext);
    } else {
      inspectObject(value, nestedContext);
    }

    context.bytes = nestedContext.bytes;
  } finally {
    context.ancestors.delete(value);
  }
}

function inspectArray(value, context) {
  if (value.length > context.maxArrayLength) {
    throw jsonLimitExceeded("array length");
  }

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
  consumeBytes(context, 2 + Math.max(0, value.length - 1));

  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];

    if (
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalidJson();
    }

    inspectJson(descriptor.value, context);
  }
}

function inspectObject(value, context) {
  const prototype = Object.getPrototypeOf(value);

  if (
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw invalidJson();
  }

  const ownKeys = Reflect.ownKeys(value);

  if (
    ownKeys.some((key) => typeof key !== "string")
  ) {
    throw invalidJson();
  }

  if (ownKeys.length > context.maxObjectKeys) {
    throw jsonLimitExceeded("object field count");
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  consumeBytes(context, 2 + Math.max(0, ownKeys.length - 1));

  for (const key of ownKeys) {
    requireWellFormedString(key);
    const descriptor = descriptors[key];

    if (
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalidJson();
    }

    consumeBytes(
      context,
      jsonStringByteLength(key) + 1
    );
    inspectJson(descriptor.value, context);
  }
}

function jsonStringByteLength(value) {
  let bytes = 2;

  for (const character of value) {
    const codePoint = character.codePointAt(0);

    if (character === "\"" || character === "\\") {
      bytes += 2;
    } else if (codePoint <= 0x1f) {
      bytes += [0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(
        codePoint
      )
        ? 2
        : 6;
    } else if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }

  return bytes;
}

function consumeBytes(context, bytes) {
  context.bytes += bytes;

  if (context.bytes > context.maxBytes) {
    throw jsonLimitExceeded("encoded bytes");
  }
}

function jsonLimitExceeded(field) {
  return new CanonicalJsonError(
    "CANONICAL_JSON_LIMIT_EXCEEDED",
    `Canonical JSON ${field} exceeds the configured limit.`
  );
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
