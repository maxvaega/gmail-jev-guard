# JevGuard

Chrome extension (MV3) that shows, inside every row of the Gmail list, how much that
message looks like spam or phishing. The score comes from **Jev** (TypeSafe System One),
not from local heuristics.

> **The code and this README are in English; every user-visible string in the extension is
> Italian by design** (see `CONTRACT.md`). Throughout this document the UI labels are quoted
> as they appear on screen, with an English gloss — e.g. *Analisi attiva* ("Analysis on").

## 1. What it does

While you scroll through your mail, JevGuard reads from the row only what Gmail already
shows (sender — display name, address and domain —, subject, preview), sends it to Jev as
six calibrated boolean questions and paints a coloured bar with the risk percentage inside
the row. No message is opened, no body is read, no mailbox is scanned: only the rows you
actually have in front of you.

```
Gmail row → sender / subject / preview → Jev (1 request) → coloured bar + %
```

**What it never analyses**: the views where the row shows the *recipient* instead of the
sender — **Sent, Drafts, Scheduled, Outbox, Templates**. There `span[email]` is the person
you are writing to: judging those rows would mean having Jev evaluate your own outgoing mail
as if it came from the recipient's domain, paying for one call each. `listRows()` in
`src/content/gmail-rows.js` returns zero rows when the page hash is one of those views; going
back to the Inbox, the rescan on `hashchange` switches everything back on by itself.

## 2. From source to a working extension (developer mode)

Nothing to compile and nothing to install: `package.json` declares no dependencies and has no
build step (it only marks the `src/*.js` sources as ESM for Node — see §4). No `npm install`.

### 2.1 Prerequisites

| | |
|---|---|
| **Chrome ≥ 116** | `minimum_chrome_version` in the manifest. Any Chromium-based browser with MV3 and `chrome.storage.session` works (Edge, Brave). |
| **Git** | Only to clone. You can also download the ZIP from GitHub and unpack it. |
| **A TypeSafe API key** | Create one in the console: <https://console.typesafe.ai/keys> (quick start: <https://docs.typesafe.ai/introduction/quickstart>). The extension is useless without it: every score comes from the API. |
| **Node.js ≥ 18** *(optional)* | Only for `tools/` — the calibration harness and the icon generator. `src/typesafe-client.js` falls back to `globalThis.fetch`, which needs Node 18 or newer. Not needed to run the extension. |

### 2.2 Get the code

```bash
git clone https://github.com/maxvaega/gmail-jev-guard.git
cd gmail-jev-guard
```

**The cloned directory is the extension folder**: it contains `manifest.json` at its root,
and that is exactly the folder you point Chrome at in the next step. Nothing to move around.

The three PNG icons are committed, so there is no generation step after a clone. If `icons/`
is ever empty (or you want to redraw them), run `node tools/make-icons.mjs` — without the
three PNGs referenced by the manifest, Chrome refuses to load the extension.

### 2.3 Load it in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select the folder containing `manifest.json` (the directory
   you cloned).
4. The JevGuard card appears in the list. Optionally click the puzzle-piece icon in the
   toolbar and pin JevGuard, so the popup is one click away.
5. **Reload your Gmail tab.** Content scripts do not enter tabs that are already open: this
   applies to every install and to every "Reload" of the extension.

### 2.4 Configure the key and switch the analysis on

Open the popup from the toolbar:

1. Paste your **TypeSafe API key** into the field and press **Salva** ("Save").
2. Press **Verifica** ("Verify"): it performs a `GET /v1/models` — it confirms the key
   without spending tokens. On success it lists the models.
3. Tick **Analisi attiva (solo per questa sessione)** ("Analysis on, this session only").
   The toolbar badge turns into `ON`.

**Session behaviour (intentional, not a bug):**

| what | where it lives | survives closing Chrome |
|---|---|---|
| API key | `chrome.storage.local` | yes |
| "Analisi attiva" switch | `chrome.storage.session` | **no — it always starts OFF** |
| cached verdicts, statistics | `chrome.storage.session` | no |

In other words: you enter the key once, and you turn the analysis back on yourself at every
new browser start. That is the guarantee that the extension never calls the API behind your back.

### 2.5 Check that it works

Go to the Inbox and scroll. Within a moment each visible row gets a grey pulsing bar (analysis
in progress) that turns into a coloured bar with a percentage (§3).

If nothing appears, open the Gmail console (F12) and run:

```js
window.JevGuard.debug()
```

It prints the extension's state and draws a dashed magenta outline for 3 seconds around every
row it recognised. What to look at:

