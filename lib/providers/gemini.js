import { withRetry, withProviderCall, parseRetryAfter, maybeSetCooldown } from './_retry.js';
import { classifyProviderError } from './classify-error.js';
import { learnTpmLimit, parseTpmLimitHeader } from './tpm-ledger.js';
import { extractUsage } from './pricing.js';
import { fetchWithTimeout } from '../util/fetch-with-timeout.js';

/**
 * Call Google Gemini generateContent API.
 *
 * @param {object} [options]
 * @param {boolean} [options.webSearch=true]
 *   When true, attaches `google_search` grounding tool.
 *   When false, omits the tool — use for analysis tasks (e.g. init auto-suggest).
 */
export async function callGemini(query, apiKey, model, options = {}) {
  const webSearch = options.webSearch !== false;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = { contents: [{ parts: [{ text: query }] }] };
  // thinkingLevel='high' is a Gemini 3.x feature. 2.x models reject the
  // field outright ("Thinking level is not supported for this model"), so
  // gate by model name. Classify models still pin gemini-2.5-flash for
  // cost in some flows — they MUST not get this field.
  if (/^gemini-3/.test(model)) {
    body.generationConfig = { thinkingConfig: { thinkingLevel: 'high' } };
  }
  // Caller-controlled temperature — used by the init-time model classifier
  // to ask for deterministic output (temperature=0) so repeated `init --force`
  // runs don't shuffle the picker order. Optional; absent => provider default.
  if (typeof options.temperature === 'number') {
    body.generationConfig = body.generationConfig || {};
    body.generationConfig.temperature = options.temperature;
  }
  if (webSearch) body.tools = [{ google_search: {} }];

  // cdKey per-(provider, model) — TPM scoping. sem stays per-provider.
  const cdKey = `gemini:${model}`;
  const onStatus = options.onStatus;
  return withRetry('Gemini', () => withProviderCall({ sem: 'gemini', cd: cdKey, onStatus }, async () => {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // Optional caller-supplied AbortSignal. fetchWithTimeout composes it
      // with its own AbortSignal.timeout (whichever aborts first wins), so
      // both caller-cancellation and the runtime timeout work together.
      signal: options.signal,
    }, { kind: 'runtime' });
    // Branch (a): HTTP failure path.
    if (!res.ok) {
      const headerMs = parseRetryAfter(res);
      const json = await res.json().catch(() => ({}));
      const err = new Error(`Gemini: ${json?.error?.message || res.statusText || `HTTP ${res.status}`}`);
      // Stash HTTP status + body on the error so upstream callers (e.g. bootstrap
      // classifier) can surface the real cause instead of a generic message.
      // The withRetry/withProviderCall pipeline forwards these unchanged.
      err.status = res.status;
      err.body = json;
      if (headerMs > 0) err.retryAfterMs = headerMs;
      const parsed = classifyProviderError(err);
      if (parsed.rateLimit?.kind === 'tpm' && parsed.rateLimit.limit != null) {
        learnTpmLimit(cdKey, parsed.rateLimit.limit, 'observed');
      }
      maybeSetCooldown(err, cdKey, headerMs);
      throw err;
    }

    // Successful 200: header-based limit learning (Gemini doesn't currently
    // expose TPM headers but parseTpmLimitHeader returns null gracefully).
    const headerLimit = parseTpmLimitHeader(res.headers, 'gemini');
    if (headerLimit != null) learnTpmLimit(cdKey, headerLimit, 'header');

    const json = await res.json();
    // Branch (b): 200 with error payload.
    if (json.error) {
      const err = new Error(`Gemini: ${json.error.message}`);
      err.status = 200;  // HTTP succeeded but body has error — distinguish from network/HTTP failure
      err.body = json;
      maybeSetCooldown(err, cdKey, 0);
      throw err;
    }

    const text = (json.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('\n');
    const citations = (json.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
      .map(ch => resolveGeminiCitation(ch.web))
      .filter(Boolean);
    // Token log fallback — see openai.js for rationale.
    if (!onStatus && process.env.AEO_LOG_TOKENS === '1') {
      const u = extractUsage('gemini', json);
      process.stderr.write(`  [tokens] ${cdKey}: input=${u.inputTokens} output=${u.outputTokens} total=${(u.inputTokens || 0) + (u.outputTokens || 0)}\n`);
    }
    return { text, citations, raw: json };
  }));
}

// Gemini's groundingChunks[*].web.uri is a Vertex AI redirect token, not a resolvable URL.
// The `title` field contains the real domain (e.g. "example.com"). Fall back to that when the uri is a redirect.
function resolveGeminiCitation(web) {
  if (!web) return null;
  const uri = web.uri;
  const title = web.title;
  if (!uri) return null;
  const isVertexRedirect = /^https?:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//.test(uri);
  if (isVertexRedirect) {
    if (title && /^[\w-]+(?:\.[\w-]+)+(?:\/|$)/.test(title)) {
      return title.startsWith('http') ? title : `https://${title}`;
    }
    return null; // drop unreadable redirect if title is unusable
  }
  return uri;
}
