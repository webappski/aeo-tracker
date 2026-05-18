/**
 * Two-stage query validation orchestrator.
 *
 * Single call site shared between init (full path), init --queries-only, and run.
 * Kills the ~80 lines of duplication that grew between those three entry points
 * and guarantees the same contract (thresholds, formatting, cache semantics) everywhere.
 *
 * Cache semantics: verdicts are keyed by exact query text. Init writes the cache,
 * run trusts it. If a user edits .aeo-tracker.json by hand and adds a new query,
 * run detects the cache miss and re-validates on-the-fly (if a provider key is
 * available) — closing the regression gap flagged in senior review P0 #1.
 */

import { validateQueries as staticValidate } from './filter.js';
import { validateQueriesWithLLM, CONFIDENCE_THRESHOLD, SEARCH_BEHAVIORS } from './validate-query-llm.js';

export { CONFIDENCE_THRESHOLD, SEARCH_BEHAVIORS };

/**
 * Merge two independent LLM verdicts for the same query into a single record.
 *
 * Voting strategy (conservative):
 *   - both valid       → valid, confidence = avg                      (unanimous approve)
 *   - both invalid     → invalid, confidence = max                    (unanimous reject, stronger signal)
 *   - split            → invalid, confidence = min                    (any disagreement blocks)
 *
 * Split result carries `modelAgreement: 'split'` plus both per-model verdicts in
 * `sources` so the user can see exactly which model said what (transparency > magic).
 * Surface reason in human-readable form for the existing formatter.
 *
 * @param {Object} a  primary verdict from validateQueriesWithLLM
 * @param {Object} b  secondary verdict
 * @returns merged verdict, same shape + { modelAgreement, sources }
 */
function mergeCostInfo(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    provider: `${a.provider}+${b.provider}`,
    model: `${a.model}+${b.model}`,
    label: 'query-validation (cross-check)',
    requests: (a.requests || 0) + (b.requests || 0),
    inputTokens:  (a.inputTokens || 0)  + (b.inputTokens || 0),
    outputTokens: (a.outputTokens || 0) + (b.outputTokens || 0),
    costUsd:      (a.costUsd || 0)      + (b.costUsd || 0),
  };
}

export function mergeCrossCheck(a, b) {
  if (!a) return b;
  if (!b) return a;

  const unanimousValid = a.valid === true && b.valid === true;
  const unanimousInvalid = a.valid === false && b.valid === false;
  const agreement = (unanimousValid || unanimousInvalid) ? 'unanimous' : 'split';

  let valid, confidence, reason;
  if (unanimousValid) {
    valid = true;
    confidence = (a.confidence + b.confidence) / 2;
    reason = a.reason && b.reason ? `Both models agree: ${a.reason}` : (a.reason || b.reason || '');
  } else if (unanimousInvalid) {
    valid = false;
    confidence = Math.max(a.confidence, b.confidence);
    reason = `Both models reject. ${a.reason || ''}${a.reason && b.reason ? ' / ' : ''}${b.reason || ''}`.trim();
  } else {
    // Split: conservative → invalid, confidence floor, show the disagreement
    valid = false;
    confidence = Math.min(a.confidence, b.confidence);
    const approver = a.valid ? 'primary' : 'secondary';
    const rejecter = a.valid ? 'secondary' : 'primary';
    reason = `Models disagree: ${approver} says valid, ${rejecter} says invalid — blocking conservatively.`;
  }

  // Merge alternate meanings (unique, cap 5)
  const altSet = new Set([...(a.alternate_meanings || []), ...(b.alternate_meanings || [])]);
  const alternate_meanings = [...altSet].slice(0, 5);

  // Prefer retrieval-triggered if either model says so (optimistic for this field —
  // if ANY model says the query will trigger live search, it probably will).
  const behaviors = [a.search_behavior, b.search_behavior];
  const search_behavior = behaviors.includes(SEARCH_BEHAVIORS.RETRIEVAL)
    ? SEARCH_BEHAVIORS.RETRIEVAL
    : behaviors.includes(SEARCH_BEHAVIORS.MIXED) ? SEARCH_BEHAVIORS.MIXED : SEARCH_BEHAVIORS.PARAMETRIC;

  return {
    query: a.query || b.query,
    valid,
    confidence,
    alternate_meanings,
    dominant_interpretation: a.dominant_interpretation || b.dominant_interpretation || '',
    search_behavior,
    reason,
    modelAgreement: agreement,
    sources: [
      { model: a.model || 'primary',   valid: a.valid, confidence: a.confidence, reason: a.reason, dominant_interpretation: a.dominant_interpretation },
      { model: b.model || 'secondary', valid: b.valid, confidence: b.confidence, reason: b.reason, dominant_interpretation: b.dominant_interpretation },
    ],
  };
}

