import {
  createAccessibleSnapshotState,
  DashboardRequestGate,
  semanticSnapshotKey,
  shouldPollDashboard
} from "/dashboard-state.js";
import {
  createProviderAccessibleSummary,
  createProviderContentRenderKey,
  createProviderPanelModel,
  createProviderPanelState,
  reduceProviderPanelState,
  shouldPollProviders
} from "/provider-state.js";

const elements = {
  snapshotTime: document.querySelector("#snapshot-time"),
  total: document.querySelector("#summary-total"),
  agents: document.querySelector("#summary-agents"),
  reviewing: document.querySelector("#summary-reviewing"),
  accepted: document.querySelector("#summary-accepted"),
  providerPanel: document.querySelector("#provider-panel"),
  providerOverview: document.querySelector(
    "#provider-overview"
  ),
  providerRefresh: document.querySelector(
    "#provider-refresh"
  ),
  providerBanner: document.querySelector(
    "#provider-banner"
  ),
  providerContent: document.querySelector(
    "#provider-content"
  ),
  providerCards: document.querySelector("#provider-cards"),
  providerLatestPanel: document.querySelector(
    "#provider-latest-panel"
  ),
  providerLatest: document.querySelector(
    "#provider-latest"
  ),
  providerLiveStatus: document.querySelector(
    "#provider-live-status"
  ),
  environmentLabel: document.querySelector("#environment-label"),
  stepCounter: document.querySelector("#step-counter"),
  workItems: document.querySelector("#work-items"),
  timeline: document.querySelector("#timeline"),
  demoControls: document.querySelector("#demo-controls"),
  runnerControls: document.querySelector("#runner-controls"),
  resetButton: document.querySelector("#reset-button"),
  nextButton: document.querySelector("#next-button"),
  runButton: document.querySelector("#run-button"),
  promptInput: document.querySelector("#runner-prompt"),
  readOnlyInput: document.querySelector("#read-only-input"),
  codexRunButton: document.querySelector("#codex-run-button"),
  liveStatus: document.querySelector("#live-status"),
  toast: document.querySelector("#toast")
};

const statusLabels = {
  planned: "Planned",
  running: "Running",
  reviewing: "Reviewing",
  blocked: "Blocked",
  accepted: "Accepted"
};
let demoComplete = false;
let mode = null;
let selectedWorkItemId = null;
let promptInitializedFor = null;
let busy = false;
let polling = false;
let lastRuntimeErrorKey = null;
let activeRunCount = 0;
let csrfToken = null;
let renderedWorkItemsKey = null;
let renderedTimelineKey = null;
let announcedStateKey = null;
let providerInitialized = false;
let providerPanelState = createProviderPanelState();
let renderedProviderKey = null;
let announcedProviderKey = null;
const requestGate = new DashboardRequestGate();
const providerRequestGate = new DashboardRequestGate();

elements.resetButton.addEventListener("click", () =>
  mutateDemo("/api/demo/reset")
);
elements.nextButton.addEventListener("click", () =>
  mutateDemo("/api/demo/next")
);
elements.runButton.addEventListener("click", () =>
  mutateDemo("/api/demo/run-all")
);
elements.codexRunButton.addEventListener("click", runCodex);
elements.providerRefresh.addEventListener(
  "click",
  () => requestProviderSnapshot()
);

loadDashboard();

async function loadDashboard() {
  window.setInterval(pollPersistentDashboard, 1_500);
  window.setInterval(pollPersistentProviders, 5_000);
  await requestSnapshot("/api/dashboard", { method: "GET" });
}

async function mutateDemo(path) {
  setBusy(true);
  try {
    await requestSnapshot(path, { method: "POST" });
  } finally {
    setBusy(false);
  }
}

async function runCodex() {
  const prompt = elements.promptInput.value.trim();

  if (!selectedWorkItemId) {
    showToast("No TaskSeal work item is available to run.");
    return;
  }

  if (!prompt) {
    showToast("Describe a bounded Codex assignment first.");
    elements.promptInput.focus();
    return;
  }

  if (!csrfToken) {
    showToast("TaskSeal session token is not ready. Reload the dashboard.");
    return;
  }

  setBusy(true);
  try {
    const dispatched = await requestSnapshot(
      `/api/work-items/${encodeURIComponent(selectedWorkItemId)}/run`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-taskseal-csrf-token": csrfToken
        },
        body: JSON.stringify({
          prompt,
          readOnly: elements.readOnlyInput.checked
        })
      }
    );

    if (dispatched) {
      await requestSnapshot("/api/dashboard", { method: "GET" });
    }
  } finally {
    setBusy(false);
  }
}