| field | expected | if not |
|---|---|---|
| `enabled` | `true` | switch the toggle on in the popup (it restarts OFF at every Chrome start) |
| `mainFound` | `true` | update `MAIN_SELECTOR` in `src/content/inject.js` |
| `detectedRows` | > 0 | update `ROW_SELECTORS` / `SUBJECT_CELL_SELECTOR` in `src/content/gmail-rows.js` |
| `firstRow` | a filled `RowData` | an empty `senderAddress` means only sender extraction broke |

If `window.JevGuard` does not even exist, the content scripts never ran: check the errors on
the extension card. The full symptom table is in §9.

### 2.6 The development loop

After **any** change to the source:

1. `chrome://extensions` → the **reload** (↻) icon on the JevGuard card.
2. **Reload the Gmail tab** — again, content scripts do not re-enter open tabs.
3. Open the popup and check the toggle: if *Analisi attiva* came back off, turn it on again.

Where errors surface:

- **Extension card** → the **Errors** button, for manifest and load-time problems.
- **Page console** (F12 on Gmail) → the content scripts (`src/content/*.js`), all their lines
  are prefixed with `[JevGuard]`.
- **Service worker console** → `chrome://extensions` → JevGuard → *Inspect views: service
  worker*, for `src/background.js`: API calls, queue, cache, storage.

To uninstall, press **Remove** on the card. That also wipes `chrome.storage.local`, i.e. the
saved API key.

## 3. Reading the indicator

A ~54 px bar: 6 px of bar plus the percentage in 11 px type. It never changes the row height.

- **Percentage** = `max(spam probability, phishing probability)`, rounded.
- **Colour**: continuous green → red ramp, `hsl(120 → 0, 70%, 42%)`. On Gmail's dark theme,
  `<html>` gets the `.jg-dark` class and only the lightness changes.
- **Bands** (`RISK_BANDS` in `src/jev.js`):

| band | value | how to read it |
|---|---|---|
| low (*basso*) | < 35 % | green/yellow — nothing to do |
| suspicious (*sospetto*) | 35 – 64 % | amber — check sender and links before clicking |
| high (*alto*) | ≥ 65 % | red — treat it as hostile |

The thresholds apply to the unrounded value: a bar showing "65 %" may still be `sospetto` (0.647).

