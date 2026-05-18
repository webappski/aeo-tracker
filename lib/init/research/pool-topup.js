/**
 * Pool top-up generator (1.0.4).
 *
 * Called when Fix A's initial pool validation produces fewer than 3
 * RETRIEVAL-passing alternatives, to keep the recovery panel's option-1
 * --keywords command honest (must contain exactly 3 comma-separated queries).
 *
 * Self-sufficient recovery: the tool autonomously generates the missing
 * queries via a single dedicated LLM call instead of asking the operator
 * to retry with --category. Hard cap of 1 attempt per init prevents loops.
 *
 * The 1.0.4 cli-walkthrough skill caught the cells D (pool=1+unclean
 * category) and F (pool=2+unclean category) regression before publish.
 * This module closes both.
 */

import { SEARCH_BEHAVIORS, runTwoStageValidation } from './run-validation.js';

const TOP_UP_OVER_FACTOR = 2;  // ask for 2× to absorb validator rejection
const TOP_UP_MAX_OUTPUT = 10;  // safety cap on LLM output

export function buildTopUpPrompt({ brand, domain, category, site, audienceTags = [], geoTags = [], needed }) {
  const audienceLine = audienceTags.length > 0
    ? `Audience markers detected on the site: ${audienceTags.join(', ')}.`
    : '';
  const geoLine = geoTags.length > 0
    ? `Geographic signals: ${geoTags.join(', ')}.`
    : '';
  const requestN = Math.min(needed * TOP_UP_OVER_FACTOR, TOP_UP_MAX_OUTPUT);

  return `You are an AEO (Answer Engine Optimization) keyword specialist topping up a query pool.

BRAND: ${brand}
DOMAIN: ${domain}
LANGUAGE: ${site?.lang || 'en'}
CATEGORY_DESCRIPTION: "${category || '(unknown — infer from brand+domain)'}"
${audienceLine}
${geoLine}

TASK — generate ${requestN} commercial vendor-listing queries that an AI answer
engine will RESOLVE BY LIVE WEB SEARCH (search_behavior: retrieval-triggered).

REQUIREMENTS:
  - Each query must be phrased the way real users search: "best X for Y",
    "top X 2026", "X consultants for Z" — NOT brand-comparison archetypes
    like "X vs alternatives" or "top X competitors" (those fail commercial-only
    on new brands).
  - Each query must trigger live retrieval (search-style verbs/phrasing),
    NOT parametric-only knowledge (definitional/explanatory phrasing).
  - Unbranded: never include the brand name or domain core.
  - Match the site's language.
  - One query per line, no numbering, no quotes.

Output exactly ${requestN} queries, one per line.`;
}

export function parseTopUpResponse(text) {
  if (!text || typeof text !== 'string') return [];
  return text.split('\n')
    .map(l => l.trim())
    // Strip leading list markers (1. — • etc.) but keep the rest.
    .map(l => l.replace(/^[\d]+[.)]\s*|^[-*•]\s*/, '').trim())
    .filter(l => l.length > 0)
    .filter(l => l.length < 200)  // sanity cap on per-line length
    .slice(0, TOP_UP_MAX_OUTPUT);
}

/**
 * Generate up to `needed` RETRIEVAL-passing queries.
 *
 * @param {object} opts
 * @param {number} opts.needed - how many more RETRIEVAL queries to add
 * @param {string} opts.brand
 * @param {string} opts.domain
 * @param {string} opts.category - inferred or user-supplied category description
 * @param {object} opts.site - { lang, title, ... } site context
 * @param {object} opts.primary - { providerCall, apiKey, model, label }
 * @param {string[]} [opts.audienceTags]
 * @param {string[]} [opts.geoTags]
 * @param {Array}    [opts.validationCache] - existing cache for hit-honouring
 * @returns {Promise<Array>} - up to `needed` alt-shaped objects, possibly empty
 */
export async function topUpPool({
  needed, brand, domain, category, site,
  primary, audienceTags = [], geoTags = [], validationCache = [],
}) {
  if (!needed || needed <= 0) return [];
  if (!primary?.providerCall) return [];

  // Generation — positional providerCall signature per brainstorm.js:173.
  let candidates;
  try {
    const prompt = buildTopUpPrompt({ brand, domain, category, site, audienceTags, geoTags, needed });
    const { text } = await primary.providerCall(
      prompt, primary.apiKey, primary.model, { webSearch: false }
    );
    candidates = parseTopUpResponse(text || '');
  } catch {
    return [];
  }
  if (candidates.length === 0) return [];

  // Validate through both stages — RETRIEVAL only counts as commercial-passable.
  let validation;
  try {
    validation = await runTwoStageValidation({
      queries: candidates,
      brand, domain, category,
      geography: geoTags,
      primary,
      secondary: null,
      validationCache,
      commercialOnly: false,
    });
  } catch {
    return [];
  }

  const verdicts = validation.updatedCache || [];
  const passing = candidates
    .map(q => ({ text: q, verdict: verdicts.find(v => v.query === q) }))
    .filter(({ verdict }) => verdict && verdict.search_behavior === SEARCH_BEHAVIORS.RETRIEVAL);

  return passing.slice(0, needed).map(({ text, verdict }) => ({
    text,
    intent: 'commercial',
    score: verdict.confidence ? Math.round(verdict.confidence * 100) : 70,
    unverified: false,
    search_behavior: verdict.search_behavior,
    confidence: verdict.confidence,
    topUp: true,
  }));
}
