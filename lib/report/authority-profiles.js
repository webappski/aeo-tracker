/**
 * Authority profile detection — decides which extra authority sources to
 * fetch on top of the always-on wikipedia+reddit baseline.
 *
 * Why additive (not replacing): wiki/reddit don't break for any segment;
 * they're just less useful for some (e.g. CLI tools). Adding GitHub/HN
 * for those segments earns the dev-tool brand a relevant authority row
 * without losing the consumer-brand baseline.
 *
 * Detection inputs (in priority order):
 *   1. category text — LLM-suggested at init; subjective but specific.
 *   2. pageSignals.homepage.headings — H1/H2 text from crawled site, used
 *      as a category proxy when init didn't fill `category`. Cheap and
 *      brand-derived: «AEO Studio» in your H1 → dev-tool profile.
 *   3. domain TLD — `.dev` / `.io` / `.sh` correlate with dev tools.
 *
 * Output is conservative: when no signal fires, profile.type='default'
 * and extras=[] — section renders exactly as it did pre-2026 (wiki+reddit
 * only). No surprise regressions.
 */

// Domain TLDs that strongly suggest a dev / OSS / API product. Not used
// as the sole signal (consumer brands sometimes pick .io for marketing);
// combined with category text for confidence.
const DEV_TLD_HINTS = ['.dev', '.io', '.sh', '.gg'];

// Category-text regex per profile. First-match wins. Each pattern is
// expressed as a word-boundary alternation so substring noise («developer»
// inside «sole developer of the brand») doesn't false-fire.
const PROFILE_RULES = [
  {
    type: 'dev-tool',
    extras: ['github'],
    // Matches OSS / CLI / SDK keywords PLUS the AEO / AI-visibility space —
    // AEO studios ship dev tools and their authority signal is GitHub.
    // Engine-name mentions (chatgpt/claude/gemini/perplexity) and AEO
    // term-of-art («ai answers», «answer engines», «cited by AI») strongly
    // imply the brand operates in the AI-search optimisation space, even
    // when their headings also say «B2B SaaS» (would otherwise misfire
    // the saas rule below). Ordered first so dev-tool wins on hybrid
    // AEO-studio brands. Word-boundary alternation avoids «developer»
    // inside «business developer» false-firing.
    categoryRegex: /\b(open[- ]?source|cli|sdk|library|framework|api[- ]?client|developer[- ]?tool|dev[- ]?tool|npm|node[- ]?module|package|toolkit|cli[- ]?tool|tracker|audit|monitoring[- ]?tool|answer[- ]?engine[- ]?optimi[sz]ation|answer[- ]?engines?|aeo[- ]?studio|aeo[- ]?agency|aeo|ai[- ]?seo|ai[- ]?visibility|ai[- ]?optimi[sz]ation|ai[- ]?answers?|cited[- ]?by[- ]?(?:ai|chatgpt|claude|gemini|perplexity)|featured[- ]?in[- ]?ai|chatgpt|claude|perplexity|gemini|github)\b/i,
    domainTlds: DEV_TLD_HINTS,
  },
  {
    type: 'saas',
    extras: [],  // Phase 1 — no SaaS-specific source yet (G2/Capterra require scrape)
    categoryRegex: /\b(saas|b2b[- ]?software|platform|enterprise[- ]?software|crm|erp|analytics[- ]?tool)\b/i,
  },
  {
    type: 'consumer',
    extras: [],  // wiki+reddit baseline already covers consumer brands
    categoryRegex: /\b(consumer|retail|e[- ]?commerce|d2c|brand|fashion|food|beverage|cosmetics)\b/i,
  },
];

/**
 * Detect authority profile for a brand based on its category, headings,
 * and domain.
 *
 * Always-on rows: wikipedia + reddit. The `extras` list adds profile-specific
 * sources (currently just github for dev-tool).
 *
 * @param {object} input
 * @param {string} input.brand — brand display name
 * @param {string} input.domain — owned domain hostname (e.g. webappski.com)
 * @param {string} [input.category] — short category text from init/research
 * @param {object} [input.pageSignals] — output of page-signals.js; we read
 *   `pageSignals.homepage.headings.h1.samples` / `h2.samples` as a category
 *   proxy when init didn't fill `category`. Brand-derived text — most
 *   reliable when LLM categorisation is empty or stale.
 * @returns {{type: string, extras: string[], caveat?: string}}
 */
export function getAuthorityProfile({ brand, domain, category, pageSignals } = {}) {
  const cat = String(category || '').toLowerCase();
  const dom = String(domain || '').toLowerCase();
  const headingsText = pageSignals ? collectHeadingsText(pageSignals) : '';

  for (const rule of PROFILE_RULES) {
    // Category text match — primary signal (when init filled it).
    if (rule.categoryRegex && rule.categoryRegex.test(cat)) {
      return { type: rule.type, extras: rule.extras, caveat: caveatFor(rule.type) };
    }
    // Heading text fallback — brand's own H1/H2 from page-signals crawl.
    // E.g. «AEO Studio Webappski» in H1 → matches dev-tool's AEO regex.
    if (rule.categoryRegex && headingsText && rule.categoryRegex.test(headingsText)) {
      return { type: rule.type, extras: rule.extras, caveat: caveatFor(rule.type) };
    }
    // Domain TLD match — last resort.
    if (rule.domainTlds && rule.domainTlds.some(tld => dom.endsWith(tld))) {
      return { type: rule.type, extras: rule.extras, caveat: caveatFor(rule.type) };
    }
  }

  return { type: 'default', extras: [], caveat: '' };
}

/**
 * Extract H1 + H2 sample text from the cached page-signals shape.
 * Safe against missing/malformed fields — returns '' on any unexpected shape.
 *
 * Shape (from `lib/report/page-signals.js`):
 *   pageSignals.homepage.headings = { h1: {count, samples: [...]}, h2: {...} }
 */
function collectHeadingsText(pageSignals) {
  const h = pageSignals?.homepage?.headings;
  if (!h) return '';
  const parts = [];
  if (h.h1 && Array.isArray(h.h1.samples)) parts.push(...h.h1.samples);
  if (h.h2 && Array.isArray(h.h2.samples)) parts.push(...h.h2.samples);
  return parts.filter(s => typeof s === 'string').join(' ').toLowerCase();
}

// Per-type caveat surfaced in the section as a one-liner above the table.
// Helps the reader interpret a «✗ No Wikipedia article» row in context
// («Wikipedia rarely covers CLI tools — look at GitHub below»).
function caveatFor(type) {
  if (type === 'dev-tool') {
    return 'Wikipedia and Reddit are rarely populated for dev tools — the GitHub row below carries the meaningful signal.';
  }
  return '';
}