- **Tooltip** (the bar's `title`), four blocks in this order:
  1. summary line — "Rischio phishing 87 % (alto)" / "Probabile spam …" / "Rischio …";
  2. `spam NN% · phishing NN%  (la % mostrata è la maggiore delle due)` — the percentage shown
     is the larger of the two;
  3. one `• <signal>: NN%` line for every explanatory signal **≥ 40 %** (all four signals are
     always computed, only the ones that actually matter show up in the tooltip);
  4. always, the closing line about where the judgement comes from:
     `Valutato da TypeSafe Jev su mittente (nome, indirizzo e dominio), oggetto e anteprima.`
- **Transient states**: pulsing grey bar = analysis in progress; grey bar with `!` = error. The
  error tooltip is `Analisi non riuscita: <reason in Italian> [CODE]` (with `NO_KEY` a second
  line points you to the popup): the code in square brackets is the one you find in the table
  in §9.

**Position**: the bar is absolutely positioned inside the subject cell, right-aligned → it sits
just left of the date column, and the icons Gmail shows on hover do not cover it. If you prefer
a real extra column, flip the single constant `BADGE_PLACEMENT = "overlay"` → `"append-cell"`
at the top of `src/content/inject.js`.

## 4. How it works inside

### File map

| file | role |
|---|---|
| `manifest.json` | MV3. Permissions: only `storage` + host `https://api.typesafe.ai/*`. No `tabs`, no `activeTab`. |
| `package.json` | No dependencies, no build. It exists only for `"type": "module"`, so Node reads `src/jev.js` and `src/typesafe-client.js` as ESM even before Node 20.19 (plus two shortcuts: `npm run icons`, `npm run calibrate`). |
| `src/jev.js` | ESM. `JEV_MODEL`, `QUESTIONS` (the 6 Nouls), `buildState`, `scoreAnswers`, `RISK_BANDS`/`riskLevel`, `riskColor`, `SIGNAL_LABELS`, `senderDomain`, `verdictTooltip`. Zero `chrome.*`: it also runs in Node. |
| `src/typesafe-client.js` | ESM. `systemOne()`, `listModels()`, `TypeSafeError`, `italianMessage()`, `inputTokensOf()` (the single tolerant reader of the token count, shared with the test). 20 s timeout, 3 retries with exponential backoff that honours `retry-after`. |
| `src/background.js` | Service worker (module). Cache, queue, calls to Jev, storage, toolbar badge. |
| `src/content/gmail-rows.js` | Classic script. The file that knows Gmail's **row** markup (`listRows`, `extractRow`, `subjectCell`) and the views to skip; the only other Gmail selector in the project is `MAIN_SELECTOR` in `inject.js`. |
| `src/content/inject.js` | Classic script. `MAIN_SELECTOR`, observers, batching, badge painting, `window.JevGuard.debug()/rescan()`. |
| `src/content/badge.css` | Bar styling, `jg-pending` / `jg-error` states, `.jg-dark` variant. |
| `src/popup/*` | API key, switch, live statistics (page + session), estimated cost, clear cache. |
| `tools/make-icons.mjs` | Generates the 3 PNGs in `icons/`. |
| `tools/fixtures.json` | Sample emails for calibration. |
| `tools/contract-test.mjs` | Test against the real API (needs the key). |

The content scripts **are not modules** (they cannot import `jev.js`): `inject.js` recomputes
the tooltip and the colour on its own, mirroring `verdictTooltip()` and `riskColor()`.
**If you touch those two functions, update `inject.js` as well.**

### Message protocol

Content scripts and popup talk to the service worker only through `chrome.runtime.sendMessage`;
the SW always answers (no port, no persistent connection).

| `type` | payload | answer |
|---|---|---|
| `ANALYZE` | `{ items: RowData[] }` (max 5) | `{ ok, verdicts[] }` |
| `GET_CACHED` | `{ ids: string[] }` | `{ ok, verdicts[] }` (known ones only) |
| `GET_STATUS` | `{}` | `{ ok, enabled, hasKey, stats, lastError }` |
| `SET_ENABLED` | `{ enabled }` | `{ ok, enabled }` |
| `SET_KEY` | `{ key }` | `{ ok }` |
| `VERIFY_KEY` | `{ key? }` | `{ ok, models[] }` |
| `CLEAR_CACHE` | `{}` | `{ ok }` |
| `PAGE_STATS` | `{ rows, rendered, pending, errors }` | `{ ok }` (fire & forget) |

`RowData` = `{ id, senderName, senderAddress, subject, snippet, hasAttachment, otherSendersCount }`.
`Verdict` = `{ id, risk, kind, level, phishing, spam, signals[], inputTokens, model, ts, error }`.

### Work cycle

- **Lazy on the viewport**: an `IntersectionObserver` (200 px margin) marks the visible rows; a
  `MutationObserver` on `div[role="main"]` plus the `hashchange` event (300 ms debounce) handle
  Gmail's single-page navigation. In the recipient views (Sent, Drafts, Scheduled, Outbox,
  Templates — §1) there is by definition no row to analyse.
- **Per-session cache**: verdicts are indexed by `RowData.id` — Gmail's thread id when the row
  exposes it, otherwise a hash of the row content. A row already seen is repainted instantly and
  never sent to Jev again. Cap of 500 verdicts, oldest by timestamp are dropped; everything dies
  when Chrome closes.
- **Batching and concurrency**: `inject.js` groups unknown rows into blocks of 5 and sends them
  in parallel; the service worker runs **at most 4 concurrent Jev requests** (`MAX_CONCURRENT = 4`)
  and deduplicates requests already in flight.
- **Storage**: `local.apiKey` is readable by the service worker only; `session` holds `enabled`,
  `verdicts`, `stats`, `page` and is opened to the content scripts through
  `setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })`, so `inject.js` reads
  `enabled` and subscribes to `storage.session.onChanged` without going through the SW.
- **Popup counters**: the first four entries (*Righe rilevate* "rows detected", *Con verdetto*
  "with a verdict", *In attesa* "pending", *Errori* "errors") come from `PAGE_STATS` and describe
  **the open Gmail tab**: *Con verdetto* counts the rows currently painted with a verdict, cache
  included, and goes down when Gmail recycles rows. *Analisi riuscite* ("successful analyses"),
  *Token input* and *Costo stimato* ("estimated cost") are instead **session** totals kept by the
  service worker, so *Token input ÷ Analisi riuscite* gives the average tokens per mail (failed
  calls produce no tokens).
- **Switching off**: unticking the box removes the badges from the page; ticking it again
  repaints them from the cache with no new calls.

## 5. The questions asked of Jev

One single request per mail: Jev ingests the `state` once and evaluates the six Nouls in
parallel (cheaper and faster than six calls).

