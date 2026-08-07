import assert from "node:assert/strict";
import test from "node:test";

import {
  createPresentation,
  getPresentationCatalog,
  resolveLocale
} from "../src/presentation/i18n.ts";
import type {
  PresentationMessageKey
} from "../src/presentation/i18n.ts";

test("locale resolution applies session, command, user, detected, and English fallback precedence", () => {
  assert.equal(
    resolveLocale({
      session: "zh-Hans",
      command: "en",
      user: "en",
      detected: ["en-US"]
    }),
    "zh-CN"
  );
  assert.equal(
    resolveLocale({
      session: "auto",
      command: "unsupported",
      user: "zh",
      detected: ["en-US"]
    }),
    "zh-CN"
  );
  assert.equal(
    resolveLocale({
      user: "auto",
      detected: ["fr-FR", "zh-CN"]
    }),
    "zh-CN"
  );
  assert.equal(
    resolveLocale({
      detected: ["fr-FR"]
    }),
    "en"
  );
});

test("English and Simplified Chinese catalogs keep identical keys and placeholders", () => {
  const english = getPresentationCatalog("en");
  const chinese = getPresentationCatalog("zh-CN");

  assert.deepEqual(
    Object.keys(chinese).sort(),
    Object.keys(english).sort()
  );

  for (const key of Object.keys(english) as PresentationMessageKey[]) {
    assert.deepEqual(
      placeholders(chinese[key]),
      placeholders(english[key]),
      key
    );
  }
});

test("presentation localizes messages and formats values without changing message keys", () => {
  const english = createPresentation("en");
  const chinese = createPresentation("zh-CN");

  assert.equal(
    english.message("config.field.source", {
      field: "project",
      source: "project"
    }),
    "project comes from project."
  );
  assert.equal(
    chinese.message("config.field.source", {
      field: "project",
      source: "project"
    }),
    "project 来自 project。"
  );
  assert.equal(english.number(1234.5), "1,234.5");
  assert.equal(chinese.number(1234.5), "1,234.5");
  assert.match(
    english.dateTime("2026-08-03T12:34:00Z", {
      timeZone: "UTC"
    }),
    /2026/
  );
  assert.match(
    chinese.dateTime("2026-08-03T12:34:00Z", {
      timeZone: "UTC"
    }),
    /2026/
  );
});

test("presentation fails closed for unknown keys, missing parameters, and invalid dates", () => {
  const presentation = createPresentation("en");

  assert.throws(
    () =>
      presentation.message(
        "unknown.message" as PresentationMessageKey
      ),
    hasCode("PRESENTATION_MESSAGE_UNKNOWN")
  );
  assert.throws(
    () => presentation.message("config.field.source", {
      field: "project"
    }),
    hasCode("PRESENTATION_PARAMETER_MISSING")
  );
  assert.throws(
    () => presentation.dateTime("not-a-date"),
    hasCode("PRESENTATION_DATE_INVALID")
  );
});

test("catalogs cover every current configuration diagnostic message key", () => {
  const presentation = createPresentation("en");
  const diagnosticKeys = [
    "config.project.invalid",
    "config.github.invalid",
    "config.linear.invalid",
    "config.gitee.invalid",
    "config.feishu.invalid",
    "config.user.invalid",
    "config.local.invalid",
    "config.environment.invalid",
    "config.command.invalid"
  ] as const;

  for (const key of diagnosticKeys) {
    assert.doesNotThrow(() => presentation.message(key));
  }
});

function placeholders(value: string): string[] {
  return [
    ...value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)
  ]
    .map((match) => match[1]!)
    .sort();
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code;
}
