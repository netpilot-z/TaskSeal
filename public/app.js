import {
  AcceptanceTruthFence,
  createAccessibleOrchestrationState,
  createAccessibleSnapshotState,
  createAcceptanceControlState,
  createAttemptTimeline,
  createOrchestrationPanelModel,
  createRunControlState,
  DashboardRequestGate,
  normalizeRequiredAuditNote,
  PromptDraftStore,
  reconcileSelectedWorkItemId,
  semanticSnapshotKey,
  shouldResetAcceptanceReasonError,
  shouldPollDashboard
} from "/dashboard-state.js";
import {
  createProviderAccessibleSummary,
  createProviderContentRenderKey,
  createProviderPanelModel,
  createProviderPanelState,
  didAdoptProviderPanelModel,
  reduceProviderPanelState,
  shouldPollProviders
} from "/provider-state.js";
import {
  currentLocale,
  initializePresentation,
  t
} from "/presentation.js";

await initializePresentation();

const elements = {
  snapshotTime: document.querySelector("#snapshot-time"),
  total: document.querySelector("#summary-total"),
  agents: document.querySelector("#summary-agents"),
  reviewing: document.querySelector("#summary-reviewing"),
  accepted: document.querySelector("#summary-accepted"),
  orchestrationPanel:
    document.querySelector(
      "#orchestration-panel"
    ),
  orchestrationOverview:
    document.querySelector(
      "#orchestration-overview"
    ),
  orchestrationPlans:
    document.querySelector(
      "#orchestration-plans"
    ),
  orchestrationRetirementCount:
    document.querySelector(
      "#orchestration-retirement-count"
    ),
  orchestrationRetirements:
    document.querySelector(
      "#orchestration-retirements"
    ),
  orchestrationLiveStatus:
    document.querySelector(
      "#orchestration-live-status"
    ),
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
  providerOperations: document.querySelector(
    "#provider-operations"
  ),
  providerOperationsEmpty: document.querySelector(
    "#provider-operations-empty"
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
  workItemSelect: document.querySelector("#work-item-select"),
  runnerStatus: document.querySelector("#runner-status"),
  resetButton: document.querySelector("#reset-button"),
  nextButton: document.querySelector("#next-button"),
  runButton: document.querySelector("#run-button"),
  promptInput: document.querySelector("#runner-prompt"),
  readOnlyInput: document.querySelector("#read-only-input"),
  codexRunButton: document.querySelector("#codex-run-button"),
  codexCancelButton: document.querySelector(
    "#codex-cancel-button"
  ),
  acceptanceOperator:
    document.querySelector(
      "#acceptance-operator"
    ),
  acceptanceControls: document.querySelector(
    "#acceptance-controls"
  ),
  acceptanceLocalStatus:
    document.querySelector(
      "#acceptance-local-status"
    ),
  acceptanceLinearStatus:
    document.querySelector(
      "#acceptance-linear-status"
    ),
  acceptanceReason:
    document.querySelector(
      "#acceptance-reason"
    ),
  acceptanceReasonHelp:
    document.querySelector(
      "#acceptance-reason-help"
    ),
  acceptanceDecisionForm: document.querySelector(
    "#acceptance-decision-form"
  ),
  acceptanceUnavailable: document.querySelector(
    "#acceptance-unavailable"
  ),
  acceptanceUnavailableMessage: document.querySelector(
    "#acceptance-unavailable-message"
  ),
  acceptanceSettingsLink: document.querySelector(
    "#acceptance-settings-link"
  ),
  acceptanceAudit:
    document.querySelector(
      "#acceptance-audit"
    ),
  acceptanceAcceptButton:
    document.querySelector(
      "#acceptance-accept-button"
    ),
  acceptanceRejectButton:
    document.querySelector(
      "#acceptance-reject-button"
    ),
  acceptanceReconcileButton:
    document.querySelector(
      "#acceptance-reconcile-button"
    ),
  liveStatus: document.querySelector("#live-status"),
  toast: document.querySelector("#toast")
};

const statusLabels = {
  planned: t("dashboard.status.planned"),
  running: t("dashboard.status.running"),
  reviewing: t("dashboard.status.reviewing"),
  blocked: t("dashboard.status.blocked"),
  accepted: t("dashboard.status.accepted"),
  completed: t("dashboard.status.completed"),
  failed: t("dashboard.status.failed"),
  interrupted: t("dashboard.status.interrupted"),
  superseded: t("dashboard.status.superseded")
};
const controlLabelKeys = new Map([
  ["Run Codex", "dashboard.runner.run"],
  ["Retry Codex", "dashboard.control.retry"],
  ["Cancel selected", "dashboard.runner.cancel"],
  ["Dispatching…", "dashboard.control.dispatching"],
  ["Cancelling…", "dashboard.control.cancelling"],
  ["Finishing cancellation…", "dashboard.control.finishingCancellation"],
  ["Saving outcome…", "dashboard.control.savingOutcome"],
  ["Codex running…", "dashboard.control.running"],
  ["Use DAG dispatch", "dashboard.control.useDag"],
  ["Cancellation requested", "dashboard.control.cancellationRequested"],
  ["Outcome locked", "dashboard.control.outcomeLocked"],
  ["Accepted", "dashboard.status.accepted"],
  ["Awaiting human decision", "dashboard.acceptance.awaiting"],
  ["Accepted locally", "dashboard.acceptance.acceptedLocally"],
  ["Rejected locally", "dashboard.acceptance.rejectedLocally"],
  ["Not applicable", "dashboard.acceptance.notApplicable"],
  ["Disabled", "common.status.disabled"],
  ["Unavailable", "common.status.invalid"]
]);

function localizeControlLabel(value) {
  const key = controlLabelKeys.get(value);
  return key ? t(key) : value;
}

function localizeRunStatusLabel(value) {
  const latest = /^(.*?) · latest attempt (.*?) is ([a-z_]+)$/.exec(value);
  if (latest) {
    return t("dashboard.runner.latestAttempt", {
      workItem: latest[1],
      attempt: latest[2],
      status: statusLabels[latest[3]] ?? latest[3]
    });
  }
  if (value === "No work item selected") {
    return t("dashboard.runner.noSelection");
  }
  const patterns = [
    [/^(.*?) · accepted; explicit reopen is required before another run$/, "dashboard.runner.acceptedStatus", ["workItem"]],
    [/^(.*?) · cancellation requested for attempt (.*?)$/, "dashboard.runner.cancellationAttemptStatus", ["workItem", "attempt"]],
    [/^(.*?) · cancellation requested$/, "dashboard.runner.cancellationStatus", ["workItem"]],
    [/^(.*?) · saving the interrupted terminal outcome$/, "dashboard.runner.savingInterruptedStatus", ["workItem"]],
    [/^(.*?) · saving the terminal outcome; cancellation is no longer available$/, "dashboard.runner.savingTerminalStatus", ["workItem"]],
    [/^(.*?) · attempt (.*?) is running$/, "dashboard.runner.runningStatus", ["workItem", "attempt"]],
    [/^(.*?) · Managed by decomposition (.*?); use DAG dispatch$/, "dashboard.runner.managedStatus", ["workItem", "plan"]],
    [/^(.*?) · execution capacity is full; retry after a run settles$/, "dashboard.runner.capacityStatus", ["workItem"]],
    [/^(.*?) · ready to run$/, "dashboard.runner.readyStatus", ["workItem"]]
  ];
  for (const [pattern, key, names] of patterns) {
    const match = pattern.exec(value);
    if (match) {
      return t(key, Object.fromEntries(names.map((name, index) => [name, match[index + 1]])));
    }
  }
  return value;
}
let demoComplete = false;
let mode = null;
let selectedWorkItemId = null;
const promptDrafts = new PromptDraftStore();
const acceptanceDrafts = new Map();
let acceptanceDraftWorkItemId = null;
let busy = false;
let polling = false;
let lastRuntimeErrorKey = null;
let csrfToken = null;
let renderedWorkItemsKey = null;
let renderedOrchestrationKey = null;
let announcedOrchestrationKey = null;
let renderedWorkItemSelectorKey = null;
let renderedTimelineKey = null;
let announcedStateKey = null;
let lastRunnerStatusLabel = null;
let latestSnapshot = null;
let orchestrationMutation = null;
const retirementDrafts = new Map();
let pendingRetirementFocusPlanId =
  null;
let pendingOrchestrationFocusToken =
  null;
let providerInitialized = false;
let providerPanelState = createProviderPanelState();
let renderedProviderKey = null;
let announcedProviderKey = null;
const requestGate = new DashboardRequestGate();
const providerRequestGate = new DashboardRequestGate();
const acceptanceTruthFence =
  new AcceptanceTruthFence();

document.addEventListener("taskseal:locale-changed", () => {
  window.location.reload();
});
document.addEventListener("taskseal:presentation-error", (event) => {
  showToast(t("settings.save.failure", {
    message: event.detail?.message ?? "LOCALE_UPDATE_FAILED"
  }));
});

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
elements.codexCancelButton.addEventListener(
  "click",
  cancelCodex
);
elements.acceptanceAcceptButton.addEventListener(
  "click",
  () => submitAcceptance("accepted")
);
elements.acceptanceRejectButton.addEventListener(
  "click",
  () => submitAcceptance("rejected")
);
elements.acceptanceReconcileButton.addEventListener(
  "click",
  reconcileAcceptance
);
elements.acceptanceReason.addEventListener(
  "input",
  () => {
    saveAcceptanceDraft();
    clearAcceptanceReasonError();
  }
);
elements.workItemSelect.addEventListener(
  "change",
  () => selectWorkItem(elements.workItemSelect.value)
);
elements.workItems.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }

  const button = event.target.closest(
    "[data-select-work-item]"
  );

  if (button) {
    selectWorkItem(button.dataset.selectWorkItem);
  }
});
elements.providerRefresh.addEventListener(
  "click",
  () => requestProviderSnapshot()
);
elements.orchestrationPlans.addEventListener(
  "click",
  (event) => {
    if (
      !(
        event.target instanceof
        Element
      )
    ) {
      return;
    }
    const dispatchButton =
      event.target.closest(
      "[data-dispatch-plan]"
    );
    if (dispatchButton) {
      void dispatchDecomposition(
        dispatchButton.dataset
          .dispatchPlan
      );
      return;
    }
    const toggle = event.target.closest(
      "[data-toggle-retirement]"
    );
    if (toggle) {
      toggleRetirementForm(
        toggle.dataset
          .toggleRetirement
      );
      return;
    }
    const cancel = event.target.closest(
      "[data-cancel-retirement]"
    );
    if (cancel) {
      cancelRetirementForm(
        cancel.dataset
          .cancelRetirement
      );
    }
  }
);
elements.orchestrationPlans.addEventListener(
  "input",
  (event) => {
    if (
      event.target instanceof
        Element
    ) {
      if (
        event.target instanceof
          HTMLTextAreaElement &&
        event.target.name ===
          "note"
      ) {
        event.target
          .setCustomValidity("");
      }
      saveRetirementDraft(
        event.target.closest(
          "[data-retirement-form]"
        )
      );
    }
  }
);
elements.orchestrationPlans.addEventListener(
  "submit",
  (event) => {
    if (
      !(event.target instanceof
        HTMLFormElement)
    ) {
      return;
    }
    event.preventDefault();
    const noteField =
      event.target.elements
        .namedItem("note");
    const normalizedNote =
      normalizeRequiredAuditNote(
        noteField instanceof
            HTMLTextAreaElement
          ? noteField.value
          : null
      );
    if (
      noteField instanceof
        HTMLTextAreaElement
    ) {
      noteField.setCustomValidity(
        normalizedNote === null
          ? "Enter an audit note that contains visible text."
          : ""
      );
    }
    saveRetirementDraft(
      event.target
    );
    if (
      !event.target.reportValidity()
    ) {
      if (
        normalizedNote === null &&
        noteField instanceof
          HTMLTextAreaElement
      ) {
        noteField.focus();
      }
      return;
    }
    if (
      normalizedNote !== null &&
      noteField instanceof
        HTMLTextAreaElement
    ) {
      noteField.value =
        normalizedNote;
      saveRetirementDraft(
        event.target
      );
    }
    void retireDecomposition(
      event.target.dataset
        .retirementForm
    );
  }
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
  const workItemId = selectedWorkItemId;

  if (!workItemId) {
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
      `/api/work-items/${encodeURIComponent(workItemId)}/run`,
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

async function cancelCodex() {
  const workItemId = selectedWorkItemId;

  if (!workItemId || !csrfToken) {
    showToast(
      "Select an active work item before cancelling."
    );
    return;
  }

  setBusy(true);
  try {
    const cancelled = await requestSnapshot(
      `/api/work-items/${encodeURIComponent(
        workItemId
      )}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-taskseal-csrf-token": csrfToken
        },
        body: "{}"
      }
    );

    if (cancelled) {
      await requestSnapshot(
        "/api/dashboard",
        { method: "GET" }
      );
    }
  } finally {
    setBusy(false);
  }
}

async function dispatchDecomposition(
  planId
) {
  const plan =
    latestSnapshot?.orchestration?.find(
      (candidate) =>
        candidate.planId === planId
    );
  if (!plan || !csrfToken) {
    showToast(
      "The approved plan or session token is no longer available."
    );
    return;
  }

  orchestrationMutation = {
    kind: "dispatch",
    planId
  };
  setBusy(true);
  try {
    const response = await fetch(
      `/api/decompositions/${encodeURIComponent(
        plan.planId
      )}/dispatch`,
      {
        method: "POST",
        headers: {
          "content-type":
            "application/json",
          "x-taskseal-csrf-token":
            csrfToken
        },
        body: JSON.stringify({
          expectedPlanDigest:
            plan.planDigest
        })
      }
    );
    const payload =
      await response.json();
    if (!response.ok) {
      throw new Error(
        payload.message ??
          "TaskSeal decomposition dispatch failed."
      );
    }
    await requestSnapshot(
      "/api/dashboard",
      { method: "GET" }
    );
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "TaskSeal decomposition dispatch failed."
    );
  } finally {
    orchestrationMutation = null;
    setBusy(false);
  }
}

function toggleRetirementForm(
  planId
) {
  if (!planId || busy) {
    return;
  }
  const current =
    retirementDrafts.get(planId) ?? {
      open: false,
      reasonCode: "",
      note: "",
      confirmed: false
    };
  retirementDrafts.set(planId, {
    ...current,
    open: !current.open
  });
  renderedOrchestrationKey = null;
  renderOrchestration(
    latestSnapshot
  );
  if (!current.open) {
    queueMicrotask(() =>
      elements.orchestrationPlans
        .querySelector(
          `[data-retirement-reason="${escapeAttribute(
            planId
          )}"]`
        )
        ?.focus()
    );
  }
}

