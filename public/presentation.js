let catalog = {};
let locale = "en";
let localePreference = "auto";
let configurationEnvelope = null;

export function currentLocale() {
  return locale;
}

export function t(key, parameters = {}) {
  const template = catalog[key] ?? key;
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, name) =>
    Object.hasOwn(parameters, name) ? String(parameters[name]) : `{${name}}`
  );
}

export async function initializePresentation() {
  configurationEnvelope = await readConfigurationEnvelope();
  localePreference = readLocalePreference(configurationEnvelope);
  locale = resolveBrowserLocale(localePreference);
  catalog = await readCatalog(locale);
  applyTranslations(document);
  bindLocaleSelectors();
  return {
    locale,
    preference: localePreference,
    configurationEnvelope
  };
}

export function applyTranslations(root = document) {
  document.documentElement.lang = locale;
  document.title = t(
    document.body.dataset.titleKey ?? "settings.meta.title"
  );

  for (const element of root.querySelectorAll("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const element of root.querySelectorAll("[data-i18n-placeholder]")) {
    element.setAttribute("placeholder", t(element.dataset.i18nPlaceholder));
  }
  for (const element of root.querySelectorAll("[data-i18n-aria-label]")) {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  }
}

export function getConfigurationEnvelope() {
  return configurationEnvelope;
}

export async function refreshConfigurationEnvelope() {
  configurationEnvelope = await readConfigurationEnvelope();
  return configurationEnvelope;
}

function bindLocaleSelectors() {
  for (const select of document.querySelectorAll("[data-locale-select]")) {
    select.value = localePreference;
    select.addEventListener("change", async () => {
      const requested = select.value;
      const previous = localePreference;
      select.disabled = true;
      try {
        await persistLocale(requested);
        localePreference = requested;
        locale = resolveBrowserLocale(requested);
        catalog = await readCatalog(locale);
        applyTranslations(document);
        for (const peer of document.querySelectorAll("[data-locale-select]")) {
          peer.value = requested;
        }
        document.dispatchEvent(new CustomEvent("taskseal:locale-changed", {
          detail: { locale, preference: requested }
        }));
      } catch (error) {
        for (const peer of document.querySelectorAll("[data-locale-select]")) {
          peer.value = previous;
        }
        document.dispatchEvent(new CustomEvent("taskseal:presentation-error", {
          detail: {
            message: error instanceof Error ? error.message : "LOCALE_UPDATE_FAILED"
          }
        }));
      } finally {
        select.disabled = false;
      }
    });
  }
}

async function persistLocale(value) {
  if (!configurationEnvelope) {
    return;
  }
  const response = await fetch("/api/configuration/change", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-taskseal-csrf-token": configurationEnvelope.csrfToken
    },
    body: JSON.stringify({
      expectedRevision: configurationEnvelope.configuration.revision,
      change: {
        operation: "set",
        key: "ui.locale",
        value
      }
    })
  });
  if (!response.ok) {
    throw new Error("LOCALE_UPDATE_FAILED");
  }
  configurationEnvelope = await readConfigurationEnvelope();
}

async function readConfigurationEnvelope() {
  try {
    const response = await fetch("/api/configuration", {
      headers: { accept: "application/json" }
    });
    if (!response.ok) {
      return null;
    }
    const value = await response.json();
    return value?.schemaVersion === "control-room-configuration/v1" &&
      typeof value.csrfToken === "string" &&
      value.configuration?.schemaVersion === "configuration-view/v1"
      ? value
      : null;
  } catch {
    return null;
  }
}

function readLocalePreference(envelope) {
  const value = envelope?.configuration?.fields?.find(
    (field) => field.key === "ui.locale"
  )?.value;
  return value === "en" || value === "zh-CN" || value === "auto"
    ? value
    : "auto";
}

function resolveBrowserLocale(preference) {
  if (preference === "en" || preference === "zh-CN") {
    return preference;
  }
  return (navigator.languages ?? [navigator.language]).some((candidate) =>
    String(candidate).toLowerCase().startsWith("zh")
  ) ? "zh-CN" : "en";
}

async function readCatalog(requestedLocale) {
  const response = await fetch(
    `/api/presentation/catalog?locale=${encodeURIComponent(requestedLocale)}`,
    { headers: { accept: "application/json" } }
  );
  if (!response.ok) {
    throw new Error("PRESENTATION_CATALOG_UNAVAILABLE");
  }
  const value = await response.json();
  if (
    value?.schemaVersion !== "presentation-catalog/v1" ||
    value.locale !== requestedLocale ||
    typeof value.messages !== "object" ||
    value.messages === null
  ) {
    throw new Error("PRESENTATION_CATALOG_INVALID");
  }
  return value.messages;
}
