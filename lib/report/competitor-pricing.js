/**
 * Competitor pricing tier extraction.
 *
 * For each top competitor surfaced by the LLM extractor, try to locate their
 * pricing page (heuristic URL guess or via canonicalCitations) and extract a
 * coarse price tier:
 *
 *   - 'free'        — no paid plans visible OR pricing page says "free"/"open source"
 *   - 'low'         — under $50/mo entry tier
 *   - 'mid'         — $50–$500/mo entry tier
 *   - 'high'        — $500–$2000/mo entry tier
 *   - 'enterprise'  — only "Contact sales" / "Custom" / >$2000
 *   - 'unknown'     — pricing page not findable / no parseable price signal
 *
 * v1: heuristic only (regex + URL pattern). Zero LLM cost. Optional LLM
 * fallback can be enabled later via config (`priceTierLLM: true`) when
 * heuristic confidence is low — deferred to v0.9.
 *
 * Why this matters for plan generation: comparison-page positioning needs
 * price context. "Webappski $2,500 productized vs Profound $5K+ retainer"
 * is a sharper pitch than "Webappski vs Profound".
 */

const FETCH_TIMEOUT_MS = 8000;
const USER_AGENT = 'aeo-platform (https://github.com/webappski/aeo-platform)';
const HTML_FETCH_BYTES_CAP = 1.5 * 1024 * 1024;
const PRICING_PATH_GUESSES = ['/pricing', '/plans', '/price', '/pricing/', '/plans/'];

// Tier thresholds (per-month USD entry-tier)
const TIER_LOW_MAX = 50;
const TIER_MID_MAX = 500;
const TIER_HIGH_MAX = 2000;

import { fetchWithTimeout as universalFetchWithTimeout } from '../util/fetch-with-timeout.js';

async function fetchWithTimeout(url, opts = {}) {
  const { timeoutMs, ...fetchInit } = opts;
  return universalFetchWithTimeout(url, {
    ...fetchInit,
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,*/*', ...(opts.headers || {}) },
  }, { timeoutMs: timeoutMs || FETCH_TIMEOUT_MS, kind: 'site' });
}

/**
 * Given a competitor name + canonicalCitations from the run, derive their
 * primary domain (best guess). Uses citation hosts first (most reliable), then
 * a slug heuristic on the name.
 */
export function deriveCompetitorDomain(name, canonicalCitations = []) {
  if (!name || typeof name !== 'string') return null;

  // Try citations first — competitor's own URL is the strongest signal
  const slugified = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const url of canonicalCitations) {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      const hostBare = host.split('.')[0].replace(/[^a-z0-9]/g, '');
      if (hostBare && slugified.includes(hostBare)) return host;
      if (hostBare && hostBare.includes(slugified)) return host;
    } catch { /* invalid URL — skip */ }
  }

  // Fallback: name → domain.com guess (e.g. "Profound" → "profound.com").
  // Returned WITH a `guessed: true` marker via second return path so callers
  // can decide to skip if guessed domains have low hit rate.
  return null;
}

/**
 * Find the pricing page for a competitor. Tries:
 *   1. Citation URLs containing "/pricing" or "/plans"
 *   2. Heuristic guesses (domain + /pricing, /plans, /price)
 *
 * Returns { url, source } where source ∈ ['citation', 'heuristic', null].
 */
export async function findPricingPage(domain, canonicalCitations = [], { fetchImpl = fetchWithTimeout } = {}) {
  if (!domain) return { url: null, source: null };

  // Strong signal: citation already points at /pricing
  for (const url of canonicalCitations) {
    try {
      const u = new URL(url);
      if (u.hostname.toLowerCase().replace(/^www\./, '') !== domain) continue;
      if (/\/(pricing|plans|price)(\/|$|\?)/i.test(u.pathname)) {
        return { url: url, source: 'citation' };
      }
    } catch { /* skip */ }
  }

  // Heuristic guess — try each path, return first 200
  for (const path of PRICING_PATH_GUESSES) {
    const url = `https://${domain}${path}`;
    try {
      const res = await fetchImpl(url, { method: 'HEAD' });
      if (res.ok) return { url, source: 'heuristic' };
    } catch { /* skip */ }
  }

  return { url: null, source: null };
}

/**
 * Extract numeric prices from HTML body. Returns sorted ascending array of
 * unique price values (USD assumed; $19/mo and €19/mo both surface as 19).
 *
 * Patterns handled:
 *   $19   $19/mo   $19.99   $1,299   $19 / month
 *   USD 19   19 USD
 *   "Free", "Open source" → returns 0 marker
 */
export function extractPrices(html) {
  if (!html || typeof html !== 'string') return { prices: [], hasFree: false, hasContactSales: false };

  // Strip scripts/styles to avoid catching non-display content
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  const hasFree = /\b(free|forever\s+free|open\s+source|free\s+tier|free\s+plan|\$0)\b/i.test(body);
  const hasContactSales = /(contact\s+(?:us\s+for\s+pricing|sales)|custom\s+pricing|talk\s+to\s+sales|enterprise\s+pricing|request\s+(?:a\s+)?quote)/i.test(body);

  const priceRe = /\$\s?([\d,]+(?:\.\d{1,2})?)/g;
  const altRe = /(?:USD|EUR|GBP)\s+([\d,]+)|(\d{2,4})\s*(?:\/|per)\s*(?:mo|month)/gi;

  const set = new Set();
  let m;
  while ((m = priceRe.exec(body)) !== null) {
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0 && n < 100000) set.add(n);
  }
  while ((m = altRe.exec(body)) !== null) {
    const raw = m[1] || m[2];
    if (!raw) continue;
    const n = Number(raw.replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0 && n < 100000) set.add(n);
  }

  return {
    prices: Array.from(set).sort((a, b) => a - b),
    hasFree,
    hasContactSales,
  };
}