/**
 * @param {Object} opts
 * @param {string[]} opts.queries                       final query list
 * @param {string}   opts.brand
 * @param {string}   opts.domain
 * @param {string}   opts.category
 * @param {string[]} [opts.geography]
 * @param {Object|null} opts.primary                    resolved provider {name, providerCall, apiKey, model, label} or null
 * @param {Array}    [opts.validationCache]             prior verdicts from config ([{query, valid, confidence, ...}])
 *
 * @returns {Promise<{
 *   staticIssues: Array,
 *   llmIssues: Array,
 *   llmResults: Array,
 *   parametricQueries: Array,
 *   updatedCache: Array,
 *   costInfo: object|null,
 *   llmSkipped: boolean,
 *   cacheHits: number,
 *   cacheMisses: number
 * }>}
 */
export async function runTwoStageValidation({
  queries, brand, domain, category, geography = [],
  primary, secondary = null, validationCache = [],
  commercialOnly = true,
}) {
  // Stage 1: static acronym tripwire (free, deterministic)
  const staticIssues = staticValidate(queries);

  // Build cache lookup. Keyed by exact query text — if the user edits a query by
  // a single character, cache miss triggers re-validation (correct behaviour).
  const cacheMap = new Map();
  for (const entry of validationCache) {
    if (entry && typeof entry.query === 'string') cacheMap.set(entry.query, entry);
  }

  const uncached = queries.filter(q => !cacheMap.has(q));
  let costInfo = null;
  let llmSkipped = false;

  if (uncached.length > 0) {
    if (primary) {
      // Cross-check mode: run both models in parallel, merge verdicts per query.
      // Cost multiplier 2× only when secondary provided (opt-in via --strict-validation).
      const runOne = (provider) => validateQueriesWithLLM({
        queries: uncached,
        brand, domain, category, geography,
        providerCall: provider.providerCall,
        providerName: provider.name,
        apiKey: provider.apiKey,
        model: provider.model,
      });

      if (secondary) {
        const [primaryRes, secondaryRes] = await Promise.all([runOne(primary), runOne(secondary)]);
        costInfo = mergeCostInfo(primaryRes.costInfo, secondaryRes.costInfo);
        const byQueryB = new Map(secondaryRes.results.map(r => [r.query, { ...r, model: secondary.model }]));
        const ts = new Date().toISOString();
        for (const r of primaryRes.results) {
          const a = { ...r, model: primary.model };
          const b = byQueryB.get(r.query);
          const merged = b ? mergeCrossCheck(a, b) : a;
          cacheMap.set(r.query, { ...merged, validatedAt: ts });
        }
      } else {
        const { results, costInfo: freshCost } = await runOne(primary);
        costInfo = freshCost;
        const ts = new Date().toISOString();
        for (const r of results) {
          cacheMap.set(r.query, { ...r, validatedAt: ts });
        }
      }
    } else {
      // No provider available — caller may want to warn the user that run-time
      // validation degraded to static-only (still catches acronyms via Stage 1).
      llmSkipped = true;
    }
  }

  const llmResults = queries
    .map(q => cacheMap.get(q))
    .filter(Boolean);

  // 1.0.8: trust `valid` field. Previously gated on (!valid || confidence < 0.7),
  // which rejected good commercial queries with normal confidence (0.6-0.7 is
  // typical for real queries — LLM accounts for alternate meanings). `valid` is
  // LLM's explicit verdict; `confidence` is its self-assessed certainty. If LLM
  // said "valid" — we accept; confidence stays in cache for audit only.
  const llmIssues = llmResults.filter(r => !r.valid);
  const parametricQueries = llmResults.filter(r => r.search_behavior === SEARCH_BEHAVIORS.PARAMETRIC);
  // Commercial-only policy: AEO tracker measures competitive visibility, which only
  // exists on retrieval-triggered queries (AI returns a ranked list of vendors).
  // Methodological/informational queries (parametric-only, mixed) produce tutorial-
  // style answers with no competitor list — they pollute the report with 0% scores
  // that mean "format of response is different" rather than "brand is invisible".
  const informationalIssues = commercialOnly
    ? llmResults.filter(r => r.search_behavior && r.search_behavior !== SEARCH_BEHAVIORS.RETRIEVAL)
    : [];

  // Fresh cache snapshot: only verdicts for queries currently in the config.
  // Drops orphaned entries from previous configs so the file doesn't grow unbounded.
  const updatedCache = queries
    .map(q => cacheMap.get(q))
    .filter(Boolean);

  return {
    staticIssues,
    llmIssues,
    informationalIssues,
    llmResults,
    parametricQueries,
    updatedCache,
    costInfo,
    llmSkipped,
    cacheHits: queries.length - uncached.length,
    cacheMisses: uncached.length,
  };
}

