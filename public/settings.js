import {
  applyTranslations,
  currentLocale,
  getConfigurationEnvelope,
  initializePresentation,
  refreshConfigurationEnvelope,
  t
} from "/presentation.js";
import { setButtonBusy } from "/ui-primitives.js";

await initializePresentation();

const PROJECT_BASIC_KEYS = new Set(["project", "mode"]);
const PROVIDER_FIELD_PREFIXES = {
  github: "github.",
  linear: "linear.",
  feishu: "feishu.",
  gitee: "gitee."
};

const elements = {
  generalForm: document.querySelector("#general-form"),
  generalFields: document.querySelector("#general-fields"),
  generalStatus: document.querySelector("#general-status"),
  projectForm: document.querySelector("#project-form"),
  projectFields: document.querySelector("#project-fields"),
  integrationList: document.querySelector("#integration-list"),
  projectStatus: document.querySelector("#project-status"),
  sourceList: document.querySelector("#source-list"),
  activeRevision: document.querySelector("#active-revision"),
  desiredRevision: document.querySelector("#desired-revision"),
  runtimeStatus: document.querySelector("#runtime-status"),
  runtimeMessage: document.querySelector("#runtime-message"),
  restartBanner: document.querySelector("#restart-banner"),
  restartCopyButton: document.querySelector("#restart-copy-button"),
  settingsError: document.querySelector("#settings-error"),
  toast: document.querySelector("#toast")
};

let envelope = getConfigurationEnvelope();
let view = envelope?.configuration ?? null;
let submitting = false;

if (view) {
  render();
} else {
  revealLoadError();
}

elements.generalForm.addEventListener("submit", saveGeneralSettings);
elements.projectForm.addEventListener("submit", saveProjectSettings);
elements.restartCopyButton.addEventListener("click", copyRestartCommand);
document.querySelector("#settings-main").addEventListener("change", (event) => {
  const control = event.target;
  if (control instanceof HTMLInputElement && control.type === "checkbox") {
    const valueLabel = control.closest(".setting-switch")?.querySelector("span:last-child");
    if (valueLabel) {
      valueLabel.textContent = t(control.checked ? "common.value.yes" : "common.value.no");
    }
  }
});
document.addEventListener("taskseal:locale-changed", () => {
  const drafts = captureDraftValues();
  render();
  restoreDraftValues(drafts);
});
document.addEventListener("taskseal:presentation-error", (event) => {
  showToast(t("settings.save.failure", {
    message: event.detail?.message ?? "LOCALE_UPDATE_FAILED"
  }));
});

function render() {
  if (!view || !envelope) {
    revealLoadError();
    return;
  }
  elements.settingsError.hidden = true;
  renderRuntimeState();
  renderFields(
    view.definitions.filter((definition) =>
      definition.editableScopes.some((scope) => scope === "user" || scope === "local")
    ),
    elements.generalFields
  );
  renderFields(
    view.definitions.filter((definition) =>
      definition.editableScopes.includes("project") && PROJECT_BASIC_KEYS.has(definition.key)
    ),
    elements.projectFields
  );
  renderIntegrations();
  renderSources();
  applyTranslations(document);
}

function renderRuntimeState() {
  const runtime = envelope.runtime;
  const restartRequired = runtime?.restartRequired === true;
  elements.activeRevision.textContent = shortRevision(runtime?.activeRevision);
  elements.desiredRevision.textContent = shortRevision(runtime?.desiredRevision);
  elements.runtimeStatus.textContent = t(
    restartRequired ? "common.status.restartRequired" : "common.status.live"
  );
  elements.runtimeStatus.dataset.tone = restartRequired ? "warning" : "success";
  elements.runtimeMessage.textContent = t(
    restartRequired ? "settings.runtime.restart" : "settings.runtime.synced"
  );
  elements.restartBanner.hidden = !restartRequired;
}

function renderFields(definitions, container) {
  container.innerHTML = definitions.map(renderField).join("");
}