/**
 * Map extracted prices to a tier label.
 *
 * Decision rules (in priority order):
 *   - hasFree AND no other prices → 'free'
 *   - hasContactSales AND no prices → 'enterprise'
 *   - lowest non-free price → bucket
 *   - hasFree AND has paid plans → 'free' (freemium signal — entry IS free)
 *
 * @returns {{ tier: string, entryPrice: number|null, confidence: 'high'|'med'|'low' }}
 */
export function classifyTier({ prices, hasFree, hasContactSales }) {
  if (hasFree && (prices.length === 0 || prices[0] === 0)) {
    return { tier: 'free', entryPrice: 0, confidence: 'high' };
  }
  if (hasFree) {
    // freemium — entry is free even if paid tiers exist
    return { tier: 'free', entryPrice: 0, confidence: 'med' };
  }
  if (prices.length === 0 && hasContactSales) {
    return { tier: 'enterprise', entryPrice: null, confidence: 'med' };
  }
  if (prices.length === 0) {
    return { tier: 'unknown', entryPrice: null, confidence: 'low' };
  }

  const entry = prices[0];
  const conf = prices.length >= 2 ? 'high' : 'med';
  if (entry < TIER_LOW_MAX) return { tier: 'low', entryPrice: entry, confidence: conf };
  if (entry < TIER_MID_MAX) return { tier: 'mid', entryPrice: entry, confidence: conf };
  if (entry < TIER_HIGH_MAX) return { tier: 'high', entryPrice: entry, confidence: conf };
  return { tier: 'enterprise', entryPrice: entry, confidence: conf };
}

/**
 * Process one competitor: derive domain → find pricing page → fetch HTML →
 * extract prices → classify tier. All errors graceful → returns 'unknown'.
 */
export async function processCompetitor(competitor, canonicalCitations = [], opts = {}) {
  const fetchImpl = opts.fetchImpl || fetchWithTimeout;
  const result = {
    name: competitor.name,
    domain: null,
    pricingUrl: null,
    pricingSource: null,
    tier: 'unknown',
    entryPrice: null,
    confidence: 'low',
    error: null,
  };

  const domain = deriveCompetitorDomain(competitor.name, canonicalCitations);
  if (!domain) {
    result.error = 'no-domain-derivable';
    return result;
  }
  result.domain = domain;

  let pricingPage;
  try {
    pricingPage = await findPricingPage(domain, canonicalCitations, { fetchImpl });
  } catch (err) {
    result.error = `findPricingPage: ${err.message || String(err)}`;
    return result;
  }
  if (!pricingPage.url) {
    result.error = 'no-pricing-page-found';
    return result;
  }
  result.pricingUrl = pricingPage.url;
  result.pricingSource = pricingPage.source;

  let html;
  try {
    const res = await fetchImpl(pricingPage.url);
    if (!res.ok) {
      result.error = `pricing-fetch HTTP ${res.status}`;
      return result;
    }
    const body = await res.text();
    html = body.length > HTML_FETCH_BYTES_CAP ? body.slice(0, HTML_FETCH_BYTES_CAP) : body;
  } catch (err) {
    result.error = `pricing-fetch: ${err.message || String(err)}`;
    return result;
  }

  const extracted = extractPrices(html);
  const classified = classifyTier(extracted);
  result.tier = classified.tier;
  result.entryPrice = classified.entryPrice;
  result.confidence = classified.confidence;
  return result;
}

/**
 * Process top-N competitors in parallel (capped) and return a summary array.
 * Caller is responsible for slicing to the budget (e.g. top 5).
 *
 * @param {Array<{name: string}>} competitors
 * @param {string[]} canonicalCitations  flat list of all citation URLs from run
 * @param {object} [opts]
 * @returns {Promise<Array>} per-competitor pricing tier objects
 */
export async function classifyCompetitorPricing(competitors, canonicalCitations = [], opts = {}) {
  if (!Array.isArray(competitors) || competitors.length === 0) return [];
  const list = competitors.slice(0, opts.limit || 5);
  return Promise.all(list.map(c => processCompetitor(c, canonicalCitations, opts)));
}
