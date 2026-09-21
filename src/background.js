/**
 * JevGuard — MV3 service worker (ES module).
 *
 * Responsibilities (CONTRACT.md §3, §4, §5):
 *  - one single message listener for content script and popup: `return true`,
 *    exactly one `sendResponse`, never a rejected promise escaping;
 *  - Jev calls capped at MAX_CONCURRENT in parallel ACROSS all in-flight
 *    messages, plus per-id deduplication so two chunks never analyse a row twice;
 *  - a verdict cache mirrored into chrome.storage.session, because the worker
 *    can be killed between two messages;
 *  - API key in storage.local (persistent), enabled/stats/page in
 *    storage.session (wiped when Chrome closes → off by default every session).
 *
 * Code and comments in English, every user-visible string in Italian.
 */

import { JEV_MODEL, QUESTIONS, buildState, scoreAnswers } from "./jev.js";
import { systemOne, listModels, TypeSafeError, italianMessage, inputTokensOf } from "./typesafe-client.js";

/* --------------------------------------------------------------- constants */

const MAX_CONCURRENT = 4;         // §6: at most 4 Jev requests in flight
const CACHE_LIMIT = 500;          // verdicts kept, oldest by `ts` dropped first
const PERSIST_DEBOUNCE_MS = 300;  // debounce of the storage.session mirror
const BADGE_COLOR = "#1a73e8";    // §4.2

const LOCAL_API_KEY = "apiKey";
const S_ENABLED = "enabled";
const S_VERDICTS = "verdicts";
const S_STATS = "stats";
const S_PAGE = "page";
const S_LAST_ERROR = "lastError";

/** Error codes the HTTP client does not know about (§4.3). */
const EXTRA_MESSAGES = {
  DISABLED: "JevGuard è disattivato"
};

const log = (...args) => console.log("[JevGuard]", ...args);

/* ----------------------------------------------------------------- helpers */

/** Italian, short message for an error code (§4.3). */
function messageFor(code) {
  return EXTRA_MESSAGES[code] || italianMessage(code);
}

/** Normalise anything thrown into the `{ code, message }` shape of the contract. */
function errorFrom(thrown) {
  const code =
    thrown instanceof TypeSafeError && typeof thrown.code === "string" ? thrown.code : "UNKNOWN";
  return { code, message: messageFor(code) };
}

function errorPayload(code) {
  return { ok: false, error: { code, message: messageFor(code) } };
}

/** Non-negative finite number, 0 otherwise. */
function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function isRowData(row) {
  return Boolean(row) && typeof row === "object" && typeof row.id === "string" && row.id.length > 0;
}

/** Verdict returned when one item failed: the chunk as a whole still succeeds. */
function errorVerdict(id, error) {
  return {
    id,
    risk: 0,
    kind: "ok",
    level: "basso",
    phishing: 0,
    spam: 0,
    signals: [],
    inputTokens: 0,
    model: JEV_MODEL,
    ts: Date.now(),
    error
  };
}

async function sessionGet(keys) {
  try {
    return (await chrome.storage.session.get(keys)) || {};
  } catch (error) {
    log("storage.session.get failed", error);
    return {};
  }
}

async function sessionSet(items) {
  try {
    await chrome.storage.session.set(items);
  } catch (error) {
    log("storage.session.set failed", error);
  }
}

async function getEnabled() {
  const data = await sessionGet(S_ENABLED);
  return data[S_ENABLED] === true;
}

async function getApiKey() {
  try {
    const data = (await chrome.storage.local.get(LOCAL_API_KEY)) || {};
    return typeof data[LOCAL_API_KEY] === "string" ? data[LOCAL_API_KEY].trim() : "";
  } catch (error) {
    log("storage.local.get failed", error);
    return "";
  }
}

/* --------------------------------------------------------------- semaphore */

/**
 * Hand-rolled counting semaphore, module scope: it therefore caps concurrency
 * across every message being handled at the same time. Module state dies with
 * the worker, which is correct — so does the work it was guarding.
 */
let activeSlots = 0;
const slotWaiters = [];

function acquireSlot() {
  if (activeSlots < MAX_CONCURRENT) {
    activeSlots += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => slotWaiters.push(resolve));
}

function releaseSlot() {
  const next = slotWaiters.shift();
  if (next) next(); // slot handed straight over, activeSlots unchanged
  else if (activeSlots > 0) activeSlots -= 1;
}

/* ------------------------------------------------------- cache and counters */

/** id -> Verdict. Only successful verdicts are cached (errors must be retried). */
const cache = new Map();
/** id -> Promise<Verdict>, so two chunks never analyse the same row twice. */
const inFlight = new Map();
/** Bumped by CLEAR_CACHE so results of requests started before it are not stored. */
let cacheGeneration = 0;

let stats = { analyzed: 0, errors: 0, inputTokens: 0, cached: 0 };
let pageStats = null;
let lastError = null;

/** Memoised hydration promise: several chunks arrive at once, hydrate once. */
let hydration = null;