async function pollPersistentDashboard() {
  if (!shouldPollDashboard(mode, busy) || polling) {
    return;
  }

  polling = true;
  try {
    await requestSnapshot(
      "/api/dashboard",
      { method: "GET" },
      { silent: true }
    );
  } finally {
    polling = false;
  }
}

async function pollPersistentProviders() {
  if (
    !shouldPollProviders(
      mode,
      providerPanelState.phase
    )
  ) {
    return;
  }

  await requestProviderSnapshot({ silent: true });
}

async function requestProviderSnapshot({
  silent = false
} = {}) {
  if (mode !== "persistent") {
    return null;
  }

  const sequence = providerRequestGate.issue();
  providerPanelState = reduceProviderPanelState(
    providerPanelState,
    { type: "request" }
  );
  renderProviderPanel();

  try {
    const response = await fetch("/api/providers", {
      method: "GET",
      cache: "no-store"
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(
        "Provider observations are unavailable."
      );
    }

    const model = createProviderPanelModel(payload);
    if (!providerRequestGate.isLatest(sequence)) {
      return null;
    }

    providerPanelState = reduceProviderPanelState(
      providerPanelState,
      {
        type: "success",
        model
      }
    );
    renderProviderPanel();
    return model;
  } catch {
    if (!providerRequestGate.isLatest(sequence)) {
      return null;
    }

    providerPanelState = reduceProviderPanelState(
      providerPanelState,
      { type: "failure" }
    );
    renderProviderPanel();
    if (!silent) {
      showToast(providerPanelState.message);
    }
    return null;
  }
}

async function requestSnapshot(path, options, { silent = false } = {}) {
  const sequence = requestGate.issue();

  try {
    const response = await fetch(path, options);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.message ?? "TaskSeal request failed.");
    }

    if (!requestGate.isLatest(sequence)) {
      return null;
    }

    render(payload);
    return payload;
  } catch (error) {
    if (!silent && requestGate.isLatest(sequence)) {
      showToast(error.message);
    }
    return null;
  }
}

function render(snapshot) {
  const isDemo =
    snapshot.capabilities?.demo ?? Boolean(snapshot.demo);
  mode = isDemo ? "demo" : "persistent";
  demoComplete = isDemo && snapshot.demo.complete;
  selectedWorkItemId = snapshot.workItems[0]?.id ?? null;
  csrfToken = snapshot.security?.csrfToken ?? csrfToken;

  elements.snapshotTime.textContent = `Snapshot ${formatTime(
    snapshot.generatedAt
  )}`;
  elements.total.textContent = snapshot.summary.total;
  elements.agents.textContent = snapshot.summary.activeAgents;
  elements.reviewing.textContent = snapshot.summary.reviewing;
  elements.accepted.textContent = snapshot.summary.accepted;

  elements.demoControls.hidden = !isDemo;
  elements.runnerControls.hidden = isDemo;
  elements.environmentLabel.textContent = isDemo
    ? "Fixture demo"
    : "Persistent journal";
  elements.providerPanel.hidden = isDemo;

  if (!isDemo && !providerInitialized) {
    providerInitialized = true;
    renderProviderPanel();
    void requestProviderSnapshot();
  }

  if (isDemo) {
    elements.stepCounter.textContent = `Step ${snapshot.demo.currentStep} / ${snapshot.demo.totalSteps}`;
    elements.nextButton.disabled = demoComplete;
    elements.runButton.disabled = demoComplete;
    renderTimeline(snapshot.demo.timeline);
  } else {
    const activeIds = snapshot.runtime?.activeWorkItemIds ?? [];
    const hasActiveRun = activeIds.length > 0;
    activeRunCount = activeIds.length;
    elements.stepCounter.textContent = hasActiveRun
      ? `${activeIds.length} Codex run active`
      : "Journal online";
    elements.codexRunButton.disabled =
      busy || hasActiveRun || !selectedWorkItemId;
    elements.codexRunButton.textContent = hasActiveRun
      ? "Codex running…"
      : "Run Codex";
    initializePrompt(snapshot.workItems[0]);
    renderTimeline(createAttemptTimeline(snapshot.workItems));
    revealRuntimeError(snapshot.runtime?.errors);
  }

  renderWorkItems(snapshot.workItems);
  announceSnapshot(snapshot);
}

