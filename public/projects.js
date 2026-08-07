const elements = {
  freshness: document.querySelector("#projects-freshness"),
  updated: document.querySelector("#projects-updated"),
  count: document.querySelector("#projects-count"),
  running: document.querySelector("#projects-running"),
  attention: document.querySelector("#projects-attention"),
  next: document.querySelector("#projects-next"),
  cards: document.querySelector("#project-cards"),
  error: document.querySelector("#projects-error"),
  errorMessage: document.querySelector("#projects-error-message"),
  retry: document.querySelector("#projects-retry"),
  live: document.querySelector("#projects-live")
};

elements.retry.addEventListener("click", loadProjects);
await loadProjects();
window.setInterval(loadProjects, 5_000);

async function loadProjects() {
  try {
    const response = await fetch("/api/project-hub", {
      headers: { accept: "application/json" }
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.message ?? `HTTP_${response.status}`);
    }
    if (payload?.schemaVersion !== "project-hub/v1") {
      throw new Error("PROJECT_HUB_INVALID");
    }
    render(payload);
    elements.error.hidden = true;
  } catch (error) {
    elements.error.hidden = false;
    elements.errorMessage.textContent = error instanceof Error && error.message !== "PROJECT_HUB_INVALID"
      ? error.message
      : "请确认运行中心已启动，然后重试。";
    elements.live.textContent = "项目总览读取失败";
  }
}

function render(snapshot) {
  elements.freshness.textContent = `${snapshot.projects.length} 个项目`;
  elements.updated.textContent = new Date(snapshot.generatedAt).toLocaleString();
  elements.count.textContent = String(snapshot.summary.projects);
  elements.running.textContent = String(snapshot.summary.running);
  elements.attention.textContent = String(snapshot.summary.needsAttention);
  elements.next.textContent = String(snapshot.summary.nextUp);
  elements.cards.innerHTML = snapshot.projects.map(renderProject).join("");
  elements.live.textContent = `${snapshot.summary.projects} 个项目，${snapshot.summary.running} 个工作项正在执行，${snapshot.summary.needsAttention} 个需要处理。`;
}

function renderProject(project) {
  const snapshot = project.snapshot;
  if (!snapshot) {
    return `<article class="ui-card project-card project-card--unavailable">
      <div class="section-heading"><div><p class="section-kicker">${escapeHtml(project.projectRef)}</p><h2>项目不可用</h2></div><span class="ui-badge ui-badge--danger">无法确认</span></div>
      <p class="project-card-copy">运行中心未返回可验证快照。不会自动启动或修改该项目。</p>
    </article>`;
  }
  const tasks = [...snapshot.runningNow, ...snapshot.needsAttention, ...snapshot.nextUp]
    .filter((task, index, all) => all.findIndex((candidate) => candidate.ref.workItemId === task.ref.workItemId) === index)
    .slice(0, 6);
  return `<article class="ui-card project-card">
    <div class="section-heading"><div><p class="section-kicker">${escapeHtml(project.projectRef)}</p><h2>${escapeHtml(snapshot.project.name)}</h2></div><span class="ui-badge ui-badge--${project.availability === "fresh" ? "success" : "warning"}">${project.availability === "fresh" ? "实时" : "离线快照"}</span></div>
    <div class="project-card-summary"><span>执行 <strong>${snapshot.summary.running}</strong></span><span>待处理 <strong>${snapshot.summary.needsAttention}</strong></span><span>下一批 <strong>${snapshot.summary.nextUp}</strong></span></div>
    ${tasks.length === 0
      ? `<p class="project-card-copy">当前没有待处理工作项。</p>`
      : `<ul class="project-task-list">${tasks.map(renderTask).join("")}</ul>`}
    <a class="ui-button ui-button--secondary" href="/?project=${encodeURIComponent(project.projectRef)}">打开运行中心</a>
  </article>`;
}

function renderTask(task) {
  const status = task.status?.code ?? "unknown";
  const tone = status === "running" ? "accent" : task.attention ? "danger" : "muted";
  return `<li><span class="ui-badge ui-badge--${tone}">${escapeHtml(status)}</span><span><strong>${escapeHtml(task.name)}</strong><small>${escapeHtml(task.ref.workItemId)}${task.attention ? ` · ${escapeHtml(task.attention.nextAction)}` : ""}</small></span></li>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}