function hydrate() {
  if (!hydration) {
    hydration = sessionGet([S_VERDICTS, S_STATS, S_PAGE, S_LAST_ERROR]).then((data) => {
      const stored = data[S_VERDICTS];
      if (stored && typeof stored === "object") {
        for (const [id, verdict] of Object.entries(stored)) {
          // Never overwrite something produced while hydration was pending.
          if (!cache.has(id) && verdict && typeof verdict === "object" && !verdict.error) {
            cache.set(id, verdict);
          }
        }
        trimCache();
      }
      const storedStats = data[S_STATS];
      if (storedStats && typeof storedStats === "object") {
        stats = {
          analyzed: num(storedStats.analyzed),
          errors: num(storedStats.errors),
          inputTokens: num(storedStats.inputTokens),
          cached: num(storedStats.cached)
        };
      }
      if (data[S_PAGE] && typeof data[S_PAGE] === "object") pageStats = data[S_PAGE];
      if (data[S_LAST_ERROR] && typeof data[S_LAST_ERROR] === "object") lastError = data[S_LAST_ERROR];
    });
  }
  return hydration;
}

function trimCache() {
  if (cache.size <= CACHE_LIMIT) return;
  const oldestFirst = [...cache.entries()].sort((a, b) => num(a[1] && a[1].ts) - num(b[1] && b[1].ts));
  const excess = cache.size - CACHE_LIMIT;
  for (let i = 0; i < excess; i += 1) cache.delete(oldestFirst[i][0]);
}

let persistTimer = null;

function schedulePersist() {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, PERSIST_DEBOUNCE_MS);
}

async function persistNow() {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const verdicts = {};
  for (const [id, verdict] of cache) verdicts[id] = verdict;
  await sessionSet({ [S_VERDICTS]: verdicts, [S_STATS]: stats, [S_LAST_ERROR]: lastError });
}

function rememberError(error) {
  lastError = { code: error.code, message: error.message, ts: Date.now() };
}

/* ------------------------------------------------------------- Jev analysis */

/** Runs one Jev evaluation. Never rejects: a failure becomes an error Verdict. */
async function analyseRow(row, apiKey) {
  await acquireSlot();
  try {
    const result = await systemOne({
      apiKey,
      state: buildState(row),
      questions: QUESTIONS,
      model: JEV_MODEL
    });
    const scored = scoreAnswers(result.answers);
    return {
      id: row.id,
      risk: scored.risk,
      kind: scored.kind,
      level: scored.level,
      phishing: scored.phishing ?? 0,
      spam: scored.spam ?? 0,
      signals: scored.signals,
      inputTokens: num(inputTokensOf(result.usage)),
      model: typeof result.model === "string" && result.model ? result.model : JEV_MODEL,
      ts: Date.now(),
      error: null
    };
  } catch (thrown) {
    log(`analysis failed for ${row.id}:`, thrown);
    return errorVerdict(row.id, errorFrom(thrown));
  } finally {
    releaseSlot();
  }
}

/* ----------------------------------------------------------- message handlers */

async function handleAnalyze(message) {
  if (!(await getEnabled())) return errorPayload("DISABLED");

  const apiKey = await getApiKey();
  if (!apiKey) return errorPayload("NO_KEY");

  const items = Array.isArray(message.items) ? message.items.filter(isRowData) : [];
  if (items.length === 0) return { ok: true, verdicts: [] };

  const generation = cacheGeneration;
  const tasks = [];

  for (const row of items) {
    // No `await` between lookup and set: two chunks must not race on the same id.
    const cached = cache.get(row.id);
    if (cached) {
      stats.cached += 1;
      tasks.push({ fresh: false, promise: Promise.resolve(cached) });
      continue;
    }
    const pending = inFlight.get(row.id);
    if (pending) {
      stats.cached += 1;
      tasks.push({ fresh: false, promise: pending });
      continue;
    }
    const task = analyseRow(row, apiKey)
      .catch((thrown) => errorVerdict(row.id, errorFrom(thrown))) // belt and braces
      .finally(() => {
        inFlight.delete(row.id);
      });
    inFlight.set(row.id, task);
    tasks.push({ fresh: true, promise: task });
  }

  const verdicts = await Promise.all(tasks.map((task) => task.promise));

  // Cache/dedup hits already moved stats.cached: that must be persisted too.
  let touched = tasks.some((task) => !task.fresh);
  verdicts.forEach((verdict, index) => {
    if (!tasks[index].fresh) return; // counted already, and the owner stores it
    if (verdict.error) {
      stats.errors += 1;
      rememberError(verdict.error);
      touched = true;
      return;
    }
    stats.analyzed += 1;
    stats.inputTokens += num(verdict.inputTokens);
    if (generation === cacheGeneration) cache.set(verdict.id, verdict);
    touched = true;
  });

  if (touched) {
    trimCache();
    // Debounced during a burst, flushed as soon as the burst is over: the
    // worker may be killed right after the response is sent.
    if (inFlight.size === 0) await persistNow();
    else schedulePersist();
  }

  return { ok: true, verdicts };
}

