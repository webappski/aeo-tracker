/**
 * Page-signals — own-domain crawl for AEO-relevant on-page signals.
 *
 * Fetches the brand's homepage (or a configured set of canonical pages) and
 * extracts:
 *   - H1 patterns (count, exact text samples — useful for category-phrase
 *     saturation analysis)
 *   - FAQ presence (FAQPage Schema.org block + question-pattern heuristic)
 *   - Schema.org validity (count of <script type="application/ld+json">,
 *     parse success rate, top @type values, required-field completeness)
 *   - Answer-capsule pattern (40-60-word direct-answer paragraph
 *     immediately after each H2 — top AEO signal per audit 2026-04-29)
 *
 * Zero LLM cost. Pure HTTP fetch + regex/JSON parse. Output cached in
 * `_summary.json::pageSignals` for use by mc-metadata.js + plan generator.
 *
 * v1 limit: homepage only. Multi-page crawl deferred to v0.9 — would
 * require a sitemap walk + budget control. For Mission Control plan
 * generation, homepage signals are highest-leverage indicator (AI engines
 * fetch homepage most frequently).
 */

const FETCH_TIMEOUT_MS = 12000;
const USER_AGENT = 'aeo-platform (https://github.com/webappski/aeo-platform)';
const ANSWER_CAPSULE_MIN_WORDS = 40;
const ANSWER_CAPSULE_MAX_WORDS = 60;
const HTML_FETCH_BYTES_CAP = 2 * 1024 * 1024; // 2MB — defensive against huge pages

import { fetchWithTimeout as universalFetchWithTimeout } from '../util/fetch-with-timeout.js';

