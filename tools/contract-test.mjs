#!/usr/bin/env node
/**
 * JevGuard — calibration harness against the real TypeSafe API.
 *
 * Runs tools/fixtures.json through the very same modules the extension uses
 * (src/jev.js + src/typesafe-client.js), so what it measures is what Chrome will
 * do: same state, same six Nouls, same scoring, same error handling.
 *
 * Usage (from anywhere, paths resolve from this file):
 *   TYPESAFE_API_KEY=... node tools/contract-test.mjs
 *   node tools/contract-test.mjs --dry                 # print the request body, no network
 *   node tools/contract-test.mjs --limit 4
 *   node tools/contract-test.mjs --only poste
 *
 * This is a tuning tool, not a gate: it exits 0 even when fixtures FAIL.
 * User-visible output is Italian, as everywhere else in the project.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildState, QUESTIONS, JEV_MODEL, scoreAnswers } from "../src/jev.js";
import { inputTokensOf, systemOne } from "../src/typesafe-client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = join(HERE, "fixtures.json");

const COST_PER_MILLION_INPUT_TOKENS = 0.042;
const CONCURRENCY = 4;
/** Any non-empty value: systemOne throws NO_KEY locally on a falsy key and would
 *  never reach the server, so this is what makes the real 401 path observable. */
const PLACEHOLDER_KEY = "chiave-non-configurata";

/* ------------------------------------------------------------- arguments --- */

function parseArgs(argv) {
  const options = { limit: Infinity, only: "", dry: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry") {
      options.dry = true;
    } else if (arg === "--limit") {
      const value = Number.parseInt(argv[i + 1], 10);
      if (!Number.isFinite(value) || value < 1) {
        console.error("Errore: --limit richiede un intero maggiore di 0.");
        process.exit(2);
      }
      options.limit = value;
      i += 1;
    } else if (arg.startsWith("--limit=")) {
      const value = Number.parseInt(arg.slice("--limit=".length), 10);
      if (!Number.isFinite(value) || value < 1) {
        console.error("Errore: --limit richiede un intero maggiore di 0.");
        process.exit(2);
      }
      options.limit = value;
    } else if (arg === "--only") {
      options.only = String(argv[i + 1] || "").toLowerCase();
      i += 1;
    } else if (arg.startsWith("--only=")) {
      options.only = arg.slice("--only=".length).toLowerCase();
    } else {
      console.error(`Errore: opzione sconosciuta "${arg}".`);
      console.error("Opzioni: --limit N | --only <testo> | --dry");
      process.exit(2);
    }
  }
  return options;
}

/* --------------------------------------------------------------- helpers --- */

function loadFixtures() {
  const raw = readFileSync(FIXTURES_PATH, "utf8");
  const fixtures = JSON.parse(raw);
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    throw new Error("fixtures.json non contiene un array di campioni");
  }
  return fixtures;
}

const pct = (value) => (Number.isFinite(value) ? `${Math.round(value * 100)}%` : "—");
const pad = (text, width) => String(text).padEnd(width).slice(0, width);
const padStart = (text, width) => String(text).padStart(width);

/** PASS when the produced kind matches the expectation ('ok' means risk < 0.5). */
function isPass(fixture, score) {
  return score.kind === fixture.expect;
}

/**
 * How far the probability that *should* have decided the row is from where it
 * belongs. Ranking on `risk` alone would hide a spam fixture called phishing at
 * 91% (the is_phishing over-fire), which is precisely what needs re-tuning.
 */
function errorMagnitude(fixture, score) {
  if (fixture.expect === "ok") return score.risk;
  const expected = fixture.expect === "spam" ? score.spam : score.phishing;
  return 1 - (Number.isFinite(expected) ? expected : 0);
}

/** Worst first: every FAIL before any PASS, then by distance. */
function compareByBadness(a, b) {
  const aFail = isPass(a.fixture, a.score) ? 0 : 1;
  const bFail = isPass(b.fixture, b.score) ? 0 : 1;
  if (aFail !== bFail) return bFail - aFail;
  return errorMagnitude(b.fixture, b.score) - errorMagnitude(a.fixture, a.score);
}

/* ----------------------------------------------------------------- table --- */

const COLUMNS = [
  ["campione", 24],
  ["atteso", 9],
  ["rischio", 8],
  ["tipo", 9],
  ["phishing", 9],
  ["spam", 7],
  ["token", 7],
  ["esito", 6]
];

function printHeader() {
  console.log(COLUMNS.map(([label, width]) => pad(label, width)).join(" "));
  console.log(COLUMNS.map(([, width]) => "-".repeat(width)).join(" "));
}

function printRow(entry) {
  const { fixture, score, tokens, failure } = entry;
  if (failure) {
    console.log(
      [
        pad(fixture.name, 24),
        pad(fixture.expect, 9),
        padStart("—", 8),
        pad(failure.code, 9),
        padStart("—", 9),
        padStart("—", 7),
        padStart("—", 7),
        pad("ERR", 6)
      ].join(" ")
    );
    console.log(`${" ".repeat(25)}↳ ${failure.message}`);
    return;
  }
  console.log(
    [
      pad(fixture.name, 24),
      pad(fixture.expect, 9),
      padStart(pct(score.risk), 8),
      pad(score.kind, 9),
      padStart(pct(score.phishing), 9),
      padStart(pct(score.spam), 7),
      padStart(tokens === null ? "?" : tokens, 7),
      pad(isPass(fixture, score) ? "PASS" : "FAIL", 6)
    ].join(" ")
  );
}

/* ------------------------------------------------------------------ main --- */

