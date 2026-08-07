import { currentLocale, initializePresentation } from "/presentation.js";
import {
  createDialogController,
  setVisible
} from "/ui-primitives.js";

await initializePresentation();

const locale = currentLocale();
const zh = locale === "zh-CN";
const labels = zh
  ? {
      modePersistent: "持久化日志",
      modeDemo: "演示数据",
      fresh: "数据新鲜",
      stale: "数据已过期",
      unavailable: "不可用",
      running: "正在执行",
      cancelling: "取消中",
      terminalizing: "保存结果中",
      planned: "待执行",
      awaitingArtifact: "等待 Artifact",
      awaitingEvidence: "等待 Evidence",
      awaitingAcceptance: "等待验收",
      blocked: "已阻塞",
      accepted: "已验证",
      unknown: "状态待确认",
      noRunning: "当前没有正在执行的任务",
      noAttention: "当前无需你处理",
      noNext: "暂无可执行任务",
      noRecent: "还没有已验证交付",
      view: "查看详情",
      run: "开始执行",
      cancel: "取消执行",
      review: "审核交付",
      open: "查看处理",
      resolve: "查看阻塞",
      loading: "读取中…",
      retry: "重试",
      close: "关闭",
      runTitle: "开始一次受控执行",
      prompt: "任务说明",
      promptPlaceholder: "描述这次执行的明确工作边界…",
      readOnly: "只读验证",
      confirmRun: "运行 Codex",
      cancelTitle: "取消当前执行",
      confirmCancel: "确认取消",
      acceptanceTitle: "人工验收",
      reason: "验收说明",
      reasonPlaceholder: "记录接受或拒绝该交付的原因…",
      accept: "接受交付",
      reject: "拒绝交付",
      unavailableAcceptance: "当前未配置可追责的人工操作人",
      evidence: "证据",
      artifact: "Artifact",
      agent: "Agent",
      elapsed: "已运行",
      nextAction: "下一步",
      external: "外部 Issue",
      factsReady: "证据门禁已满足",
      noArtifact: "尚未提交当前 Artifact",
      evidenceMissing: "项证据缺失",
      evidenceFailed: "项证据失败",
      snapshotFailed: "无法读取当前交付状态",
      snapshotFailedCopy: "请检查运行中心是否仍在运行，然后重试。"
    }
  : {
      modePersistent: "Persistent journal",
      modeDemo: "Demo data",
      fresh: "Fresh data",
      stale: "Stale data",
      unavailable: "Unavailable",
      running: "Running",
      cancelling: "Cancelling",
      terminalizing: "Saving outcome",
      planned: "Next up",
      awaitingArtifact: "Waiting for Artifact",
      awaitingEvidence: "Waiting for Evidence",
      awaitingAcceptance: "Awaiting acceptance",
      blocked: "Blocked",
      accepted: "Verified",
      unknown: "Unknown",
      noRunning: "No tasks are running",
      noAttention: "Nothing needs your attention",
      noNext: "No executable tasks yet",
      noRecent: "No verified deliveries yet",
      view: "View details",
      run: "Start run",
      cancel: "Cancel run",
      review: "Review delivery",
      open: "View issue",
      resolve: "View blocker",
      loading: "Loading…",
      retry: "Retry",
      close: "Close",
      runTitle: "Start a controlled run",
      prompt: "Assignment",
      promptPlaceholder: "Describe the bounded work for this attempt…",
      readOnly: "Read-only validation",
      confirmRun: "Run Codex",
      cancelTitle: "Cancel current run",
      confirmCancel: "Confirm cancel",
      acceptanceTitle: "Human acceptance",
      reason: "Review reason",
      reasonPlaceholder: "Record why this delivery is accepted or rejected…",
      accept: "Accept delivery",
      reject: "Reject delivery",
      unavailableAcceptance: "No accountable human operator is configured",
      evidence: "Evidence",
      artifact: "Artifact",
      agent: "Agent",
      elapsed: "Running for",
      nextAction: "Next action",
      external: "External issue",
      factsReady: "Evidence gate is satisfied",
      noArtifact: "No current Artifact submitted",
      evidenceMissing: "evidence missing",
      evidenceFailed: "evidence failed",
      snapshotFailed: "Unable to read delivery state",
      snapshotFailedCopy: "Check that the Control Room is still running and retry."
    };

