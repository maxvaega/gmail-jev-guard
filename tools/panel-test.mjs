/**
 * JevGuard — harness del pannello hover (src/content/inject.js).
 *
 * Il progetto non ha dipendenze: jsdom NON è una dipendenza dell'estensione, va
 * installato dove si vuole e passato con JSDOM_HOME. Esempio:
 *
 *   mkdir -p /tmp/jg-jsdom && cd /tmp/jg-jsdom && npm install jsdom
 *   cd ~/Developer/jev-gmail/gmail-jev-guard
 *   JSDOM_HOME=/tmp/jg-jsdom node tools/panel-test.mjs
 *
 * Carica il vero inject.js in jsdom con `chrome` finto, un NS.rows finto (così la
 * struttura HTML di Gmail è irrilevante) e un IntersectionObserver che dichiara
 * visibile ogni riga osservata; poi manda eventi di mouse veri e controlla che il
 * pannello si apra, mostri tutte e sei le domande e — soprattutto — sparisca
 * appena il puntatore lascia l'indicatore.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { scoreAnswers, QUESTION_META } from "../src/jev.js";

const require = createRequire(process.env.JSDOM_HOME ? process.env.JSDOM_HOME + "/" : import.meta.url);
let JSDOM;
try {
  JSDOM = require("jsdom").JSDOM;
} catch (error) {
  console.log("jsdom non trovato. Installalo altrove e passa JSDOM_HOME, vedi l'intestazione di questo file.");
  process.exit(0);
}

const SRC = new URL("../src/content/inject.js", import.meta.url);
const source = readFileSync(SRC, "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log("  ✓ " + name);
  else {
    failures += 1;
    console.log("  ✗ " + name + (detail ? " — " + detail : ""));
  }
}

const ANSWERS = {
  is_phishing: { noul: 0.87 },
  is_spam: { noul: 0.41 },
  sender_identity_mismatch: { noul: 0.92 },
  urgency_pressure: { noul: 0.75 },
  credential_or_payment_request: { noul: 0.88 },
  too_good_to_be_true: { noul: 0.05 }
};

function fullVerdict(id) {
  const scored = scoreAnswers(ANSWERS);
  return { id, ...scored, inputTokens: 612, model: "jev-1.13.0", ts: Date.now(), error: null };
}

function legacyVerdict(id) {
  const v = fullVerdict(id);
  delete v.questions; // a verdict cached by v0.1.0
  return v;
}

function errorResponse() {
  return { ok: false, error: { code: "NO_KEY", message: "chiave API mancante" } };
}

async function boot(mode) {
  const dom = new JSDOM(
    `<!doctype html><html><body><div role="main"><table><tbody>
      <tr class="row" id="thread-a"><td class="subj"><span>Oggetto A</span></td><td class="date">10:00</td></tr>
      <tr class="row" id="thread-b"><td class="subj"><span>Oggetto B</span></td><td class="date">09:12</td></tr>
     </tbody></table></div></body></html>`,
    { url: "https://mail.google.com/mail/u/0/#inbox", pretendToBeVisual: true, runScripts: "outside-only" }
  );
  const { window } = dom;
  const { document } = window;

  window.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; }
    observe(t) { setTimeout(() => this.cb([{ target: t, isIntersecting: true }], this), 0); }
    unobserve() {}
    disconnect() {}
  };

  window.chrome = {
    runtime: {
      id: "test-extension",
      lastError: null,
      sendMessage(message, cb) {
        setTimeout(() => {
          if (message.type === "GET_STATUS") cb({ ok: true, enabled: true });
          else if (message.type === "GET_CACHED") cb({ ok: true, verdicts: [] });
          else if (message.type === "ANALYZE") {
            if (mode === "error") cb(errorResponse());
            else cb({ ok: true, verdicts: message.items.map((it) => (mode === "legacy" ? legacyVerdict(it.id) : fullVerdict(it.id))) });
          } else cb({ ok: true });
        }, 0);
      }
    },
    storage: {
      session: { get: async () => ({ enabled: true }), onChanged: { addListener: () => {} } },
      local: { get: async () => ({}) }
    }
  };

  window.JevGuard = {
    rows: {
      listRows: () => Array.from(document.querySelectorAll("tr.row")),
      subjectCell: (row) => row.querySelector("td.subj"),
      extractRow: (row) => ({
        id: row.id, senderName: "Poste Italiane", senderAddress: "no-reply@poste-sicuro.tk",
        subject: row.textContent.trim(), snippet: "Gentile cliente…", hasAttachment: false, otherSendersCount: 0
      })
    }
  };

  window.eval(source);
  await sleep(1200); // rescan 300ms + flush 300ms + the stubbed round trips
  return dom;
}

const panelOf = (d) => d.window.document.querySelector(".jg-panel");
const isOpen = (d) => { const p = panelOf(d); return Boolean(p) && !p.hasAttribute("hidden"); };
const text = (d) => { const p = panelOf(d); return p ? p.textContent : ""; };

function fire(dom, target, type, relatedTarget) {
  const ev = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget: relatedTarget || null });
  target.dispatchEvent(ev);
}

/* ------------------------------------------------------------------ run 1 */
console.log("\n1. verdetto completo");
let dom = await boot("full");
let doc = dom.window.document;
let badges = doc.querySelectorAll(".jg-badge");
check("due badge dipinti", badges.length === 2, "trovati " + badges.length);
const badge = badges[0];
check("nessun attributo title sul badge", !badge.hasAttribute("title"));
check("aria-label col verdetto", (badge.getAttribute("aria-label") || "").includes("Rischio phishing 87%"), badge.getAttribute("aria-label"));
check("percentuale nel badge", badge.querySelector(".jg-pct").textContent === "87%");
check("pannello assente prima dell'hover", !isOpen(dom));

