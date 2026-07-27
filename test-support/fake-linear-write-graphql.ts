import {
  LINEAR_WRITE_RESPONSE_BYTE_LIMIT
} from "../src/connectors/linear-write-transport.ts";
import type {
  LinearWriteGraphqlExchange,
  LinearWriteGraphqlExchangeResult,
  LinearWriteGraphqlRequest
} from "../src/connectors/linear-write-transport.ts";

export type FakeLinearCreateMode =
  | "success"
  | "not_dispatched"
  | "response_lost"
  | "http_error"
  | "graphql_error"
  | "timeout"
  | "malformed_response"
  | "oversized_response"
  | "correlation_mismatch"
  | "id_mismatch"
  | "identifier_mismatch"
  | "success_false";

export type FakeLinearQueryMode =
  | "normal"
  | "ambiguous"
  | "id_mismatch"
  | "identifier_mismatch"
  | "response_lost"
  | "http_error"
  | "graphql_error"
  | "timeout"
  | "malformed_response"
  | "oversized_response";

export interface FakeLinearWriteGraphqlOptions {
  createMode?: FakeLinearCreateMode;
  queryMode?: FakeLinearQueryMode;
  identifier?: string;
  teamId?: string;
  rawErrorText?: string;
}

interface FakeIssue {
  id: string;
  identifier: string;
  teamId: string;
}

const AMBIGUOUS_TEAM_ID =
  "44444444-4444-4444-8444-444444444444";

export class FakeLinearWriteGraphql {
  readonly #createMode: FakeLinearCreateMode;
  readonly #queryMode: FakeLinearQueryMode;
  readonly #identifier: string;
  readonly #teamId: string;
  readonly #rawErrorText: string;
  readonly #requests: LinearWriteGraphqlRequest[] =
    [];
  readonly #issues = new Map<string, FakeIssue>();
  #externalWriteCount = 0;

  constructor({
    createMode = "success",
    queryMode = "normal",
    identifier = "NP-101",
    teamId =
      "22222222-2222-4222-8222-222222222222",
    rawErrorText = "fake provider failure"
  }: FakeLinearWriteGraphqlOptions = {}) {
    this.#createMode = createMode;
    this.#queryMode = queryMode;
    this.#identifier = identifier;
    this.#teamId = teamId;
    this.#rawErrorText = rawErrorText;
  }