| Noul | question |
|---|---|
| `is_phishing` | is it a fraud attempt: impersonating someone to get your credentials, data or money? |
| `is_spam` | is it unsolicited bulk commercial mail: ads, cold outreach, chain letters, sent to a list instead of written for you? |
| `sender_identity_mismatch` | does the display name claim an organisation that would never use that domain? |
| `urgency_pressure` | does it push you: deadlines, threats, an account or a parcel on hold? |
| `credential_or_payment_request` | does it ask you to authenticate, confirm data, pay or transfer money? |
| `too_good_to_be_true` | does it promise prizes, winnings, inheritances, unexpected refunds, guaranteed returns? |

The first two make the percentage, the other four only explain it in the tooltip.
The `state` that travels with the questions carries **exactly the five fields the questions
mention** (§7): everything else would be noise, and noise costs accuracy.

**Why the percentage is a `max` and not a weighted average.** `is_phishing` and `is_spam` are
calibrated probabilities: "0.80" really does mean "in 8 out of 10 cases of this kind it is true".
Combining them with made-up weights would destroy that calibration and produce a number with no
unit. The `max`, instead, stays interpretable: it is the worse of the two accusations, read on
the scale of whoever produced it. Besides, spam and phishing are distinct categories, not two
components of the same risk: a mail can be pure phishing and almost zero spam, and it must be
flagged red all the same. The sender domain, for the same reason, is extracted by the code
(`senderDomain()`) and not left for the model to infer.

## 6. Cost and limits

- **$0.042 per million input tokens**, output free. The popup shows tokens consumed and
  **estimated cost** in real time.
- **~1 request per mail actually displayed**, then it is cached for the whole session. Order of
  magnitude, **measured on the body the client really sends**
  (`JSON.stringify({ state, model, questions })`, `src/typesafe-client.js`): the six questions
  alone weigh ~3.8 KB, with a typical `state` the body is ~4.2 KB and in the worst case
  (300-character subject + 600-character preview) ~5.0 KB. With the ~4-characters-per-token
  heuristic that is **~1,000–1,250 input tokens per mail**, i.e. 1,000 mails ≈ 1–1.3 M tokens ≈
  **$0.04–0.05**, before any server-side wrapping.
  **It is an estimate until you measure it**: `TYPESAFE_API_KEY=... node tools/contract-test.mjs`
  (§8) prints the real `Token di input totali`, `Costo misurato` and `Costo per email` returned
  by the API. Replace the numbers above with those as soon as you have them.
- **Rate limit: 1,200 requests/minute.** With the cap of 4 parallel requests it is out of reach
  in normal use; if you hit it, the client retries with backoff.

Honest limitations:

- JevGuard sees **only what the list shows**: no message body, no links, no headers, no
  SPF/DKIM/DMARC check. It is a triage traffic light, not an antispam gateway: a well-written
  phishing mail with an anonymous subject can come out low.
- **It does not cover the recipient views** (Sent, Drafts, Scheduled, Outbox, Templates): there
  the row shows who you are writing to, not who is writing to you, so the analysis is disabled
  on purpose (§1).
- Jev is **primarily English**: on Italian text the thresholds need calibrating (see §8) before
  you trust the intermediate values.
- **Gmail's CSS class names change without notice**: if one day you see no more bars, the first
  suspects are the row selectors in `gmail-rows.js` and `MAIN_SELECTOR` in `inject.js` →
  `window.JevGuard.debug()`.

## 7. Privacy

For every analysed row, **only** this object leaves the browser, towards
`https://api.typesafe.ai/v1/systemone` and nowhere else:

| field sent | origin |
|---|---|
| `sender_display_name` | sender name shown in the row (max 120 characters) |
| `sender_address` | sender address, if the row exposes it (max 160 characters) |
| `sender_domain` | derived **locally** from the address, not inferred by the model |
| `subject` | subject (max 300 characters) |
| `preview_text` | preview already visible in the list (max 600 characters) |

Five fields, nothing else: exactly the ones the six questions mention. A field whose value is
unknown is **omitted from the object**, never sent as a placeholder (a `"(non disponibile)"` in
place of the domain would be read by the model as a wrong domain). The only exception:
`preview_text` is always there, at worst as an empty string.

What **never** leaves: the message body, the links, the headers, the attachments, the thread id
(it stays local, it only serves as a cache key), your own account address. `hasAttachment` and
`otherSendersCount` stay local too: the content script extracts them and they are part of
`RowData`, but they **are not sent to the model** (none of the six questions uses them).

The API key lives in `chrome.storage.local` and **only** the service worker reads it: it is never
injected into the page, it never appears in Gmail's DOM, it never travels in messages towards the
content scripts. No telemetry, no logging endpoint, no third-party server: the only traces are the
`[JevGuard]` lines in the local console.

