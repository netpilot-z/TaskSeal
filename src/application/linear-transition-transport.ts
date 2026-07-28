import type {
  ControlledTransitionObservedIssue
} from "./controlled-transition-operation.ts";

export interface LinearTransitionGraphqlRequest {
  readonly schemaVersion: 1;
  readonly operation:
    | "read_transition_issue"
    | "update_transition_state";
  readonly body: string;
}

export type LinearTransitionGraphqlExchangeResult =
  | {
      readonly kind: "not_dispatched";
    }
  | {
      readonly kind: "response_lost";
    }
  | {
      readonly kind: "response";
      readonly status: number;
      readonly body: string;
    };

export type LinearTransitionGraphqlExchange = (
  request: unknown
) => Promise<LinearTransitionGraphqlExchangeResult>;

export interface LinearTransitionObservedIssue
  extends ControlledTransitionObservedIssue {
  readonly stateType: string;
}

export type LinearTransitionReadResult =
  | {
      readonly kind: "found";
      readonly issue:
        LinearTransitionObservedIssue;
    }
  | {
      readonly kind: "missing";
    }
  | {
      readonly kind: "failed";
      readonly diagnosticCode:
        "LINEAR_RECONCILIATION_FAILED";
    };

export type LinearTransitionUpdateResult =
  | {
      readonly kind: "dispatched";
    }
  | {
      readonly kind: "not_dispatched";
      readonly diagnosticCode:
        "LINEAR_WRITE_NOT_DISPATCHED";
    }
  | {
      readonly kind: "outcome_unknown";
      readonly diagnosticCode:
        "LINEAR_WRITE_OUTCOME_UNKNOWN";
    };

export interface LinearTransitionTransportPort {
  readIssue(input: {
    readonly issueId: string;
  }): Promise<LinearTransitionReadResult>;
  updateIssueState(input: {
    readonly issueId: string;
    readonly stateId: string;
  }): Promise<LinearTransitionUpdateResult>;
}