const elements = {
  mode: document.querySelector("#home-mode"),
  freshness: document.querySelector("#home-freshness"),
  project: document.querySelector("#home-project-name"),
  updated: document.querySelector("#home-updated-at"),
  banner: document.querySelector("#home-truth-banner"),
  runningSummary: document.querySelector("#summary-running"),
  attentionSummary: document.querySelector("#summary-attention"),
  nextSummary: document.querySelector("#summary-next"),
  verifiedSummary: document.querySelector("#summary-verified"),
  capacity: document.querySelector("#runtime-capacity"),
  attentionCount: document.querySelector("#attention-count"),
  nextCount: document.querySelector("#next-count"),
  runningList: document.querySelector("#running-list"),
  attentionList: document.querySelector("#attention-list"),
  nextList: document.querySelector("#next-list"),
  recentList: document.querySelector("#recent-list"),
  error: document.querySelector("#home-error"),
  errorMessage: document.querySelector("#home-error-message"),
  retry: document.querySelector("#home-retry"),
  live: document.querySelector("#home-live-status"),
  toast: document.querySelector("#home-toast"),
  dialog: document.querySelector("#task-detail-dialog"),
  detail: document.querySelector("#task-detail-content")
};

const dialog = createDialogController(elements.dialog);
let homeSnapshot = null;
let dashboardSnapshot = null;
let csrfToken = null;
let busy = false;

elements.retry.addEventListener("click", () => loadHome());
elements.runningList.addEventListener("click", handleListAction);
elements.attentionList.addEventListener("click", handleListAction);
elements.nextList.addEventListener("click", handleListAction);
elements.recentList.addEventListener("click", handleListAction);
elements.detail.addEventListener("click", handleDetailClick);
elements.detail.addEventListener("submit", handleDetailSubmit);
document.addEventListener("taskseal:locale-changed", () => window.location.reload());

await loadHome();
window.setInterval(loadHome, 2_000);

async function loadHome() {
  try {
    const payload = await requestJson("/api/home");
    if (payload?.schemaVersion !== "home/v1") {
      throw new Error("HOME_SNAPSHOT_INVALID");
    }
    homeSnapshot = payload;
    csrfToken = payload.security?.csrfToken ?? csrfToken;
    renderHome(payload);
    setVisible(elements.error, false);
  } catch (error) {
    setVisible(elements.error, true);
    elements.errorMessage.textContent =
      error instanceof Error && error.message !== "HOME_SNAPSHOT_INVALID"
        ? error.message
        : labels.snapshotFailedCopy;
    elements.live.textContent = labels.snapshotFailed;
    showToast(labels.snapshotFailed);
  }
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers ?? {})
    }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message ?? `HTTP_${response.status}`);
  }
  return payload;
}

