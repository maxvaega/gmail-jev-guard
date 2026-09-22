# JevGuard — internal contract (source of truth for all files)

Chrome MV3 extension. Shows a spam/phishing risk bar inside each Gmail list row,
computed by TypeSafe **Jev** (`POST https://api.typesafe.ai/v1/systemone`).

**Rules for every file**
- Plain JS, no build step, no npm deps, no frameworks, no TypeScript.
- Service worker (`src/background.js`) is an **ES module** (`"type":"module"`) → `import` allowed.
- **Content scripts are NOT modules**: no `import`/`export` in `src/content/*.js`.
  They share state through the single global `window.JevGuard` (see below).
- Code + comments in English. All user-visible strings in **Italian**.
- No `chrome.tabs`, no `activeTab`, no broad host permissions. Only:
  `permissions: ["storage"]`, `host_permissions: ["https://api.typesafe.ai/*"]`.

## 1. Files and ownership

```
gmail-jev-guard/
  manifest.json            (owner: main)  MV3 manifest
  package.json             (owner: main)  "type":"module" (Node reads src/*.js as ESM)
                                          + npm run icons|calibrate; zero dependencies
  CONTRACT.md              (owner: main)  this file
  README.md                (owner: docs agent)
  src/
    jev.js                 (owner: main)  questions, state builder, scoring  [ESM]
    typesafe-client.js     (owner: main)  HTTP client + retry                [ESM]
    background.js          (owner: bg agent)   service worker                [ESM]
    content/
      gmail-rows.js        (owner: content agent) DOM adapter                [classic]
      inject.js            (owner: content agent) observers, badge, panel    [classic]
      badge.css            (owner: content agent)
    popup/
      popup.html|.css|.js  (owner: popup agent)
  icons/icon16.png icon48.png icon128.png   (owner: tools agent, generated)
  tools/
    make-icons.mjs         (owner: tools agent) writes the 3 PNGs
    fixtures.json          (owner: tools agent) sample emails for calibration
    contract-test.mjs      (owner: tools agent) real API test (needs key)
    panel-test.mjs         (owner: tools agent) hover panel in jsdom (JSDOM_HOME)
```

## 2. Data shapes

### RowData — extracted by the content script, sent to the SW
```js
{
  id: "thread-f:1234...",   // stable per row, see gmail-rows.js
  senderName: "Poste Italiane",
  senderAddress: "no-reply@poste-it-secure.example",  // "" if unknown
  subject: "Il tuo account e' stato sospeso",
  snippet: "Gentile cliente, ...",                    // may be ""
  hasAttachment: false,
  otherSendersCount: 0      // extra span[email] in the same row, integer
}
```

### Verdict — produced by the SW, rendered by the content script
```js
{
  id, risk: 0.87,           // = max(is_phishing, is_spam)
  kind: "phishing" | "spam" | "ok",
  level: "basso" | "sospetto" | "alto",
  phishing: 0.87, spam: 0.41,
  signals: [ { id, label, value } ],   // short Italian label, 0..1, sorted desc
  questions: [ { id, role, question, value } ],  // ALL six, QUESTIONS order, for
                            // the hover panel: `role` is "score" (is_phishing,
                            // is_spam) or "signal", `question` is the Italian
                            // question, `value` is 0..1 or null if unusable
  inputTokens: 612,
  model: "jev-1.13.0",
  ts: 1758... ,             // Date.now() at completion
  error: null               // or { code, message } — see 4.3
}
```

## 3. Message protocol (content script / popup  →  service worker)

`chrome.runtime.sendMessage(msg)` → the SW **always** answers (`return true` in the
listener, single `sendResponse`). No ports, no long-lived connections.

| `msg.type`     | payload                    | response |
|----------------|----------------------------|----------|
| `ANALYZE`      | `{ items: RowData[] }` (max 5 per message) | `{ ok:true, verdicts: Verdict[] }` or `{ ok:false, error:{code,message} }` |
| `GET_CACHED`   | `{ ids: string[] }`        | `{ ok:true, verdicts: Verdict[] }` (only the ones already known) |
| `GET_STATUS`   | `{}`                       | `{ ok:true, enabled, hasKey, stats:{analyzed,errors,inputTokens,cached}, lastError }` |
| `SET_ENABLED`  | `{ enabled: boolean }`     | `{ ok:true, enabled }` |
| `SET_KEY`      | `{ key: string }`          | `{ ok:true }` |
| `VERIFY_KEY`   | `{ key?: string }`         | `{ ok:true, models:[names] }` or `{ ok:false, error }` |
| `CLEAR_CACHE`  | `{}`                       | `{ ok:true }` |
| `PAGE_STATS`   | `{ rows, rendered, pending, errors }` — content → SW, fire and forget | `{ ok:true }` |