function cancelRetirementForm(
  planId
) {
  if (!planId || busy) {
    return;
  }
  retirementDrafts.delete(planId);
  renderedOrchestrationKey = null;
  renderOrchestration(
    latestSnapshot
  );
  elements.orchestrationPlans
    .querySelector(
      `[data-toggle-retirement="${escapeAttribute(
        planId
      )}"]`
    )
    ?.focus();
}

function saveRetirementDraft(form) {
  if (
    !(
      form instanceof
      HTMLFormElement
    )
  ) {
    return;
  }
  const planId =
    form.dataset.retirementForm;
  if (!planId) {
    return;
  }
  const fields =
    form.elements;
  retirementDrafts.set(planId, {
    open: true,
    reasonCode:
      fields.reasonCode?.value ??
      "",
    note:
      fields.note?.value ?? "",
    confirmed:
      fields.confirmed?.checked ===
      true
  });
}

async function retireDecomposition(
  planId
) {
  const plan =
    latestSnapshot?.orchestration?.find(
      (candidate) =>
        candidate.planId === planId
    );
  const draft =
    retirementDrafts.get(planId);
  if (
    !plan ||
    !draft ||
    !csrfToken
  ) {
    showToast(
      "The approved plan or session token is no longer available."
    );
    return;
  }

  orchestrationMutation = {
    kind: "retire",
    planId
  };
  setBusy(true);
  let committed = false;
  try {
    const response = await fetch(
      `/api/decompositions/${encodeURIComponent(
        plan.planId
      )}/retire`,
      {
        method: "POST",
        headers: {
          "content-type":
            "application/json",
          "x-taskseal-csrf-token":
            csrfToken
        },
        body: JSON.stringify({
          expectedPlanDigest:
            plan.planDigest,
          reasonCode:
            draft.reasonCode,
          note: draft.note.trim()
        })
      }
    );
    const payload =
      await response.json();
    if (!response.ok) {
      throw new Error(
        payload.message ??
          "TaskSeal decomposition retirement failed."
      );
    }
    committed = true;
    retirementDrafts.delete(planId);
    pendingRetirementFocusPlanId =
      planId;
    await requestSnapshot(
      "/api/dashboard",
      { method: "GET" }
    );
    showToast(
      "Plan retired. WorkItems and delivery evidence were retained."
    );
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "TaskSeal decomposition retirement failed."
    );
  } finally {
    orchestrationMutation = null;
    setBusy(false);
    if (
      committed &&
      pendingRetirementFocusPlanId
    ) {
      restoreRetirementAuditFocus();
    }
  }
}