function renderHome(snapshot) {
  elements.mode.textContent =
    snapshot.mode === "demo" ? labels.modeDemo : labels.modePersistent;
  elements.mode.dataset.tone = snapshot.mode === "demo" ? "warning" : "neutral";
  elements.freshness.textContent = freshnessLabel(snapshot.freshness);
  elements.freshness.dataset.tone = snapshot.freshness === "fresh" ? "success" : "danger";
  elements.project.textContent = snapshot.project?.name ?? "Current project";
  elements.updated.textContent = `${formatRelative(snapshot.generatedAt)} · ${formatTime(snapshot.generatedAt)}`;
  elements.runningSummary.textContent = String(snapshot.summary.running);
  elements.attentionSummary.textContent = String(snapshot.summary.needsAttention);
  elements.nextSummary.textContent = String(snapshot.summary.nextUp);
  elements.verifiedSummary.textContent = String(snapshot.summary.verified);
  elements.capacity.textContent = `${snapshot.runtime.activeCount} / ${snapshot.runtime.maxConcurrentRuns}`;
  elements.attentionCount.textContent = String(snapshot.summary.needsAttention);
  elements.nextCount.textContent = String(snapshot.summary.nextUp);
  renderTruthBanner(snapshot);
  renderList(elements.runningList, snapshot.runningNow, "running");
  renderList(elements.attentionList, snapshot.needsAttention, "attention");
  renderList(elements.nextList, snapshot.nextUp, "next");
  renderRecent(snapshot.recentlyVerified);
  elements.live.textContent = `${snapshot.project?.name ?? "Current project"}: ${snapshot.summary.running} running, ${snapshot.summary.needsAttention} need attention.`;
}

function renderTruthBanner(snapshot) {
  if (snapshot.freshness === "fresh") {
    setVisible(elements.banner, false);
    return;
  }
  const label = freshnessLabel(snapshot.freshness);
  elements.banner.innerHTML = `
    <strong>${escapeHtml(label)}</strong>
    <p>${escapeHtml(
      snapshot.freshness === "stale"
        ? zh
          ? "页面保留最后一次成功快照；依赖实时状态的操作暂时不可用。"
          : "The page is showing the last successful snapshot; live actions are paused."
        : zh
          ? "当前项目暂时无法确认运行状态。"
          : "The current project state cannot be verified right now."
    )}</p>
  `;
  setVisible(elements.banner, true);
}

function renderList(container, tasks, section) {
  if (!tasks || tasks.length === 0) {
    const copy =
      section === "running"
        ? labels.noRunning
        : section === "attention"
          ? labels.noAttention
          : labels.noNext;
    container.innerHTML = `<div class="ui-empty-state"><strong>${escapeHtml(copy)}</strong></div>`;
    return;
  }
  container.innerHTML = tasks.map((task) => renderTask(task, section)).join("");
}

function renderTask(task, section) {
  const disabled = homeSnapshot?.freshness !== "fresh" || busy;
  const action = taskAction(task, section);
  const external = task.externalIssue
    ? `<a class="task-external" href="${escapeAttribute(task.externalIssue.url)}" target="_blank" rel="noreferrer">${escapeHtml(task.externalIssue.provider)} · ${escapeHtml(task.externalIssue.id)}</a>`
    : `<span class="task-external">${escapeHtml(task.ref.projectKey)}</span>`;
  const gate = `${task.deliveryGate.passed}/${task.deliveryGate.total}`;
  const evidenceCopy = task.deliveryGate.failed > 0
    ? `${task.deliveryGate.failed} ${labels.evidenceFailed}`
    : task.deliveryGate.missing > 0
      ? `${task.deliveryGate.missing} ${labels.evidenceMissing}`
      : labels.factsReady;

  return `
    <article class="task-row" data-task-id="${escapeAttribute(task.ref.workItemId)}">
      <div class="task-row-main">
        <div class="task-row-heading">
          <span class="task-id">${escapeHtml(task.ref.workItemId)}</span>
          <a class="task-title" href="#task-${escapeAttribute(task.ref.workItemId)}" data-home-action="detail" data-task-id="${escapeAttribute(task.ref.workItemId)}">${escapeHtml(task.name)}</a>
        </div>
        <div class="task-row-meta">${external}</div>
      </div>
      <div class="task-row-state">
        <span class="ui-badge ui-badge--${statusTone(task.status.code)}">${escapeHtml(statusLabel(task.status.code))}</span>
        ${task.elapsed ? `<span class="task-duration">${escapeHtml(formatDuration(task.elapsed.elapsedMs))}</span>` : ""}
      </div>
      <div class="task-row-facts">
        <span>${escapeHtml(labels.evidence)} <strong>${escapeHtml(gate)}</strong></span>
        <span>${escapeHtml(evidenceCopy)}</span>
        ${task.attention ? `<span class="task-attention-copy">${escapeHtml(task.attention.reason)}</span>` : ""}
      </div>
      <div class="task-row-action">
        <button class="ui-button ui-button--secondary ui-button--sm" type="button" data-home-action="${escapeAttribute(action.primaryKind)}" data-task-id="${escapeAttribute(task.ref.workItemId)}" ${disabled && action.primaryKind !== "detail" ? "disabled" : ""}>${escapeHtml(action.label)}</button>
        ${action.secondary ? `<button class="ui-button ui-button--ghost ui-button--sm" type="button" data-home-action="${escapeAttribute(action.secondary.kind)}" data-task-id="${escapeAttribute(task.ref.workItemId)}" ${disabled ? "disabled" : ""}>${escapeHtml(action.secondary.label)}</button>` : ""}
      </div>
    </article>
  `;
}