function renderIntegrations() {
  const integrations = Array.isArray(view.integrations) ? view.integrations : [];
  elements.integrationList.innerHTML = integrations.map((integration) => {
    const definitions = view.definitions.filter((definition) =>
      definition.editableScopes.includes("project") &&
      definition.key.startsWith(PROVIDER_FIELD_PREFIXES[integration.id] ?? "__unknown__")
    );
    const statusKey = {
      present: "settings.integration.status.present",
      missing: "settings.integration.status.missing",
      conflict: "settings.integration.status.conflict",
      "not-required": "settings.integration.status.notRequired",
      "not-configured": "settings.integration.status.notConfigured"
    }[integration.credential.status] ?? "settings.integration.status.notConfigured";
    const statusTone = ["present"].includes(integration.credential.status)
      ? "success"
      : ["missing", "conflict"].includes(integration.credential.status)
        ? "warning"
        : "neutral";
    const bindingText = integration.credential.bindings.length > 0
      ? t("settings.integration.bindings", { bindings: integration.credential.bindings.join(" / ") })
      : t("settings.integration.noBinding");
    return `
      <article class="integration-card ui-card">
        <div class="integration-card-heading">
          <div>
            <div class="integration-title-row">
              <h4>${escapeHtml(t(`settings.integration.${integration.id}.name`))}</h4>
              <span class="status-chip" data-tone="${escapeAttribute(statusTone)}">${escapeHtml(t(statusKey))}</span>
            </div>
            <p>${escapeHtml(t(`settings.integration.${integration.id}.copy`))}</p>
            <small>${escapeHtml(bindingText)}</small>
          </div>
          <a class="button button-secondary ui-button" href="${escapeAttribute(integration.setupUrl)}" target="_blank" rel="noreferrer">${escapeHtml(t("settings.integrations.openAccess"))}</a>
        </div>
        ${definitions.length > 0 ? `
          <details class="integration-config" ${integration.credential.status === "conflict" ? "open" : ""}>
            <summary>${escapeHtml(t("settings.integrations.configure"))}</summary>
            <div class="settings-fields integration-fields">${definitions.map(renderField).join("")}</div>
          </details>
        ` : ""}
      </article>
    `;
  }).join("");
}

function renderField(definition) {
  const field = view.fields.find((candidate) => candidate.key === definition.key);
  const value = field?.value ?? "";
  const inputId = `setting-${definition.key.replaceAll(".", "-")}`;
  const lockedByHigherPrecedence = field?.source === "environment" || field?.source === "command";
  const required = definition.required ? "required" : "";
  const control = lockedByHigherPrecedence
    ? renderReadonlyValue(definition, value, inputId)
    : renderControl(definition, inputId, value, required);
  return `
    <label class="setting-field${lockedByHigherPrecedence ? " is-locked" : ""}" for="${escapeAttribute(inputId)}">
      <span class="setting-label-row">
        <strong>${escapeHtml(t(`settings.field.${definition.key}`))}</strong>
        ${definition.required ? `<small>${escapeHtml(t("settings.field.required"))}</small>` : ""}
      </span>
      ${control}
      <span class="setting-meta">
        <span>${escapeHtml(t("settings.field.source", { source: sourceLabel(field?.source ?? "built-in") }))}</span>
        <span>${escapeHtml(t(isOperationBoundProviderField(definition.key) ? "settings.field.immediate" : definition.restartRequired ? "settings.field.restart" : "settings.field.immediate"))}</span>
      </span>
    </label>
  `;
}

function isOperationBoundProviderField(key) {
  return ["github.", "linear.", "gitee.", "feishu."].some((prefix) => key.startsWith(prefix));
}

function renderControl(definition, inputId, value, required) {
  if (definition.valueType === "boolean") {
    return `
      <span class="setting-switch">
        <input id="${escapeAttribute(inputId)}" data-setting-key="${escapeAttribute(definition.key)}" type="checkbox" ${value === true ? "checked" : ""} />
        <span aria-hidden="true"></span>
        <span>${escapeHtml(t(value === true ? "common.value.yes" : "common.value.no"))}</span>
      </span>
    `;
  }
  if (definition.valueType === "enum") {
    return `
      <select class="ui-select" id="${escapeAttribute(inputId)}" data-setting-key="${escapeAttribute(definition.key)}" ${required}>
        ${(definition.options ?? []).map((option) => `
          <option value="${escapeAttribute(option)}" ${value === option ? "selected" : ""}>
            ${escapeHtml(localeOptionLabel(option))}
          </option>
        `).join("")}
      </select>
    `;
  }
  const type = definition.valueType === "number" ? "number" : "text";
  const numberAttributes = definition.key === "runtime.port" ? ' min="1" max="65535" step="1"' : "";
  return `
    <input class="ui-input" id="${escapeAttribute(inputId)}" data-setting-key="${escapeAttribute(definition.key)}" type="${type}" value="${escapeAttribute(value)}" ${required}${numberAttributes} />
  `;
}

