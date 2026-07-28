import type {
  LinearAcceptanceCoordinates,
  LinearBootstrapCoordinates,
  LinearReadyWorkCoordinates
} from "../config/project-config.ts";
import {
  LINEAR_GRAPHQL_REQUEST_BYTE_LIMIT,
  LINEAR_GRAPHQL_RESPONSE_BYTE_LIMIT
} from "./linear-graphql-http-exchange.ts";

const PAGE_SIZE = 50;
const MAXIMUM_PAGES = 20;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_NAME_PATTERN =
  /^[A-Za-z][A-Za-z0-9]{0,63}$/;

const RESOLVE_SCOPE_QUERY =
  `query TaskSealResolveBootstrapScope($after: String) {
  organization {
    id
    name
    urlKey
  }
  teams(first: 50, after: $after) {
    nodes {
      id
      name
      key
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

const RESOLVE_PROJECTS_QUERY =
  `query TaskSealResolveBootstrapProjects($after: String) {
  projects(first: 50, after: $after) {
    nodes {
      id
      name
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

const RESOLVE_PROJECT_TEAMS_QUERY =
  `query TaskSealResolveBootstrapProjectTeams($projectId: String!, $after: String) {
  project(id: $projectId) {
    id
    teams(first: 50, after: $after) {
      nodes {
        id
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;

const RESOLVE_TEAM_STATES_QUERY =
  `query TaskSealResolveBootstrapTeamStates($teamId: String!, $after: String) {
  team(id: $teamId) {
    id
    states(first: 50, after: $after) {
      nodes {
        id
        name
        type
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;

export interface LinearBootstrapGraphqlRequest {
  readonly schemaVersion: 1;
  readonly operation:
    | "resolve_scope"
    | "resolve_projects"
    | "resolve_project_teams"
    | "resolve_team_states";
  readonly body: string;
}

export type LinearBootstrapGraphqlExchange = (
  request: LinearBootstrapGraphqlRequest
) => Promise<unknown>;

export interface ResolvedLinearBootstrapScope {
  readonly organizationId: string;
  readonly teamId: string;
  readonly teamKey: string;
  readonly projectId: string;
  readonly stateId: string;
}

export interface ResolvedLinearReadyWorkScope {
  readonly organizationId: string;
  readonly teamId: string;
  readonly teamKey: string;
  readonly projectId: string;
  readonly readyStateId: string;
  readonly completedStateId: string;
}

export interface ResolvedLinearAcceptanceScope {
  readonly organizationId: string;
  readonly teamId: string;
  readonly teamKey: string;
  readonly projectId: string;
  readonly expectedStateId: string;
  readonly targetStateId: string;
}

interface Organization {
  readonly id: string;
  readonly name: string;
  readonly urlKey: string;
}

interface Team {
  readonly id: string;
  readonly name: string;
  readonly key: string;
}

interface Project {
  readonly id: string;
  readonly name: string;
}

interface WorkflowState {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

interface Connection {
  readonly nodes: readonly unknown[];
  readonly pageInfo: {
    readonly hasNextPage: boolean;
    readonly endCursor: unknown;
  };
}

interface ResolveLinearBootstrapScopeOptions {
  readonly configuredTarget:
    LinearBootstrapCoordinates;
  readonly exchange: LinearBootstrapGraphqlExchange;
}

interface ResolveLinearReadyWorkScopeOptions {
  readonly configuredTarget: Pick<
    LinearReadyWorkCoordinates,
    | "workspace"
    | "team"
    | "project"
    | "readyState"
    | "completedState"
  >;
  readonly exchange: LinearBootstrapGraphqlExchange;
}

interface ResolveLinearAcceptanceScopeOptions {
  readonly configuredTarget: Pick<
    Extract<
      LinearAcceptanceCoordinates,
      { enabled: true }
    >,
    | "workspace"
    | "team"
    | "project"
    | "expectedState"
    | "targetState"
  >;
  readonly exchange:
    LinearBootstrapGraphqlExchange;
}

interface ResolvedLinearProjectScope {
  readonly organization: Organization;
  readonly team: Team;
  readonly project: Project;
  readonly states: readonly WorkflowState[];
}

export async function resolveLinearBootstrapScope(
  optionsValue: unknown
): Promise<ResolvedLinearBootstrapScope> {
  const { configuredTarget, exchange } =
    normalizeOptions(optionsValue);
  const {
    organization,
    team,
    project,
    states
  } = await resolveLinearProjectScope({
    configuredTarget,
    exchange
  });
  const state = selectUnique(
    uniqueById(states).filter((candidate) =>
      matchesReference(
        candidate.name,
        configuredTarget.backlogState
      )
    ),
    {
      notFoundCode:
        "LINEAR_BOOTSTRAP_STATE_NOT_FOUND",
      ambiguousCode:
        "LINEAR_BOOTSTRAP_STATE_AMBIGUOUS",
      label: "Linear bootstrap state"
    }
  );

  if (state.type !== "backlog") {
    throw bootstrapError(
      "LINEAR_BOOTSTRAP_STATE_TYPE_INVALID",
      "Configured Linear bootstrap state is not a backlog workflow state."
    );
  }

  return Object.freeze({
    organizationId: organization.id,
    teamId: team.id,
    teamKey: team.key,
    projectId: project.id,
    stateId: state.id
  });
}

export async function resolveLinearReadyWorkScope(
  optionsValue: unknown
): Promise<ResolvedLinearReadyWorkScope> {
  const { configuredTarget, exchange } =
    normalizeReadyOptions(optionsValue);
  const {
    organization,
    team,
    project,
    states
  } = await resolveLinearProjectScope({
    configuredTarget,
    exchange
  });
  const uniqueStates = uniqueById(states);
  const readyState = selectUnique(
    uniqueStates.filter((candidate) =>
      matchesReference(
        candidate.name,
        configuredTarget.readyState
      )
    ),
    {
      notFoundCode:
        "LINEAR_READY_STATE_NOT_FOUND",
      ambiguousCode:
        "LINEAR_READY_STATE_AMBIGUOUS",
      label: "Linear ready state"
    }
  );
  const completedState = selectUnique(
    uniqueStates.filter((candidate) =>
      matchesReference(
        candidate.name,
        configuredTarget.completedState
      )
    ),
    {
      notFoundCode:
        "LINEAR_READY_COMPLETED_STATE_NOT_FOUND",
      ambiguousCode:
        "LINEAR_READY_COMPLETED_STATE_AMBIGUOUS",
      label: "Linear completed state"
    }
  );

  if (readyState.type !== "unstarted") {
    throw bootstrapError(
      "LINEAR_READY_STATE_TYPE_INVALID",
      "Configured Linear ready state is not an unstarted workflow state."
    );
  }

  if (completedState.type !== "completed") {
    throw bootstrapError(
      "LINEAR_READY_COMPLETED_STATE_TYPE_INVALID",
      "Configured Linear completed state is not a completed workflow state."
    );
  }

  if (readyState.id === completedState.id) {
    throw bootstrapError(
      "LINEAR_READY_STATE_IDENTITY_CONFLICT",
      "Linear ready and completed states must be distinct."
    );
  }

  return Object.freeze({
    organizationId: organization.id,
    teamId: team.id,
    teamKey: team.key,
    projectId: project.id,
    readyStateId: readyState.id,
    completedStateId: completedState.id
  });
}

export async function resolveLinearAcceptanceScope(
  optionsValue: unknown
): Promise<ResolvedLinearAcceptanceScope> {
  const { configuredTarget, exchange } =
    normalizeAcceptanceOptions(
      optionsValue
    );
  const {
    organization,
    team,
    project,
    states
  } = await resolveLinearProjectScope({
    configuredTarget,
    exchange
  });
  const uniqueStates = uniqueById(states);
  const expectedState = selectUnique(
    uniqueStates.filter((candidate) =>
      matchesReference(
        candidate.name,
        configuredTarget.expectedState
      )
    ),
    {
      notFoundCode:
        "LINEAR_ACCEPTANCE_EXPECTED_STATE_NOT_FOUND",
      ambiguousCode:
        "LINEAR_ACCEPTANCE_EXPECTED_STATE_AMBIGUOUS",
      label:
        "Linear acceptance expected state"
    }
  );
  const targetState = selectUnique(
    uniqueStates.filter((candidate) =>
      matchesReference(
        candidate.name,
        configuredTarget.targetState
      )
    ),
    {
      notFoundCode:
        "LINEAR_ACCEPTANCE_TARGET_STATE_NOT_FOUND",
      ambiguousCode:
        "LINEAR_ACCEPTANCE_TARGET_STATE_AMBIGUOUS",
      label:
        "Linear acceptance target state"
    }
  );

  if (
    expectedState.type !== "started" &&
    expectedState.type !== "unstarted"
  ) {
    throw bootstrapError(
      "LINEAR_ACCEPTANCE_EXPECTED_STATE_TYPE_INVALID",
      "Configured Linear acceptance expected state is terminal."
    );
  }
  if (targetState.type !== "completed") {
    throw bootstrapError(
      "LINEAR_ACCEPTANCE_TARGET_STATE_TYPE_INVALID",
      "Configured Linear acceptance target state is not completed."
    );
  }
  if (expectedState.id === targetState.id) {
    throw bootstrapError(
      "LINEAR_ACCEPTANCE_STATE_IDENTITY_CONFLICT",
      "Linear acceptance states must be distinct."
    );
  }

  return Object.freeze({
    organizationId: organization.id,
    teamId: team.id,
    teamKey: team.key,
    projectId: project.id,
    expectedStateId:
      expectedState.id,
    targetStateId: targetState.id
  });
}

async function resolveLinearProjectScope({
  configuredTarget,
  exchange
}: {
  readonly configuredTarget: {
    readonly workspace: string;
    readonly team: string;
    readonly project: string;
  };
  readonly exchange: LinearBootstrapGraphqlExchange;
}): Promise<ResolvedLinearProjectScope> {
  const { organization, teams } =
    await resolveOrganizationAndTeams(exchange);
  validateWorkspace(
    organization,
    configuredTarget.workspace
  );
  const team = selectUnique(
    uniqueById(teams).filter(
      (candidate) =>
        matchesReference(
          candidate.name,
          configuredTarget.team
        ) ||
        matchesReference(
          candidate.key,
          configuredTarget.team
        )
    ),
    {
      notFoundCode:
        "LINEAR_BOOTSTRAP_TEAM_NOT_FOUND",
      ambiguousCode:
        "LINEAR_BOOTSTRAP_TEAM_AMBIGUOUS",
      label: "Linear team"
    }
  );
  const projects = await resolveProjects(exchange);
  const project = selectUnique(
    uniqueById(projects).filter((candidate) =>
      matchesReference(
        candidate.name,
        configuredTarget.project
      )
    ),
    {
      notFoundCode:
        "LINEAR_BOOTSTRAP_PROJECT_NOT_FOUND",
      ambiguousCode:
        "LINEAR_BOOTSTRAP_PROJECT_AMBIGUOUS",
      label: "Linear project"
    }
  );
  const projectTeamIds =
    await resolveProjectTeamIds(
      exchange,
      project.id
    );

  if (!projectTeamIds.has(team.id)) {
    throw bootstrapError(
      "LINEAR_BOOTSTRAP_PROJECT_TEAM_MISMATCH",
      "Configured Linear project does not belong to the configured team."
    );
  }

  const states = await resolveTeamStates(
    exchange,
    team.id
  );

  return {
    organization,
    team,
    project,
    states
  };
}

async function resolveOrganizationAndTeams(
  exchange: LinearBootstrapGraphqlExchange
): Promise<{
  readonly organization: Organization;
  readonly teams: readonly Team[];
}> {
  let after: string | null = null;
  let organization: Organization | null =
    null;
  const teams: Team[] = [];
  const visited = new Set<string>();

  for (let page = 0; ; page += 1) {
    enforcePageLimit(page);
    const data = await requestGraphql({
      exchange,
      operation: "resolve_scope",
      operationName:
        "TaskSealResolveBootstrapScope",
      query: RESOLVE_SCOPE_QUERY,
      variables: { after }
    });
    const currentOrganization =
      parseOrganization(data.organization);
    const connection = parseConnection(
      data.teams
    );

    if (
      organization !== null &&
      (organization.id !==
        currentOrganization.id ||
        organization.name !==
          currentOrganization.name ||
        organization.urlKey !==
          currentOrganization.urlKey)
    ) {
      throw bootstrapError(
        "LINEAR_BOOTSTRAP_RESPONSE_INVALID",
        "Linear organization changed during pagination."
      );
    }

    organization = currentOrganization;
    teams.push(
      ...connection.nodes.map(parseTeam)
    );
    const next = readNextCursor(
      connection,
      visited
    );

    if (next === null) {
      break;
    }

    after = next;
  }

  if (organization === null) {
    throw bootstrapError(
      "LINEAR_BOOTSTRAP_RESPONSE_INVALID",
      "Linear organization response is invalid."
    );
  }

  return { organization, teams };
}

async function resolveProjects(
  exchange: LinearBootstrapGraphqlExchange
): Promise<readonly Project[]> {
  let after: string | null = null;
  const projects: Project[] = [];
  const visited = new Set<string>();

  for (let page = 0; ; page += 1) {
    enforcePageLimit(page);
    const data = await requestGraphql({
      exchange,
      operation: "resolve_projects",
      operationName:
        "TaskSealResolveBootstrapProjects",
      query: RESOLVE_PROJECTS_QUERY,
      variables: { after }
    });
    const connection = parseConnection(
      data.projects
    );
    projects.push(
      ...connection.nodes.map(parseProject)
    );
    const next = readNextCursor(
      connection,
      visited
    );

    if (next === null) {
      break;
    }

    after = next;
  }

  return projects;
}

async function resolveProjectTeamIds(
  exchange: LinearBootstrapGraphqlExchange,
  projectId: string
): Promise<ReadonlySet<string>> {
  let after: string | null = null;
  const teamIds = new Set<string>();
  const visited = new Set<string>();

  for (let page = 0; ; page += 1) {
    enforcePageLimit(page);
    const data = await requestGraphql({
      exchange,
      operation: "resolve_project_teams",
      operationName:
        "TaskSealResolveBootstrapProjectTeams",
      query: RESOLVE_PROJECT_TEAMS_QUERY,
      variables: {
        projectId,
        after
      }
    });
    const project = readDataRecord(
      data.project
    );

    if (project.id !== projectId) {
      throw bootstrapError(
        "LINEAR_BOOTSTRAP_RESPONSE_INVALID",
        "Linear project identity changed during pagination."
      );
    }

    const connection = parseConnection(
      project.teams
    );

    for (const node of connection.nodes) {
      const team = readDataRecord(node);
      teamIds.add(
        parseUuid(team.id, "project team")
      );
    }

    const next = readNextCursor(
      connection,
      visited
    );

    if (next === null) {
      break;
    }

    after = next;
  }

  return teamIds;
}

async function resolveTeamStates(
  exchange: LinearBootstrapGraphqlExchange,
  teamId: string
): Promise<readonly WorkflowState[]> {
  let after: string | null = null;
  const states: WorkflowState[] = [];
  const visited = new Set<string>();

  for (let page = 0; ; page += 1) {
    enforcePageLimit(page);
    const data = await requestGraphql({
      exchange,
      operation: "resolve_team_states",
      operationName:
        "TaskSealResolveBootstrapTeamStates",
      query: RESOLVE_TEAM_STATES_QUERY,
      variables: {
        teamId,
        after
      }
    });
    const team = readDataRecord(data.team);

    if (team.id !== teamId) {
      throw bootstrapError(
        "LINEAR_BOOTSTRAP_RESPONSE_INVALID",
        "Linear team identity changed during state pagination."
      );
    }

    const connection = parseConnection(
      team.states
    );
    states.push(
      ...connection.nodes.map(
        parseWorkflowState
      )
    );
    const next = readNextCursor(
      connection,
      visited
    );

    if (next === null) {
      break;
    }

    after = next;
  }

  return states;
}

async function requestGraphql({
  exchange,
  operation,
  operationName,
  query,
  variables
}: {
  readonly exchange:
    LinearBootstrapGraphqlExchange;
  readonly operation:
    LinearBootstrapGraphqlRequest["operation"];
  readonly operationName: string;
  readonly query: string;
  readonly variables:
    Readonly<Record<string, string | null>>;
}): Promise<Record<string, unknown>> {
  if (
    !OPERATION_NAME_PATTERN.test(operationName)
  ) {
    throw bootstrapError(
      "LINEAR_BOOTSTRAP_INPUT_INVALID",
      "Linear bootstrap operation is invalid."
    );
  }

  const body = JSON.stringify({
    operationName,
    query,
    variables
  });

  if (
    Buffer.byteLength(body, "utf8") >
    LINEAR_GRAPHQL_REQUEST_BYTE_LIMIT
  ) {
    throw bootstrapError(
      "LINEAR_BOOTSTRAP_INPUT_INVALID",
      "Linear bootstrap request is too large."
    );
  }

  const request = Object.freeze({
    schemaVersion: 1,
    operation,
    body
  } as const);
  let rawResult: unknown;

  try {
    rawResult = await exchange(request);
  } catch {
    throw requestFailed();
  }

  let result: Record<string, unknown>;

  try {
    result = readDataRecord(rawResult);
  } catch {
    throw requestFailed();
  }

  if (
    result.kind !== "response" ||
    typeof result.status !== "number" ||
    !Number.isSafeInteger(result.status) ||
    result.status < 200 ||
    result.status >= 300 ||
    typeof result.body !== "string" ||
    !result.body.isWellFormed() ||
    Buffer.byteLength(result.body, "utf8") >
      LINEAR_GRAPHQL_RESPONSE_BYTE_LIMIT
  ) {
    throw requestFailed();
  }

  let envelope: unknown;

  try {
    envelope = JSON.parse(result.body);
  } catch {
    throw requestFailed();
  }

  let root: Record<string, unknown>;

  try {
    root = readDataRecord(envelope);
  } catch {
    throw requestFailed();
  }

  if (
    (Object.hasOwn(root, "errors") &&
      (!Array.isArray(root.errors) ||
        root.errors.length > 0)) ||
    !Object.hasOwn(root, "data")
  ) {
    throw requestFailed();
  }

  try {
    return readDataRecord(root.data);
  } catch {
    throw requestFailed();
  }
}

function normalizeOptions(
  value: unknown
): ResolveLinearBootstrapScopeOptions {
  try {
    return normalizeOptionsUnsafe(value);
  } catch (error) {
    if (
      error instanceof
      LinearBootstrapScopeError
    ) {
      if (
        error.code ===
        "LINEAR_BOOTSTRAP_INPUT_INVALID"
      ) {
        throw error;
      }
    }

    throw bootstrapError(
      "LINEAR_BOOTSTRAP_INPUT_INVALID",
      "Linear bootstrap input is invalid."
    );
  }
}

function normalizeOptionsUnsafe(
  value: unknown
): ResolveLinearBootstrapScopeOptions {
  const options = readExactRecord(value, [
    "configuredTarget",
    "exchange"
  ]);
  const target = readExactRecord(
    options.configuredTarget,
    [
      "workspace",
      "team",
      "project",
      "backlogState"
    ]
  );

  if (typeof options.exchange !== "function") {
    throw bootstrapError(
      "LINEAR_BOOTSTRAP_INPUT_INVALID",
      "Linear bootstrap scope requires an exchange."
    );
  }

  return {
    configuredTarget: {
      workspace: parseReference(
        target.workspace
      ),
      team: parseReference(target.team),
      project: parseReference(target.project),
      backlogState: parseReference(
        target.backlogState
      )
    },
    exchange:
      options.exchange as LinearBootstrapGraphqlExchange
  };
}

function normalizeReadyOptions(
  value: unknown
): ResolveLinearReadyWorkScopeOptions {
  try {
    const options = readExactRecord(value, [
      "configuredTarget",
      "exchange"
    ]);
    const target = readExactRecord(
      options.configuredTarget,
      [
        "workspace",
        "team",
        "project",
        "readyState",
        "completedState"
      ]
    );

    if (typeof options.exchange !== "function") {
      throw bootstrapError(
        "LINEAR_BOOTSTRAP_INPUT_INVALID",
        "Linear ready-work scope requires an exchange."
      );
    }

    const readyState = parseReference(
      target.readyState
    );
    const completedState = parseReference(
      target.completedState
    );

    if (
      matchesReference(
        readyState,
        completedState
      )
    ) {
      throw bootstrapError(
        "LINEAR_READY_STATE_IDENTITY_CONFLICT",
        "Linear ready and completed state references must be distinct."
      );
    }

    return {
      configuredTarget: {
        workspace: parseReference(
          target.workspace
        ),
        team: parseReference(target.team),
        project: parseReference(
          target.project
        ),
        readyState,
        completedState
      },
      exchange:
        options.exchange as LinearBootstrapGraphqlExchange
    };
  } catch (error) {
    if (
      error instanceof
        LinearBootstrapScopeError &&
      (
        error.code ===
          "LINEAR_READY_STATE_IDENTITY_CONFLICT" ||
        error.code ===
          "LINEAR_BOOTSTRAP_INPUT_INVALID"
      )
    ) {
      throw error;
    }

    throw bootstrapError(
      "LINEAR_BOOTSTRAP_INPUT_INVALID",
      "Linear ready-work input is invalid."
    );
  }
}

function normalizeAcceptanceOptions(
  value: unknown
): ResolveLinearAcceptanceScopeOptions {
  try {
    const options = readExactRecord(value, [
      "configuredTarget",
      "exchange"
    ]);
    const target = readExactRecord(
      options.configuredTarget,
      [
        "workspace",
        "team",
        "project",
        "expectedState",
        "targetState"
      ]
    );
    if (
      typeof options.exchange !==
      "function"
    ) {
      throw bootstrapError(
        "LINEAR_BOOTSTRAP_INPUT_INVALID",
        "Linear acceptance scope requires an exchange."
      );
    }
    const expectedState =
      parseReference(
        target.expectedState
      );
    const targetState =
      parseReference(target.targetState);
    if (
      matchesReference(
        expectedState,
        targetState
      )
    ) {
      throw bootstrapError(
        "LINEAR_ACCEPTANCE_STATE_IDENTITY_CONFLICT",
        "Linear acceptance state references must be distinct."
      );
    }
    return {
      configuredTarget: {
        workspace: parseReference(
          target.workspace
        ),
        team: parseReference(target.team),
        project:
          parseReference(target.project),
        expectedState,
        targetState
      },
      exchange:
        options.exchange as
          LinearBootstrapGraphqlExchange
    };
  } catch (error) {
    if (
      error instanceof
        LinearBootstrapScopeError &&
      (
        error.code ===
          "LINEAR_ACCEPTANCE_STATE_IDENTITY_CONFLICT" ||
        error.code ===
          "LINEAR_BOOTSTRAP_INPUT_INVALID"
      )
    ) {
      throw error;
    }
    throw bootstrapError(
      "LINEAR_BOOTSTRAP_INPUT_INVALID",
      "Linear acceptance input is invalid."
    );
  }
}

function parseOrganization(
  value: unknown
): Organization {
  const record = readDataRecord(value);

  return {
    id: parseUuid(
      record.id,
      "organization"
    ),
    name: parseRemoteText(
      record.name,
      "organization name"
    ),
    urlKey: parseRemoteText(
      record.urlKey,
      "organization URL key"
    )
  };
}

function parseTeam(value: unknown): Team {
  const record = readDataRecord(value);

  return {
    id: parseUuid(record.id, "team"),
    name: parseRemoteText(
      record.name,
      "team name"
    ),
    key: parseRemoteText(
      record.key,
      "team key"
    )
  };
}

function parseProject(value: unknown): Project {
  const record = readDataRecord(value);

  return {
    id: parseUuid(record.id, "project"),
    name: parseRemoteText(
      record.name,
      "project name"
    )
  };
}

function parseWorkflowState(
  value: unknown
): WorkflowState {
  const record = readDataRecord(value);

  return {
    id: parseUuid(
      record.id,
      "workflow state"
    ),
    name: parseRemoteText(
      record.name,
      "workflow state name"
    ),
    type: parseRemoteText(
      record.type,
      "workflow state type"
    )
  };
}

function parseConnection(
  value: unknown
): Connection {
  const connection = readDataRecord(value);
  const pageInfo = readDataRecord(
    connection.pageInfo
  );

  if (
    !Array.isArray(connection.nodes) ||
    connection.nodes.length > PAGE_SIZE ||
    typeof pageInfo.hasNextPage !==
      "boolean"
  ) {
    throw bootstrapError(
      "LINEAR_BOOTSTRAP_RESPONSE_INVALID",
      "Linear returned an invalid connection."
    );
  }

  return {
    nodes: connection.nodes,
    pageInfo: {
      hasNextPage: pageInfo.hasNextPage,
      endCursor: pageInfo.endCursor
    }
  };
}

function readNextCursor(
  connection: Connection,
  visited: Set<string>
): string | null {
  if (!connection.pageInfo.hasNextPage) {
    return null;
  }

  const cursor = connection.pageInfo.endCursor;

  if (
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    cursor.length > 512 ||
    visited.has(cursor)
  ) {
    throw bootstrapError(
      "LINEAR_BOOTSTRAP_PAGINATION_INVALID",
      "Linear returned an invalid pagination cursor."
    );
  }

  visited.add(cursor);
  return cursor;
}

function enforcePageLimit(page: number): void {
  if (page >= MAXIMUM_PAGES) {
    throw bootstrapError(
      "LINEAR_BOOTSTRAP_PAGINATION_LIMIT",
      "Linear bootstrap pagination exceeded the safety limit."
    );
  }
}

function validateWorkspace(
  organization: Organization,
  workspace: string
): void {
  if (
    !matchesReference(
      organization.name,
      workspace
    ) &&
    !matchesReference(
      organization.urlKey,
      workspace
    )
  ) {
    throw bootstrapError(
      "LINEAR_BOOTSTRAP_WORKSPACE_MISMATCH",
      "Configured Linear workspace does not match the authenticated organization."
    );
  }
}

function selectUnique<T>(
  values: readonly T[],
  {
    notFoundCode,
    ambiguousCode,
    label
  }: {
    readonly notFoundCode: string;
    readonly ambiguousCode: string;
    readonly label: string;
  }
): T {
  if (values.length === 0) {
    throw bootstrapError(
      notFoundCode,
      `${label} was not found.`
    );
  }

  if (values.length > 1) {
    throw bootstrapError(
      ambiguousCode,
      `${label} reference is ambiguous.`
    );
  }

  const value = values[0];

  if (value === undefined) {
    throw bootstrapError(
      notFoundCode,
      `${label} was not found.`
    );
  }

  return value;
}

function uniqueById<
  T extends { readonly id: string }
>(values: readonly T[]): readonly T[] {
  const byId = new Map<string, T>();

  for (const value of values) {
    const existing = byId.get(value.id);

    if (
      existing !== undefined &&
      !sameScalarRecord(existing, value)
    ) {
      throw bootstrapError(
        "LINEAR_BOOTSTRAP_RESPONSE_INVALID",
        "Linear object identity changed during pagination."
      );
    }

    byId.set(value.id, value);
  }

  return [...byId.values()];
}

function sameScalarRecord(
  left: object,
  right: object
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();

  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        Reflect.get(left, key) ===
          Reflect.get(right, key)
    )
  );
}

function matchesReference(
  actual: string,
  configured: string
): boolean {
  return (
    actual.trim().toLowerCase() ===
    configured.trim().toLowerCase()
  );
}

function parseReference(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !value.isWellFormed() ||
    [...value].length > 256 ||
    Buffer.byteLength(value, "utf8") >
      1_024 ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(
      value
    )
  ) {
    throw bootstrapError(
      "LINEAR_BOOTSTRAP_INPUT_INVALID",
      "Linear bootstrap target is invalid."
    );
  }

  return value;
}

function parseRemoteText(
  value: unknown,
  label: string
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !value.isWellFormed() ||
    [...value].length > 256 ||
    Buffer.byteLength(value, "utf8") >
      1_024
  ) {
    throw bootstrapError(
      "LINEAR_BOOTSTRAP_RESPONSE_INVALID",
      `Linear ${label} is invalid.`
    );
  }

  return value;
}

function parseUuid(
  value: unknown,
  label: string
): string {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    throw bootstrapError(
      "LINEAR_BOOTSTRAP_RESPONSE_INVALID",
      `Linear ${label} identity is invalid.`
    );
  }

  return value.toLowerCase();
}

function readExactRecord(
  value: unknown,
  expectedKeys: readonly string[]
): Record<string, unknown> {
  const record = readDataRecord(value);
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();

  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) => key !== expected[index]
    )
  ) {
    throw bootstrapError(
      "LINEAR_BOOTSTRAP_INPUT_INVALID",
      "Linear bootstrap input is invalid."
    );
  }

  return record;
}