async function fetchWithTimeout(url, opts = {}) {
  const { timeoutMs, ...fetchInit } = opts;
  return universalFetchWithTimeout(url, {
    ...fetchInit,
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,*/*', ...(opts.headers || {}) },
  }, { timeoutMs: timeoutMs || FETCH_TIMEOUT_MS, kind: 'site' });
}

/**
 * Strip HTML tags from a fragment, collapse whitespace, trim. Returns plain
 * text suitable for word-count heuristics (answer capsule detection, lede
 * length checks).
 */
function htmlToText(fragment) {
  if (!fragment) return '';
  return fragment
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(text) {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

/**
 * Extract all H1/H2 elements from raw HTML. Returns:
 *   { h1: { count, samples }, h2: { count, samples } }
 * where `samples` is an array of plain-text contents (max 5 each).
 *
 * Regex-based parsing — no DOM. Sufficient for the signals we need; full DOM
 * parsing would add `cheerio`/`jsdom` (violates zero-dep contract).
 */
export function extractHeadings(html) {
  const result = { h1: { count: 0, samples: [] }, h2: { count: 0, samples: [] } };
  if (!html || typeof html !== 'string') return result;

  const h1Re = /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi;
  const h2Re = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;

  let m;
  while ((m = h1Re.exec(html)) !== null) {
    result.h1.count++;
    if (result.h1.samples.length < 5) {
      const text = htmlToText(m[1]).slice(0, 200);
      if (text) result.h1.samples.push(text);
    }
  }
  while ((m = h2Re.exec(html)) !== null) {
    result.h2.count++;
    if (result.h2.samples.length < 5) {
      const text = htmlToText(m[1]).slice(0, 200);
      if (text) result.h2.samples.push(text);
    }
  }

  return result;
}

/**
 * Find the paragraph that follows each H2 and check if its word count falls
 * in the AEO-optimal range (40-60 words). Returns:
 *   {
 *     totalH2: N,
 *     withCapsule: N,        // count of H2s followed by 40-60-word para
 *     coverage: 0-100,       // pct
 *     samples: [{ heading, paraWords, hasCapsule }]  // up to 5
 *   }
 *
 * Heuristic: para = first <p>...</p> AFTER the H2 closing tag, BEFORE the
 * next heading (h1-h6).
 */
export function detectAnswerCapsules(html) {
  const result = { totalH2: 0, withCapsule: 0, coverage: 0, samples: [] };
  if (!html || typeof html !== 'string') return result;

  const blockRe = /<h2\b[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h[1-6]\b|$)/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    result.totalH2++;
    const heading = htmlToText(m[1]).slice(0, 100);
    const after = m[2] || '';
    const paraMatch = after.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    const paraText = paraMatch ? htmlToText(paraMatch[1]) : '';
    const w = wordCount(paraText);
    const hasCapsule = w >= ANSWER_CAPSULE_MIN_WORDS && w <= ANSWER_CAPSULE_MAX_WORDS;
    if (hasCapsule) result.withCapsule++;
    if (result.samples.length < 5) {
      result.samples.push({ heading, paraWords: w, hasCapsule });
    }
  }

  result.coverage = result.totalH2 === 0 ? 0 : Math.round((result.withCapsule / result.totalH2) * 100);
  return result;
}

/**
 * Extract all <script type="application/ld+json"> blocks, parse each, return
 * structural summary:
 *   {
 *     blockCount: N,            // total ld+json blocks found
 *     parseFailures: N,         // blocks that didn't parse as JSON
 *     types: ["Organization", "FAQPage", ...],   // @type values seen
 *     hasOrganization: bool,
 *     hasFaqPage: bool,
 *     hasBreadcrumb: bool,
 *     hasPerson: bool,
 *     hasArticle: bool,         // BlogPosting | Article | NewsArticle
 *     orgFields: [...]          // top-level keys of first Organization block (validity proxy)
 *   }
 *
 * Why structural-only (no schema.org validation against full vocabulary): full
 * validation requires the schema.org graph (~200KB JSON-LD context). This
 * module returns enough signal for plan generator to decide "Organization
 * exists, but no `address` field — recommend adding `address`".
 */
export function analyzeSchemaOrg(html) {
  const result = {
    blockCount: 0,
    parseFailures: 0,
    types: [],
    hasOrganization: false,
    hasFaqPage: false,
    hasBreadcrumb: false,
    hasPerson: false,
    hasArticle: false,
    orgFields: [],
  };
  if (!html || typeof html !== 'string') return result;

  const blockRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const seenTypes = new Set();
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    result.blockCount++;
    const body = m[1].trim();
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      result.parseFailures++;
      continue;
    }

    // Schema.org allows array-form + @graph nesting
    const items = Array.isArray(parsed) ? parsed
      : (Array.isArray(parsed['@graph']) ? parsed['@graph'] : [parsed]);

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const t = item['@type'];
      const typeStrs = Array.isArray(t) ? t : (t ? [t] : []);
      for (const ts of typeStrs) {
        if (typeof ts === 'string') seenTypes.add(ts);
      }
      if (typeStrs.includes('Organization') || typeStrs.includes('ProfessionalService') || typeStrs.includes('Corporation')) {
        result.hasOrganization = true;
        if (result.orgFields.length === 0) {
          result.orgFields = Object.keys(item).filter(k => !k.startsWith('@')).slice(0, 30);
        }
      }
      if (typeStrs.includes('FAQPage')) result.hasFaqPage = true;
      if (typeStrs.includes('BreadcrumbList')) result.hasBreadcrumb = true;
      if (typeStrs.includes('Person')) result.hasPerson = true;
      if (typeStrs.includes('Article') || typeStrs.includes('BlogPosting') || typeStrs.includes('NewsArticle')) {
        result.hasArticle = true;
      }
    }
  }

  result.types = Array.from(seenTypes).slice(0, 20);
  return result;
}

/**
 * Heuristic FAQ count even WITHOUT Schema.org FAQPage block. Looks for
 * accordion / disclosure patterns: <details><summary>?</summary>, h2/h3 ending
 * with "?", repeated question-answer blocks.
 *
 * Returns: { schemaCount, heuristicCount, total }
 *   - schemaCount: questions inside FAQPage `mainEntity` array
 *   - heuristicCount: question-pattern matches outside any FAQPage block
 */
export function countFaqs(html) {
  const result = { schemaCount: 0, heuristicCount: 0, total: 0 };
  if (!html || typeof html !== 'string') return result;

  // Schema.org FAQPage → mainEntity array of Question items
  const blockRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    let parsed;
    try { parsed = JSON.parse(m[1]); } catch { continue; }
    const items = Array.isArray(parsed) ? parsed
      : (Array.isArray(parsed['@graph']) ? parsed['@graph'] : [parsed]);
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const isFaq = item['@type'] === 'FAQPage'
        || (Array.isArray(item['@type']) && item['@type'].includes('FAQPage'));
      if (isFaq && Array.isArray(item.mainEntity)) {
        result.schemaCount += item.mainEntity.length;
      }
    }
  }

  // Heuristic: heading or summary tag ending in "?"
  const qHeadingRe = /<(?:h[2-4]|summary|dt)\b[^>]*>([^<]*\?\s*)<\/(?:h[2-4]|summary|dt)>/gi;
  while ((m = qHeadingRe.exec(html)) !== null) {
    if (m[1].trim().endsWith('?')) result.heuristicCount++;
  }

  result.total = result.schemaCount > 0 ? result.schemaCount : result.heuristicCount;
  return result;
}