function renderRecent(tasks) {
  if (!tasks || tasks.length === 0) {
    elements.recentList.innerHTML = `<div class="ui-empty-state"><strong>${escapeHtml(labels.noRecent)}</strong></div>`;
    return;
  }
  elements.recentList.innerHTML = tasks.map((task) => `
    <article class="recent-row">
      <div>
        <span class="task-id">${escapeHtml(task.ref.workItemId)}</span>
        <button class="recent-title" type="button" data-home-action="detail" data-task-id="${escapeAttribute(task.ref.workItemId)}">${escapeHtml(task.name)}</button>
      </div>
      <span class="ui-badge ui-badge--success">${escapeHtml(labels.accepted)}</span>
    </article>
  `).join("");
}

function taskAction(task, section) {
  if (section === "next" || task.nextStep?.code === "dispatch") {
    return {
      primaryKind: "run",
      label: labels.run,
      secondary: null
    };
  }
  if (section === "attention" && task.attention?.kind === "ready_for_acceptance") {
    return {
      primaryKind: "detail",
      label: labels.review,
      secondary: null
    };
  }
  if (section === "running") {
    return {
      primaryKind: "detail",
      label: labels.view,
      secondary: { kind: "cancel", label: labels.cancel }
    };
  }
  return { primaryKind: "detail", label: task.attention?.nextAction ?? labels.view, secondary: null };
}

async function handleListAction(event) {
  const target = event.target instanceof Element
    ? event.target.closest("[data-home-action]")
    : null;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const workItemId = target.dataset.taskId;
  if (!workItemId) {
    return;
  }
  const action = target.dataset.homeAction;
  if (action === "cancel") {
    await cancelTask(workItemId);
    return;
  }
  if (action === "run") {
    await openTaskDetail(workItemId, "run");
    return;
  }
  await openTaskDetail(workItemId, "view");
}

async function openTaskDetail(workItemId, mode) {
  try {
    dashboardSnapshot = await requestJson("/api/dashboard");
    const task = dashboardSnapshot.workItems?.find((item) => item.id === workItemId);
    if (!task) {
      throw new Error("WORK_ITEM_NOT_FOUND");
    }
    elements.detail.innerHTML = renderDetail(task, mode);
    dialog.open();
    elements.detail.querySelector("textarea, input:not([type=checkbox])")?.focus();
  } catch (error) {
    showToast(error instanceof Error ? error.message : labels.snapshotFailed);
  }
}

