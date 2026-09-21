/**
 * JevGuard — content controller.
 *
 * Classic content script (NOT a module): it cannot import jev.js, so the tooltip
 * text and the risk colour are rebuilt here, deliberately mirroring
 * `verdictTooltip()` / `riskColor()` in src/jev.js.
 *
 * Responsibilities:
 *  - follow `enabled` (chrome.storage.session, with a GET_STATUS fallback),
 *  - detect the visible rows (IntersectionObserver) and keep up with Gmail's
 *    single-page navigation (MutationObserver + hashchange),
 *  - ask the service worker for cached verdicts first, then analyse the rest in
 *    concurrent chunks of 5,
 *  - paint / update / remove the badges, never twice in the same row.
 */
(function () {
  "use strict";

  const NS = (window.JevGuard = window.JevGuard || {});
  if (NS.injected) return;
  NS.injected = true;

  if (!NS.rows || typeof NS.rows.listRows !== "function") {
    console.error("[JevGuard] gmail-rows.js non caricato: nessun badge verrà mostrato.");
    return;
  }

  /**
   * Badge placement (CONTRACT.md §7).
   *  - "overlay"     : the badge is absolutely positioned inside the row's subject
   *                    cell, flush right, so it sits immediately left of the date
   *                    column and Gmail's hover icons never cover it. Default: it
   *                    adds no cell to Gmail's table and cannot change row height.
   *  - "append-cell" : the badge lives in a new <td class="jg-cell"> appended as the
   *                    true last cell of the row. Sturdier against odd subject-cell
   *                    markup, but Gmail's hover action icons overlap it.
   * Switch by editing this single constant.
   */
  const BADGE_PLACEMENT = "overlay"; // "overlay" | "append-cell"

  const CHUNK_SIZE = 5;
  const FLUSH_DEBOUNCE_MS = 300;
  const RESCAN_DEBOUNCE_MS = 300;
  /** Hard cap on the trailing debounce: a long mutation burst must not starve it. */
  const RESCAN_MAX_WAIT_MS = 1000;
  const ROOT_MARGIN = "200px 0px";
  const STATUS_POLL_MS = 4000;
  const DEBUG_OUTLINE_MS = 3000;
  const MAIN_SELECTOR = 'div[role="main"]';

  let enabled = false;
  let running = false;
  let destroyed = false;
  let storageBound = false;
  /** True once chrome.storage.session.onChanged accepted our listener (never cleared
   *  by a failed read: the listener stays live and will deliver once access is up). */
  let sessionListenerBound = false;
  /** True once a storage event has decided the state: the boot read must not undo it. */
  let stateFromEvent = false;

  /** id -> Verdict (also caches error verdicts, so scrolling does not re-fire). */
  const verdicts = new Map();
  /** ids sent to the worker and not yet answered. */
  const pending = new Set();
  /** id -> RowData, waiting for the next flush. */
  const queue = new Map();
  /** Rebuilt on every rescan: rows are recycled, so never keep an old element. */
  let rowElements = new Map();
  let rowData = new Map();
  let observedRows = new WeakSet();

  let mainEl = null;
  let bootObserver = null;
  let flushTimer = null;
  let rescanTimer = null;
  /** Date.now() of the first scheduleRescan() call of the current debounce window. */
  let rescanSince = 0;
  let statusTimer = null;
  let pendingForce = false;

  const warned = new Set();
  function warnOnce(key, message, detail) {
    if (warned.has(key)) return;
    warned.add(key);
    if (detail === undefined) console.warn("[JevGuard]", message);
    else console.warn("[JevGuard]", message, detail);
  }

  // ---------------------------------------------------------------- messaging

  function contextAlive() {
    try {
      return Boolean(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id);
    } catch (error) {
      return false;
    }
  }

  /**
   * Callback form only (never mixed with the promise form) and always resolving:
   * an invalidated extension context must never throw inside the page.
   */
  function sendMessage(message) {
    return new Promise((resolve) => {
      if (destroyed || !contextAlive()) {
        destroy();
        resolve(null);
        return;
      }
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const failure = chrome.runtime.lastError;
          if (failure) {
            warnOnce("sendMessage:" + message.type, "messaggio non consegnato: " + message.type, failure.message);
            resolve(null);
            return;
          }
          resolve(response || null);
        });
      } catch (error) {
        warnOnce("sendMessage-throw", "contesto dell'estensione non più valido", error);
        destroy();
        resolve(null);
      }
    });
  }

  // ------------------------------------------------------------ tooltip texts

  function pct(value) {
    const number = typeof value === "number" && isFinite(value) ? value : 0;
    return Math.round(number * 100) + "%";
  }

  /** Mirrors verdictTooltip() in src/jev.js (not importable from a content script). */
  function verdictTooltip(verdict) {
    const head =
      verdict.kind === "phishing"
        ? "Rischio phishing " + pct(verdict.risk) + " (" + verdict.level + ")"
        : verdict.kind === "spam"
          ? "Probabile spam " + pct(verdict.risk) + " (" + verdict.level + ")"
          : "Rischio " + pct(verdict.risk) + " (" + verdict.level + ")";
    const lines = [
      head,
      "spam " + pct(verdict.spam) + " · phishing " + pct(verdict.phishing) + "  (la % mostrata è la maggiore delle due)"
    ];
    const signals = Array.isArray(verdict.signals) ? verdict.signals : [];
    for (const signal of signals) {
      if (signal && typeof signal.value === "number" && signal.value >= 0.4) {
        lines.push("• " + signal.label + ": " + pct(signal.value));
      }
    }
    lines.push("Valutato da TypeSafe Jev su mittente (nome, indirizzo e dominio), oggetto e anteprima.");
    return lines.join("\n");
  }

  function errorTooltip(error) {
    const code = error && error.code ? error.code : "UNKNOWN";
    const message = error && error.message ? error.message : "errore inatteso";
    // The code is part of the tooltip on purpose: README's troubleshooting table
    // keys its remedies off NO_KEY / AUTH / RATE_LIMIT and the user must see it.
    const lines = ["Analisi non riuscita: " + message + " [" + code + "]"];
    if (code === "NO_KEY") lines.push("Imposta la chiave dal popup di JevGuard.");
    return lines.join("\n");
  }

  /** Same ramp as riskColor() in src/jev.js; the lightness comes from badge.css. */
  function riskHue(risk) {
    const value = typeof risk === "number" && isFinite(risk) ? Math.min(Math.max(risk, 0), 1) : 0;
    return Math.round(120 * (1 - value));
  }

  // ------------------------------------------------------------------ badges

  function badgeHost(row) {
    if (BADGE_PLACEMENT === "append-cell") {
      let cell = row.querySelector(":scope > .jg-cell");
      if (!cell) {
        cell = document.createElement(row.tagName === "TR" ? "td" : "span");
        cell.className = "jg-cell";
        row.appendChild(cell);
      }
      return cell;
    }
    const cell = NS.rows.subjectCell(row);
    if (!cell) {
      warnOnce("no-subject-cell", "cella oggetto non trovata: badge non inseribile in questa riga");
      return null;
    }
    cell.classList.add("jg-anchor");
    return cell;
  }

  function buildBadge() {
    const badge = document.createElement("span");
    badge.className = "jg-badge";
    const bar = document.createElement("span");
    bar.className = "jg-bar";
    const fill = document.createElement("i");
    bar.appendChild(fill);
    const label = document.createElement("span");
    label.className = "jg-pct";
    badge.appendChild(bar);
    badge.appendChild(label);
    return badge;
  }

  /** One badge per row: reuse the existing node, never insert a second one. */
  function paint(row, state) {
    if (destroyed || !row || !row.isConnected) return false;
    const host = badgeHost(row);
    if (!host) return false;

    let badge = row.querySelector(".jg-badge");
    if (!badge) badge = buildBadge();
    const previousHost = badge.parentElement;
    if (previousHost !== host) {
      host.appendChild(badge);
      // The old host keeps jg-anchor (a 62px padding hole) or is an empty jg-cell
      // until it is cleaned: subjectCell() can resolve differently across rescans.
      if (previousHost) cleanupHost(previousHost);
    }

    const fill = badge.querySelector(".jg-bar i");
    const label = badge.querySelector(".jg-pct");
    if (!fill || !label) return false;

    if (state.kind === "verdict") {
      const verdict = state.verdict;
      const hue = riskHue(verdict.risk);
      badge.className = "jg-badge";
      badge.dataset.level = verdict.level || "basso";
      badge.style.setProperty("--jg-h", String(hue));
      fill.style.width = pct(verdict.risk);
      fill.style.background = "hsl(" + hue + " 70% var(--jg-l, 42%))";
      label.textContent = pct(verdict.risk);
      badge.title = verdictTooltip(verdict);
    } else if (state.kind === "error") {
      badge.className = "jg-badge jg-error";
      badge.dataset.level = "errore";
      badge.style.removeProperty("--jg-h");
      fill.style.width = "0%";
      fill.style.removeProperty("background");
      label.textContent = "!";
      badge.title = errorTooltip(state.error);
    } else {
      badge.className = "jg-badge jg-pending";
      badge.dataset.level = "attesa";
      badge.style.removeProperty("--jg-h");
      fill.style.width = "100%";
      fill.style.removeProperty("background");
      label.textContent = "…";
      badge.title = "JevGuard: analisi in corso…";
    }
    return true;
  }

  function paintById(id) {
    const row = rowElements.get(id);
    if (!row || !row.isConnected) return;
    const verdict = verdicts.get(id);
    if (verdict) {
      if (verdict.error) paint(row, { kind: "error", error: verdict.error });
      else paint(row, { kind: "verdict", verdict: verdict });
    } else if (pending.has(id)) {
      paint(row, { kind: "pending" });
    }
  }

  function cleanupHost(host) {
    if (!host || !host.classList) return;
    if (host.classList.contains("jg-cell")) {
      if (!host.querySelector(".jg-badge")) host.remove();
      return;
    }
    if (host.classList.contains("jg-anchor") && !host.querySelector(".jg-badge")) {
      host.classList.remove("jg-anchor");
    }
  }

  function removeBadgeFrom(row) {
    if (!row || typeof row.querySelectorAll !== "function") return;
    for (const badge of row.querySelectorAll(".jg-badge")) {
      const host = badge.parentElement;
      badge.remove();
      cleanupHost(host);
    }
  }

  function removeAllBadges() {
    for (const badge of document.querySelectorAll(".jg-badge")) badge.remove();
    for (const cell of document.querySelectorAll(".jg-cell")) cell.remove();
    for (const anchor of document.querySelectorAll(".jg-anchor")) anchor.classList.remove("jg-anchor");
  }

  // ------------------------------------------------------------- dark theme

  function luminanceOf(color) {
    const match = /rgba?\(([^)]+)\)/.exec(color || "");
    if (!match) return null;
    const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !isFinite(n))) return null;
    const alpha = parts.length >= 4 && isFinite(parts[3]) ? parts[3] : 1;
    if (alpha === 0) return null; // fully transparent: tells us nothing
    return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
  }

  /** Gmail's body is often transparent: walk a chain of candidates, default light. */
  function detectDark() {
    const firstRow = rowElements.values().next().value || null;
    const candidates = [document.body, document.querySelector(MAIN_SELECTOR), firstRow];
    for (const element of candidates) {
      if (!element || !element.isConnected) continue;
      let color = "";
      try {
        color = getComputedStyle(element).backgroundColor;
      } catch (error) {
        continue;
      }
      const luminance = luminanceOf(color);
      if (luminance !== null) return luminance < 128;
    }
    return false;
  }

  function updateTheme() {
    document.documentElement.classList.toggle("jg-dark", detectDark());
  }

  // ------------------------------------------------------------ row scanning

  function safeListRows() {
    try {
      return NS.rows.listRows() || [];
    } catch (error) {
      warnOnce("listRows", "listRows() ha sollevato un errore", error);
      return [];
    }
  }

  function safeExtract(row) {
    try {
      return NS.rows.extractRow(row);
    } catch (error) {
      warnOnce("extractRow", "extractRow() ha sollevato un errore", error);
      return null;
    }
  }

  function observeRow(row) {
    if (!intersection || observedRows.has(row)) return;
    observedRows.add(row);
    intersection.observe(row);
  }

  function rescan(force) {
    if (destroyed) return;
    if (!enabled) {
      if (!storageBound) void refreshStatus();
      return;
    }
    if (!attachMain()) return;

    if (force && intersection) {
      intersection.disconnect();
      observedRows = new WeakSet();
    }

    const nextElements = new Map();
    const nextData = new Map();
    const liveRows = new Set();

    for (const row of safeListRows()) {
      const data = safeExtract(row);
      if (!data || !data.id) continue;
      const previous = row.dataset ? row.dataset.jgId : "";
      if (previous && previous !== data.id) {
        // Recycled row: same element, different message. Drop the old badge and
        // re-observe it, otherwise no intersection callback would ever fire again.
        removeBadgeFrom(row);
        if (intersection) intersection.unobserve(row);
        observedRows.delete(row);
      }
      if (row.dataset) row.dataset.jgId = data.id;
      nextElements.set(data.id, row);
      nextData.set(data.id, data);
      liveRows.add(row);
      observeRow(row);
    }

    rowElements = nextElements;
    rowData = nextData;
    updateTheme();

    // Drop badges left behind by rows Gmail removed or no longer detects.
    for (const badge of document.querySelectorAll(".jg-badge")) {
      const owner = badge.closest("[data-jg-id]");
      if (owner && liveRows.has(owner)) continue;
      const host = badge.parentElement;
      badge.remove();
      cleanupHost(host);
    }

    for (const id of rowElements.keys()) paintById(id);
  }

  function scheduleRescan(force) {
    if (destroyed) return;
    // Coalesced calls must not downgrade a forced rescan to a plain one.
    pendingForce = pendingForce || Boolean(force);
    const now = Date.now();
    if (rescanTimer) {
      // Trailing debounce, but capped: Gmail streams a folder in long mutation
      // bursts, and an uncapped re-arm would push the rescan back indefinitely —
      // new rows would get no data-jg-id, never be observed and never analysed.
      if (now - rescanSince >= RESCAN_MAX_WAIT_MS) return; // let the armed timer fire
      clearTimeout(rescanTimer);
    } else {
      rescanSince = now;
    }
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      const forced = pendingForce;
      pendingForce = false;
      rescan(forced);
    }, RESCAN_DEBOUNCE_MS);
  }

  // --------------------------------------------------------------- observers

  const intersection =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(onIntersect, { rootMargin: ROOT_MARGIN })
      : null;
  if (!intersection) warnOnce("no-io", "IntersectionObserver non disponibile: nessuna analisi automatica");

  function onIntersect(entries) {
    if (destroyed || !enabled) return;
    let queued = false;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const row = entry.target;
      const id = row.dataset ? row.dataset.jgId : "";
      if (!id) continue;
      if (verdicts.has(id)) {
        paintById(id);
        continue;
      }
      if (pending.has(id) || queue.has(id)) {
        paint(row, { kind: "pending" });
        continue;
      }
      const data = rowData.get(id) || safeExtract(row);
      if (!data || !data.id) continue;
      queue.set(id, data);
      queued = true;
    }
    if (queued) scheduleFlush();
  }

  /**
   * True when a record only describes JevGuard's own rendering. Judging the target
   * alone is not enough: a badge is appended to (or removed from) Gmail's own
   * subject cell, so the record's target is that cell and only the added/removed
   * nodes are ours. Two complementary tests:
   *  - target inside a badge/cell: covers the text-node churn of `label.textContent`
   *    (nodeType 3, so the node test below would reject it),
   *  - every added/removed node is one of our elements: covers appendChild(badge),
   *    badge.remove(), the append-cell <td> and its removal by cleanupHost().
   * A record mixing our nodes with Gmail's is treated as Gmail's, i.e. it rescans.
   */
  function isOwnNode(node) {
    return Boolean(node && node.nodeType === 1 && node.classList && (node.classList.contains("jg-badge") || node.classList.contains("jg-cell")));
  }

  function isOwnRecord(record) {
    const target = record.target;
    if (target && target.nodeType === 1 && typeof target.closest === "function" && target.closest(".jg-badge, .jg-cell")) {
      return true;
    }
    const added = record.addedNodes ? Array.from(record.addedNodes) : [];
    const removed = record.removedNodes ? Array.from(record.removedNodes) : [];
    const nodes = added.concat(removed);
    return nodes.length > 0 && nodes.every(isOwnNode);
  }

  const mutation = new MutationObserver((records) => {
    if (destroyed || !enabled) return;
    for (const record of records) {
      // Ignore the mutations our own rendering causes.
      if (isOwnRecord(record)) continue;
      scheduleRescan(false);
      return;
    }
  });

  function attachMain() {
    const main = document.querySelector(MAIN_SELECTOR);
    if (!main) {
      watchForMain();
      return false;
    }
    if (mainEl !== main || !mainEl.isConnected) {
      mutation.disconnect();
      // childList only, deliberately: our own attribute writes on Gmail nodes
      // (jg-anchor, data-jg-id) and on the badge (title, style, data-level) must
      // not produce records, so they can never re-trigger a rescan.
      mutation.observe(main, { childList: true, subtree: true });
      mainEl = main;
    }
    return true;
  }

  /** At document_idle Gmail's main pane often does not exist yet. */
  function watchForMain() {
    if (bootObserver || destroyed) return;
    bootObserver = new MutationObserver(() => {
      if (!document.querySelector(MAIN_SELECTOR)) return;
      bootObserver.disconnect();
      bootObserver = null;
      if (enabled) rescan(true);
    });
    bootObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function onHashChange() {
    if (destroyed || !enabled) return;
    if (mainEl && !mainEl.isConnected) mainEl = null;
    scheduleRescan(true);
  }

  // ------------------------------------------------------------------ flush

  function scheduleFlush() {
    if (destroyed || flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  function storeVerdict(verdict) {
    if (!verdict || !verdict.id) return;
    verdicts.set(verdict.id, verdict);
    pending.delete(verdict.id);
    if (!enabled || destroyed) return; // a late answer after a toggle-off
    try {
      paintById(verdict.id);
    } catch (error) {
      // A render failure must never reject the chunk's promise.
      warnOnce("paint", "rendering del badge non riuscito", error);
    }
  }

  function failItems(items, error) {
    for (const item of items) {
      storeVerdict({ id: item.id, error: { code: error.code || "UNKNOWN", message: error.message || "errore inatteso" } });
    }
  }

  async function analyseChunk(chunk) {
    const response = await sendMessage({ type: "ANALYZE", items: chunk });
    if (destroyed) return;
    if (!response) {
      failItems(chunk, { code: "UNKNOWN", message: "estensione non raggiungibile" });
      return;
    }
    if (!response.ok) {
      const error = response.error || { code: "UNKNOWN", message: "errore inatteso" };
      if (error.code === "DISABLED") {
        for (const item of chunk) pending.delete(item.id);
        applyEnabled(false);
        return;
      }
      failItems(chunk, error);
      return;
    }
    const answered = new Set();
    const list = Array.isArray(response.verdicts) ? response.verdicts : [];
    for (const verdict of list) {
      if (!verdict || !verdict.id) continue;
      answered.add(verdict.id);
      storeVerdict(verdict);
    }
    const missing = chunk.filter((item) => !answered.has(item.id));
    if (missing.length) failItems(missing, { code: "UNKNOWN", message: "nessun verdetto restituito" });
  }

  async function flush() {
    if (destroyed || !enabled || queue.size === 0) return;

    const batch = Array.from(queue.values());
    queue.clear();

    const unknown = [];
    for (const item of batch) {
      if (verdicts.has(item.id)) {
        paintById(item.id);
        continue;
      }
      if (pending.has(item.id)) continue;
      pending.add(item.id);
      const row = rowElements.get(item.id);
      if (row) paint(row, { kind: "pending" });
      unknown.push(item);
    }
    if (!unknown.length) {
      reportStats();
      return;
    }

    // Cached first: those rows are painted instantly and never sent again.
    const cached = await sendMessage({ type: "GET_CACHED", ids: unknown.map((item) => item.id) });
    if (destroyed) return;
    if (!enabled) {
      for (const item of unknown) pending.delete(item.id);
      return;
    }

    const known = new Set();
    if (cached && cached.ok && Array.isArray(cached.verdicts)) {
      for (const verdict of cached.verdicts) {
        if (!verdict || !verdict.id) continue;
        known.add(verdict.id);
        storeVerdict(verdict);
      }
    }

    const todo = unknown.filter((item) => !known.has(item.id));
    const chunks = [];
    for (let i = 0; i < todo.length; i += CHUNK_SIZE) chunks.push(todo.slice(i, i + CHUNK_SIZE));

    // Concurrent: each chunk paints its own verdicts as soon as it comes back.
    await Promise.all(chunks.map((chunk) => analyseChunk(chunk)));
    reportStats();
  }

  /** Fire and forget: the worker may be asleep or the context gone. */
  function reportStats() {
    if (destroyed) return;
    let rendered = 0;
    let errors = 0;
    for (const id of rowElements.keys()) {
      const verdict = verdicts.get(id);
      if (!verdict) continue;
      if (verdict.error) errors += 1;
      else rendered += 1;
    }
    void sendMessage({ type: "PAGE_STATS", rows: rowElements.size, rendered: rendered, pending: pending.size, errors: errors });
  }

  // ----------------------------------------------------------- enabled state

  function start() {
    if (destroyed || running) return;
    running = true;
    // Failed rows are cached as errors so scrolling does not retry them; turning
    // the extension back on is an explicit retry.
    for (const [id, verdict] of Array.from(verdicts.entries())) {
      if (verdict && verdict.error) verdicts.delete(id);
    }
    updateTheme();
    attachMain();
    rescan(true);
  }

  function stop() {
    running = false;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (rescanTimer) {
      clearTimeout(rescanTimer);
      rescanTimer = null;
    }
    if (intersection) intersection.disconnect();
    observedRows = new WeakSet();
    mutation.disconnect();
    mainEl = null;
    queue.clear();
    pending.clear();
    removeAllBadges();
  }

  function applyEnabled(next) {
    const value = Boolean(next);
    if (value === enabled && (value ? running : !running)) return;
    enabled = value;
    if (enabled) start();
    else stop();
  }

  async function readEnabled() {
    try {
      const stored = await chrome.storage.session.get("enabled");
      if (stored && typeof stored.enabled === "boolean") return stored.enabled;
    } catch (error) {
      // Access can be denied even after addListener() silently succeeded (the SW
      // may not have raised the access level yet): fall back to polling.
      warnOnce("session-read", "storage.session non leggibile dal content script", error);
      storageBound = false;
      startStatusPoll();
    }
    const status = await sendMessage({ type: "GET_STATUS" });
    if (status && status.ok && typeof status.enabled === "boolean") return status.enabled;
    return false; // contract: off by default
  }

  function bindStorage() {
    try {
      chrome.storage.session.onChanged.addListener((changes) => {
        if (destroyed || !changes || !changes.enabled) return;
        stateFromEvent = true;
        applyEnabled(changes.enabled.newValue);
      });
      sessionListenerBound = true;
      storageBound = true;
    } catch (error) {
      warnOnce("session-subscribe", "storage.session.onChanged non disponibile: uso GET_STATUS", error);
      sessionListenerBound = false;
      storageBound = false;
    }
  }

  async function refreshStatus() {
    const status = await sendMessage({ type: "GET_STATUS" });
    if (destroyed || !status || !status.ok || typeof status.enabled !== "boolean") return;
    applyEnabled(status.enabled);
  }

  /**
   * Without storage events the only way to notice a popup toggle is to ask.
   * The poll wakes the MV3 service worker every 4 s, so it must stop as soon as it
   * is no longer needed: when the onChanged listener is live (it is, unless
   * bindStorage() threw) and storage.session has become readable again, the events
   * take over and the interval is cleared. If there is no listener at all the poll
   * is the only channel and keeps running.
   */
  function startStatusPoll() {
    if (statusTimer || destroyed) return;
    statusTimer = setInterval(async () => {
      if (destroyed) return;
      if (sessionListenerBound) {
        try {
          const stored = await chrome.storage.session.get("enabled");
          if (destroyed || statusTimer === null) return;
          storageBound = true;
          clearInterval(statusTimer);
          statusTimer = null;
          // A storage event already decided the state: it is live and authoritative,
          // this read may have been taken before it fired.
          if (!stateFromEvent && stored && typeof stored.enabled === "boolean") applyEnabled(stored.enabled);
          return;
        } catch (error) {
          // Access still denied by the worker: keep polling.
        }
      }
      void refreshStatus();
    }, STATUS_POLL_MS);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stop();
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
    if (bootObserver) {
      bootObserver.disconnect();
      bootObserver = null;
    }
    window.removeEventListener("hashchange", onHashChange);
    document.documentElement.classList.remove("jg-dark");
  }

  // ------------------------------------------------------------ debug hooks

  NS.debug = function debug() {
    const rows = safeListRows();
    const info = {
      placement: BADGE_PLACEMENT,
      enabled: enabled,
      running: running,
      detectedRows: rows.length,
      firstRow: rows.length ? safeExtract(rows[0]) : null,
      cachedVerdicts: verdicts.size,
      pending: pending.size,
      queued: queue.size,
      dark: document.documentElement.classList.contains("jg-dark"),
      mainFound: Boolean(document.querySelector(MAIN_SELECTOR))
    };
    console.log("[JevGuard] debug", info);
    for (const row of rows) row.classList.add("jg-debug");
    setTimeout(() => {
      for (const row of rows) row.classList.remove("jg-debug");
    }, DEBUG_OUTLINE_MS);
    return info;
  };

  NS.rescan = function forceRescan() {
    // Errors are cached so scrolling does not retry them; a manual rescan does.
    for (const [id, verdict] of Array.from(verdicts.entries())) {
      if (verdict && verdict.error) verdicts.delete(id);
    }
    if (!enabled) {
      void refreshStatus();
      return false;
    }
    rescan(true);
    return true;
  };

  // ------------------------------------------------------------------- boot

  window.addEventListener("hashchange", onHashChange);

  (async function boot() {
    bindStorage();
    if (!storageBound) startStatusPoll();
    const initial = await readEnabled();
    if (destroyed || stateFromEvent) return;
    applyEnabled(initial);
  })();
})();