function renderProviderPanel() {
  const { phase, model, message } = providerPanelState;
  const isLoading =
    phase === "loading" || phase === "refreshing";
  elements.providerContent.setAttribute(
    "aria-busy",
    String(isLoading)
  );
  elements.providerRefresh.textContent = isLoading
    ? "Refreshing…"
    : "Refresh";
  elements.providerRefresh.disabled = phase === "loading";
  elements.providerBanner.hidden = phase !== "stale";

  if (phase === "stale") {
    elements.providerBanner.dataset.tone = "warning";
    elements.providerBanner.textContent = message;
  } else {
    elements.providerBanner.textContent = "";
    delete elements.providerBanner.dataset.tone;
  }

  const contentKey =
    createProviderContentRenderKey(providerPanelState);
  if (contentKey === renderedProviderKey) {
    updateProviderObservationTimes();
    announceProviderPanel();
    return;
  }
  renderedProviderKey = contentKey;

  if (phase === "idle" || phase === "loading") {
    elements.providerOverview.textContent =
      "Loading safe observations";
    elements.providerCards.innerHTML =
      renderProviderStateMessage({
        className: "provider-state-loading",
        icon: "",
        title: "Loading Provider observations",
        description:
          "Reading the latest bounded snapshot from the local Control Room."
      });
    elements.providerLatestPanel.hidden = true;
  } else if (phase === "error") {
    elements.providerOverview.textContent =
      "Provider status unavailable";
    elements.providerCards.innerHTML =
      renderProviderStateMessage({
        className: "provider-state-error",
        icon: "!",
        title: "Provider observations unavailable",
        description:
          "The workflow remains isolated. Refresh after the observation store is available."
      });
    elements.providerLatestPanel.hidden = true;
  } else if (model && model.cards.length === 0) {
    elements.providerOverview.textContent =
      "0 configured targets";
    elements.providerCards.innerHTML =
      renderProviderStateMessage({
        className: "",
        icon: "○",
        title: "No Provider observations yet",
        description:
          "Configure a Provider and run an inspection to populate this read model."
      });
    elements.providerLatestPanel.hidden = true;
  } else if (model) {
    elements.providerOverview.textContent =
      `${model.summary.total} targets · ` +
      `${model.summary.ready} ready · ` +
      `${model.summary.attention} need attention`;
    elements.providerCards.innerHTML = model.cards
      .map(renderProviderCard)
      .join("");
    elements.providerLatest.innerHTML = model.latest
      .map(renderLatestProviderObservation)
      .join("");
    elements.providerLatestPanel.hidden = false;
  }

  announceProviderPanel();
}

function updateProviderObservationTimes() {
  for (const element of elements.providerPanel.querySelectorAll(
    "time[data-observed-at]"
  )) {
    element.textContent = formatObservationTime(
      element.dataset.observedAt
    );
  }
}

function renderProviderStateMessage({
  className,
  icon,
  title,
  description
}) {
  return `
    <div class="provider-state-message ${className}">
      <span aria-hidden="true">${escapeHtml(icon)}</span>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(description)}</p>
    </div>
  `;
}

