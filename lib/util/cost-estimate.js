// Pre-flight ETA + UX hints for rate-limit-aware command planning.
//
// Philosophy (per Alex's direction): we never tell the user "this will fail".
// We say "this will take ~N seconds" — because the adaptive scheduler (Fix 9
// in scheduler.js) guarantees the run COMPLETES regardless of TPM headroom.
// Low-TPM picks just pace across more 60s windows; high-TPM picks fire all
// at once. The hint communicates honest ETA so users can choose informedly.

import { getTier1Limit } from '../providers/rate-limits.js';

// Per-command rough token estimate per provider. Conservative (rounded up).
// Calibrate via AEO_LOG_TOKENS=1 if real numbers drift more than ~30%.
//   - `init-auto`: one LLM call (HTML excerpt → structured JSON suggestions)
//   - `init-auto-strict`: + cross-check 3 queries × 2 validators
//   - `run`: 3 queries × ~2500 tokens (web-search capable)
//   - `run-strict`: same as run (validation usually cache-hits)
//   - `run-depth-full`: web pass + training pass per cell, ~2× run cost
export const COMMAND_TPM_ESTIMATES = {
  'init-auto':        { perProvider: 3500,  description: 'init --auto: fetch site + LLM suggest queries' },
  'init-auto-strict': { perProvider: 9500,  description: 'init --auto --strict-validation: + cross-check 3 queries' },
  'run':              { perProvider: 7500,  description: 'run: 3 web-search queries' },
  'run-strict':       { perProvider: 7500,  description: 'run --strict-validation: same TPM if validation cache hit' },
  'run-depth-full':   { perProvider: 15000, description: 'run --depth=full: web + training passes' },
};

const TYPICAL_CALL_SECONDS = 5;  // Time for a single LLM call to round-trip

/**
 * How long the command will likely take given the model's TPM constraint.
 *
 *   - `fast`:    estimate fits in the 60s window with budget room. All tasks
 *                fire in parallel; semaphore caps real concurrency. ~5s total.
 *   - `paced`:   estimate exceeds one window. Scheduler packs tasks into
 *                ceil(est/budget) windows; wall-clock = (N-1) inter-window
 *                gaps × 60s + final-window call time.
 *   - `unknown`: model not in TIER_1_LIMITS table or command unknown. Caller
 *                degrades gracefully (skips ETA hint, scheduler fires all
 *                immediately, ledger throttles reactively).
 *
 * @param {string} provider
 * @param {string} modelId
 * @param {string} commandKey  one of COMMAND_TPM_ESTIMATES keys
 * @param {object} [opts]
 * @param {boolean} [opts.thinkingActive=false]
 *   When true, output portion of estimate is multiplied by THINKING_OUTPUT_MULTIPLIER
 *   (extended thinking/reasoning_effort=high adds ~5× output tokens). Honest ETA
 *   for thinking-enabled main calls. Default false for backward compat.
 * @returns {{mode: 'fast'|'paced'|'unknown', etaSeconds?: number, limit?: object, est?: object, windowsNeeded?: number}}
 */
const THINKING_OUTPUT_MULTIPLIER = 5;
const OUTPUT_PORTION_OF_RUN = 0.6;  // ~60% of run.perProvider is output tokens

export function estimateRunDuration(provider, modelId, commandKey, opts = {}) {
  const limit = getTier1Limit(provider, modelId);
  const est = COMMAND_TPM_ESTIMATES[commandKey];
  if (!limit?.tpm || !est) return { mode: 'unknown' };
  const budget = limit.tpm * 0.9;  // 10% headroom for provider accounting jitter
  // Apply thinking multiplier: scale output portion when reasoning/thinking is on.
  // perProvider = input_portion + output_portion. Thinking only inflates output.
  const perProvider = opts?.thinkingActive
    ? est.perProvider + est.perProvider * OUTPUT_PORTION_OF_RUN * (THINKING_OUTPUT_MULTIPLIER - 1)
    : est.perProvider;
  if (perProvider <= budget) {
    return { mode: 'fast', etaSeconds: TYPICAL_CALL_SECONDS, limit, est };
  }
  // N windows means (N-1) inter-window 60s gaps + the final window's call time.
  // NOT N × 60s — that was an off-by-one bug caught by audit round 5.
  const windowsNeeded = Math.ceil(perProvider / budget);
  const etaSeconds = (windowsNeeded - 1) * 60 + TYPICAL_CALL_SECONDS;
  return { mode: 'paced', etaSeconds, limit, est, windowsNeeded };
}

/**
 * Human-readable TPM hint for a model, used in the init picker.
 * Returns empty string if model is unknown (caller drops the hint line).
 *
 * @param {string} provider
 * @param {string} modelId
 * @param {object} [opts]
 * @param {boolean} [opts.thinkingActive=false]  Propagated to estimateRunDuration.
 * @returns {string}
 */
export function formatTpmHint(provider, modelId, opts = {}) {
  const limit = getTier1Limit(provider, modelId);
  if (!limit) return '';
  if (limit.tpm == null) {
    // Perplexity — RPM-only, no TPM cap exposed.
    return `tier 1: ${limit.rpm} RPM`;
  }
  const eta = estimateRunDuration(provider, modelId, 'run', opts);
  const tpmStr = limit.tpm.toLocaleString();
  if (eta.mode === 'fast')  return `tier 1: ${tpmStr} TPM — typical run completes in ~${eta.etaSeconds}s`;
  if (eta.mode === 'paced') return `tier 1: ${tpmStr} TPM — typical run paced across ~${eta.etaSeconds}s`;
  return `tier 1: ${tpmStr} TPM`;
}