async function runPool(fixtures, apiKey, onDone) {
  const results = new Array(fixtures.length).fill(null);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= fixtures.length) return;
      const fixture = fixtures[index];
      const entry = { fixture, score: null, tokens: null, failure: null, usage: null };
      try {
        const data = await systemOne({
          apiKey,
          state: buildState(fixture.row),
          questions: QUESTIONS,
          model: JEV_MODEL
        });
        entry.score = scoreAnswers(data.answers);
        entry.usage = data.usage;
        entry.tokens = inputTokensOf(data.usage);
      } catch (error) {
        entry.failure = {
          code: error && error.code ? error.code : "UNKNOWN",
          message: error && error.message ? String(error.message).slice(0, 200) : "errore sconosciuto"
        };
      }
      results[index] = entry;
      onDone(results);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, fixtures.length) }, worker));
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  let fixtures;
  try {
    fixtures = loadFixtures();
  } catch (error) {
    console.error(`Impossibile leggere ${FIXTURES_PATH}: ${error.message}`);
    process.exit(1);
  }

  let selected = fixtures;
  if (options.only) {
    selected = selected.filter((fixture) => String(fixture.name).toLowerCase().includes(options.only));
    if (selected.length === 0) {
      console.error(`Nessun campione corrisponde a "${options.only}".`);
      process.exit(1);
    }
  }
  if (Number.isFinite(options.limit)) selected = selected.slice(0, options.limit);

  if (options.dry) {
    const body = { state: buildState(selected[0].row), model: JEV_MODEL, questions: QUESTIONS };
    // Notice on stderr, body on stdout: `--dry | jq .` stays usable.
    console.error(`Corpo esatto della prima richiesta (campione: ${selected[0].name}), nessuna chiamata di rete:`);
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  let apiKey = process.env.TYPESAFE_API_KEY || "";
  if (!apiKey) {
    console.log("");
    console.log("⚠  TYPESAFE_API_KEY non impostata.");
    console.log("   Eseguo comunque UNA richiesta reale con una chiave fittizia,");
    console.log("   così vedi esattamente l'errore 401 che l'estensione mostrerebbe.");
    console.log("   Per la calibrazione vera: TYPESAFE_API_KEY=... node tools/contract-test.mjs");
    console.log("");
    apiKey = PLACEHOLDER_KEY;
    selected = selected.slice(0, 1);
  }

  console.log(`Modello: ${JEV_MODEL} · campioni: ${selected.length} · concorrenza: ${CONCURRENCY}`);
  console.log("");
  printHeader();

  // Print in fixture order as soon as each prefix is complete: the table stays
  // aligned and readable while the requests are still in flight.
  let cursor = 0;
  const flush = (results) => {
    while (cursor < results.length && results[cursor]) {
      printRow(results[cursor]);
      cursor += 1;
    }
  };

  const results = await runPool(selected, apiKey, flush);
  flush(results);

  const scored = results.filter((entry) => entry && entry.score);
  const failed = results.filter((entry) => entry && entry.failure);
  const passes = scored.filter((entry) => isPass(entry.fixture, entry.score)).length;
  const totalTokens = scored.reduce((sum, entry) => sum + (entry.tokens || 0), 0);
  const unknownTokens = scored.some((entry) => entry.tokens === null);

  console.log("");
  console.log(`Accuratezza: ${passes}/${scored.length} campioni valutati` + (failed.length ? ` (${failed.length} in errore)` : ""));
  console.log(`Token di input totali: ${totalTokens}${unknownTokens ? " (alcune risposte non riportano l'uso)" : ""}`);
  console.log(
    `Costo misurato: $${((totalTokens / 1e6) * COST_PER_MILLION_INPUT_TOKENS).toFixed(6)} ` +
      `a $${COST_PER_MILLION_INPUT_TOKENS} per 1M token di input`
  );
  if (scored.length > 0) {
    const perEmail = (totalTokens / scored.length / 1e6) * COST_PER_MILLION_INPUT_TOKENS;
    console.log(`Costo per email: $${perEmail.toFixed(6)} (media su ${scored.length})`);
  }
  if (unknownTokens) {
    const sample = scored.find((entry) => entry.tokens === null);
    console.log(`Campo usage non riconosciuto, valore grezzo: ${JSON.stringify(sample.usage)}`);
  }

  const worst = scored.slice().sort(compareByBadness).slice(0, 3);

  if (worst.length > 0) {
    console.log("");
    console.log("Tre scostamenti peggiori (per ritarare le domande in src/jev.js):");
    for (const entry of worst) {
      const { fixture, score } = entry;
      const verdict = isPass(fixture, score) ? "PASS" : "FAIL";
      console.log(
        `  • ${fixture.name} — atteso ${fixture.expect}, ottenuto ${score.kind} ` +
          `(rischio ${pct(score.risk)}, scostamento ${pct(errorMagnitude(fixture, score))}) [${verdict}]`
      );
      console.log(`      is_phishing ${pct(score.phishing)} · is_spam ${pct(score.spam)}`);
      for (const signal of score.signals) {
        console.log(`      ${pad(signal.label, 36)} ${padStart(pct(signal.value), 5)}`);
      }
      console.log(`      oggetto: ${fixture.row.subject}`);
    }
  }

  if (failed.length > 0) {
    console.log("");
    console.log(`Campioni non valutati: ${failed.map((entry) => `${entry.fixture.name} (${entry.failure.code})`).join(", ")}`);
  }
  console.log("");
}

main().catch((error) => {
  console.error(`Errore imprevisto: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