async function submitAcceptance(
  decision
) {
  const control =
    readAcceptanceControl();
  const allowed =
    decision === "accepted"
      ? control.canAccept
      : control.canReject;
  const reason =
    elements.acceptanceReason
      .value.trim();
  if (!allowed || !selectedWorkItemId) {
    showToast(
      "The selected delivery is not ready for that decision."
    );
    return;
  }
  if (!reason) {
    setAcceptanceReasonError();
    showToast(
      "Record an acceptance reason first."
    );
    elements.acceptanceReason.focus();
    return;
  }
  if (
    !control.reviewRevision ||
    !csrfToken
  ) {
    showToast(
      "The acceptance review is not ready. Refresh the dashboard."
    );
    return;
  }
  clearAcceptanceReasonError();
  const draft =
    requireAcceptanceDraft(
      selectedWorkItemId,
      control.reviewRevision
    );
  draft.reason = reason;
  draft.decisionId ??=
    crypto.randomUUID();
  const workItemId =
    selectedWorkItemId;
  let providerTruthRequired =
    decision === "accepted" &&
    latestSnapshot?.capabilities
      ?.linearTransition === true;

  setBusy(true);
  try {
    const response = await fetch(
      `/api/work-items/${encodeURIComponent(
        selectedWorkItemId
      )}/acceptance`,
      {
        method: "POST",
        headers: {
          "content-type":
            "application/json",
          "x-taskseal-csrf-token":
            csrfToken
        },
        body: JSON.stringify({
          decisionId:
            draft.decisionId,
          decision,
          reason,
          expectedReviewRevision:
            control.reviewRevision
        })
      }
    );
    const payload = await response.json();
    if (!response.ok) {
      providerTruthRequired = false;
      throw new Error(
        payload.message ??
          "TaskSeal acceptance failed."
      );
    }
    providerTruthRequired =
      typeof payload.linearSync
        ?.operationKey === "string";
    showToast(
      payload.linearSync?.status ===
        "sync_failed"
        ? "Local decision saved; Linear is not synchronized."
        : decision === "accepted"
          ? "Delivery accepted."
          : "Delivery rejected."
    );
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "TaskSeal acceptance failed."
    );
  } finally {
    beginAcceptanceTruthRefresh({
      workItemId,
      dashboard: true,
      provider:
        providerTruthRequired
    });
    await refreshAcceptanceTruth();
    setBusy(false);
  }
}

async function reconcileAcceptance() {
  const control =
    readAcceptanceControl();
  if (
    !control.canReconcile ||
    !control.operationKey ||
    !csrfToken
  ) {
    showToast(
      "No uncertain Linear transition is available to reconcile."
    );
    return;
  }
  const workItemId =
    selectedWorkItemId;
  let providerTruthRequired = true;
  setBusy(true);
  try {
    const response = await fetch(
      `/api/provider-operations/${encodeURIComponent(
        control.operationKey
      )}/reconcile`,
      {
        method: "POST",
        headers: {
          "content-type":
            "application/json",
          "x-taskseal-csrf-token":
            csrfToken
        },
        body: "{}"
      }
    );
    const payload = await response.json();
    if (!response.ok) {
      providerTruthRequired = false;
      throw new Error(
        payload.message ??
          "Linear reconciliation failed."
      );
    }
    providerTruthRequired =
      typeof payload.operationKey ===
      "string";
    showToast(
      payload.status === "reconciled"
        ? "Linear Done state reconciled."
        : "Linear reconciliation still needs attention."
    );
  } catch (error) {
    showToast(
      error instanceof Error
        ? error.message
        : "Linear reconciliation failed."
    );
  } finally {
    if (
      workItemId &&
      providerTruthRequired
    ) {
      beginAcceptanceTruthRefresh({
        workItemId,
        dashboard: false,
        provider: true
      });
    }
    await refreshAcceptanceTruth();
    setBusy(false);
  }
}

async function refreshAcceptanceTruth() {
  await Promise.all([
    requestSnapshot(
      "/api/dashboard",
      { method: "GET" },
      { silent: true }
    ),
    requestProviderSnapshot({
      silent: true
    })
  ]);
}

function beginAcceptanceTruthRefresh({
  workItemId,
  dashboard,
  provider
}) {
  acceptanceTruthFence.begin({
    workItemId,
    dashboardAfter:
      dashboard
        ? requestGate.latestIssued + 1
        : null,
    providerAfter:
      provider
        ? providerRequestGate
            .latestIssued + 1
        : null
  });
  applyAcceptanceControls();
}

function selectWorkItem(workItemId) {
  const workItems = latestSnapshot?.workItems ?? [];
  const selected =
    reconcileSelectedWorkItemId(
      workItemId,
      workItems
    );

  if (!selected || selected === selectedWorkItemId) {
    return;
  }

  selectedWorkItemId = selected;
  renderWorkItemSelector(workItems);
  initializePrompt(
    workItems.find(
      (workItem) => workItem.id === selected
    )
  );
  initializeAcceptanceDraft(
    workItems.find(
      (workItem) =>
        workItem.id === selected
    )
  );
  renderWorkItems(workItems);
  applyRunControls();
  applyAcceptanceControls();
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

    const nextProviderPanelState =
      reduceProviderPanelState(
      providerPanelState,
      {
        type: "success",
        model
      }
    );
    providerPanelState =
      nextProviderPanelState;
    if (
      didAdoptProviderPanelModel(
        nextProviderPanelState,
        model
      )
    ) {
      acceptanceTruthFence.confirm(
        "provider",
        sequence
      );
    }
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
      showToast(localizeProviderPanelMessage(providerPanelState));
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

    acceptanceTruthFence.confirm(
      "dashboard",
      sequence
    );
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
  latestSnapshot = snapshot;
  mode = isDemo ? "demo" : "persistent";
  demoComplete = isDemo && snapshot.demo.complete;
  selectedWorkItemId =
    reconcileSelectedWorkItemId(
      selectedWorkItemId,
      snapshot.workItems
    );
  csrfToken = snapshot.security?.csrfToken ?? csrfToken;

  elements.snapshotTime.textContent = t("dashboard.snapshot.label", {
    time: formatTime(snapshot.generatedAt)
  });
  elements.total.textContent = snapshot.summary.total;
  elements.agents.textContent = snapshot.summary.activeAgents;
  elements.reviewing.textContent = snapshot.summary.reviewing;
  elements.accepted.textContent = snapshot.summary.accepted;

  elements.demoControls.hidden = !isDemo;
  elements.runnerControls.hidden = isDemo;
  elements.environmentLabel.textContent = t(
    isDemo
      ? "dashboard.environment.local"
      : "dashboard.environment.persistent"
  );
  elements.providerPanel.hidden = isDemo;
  elements.orchestrationPanel.hidden =
    isDemo;

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
    const limit =
      snapshot.runtime?.capacity?.maxConcurrentRuns ?? 1;
    elements.stepCounter.textContent =
      activeIds.length > 0
        ? t("dashboard.runtime.activeRuns", {
            active: activeIds.length,
            limit
          })
        : t(
            limit === 1
              ? "dashboard.runtime.journalOnline"
              : "dashboard.runtime.journalOnlinePlural",
            { limit }
          );
    renderWorkItemSelector(snapshot.workItems);
    initializePrompt(
      snapshot.workItems.find(
        (workItem) =>
          workItem.id === selectedWorkItemId
      )
    );
    initializeAcceptanceDraft(
      snapshot.workItems.find(
        (workItem) =>
          workItem.id ===
          selectedWorkItemId
      )
    );
    applyRunControls();
    applyAcceptanceControls();
    renderOrchestration(snapshot);
    renderTimeline(
      createAttemptTimeline(
        snapshot.workItems,
        statusLabels
      )
    );
    revealRuntimeError(snapshot.runtime?.errors);
  }

  renderWorkItems(snapshot.workItems);
  announceSnapshot(snapshot);
}

