import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalizeJson,
  digestCanonicalJson
} from "../src/lib/canonical-json.js";

test("canonical JSON sorts object keys recursively and preserves array order", () => {
  const value = {
    z: 1,
    nested: {
      beta: true,
      alpha: null
    },
    array: [
      { y: "second", x: "first" },
      2,
      1
    ]
  };
  const expected =
    '{"array":[{"x":"first","y":"second"},2,1],"nested":{"alpha":null,"beta":true},"z":1}';

  assert.equal(canonicalizeJson(value), expected);
  assert.equal(
    digestCanonicalJson(value),
    `sha256:${createHash("sha256").update(expected).digest("hex")}`
  );
});

test("canonical JSON follows JSON number and string encoding semantics", () => {
  assert.equal(
    canonicalizeJson({
      negativeZero: -0,
      quote: "\"",
      unicode: "任务"
    }),
    '{"negativeZero":0,"quote":"\\"","unicode":"任务"}'
  );
});

test("canonical JSON rejects values that cannot be represented losslessly", () => {
  const invalidValues = [
    undefined,
    () => {},
    Symbol("not-json"),
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    new Date("2026-07-26T08:00:00.000Z"),
    Object.assign(Object.create({ inherited: true }), {
      own: true
    }),
    [, "sparse"]
  ];

  for (const value of invalidValues) {
    assert.throws(
      () => canonicalizeJson(value),
      hasCode("CANONICAL_JSON_INVALID")
    );
  }
});

test("canonical JSON rejects cycles, accessors, and excessive depth safely", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const accessor = {};
  Object.defineProperty(accessor, "secret", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    }
  });
  let tooDeep = "leaf";

  for (let index = 0; index < 17; index += 1) {
    tooDeep = { child: tooDeep };
  }

  assert.throws(
    () => canonicalizeJson(cyclic),
    hasCode("CANONICAL_JSON_INVALID")
  );
  assert.throws(
    () => canonicalizeJson(accessor),
    hasCode("CANONICAL_JSON_INVALID")
  );
  assert.throws(
    () => canonicalizeJson(tooDeep, { maxDepth: 16 }),
    hasCode("CANONICAL_JSON_DEPTH_EXCEEDED")
  );
});

function hasCode(code) {
  return (error) => error?.code === code;
}
