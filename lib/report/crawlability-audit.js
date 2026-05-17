/**
 * AI-bot crawlability audit for the user's domain.
 *
 * Fetches robots.txt, /llms.txt, and /sitemap.xml from the brand's own domain
 * and reports which AI crawlers are allowed, which are blocked, and which AEO
 * discovery files are present. Pure HTTP — no LLM calls, no auth, ~3 requests.
 *
 * The "your brand isn't visible in Claude" problem is sometimes a writing problem
 * but VERY often a robots.txt problem (`Disallow: / for ClaudeBot`). This module
 * surfaces that root cause before the user spends $$$ on content production.
 *
 * Run-once-per-report. Cached in `_summary.json::crawlability` so re-running
 * `aeo-tracker report` does not re-fetch.
 */

// Bots tracked. Each entry: { name (matches User-agent header in robots.txt),
// label (display), provider (which AI engine it feeds), official (link to docs) }
export const AI_BOTS = [
  { name: 'GPTBot',           label: 'GPTBot',           provider: 'ChatGPT',     docs: 'https://platform.openai.com/docs/bots' },
  { name: 'OAI-SearchBot',    label: 'OAI-SearchBot',    provider: 'ChatGPT',     docs: 'https://platform.openai.com/docs/bots' },
  { name: 'ChatGPT-User',     label: 'ChatGPT-User',     provider: 'ChatGPT',     docs: 'https://platform.openai.com/docs/bots' },
  { name: 'Google-Extended',  label: 'Google-Extended',  provider: 'Gemini',      docs: 'https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers' },
  { name: 'GoogleOther',      label: 'GoogleOther',      provider: 'Gemini',      docs: 'https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers' },
  { name: 'ClaudeBot',        label: 'ClaudeBot',        provider: 'Claude',      docs: 'https://support.anthropic.com/en/articles/8896518' },
  { name: 'Claude-Web',       label: 'Claude-Web',       provider: 'Claude',      docs: 'https://support.anthropic.com/en/articles/8896518' },
  { name: 'anthropic-ai',     label: 'anthropic-ai',     provider: 'Claude',      docs: 'https://support.anthropic.com/en/articles/8896518' },
  { name: 'PerplexityBot',    label: 'PerplexityBot',    provider: 'Perplexity',  docs: 'https://docs.perplexity.ai/guides/bots' },
  { name: 'Perplexity-User',  label: 'Perplexity-User',  provider: 'Perplexity',  docs: 'https://docs.perplexity.ai/guides/bots' },
  { name: 'CCBot',            label: 'CCBot (CommonCrawl)', provider: 'training-data', docs: 'https://commoncrawl.org/ccbot' },
  { name: 'Bytespider',       label: 'Bytespider',       provider: 'ByteDance/TikTok', docs: 'https://bytespider.bytedance.com' },
];

import { fetchWithTimeout as universalFetchWithTimeout } from '../util/fetch-with-timeout.js';

const FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, opts = {}) {
  const { timeoutMs, ...fetchInit } = opts;
  return universalFetchWithTimeout(url, { ...fetchInit, redirect: 'follow' }, {
    timeoutMs: timeoutMs || FETCH_TIMEOUT_MS,
    kind: 'site',
  });
}

/**
 * Parse robots.txt into per-user-agent rule blocks.
 * Returns { groups: [{ userAgents: [...], allow: [...], disallow: [...] }] }.
 *
 * Spec quirks handled:
 *   - Multiple consecutive `User-agent:` lines share the same rule block
 *   - Comments (`#`) are stripped
 *   - Case-insensitive matching of directive names
 *   - Empty Disallow ("Disallow:") = allow everything
 */
