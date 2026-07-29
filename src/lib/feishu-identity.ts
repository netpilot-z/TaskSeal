import {
  digestCanonicalJson
} from "./canonical-json.ts";

export interface FeishuTableScope {
  readonly kind: "table";
  readonly key: string;
  readonly parentKey: string;
}

const RESOURCE_IDENTIFIER_PATTERN =
  /^[A-Za-z0-9_-]{1,64}$/;

export function createFeishuTableScope({
  appToken,
  tableId
}: {
  readonly appToken: string;
  readonly tableId: string;
}): FeishuTableScope {
  requireResourceIdentifier(appToken);
  requireResourceIdentifier(tableId);
  const baseDigest = digestCanonicalJson({
    schemaVersion: 1,
    provider: "feishu",
    kind: "base",
    appToken
  });
  const tableDigest = digestCanonicalJson({
    schemaVersion: 1,
    provider: "feishu",
    kind: "table",
    appToken,
    tableId
  });

  return {
    kind: "table",
    key: `feishu:table:${tableDigest}`,
    parentKey: `feishu:base:${baseDigest}`
  };
}

function requireResourceIdentifier(
  value: unknown
): string {
  if (
    typeof value !== "string" ||
    !RESOURCE_IDENTIFIER_PATTERN.test(value)
  ) {
    throw new TypeError(
      "Feishu resource identity is invalid."
    );
  }
  return value;
}