function renderOrchestration(snapshot) {
  const model =
    createOrchestrationPanelModel(
      snapshot,
      busy,
      orchestrationMutation
    );
  elements.orchestrationPanel.dataset.state =
    model.plans.length === 0 &&
    model.retirements.length === 0
      ? "empty"
      : "ready";
  const renderKey =
    semanticSnapshotKey(model);
  if (
    renderKey ===
    renderedOrchestrationKey
  ) {
    return;
  }
  renderedOrchestrationKey =
    renderKey;
  const focusToken =
    document.activeElement
      ?.dataset
      ?.orchestrationFocus ??
    null;
  const retirementFocusPlanId =
    document.activeElement
      ?.dataset
      ?.retirementRecord ??
    null;

  elements.orchestrationPanel.hidden =
    !model.visible;
  elements.orchestrationOverview.textContent =
    t("dashboard.orchestration.overview", {
      active: model.plans.length,
      retired: model.retirements.length
    });
  elements.orchestrationPlans.innerHTML =
    model.plans.length === 0
      ? `
      <div class="orchestration-empty">
        <strong>${escapeHtml(t("dashboard.orchestration.noActive"))}</strong>
        <p>${escapeHtml(t("dashboard.orchestration.noActiveCopy"))}</p>
      </div>
      `
      : model.plans
          .map(
            renderOrchestrationPlan
          )
          .join("");
  elements.orchestrationRetirementCount
    .textContent =
      t("dashboard.orchestration.retiredCount", {
        count: model.retirements.length
      });
  elements.orchestrationRetirements
    .innerHTML =
      model.retirements.length === 0
        ? `
          <li class="orchestration-retirement-empty">
            ${escapeHtml(t("dashboard.orchestration.noRetirements"))}
          </li>
        `
        : model.retirements
            .map(
              renderRetirementAuditRecord
            )
            .join("");

  const accessibleState =
    createAccessibleOrchestrationState(
      snapshot
    );
  const accessibleKey =
    semanticSnapshotKey(
      accessibleState
    );
  if (
    accessibleKey !==
    announcedOrchestrationKey
  ) {
    announcedOrchestrationKey =
      accessibleKey;
    elements.orchestrationLiveStatus
      .textContent =
        createOrchestrationAnnouncement(
          model
        );
  }

  if (
    busy
  ) {
    return;
  }
  if (
    pendingRetirementFocusPlanId
  ) {
    restoreRetirementAuditFocus();
  } else if (
    retirementFocusPlanId
  ) {
    focusRetirementAuditRecord(
      retirementFocusPlanId
    );
  } else if (
    pendingOrchestrationFocusToken
  ) {
    if (
      restoreOrchestrationFocus(
        pendingOrchestrationFocusToken
      )
    ) {
      pendingOrchestrationFocusToken =
        null;
    }
  } else if (focusToken) {
    restoreOrchestrationFocus(
      focusToken
    );
  }
}

function renderOrchestrationPlan(plan) {
  const nodeById = new Map(
    plan.nodes.map((node) => [
      node.nodeId,
      node
    ])
  );
  const orderedNodes =
    plan.topologicalOrder
      .map((nodeId) =>
        nodeById.get(nodeId)
      )
      .filter(Boolean);
  const disabled =
    plan.dispatchControl.enabled
      ? ""
      : " disabled";
  const retirementDisabled =
    plan.retirementControl.enabled
      ? ""
      : " disabled";
  const draft =
    retirementDrafts.get(
      plan.planId
    ) ?? {
      open: false,
      reasonCode: "",
      note: "",
      confirmed: false
    };
  const retirementFormDisabled =
    plan.retirementControl.enabled &&
    !busy
      ? ""
      : " disabled";
  const busyDisabled =
    busy ? " disabled" : "";

  return `
    <article
      class="orchestration-plan"
      data-orchestration-plan="${escapeAttribute(
        plan.planId
      )}"
      tabindex="-1"
      aria-labelledby="orchestration-plan-${escapeAttribute(
        plan.planId
      )}"
    >
      <header class="orchestration-plan-header">
        <div>
          <p class="work-id">${escapeHtml(
            plan.planId
          )}</p>
          <h3 id="orchestration-plan-${escapeAttribute(
            plan.planId
          )}">
            ${escapeHtml(
              `${plan.progress.acceptedNodes} / ${plan.progress.totalNodes} nodes accepted`
            )}
          </h3>
          <p>
            ${escapeHtml(
              `${plan.progress.uncertainNodes} nodes remain unresolved · queue is ephemeral`
            )}
          </p>
        </div>
        <div class="orchestration-plan-actions">
          <button
            class="button button-primary orchestration-dispatch"
            type="button"
            data-dispatch-plan="${escapeAttribute(
              plan.planId
            )}"
            data-orchestration-focus="${escapeAttribute(
              `dispatch:${plan.planId}`
            )}"
            ${disabled}
          >
            ${escapeHtml(
              plan.dispatchControl.label
            )}
          </button>
          <button
            class="button button-secondary orchestration-retire-toggle"
            type="button"
            data-toggle-retirement="${escapeAttribute(
              plan.planId
            )}"
            data-orchestration-focus="${escapeAttribute(
              `retire-toggle:${plan.planId}`
            )}"
            aria-expanded="${
              draft.open
                ? "true"
                : "false"
            }"
            aria-controls="retirement-form-${escapeAttribute(
              plan.planId
            )}"
            ${retirementDisabled}
          >
            ${escapeHtml(
              plan.retirementControl
                .label
            )}
          </button>
        </div>
      </header>
      <dl class="orchestration-metadata">
        <div>
          <dt>Root</dt>
          <dd>${escapeHtml(
            plan.rootWorkItemId
          )}</dd>
        </div>
        <div>
          <dt>Approved by</dt>
          <dd>${escapeHtml(
            plan.approvedBy
          )}</dd>
        </div>
        <div>
          <dt>Plan revision</dt>
          <dd title="${escapeAttribute(
            plan.planDigest
          )}">${escapeHtml(
            shortDigest(
              plan.planDigest
            )
          )}</dd>
        </div>
        <div>
          <dt>Concurrency</dt>
          <dd>${escapeHtml(
            `${plan.activeNodeIds.length} active / ${plan.dispatch.maxParallelism} allowed`
          )}</dd>
        </div>
      </dl>
      <p class="orchestration-queue">
        ${escapeHtml(
          `${plan.queue.queuedCount} / ${plan.queue.limit} ready nodes · Ephemeral; dispatch again after active nodes settle`
        )}
      </p>
      <form
        class="orchestration-retirement-form"
        id="retirement-form-${escapeAttribute(
          plan.planId
        )}"
        data-retirement-form="${escapeAttribute(
          plan.planId
        )}"
        ${draft.open ? "" : " hidden"}
      >
        <p class="retirement-warning">
          Retirement is irreversible for this plan ID. It releases orchestration ownership without deleting WorkItems, Attempts, Artifacts, Evidence, or acceptance history.
        </p>
        <label>
          <span>Retirement reason</span>
          <select
            name="reasonCode"
            required
            data-retirement-reason="${escapeAttribute(
              plan.planId
            )}"
            data-orchestration-focus="${escapeAttribute(
              `retire-reason:${plan.planId}`
            )}"
            ${retirementFormDisabled}
          >
            ${renderRetirementReasonOptions(
              draft.reasonCode
            )}
          </select>
        </label>
        <label>
          <span>Audit note</span>
          <textarea
            name="note"
            maxlength="2048"
            required
            aria-required="true"
            data-orchestration-focus="${escapeAttribute(
              `retire-note:${plan.planId}`
            )}"
            ${retirementFormDisabled}
          >${escapeHtml(
            draft.note
          )}</textarea>
          <small>
            Required. The note is retained in the local lifecycle audit.
          </small>
        </label>
        <label class="retirement-confirmation">
          <input
            name="confirmed"
            type="checkbox"
            required
            data-orchestration-focus="${escapeAttribute(
              `retire-confirm:${plan.planId}`
            )}"
            ${
              draft.confirmed
                ? " checked"
                : ""
            }
            ${retirementFormDisabled}
          />
          <span>I understand this plan ID cannot be reactivated.</span>
        </label>
        <div class="orchestration-retirement-actions">
          <button
            class="button button-secondary"
            type="button"
            data-cancel-retirement="${escapeAttribute(
              plan.planId
            )}"
            data-orchestration-focus="${escapeAttribute(
              `retire-cancel:${plan.planId}`
            )}"
            ${busyDisabled}
          >
            Cancel
          </button>
          <button
            class="button button-danger"
            type="submit"
            data-orchestration-focus="${escapeAttribute(
              `retire-submit:${plan.planId}`
            )}"
            ${retirementFormDisabled}
          >
            ${
              orchestrationMutation
                ?.kind ===
                  "retire" &&
              orchestrationMutation
                .planId ===
                plan.planId
                ? "Retiring…"
                : "Confirm retirement"
            }
          </button>
        </div>
      </form>
      <ol
        class="orchestration-nodes"
        aria-label="Dependency nodes"
      >
        ${orderedNodes
          .map(renderOrchestrationNode)
          .join("")}
      </ol>
    </article>
  `;
}

function renderRetirementReasonOptions(
  selectedReason
) {
  const options = [
    ["", "Choose a reason…"],
    [
      "interrupted",
      "Execution interrupted"
    ],
    [
      "human_rejected",
      "Human rejected delivery"
    ],
    [
      "runner_profile_drift",
      "Runner profile changed"
    ],
    [
      "operator_rollback",
      "Operator rollback"
    ]
  ];
  return options
    .map(
      ([value, label]) => `
        <option
          value="${value}"
          ${
            value === selectedReason
              ? "selected"
              : ""
          }
        >${label}</option>
      `
    )
    .join("");
}