function readDataRecord(
  value: unknown
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !==
      Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw bootstrapError(
      "LINEAR_BOOTSTRAP_RESPONSE_INVALID",
      "Linear bootstrap data is invalid."
    );
  }

  const descriptors =
    Object.getOwnPropertyDescriptors(value);
  const result = Object.create(
    null
  ) as Record<string, unknown>;

  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw bootstrapError(
        "LINEAR_BOOTSTRAP_RESPONSE_INVALID",
        "Linear bootstrap data is invalid."
      );
    }

    const descriptor = descriptors[key];

    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw bootstrapError(
        "LINEAR_BOOTSTRAP_RESPONSE_INVALID",
        "Linear bootstrap data is invalid."
      );
    }

    result[key] = descriptor.value;
  }

  return result;
}

function requestFailed(): LinearBootstrapScopeError {
  return bootstrapError(
    "LINEAR_BOOTSTRAP_REQUEST_FAILED",
    "Linear bootstrap request failed before a trusted response was available."
  );
}

export class LinearBootstrapScopeError
  extends Error
{
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LinearBootstrapScopeError";
    this.code = code;
  }
}

function bootstrapError(
  code: string,
  message: string
): LinearBootstrapScopeError {
  return new LinearBootstrapScopeError(
    code,
    message
  );
}
