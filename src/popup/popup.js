/**
 * JevGuard — popup (classic script, loaded with defer; MV3 CSP forbids inline JS).
 *
 * It owns no state of its own except pure UI flags: the service worker is the
 * single source of truth and answers GET_STATUS. The DOM is built once in
 * popup.html; this file only flips hidden/disabled/textContent, so the 2 s
 * refresh can never wipe a half-typed API key.
 *
 * Every chrome.runtime.sendMessage is wrapped: the callback form plus a
 * chrome.runtime.lastError check means a missing or asleep worker resolves into
 * an Italian error object instead of an unhandled rejection.
 *
 * Code and comments in English, user-visible strings in Italian.
 */

"use strict";

/* -------------------------------------------------------------- constants */

const POLL_MS = 2000;
/** TypeSafe input-token price, USD per million tokens (see CONTRACT.md §5). */
const COST_PER_MTOK = 0.042;
/** Mirrors JEV_MODEL from src/jev.js — a classic script cannot import it. */
const MODEL_LABEL = "jev-latest";
const EM_DASH = "–";

const TEXT = {
  unavailable: "Estensione non disponibile in questo contesto.",
  unreachable: "Servizio non raggiungibile: chiudi e riapri il popup.",
  noAnswer: "Nessuna risposta dal servizio.",
  unexpected: "Errore inatteso.",
  emptyKey: "Incolla prima la tua API key.",
  saved: "Chiave salvata.",
  saving: "Salvo…",
  verifying: "Verifico…",
  verify: "Verifica",
  save: "Salva",
  clearing: "Svuoto…",
  clearCache: "Svuota cache",
  cacheCleared: "Cache svuotata.",
  enabledOn: "Attiva",
  enabledOff: "Disattivata"
};

/* ------------------------------------------------------------------- DOM */

const $ = (id) => document.getElementById(id);

const dom = {
  errorStrip: $("error-strip"),
  errorText: $("error-text"),
  errorDismiss: $("error-dismiss"),
  toggle: $("enabled-toggle"),
  stateDot: $("state-dot"),
  stateText: $("state-text"),
  needKey: $("need-key"),
  keyInput: $("key-input"),
  keyMask: $("key-mask"),
  keyChange: $("key-change"),
  keyCancel: $("key-cancel"),
  keySave: $("key-save"),
  keyVerify: $("key-verify"),
  keyMsg: $("key-msg"),
  statRows: $("stat-rows"),
  statRendered: $("stat-rendered"),
  statPending: $("stat-pending"),
  statErrors: $("stat-errors"),
  statCalls: $("stat-calls"),
  statTokens: $("stat-tokens"),
  statCost: $("stat-cost"),
  clearCache: $("clear-cache"),
  cacheMsg: $("cache-msg")
};

/* ------------------------------------------------------------- UI state */

let lastStatus = null;      // last successful GET_STATUS answer
let refreshPromise = null;  // in-flight GET_STATUS, shared instead of stacked
let toggleBusy = false;     // a SET_ENABLED is in flight
let keyBusy = false;        // a SET_KEY or VERIFY_KEY is in flight
let editingKey = false;     // the user asked to replace a stored key
let stripMessage = "";      // what the red strip currently reports
let stripStamp = 0;
let dismissedMessage = "";  // what the user dismissed, and when
let dismissedStamp = 0;

/* -------------------------------------------------------------- messaging */

/**
 * Sends one message to the service worker. Never rejects: transport problems
 * come back as `{ ok:false, error:{ code, message } }` like any other failure.
 */
function send(message) {
  return new Promise((resolve) => {
    const fail = (text) => resolve({ ok: false, error: { code: "UNKNOWN", message: text } });

    if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
      fail(TEXT.unavailable);
      return;
    }

    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    try {
      chrome.runtime.sendMessage(message, (response) => {
        // Reading lastError is what prevents Chrome's "unchecked runtime.lastError".
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          done({ ok: false, error: { code: "UNKNOWN", message: TEXT.unreachable } });
          return;
        }
        if (!response || typeof response !== "object") {
          done({ ok: false, error: { code: "UNKNOWN", message: TEXT.noAnswer } });
          return;
        }
        done(response);
      });
    } catch (error) {
      done({ ok: false, error: { code: "UNKNOWN", message: TEXT.unreachable } });
    }
  });
}

function errorMessage(response) {
  const error = response && response.error;
  return error && typeof error.message === "string" && error.message ? error.message : TEXT.unexpected;
}