function renderRetirementAuditRecord(
  record
) {
  return `
    <li
      class="orchestration-retirement-record"
      data-retirement-record="${escapeAttribute(
        record.planId
      )}"
      tabindex="-1"
      aria-label="${escapeAttribute(
        `Plan ${record.planId} retired by ${record.retiredBy}`
      )}"
    >
      <div>
        <strong>${escapeHtml(
          record.planId
        )}</strong>
        <span>${escapeHtml(
          record.reasonLabel
        )}</span>
      </div>
      <time datetime="${escapeAttribute(
        record.retiredAt
      )}">${escapeHtml(
        formatDateTime(
          record.retiredAt
        )
      )}</time>
      <span>${escapeHtml(
        `Retired by ${record.retiredBy}`
      )}</span>
      <code title="${escapeAttribute(
        record.planDigest
      )}">${escapeHtml(
        shortDigest(
          record.planDigest
        )
      )}</code>
      <details>
        <summary>Audit note</summary>
        <p>${escapeHtml(
          record.note
        )}</p>
      </details>
    </li>
  `;
}

function createOrchestrationAnnouncement(
  model
) {
  const activeSummary =
    model.plans.length === 0
      ? t("dashboard.orchestration.announcement.none")
      : model.plans
          .map(
            (plan) => t("dashboard.orchestration.announcement.plan", {
              plan: plan.planId,
              accepted: plan.progress.acceptedNodes,
              total: plan.progress.totalNodes,
              running: plan.countsByPhase.running,
              waiting: plan.countsByPhase.waiting_dependencies,
              ready: plan.queue.queuedCount
            })
          )
          .join(" ");
  const latest =
    model.retirements[0];
  return latest
    ? `${activeSummary} ${t("dashboard.orchestration.announcement.retired", {
        count: model.retirements.length,
        plan: latest.planId,
        reason: latest.reasonLabel,
        actor: latest.retiredBy
      })}`
    : `${activeSummary} ${t("dashboard.orchestration.announcement.noRetirements")}`;
}

function restoreRetirementAuditFocus() {
  if (
    busy ||
    !pendingRetirementFocusPlanId
  ) {
    return;
  }
  if (
    focusRetirementAuditRecord(
      pendingRetirementFocusPlanId
    )
  ) {
    pendingRetirementFocusPlanId =
      null;
    pendingOrchestrationFocusToken =
      null;
  }
}

function focusRetirementAuditRecord(
  planId
) {
  const focusTarget =
    elements.orchestrationRetirements
      .querySelector(
        `[data-retirement-record="${escapeAttribute(
          planId
        )}"]`
      );
  focusTarget?.focus();
  return (
    focusTarget !== null &&
    document.activeElement ===
      focusTarget
  );
}

function restoreOrchestrationFocus(
  focusToken
) {
  const focusTarget =
    elements.orchestrationPlans
      .querySelector(
        `[data-orchestration-focus="${escapeAttribute(
          focusToken
        )}"]`
      );
  if (
    focusTarget &&
    !focusTarget.matches(
      ":disabled"
    )
  ) {
    focusTarget.focus();
    if (
      document.activeElement ===
      focusTarget
    ) {
      return true;
    }
  }
  const separator =
    focusToken.indexOf(":");
  const planId =
    separator >= 0
      ? focusToken.slice(
          separator + 1
        )
      : "";
  const fallback =
    planId.length > 0
      ? elements
          .orchestrationPlans
          .querySelector(
            `[data-orchestration-plan="${escapeAttribute(
              planId
            )}"]`
          )
      : null;
  fallback?.focus();
  return (
    fallback !== null &&
    document.activeElement ===
      fallback
  );
}

function renderOrchestrationNode(node) {
  const dependencies =
    node.dependsOn.length > 0
      ? node.dependsOn.join(", ")
      : "None";
  const blockers =
    node.blockingReasons.length > 0
      ? `
        <ul class="orchestration-blockers">
          ${node.blockingReasons
            .map(
              (reason) => `
                <li>
                  <strong>${escapeHtml(
                    reason.label
                  )}</strong>
                  ${
                    reason
                      .relatedNodeIds
                      .length > 0
                      ? `<span> · ${escapeHtml(
                          reason.relatedNodeIds.join(
                            ", "
                          )
                        )}</span>`
                      : ""
                  }
                </li>
              `
            )
            .join("")}
        </ul>
      `
      : "";
  const trace =
    node.attemptTrace.length > 0
      ? `
        <details>
          <summary>${escapeHtml(
            `${node.attemptTrace.length} attempt${
              node.attemptTrace.length ===
              1
                ? ""
                : "s"
            }`
          )}</summary>
          <ol class="orchestration-attempts">
            ${node.attemptTrace
              .map(
                (attempt) => `
                  <li>
                    <code>${escapeHtml(
                      attempt.id
                    )}</code>
                    <span>${escapeHtml(
                      `${attempt.status} · ${attempt.agentId}`
                    )}</span>
                  </li>
                `
              )
              .join("")}
          </ol>
        </details>
      `
      : "";

  return `
    <li class="orchestration-node" data-phase="${escapeAttribute(
      node.phase
    )}">
      <div class="orchestration-node-heading">
        <div>
          <span class="orchestration-phase">${escapeHtml(
            formatOrchestrationPhase(
              node.phase
            )
          )}</span>
          <h4>${escapeHtml(
            node.title
          )}</h4>
          <code>${escapeHtml(
            `${node.nodeId} · ${node.workItemId}`
          )}</code>
        </div>
        <span class="orchestration-evidence">
          ${escapeHtml(
            `${node.evidence.passed}/${node.evidence.total} evidence passed`
          )}
        </span>
      </div>
      <dl class="orchestration-node-facts">
        <div>
          <dt>Depends on</dt>
          <dd>${escapeHtml(
            dependencies
          )}</dd>
        </div>
        <div>
          <dt>Planned owner</dt>
          <dd>${escapeHtml(
            `${node.owner.runnerId} · ${node.owner.match}`
          )}</dd>
        </div>
        <div>
          <dt>Actual agent</dt>
          <dd>${escapeHtml(
            node.actualAgentId ??
              "Not started"
          )}</dd>
        </div>
        <div>
          <dt>Retry</dt>
          <dd>${escapeHtml(
            `${node.retry.attempts}/${node.retry.maxAttempts}${
              node.retry.nextEligibleAt
                ? ` · next ${node.retry.nextEligibleAt}`
                : ""
            }`
          )}</dd>
        </div>
      </dl>
      ${blockers}
      ${trace}
    </li>
  `;
}

function formatOrchestrationPhase(
  phase
) {
  return String(phase)
    .replaceAll("_", " ")
    .replace(
      /^./,
      (letter) =>
        letter.toUpperCase()
    );
}