function renderProviderCard(card, index) {
  const headingId = `provider-card-${index}-heading`;
  const scope =
    card.observedScope?.key ?? "Not observed";
  const parentScope =
    card.observedScope?.parentKey ?? "Not applicable";

  return `
    <article
      class="provider-card"
      aria-labelledby="${headingId}"
      data-status="${escapeAttribute(card.status)}"
    >
      <div class="provider-card-header">
        <div class="provider-identity">
          <span class="provider-monogram" aria-hidden="true">
            ${escapeHtml(card.providerShortLabel)}
          </span>
          <div>
            <h3 id="${headingId}">${escapeHtml(card.providerLabel)}</h3>
            <small>${escapeHtml(card.configuredTarget.key)}</small>
          </div>
        </div>
        <span class="provider-status provider-tone-${escapeAttribute(
          card.tone
        )}">
          <span aria-hidden="true">${escapeHtml(card.statusIcon)}</span>
          ${escapeHtml(card.statusLabel)}
        </span>
      </div>

      <div class="provider-observed-row">
        <span class="provider-operation">${escapeHtml(
          card.operationLabel
        )}</span>
        <time
          datetime="${escapeAttribute(card.observedAt)}"
          data-observed-at="${escapeAttribute(card.observedAt)}"
        >
          ${escapeHtml(formatObservationTime(card.observedAt))}
        </time>
      </div>

      <div class="provider-facts">
        <div class="provider-fact">
          <span class="detail-label">Observed scope</span>
          <strong>${escapeHtml(scope)}</strong>
          <small>${escapeHtml(
            card.observedScope?.kind ?? "No verified scope"
          )}</small>
        </div>
        <div class="provider-fact">
          <span class="detail-label">Snapshot</span>
          <strong>${escapeHtml(
            shortDigest(card.snapshotDigest) ?? "Not captured"
          )}</strong>
          <small>
            ${card.sourceRevisionCount} source
            revision${card.sourceRevisionCount === 1 ? "" : "s"}
          </small>
        </div>
        <div class="provider-fact">
          <span class="detail-label">Mapping</span>
          <strong>${escapeHtml(
            shortDigest(card.mappingDigest) ?? "Not captured"
          )}</strong>
          <small>Canonical digest only</small>
        </div>
        <div class="provider-fact">
          <span class="detail-label">Approval</span>
          <strong>${escapeHtml(card.approvalLabel)}</strong>
          <small>Requires #6 and #29</small>
        </div>
      </div>

      ${
        card.missingEvidence.length > 0
          ? `<div class="provider-missing">
              <strong>Missing evidence:</strong>
              ${escapeHtml(card.missingEvidence.join(", "))}
            </div>`
          : ""
      }
      ${
        card.diagnosticCode
          ? `<div class="provider-diagnostic">
              ${escapeHtml(card.diagnosticCode)}
            </div>`
          : ""
      }

      <details class="provider-details">
        <summary>Technical observation details</summary>
        <dl class="provider-technical-list">
          ${renderProviderTechnicalDetail(
            "Target",
            card.configuredTarget.key
          )}
          ${renderProviderTechnicalDetail("Scope parent", parentScope)}
          ${renderProviderTechnicalDetail(
            "Snapshot",
            shortDigest(card.snapshotDigest) ?? "—"
          )}
          ${renderProviderTechnicalDetail(
            "Mapping",
            shortDigest(card.mappingDigest) ?? "—"
          )}
          ${renderProviderTechnicalDetail(
            "Plan",
            shortDigest(card.planDigest) ?? "—"
          )}
          ${renderProviderTechnicalDetail(
            "Resolution",
            card.resolution ?? "—"
          )}
        </dl>
      </details>
    </article>
  `;
}

function renderProviderTechnicalDetail(label, value) {
  return `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(value)}</dd>
    </div>
  `;
}

function renderLatestProviderObservation(card) {
  return `
    <li data-tone="${escapeAttribute(card.tone)}">
      <span class="provider-latest-icon" aria-hidden="true">
        ${escapeHtml(card.statusIcon)}
      </span>
      <div class="provider-latest-copy">
        <strong>
          ${escapeHtml(card.providerLabel)} ·
          ${escapeHtml(card.statusLabel)}
        </strong>
        <span>
          ${escapeHtml(card.operationLabel)} ·
          ${escapeHtml(card.configuredTarget.key)}
        </span>
        <time
          datetime="${escapeAttribute(card.observedAt)}"
          data-observed-at="${escapeAttribute(card.observedAt)}"
        >
          ${escapeHtml(formatObservationTime(card.observedAt))}
        </time>
      </div>
    </li>
  `;
}

function announceProviderPanel() {
  if (providerPanelState.phase === "refreshing") {
    return;
  }

  const summary = createProviderAccessibleSummary(
    providerPanelState
  );
  const key = semanticSnapshotKey(summary);

  if (key === announcedProviderKey) {
    return;
  }
  announcedProviderKey = key;
  elements.providerLiveStatus.textContent = summary;
}

function initializePrompt(workItem) {
  if (!workItem || promptInitializedFor === workItem.id) {
    return;
  }

  elements.promptInput.value = [
    `Work on TaskSeal work item ${workItem.id}: ${workItem.title}.`,
    "Stay inside this project and report a concise result.",
    "Do not access or modify external issue trackers."
  ].join("\n");
  promptInitializedFor = workItem.id;
}