## 8. Calibration and testing

```bash
cd gmail-jev-guard
TYPESAFE_API_KEY=sk-... node tools/contract-test.mjs
```

It runs the emails in `tools/fixtures.json` against the real API. They are Italian cases built in
pairs — the fake Poste and a real Poste, the fake Intesa and a genuine login, the fake Agenzia
delle Entrate refund and a legitimate one, plus solicited promotions, newsletters and personal
mail — so that a model saying merely "Italian banking language = phishing" would be caught
immediately. It prints a table: one row per fixture, with the probabilities returned by the Nouls,
the computed risk and the outcome expected by the `expect` field (`phishing` / `spam` / `ok`), so
you see false positives and false negatives at a glance. It uses the extension's exact `src/jev.js`
and `src/typesafe-client.js` — what you see in the test is what you will see in Gmail. At the end it
prints `Token di input totali`, `Costo misurato` and `Costo per email`: these are the only truly
measured cost figures, the ones to update the estimate in §6 with.

Useful flags: `--dry` (prints the request body, no network), `--limit N`, `--only <name>`.

Tuning cycle:

1. Add to `tools/fixtures.json` the mails the extension gets wrong (anonymised), with their `expect`.
2. Fix `QUESTIONS[<noul>].criteria.true` / `.false` in `src/jev.js`: the criteria must say the same
   thing in the same direction as the `instructions`, and Italian mail has to be described with its
   typical pretexts (SPID, Poste, Agenzia delle Entrate, couriers).
3. Run the test again, then reload the extension from `chrome://extensions` and reload Gmail.

The band thresholds live in `RISK_BANDS`, again in `src/jev.js`.

## 9. Troubleshooting

Two consoles to keep in mind:
the **page** one (F12 on Gmail) for the content scripts, and the **service worker** one at
`chrome://extensions` → JevGuard → *Inspect views: service worker*.

| symptom | what to check |
|---|---|
| **No bar at all** | Are you in **Sent / Drafts / Scheduled / Outbox / Templates**? There the analysis is disabled on purpose (§1), it is not a fault. Did you reload the Gmail tab after loading the extension? Then, in the console: `window.JevGuard.debug()`. `enabled: false` → turn the switch on in the popup (it restarts OFF at every Chrome start). `mainFound: false` → update `MAIN_SELECTOR` in `src/content/inject.js`: it is the container observers and row lookup are attached to, and if it does not match `rescan()` returns immediately, so touching `gmail-rows.js` is pointless. `mainFound: true` but `detectedRows: 0` → update `ROW_SELECTORS` / `SUBJECT_CELL_SELECTOR` in `src/content/gmail-rows.js`. `firstRow.senderAddress: ""` → only sender extraction broke. If `debug` does not exist, the content scripts never ran: check the errors in `chrome://extensions`. |
| **Pulsing grey bars that never stop** | Analysis in progress or a stuck queue: look at `pending` / `queued` in `debug()` and at the service worker console. |
| **Grey bars with `!`** | Hover over them: the tooltip gives the reason and ends with the code in square brackets (`Analisi non riuscita: … [AUTH]`). Codes: `NO_KEY`, `AUTH`, `RATE_LIMIT`, `BAD_REQUEST`, `NETWORK`, `TIMEOUT`, `DISABLED`, `UNKNOWN`. Once fixed, `window.JevGuard.rescan()`: it clears the errored verdicts and re-analyses (plain scrolling does not retry). |
| **401 / `AUTH`** | Key wrong, expired or pasted with whitespace. Popup → **Cambia** ("Change") → paste again → **Verifica** ("Verify"), which must list the models. |
| **429 / `RATE_LIMIT`** | The client already retried 3 times honouring `retry-after`. Wait a minute and `rescan()`. If it happens on just a few messages, a quota problem on the TypeSafe account is more likely than the 1,200 req/min limit. |
| **Bar in the wrong place / covered** | `BADGE_PLACEMENT = "append-cell"`, the constant at the top of `src/content/inject.js`, then reload the extension and the tab. |
| **Inconsistent numbers in the popup** | First check it is not normal: *Con verdetto* is relative to the open Gmail tab and goes down when Gmail recycles rows, while *Analisi riuscite* and *Token input* are session totals that only go up (§4). If they stay inconsistent: **Svuota cache** ("Clear cache") in the popup (`CLEAR_CACHE`), then reload Gmail. |

`window.JevGuard.debug()` also draws a dashed magenta border for 3 seconds around every row it
recognised: it is the quickest way to tell whether the problem is row detection or the analysis.

---

The original Italian version of this README is preserved in the first commit (`4b8b07c`).