function handleGetCached(message) {
  const ids = Array.isArray(message.ids) ? message.ids : [];
  const verdicts = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const verdict = cache.get(id);
    if (verdict) verdicts.push(verdict);
  }
  return { ok: true, verdicts };
}

async function handleGetStatus() {
  const [enabled, apiKey] = await Promise.all([getEnabled(), getApiKey()]);
  return {
    ok: true,
    enabled,
    hasKey: apiKey.length > 0,
    stats: {
      analyzed: stats.analyzed,
      errors: stats.errors,
      inputTokens: stats.inputTokens,
      cached: stats.cached,
      page: pageStats
    },
    lastError
  };
}

async function handleSetEnabled(message) {
  const enabled = message.enabled === true;
  await sessionSet({ [S_ENABLED]: enabled });
  await refreshBadge(enabled);
  return { ok: true, enabled };
}

async function handleSetKey(message) {
  const key = typeof message.key === "string" ? message.key.trim() : "";
  try {
    if (key) await chrome.storage.local.set({ [LOCAL_API_KEY]: key });
    else await chrome.storage.local.remove(LOCAL_API_KEY);
  } catch (error) {
    log("storing the API key failed", error);
    return errorPayload("UNKNOWN");
  }
  return { ok: true };
}

async function handleVerifyKey(message) {
  const candidate = typeof message.key === "string" ? message.key.trim() : "";
  const apiKey = candidate || (await getApiKey());
  if (!apiKey) return errorPayload("NO_KEY");
  try {
    const models = await listModels({ apiKey });
    return { ok: true, models };
  } catch (thrown) {
    const error = errorFrom(thrown);
    rememberError(error);
    schedulePersist();
    return { ok: false, error };
  }
}

async function handleClearCache() {
  cacheGeneration += 1;
  cache.clear();
  await persistNow();
  return { ok: true };
}

async function handlePageStats(message) {
  pageStats = {
    rows: num(message.rows),
    rendered: num(message.rendered),
    pending: num(message.pending),
    errors: num(message.errors),
    ts: Date.now()
  };
  await sessionSet({ [S_PAGE]: pageStats });
  return { ok: true };
}

/* ------------------------------------------------------------------ routing */

async function handleMessage(message) {
  if (!message || typeof message.type !== "string") return errorPayload("UNKNOWN");
  await hydrate();

  switch (message.type) {
    case "ANALYZE":
      return handleAnalyze(message);
    case "GET_CACHED":
      return handleGetCached(message);
    case "GET_STATUS":
      return handleGetStatus();
    case "SET_ENABLED":
      return handleSetEnabled(message);
    case "SET_KEY":
      return handleSetKey(message);
    case "VERIFY_KEY":
      return handleVerifyKey(message);
    case "CLEAR_CACHE":
      return handleClearCache();
    case "PAGE_STATS":
      return handlePageStats(message);
    default:
      log("unknown message type:", message.type);
      return errorPayload("UNKNOWN");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let answered = false;
  const respond = (payload) => {
    if (answered) return;
    answered = true;
    try {
      sendResponse(payload);
    } catch (error) {
      // The popup may have been closed before the answer was ready.
      log("sendResponse failed", error);
    }
  };

  handleMessage(message).then(respond, (thrown) => {
    log("message handler crashed", thrown);
    respond({ ok: false, error: errorFrom(thrown) });
  });

  return true; // the response is asynchronous
});

/* ------------------------------------------------------------- lifecycle */

async function refreshBadge(enabledValue) {
  const enabled = typeof enabledValue === "boolean" ? enabledValue : await getEnabled();
  try {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    await chrome.action.setBadgeText({ text: enabled ? "ON" : "" });
  } catch (error) {
    log("badge update failed", error);
  }
}

/** Lets the content script read `enabled` and watch storage.session directly. */
async function openSessionStorage() {
  try {
    if (chrome.storage.session && typeof chrome.storage.session.setAccessLevel === "function") {
      await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
    }
  } catch (error) {
    // Older Chrome builds do not expose setAccessLevel — not fatal.
    log("setAccessLevel unavailable", error);
  }
}

async function bootstrap() {
  await openSessionStorage();
  const data = await sessionGet(S_ENABLED);
  if (typeof data[S_ENABLED] !== "boolean") {
    // Off at every new browser session (§4.1) and an explicit value for the
    // storage.onChanged listeners of the content script.
    await sessionSet({ [S_ENABLED]: false });
  }
  await refreshBadge();
}

chrome.runtime.onInstalled.addListener(() => {
  bootstrap().catch((error) => log("onInstalled bootstrap failed", error));
});

chrome.runtime.onStartup.addListener(() => {
  bootstrap().catch((error) => log("onStartup bootstrap failed", error));
});

// The worker is also revived by messages and by Chrome itself: make sure the
// session access level and the badge are right whatever woke it up.
bootstrap().catch((error) => log("bootstrap failed", error));