/**
 * Human-readable formatter for validation results.
 * Returns an array of printable lines so the caller can feed it to console.log
 * or prepend ANSI colour codes. Pure — no I/O, no colour logic.
 */
export function formatValidationResult(v, { indent = '  ' } = {}) {
  const lines = [];
  if (v.staticIssues.length > 0) {
    lines.push(`Static check — ${v.staticIssues.length} ambiguous acronym(s):`);
    for (const i of v.staticIssues) {
      lines.push(`${indent}"${i.query}"  — ${i.message}`);
    }
  }
  if (v.llmIssues.length > 0) {
    lines.push(`LLM industry-fit check — ${v.llmIssues.length} flagged query/queries:`);
    for (const r of v.llmIssues) {
      lines.push(`${indent}"${r.query}"`);
      lines.push(`${indent}  confidence: ${r.confidence.toFixed(2)}   valid: ${r.valid}`);
      if (r.modelAgreement === 'split' && Array.isArray(r.sources)) {
        lines.push(`${indent}  ⚠ models disagree — both verdicts shown:`);
        for (const s of r.sources) {
          lines.push(`${indent}    [${s.model}] valid=${s.valid} conf=${s.confidence?.toFixed?.(2) ?? s.confidence} — ${s.reason || ''}`);
        }
      }
      if (r.alternate_meanings.length > 0) {
        lines.push(`${indent}  alternate meanings:`);
        for (const m of r.alternate_meanings.slice(0, 3)) lines.push(`${indent}    • ${m}`);
      }
      if (r.dominant_interpretation) lines.push(`${indent}  dominant: ${r.dominant_interpretation}`);
      if (r.reason) lines.push(`${indent}  reason: ${r.reason}`);
    }
  }
  if (v.informationalIssues && v.informationalIssues.length > 0) {
    lines.push(`Commercial-only check — ${v.informationalIssues.length} non-commercial query/queries blocked:`);
    lines.push(`${indent}AEO tracker measures where AI lists vendors. Methodological queries produce`);
    lines.push(`${indent}tutorial-style answers with no competitor list — 0% scores here mean "wrong format",`);
    lines.push(`${indent}not "invisible". Rewrite as "best X for Y" / "top X 2026" / "X consultants for Z".`);
    for (const r of v.informationalIssues) {
      lines.push(`${indent}  "${r.query}" — search_behavior: ${r.search_behavior}`);
    }
  } else if (v.parametricQueries.length > 0) {
    // Only surfaces when commercialOnly=false (opt-out for content-marketing mode).
    lines.push(`Retrievability — ${v.parametricQueries.length} parametric-only query/queries:`);
    lines.push(`${indent}AI answers from training data without live web search.`);
    lines.push(`${indent}"0% visibility" here means the model didn't learn you, not that you don't rank.`);
    for (const r of v.parametricQueries) {
      lines.push(`${indent}  "${r.query}"`);
    }
  }
  return lines;
}

export function hasBlockers(v) {
  const infoCount = (v.informationalIssues && v.informationalIssues.length) || 0;
  return v.staticIssues.length > 0 || v.llmIssues.length > 0 || infoCount > 0;
}
