import { initializePresentation } from "/presentation.js";

await initializePresentation();

const elements = {
  list: document.querySelector("#connections-list"),
  revision: document.querySelector("#connections-revision"),
  updated: document.querySelector("#connections-updated"),
  error: document.querySelector("#connections-error"),
  errorMessage: document.querySelector("#connections-error-message"),
  retry: document.querySelector("#connections-retry")
};

const copy = {
  configured: "已配置",
  notConfigured: "未配置",
  present: "凭据已提供",
  missing: "缺少凭据",
  observed: "最近观察正常",
  notProbed: "尚未探测",
  unavailable: "观察不可用",
  notRequired: "不需要凭据",
  nextOperation: "下一次 operation 生效",
  restartRequired: "需要重启运行时",
  open: "打开官方设置",
  binding: "绑定",
  basis: "依据",
  noBinding: "没有环境绑定",
  probe: "检查连接",
  verify: "联网验证",
  probing: "检查中…",
  probeUnavailable: "检查结果不可用",
  probeReady: "本地配置可用",
  probeObserved: "最近观察可用",
  probeMissing: "缺少必要配置",
  probeNotConfigured: "尚未配置",
  probeNoNetwork: "仅检查本地配置和最近观察，未访问外部网络"
};

elements.retry.addEventListener("click", load);
await load();

async function load() {
  elements.error.hidden = true;
  try {
    const response = await fetch("/api/connections", { headers: { accept: "application/json" } });
    const value = await response.json().catch(() => null);
    if (!response.ok || value?.schemaVersion !== "connections/v1") {
      throw new Error(value?.error ?? "CONNECTIONS_UNAVAILABLE");
    }
    render(value);
  } catch (error) {
    elements.error.hidden = false;
    elements.errorMessage.textContent = error instanceof Error ? error.message : "CONNECTIONS_UNAVAILABLE";
    elements.list.innerHTML = "";
  }
}

function render(snapshot) {
  elements.revision.textContent = shortRevision(snapshot.configurationRevision);
  elements.updated.textContent = `更新于 ${new Date(snapshot.generatedAt).toLocaleTimeString()}`;
  elements.list.innerHTML = snapshot.connections.map((connection) => renderConnection(connection, snapshot)).join("");
  for (const button of elements.list.querySelectorAll("[data-connection-probe]")) {
    button.addEventListener("click", () => probe(button.dataset.connectionProbe, snapshot, false));
  }
  for (const button of elements.list.querySelectorAll("[data-connection-verify]")) {
    button.addEventListener("click", () => probe(button.dataset.connectionVerify, snapshot, true));
  }
}

function renderConnection(connection, snapshot) {
  const connectivity = connection.connectivity.status;
  const credential = connection.credential.status;
  const tone = connectivity === "unavailable" || credential === "missing" ? "warning" : connectivity === "observed" ? "success" : "muted";
  const bindings = connection.credential.bindings.length > 0 ? connection.credential.bindings.join(" / ") : copy.noBinding;
  return `
    <article class="ui-card connection-card">
      <div class="connection-card-heading"><div><p class="section-kicker">${escapeHtml(connection.id)}</p><h2>${escapeHtml(connection.id[0].toUpperCase() + connection.id.slice(1))}</h2></div><span class="ui-badge ui-badge--${tone}">${escapeHtml(connectivityLabel(connectivity))}</span></div>
      <div class="connection-facts">
        <span><strong>${escapeHtml(connection.configured ? copy.configured : copy.notConfigured)}</strong></span>
        <span>${escapeHtml(credentialLabel(credential))}</span>
        <span>${escapeHtml(copy.binding)}: ${escapeHtml(bindings)}</span>
      </div>
      <div class="connection-card-footer"><span class="ui-badge ui-badge--muted">${escapeHtml(connection.activation === "next-operation" ? copy.nextOperation : copy.restartRequired)}</span><button class="ui-button ui-button--secondary ui-button--sm" type="button" data-connection-probe="${escapeAttribute(connection.id)}" ${snapshot.capabilities?.explicitProbe === false ? "disabled" : ""}>${escapeHtml(copy.probe)}</button><button class="ui-button ui-button--ghost ui-button--sm" type="button" data-connection-verify="${escapeAttribute(connection.id)}" ${snapshot.capabilities?.networkProbe === false ? "disabled" : ""}>${escapeHtml(copy.verify)}</button><a class="ui-button ui-button--secondary ui-button--sm" href="${escapeAttribute(connection.setupUrl)}" target="_blank" rel="noreferrer">${escapeHtml(copy.open)}</a></div>
      <p class="connection-probe-result" data-connection-probe-result="${escapeAttribute(connection.id)}" aria-live="polite">${escapeHtml(copy.probeNoNetwork)}</p>
    </article>
  `;
}

async function probe(provider, snapshot, network) {
  if (!provider) return;
  const button = elements.list.querySelector(`[data-connection-${network ? "verify" : "probe"}="${CSS.escape(provider)}"]`);
  const result = elements.list.querySelector(`[data-connection-probe-result="${CSS.escape(provider)}"]`);
  if (!(button instanceof HTMLButtonElement) || !(result instanceof HTMLElement)) return;
  button.disabled = true;
  button.textContent = copy.probing;
  try {
    const response = await fetch(`/api/connections/${encodeURIComponent(provider)}/${network ? "verify" : "probe"}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-taskseal-csrf-token": snapshot.security?.csrfToken ?? ""
      },
      body: JSON.stringify({ expectedConfigurationRevision: snapshot.configurationRevision })
    });
    const value = await response.json().catch(() => null);
    if (!response.ok || value?.schemaVersion !== "connection-probe/v1") {
      throw new Error(value?.error ?? copy.probeUnavailable);
    }
    result.textContent = `${probeLabel(value.status)} · ${value.summary}`;
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : copy.probeUnavailable;
  } finally {
    button.disabled = false;
    button.textContent = network ? copy.verify : copy.probe;
  }
}

function probeLabel(value) {
  return {
    "configuration-ready": copy.probeReady,
    connected: "联网验证通过",
    unauthorized: "凭据或范围被拒绝",
    observed: copy.probeObserved,
    "credential-missing": copy.probeMissing,
    "not-configured": copy.probeNotConfigured,
    "observation-unavailable": copy.unavailable
  }[value] ?? value;
}

function connectivityLabel(value) { return copy[value] ?? value; }
function credentialLabel(value) { return copy[value] ?? value; }
function shortRevision(value) { return typeof value === "string" && value.length > 20 ? `${value.slice(0, 14)}…${value.slice(-6)}` : value ?? "—"; }
function escapeHtml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function escapeAttribute(value) { return escapeHtml(value); }