/**
 * Read raw HTML body up to the size cap. Returns string (may be truncated).
 */
async function fetchHtml(url, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) {
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  }
  // res.text() awaits the full body — for the cap, we slice after.
  const body = await res.text();
  const truncated = body.length > HTML_FETCH_BYTES_CAP;
  return {
    ok: true,
    status: res.status,
    html: truncated ? body.slice(0, HTML_FETCH_BYTES_CAP) : body,
    bytes: body.length,
    truncated,
  };
}

/**
 * Crawl the brand's homepage and return structured page signals. Returns
 * `{ ok: false, error }` on fetch failure — do NOT throw, downstream plan
 * generator handles null gracefully.
 *
 * @param {string} domain  e.g. "webappski.com" (no scheme — added here)
 * @param {object} opts
 * @param {string} [opts.scheme='https'] — for testing or http-only sites
 * @param {string} [opts.path='/']
 * @param {Function} [opts.fetchImpl] — DI for tests
 */
export async function crawlPageSignals(domain, opts = {}) {
  if (!domain || typeof domain !== 'string') {
    return { ok: false, error: 'no domain' };
  }
  const scheme = opts.scheme || 'https';
  const path = opts.path || '/';
  const url = `${scheme}://${domain.replace(/^https?:\/\//, '').replace(/\/$/, '')}${path}`;
  const fetchImpl = opts.fetchImpl || fetchWithTimeout;

  let fetched;
  try {
    fetched = await fetchHtml(url, fetchImpl);
  } catch (err) {
    return { ok: false, url, error: err.message || String(err) };
  }
  if (!fetched.ok) {
    return { ok: false, url, status: fetched.status, error: fetched.error };
  }

  const html = fetched.html;
  const headings = extractHeadings(html);
  const capsules = detectAnswerCapsules(html);
  const schemaOrg = analyzeSchemaOrg(html);
  const faq = countFaqs(html);

  return {
    ok: true,
    url,
    fetchedAt: new Date().toISOString(),
    bytes: fetched.bytes,
    truncated: fetched.truncated,
    headings,
    answerCapsules: capsules,
    schemaOrg,
    faq,
  };
}

/**
 * Top-level entry: fetch page signals for the brand's homepage. Output is
 * cached in `_summary.json::pageSignals` and consumed by mc-metadata builder.
 *
 * @param {string} domain
 * @param {object} [opts]
 * @returns {Promise<Object>}
 */
export async function checkPageSignals(domain, opts = {}) {
  const result = await crawlPageSignals(domain, opts);
  return {
    domain,
    ranAt: new Date().toISOString(),
    homepage: result,
  };
}