function renderProviderPanel() {
  const { phase, model } = providerPanelState;
  elements.providerPanel.dataset.state =
    model &&
    model.cards.length === 0 &&
    model.operations.length === 0
      ? "empty"
      : phase;
  const isLoading =
    phase === "loading" || phase === "refreshing";
  elements.providerContent.setAttribute(
    "aria-busy",
    String(isLoading)
  );
  elements.providerRefresh.textContent = isLoading
    ? t("dashboard.provider.refreshing")
    : t("common.action.refresh");
  elements.providerRefresh.disabled = phase === "loading";
  elements.providerBanner.hidden = phase !== "stale";

  if (phase === "stale") {
    elements.providerBanner.dataset.tone = "warning";
    elements.providerBanner.textContent =
      localizeProviderPanelMessage(providerPanelState);
  } else {
    elements.providerBanner.textContent = "";
    delete elements.providerBanner.dataset.tone;
  }

  const contentKey =
    createProviderContentRenderKey(providerPanelState);
  if (contentKey === renderedProviderKey) {
    updateProviderObservationTimes();
    announceProviderPanel();
    applyAcceptanceControls();
    return;
  }
  renderedProviderKey = contentKey;

  if (phase === "idle" || phase === "loading") {
    elements.providerOverview.textContent =
      t("dashboard.provider.loading");
    elements.providerCards.innerHTML =
      renderProviderStateMessage({
        className: "provider-state-loading",
        icon: "",
        title: t("dashboard.provider.loadingTitle"),
        description:
          t("dashboard.provider.loadingCopy")
      });
    elements.providerLatestPanel.hidden = true;
  } else if (phase === "error") {
    elements.providerOverview.textContent =
      t("dashboard.provider.unavailable");
    elements.providerCards.innerHTML =
      renderProviderStateMessage({
        className: "provider-state-error",
        icon: "!",
        title: t("dashboard.provider.unavailableTitle"),
        description:
          t("dashboard.provider.unavailableCopy")
      });
    elements.providerLatestPanel.hidden = true;
  } else if (
    model &&
    model.cards.length === 0 &&
    model.operations.length === 0
  ) {
    elements.providerOverview.textContent =
      "0 targets · 0 controlled writes";
    elements.providerCards.innerHTML =
      renderProviderStateMessage({
        className: "",
        icon: "○",
        title: t("dashboard.provider.emptyTitle"),
        description:
          t("dashboard.provider.emptyCopy")
      });
    elements.providerLatestPanel.hidden = true;
  } else if (model) {
    elements.providerOverview.textContent =
      `${model.summary.total} targets · ` +
      `${model.summary.ready} ready · ` +
      `${model.summary.operations} controlled writes · ` +
      `${model.summary.approvalRequired} need approval`;
    elements.providerCards.innerHTML =
      model.cards.length > 0
        ? model.cards
            .map(renderProviderCard)
            .join("")
        : renderProviderStateMessage({
            className: "",
            icon: "○",
            title:
              t("dashboard.provider.emptyTitle"),
            description:
              "Controlled operations remain visible while the observation read model is empty."
          });
    elements.providerLatest.innerHTML = model.latest
      .map(renderLatestProviderObservation)
      .join("");
    elements.providerOperations.innerHTML =
      model.operations
        .map(renderLatestControlledOperation)
        .join("");
    elements.providerOperationsEmpty.hidden =
      model.operations.length > 0;
    elements.providerLatestPanel.hidden = false;
  }

  announceProviderPanel();
  applyAcceptanceControls();
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
          <small>${
            card.controlledWrite
              ? `Operation v${card.controlledWrite.version}`
              : card.approvalLabel ===
                  "Operation journal not connected"
                ? "Read-only v1 compatibility"
                : "No operation for this target"
          }</small>
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
          ${renderProviderTechnicalDetail(
            "Controlled operation",
            card.controlledWrite
              ? shortDigest(
                  card.controlledWrite
                    .operationKey
                ) ?? "—"
              : "—"
          )}
          ${renderProviderTechnicalDetail(
            "Write status",
            card.controlledWrite
              ?.statusLabel ?? "—"
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

function renderLatestControlledOperation(
  operation
) {
  const diagnostic = operation.diagnosticCode
    ? ` · ${operation.diagnosticCode}`
    : "";

  return `
    <li data-tone="${escapeAttribute(operation.tone)}">
      <span class="provider-latest-icon" aria-hidden="true">
        ${escapeHtml(operation.statusIcon)}
      </span>
      <div class="provider-latest-copy">
        <strong>
          ${escapeHtml(operation.providerLabel)} ·
          ${escapeHtml(operation.statusLabel)}
        </strong>
        <span>
          ${escapeHtml(operation.configuredTarget.key)} ·
          v${escapeHtml(String(operation.version))} ·
          ${escapeHtml(
            shortDigest(operation.operationKey) ??
              operation.operationKey
          )}${escapeHtml(diagnostic)}
        </span>
        <time
          datetime="${escapeAttribute(operation.updatedAt)}"
          data-observed-at="${escapeAttribute(operation.updatedAt)}"
        >
          ${escapeHtml(formatObservationTime(operation.updatedAt))}
        </time>
      </div>
    </li>
  `;
}

function announceProviderPanel() {
  if (providerPanelState.phase === "refreshing") {
    return;
  }

  const summary = localizeProviderAccessibleSummary(providerPanelState);
  const key = semanticSnapshotKey(summary);

  if (key === announcedProviderKey) {
    return;
  }
  announcedProviderKey = key;
  elements.providerLiveStatus.textContent = summary;
}

function renderWorkItemSelector(workItems) {
  const selectorKey = semanticSnapshotKey(
    workItems.map(({ id, title }) => ({
      id,
      title
    }))
  );

  if (selectorKey !== renderedWorkItemSelectorKey) {
    renderedWorkItemSelectorKey = selectorKey;
    elements.workItemSelect.innerHTML =
      workItems.length > 0
        ? workItems
            .map(
              (workItem) =>
                `<option value="${escapeAttribute(
                  workItem.id
                )}">${escapeHtml(
                  `${workItem.id} · ${workItem.title}`
                )}</option>`
            )
            .join("")
        : '<option value="">No work items</option>';
  }

  elements.workItemSelect.value =
    selectedWorkItemId ?? "";
  elements.workItemSelect.disabled =
    workItems.length === 0 || busy;
}

function applyRunControls() {
  if (!latestSnapshot || mode !== "persistent") {
    return;
  }

  const control = createRunControlState(
    latestSnapshot,
    selectedWorkItemId,
    busy
  );
  elements.codexRunButton.disabled = !control.canRun;
  elements.codexRunButton.textContent = localizeControlLabel(control.runLabel);
  elements.codexCancelButton.disabled =
    !control.canCancel;
  elements.codexCancelButton.hidden =
    !control.canCancel;
  elements.codexCancelButton.textContent =
    localizeControlLabel(control.cancelLabel);
  if (
    control.statusLabel !==
    lastRunnerStatusLabel
  ) {
    lastRunnerStatusLabel =
      control.statusLabel;
    elements.runnerStatus.textContent =
      localizeRunStatusLabel(control.statusLabel);
  }
  elements.workItemSelect.disabled =
    latestSnapshot.workItems.length === 0 ||
    busy;
}

function readAcceptanceControl() {
  return createAcceptanceControlState(
    latestSnapshot ?? {
      mode: null,
      capabilities: {},
      security: {},
      workItems: []
    },
    selectedWorkItemId,
    providerPanelState,
    busy,
    {
      dashboard:
        acceptanceTruthFence.pendingFor(
          selectedWorkItemId,
          "dashboard"
        ),
      provider:
        acceptanceTruthFence.pendingFor(
          selectedWorkItemId,
          "provider"
        )
    }
  );
}

function applyAcceptanceControls() {
  if (!latestSnapshot || mode !== "persistent") {
    return;
  }
  const control =
    readAcceptanceControl();
  elements.acceptanceAcceptButton.disabled =
    !control.canAccept;
  elements.acceptanceRejectButton.disabled =
    !control.canReject;
  elements.acceptanceReconcileButton.hidden =
    !control.operationKey;
  elements.acceptanceReconcileButton.disabled =
    !control.canReconcile;
  elements.acceptanceLocalStatus.textContent =
    `${localizeControlLabel(control.localLabel)}${
      control.dashboardTruthPending
        ? ` · ${t("dashboard.acceptance.awaitingRefresh")}`
        : ""
    }`;
  elements.acceptanceLinearStatus.textContent =
    `${localizeControlLabel(control.linearLabel)}${
      control.linearStale
        ? ` · ${t("dashboard.acceptance.stale")}`
        : ""
    }`;
  elements.acceptanceLinearStatus.dataset.tone =
    control.linearTone;
  elements.acceptanceOperator.textContent =
    control.operatorId
      ? t("dashboard.acceptance.currentOperator", { operator: control.operatorId })
      : t("dashboard.acceptance.operatorUnavailable");
  renderAcceptanceAudit(control);
  const formAvailable = control.decisionFormAvailable === true;
  elements.acceptanceControls.dataset.blockReason = formAvailable
    ? ""
    : control.decisionBlockReason ?? "review-unavailable";
  elements.acceptanceDecisionForm.hidden = !formAvailable;
  elements.acceptanceUnavailable.hidden = formAvailable;
  elements.acceptanceReason.disabled = !formAvailable;
  if (!formAvailable) {
    const reasonKey = {
      "operator-unavailable": "dashboard.acceptance.unavailable.operator",
      "review-unavailable": "dashboard.acceptance.unavailable.review",
      "decomposition-blocked": "dashboard.acceptance.unavailable.decomposition",
      "decision-recorded": "dashboard.acceptance.unavailable.recorded",
      busy: "dashboard.acceptance.unavailable.busy"
    }[control.decisionBlockReason] ?? "dashboard.acceptance.unavailable.review";
    elements.acceptanceUnavailableMessage.textContent = t(reasonKey);
    elements.acceptanceSettingsLink.hidden = control.decisionBlockReason !== "operator-unavailable";
  }
}

function localizeProviderPanelMessage(state) {
  const messageKey = {
    "provider-refresh-older": "dashboard.provider.refreshOlder",
    "provider-refresh-failed": "dashboard.provider.refreshFailed",
    "provider-unavailable": "dashboard.provider.unavailable"
  }[state?.messageCode];
  return messageKey
    ? t(messageKey)
    : state?.phase === "error"
      ? t("dashboard.provider.unavailable")
      : state?.message ?? "";
}

function localizeProviderAccessibleSummary(state) {
  if (state?.phase === "idle" || state?.phase === "loading") {
    return t("dashboard.provider.loadingTitle");
  }
  if (state?.phase === "error") {
    return t("dashboard.provider.unavailableTitle");
  }
  if (state?.phase === "empty") {
    return t("dashboard.provider.emptyTitle");
  }
  return createProviderAccessibleSummary(state);
}

function renderAcceptanceAudit(control) {
  const renderKey = semanticSnapshotKey({
    currentDecision:
      control.currentDecision,
    acceptanceHistory:
      control.acceptanceHistory
  });
  if (
    elements.acceptanceAudit.dataset
      .renderKey === renderKey
  ) {
    return;
  }

  const current =
    control.currentDecision;
  const history =
    control.acceptanceHistory ?? [];
  const currentMarkup = current
    ? `
        <div class="acceptance-current-decision">
          <span class="detail-label">${escapeHtml(t("dashboard.acceptance.currentDecision"))}</span>
          <strong>
            ${escapeHtml(formatAcceptanceDecision(current, current.actor))}
          </strong>
          <time datetime="${escapeAttribute(current.decidedAt)}">
            ${escapeHtml(formatObservationTime(current.decidedAt))}
          </time>
          <p>${escapeHtml(current.reason)}</p>
          <code>${escapeHtml(
            current.basis?.decisionId ??
              "Legacy decision"
          )}</code>
        </div>
      `
    : `<p>${escapeHtml(t("dashboard.acceptance.noCurrent"))}</p>`;
  const historyMarkup =
    history.length > 0
      ? `
          <details class="acceptance-history">
            <summary>
              ${escapeHtml(t("dashboard.acceptance.history", { count: history.length }))}
            </summary>
            <ol>
              ${history
                .toReversed()
                .map(renderAcceptanceHistoryEntry)
                .join("")}
            </ol>
          </details>
        `
      : "";

  elements.acceptanceAudit.innerHTML =
    currentMarkup + historyMarkup;
  elements.acceptanceAudit.dataset
    .renderKey = renderKey;
}

function renderAcceptanceHistoryEntry(
  decision
) {
  return `
    <li>
      <strong>
        ${escapeHtml(formatAcceptanceDecision(decision, decision.actor))}
      </strong>
      <time datetime="${escapeAttribute(decision.decidedAt)}">
        ${escapeHtml(formatObservationTime(decision.decidedAt))}
      </time>
      <p>${escapeHtml(decision.reason)}</p>
      <code>${escapeHtml(
        decision.basis?.decisionId ??
          "Legacy decision"
      )}</code>
    </li>
  `;
}

function formatAcceptanceDecision(
  decision,
  actor
) {
  return t(
    decision.decision === "accepted"
      ? "dashboard.acceptance.acceptedBy"
      : "dashboard.acceptance.rejectedBy",
    { actor }
  );
}

function setAcceptanceReasonError() {
  elements.acceptanceReason.setAttribute(
    "aria-invalid",
    "true"
  );
  elements.acceptanceReasonHelp.dataset.tone =
    "danger";
  elements.acceptanceReasonHelp.textContent =
    t("dashboard.acceptance.reasonError");
}

function clearAcceptanceReasonError() {
  elements.acceptanceReason.removeAttribute(
    "aria-invalid"
  );
  delete elements.acceptanceReasonHelp.dataset
    .tone;
  elements.acceptanceReasonHelp.textContent =
    t("dashboard.acceptance.reasonHelp");
}

function initializePrompt(workItem) {
  if (
    promptDrafts.currentWorkItemId ===
    (workItem?.id ?? null)
  ) {
    return;
  }

  elements.promptInput.value =
    promptDrafts.switchTo(
      workItem,
      elements.promptInput.value
    );
}

function initializeAcceptanceDraft(
  workItem
) {
  const previousWorkItemId =
    acceptanceDraftWorkItemId;
  if (
    previousWorkItemId &&
    previousWorkItemId !==
      workItem?.id
  ) {
    saveAcceptanceDraft();
  }
  if (!workItem) {
    if (previousWorkItemId) {
      clearAcceptanceReasonError();
    }
    acceptanceDraftWorkItemId = null;
    elements.acceptanceReason.value =
      "";
    return;
  }
  const reviewRevision =
    workItem.acceptanceReviewRevision ??
    null;
  const existing =
    acceptanceDrafts.get(workItem.id);
  const reviewChanged =
    shouldResetAcceptanceReasonError({
      previousWorkItemId,
      nextWorkItemId: workItem.id,
      previousReviewRevision:
        existing?.reviewRevision ??
        null,
      nextReviewRevision:
        reviewRevision
    });
  if (reviewChanged) {
    clearAcceptanceReasonError();
  }
  const draft =
    existing?.reviewRevision ===
    reviewRevision
      ? existing
      : {
          reviewRevision,
          reason:
            existing?.reason ?? "",
          decisionId: null
        };
  acceptanceDrafts.set(
    workItem.id,
    draft
  );
  acceptanceDraftWorkItemId =
    workItem.id;
  elements.acceptanceReason.value =
    draft.reason;
}

function saveAcceptanceDraft() {
  if (!acceptanceDraftWorkItemId) {
    return;
  }
  const current =
    acceptanceDrafts.get(
      acceptanceDraftWorkItemId
    );
  if (current) {
    current.reason =
      elements.acceptanceReason.value;
  }
}

function requireAcceptanceDraft(
  workItemId,
  reviewRevision
) {
  const existing =
    acceptanceDrafts.get(workItemId);
  if (
    existing?.reviewRevision ===
    reviewRevision
  ) {
    return existing;
  }
  const draft = {
    reviewRevision,
    reason:
      elements.acceptanceReason.value,
    decisionId: null
  };
  acceptanceDrafts.set(
    workItemId,
    draft
  );
  return draft;
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
  const renderKey = semanticSnapshotKey({
    busy,
    selectedWorkItemId,
    workItems
  });

  if (renderKey === renderedWorkItemsKey) {
    return;
  }

  renderedWorkItemsKey = renderKey;
  const focusedWorkItemId =
    document.activeElement?.dataset
      ?.selectWorkItem ?? null;

  if (workItems.length === 0) {
    elements.workItems.innerHTML = `
      <div
        class="empty-state"
        data-work-items-empty
        tabindex="-1"
        aria-label="${escapeAttribute(t("dashboard.work.emptyLabel"))}"
      >
        <strong>No work items yet</strong>
        <p>Run the first event to ingest a task.</p>
      </div>
    `;
    if (focusedWorkItemId) {
      elements.workItems
        .querySelector("[data-work-items-empty]")
        ?.focus();
    }
    return;
  }

  elements.workItems.innerHTML = workItems.map(renderWorkItem).join("");

  if (focusedWorkItemId) {
    const selectionButtons = [
      ...elements.workItems.querySelectorAll(
        "[data-select-work-item]"
      )
    ];
    const focusTarget =
      selectionButtons.find(
        (button) =>
          button.dataset.selectWorkItem ===
          focusedWorkItemId
      ) ??
      selectionButtons.find(
        (button) =>
          button.dataset.selectWorkItem ===
          selectedWorkItemId
      );

    if (focusTarget) {
      focusTarget.focus();
    } else {
      elements.workItemSelect.focus();
    }
  }
}

function renderWorkItem(item) {
  const currentAttempt = item.activeAttempt;
  const currentArtifact = item.activeArtifact;
  const decision = item.acceptanceDecision;
  const decisionView = getDecisionView(decision);
  const isSelected =
    item.id === selectedWorkItemId;

  return `
    <article
      class="work-item-card${isSelected ? " is-selected" : ""}"
      aria-label="${escapeAttribute(t("dashboard.work.itemLabel", { id: item.id }))}"
    >
      <div class="work-item-header">
        <div>
          <div class="work-id">${escapeHtml(item.id)}</div>
          <h3>${escapeHtml(item.title)}</h3>
        </div>
        <div class="work-item-heading-actions">
          <span class="status status-${escapeAttribute(item.status)}">
            <span aria-hidden="true"></span>
            ${escapeHtml(statusLabels[item.status] ?? item.status)}
          </span>
          <button
            class="work-item-select"
            type="button"
            data-select-work-item="${escapeAttribute(item.id)}"
            aria-pressed="${String(isSelected)}"
            ${busy ? "disabled" : ""}
          >
            ${escapeHtml(t(isSelected ? "dashboard.work.selected" : "dashboard.work.select"))}
          </button>
        </div>
      </div>

      ${renderDeliveryProgress(item.progress)}

      <div class="work-detail-grid">
        <div class="detail-block">
          <span class="detail-label">${escapeHtml(t("dashboard.work.assignedAgent"))}</span>
          ${
            currentAttempt
              ? `<strong>${escapeHtml(currentAttempt.agentId)}</strong>
                 <small>${escapeHtml(statusLabels[currentAttempt.status] ?? currentAttempt.status)}</small>`
              : `<strong>${escapeHtml(t("dashboard.work.waitingDispatch"))}</strong>
                 <small>${escapeHtml(t("dashboard.work.noActiveAttempt"))}</small>`
          }
        </div>
        <div class="detail-block">
          <span class="detail-label">${escapeHtml(t("dashboard.work.currentArtifact"))}</span>
          ${
            currentArtifact
              ? renderArtifact(currentArtifact)
              : `<strong>${escapeHtml(t("dashboard.work.notSubmitted"))}</strong>
                 <small>${escapeHtml(t("dashboard.work.evidenceWaiting"))}</small>`
          }
        </div>
      </div>

      ${renderAttemptHistory(item.attempts)}

      <div class="evidence-row">
        <span class="detail-label">${escapeHtml(t("dashboard.work.requiredEvidence"))}</span>
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

function renderAttemptHistory(attempts) {
  if (attempts.length === 0) {
    return `
      <section class="attempt-history" aria-label="${escapeAttribute(t("dashboard.work.attemptHistory"))}">
        <span class="detail-label">${escapeHtml(t("dashboard.work.attemptHistory"))}</span>
        <p>${escapeHtml(t("dashboard.work.noAttempts"))}</p>
      </section>
    `;
  }

  return `
    <section class="attempt-history" aria-label="${escapeAttribute(t("dashboard.work.attemptHistory"))}">
      <span class="detail-label">${escapeHtml(t("dashboard.work.attemptHistory"))}</span>
      <ol>
        ${attempts
          .toReversed()
          .map(
            (attempt) => `
              <li>
                <div>
                  <strong>${escapeHtml(attempt.id)}</strong>
                  <span>${escapeHtml(attempt.agentId)}</span>
                </div>
                <div>
                  <span class="attempt-status attempt-${escapeAttribute(
                    attempt.status
                  )}">
                    ${escapeHtml(
                      statusLabels[attempt.status] ??
                        attempt.status
                    )}
                  </span>
                  <time datetime="${escapeAttribute(
                    attempt.completedAt ??
                      attempt.startedAt
                  )}">
                    ${escapeHtml(
                      formatTime(
                        attempt.completedAt ??
                          attempt.startedAt
                      )
                    )}
                  </time>
                </div>
              </li>
            `
          )
          .join("")}
      </ol>
    </section>
  `;
}

function renderEvidence(criterion, evidence) {
  const latest = evidence.filter(
    (item) => item.criterionKey === criterion
  ).at(-1);
  const outcome = latest?.outcome ?? "missing";
  const outcomeLabel = {
    passed: t("dashboard.work.evidence.passed"),
    failed: t("dashboard.work.evidence.failed"),
    missing: t("dashboard.work.evidence.missing")
  }[outcome] ?? outcome;

  return `
    <span class="evidence evidence-${outcome}">
      <span aria-hidden="true">${outcome === "passed" ? "✓" : "·"}</span>
      ${escapeHtml(criterion)} — ${escapeHtml(outcomeLabel)}
    </span>
  `;
}

function renderDeliveryProgress(progress) {
  const accepted = progress?.accepted === true;
  const passed = Number.isInteger(
    progress?.passedEvidence
  )
    ? progress.passedEvidence
    : 0;
  const failed = Number.isInteger(
    progress?.failedEvidence
  )
    ? progress.failedEvidence
    : 0;
  const missing = Number.isInteger(
    progress?.missingEvidence
  )
    ? progress.missingEvidence
    : 0;
  const total = Number.isInteger(
    progress?.totalEvidence
  )
    ? progress.totalEvidence
    : 0;

  return `
    <div
      class="progress-row"
      aria-label="${escapeAttribute(
        accepted
          ? t("dashboard.work.progressAccepted")
          : t("dashboard.work.progressCount", { passed, total })
      )}"
    >
      <div>
        <span class="detail-label">${escapeHtml(t("dashboard.work.progress"))}</span>
        <strong>${
          accepted
            ? escapeHtml(t("dashboard.work.progressAccepted"))
            : escapeHtml(t("dashboard.work.progressCount", { passed, total }))
        }</strong>
        <small>${
          accepted
            ? escapeHtml(t("dashboard.work.progressAcceptedHint"))
            : escapeHtml(t("dashboard.work.progressPendingHint", { failed, missing }))
        }</small>
      </div>
      <span class="progress-certainty">
        ${escapeHtml(t(accepted ? "dashboard.work.verified" : "dashboard.work.uncertain"))}
      </span>
    </div>
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
      title: t("dashboard.work.ownerAccepted"),
      description: escapeHtml(decision.reason)
    };
  }

  if (decision?.decision === "rejected") {
    return {
      className: "decision-rejected",
      icon: "×",
      title: t("dashboard.work.ownerRejected"),
      description: escapeHtml(decision.reason)
    };
  }

  return {
    className: "",
    icon: "○",
    title: t("dashboard.work.acceptancePending"),
    description:
      t("dashboard.work.acceptanceRequired")
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
        } ${step.latest ? "latest" : ""}"${
          step.latest ? ' aria-current="true"' : ""
        }>
          <span class="timeline-node">${step.completed ? "✓" : step.number}</span>
          <div>
            <div class="timeline-meta">
              <small>${escapeHtml(step.source)}</small>
              ${
                step.latest
                  ? `<span class="timeline-latest">${escapeHtml(
                      t("dashboard.timeline.latest")
                    )}</span>`
                  : ""
              }
              ${
                step.startedAt
                  ? `<time datetime="${escapeAttribute(
                      step.startedAt
                    )}">${escapeHtml(formatTime(step.startedAt))}</time>`
                  : ""
              }
            </div>
            <strong>${escapeHtml(step.label)}</strong>
            ${
              step.summary
                ? `<details class="timeline-summary">
                    <summary>${escapeHtml(
                      t("dashboard.timeline.summary")
                    )}</summary>
                    <p>${escapeHtml(step.summary)}</p>
                  </details>`
                : ""
            }
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
                ? t("dashboard.announcement.artifactLinked", {
                    kind: workItem.artifact.kind
                  })
                : t("dashboard.announcement.artifactPending");

              return t("dashboard.announcement.workItem", {
                workItem: workItem.id,
                status: statusLabels[workItem.status] ?? workItem.status,
                artifact: artifactSummary,
                passed: passedEvidence,
                total: workItem.evidence.length
              });
            }
          )
          .join(t("common.separator.sentence"))
      : t("dashboard.announcement.noWorkItems");
  const demoSummary = state.demo
    ? `${t("dashboard.announcement.demo", {
        current: state.demo.currentStep,
        total: state.demo.totalSteps,
        label: state.demo.activeLabel ?? "—"
      })} `
    : "";
  elements.liveStatus.textContent = `${demoSummary}${t("dashboard.announcement.summary", {
    work: workSummary,
    agents: state.activeAgents
  })}`;
}