function renderDetail(task, mode) {
  const attempt = task.activeAttempt;
  const canAccept =
    dashboardSnapshot.capabilities?.decideAcceptance === true &&
    dashboardSnapshot.security?.operatorId &&
    task.progress?.failedEvidence === 0 &&
    task.progress?.missingEvidence === 0 &&
    task.activeArtifact &&
    attempt?.status === "completed" &&
    !task.acceptanceDecision;
  const canRun = task.status === "planned" || task.status === "blocked";
  const showRun = mode === "run" || canRun;

  return `
    <div class="ui-dialog-header">
      <span class="task-id">${escapeHtml(task.id)}</span>
      <h2 id="task-detail-title">${escapeHtml(task.title)}</h2>
      <span class="ui-badge ui-badge--${statusTone(task.status)}">${escapeHtml(statusLabel(task.status))}</span>
    </div>
    <div class="detail-fact-grid">
      <div><span class="detail-label">${escapeHtml(labels.agent)}</span><strong>${escapeHtml(attempt?.agentId ?? "—")}</strong></div>
      <div><span class="detail-label">${escapeHtml(labels.artifact)}</span><strong>${escapeHtml(task.activeArtifact?.revision ?? labels.noArtifact)}</strong></div>
      <div><span class="detail-label">${escapeHtml(labels.evidence)}</span><strong>${task.progress.passedEvidence}/${task.progress.totalEvidence}</strong></div>
    </div>
    ${showRun ? `
      <form class="ui-form task-action-form" data-detail-form="run" data-task-id="${escapeAttribute(task.id)}">
        <label class="ui-field">
          <span>${escapeHtml(labels.prompt)}</span>
          <textarea name="prompt" rows="4" required placeholder="${escapeAttribute(labels.promptPlaceholder)}">${escapeHtml(defaultPrompt(task))}</textarea>
        </label>
        <label class="ui-checkbox"><input type="checkbox" name="readOnly" checked /><span>${escapeHtml(labels.readOnly)}</span></label>
        <button class="ui-button ui-button--primary" type="submit">${escapeHtml(labels.confirmRun)}</button>
      </form>
    ` : ""}
    ${attempt?.status === "running" ? `
      <div class="ui-action-block">
        <p>${escapeHtml(labels.running)} · ${escapeHtml(formatDuration(Date.now() - Date.parse(attempt.startedAt)))}</p>
        <button class="ui-button ui-button--secondary" type="button" data-detail-action="cancel" data-task-id="${escapeAttribute(task.id)}">${escapeHtml(labels.cancel)}</button>
      </div>
    ` : ""}
    ${task.acceptanceDecision ? `
      <div class="ui-alert ui-alert--success"><strong>${escapeHtml(labels.accepted)}</strong><p>${escapeHtml(task.acceptanceDecision.reason)}</p></div>
    ` : canAccept ? `
      <form class="ui-form task-action-form" data-detail-form="acceptance" data-task-id="${escapeAttribute(task.id)}">
        <h3>${escapeHtml(labels.acceptanceTitle)}</h3>
        <label class="ui-field"><span>${escapeHtml(labels.reason)}</span><textarea name="reason" rows="3" required placeholder="${escapeAttribute(labels.reasonPlaceholder)}"></textarea></label>
        <div class="ui-form-actions"><button class="ui-button ui-button--secondary" name="decision" value="rejected" type="submit">${escapeHtml(labels.reject)}</button><button class="ui-button ui-button--primary" name="decision" value="accepted" type="submit">${escapeHtml(labels.accept)}</button></div>
      </form>
    ` : task.status === "reviewing" ? `
      <div class="ui-alert ui-alert--warning"><strong>${escapeHtml(labels.awaitingAcceptance)}</strong><p>${escapeHtml(labels.unavailableAcceptance)}</p></div>
    ` : ""}
    <div class="detail-evidence-list">
      <span class="detail-label">${escapeHtml(labels.evidence)}</span>
      ${task.requiredEvidence.map((criterion) => {
        const evidence = task.currentEvidence.find((item) => item.criterionKey === criterion);
        return `<span class="ui-badge ui-badge--${evidence?.outcome === "passed" ? "success" : evidence?.outcome === "failed" ? "danger" : "muted"}">${escapeHtml(criterion)} · ${escapeHtml(evidence?.outcome ?? "missing")}</span>`;
      }).join("")}
    </div>
  `;
}

