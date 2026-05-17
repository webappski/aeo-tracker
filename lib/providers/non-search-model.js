/**
 * Derive a non-search ("training-data only") model from the search-enabled
 * model that `discoverModels()` returned.
 *
 * Used by `aeo-tracker run --depth=full` to make a second LLM call per cell
 * with web search disabled — measures whether the brand is in the model's
 * training corpus, independent of current SERPs.
 *
 *   openai      → strip `-search-api` / `-search-preview` suffix
 *                 (`gpt-5-search-api` → `gpt-5`)
 *   gemini      → same model; webSearch toggle is a request-body flag
 *   anthropic   → same model; webSearch toggle is a tool flag
 *   perplexity  → null — Perplexity is search-only by design, no training mode
 *
 * Returns null when the provider has no training-data variant.
 */
export function deriveTrainingModel(providerName, searchModel) {
  if (!providerName || !searchModel) return null;
  switch (providerName) {
    case 'openai':
      // Strip every OpenAI search-suffix variant. `-search` is the plain form
      // (gpt-4o-search → gpt-4o); `-search-api` is the GPT-5 form; `-search-preview`
      // is the legacy 4o-preview form (with optional date suffix). Order matters
      // only insofar as the more specific suffixes can't match after a generic
      // `-search$` strip, so apply specific-first.
      return searchModel
        .replace(/-search-api$/, '')
        .replace(/-search-preview(?:-\d{4}-\d{2}-\d{2})?$/, '')
        .replace(/-search$/, '');
    case 'gemini':
    case 'anthropic':
      return searchModel;
    case 'perplexity':
      return null;
    default:
      return searchModel;
  }
}

/** Milliseconds in one calendar day (24 h × 60 min × 60 s × 1000 ms). */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How many days since the last `--depth=full` run for this brand?
 * Returns null if no prior full run is recorded. Caller decides the threshold
 * (default 14 days) for prompting the user.
 */
export function daysSinceLastFullRun(lastFullRun, today = new Date()) {
  if (!lastFullRun || typeof lastFullRun !== 'string') return null;
  const last = new Date(lastFullRun + 'T00:00:00Z');
  if (isNaN(last.getTime())) return null;
  const ms = today.getTime() - last.getTime();
  return Math.floor(ms / MS_PER_DAY);
}
