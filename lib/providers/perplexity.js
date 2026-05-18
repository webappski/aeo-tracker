import { withRetry, withProviderCall, parseRetryAfter, maybeSetCooldown } from './_retry.js';
import { classifyProviderError } from './classify-error.js';
import { learnTpmLimit, parseTpmLimitHeader } from './tpm-ledger.js';
import { extractUsage } from './pricing.js';
import { fetchWithTimeout } from '../util/fetch-with-timeout.js';

export async function callPerplexity(query, apiKey, model, options = {}) {
  // cdKey per-(provider, model) — TPM scoping. sem stays per-provider.
  const cdKey = `perplexity:${model}`;
  const onStatus = options.onStatus;
  return withRetry('Perplexity', () => withProviderCall({ sem: 'perplexity', cd: cdKey, onStatus }, async () => {
    const res = await fetchWithTimeout('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: query }],
      }),
    }, { kind: 'runtime' });
    // Branch (a): HTTP failure path.
    if (!res.ok) {
      const headerMs = parseRetryAfter(res);
      const json = await res.json().catch(() => ({}));
      const err = new Error(`Perplexity: ${json?.error?.message || json?.error || res.statusText || `HTTP ${res.status}`}`);
      if (headerMs > 0) err.retryAfterMs = headerMs;
      const parsed = classifyProviderError(err);
      if (parsed.rateLimit?.kind === 'tpm' && parsed.rateLimit.limit != null) {
        learnTpmLimit(cdKey, parsed.rateLimit.limit, 'observed');
      }
      maybeSetCooldown(err, cdKey, headerMs);
      throw err;
    }

    // Successful 200: header-based limit learning (Perplexity doesn't currently
    // document TPM headers — parseTpmLimitHeader returns null).
    const headerLimit = parseTpmLimitHeader(res.headers, 'perplexity');
    if (headerLimit != null) learnTpmLimit(cdKey, headerLimit, 'header');

    const json = await res.json();
    // Branch (b): 200 with error payload.
    if (json.error) {
      const err = new Error(`Perplexity: ${json.error.message || json.error}`);
      maybeSetCooldown(err, cdKey, 0);
      throw err;
    }
    const text = json.choices?.[0]?.message?.content || '';
    // Sonar returns citations as a top-level array of URLs
    const citations = Array.isArray(json.citations) ? json.citations : [];
    // Token log fallback — see openai.js for rationale.
    if (!onStatus && process.env.AEO_LOG_TOKENS === '1') {
      const u = extractUsage('perplexity', json);
      process.stderr.write(`  [tokens] ${cdKey}: input=${u.inputTokens} output=${u.outputTokens} total=${(u.inputTokens || 0) + (u.outputTokens || 0)}\n`);
    }
    return { text, citations, raw: json };
  }));
}