function setBusy(isBusy) {
  if (isBusy && !busy) {
    pendingOrchestrationFocusToken =
      document.activeElement
        ?.dataset
        ?.orchestrationFocus ??
      null;
  }
  busy = isBusy;
  elements.resetButton.disabled = isBusy;
  elements.nextButton.disabled = isBusy || demoComplete;
  elements.runButton.disabled = isBusy || demoComplete;
  if (latestSnapshot?.workItems) {
    renderWorkItems(latestSnapshot.workItems);
    renderOrchestration(
      latestSnapshot
    );
  }
  if (
    !isBusy &&
    !pendingRetirementFocusPlanId &&
    pendingOrchestrationFocusToken
  ) {
    if (
      restoreOrchestrationFocus(
        pendingOrchestrationFocusToken
      )
    ) {
      pendingOrchestrationFocusToken =
        null;
    }
  }
  applyRunControls();
  applyAcceptanceControls();
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("toast-visible");
  window.setTimeout(() => elements.toast.classList.remove("toast-visible"), 3200);
}

function formatTime(value) {
  return new Intl.DateTimeFormat(currentLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat(
    currentLocale(),
    {
      dateStyle: "medium",
      timeStyle: "short"
    }
  ).format(new Date(value));
}

function formatObservationTime(value) {
  const timestamp = Date.parse(value);
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  const relativeFormatter = new Intl.RelativeTimeFormat(
    currentLocale(),
    {
      numeric: "auto",
      style: "short"
    }
  );
  const relative =
    minutes < 1
      ? relativeFormatter.format(0, "second")
      : minutes < 60
        ? relativeFormatter.format(-minutes, "minute")
        : minutes < 1_440
          ? relativeFormatter.format(-Math.floor(minutes / 60), "hour")
          : relativeFormatter.format(-Math.floor(minutes / 1_440), "day");
  const absolute = new Intl.DateTimeFormat(currentLocale(), {
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