export function parseRobotsTxt(text) {
  if (!text || typeof text !== 'string') return { groups: [], sitemaps: [] };

  const lines = text.split(/\r?\n/);
  const groups = [];
  const sitemaps = [];

  let current = null;
  let lastWasUserAgent = false;

  for (const rawLine of lines) {
    const line = rawLine.split('#')[0].trim();
    if (!line) {
      lastWasUserAgent = false;
      continue;
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const directive = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (directive === 'user-agent') {
      if (!lastWasUserAgent || !current) {
        current = { userAgents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.userAgents.push(value);
      lastWasUserAgent = true;
    } else if (directive === 'allow' && current) {
      current.allow.push(value);
      lastWasUserAgent = false;
    } else if (directive === 'disallow' && current) {
      current.disallow.push(value);
      lastWasUserAgent = false;
    } else if (directive === 'sitemap') {
      sitemaps.push(value);
      lastWasUserAgent = false;
    } else {
      lastWasUserAgent = false;
    }
  }

  return { groups, sitemaps };
}

/**
 * Determine whether a given AI bot is allowed to crawl the root path.
 *
 * Returns one of:
 *   - 'allowed'    — explicit User-agent block exists, root not disallowed
 *   - 'blocked'    — explicit `Disallow: /` for this bot (or `*` covering it)
 *   - 'partial'    — disallows specific paths but root is OK
 *   - 'unspecified' — no rule at all; default-allow, but worth flagging
 *
 * Spec: User-agent matching is case-insensitive substring on bot name.
 */
export function checkBotAccess(parsed, botName) {
  if (!parsed || !Array.isArray(parsed.groups) || parsed.groups.length === 0) {
    return 'unspecified';
  }
  const lowerBot = botName.toLowerCase();

  let matched = null;
  let wildcard = null;

  for (const group of parsed.groups) {
    for (const ua of group.userAgents) {
      const lowerUa = ua.toLowerCase().trim();
      if (lowerUa === '*') {
        wildcard = group;
      } else if (lowerUa === lowerBot || lowerUa.includes(lowerBot)) {
        matched = group;
      }
    }
  }

  const evaluate = (group) => {
    if (!group) return null;
    // Per robots.txt spec, an empty Disallow value means "no restriction"
    // and should not count as a real disallow rule.
    const realDisallows = group.disallow.filter(d => d !== '');
    if (realDisallows.includes('/')) return 'blocked';
    if (realDisallows.length === 0) return 'allowed';
    return 'partial';
  };

  return evaluate(matched) || evaluate(wildcard) || 'unspecified';
}

/**
 * Run the full crawlability audit on a domain. Returns an object that gets
 * stored verbatim in `_summary.json::crawlability` and rendered by the section.
 */
export async function auditCrawlability(domain, { fetchImpl = fetchWithTimeout } = {}) {
  if (!domain || typeof domain !== 'string') {
    throw new Error('auditCrawlability: domain required');
  }
  const cleanDomain = domain.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const baseUrl = `https://${cleanDomain}`;

  // robots.txt
  let robotsResult = { url: `${baseUrl}/robots.txt`, found: false, status: null, parsed: null, error: null };
  try {
    const res = await fetchImpl(robotsResult.url);
    robotsResult.status = res.status;
    if (res.ok) {
      const text = await res.text();
      robotsResult.found = true;
      robotsResult.parsed = parseRobotsTxt(text);
      robotsResult.bytes = text.length;
    }
  } catch (err) {
    robotsResult.error = err.message || String(err);
  }

  // /llms.txt — emerging convention for LLM-friendly summaries
  let llmsResult = { url: `${baseUrl}/llms.txt`, found: false, status: null, error: null };
  try {
    const res = await fetchImpl(llmsResult.url);
    llmsResult.status = res.status;
    llmsResult.found = res.ok;
    if (res.ok) llmsResult.bytes = (await res.text()).length;
  } catch (err) {
    llmsResult.error = err.message || String(err);
  }

  // sitemap.xml — fall back to robots.txt-declared sitemap if direct fetch 404s
  let sitemapResult = { url: `${baseUrl}/sitemap.xml`, found: false, status: null, error: null, urlCount: 0 };
  try {
    const res = await fetchImpl(sitemapResult.url);
    sitemapResult.status = res.status;
    if (res.ok) {
      const text = await res.text();
      sitemapResult.found = true;
      sitemapResult.urlCount = (text.match(/<loc>/g) || []).length;
    }
  } catch (err) {
    sitemapResult.error = err.message || String(err);
  }

  if (!sitemapResult.found && robotsResult.parsed?.sitemaps?.length > 0) {
    sitemapResult.declaredInRobots = robotsResult.parsed.sitemaps;
  }

  // Per-bot verdicts
  const botAccess = AI_BOTS.map(bot => ({
    ...bot,
    access: checkBotAccess(robotsResult.parsed, bot.name),
  }));

  const blocked = botAccess.filter(b => b.access === 'blocked');
  const allowed = botAccess.filter(b => b.access === 'allowed');
  const partial = botAccess.filter(b => b.access === 'partial');
  const unspecified = botAccess.filter(b => b.access === 'unspecified');

  return {
    domain: cleanDomain,
    ranAt: new Date().toISOString(),
    robots: robotsResult,
    llmsTxt: llmsResult,
    sitemap: sitemapResult,
    botAccess,
    summary: {
      totalBots: AI_BOTS.length,
      blockedCount: blocked.length,
      allowedCount: allowed.length,
      partialCount: partial.length,
      unspecifiedCount: unspecified.length,
      hasRobots: robotsResult.found,
      hasLlmsTxt: llmsResult.found,
      hasSitemap: sitemapResult.found,
    },
  };
}