async function handleDetailClick(event) {
  const target = event.target instanceof Element
    ? event.target.closest("[data-detail-action]")
    : null;
  if (!(target instanceof HTMLElement) || target.dataset.detailAction !== "cancel") {
    return;
  }
  await cancelTask(target.dataset.taskId);
  dialog.close();
}

async function handleDetailSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  event.preventDefault();
  const taskId = form.dataset.taskId;
  if (!taskId) {
    return;
  }
  if (form.dataset.detailForm === "run") {
    await runTask(taskId, new FormData(form));
    return;
  }
  if (form.dataset.detailForm === "acceptance") {
    await decideTask(taskId, new FormData(form));
  }
}

async function runTask(workItemId, formData) {
  const prompt = String(formData.get("prompt") ?? "").trim();
  if (!prompt) {
    showToast(labels.prompt);
    return;
  }
  await withBusy(async () => {
    await requestJson(`/api/work-items/${encodeURIComponent(workItemId)}/run`, {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({
        prompt,
        readOnly: formData.get("readOnly") === "on"
      })
    });
    dialog.close();
    await loadHome();
  });
}

async function cancelTask(workItemId) {
  await withBusy(async () => {
    await requestJson(`/api/work-items/${encodeURIComponent(workItemId)}/cancel`, {
      method: "POST",
      headers: writeHeaders(),
      body: "{}"
    });
    await loadHome();
  });
}

async function decideTask(workItemId, formData) {
  const reason = String(formData.get("reason") ?? "").trim();
  const decision = String(formData.get("decision") ?? "");
  const task = dashboardSnapshot?.workItems?.find((item) => item.id === workItemId);
  if (!reason || !task || (decision !== "accepted" && decision !== "rejected")) {
    showToast(labels.reason);
    return;
  }
  await withBusy(async () => {
    await requestJson(`/api/work-items/${encodeURIComponent(workItemId)}/acceptance`, {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({
        decisionId: crypto.randomUUID(),
        decision,
        reason,
        expectedReviewRevision: task.acceptanceReviewRevision
      })
    });
    dialog.close();
    await loadHome();
  });
}

async function withBusy(action) {
  if (busy) {
    return;
  }
  busy = true;
  try {
    await action();
  } catch (error) {
    showToast(error instanceof Error ? error.message : labels.snapshotFailed);
  } finally {
    busy = false;
  }
}

function writeHeaders() {
  if (!csrfToken) {
    throw new Error("TASKSEAL_SESSION_NOT_READY");
  }
  return {
    "content-type": "application/json",
    "x-taskseal-csrf-token": csrfToken
  };
}

function defaultPrompt(task) {
  return `Work on TaskSeal work item ${task.id}: ${task.title}. Stay inside this project and report a concise result.`;
}

function freshnessLabel(value) {
  return value === "fresh" ? labels.fresh : value === "stale" ? labels.stale : labels.unavailable;
}

function statusLabel(value) {
  return {
    running: labels.running,
    cancelling: labels.cancelling,
    terminalizing: labels.terminalizing,
    planned: labels.planned,
    awaiting_artifact: labels.awaitingArtifact,
    awaiting_evidence: labels.awaitingEvidence,
    awaiting_acceptance: labels.awaitingAcceptance,
    blocked: labels.blocked,
    accepted: labels.accepted,
    unknown: labels.unknown
  }[value] ?? value;
}

function statusTone(value) {
  return value === "accepted" ? "success" : value === "blocked" || value === "awaiting_evidence" ? "danger" : value === "awaiting_acceptance" ? "warning" : value === "running" || value === "cancelling" || value === "terminalizing" ? "accent" : "muted";
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  }
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatRelative(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 10) return zh ? "刚刚" : "just now";
  if (seconds < 60) return zh ? `${seconds} 秒前` : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return zh ? `${minutes} 分钟前` : `${minutes}m ago`;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.dataset.visible = "true";
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    delete elements.toast.dataset.visible;
  }, 3200);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  }[character]));
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
