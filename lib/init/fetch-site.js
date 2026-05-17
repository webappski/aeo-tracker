import { readFileSync } from 'node:fs';
import { fetchWithTimeout } from '../util/fetch-with-timeout.js';

const pkgVersion = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
})();
const DEFAULT_UA = `aeo-platform/${pkgVersion} (+https://webappski.com)`;

/**
 * Prepend https:// if the scheme is missing; strip trailing slash.
 */
export function normalizeUrl(input) {
  const t = String(input || '').trim();
  if (!t) return '';
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  return withScheme.replace(/\/+$/, '');
}

/**
 * Extract hostname from a URL-ish string for the config `domain` field.
 */
export function extractDomain(input) {
  const t = String(input || '').trim().replace(/^https?:\/\//i, '');
  return t.split('/')[0].replace(/^www\./i, '');
}

/**
 * Fetch a URL with timeout, redirect follow, and a descriptive UA.
 * Returns { html, finalUrl, status }.
 */
export async function fetchSite(url, { timeoutMs = 10000, ua = DEFAULT_UA } = {}) {
  try {
    const res = await fetchWithTimeout(url, {
      redirect: 'follow',
      headers: { 'User-Agent': ua, 'Accept': 'text/html,application/xhtml+xml' },
    }, { timeoutMs, kind: 'site' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const html = await res.text();
    return { html, finalUrl: res.url, status: res.status };
  } catch (err) {
    if (err.code === 'ETIMEDOUT' || err.name === 'TimeoutError') {
      throw new Error(`Fetch timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

/**
 * Regex-based HTML parser — good enough for meta/headings extraction.
 * Returns { lang, title, metaDesc, h1, h2, text, htmlSize }.
 */
export function parseSiteContent(html) {
  const get = (re) => {
    const m = html.match(re);
    return m ? decodeBasicEntities(m[1].trim().replace(/\s+/g, ' ')) : '';
  };
  const getAll = (re, limit = 5) => {
    const out = [];
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = global.exec(html)) && out.length < limit) {
      const text = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) out.push(decodeBasicEntities(text));
    }
    return out;
  };

  const lang = get(/<html[^>]*\blang=["']([^"']+)["']/i) || 'en';
  const title = get(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDesc =
    get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
    get(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i) ||
    get(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);

  const h1 = getAll(/<h1[^>]*>([\s\S]*?)<\/h1>/i, 3);
  const h2 = getAll(/<h2[^>]*>([\s\S]*?)<\/h2>/i, 8);

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);

  return { lang, title, metaDesc, h1, h2, text, htmlSize: html.length };
}

function decodeBasicEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Build a short category descriptor from site content.
 * Used downstream as CATEGORY_DESCRIPTION for brainstorm and validation prompts.
 *
 * This is a cheap heuristic — the user can override with --category flag,
 * and the LLM gets both this inference and the raw title/meta/h1 so it can
 * correct if the inference is off.
 */
export function inferCategory(parsed, brand = '') {
  const pieces = [];
  if (parsed.title) pieces.push(parsed.title);
  if (parsed.metaDesc) pieces.push(parsed.metaDesc);
  if (parsed.h1?.[0]) pieces.push(parsed.h1[0]);

  let joined = pieces.join(' · ');
  // Strip brand name so the category reads without branding
  if (brand) {
    const brandRe = new RegExp(`\\b${escapeRegex(brand)}\\b`, 'gi');
    joined = joined.replace(brandRe, '').replace(/\s+/g, ' ').trim();
  }
  // Drop leading/trailing separators left by brand removal
  joined = joined.replace(/^[\s·—\-|:,]+|[\s·—\-|:,]+$/g, '');
  if (joined.length > 160) joined = joined.slice(0, 157) + '…';
  return joined;
}

/**
 * Detect target-audience markers in site text. Returns an array of normalised
 * audience tags the brainstorm prompt can use for vertical-intent queries.
 */
export function detectAudience(parsed) {
  const haystack = [
    parsed.title,
    parsed.metaDesc,
    ...(parsed.h1 || []),
    ...(parsed.h2 || []),
    (parsed.text || '').slice(0, 1500),
  ].join(' ').toLowerCase();

  const patterns = [
    { tag: 'SaaS',         re: /\b(saas|software as a service|b2b saas)\b/ },
    { tag: 'startups',     re: /\b(startups?|early-stage|founders?|pre-seed|seed-stage)\b/ },
    { tag: 'enterprise',   re: /\b(enterprise|fortune ?(500|1000)|large organizations?)\b/ },
    { tag: 'agencies',     re: /\b(agencies|agency|consultancies|consulting firms?)\b/ },
    { tag: 'developers',   re: /\b(developers?|engineers?|devs|engineering teams?)\b/ },
    { tag: 'marketing',    re: /\b(marketers?|marketing teams?|cmo|growth teams?)\b/ },
    { tag: 'ecommerce',    re: /\b(ecommerce|e-commerce|online stores?|shopify|woocommerce)\b/ },
    { tag: 'healthcare',   re: /\b(healthcare|clinics?|hospitals?|medical|patients?)\b/ },
    { tag: 'finance',      re: /\b(fintech|finance|banks?|banking|trading|investment)\b/ },
    { tag: 'legal',        re: /\b(law firms?|legal|lawyers?|attorneys?|compliance)\b/ },
    { tag: 'education',    re: /\b(education|schools?|universities|students?|edtech)\b/ },
    { tag: 'small-business', re: /\b(small businesses|smbs?|local businesses?|small teams?)\b/ },
  ];

  const found = [];
  for (const { tag, re } of patterns) {
    if (re.test(haystack)) found.push(tag);
  }
  return found;
}

/**
 * Detect geography hints from TLD and site text. Helps the brainstorm prompt
 * produce region-appropriate queries (and flag when a term means something
 * different in the target region — e.g. "AEO" in Poland).
 */
export function detectGeography(domain, parsed) {
  const tldMap = {
    pl: 'Poland', de: 'Germany', fr: 'France', it: 'Italy', es: 'Spain',
    nl: 'Netherlands', se: 'Sweden', no: 'Norway', fi: 'Finland', dk: 'Denmark',
    uk: 'United Kingdom', ie: 'Ireland', ca: 'Canada', au: 'Australia',
    br: 'Brazil', mx: 'Mexico', jp: 'Japan', kr: 'South Korea',
    ru: 'Russia', ua: 'Ukraine', cz: 'Czech Republic', sk: 'Slovakia',
    ch: 'Switzerland', at: 'Austria', be: 'Belgium', pt: 'Portugal',
  };

  const hints = new Set();

  // TLD
  const tld = (domain || '').toLowerCase().split('.').pop();
  if (tldMap[tld]) hints.add(tldMap[tld]);

  // Text mentions of country names (first 1500 chars of body)
  const text = (parsed.text || '').slice(0, 1500);
  for (const country of Object.values(tldMap)) {
    const re = new RegExp(`\\b${escapeRegex(country)}\\b`, 'i');
    if (re.test(text) || re.test(parsed.title || '') || re.test(parsed.metaDesc || '')) {
      hints.add(country);
    }
  }
  // Common city/region markers
  const cityPatterns = [
    'Gdynia', 'Warsaw', 'Krakow', 'Berlin', 'Munich', 'Paris', 'London',
    'Dublin', 'Amsterdam', 'Stockholm', 'Helsinki', 'Prague', 'Vienna',
  ];
  for (const city of cityPatterns) {
    const re = new RegExp(`\\b${city}\\b`, 'i');
    if (re.test(text) || re.test(parsed.metaDesc || '')) hints.add(city);
  }

  return [...hints];
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Flag problematic pages so the user can decide whether to proceed.
 */
export function detectSiteIssues(parsed, html) {
  const issues = [];
  const bodyLen = parsed.text.length;
  const hasHeadings = parsed.h1.length > 0 || parsed.h2.length > 0;

  if (/cf-ray|just a moment|challenge-platform|\/cdn-cgi\//i.test(html.slice(0, 5000))) {
    issues.push('BOT_PROTECTED');
  }
  if (html.length < 500) {
    issues.push('TINY_HTML');
  } else if (bodyLen < 120 && !hasHeadings) {
    issues.push('SPA_OR_EMPTY');
  }
  return issues;
}