  get requests(): readonly LinearWriteGraphqlRequest[] {
    return Object.freeze([...this.#requests]);
  }

  get requestCount(): number {
    return this.#requests.length;
  }

  get externalWriteCount(): number {
    return this.#externalWriteCount;
  }

  readonly exchange: LinearWriteGraphqlExchange =
    async (request) => {
      this.#requests.push(request);
      if (request.operation === "issue_create") {
        return this.handleCreate(request);
      }
      return this.handleQuery(request);
    };

  private async handleCreate(
    request: LinearWriteGraphqlRequest
  ): Promise<LinearWriteGraphqlExchangeResult> {
    const input = readCreateInput(request);

    if (this.#createMode === "not_dispatched") {
      return {
        kind: "not_dispatched"
      };
    }

    this.#externalWriteCount += 1;
    const issue: FakeIssue = {
      id: input.id,
      identifier: this.#identifier,
      teamId: input.teamId
    };

    if (
      this.#createMode === "success" ||
      this.#createMode === "response_lost"
    ) {
      this.#issues.set(issue.id, issue);
    }

    if (this.#createMode === "response_lost") {
      return {
        kind: "response_lost"
      };
    }
    if (this.#createMode === "timeout") {
      throw new Error(this.#rawErrorText);
    }
    if (this.#createMode === "http_error") {
      return rawResponse(
        503,
        this.#rawErrorText
      );
    }
    if (this.#createMode === "graphql_error") {
      return jsonResponse({
        errors: [
          {
            message: this.#rawErrorText
          }
        ]
      });
    }
    if (
      this.#createMode ===
      "malformed_response"
    ) {
      return jsonResponse({
        data: {
          issueCreate: {
            success: true,
            issue: {
              raw: this.#rawErrorText
            }
          }
        }
      });
    }
    if (
      this.#createMode ===
      "oversized_response"
    ) {
      return rawResponse(
        200,
        "x".repeat(
          LINEAR_WRITE_RESPONSE_BYTE_LIMIT + 1
        )
      );
    }
    if (this.#createMode === "success_false") {
      return jsonResponse({
        data: {
          issueCreate: {
            success: false,
            issue: null
          }
        }
      });
    }

    let responseIssue = issue;
    if (
      this.#createMode ===
      "correlation_mismatch"
    ) {
      responseIssue = {
        ...issue,
        teamId: AMBIGUOUS_TEAM_ID
      };
    } else if (
      this.#createMode === "id_mismatch"
    ) {
      responseIssue = {
        ...issue,
        id: "55555555-5555-4555-8555-555555555555"
      };
    } else if (
      this.#createMode ===
      "identifier_mismatch"
    ) {
      responseIssue = {
        ...issue,
        identifier: "not-a-linear-identifier"
      };
    }

    return jsonResponse({
      data: {
        issueCreate: {
          success: true,
          issue: presentIssue(responseIssue)
        }
      }
    });
  }

  private async handleQuery(
    request: LinearWriteGraphqlRequest
  ): Promise<LinearWriteGraphqlExchangeResult> {
    const id = readQueryId(request);

    if (this.#queryMode === "response_lost") {
      return {
        kind: "response_lost"
      };
    }
    if (this.#queryMode === "timeout") {
      throw new Error(this.#rawErrorText);
    }
    if (this.#queryMode === "http_error") {
      return rawResponse(
        503,
        this.#rawErrorText
      );
    }
    if (this.#queryMode === "graphql_error") {
      return jsonResponse({
        errors: [
          {
            message: this.#rawErrorText
          }
        ]
      });
    }
    if (
      this.#queryMode ===
      "malformed_response"
    ) {
      return jsonResponse({
        data: {
          issue: {
            raw: this.#rawErrorText
          }
        }
      });
    }
    if (
      this.#queryMode ===
      "oversized_response"
    ) {
      return rawResponse(
        200,
        "x".repeat(
          LINEAR_WRITE_RESPONSE_BYTE_LIMIT + 1
        )
      );
    }
    if (this.#queryMode === "ambiguous") {
      return jsonResponse({
        data: {
          issue: presentIssue({
            id,
            identifier: this.#identifier,
            teamId: AMBIGUOUS_TEAM_ID
          })
        }
      });
    }
    if (this.#queryMode === "id_mismatch") {
      return jsonResponse({
        data: {
          issue: presentIssue({
            id: "55555555-5555-4555-8555-555555555555",
            identifier: this.#identifier,
            teamId: this.#teamId
          })
        }
      });
    }
    if (
      this.#queryMode ===
      "identifier_mismatch"
    ) {
      return jsonResponse({
        data: {
          issue: presentIssue({
            id,
            identifier: "not-a-linear-identifier",
            teamId: this.#teamId
          })
        }
      });
    }

    const issue = this.#issues.get(id);
    return jsonResponse({
      data: {
        issue:
          issue === undefined
            ? null
            : presentIssue(issue)
      }
    });
  }
}

function readCreateInput(
  request: LinearWriteGraphqlRequest
): {
  id: string;
  teamId: string;
} {
  const body = parseBody(request.body);
  const variables = requireRecord(body.variables);
  const input = requireRecord(variables.input);
  return {
    id: requireString(input.id),
    teamId: requireString(input.teamId)
  };
}

function readQueryId(
  request: LinearWriteGraphqlRequest
): string {
  const body = parseBody(request.body);
  const variables = requireRecord(body.variables);
  return requireString(variables.id);
}

function parseBody(
  body: string
): Record<string, unknown> {
  return requireRecord(JSON.parse(body));
}

function presentIssue(issue: FakeIssue): {
  id: string;
  identifier: string;
  team: {
    id: string;
  };
} {
  return {
    id: issue.id,
    identifier: issue.identifier,
    team: {
      id: issue.teamId
    }
  };
}

function jsonResponse(
  body: unknown
): LinearWriteGraphqlExchangeResult {
  return rawResponse(200, JSON.stringify(body));
}

function rawResponse(
  status: number,
  body: string
): LinearWriteGraphqlExchangeResult {
  return {
    kind: "response",
    status,
    body
  };
}

function requireRecord(
  value: unknown
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(
      "Fake Linear request is invalid."
    );
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError(
      "Fake Linear request is invalid."
    );
  }
  return value;
}