function createAttemptTimeline(workItems) {
  const attempts = workItems
    .flatMap((workItem) =>
      workItem.attempts.map((attempt) => ({
        workItem,
        attempt
      }))
    )
    .toSorted(
      (left, right) =>
        Date.parse(left.attempt.startedAt) -
        Date.parse(right.attempt.startedAt)
    );

  if (attempts.length === 0) {
    return [
      {
        number: 1,
        source: "TaskSeal",
        label: "Waiting for the first Codex attempt",
        completed: false,
        active: true
      }
    ];
  }

  return attempts.map(({ workItem, attempt }, index) => ({
    number: index + 1,
    source: attempt.agentId,
    label: [
      `${workItem.id} · ${statusLabels[attempt.status] ?? attempt.status}`,
      attempt.summary
    ]
      .filter(Boolean)
      .join(" — "),
    completed: attempt.status !== "running",
    active: attempt.status === "running"
  }));
}

function revealRuntimeError(errors) {
  const entries = Object.entries(errors ?? {});

  if (entries.length === 0) {
    return;
  }

  const [workItemId, error] = entries.at(-1);
  const key = `${workItemId}:${error.recordedAt}:${error.code}`;

  if (key === lastRuntimeErrorKey) {
    return;
  }

  lastRuntimeErrorKey = key;
  showToast(`${workItemId}: ${error.message}`);
}

function renderWorkItems(workItems) {
  const renderKey = semanticSnapshotKey(workItems);

  if (renderKey === renderedWorkItemsKey) {
    return;
  }

  renderedWorkItemsKey = renderKey;

  if (workItems.length === 0) {
    elements.workItems.innerHTML = `
      <div class="empty-state">
        <strong>No work items yet</strong>
        <p>Run the first event to ingest a task.</p>
      </div>
    `;
    return;
  }

  elements.workItems.innerHTML = workItems.map(renderWorkItem).join("");
}

function renderWorkItem(item) {
  const currentAttempt = item.activeAttempt;
  const currentArtifact = item.activeArtifact;
  const decision = item.acceptanceDecision;
  const decisionView = getDecisionView(decision);

  return `
    <article class="work-item-card">
      <div class="work-item-header">
        <div>
          <div class="work-id">${escapeHtml(item.id)}</div>
          <h3>${escapeHtml(item.title)}</h3>
        </div>
        <span class="status status-${escapeAttribute(item.status)}">
          <span aria-hidden="true"></span>
          ${escapeHtml(statusLabels[item.status] ?? item.status)}
        </span>
      </div>

      <div class="progress-row">
        <div class="progress-track" aria-label="${item.progress}% complete">
          <span style="width: ${item.progress}%"></span>
        </div>
        <strong>${item.progress}%</strong>
      </div>

      <div class="work-detail-grid">
        <div class="detail-block">
          <span class="detail-label">Assigned agent</span>
          ${
            currentAttempt
              ? `<strong>${escapeHtml(currentAttempt.agentId)}</strong>
                 <small>${escapeHtml(currentAttempt.status)}</small>`
              : `<strong>Waiting for dispatch</strong>
                 <small>No active attempt</small>`
          }
        </div>
        <div class="detail-block">
          <span class="detail-label">Current artifact</span>
          ${
            currentArtifact
              ? renderArtifact(currentArtifact)
              : `<strong>Not submitted</strong>
                 <small>Evidence gate is waiting</small>`
          }
        </div>
      </div>

      <div class="evidence-row">
        <span class="detail-label">Required evidence</span>
        <div class="evidence-list">
          ${item.requiredEvidence
            .map((criterion) =>
              renderEvidence(criterion, item.currentEvidence)
            )
            .join("")}
        </div>
      </div>

      <div class="decision ${decisionView.className}">
        <span class="decision-icon" aria-hidden="true">${decisionView.icon}</span>
        <div>
          <strong>${decisionView.title}</strong>
          <small>${decisionView.description}</small>
        </div>
      </div>
    </article>
  `;
}

function renderEvidence(criterion, evidence) {
  const latest = evidence.filter(
    (item) => item.criterionKey === criterion
  ).at(-1);
  const outcome = latest?.outcome ?? "missing";
  const outcomeLabel = {
    passed: "passed",
    failed: "failed",
    missing: "missing"
  }[outcome] ?? outcome;

  return `
    <span class="evidence evidence-${outcome}">
      <span aria-hidden="true">${outcome === "passed" ? "✓" : "·"}</span>
      ${escapeHtml(criterion)} — ${escapeHtml(outcomeLabel)}
    </span>
  `;
}

