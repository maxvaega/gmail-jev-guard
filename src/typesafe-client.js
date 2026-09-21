/**
 * Minimal TypeSafe HTTP client — dependency-free ESM, usable both from the MV3
 * service worker and from plain Node 20 (tools/contract-test.mjs).
 *
 * API: POST https://api.typesafe.ai/v1/systemone   Authorization: Bearer <key>
 *      body  { state, model, questions }  ->  { model, answers, usage }
 *      401 auth · 422 validation · 429 rate limit · 529 overloaded (retry with backoff)
 */

export const API_BASE = "https://api.typesafe.ai/v1";

export class TypeSafeError extends Error {
  constructor(code, message, { status = 0, retryable = false, cause = null } = {}) {
    super(message);
    this.name = "TypeSafeError";
    this.code = code;          // NO_KEY | AUTH | BAD_REQUEST | RATE_LIMIT | NETWORK | TIMEOUT | UNKNOWN
    this.status = status;
    this.retryable = retryable;
    this.cause = cause;
  }
}

const ITALIAN = {
  NO_KEY: "chiave API TypeSafe mancante",
  AUTH: "chiave API non valida (401)",
  BAD_REQUEST: "richiesta rifiutata da TypeSafe (422)",
  RATE_LIMIT: "limite di richieste raggiunto, riprova tra poco",
  NETWORK: "rete non raggiungibile",
  TIMEOUT: "timeout della richiesta",
  UNKNOWN: "errore inatteso"
};

export function italianMessage(code) {
  return ITALIAN[code] || ITALIAN.UNKNOWN;
}

function classify(status) {
  if (status === 401 || status === 403) return { code: "AUTH", retryable: false };
  if (status === 422) return { code: "BAD_REQUEST", retryable: false };
  if (status === 429 || status === 529) return { code: "RATE_LIMIT", retryable: true };
  if (status >= 500) return { code: "UNKNOWN", retryable: true };
  return { code: "UNKNOWN", retryable: false };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff honouring `retry-after` when the server sends one. */
function backoffMs(attempt, retryAfterHeader) {
  const retryAfter = Number.parseFloat(retryAfterHeader || "");
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 20000);
  return Math.min(500 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
}

async function request(path, { apiKey, body, method = "POST", timeoutMs = 20000, maxRetries = 3, fetchImpl }) {
  if (!apiKey) throw new TypeSafeError("NO_KEY", ITALIAN.NO_KEY);
  const doFetch = fetchImpl || globalThis.fetch;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });

      if (response.ok) return await response.json();

      const { code, retryable } = classify(response.status);
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      lastError = new TypeSafeError(code, `${ITALIAN[code]}${detail ? ` — ${detail}` : ""}`, {
        status: response.status,
        retryable
      });
      if (!retryable || attempt === maxRetries) throw lastError;
      await wait(backoffMs(attempt, response.headers.get("retry-after")));
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof TypeSafeError) {
        if (!error.retryable || attempt === maxRetries) throw error;
        lastError = error;
        continue;
      }
      const aborted = error && (error.name === "AbortError" || error.name === "TimeoutError");
      const code = aborted ? "TIMEOUT" : "NETWORK";
      lastError = new TypeSafeError(code, ITALIAN[code], { retryable: true, cause: error });
      if (attempt === maxRetries) throw lastError;
      await wait(backoffMs(attempt, null));
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new TypeSafeError("UNKNOWN", ITALIAN.UNKNOWN);
}

/** One evaluation: every question is scored against the same state, in parallel. */
export async function systemOne({ apiKey, state, questions, model = "jev-latest", timeoutMs, maxRetries, fetchImpl }) {
  const data = await request("/systemone", {
    apiKey,
    body: { state, model, questions },
    timeoutMs,
    maxRetries,
    fetchImpl
  });
  if (!data || typeof data !== "object" || !data.answers) {
    throw new TypeSafeError("UNKNOWN", "risposta TypeSafe non valida");
  }
  return data;
}

/**
 * Tolerant reader for the `usage` object: the contract pins `{ model, answers, usage }`
 * but not the spelling inside `usage`. One shared reader so the extension and the
 * calibration tool can never disagree on the token count.
 */
export function inputTokensOf(usage) {
  if (!usage || typeof usage !== "object") return null;
  const candidates = [
    usage.input_tokens,
    usage.inputTokens,
    usage.prompt_tokens,
    usage.promptTokens,
    usage.tokens && usage.tokens.input
  ];
  const value = candidates.find((candidate) => Number.isFinite(candidate));
  return Number.isFinite(value) ? value : null;
}

/** Cheap key check used by the popup: GET /v1/models costs nothing. */
export async function listModels({ apiKey, timeoutMs = 10000, fetchImpl }) {
  const data = await request("/models", { apiKey, method: "GET", body: null, timeoutMs, maxRetries: 1, fetchImpl });
  const models = Array.isArray(data) ? data : data && Array.isArray(data.models) ? data.models : [];
  return models.map((entry) => (typeof entry === "string" ? entry : entry && entry.name)).filter(Boolean);
}
