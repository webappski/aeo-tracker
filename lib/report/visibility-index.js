/**
 * Unified Visibility Index (UVI) — a single 0-100 score that combines four
 * signals from a run into one number, with transparent weights you can audit.
 *
 * Inspired by Rankability's "SPI" but open — no proprietary scoring,
 * everything is documented and verifiable from `_summary.json`.
 *
 *   UVI = w1·presence + w2·sentiment + w3·rank + w4·citation
 *
 * Default weights:
 *   - presence  35%   (% of cells where brand was mentioned)
 *   - sentiment 25%   (avg sentiment, 50 = neutral)
 *   - rank      20%   (avg position strength when listed)
 *   - citation  20%   (% of cells where brand appeared in a citation URL)
 *
 * Designed so each component is independently meaningful and the user can
 * spot which signal dragged the index down.
 */

const DEFAULT_WEIGHTS = {
  presence: 0.35,
  sentiment: 0.25,
  rank: 0.20,
  citation: 0.20,
};

const SENTIMENT_VALUE = { positive: 100, neutral: 50, negative: 0 };

/**
 * Compute the four sub-components from a `_summary.json`-shaped object.
 * Pure function — easy to unit-test, easy to surface in the report.
 */
export function computeComponents(latest) {
  const results = (latest?.results || []).filter(r => r.mention !== 'error');
  const total = results.length;

  if (total === 0) {
    return { presence: 0, sentiment: 0, rank: 0, citation: 0, sample: 0 };
  }

  // Presence — share of non-error cells where brand was mentioned
  const mentioned = results.filter(r => r.mention === 'yes' || r.mention === 'src').length;
  const presence = (mentioned / total) * 100;

  // Sentiment — average across cells that have sentiment data. When NOTHING
  // is mentioned (no signal at all) we score 0, not 50. Falling back to 50
  // ("neutral") added a phantom 12.5pt to UVI for fully-invisible brands —
  // a 0/0/0/50 run rendered as 13/100 with no underlying mention to justify it.
  const withSentiment = results.filter(r => r.sentiment?.label);
  const sentiment = withSentiment.length > 0
    ? withSentiment.reduce((s, r) => s + (SENTIMENT_VALUE[r.sentiment.label] ?? 50), 0) / withSentiment.length
    : 0;

  // Rank — average position strength (lower position = higher score). Only
  // counts cells where brand appeared in body (mention === 'yes' with a
  // numeric position). 0 when never named.
  const ranked = results.filter(r => r.mention === 'yes' && typeof r.position === 'number' && r.position > 0);
  const rank = ranked.length > 0
    ? ranked.reduce((s, r) => s + Math.max(0, 100 - (r.position - 1) * 15), 0) / ranked.length
    : (mentioned > 0 ? 50 : 0);

  // Citation share — share of cells where the brand domain appeared in a
  // canonical citation URL. Independent of body-mention so it surfaces
  // "AI cited my page but didn't name me" patterns.
  const citationCells = results.filter(r => {
    const cites = r.canonicalCitations || [];
    if (cites.length === 0) return false;
    const dom = (latest.domain || '').toLowerCase();
    return cites.some(u => u.toLowerCase().includes(dom));
  }).length;
  const citation = (citationCells / total) * 100;

  return {
    presence: Math.round(presence),
    sentiment: Math.round(sentiment),
    rank: Math.round(rank),
    citation: Math.round(citation),
    sample: total,
  };
}

/**
 * Compute the composite UVI score from components and weights.
 */
export function computeUVI(components, weights = DEFAULT_WEIGHTS) {
  const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  const total = w.presence + w.sentiment + w.rank + w.citation;
  const norm = total > 0 ? total : 1;
  const score = (
    components.presence * w.presence +
    components.sentiment * w.sentiment +
    components.rank * w.rank +
    components.citation * w.citation
  ) / norm;
  return Math.round(score);
}

/**
 * Discoverability score — composite of crawlability inputs (robots.txt,
 * /llms.txt, sitemap.xml, AI bot access). Range 0-100. Pure derivation from
 * the audit object — no extra fetches.
 *
 * Weighting:
 *   - 30% — robots.txt present and not blocking key bots
 *   - 25% — share of AI bots NOT blocked (allowed + partial + unspecified)
 *   - 25% — sitemap.xml present with URL count > 0
 *   - 20% — /llms.txt present
 */
export function computeDiscoverability(crawlability) {
  if (!crawlability || !crawlability.summary) return null;
  const s = crawlability.summary;
  const total = s.totalBots || 1;
  const notBlocked = total - (s.blockedCount || 0);
  const botShare = notBlocked / total;

  const robotsScore   = s.hasRobots  ? 100 : 0;
  const botsScore     = botShare * 100;
  const sitemapScore  = s.hasSitemap ? 100 : 0;
  const llmsTxtScore  = s.hasLlmsTxt ? 100 : 0;

  const score = (
    robotsScore  * 0.30 +
    botsScore    * 0.25 +
    sitemapScore * 0.25 +
    llmsTxtScore * 0.20
  );

  return {
    score: Math.round(score),
    breakdown: {
      robots:   { value: Math.round(robotsScore),  weight: 0.30, note: s.hasRobots ? 'present' : 'missing' },
      // notBlocked = allowed + partial + unspecified (matches the score formula).
      // Earlier versions reported `allowedCount/total`, which understated the
      // signal whenever sites had no robots.txt at all (all bots → unspecified).
      bots:     { value: Math.round(botsScore),    weight: 0.25, note: `${notBlocked}/${total} bots not blocked` },
      sitemap:  { value: Math.round(sitemapScore), weight: 0.25, note: s.hasSitemap ? 'present' : 'missing' },
      llmsTxt:  { value: Math.round(llmsTxtScore), weight: 0.20, note: s.hasLlmsTxt ? 'present' : 'missing — emerging convention' },
    },
  };
}