function renderArtifact(artifact) {
  const safeUrl = safeExternalUrl(artifact.url);
  const label = escapeHtml(artifact.kind);
  const revision = escapeHtml(artifact.revision);

  if (!safeUrl) {
    return `<strong>${label}</strong>
      <small>Unsafe artifact URL blocked · revision ${revision}</small>`;
  }

  return `<a href="${escapeAttribute(
    safeUrl
  )}" target="_blank" rel="noreferrer">
      ${label}
    </a>
    <small>revision ${revision}</small>`;
}

function getDecisionView(decision) {
  if (decision?.decision === "accepted") {
    return {
      className: "decision-ready",
      icon: "✓",
      title: "Owner accepted delivery",
      description: escapeHtml(decision.reason)
    };
  }

  if (decision?.decision === "rejected") {
    return {
      className: "decision-rejected",
      icon: "×",
      title: "Owner rejected delivery",
      description: escapeHtml(decision.reason)
    };
  }

  return {
    className: "",
    icon: "○",
    title: "Acceptance pending",
    description:
      "Artifact, evidence, and accountable approval are required."
  };
}

function renderTimeline(timeline) {
  const renderKey = semanticSnapshotKey(timeline);

  if (renderKey === renderedTimelineKey) {
    return;
  }

  renderedTimelineKey = renderKey;
  elements.timeline.innerHTML = timeline
    .map(
      (step) => `
        <li class="${step.completed ? "completed" : ""} ${
          step.active ? "active" : ""
        }">
          <span class="timeline-node">${step.completed ? "✓" : step.number}</span>
          <div>
            <small>${escapeHtml(step.source)}</small>
            <strong>${escapeHtml(step.label)}</strong>
          </div>
        </li>
      `
    )
    .join("");
}

function announceSnapshot(snapshot) {
  const state = createAccessibleSnapshotState(snapshot);
  const stateKey = semanticSnapshotKey(state);

  if (stateKey === announcedStateKey) {
    return;
  }

  announcedStateKey = stateKey;
  const workSummary =
    state.workItems.length > 0
      ? state.workItems
          .map(
            (workItem) => {
              const passedEvidence = workItem.evidence.filter(
                (evidence) => evidence.outcome === "passed"
              ).length;
              const artifactSummary = workItem.artifact
                ? `${workItem.artifact.kind} artifact linked`
                : "artifact pending";

              return `${workItem.id} is ${
                statusLabels[workItem.status] ?? workItem.status
              }, ${artifactSummary}, ${passedEvidence} of ${
                workItem.evidence.length
              } evidence checks passed`;
            }
          )
          .join(". ")
      : "No work items";
  const demoSummary = state.demo
    ? `Demo step ${state.demo.currentStep} of ${state.demo.totalSteps}${
        state.demo.activeLabel
          ? `, ${state.demo.activeLabel}`
          : ""
      }. `
    : "";
  elements.liveStatus.textContent = `${demoSummary}${workSummary}. ${state.activeAgents} active agents.`;
}

function setBusy(isBusy) {
  busy = isBusy;
  elements.resetButton.disabled = isBusy;
  elements.nextButton.disabled = isBusy || demoComplete;
  elements.runButton.disabled = isBusy || demoComplete;
  elements.codexRunButton.disabled =
    isBusy || activeRunCount > 0 || !selectedWorkItemId;
  elements.codexRunButton.textContent = isBusy
    ? "Dispatching…"
    : activeRunCount > 0
      ? "Codex running…"
      : "Run Codex";
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("toast-visible");
  window.setTimeout(() => elements.toast.classList.remove("toast-visible"), 3200);
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function formatObservationTime(value) {
  const timestamp = Date.parse(value);
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  const relative =
    minutes < 1
      ? "just now"
      : minutes < 60
        ? `${minutes}m ago`
        : minutes < 1_440
          ? `${Math.floor(minutes / 60)}h ago`
          : `${Math.floor(minutes / 1_440)}d ago`;
  const absolute = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(timestamp));

  return `${absolute} · ${relative}`;
}

function shortDigest(value) {
  if (!value) {
    return null;
  }
  return `${value.slice(0, 15)}…${value.slice(-6)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}
