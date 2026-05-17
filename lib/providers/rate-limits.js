// Static tier-1 TPM/RPM limits, used by the adaptive scheduler and the init
// wizard ETA hints. Tier-1 = entry-level paid tier — what most CLI users have.
//
// SNAPSHOT as of 2026-01. Source URLs:
//   OpenAI:     https://platform.openai.com/docs/guides/rate-limits
//   Anthropic:  https://docs.anthropic.com/en/api/rate-limits
//   Gemini:     https://ai.google.dev/gemini-api/docs/rate-limits
//   Perplexity: https://docs.perplexity.ai/docs/rate-limits
//
// Numbers drift — re-check yearly or on user reports. We only use this as a
// FALLBACK: the tpm-ledger learns the real limit from 429 bodies and successful
// 200 response headers, then `getLearnedOrTierLimit` prefers learned values.

/** @type {Record<string, Record<string, {tpm: number|null, rpm: number}>>} */
export const TIER_1_LIMITS = {
  openai: {
    // Search-capable variants share the strict 6k TPM cap on tier 1.
    'gpt-5-search-api':  { tpm: 6_000,   rpm: 500 },
    'gpt-5-mini':        { tpm: 200_000, rpm: 500 },  // before 'gpt-5' (longest-prefix)
    'gpt-5-nano':        { tpm: 200_000, rpm: 500 },
    'gpt-5':             { tpm: 90_000,  rpm: 500 },
    'gpt-4o-mini-search':{ tpm: 6_000,   rpm: 500 },
    'gpt-4o-search':     { tpm: 6_000,   rpm: 500 },
    'gpt-4o-mini':       { tpm: 200_000, rpm: 500 },
    'gpt-4o':            { tpm: 150_000, rpm: 500 },
  },
  anthropic: {
    'claude-opus':       { tpm: 20_000,  rpm: 50 },
    'claude-sonnet':     { tpm: 30_000,  rpm: 50 },
    'claude-haiku':      { tpm: 50_000,  rpm: 50 },
  },
  gemini: {
    // Tier-1 paid (free tier is stricter — we assume paid).
    'gemini-3.1-pro':        { tpm: 1_000_000, rpm: 1_000 },
    'gemini-3.1-flash-lite': { tpm: 4_000_000, rpm: 4_000 },
    'gemini-3.1-flash':      { tpm: 4_000_000, rpm: 2_000 },
    'gemini-2.5-pro':        { tpm: 2_000_000, rpm: 1_000 },
    'gemini-2.5-flash':      { tpm: 4_000_000, rpm: 2_000 },
  },
  perplexity: {
    // Perplexity doesn't publish explicit TPM — only RPM. tpm: null signals
    // "use semaphore-based RPM throttling only, no scheduler pacing needed."
    'sonar-reasoning-pro': { tpm: null, rpm: 50 },
    'sonar-pro':           { tpm: null, rpm: 50 },
    'sonar':               { tpm: null, rpm: 50 },
  },
};

/**
 * Find the longest-prefix family name in TIER_1_LIMITS that matches modelId.
 * Returns null if no family matches.
 *
 * Example: matchModelFamily('openai', 'gpt-5-search-api-2025-01-01')
 *   → 'gpt-5-search-api' (longest prefix that startsWith() matches)
 *
 * @param {string} provider
 * @param {string} modelId
 * @returns {string|null}
 */
export function matchModelFamily(provider, modelId) {
  const fams = Object.keys(TIER_1_LIMITS[provider] || {});
  if (fams.length === 0 || !modelId) return null;
  const matching = fams.filter(f => modelId.startsWith(f));
  if (matching.length === 0) return null;
  matching.sort((a, b) => b.length - a.length);
  return matching[0];
}

/**
 * Get tier-1 limits for a (provider, model) pair, or null if unknown.
 *
 * @param {string} provider
 * @param {string} modelId
 * @returns {{tpm: number|null, rpm: number}|null}
 */
export function getTier1Limit(provider, modelId) {
  const fam = matchModelFamily(provider, modelId);
  return fam ? TIER_1_LIMITS[provider][fam] : null;
}
