/**
 * Authority-source presence checker — does the brand have a Wikipedia article?
 * Is it discussed in relevant subreddits? Is the org on GitHub (dev-tools)?
 *
 * Otterly recommends "PR + earned media + Reddit + Wikipedia" as core off-page
 * signals AI engines weight heavily. For dev-tool / OSS brands the relevant
 * authority signals are GitHub stars + npm / HN — added via authority-github
 * etc. and gated by authority-profiles.getAuthorityProfile().
 *
 *   - Wikipedia: Wikipedia REST API → page exists yes/no, lastModified, URL
 *   - Reddit:    old.reddit.com search JSON → match count + top subreddits
 *   - GitHub:    REST search + repo stats (only for dev-tool profile)
 *
 * All sources have free public APIs. GitHub honours optional GITHUB_TOKEN env
 * var (60 → 5000 req/h). All run once per report; result cached in
 * `_summary.json::authorityPresence`. Shape is **additive**: new sources are
 * extra keys alongside `wikipedia` and `reddit`, so existing readers keep
 * working without migration.
 */

import { fetchWithTimeout } from './_http.js';
import { getAuthorityProfile } from './authority-profiles.js';
import { checkGitHub } from './authority-github.js';

/**
 * Wikipedia REST summary — exact title match. We only check `en.wikipedia.org`
 * because that's the corpus most LLMs were trained on. Disambiguation pages
 * count as "found" but are flagged so the user knows it's not their brand.
 */
export async function checkWikipedia(brand, { fetchImpl = fetchWithTimeout } = {}) {
  if (!brand || typeof brand !== 'string') return { found: false, error: 'no brand' };
  const slug = encodeURIComponent(brand.trim().replace(/\s+/g, '_'));
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`;

  try {
    const res = await fetchImpl(url);
    if (res.status === 404) {
      return { found: false, status: 404, url, queryUrl: `https://en.wikipedia.org/wiki/${slug}` };
    }
    if (!res.ok) {
      return { found: false, status: res.status, url, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    return {
      found: true,
      title: data.title,
      type: data.type,                          // "standard" | "disambiguation"
      isDisambiguation: data.type === 'disambiguation',
      extract: typeof data.extract === 'string' ? data.extract.slice(0, 240) : '',
      pageUrl: data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${slug}`,
      lastModified: data.timestamp || null,
    };
  } catch (err) {
    return { found: false, error: err.message || String(err), url };
  }
}

/**
 * Reddit search — old.reddit.com supports a JSON endpoint that returns up to
 * 25 results without auth. We count matches and report the top 5 subreddits
 * where the brand surfaces. This is "discoverable in social proof?", not
 * "what do people say?" — sentiment requires another module pass.
 */
export async function checkReddit(brand, { fetchImpl = fetchWithTimeout, limit = 25 } = {}) {
  if (!brand || typeof brand !== 'string') return { found: false, error: 'no brand' };

  // Strip embedded double-quotes so the wrapping quote-pair stays balanced;
  // wrap multi-word brands so the search is exact-match.
  const cleaned = brand.replace(/"/g, '');
  const q = cleaned.includes(' ') ? `"${cleaned}"` : cleaned;
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=relevance&limit=${limit}`;

  try {
    const res = await fetchImpl(url);
    if (!res.ok) {
      return { found: false, status: res.status, error: `HTTP ${res.status}`, url };
    }
    const data = await res.json();
    const posts = data.data?.children || [];
    if (posts.length === 0) {
      return { found: false, mentionCount: 0, topSubs: [], url };
    }

    const subCounts = new Map();
    for (const p of posts) {
      const sub = p.data?.subreddit;
      if (!sub) continue;
      subCounts.set(sub, (subCounts.get(sub) || 0) + 1);
    }
    const topSubs = Array.from(subCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    return {
      found: true,
      mentionCount: posts.length,
      capped: posts.length === limit,
      topSubs,
      sampleTitle: posts[0]?.data?.title?.slice(0, 140) || '',
      url,
    };
  } catch (err) {
    return { found: false, error: err.message || String(err), url };
  }
}

/**
 * Run baseline (wiki + reddit) + profile-specific extras in parallel and
 * return a combined object for caching in `_summary.json::authorityPresence`.
 *
 * Shape is **additive**: existing readers (mc-metadata, section render) keep
 * working without migration; new keys (`github`, future `hn`/`devto`) appear
 * only when the profile asks for them.
 *
 * @param {string} brand — display name (passed to all source checkers)
 * @param {object} [opts]
 * @param {string} [opts.domain] — owned domain (needed for github disambiguation)
 * @param {string} [opts.category] — short category text for profile detection
 * @param {object} [opts.pageSignals] — page-signals output (headings used
 *   as category fallback when init didn't fill category)
 * @param {string} [opts.githubTokenEnv] — env-var name (not value); default 'GITHUB_TOKEN'
 * @param {Function} [opts.fetchImpl] — injectable for tests
 * @returns {Promise<object>} `{brand, ranAt, profile, wikipedia, reddit, github?}`
 */
export async function checkAuthorityPresence(brand, opts = {}) {
  const profile = getAuthorityProfile({
    brand,
    domain: opts.domain,
    category: opts.category,
    pageSignals: opts.pageSignals,
  });

  // Baseline tasks — always run, regardless of profile.
  const tasks = {
    wikipedia: checkWikipedia(brand, opts),
    reddit:    checkReddit(brand, opts),
  };

  // Extras — opt-in by profile. Each extra obeys the same `{found, ...}`
  // result contract so the section renderer can iterate uniformly.
  if (profile.extras.includes('github')) {
    tasks.github = checkGitHub({
      brand,
      domain: opts.domain,
      tokenEnv: opts.githubTokenEnv || 'GITHUB_TOKEN',
      fetchImpl: opts.fetchImpl,
    });
  }

  const keys = Object.keys(tasks);
  const results = await Promise.all(keys.map(k => tasks[k]));
  const sources = {};
  keys.forEach((k, i) => { sources[k] = results[i]; });

  return {
    brand,
    ranAt: new Date().toISOString(),
    profile,           // {type, extras, caveat}
    ...sources,        // wikipedia, reddit, github?, ... — additive top-level keys
  };
}