/* ------------------------------------------------------------ formatting */

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatCount(value) {
  const parsed = toNumber(value);
  return parsed === null ? EM_DASH : Math.round(parsed).toLocaleString("it-IT");
}

/** Estimated spend for the input tokens seen so far, Italian decimal comma. */
function formatCost(tokens) {
  const parsed = toNumber(tokens) || 0;
  const cost = (Math.max(parsed, 0) * COST_PER_MTOK) / 1e6;
  return `≈ $${cost.toLocaleString("it-IT", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
}

/* ----------------------------------------------------------- red strip */

function showStrip(message, stamp) {
  stripMessage = message;
  stripStamp = stamp;
  const alreadyDismissed = message === dismissedMessage && stamp <= dismissedStamp;
  if (alreadyDismissed) {
    dom.errorStrip.hidden = true;
    return;
  }
  dom.errorText.textContent = message;
  dom.errorStrip.hidden = false;
}

function hideStrip() {
  stripMessage = "";
  stripStamp = 0;
  dom.errorStrip.hidden = true;
}

function dismissStrip() {
  dismissedMessage = stripMessage;
  dismissedStamp = stripStamp;
  dom.errorStrip.hidden = true;
}

/* -------------------------------------------------------------- rendering */

/** Applies a status answer (or `null`, before the first one) to the static DOM. */
function render(status) {
  const enabled = Boolean(status && status.enabled === true);
  const hasKey = Boolean(status && status.hasKey === true);

  // Session switch: the poll must not fight the user mid-click.
  if (!toggleBusy) dom.toggle.checked = enabled;
  dom.toggle.disabled = toggleBusy || !hasKey;
  dom.toggle.setAttribute("aria-disabled", dom.toggle.disabled ? "true" : "false");
  dom.stateDot.className = enabled ? "dot dot-on" : "dot dot-off";
  dom.stateText.textContent = enabled ? TEXT.enabledOn : TEXT.enabledOff;
  dom.needKey.hidden = hasKey;

  // API key section: masked when a key is stored and the user is not editing.
  const showSaved = hasKey && !editingKey;
  dom.keyInput.hidden = showSaved;
  dom.keyMask.hidden = !showSaved;
  dom.keyChange.hidden = !showSaved;
  dom.keySave.hidden = showSaved;
  dom.keyCancel.hidden = !(hasKey && editingKey);
  dom.keySave.disabled = keyBusy;
  dom.keyVerify.disabled = keyBusy;
  dom.keyChange.disabled = keyBusy;
  dom.keyCancel.disabled = keyBusy;

  // Stats, two blocks. The four page counters come from stats.page, which is
  // null until a Gmail tab has reported at least once; "Con verdetto" is the
  // rows currently painted with a verdict (cache hits included), NOT the number
  // of Jev calls. That one is stats.analyzed, shown on its own row so that
  // token / call arithmetic in the popup adds up.
  const stats = (status && status.stats) || {};
  const page = stats.page && typeof stats.page === "object" ? stats.page : null;
  dom.statRows.textContent = page ? formatCount(page.rows) : EM_DASH;
  dom.statRendered.textContent = page ? formatCount(page.rendered) : EM_DASH;
  dom.statPending.textContent = page ? formatCount(page.pending) : EM_DASH;
  dom.statErrors.textContent = page ? formatCount(page.errors) : EM_DASH;
  dom.statCalls.textContent = formatCount(stats.analyzed);
  dom.statTokens.textContent = formatCount(stats.inputTokens);
  dom.statCost.textContent = formatCost(stats.inputTokens);

  // Last error strip.
  const lastError = status && status.lastError && typeof status.lastError === "object" ? status.lastError : null;
  if (lastError) {
    const message = typeof lastError.message === "string" && lastError.message ? lastError.message : TEXT.unexpected;
    const ts = toNumber(lastError.ts);
    showStrip(message, ts !== null && ts > 0 ? ts : 1);
  } else {
    hideStrip();
  }
}

function setMessage(node, text, kind) {
  if (!text) {
    node.textContent = "";
    node.className = "msg";
    node.hidden = true;
    return;
  }
  node.textContent = text;
  node.className = kind === "ok" ? "msg msg-ok" : "msg msg-err";
  node.hidden = false;
}

/* ----------------------------------------------------------------- polling */

async function pollStatus() {
  const response = await send({ type: "GET_STATUS" });
  if (response && response.ok === true) {
    lastStatus = response;
    render(response);
    return;
  }
  render(lastStatus);
  showStrip(errorMessage(response), 1);
}

/** Never stacks: a caller arriving during a poll awaits that same poll. */
function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = pollStatus().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

/* ---------------------------------------------------------------- handlers */

async function onToggle() {
  const wanted = dom.toggle.checked === true;
  toggleBusy = true;
  dom.toggle.disabled = true;

  const response = await send({ type: "SET_ENABLED", enabled: wanted });
  toggleBusy = false;

  if (response && response.ok === true) {
    const enabled = response.enabled === true;
    if (lastStatus) lastStatus.enabled = enabled;
    dom.toggle.checked = enabled;
    render(lastStatus);
    await refresh();
    return;
  }

  dom.toggle.checked = !wanted;
  render(lastStatus);
  showStrip(errorMessage(response), 1);
}

async function onSaveKey() {
  const key = dom.keyInput.value.trim();
  if (!key) {
    setMessage(dom.keyMsg, TEXT.emptyKey, "err");
    dom.keyInput.focus();
    return;
  }

  keyBusy = true;
  dom.keySave.textContent = TEXT.saving;
  render(lastStatus);

  const response = await send({ type: "SET_KEY", key });

  keyBusy = false;
  dom.keySave.textContent = TEXT.save;

  if (response && response.ok === true) {
    dom.keyInput.value = "";
    editingKey = false;
    setMessage(dom.keyMsg, TEXT.saved, "ok");
    await refresh();
    return;
  }

  render(lastStatus);
  setMessage(dom.keyMsg, errorMessage(response), "err");
}

async function onVerifyKey() {
  // A key typed but not yet saved is verified as-is; otherwise the worker falls
  // back to the stored one.
  const typed = dom.keyInput.hidden ? "" : dom.keyInput.value.trim();

  keyBusy = true;
  dom.keyVerify.textContent = TEXT.verifying;
  setMessage(dom.keyMsg, "", null);
  render(lastStatus);

  const response = await send(typed ? { type: "VERIFY_KEY", key: typed } : { type: "VERIFY_KEY" });

  keyBusy = false;
  dom.keyVerify.textContent = TEXT.verify;
  render(lastStatus);

  if (response && response.ok === true) {
    const models = Array.isArray(response.models) ? response.models.filter((name) => typeof name === "string" && name) : [];
    const model =
      models.find((name) => name === MODEL_LABEL) ||
      models.find((name) => name.toLowerCase().startsWith("jev")) ||
      MODEL_LABEL;
    setMessage(dom.keyMsg, `Chiave valida ✓ (${model})`, "ok");
    return;
  }

  setMessage(dom.keyMsg, errorMessage(response), "err");
}

function onChangeKey() {
  // UI only: the stored key stays until a new one is actually saved.
  editingKey = true;
  dom.keyInput.value = "";
  setMessage(dom.keyMsg, "", null);
  render(lastStatus);
  dom.keyInput.focus();
}

function onCancelKey() {
  editingKey = false;
  dom.keyInput.value = "";
  setMessage(dom.keyMsg, "", null);
  render(lastStatus);
}

async function onClearCache() {
  dom.clearCache.disabled = true;
  dom.clearCache.textContent = TEXT.clearing;

  const response = await send({ type: "CLEAR_CACHE" });

  dom.clearCache.textContent = TEXT.clearCache;
  dom.clearCache.disabled = false;

  if (response && response.ok === true) {
    setMessage(dom.cacheMsg, TEXT.cacheCleared, "ok");
    await refresh();
    return;
  }
  setMessage(dom.cacheMsg, errorMessage(response), "err");
}

/* -------------------------------------------------------------------- init */

function wire() {
  dom.toggle.addEventListener("change", () => {
    onToggle();
  });
  dom.keySave.addEventListener("click", () => {
    onSaveKey();
  });
  dom.keyVerify.addEventListener("click", () => {
    onVerifyKey();
  });
  dom.keyChange.addEventListener("click", onChangeKey);
  dom.keyCancel.addEventListener("click", onCancelKey);
  dom.clearCache.addEventListener("click", () => {
    onClearCache();
  });
  dom.errorDismiss.addEventListener("click", dismissStrip);
  dom.keyInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onSaveKey();
    }
  });
}

function init() {
  // Every element of popup.html must exist: bail out loudly rather than
  // throwing on the first null.
  const missing = Object.keys(dom).filter((name) => !dom[name]);
  if (missing.length > 0) {
    console.error("[JevGuard] popup markup incomplete:", missing.join(", "));
    return;
  }
  wire();
  render(null);      // neutral state: toggle off and disabled, counters "–"
  refresh();
  setInterval(refresh, POLL_MS);
}

init();