The popup additionally reads `PAGE_STATS` back through `GET_STATUS.stats.page`.

## 4. Storage and state

### 4.1 Keys
- `chrome.storage.local`: `{ apiKey: string }` — persists across sessions, **SW only**.
- `chrome.storage.session`: `{ enabled: boolean, verdicts: {id: Verdict}, stats: {...},
  page: {...}, lastError: {code, message, ts}|null }`
  Cleared automatically when Chrome closes → this is what makes the extension
  **off by default at every new browser session** (a requirement).
- The SW calls, at `onInstalled` and `onStartup`:
  `chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })`
  so the content script can read `enabled` directly and subscribe to
  `chrome.storage.session.onChanged`.

### 4.2 Toolbar feedback
When `enabled` flips: `chrome.action.setBadgeText({ text: enabled ? "ON" : "" })`
and `chrome.action.setBadgeBackgroundColor({ color: "#1a73e8" })`.

### 4.3 Error codes (`error.code`)
`NO_KEY` · `AUTH` (401) · `RATE_LIMIT` (429/529 after retries) · `BAD_REQUEST` (422)
· `NETWORK` · `TIMEOUT` · `DISABLED` · `UNKNOWN`. `error.message` is Italian, short.

## 5. Modules owned by main (do not rewrite, just import)

`src/jev.js` exports:
- `JEV_MODEL` = `"jev-latest"`
- `QUESTIONS` — map of 6 Noul questions
- `buildState(row: RowData) -> object` — the `state` payload: exactly the five fields the
  questions reference (`sender_display_name`, `sender_address`, `sender_domain`, `subject`,
  `preview_text`); a field whose value is unknown is omitted, never sent as a placeholder —
  the single exception is `preview_text`, always present, possibly an empty string.
  `hasAttachment` and `otherSendersCount` are deliberately NOT sent to the model.
- `scoreAnswers(answers) -> { risk, kind, level, phishing, spam, signals, questions }`
- `SIGNAL_LABELS` (short labels, one-line summary) and `QUESTION_META` (`{role, question}`
  per Noul, the Italian questions the hover panel lists)
- `RISK_BANDS`, `riskColor(risk) -> {bar, text}` (HSL strings, dark-mode agnostic)

`src/typesafe-client.js` exports:
- `API_BASE` = `"https://api.typesafe.ai/v1"`
- `class TypeSafeError extends Error` with `.code`, `.status`, `.retryable`
- `async systemOne({ apiKey, state, questions, model, timeoutMs, maxRetries, fetchImpl })`
  → `{ model, answers, usage }`, throws `TypeSafeError`
- `async listModels({ apiKey, timeoutMs, fetchImpl })` → `string[]`
- `inputTokensOf(usage) -> number|null` — the one tolerant reader for the token count
Both are dependency-free ESM and must stay usable from plain Node 20 (`tools/contract-test.mjs`).

## 6. Behaviour spec

- Only rows **currently visible in the viewport** are analysed (IntersectionObserver), in any
  folder/label **except the recipient-side views** (`#sent`, `#drafts`, `#scheduled`, `#outbox`,
  `#templates`), where `listRows()` returns `[]` because there `span[email]` is the recipient and
  scoring the user's own outgoing mail would be meaningless and paid. Plus a rescan on
  `hashchange` and on list mutations (MutationObserver on `div[role="main"]`, debounce 300 ms,
  max wait 1 s).
- Verdicts are cached by `RowData.id` for the session; a cached row is rendered
  instantly and never re-sent.
- The content script batches visible-but-unknown rows into chunks of **5** and sends
  them concurrently; the SW runs at most **4** Jev requests in parallel.
- While a row waits: a pulsing grey placeholder bar. On error: grey bar with `!` and
  the reason in the tooltip.
- Toggling off removes every badge from the page; toggling on re-renders from cache.

## 7. Badge (visual spec)