function renderReadonlyValue(definition, value, inputId) {
  const displayValue = definition.valueType === "boolean"
    ? t(value === true ? "common.value.yes" : "common.value.no")
    : value || "—";
  return `<output class="ui-readonly" id="${escapeAttribute(inputId)}">${escapeHtml(displayValue)}</output>`;
}

function renderSources() {
  elements.sourceList.innerHTML = view.sources.map((source) => `
    <article class="source-item">
      <div>
        <strong>${escapeHtml(sourceLabel(source.scope))}</strong>
        <span class="source-status" data-tone="${escapeAttribute(source.status)}">${escapeHtml(sourceStatusLabel(source.status))}</span>
      </div>
      <code>${escapeHtml(source.path)}</code>
      <small>${escapeHtml(shortRevision(source.revision))}</small>
    </article>
  `).join("");
}

async function saveGeneralSettings(event) {
  event.preventDefault();
  if (submitting || !view) {
    return;
  }
  const controls = [...elements.generalFields.querySelectorAll("[data-setting-key]")];
  const portControl = controls.find((control) => control.dataset.settingKey === "runtime.port");
  const port = Number(portControl?.value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    setFormStatus(elements.generalStatus, t("settings.validation.port"), "danger");
    portControl?.focus();
    return;
  }
  await withSubmission(elements.generalForm, elements.generalStatus, async () => {
    let localeChanged = false;
    for (const control of controls) {
      if (control.disabled) {
        continue;
      }
      const key = control.dataset.settingKey;
      const definition = view.definitions.find((candidate) => candidate.key === key);
      const nextValue = readControlValue(control, definition);
      const previous = view.fields.find((field) => field.key === key)?.value;
      if (nextValue === previous) {
        continue;
      }
      await applyChange(key, nextValue);
      localeChanged ||= key === "ui.locale";
    }
    await refreshView();
    showToast(t("settings.save.success"));
    if (localeChanged) {
      window.location.reload();
    }
  });
}

async function saveProjectSettings(event) {
  event.preventDefault();
  if (submitting || !view) {
    return;
  }
  const controls = [...elements.projectForm.querySelectorAll("[data-setting-key]")];
  const missingRequired = controls.find((control) => control.required && !String(control.value).trim());
  if (missingRequired) {
    setFormStatus(elements.projectStatus, t("settings.validation.required"), "danger");
    missingRequired.closest("details")?.setAttribute("open", "");
    missingRequired.focus();
    return;
  }
  await withSubmission(elements.projectForm, elements.projectStatus, async () => {
    const draftResponse = await requestJson("/api/configuration/drafts/project");
    const document = structuredClone(draftResponse.draft.document);
    for (const control of controls) {
      const key = control.dataset.settingKey;
      const definition = view.definitions.find((candidate) => candidate.key === key);
      const value = readControlValue(control, definition);
      const existingField = view.fields.find((field) => field.key === key);
      if (
        (definition.valueType === "string" && value === "" && !definition.required) ||
        (definition.valueType === "boolean" && value === false && !existingField)
      ) {
        deleteNested(document, key.split("."));
      } else {
        setNested(document, key.split("."), value);
      }
    }
    const result = await requestJson("/api/configuration/draft", {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({
        expectedRevision: draftResponse.draft.revision,
        scope: "project",
        document
      })
    });
    await refreshView();
    showToast(t(result.replayed ? "settings.save.replayed" : "settings.save.success"));
  });
}

async function applyChange(key, value) {
  const current = await refreshConfigurationEnvelope();
  if (!current) {
    throw new Error("CONFIGURATION_UNAVAILABLE");
  }
  envelope = current;
  view = current.configuration;
  await requestJson("/api/configuration/change", {
    method: "POST",
    headers: mutationHeaders(),
    body: JSON.stringify({
      expectedRevision: view.revision,
      change: { operation: "set", key, value }
    })
  });
}

