// Static map of "options to inject when calling a provider's MAIN model".
//
// Why a separate file (not inline in bin/aeo-tracker.js): bin has no unit
// tests (only smoke). Drift here is silent — if someone edits bin and sneaks
// out `reasoning_effort: 'high'`, juser pays for mid-tier model without the
// quality bonus. With this file + test/main-options.test.js, deepStrictEqual
// catches the drift.
//
// Semantics per provider:
//   - openai:    `reasoning_effort: 'high'` — GPT-5+ reasoning model trigger.
//                Gate in openai.js drops it on non-reasoning models silently.
//   - anthropic: `thinking: { type: 'enabled', budget_tokens: 16k }` — Claude 4.x+
//                extended thinking. Gate in anthropic.js drops on legacy gen.
//                max_tokens auto-bumped in anthropic.js to budget+2048.
//   - gemini:    {} — thinkingLevel: 'high' is already injected automatically by
//                gemini.js for any `^gemini-3` model via regex. No extra options.
//   - perplexity: {} — reasoning is built-in for `sonar-reasoning*` family;
//                 no request-time flag.
//
// Caller (bin/aeo-tracker.js makeResearchProvider) merges this into `mainCall`
// options. `classifyCall` doesn't merge — classify hot path stays cheap.

export const MAIN_OPTIONS_BY_PROVIDER = {
  openai:     { reasoning_effort: 'high' },
  anthropic:  { thinking: { type: 'enabled', budget_tokens: 16000 } },
  gemini:     {},
  perplexity: {},
};

/**
 * Single source of truth for "is thinking/reasoning active for this (provider,
 * model) pair?". Used by ETA estimation in cost-estimate.js — same logic must
 * apply to runtime loop AND any future init UI / preview hint to avoid number
 * drift between estimates and actuals.
 *
 * thinking is active when ANY of:
 *   - MAIN_OPTIONS_BY_PROVIDER[provider] has a thinking-related key
 *     (reasoning_effort, thinking — both indicate active reasoning).
 *   - model is `^gemini-3` (gemini.js auto-injects thinkingLevel=high regardless
 *     of mainOptions, so caller can't opt out).
 *   - model is `sonar-reasoning*` (Perplexity reasoning is built-in to model).
 *
 * @param {string} provider  'openai' | 'anthropic' | 'gemini' | 'perplexity'
 * @param {string} model     model id
 * @returns {boolean}
 */
export function detectThinkingActive(provider, model) {
  if (!provider || !model) return false;
  const opts = MAIN_OPTIONS_BY_PROVIDER[provider];
  if (opts && Object.keys(opts).length > 0) return true;
  if (/^gemini-3/i.test(model)) return true;
  if (/sonar-reasoning/i.test(model)) return true;
  return false;
}
