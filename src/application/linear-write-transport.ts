export interface LinearWriteCreateInput {
  clientRequestId: string;
  teamId: string;
  title: string;
  description: string;
}

export interface LinearWriteQueryInput {
  clientRequestId: string;
  teamId: string;
}

export interface LinearWriteObservedPlacementV2 {
  readonly organizationId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly stateId: string;
  readonly parentIssueId: string | null;
}

export interface LinearWriteCreateInputV2
  extends LinearWriteObservedPlacementV2 {
  readonly clientRequestId: string;
  readonly title: string;
  readonly description: string;
}

export interface LinearWriteQueryInputV2
  extends LinearWriteObservedPlacementV2 {
  readonly clientRequestId: string;
}

export interface LinearWriteIssueIdentity {
  readonly id: string;
  readonly identifier: string;
}

export type LinearWriteCreateResult =
  | {
      readonly kind: "created";
      readonly issue: LinearWriteIssueIdentity;
      readonly observedTeamId: string;
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

export type LinearWriteQueryResult =
  | {
      readonly kind: "found";
      readonly issue: LinearWriteIssueIdentity;
      readonly observedTeamId: string;
    }
  | {
      readonly kind: "absent";
    }
  | {
      readonly kind: "failed";
      readonly diagnosticCode:
        "LINEAR_RECONCILIATION_FAILED";
    }
  | {
      readonly kind: "ambiguous";
      readonly diagnosticCode:
        "LINEAR_RECONCILIATION_AMBIGUOUS";
    };

export type LinearWriteCreateResultV2 =
  | {
      readonly kind: "created";
      readonly issue: LinearWriteIssueIdentity;
      readonly observedPlacement:
        LinearWriteObservedPlacementV2;
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

export type LinearWriteQueryResultV2 =
  | {
      readonly kind: "found";
      readonly issue: LinearWriteIssueIdentity;
      readonly observedPlacement:
        LinearWriteObservedPlacementV2;
    }
  | {
      readonly kind: "absent";
    }
  | {
      readonly kind: "failed";
      readonly diagnosticCode:
        "LINEAR_RECONCILIATION_FAILED";
    }
  | {
      readonly kind: "ambiguous";
      readonly diagnosticCode:
        "LINEAR_RECONCILIATION_AMBIGUOUS";
    };

export interface LinearWriteTransportPort {
  createIssue(
    input: LinearWriteCreateInput
  ): Promise<LinearWriteCreateResult>;
  queryByClientUuid(
    input: LinearWriteQueryInput
  ): Promise<LinearWriteQueryResult>;
}

export interface LinearWriteTransportV2Port {
  createIssueV2(
    input: LinearWriteCreateInputV2
  ): Promise<LinearWriteCreateResultV2>;
  queryByClientUuidV2(
    input: LinearWriteQueryInputV2
  ): Promise<LinearWriteQueryResultV2>;
}