async function withSubmission(form, statusElement, operation) {
  submitting = true;
  const button = form.querySelector('button[type="submit"]');
  setButtonBusy(button, true, t("common.action.saving"));
  setFormStatus(statusElement, "", "neutral");
  try {
    await operation();
    setFormStatus(statusElement, t("settings.save.success"), "success");
  } catch (error) {
    setFormStatus(
      statusElement,
      t("settings.save.failure", { message: safeErrorMessage(error) }),
      "danger"
    );
  } finally {
    submitting = false;
    setButtonBusy(button, false, t("common.action.save"));
  }
}

async function refreshView() {
  envelope = await refreshConfigurationEnvelope();
  if (!envelope) {
    throw new Error("CONFIGURATION_UNAVAILABLE");
  }
  view = envelope.configuration;
  render();
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { accept: "application/json", ...(init.headers ?? {}) }
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(value?.message ?? value?.error ?? "CONFIGURATION_REQUEST_FAILED");
  }
  return value;
}

function mutationHeaders() {
  return {
    "content-type": "application/json",
    "x-taskseal-csrf-token": envelope.csrfToken
  };
}

function readControlValue(control, definition) {
  if (definition.valueType === "boolean") {
    return control.checked;
  }
  if (definition.valueType === "number") {
    return Number(control.value);
  }
  return control.value.trim();
}

function captureDraftValues() {
  return new Map(
    [...document.querySelectorAll("[data-setting-key]")].map((control) => [
      control.dataset.settingKey,
      control.type === "checkbox" ? control.checked : control.value
    ])
  );
}

function restoreDraftValues(drafts) {
  for (const control of document.querySelectorAll("[data-setting-key]")) {
    if (!drafts.has(control.dataset.settingKey)) {
      continue;
    }
    const value = drafts.get(control.dataset.settingKey);
    if (control.type === "checkbox") {
      control.checked = value === true;
      const valueLabel = control.closest(".setting-switch")?.querySelector("span:last-child");
      if (valueLabel) {
        valueLabel.textContent = t(control.checked ? "common.value.yes" : "common.value.no");
      }
    } else {
      control.value = value;
    }
  }
}

function setNested(target, path, value) {
  let current = target;
  for (const segment of path.slice(0, -1)) {
    if (typeof current[segment] !== "object" || current[segment] === null || Array.isArray(current[segment])) {
      current[segment] = {};
    }
    current = current[segment];
  }
  current[path.at(-1)] = value;
}

function deleteNested(target, path) {
  const parents = [];
  let current = target;
  for (const segment of path.slice(0, -1)) {
    if (typeof current[segment] !== "object" || current[segment] === null) {
      return;
    }
    parents.push([current, segment]);
    current = current[segment];
  }
  delete current[path.at(-1)];
  for (const [parent, segment] of parents.toReversed()) {
    if (Object.keys(parent[segment]).length === 0) {
      delete parent[segment];
    }
  }
}

function localeOptionLabel(value) {
  if (value === "auto") return t("common.language.auto");
  if (value === "zh-CN") return t("common.language.chineseSimplified");
  return t("common.language.english");
}

function sourceLabel(source) {
  const labels = currentLocale() === "zh-CN"
    ? { "built-in": "内置默认", user: "用户", project: "项目", local: "本机", environment: "环境变量", command: "命令参数" }
    : { "built-in": "Built-in", user: "User", project: "Project", local: "Local", environment: "Environment", command: "Command" };
  return labels[source] ?? source;
}

function sourceStatusLabel(status) {
  return t(status === "loaded" ? "common.status.loaded" : status === "missing" ? "common.status.missing" : "common.status.invalid");
}

function shortRevision(value) {
  return typeof value === "string" && value.length > 24
    ? `${value.slice(0, 15)}…${value.slice(-6)}`
    : value ?? "—";
}

function setFormStatus(element, message, tone) {
  element.textContent = message;
  element.dataset.tone = tone;
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : "CONFIGURATION_REQUEST_FAILED";
}

function revealLoadError() {
  elements.settingsError.hidden = false;
  elements.generalForm.hidden = true;
  elements.projectForm.hidden = true;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("toast-visible");
  window.setTimeout(() => elements.toast.classList.remove("toast-visible"), 3200);
}

async function copyRestartCommand() {
  try {
    await navigator.clipboard.writeText("taskseal start");
    showToast(t("settings.restart.copied"));
  } catch {
    showToast(t("settings.restart.copyFailure"));
  }
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