fire(dom, badge.querySelector(".jg-bar"), "mouseover");
await sleep(60);
check("non si apre prima del ritardo (90ms)", !isOpen(dom));
await sleep(120);
check("pannello aperto dopo l'hover", isOpen(dom));

const body = text(dom);
let missing = Object.values(QUESTION_META).map((m) => m.question).filter((q) => !body.includes(q));
check("tutte e 6 le domande presenti", missing.length === 0, "mancanti: " + missing.join(" | "));
check("le 6 risposte presenti", ["87%", "41%", "92%", "75%", "88%", "5%"].every((v) => body.includes(v)), body.replace(/\s+/g, " "));
check("intestazioni dei due gruppi", body.includes("Domande che determinano la percentuale") && body.includes("Segnali che spiegano il verdetto"));
check("riga spam/phishing", body.includes("spam 41%") && body.includes("phishing 87%"));
check("provenienza e token nel footer", body.includes("jev-1.13.0") && body.includes("612 token"));
check("pannello figlio di <body>", panelOf(dom).parentElement === doc.body);
check("pannello fuori dalla riga Gmail", !doc.querySelector("tr.row").contains(panelOf(dom)));
check("aria-hidden sul pannello", panelOf(dom).getAttribute("aria-hidden") === "true");
check("6 barre e 6 valori", panelOf(dom).querySelectorAll(".jg-panel-bar").length === 6 && panelOf(dom).querySelectorAll(".jg-panel-val").length === 6);
check("risposte >= 50% evidenziate", panelOf(dom).querySelectorAll(".jg-panel-val.jg-hi").length === 4);

// jsdom non fa layout (ogni rect è 0), quindi tutti gli altri controlli passano dal
// ramo di riserva: il posizionamento preferito — a sinistra del badge, centrato in
// verticale — si verifica solo con i due rect finti. vw/vh di jsdom: 1024x768.
badge.getBoundingClientRect = () => ({ left: 900, right: 954, top: 300, bottom: 318, width: 54, height: 18 });
panelOf(dom).getBoundingClientRect = () => ({ left: 0, right: 330, top: 0, bottom: 340, width: 330, height: 340 });
dom.window.JevGuard.showPanel("thread-a");
check(
  "posizionato a sinistra del badge e centrato in verticale",
  panelOf(dom).style.left === "562px" && panelOf(dom).style.top === "139px",
  panelOf(dom).style.left + " / " + panelOf(dom).style.top
);
delete panelOf(dom).getBoundingClientRect;
delete badge.getBoundingClientRect;

// bar -> percentage inside the same badge: the panel must stay
fire(dom, badge.querySelector(".jg-bar"), "mouseout", badge.querySelector(".jg-pct"));
fire(dom, badge.querySelector(".jg-pct"), "mouseover");
await sleep(200);
check("resta aperto passando dalla barra alla percentuale", isOpen(dom));