- Placement (default `BADGE_PLACEMENT = "overlay"`): absolutely positioned inside the
  row's subject cell, flush right → it sits immediately left of the date column and is
  not covered by Gmail's hover action icons. Alternative mode `"append-cell"` appends a
  new `<td>` as the true last cell. One constant at the top of `inject.js`.
- Markup: `<span class="jg-badge" data-level="..."><span class="jg-bar"><i style="width:NN%"></i></span><span class="jg-pct">NN%</span></span>`
- Width ~54 px, height 6 px bar + 11 px text, never changes row height.
- Colour: continuous hue 120 (green) → 0 (red), `hsl(H 70% 42%)`; the track is a
  translucent grey that works on both Gmail themes. `.jg-dark` is set on `<html>` when
  the Gmail background is dark (computed luminance of `body`).
- **No `title` attribute** (it would pop the native tooltip on top of the panel): the same
  Italian text goes into `aria-label`, four blocks — the risk line; `spam NN% · phishing NN%
  (la % mostrata è la maggiore delle due)`; one line per explanatory signal `>= 40%`; the closing
  provenance line "Valutato da TypeSafe Jev su mittente (nome, indirizzo e dominio), oggetto e
  anteprima." — kept textually identical in `src/jev.js` and `src/content/inject.js`.
- Only the badge's children are hit-testable (`pointer-events`): the bar and the percentage are
  the hover target, the rest of the 54 px box keeps letting clicks through to the Gmail row.

## 7.1 Hover panel (visual spec)

- One `div.jg-panel` appended to `<body>`, `position: fixed`, placed from the badge's
  `getBoundingClientRect()`: **left** of the badge and vertically centred on it; under it
  (right-aligned), or over it, only when the left side has no room. Never inside the row —
  Gmail's overflow would clip it and its z-index would have to be fought.
- `pointer-events: none`, always. Moving the pointer "into" the panel is therefore a *leave*
  of the badge and the panel closes: **the panel must disappear as soon as the mouse is off the
  indicator**, and it must never swallow a click on a Gmail row. No hover-to-keep-open.
- Opens after `PANEL_SHOW_MS` (90 ms) on the badge, closes after `PANEL_HIDE_MS` (120 ms) of
  grace — the grace exists only because the 1 px gap between the bar and the percentage belongs
  to the row, so crossing it fires a `mouseout` the next `mouseover` has to cancel.
- Also closes on: scroll, `mousedown`, any `keydown`, window `blur`, `visibilitychange`,
  `hashchange`, the anchored badge being removed/recycled, toggle-off and context invalidation.
- Content, with a verdict: big percentage + "Rischio phishing · alto"; the `spam/phishing` line;
  **all six questions in `QUESTIONS` order**, grouped as "Domande che determinano la percentuale"
  (the two `score` Nouls) and "Segnali che spiegano il verdetto" (the four `signal` ones), each
  with a mini bar on the same hue ramp and its percentage (`n/d` when the answer is unusable,
  bold when `>= 50%` = Jev answering "yes"); a footer with the `>= 50%` legend, the model, the
  input tokens and the provenance line. Pending: one line. Error: `message [CODE]` + the remedy.
- A verdict landing while the pointer is on the badge re-renders the open panel.
- Delegated `mouseover`/`mouseout` on `document` in the **capture** phase (immune to Gmail's own
  delegation calling `stopPropagation`); the row's state is looked up by `data-jg-id`, never kept
  in a side map, because Gmail recycles rows.

## 8. Debug affordances (required — the author cannot open a browser)

- `window.JevGuard.debug()` in the page console: logs the number of detected rows, the
  first extracted `RowData`, the cache size, and outlines every detected row with a
  dashed magenta border for 3 s.
- `window.JevGuard.rescan()` forces a full rescan.
- `window.JevGuard.showPanel([id])` opens the hover panel without a mouse (first visible row
  with a verdict, or the given id); `window.JevGuard.hidePanel()` closes it. `debug()` reports
  `panelOpen`.
- `tools/panel-test.mjs` drives the real `inject.js` in jsdom (stubbed `chrome`, stubbed
  `NS.rows`) and asserts the open/close behaviour: `JSDOM_HOME=/path node tools/panel-test.mjs`.
- Every unexpected DOM situation logs once with the `[JevGuard]` prefix.