// crossing the 1px gap: mouseout toward the row, then back onto the badge
fire(dom, badge.querySelector(".jg-bar"), "mouseout", doc.querySelector("tr.row"));
await sleep(60);
fire(dom, badge.querySelector(".jg-pct"), "mouseover");
await sleep(200);
check("il rientro entro la grazia annulla la chiusura", isOpen(dom));

// badge -> badge: content swaps, no second delay
fire(dom, badge.querySelector(".jg-pct"), "mouseout", badges[1].querySelector(".jg-bar"));
fire(dom, badges[1].querySelector(".jg-bar"), "mouseover");
await sleep(10);
check("passando a un altro badge resta aperto subito", isOpen(dom));

// the real requirement: mouse off the indicator -> gone
fire(dom, badges[1].querySelector(".jg-bar"), "mouseout", doc.querySelector("tr.row"));
await sleep(250);
check("SPARISCE quando il mouse lascia l'indicatore", !isOpen(dom));
check("contenuto svuotato alla chiusura", text(dom) === "");

// dismissals
fire(dom, badge.querySelector(".jg-bar"), "mouseover");
await sleep(150);
check("riaperto", isOpen(dom));
doc.querySelector("table").dispatchEvent(new dom.window.Event("scroll", { bubbles: false }));
check("lo scroll lo chiude", !isOpen(dom));

fire(dom, badge.querySelector(".jg-bar"), "mouseover");
await sleep(150);
doc.querySelector("tr.row").dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
check("il click lo chiude", !isOpen(dom));

fire(dom, badge.querySelector(".jg-bar"), "mouseover");
await sleep(150);
doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
check("un tasto lo chiude", !isOpen(dom));

fire(dom, badge.querySelector(".jg-bar"), "mouseover");
await sleep(150);
doc.querySelector("tr.row").remove();
dom.window.JevGuard.rescan();
await sleep(400);
check("la riga rimossa lo chiude", !isOpen(dom));

check("showPanel() apre senza mouse", dom.window.JevGuard.showPanel() !== null && isOpen(dom));
check("hidePanel() chiude", dom.window.JevGuard.hidePanel() && !isOpen(dom));
check("debug() riporta lo stato del pannello", dom.window.JevGuard.debug().panelOpen === false);
dom.window.close();

/* ------------------------------------------------------------------ run 2 */
console.log("\n2. errore (NO_KEY)");
dom = await boot("error");
doc = dom.window.document;
const errBadge = doc.querySelector(".jg-badge");
check("badge in errore", Boolean(errBadge) && errBadge.classList.contains("jg-error"));
fire(dom, errBadge.querySelector(".jg-bar"), "mouseover");
await sleep(150);
check("pannello di errore aperto", isOpen(dom));
check("codice errore visibile", text(dom).includes("[NO_KEY]"), text(dom));
check("messaggio e rimedio", text(dom).includes("chiave API mancante") && text(dom).includes("popup di JevGuard"));
fire(dom, errBadge.querySelector(".jg-bar"), "mouseout", doc.querySelector("tr.row"));
await sleep(250);
check("sparisce anche in errore", !isOpen(dom));
dom.window.close();

/* ------------------------------------------------------------------ run 3 */
console.log("\n3. verdetto vecchio senza `questions` (fallback)");
dom = await boot("legacy");
doc = dom.window.document;
const oldBadge = doc.querySelector(".jg-badge");
fire(dom, oldBadge.querySelector(".jg-bar"), "mouseover");
await sleep(150);
check("pannello aperto", isOpen(dom));
check("6 righe ricostruite", panelOf(dom).querySelectorAll(".jg-panel-bar").length === 6, String(panelOf(dom).querySelectorAll(".jg-panel-bar").length));
check("etichette brevi dei segnali", text(dom).includes("mittente non coerente col dominio"));
check("nessun n/d", !text(dom).includes("n/d"), text(dom));
dom.window.close();

console.log("\n" + (failures === 0 ? "TUTTI I CONTROLLI PASSATI" : failures + " CONTROLLI FALLITI"));
process.exit(failures === 0 ? 0 : 1);
