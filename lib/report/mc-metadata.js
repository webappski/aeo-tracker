/**
 * AEO Mission Control metadata builder.
 *
 * Produces a privacy-stripped, structured snapshot of a tracker run that the
 * customer pastes into webappski.com/portal/aeo-mission-control to receive a
 * personalised AEO action plan grounded in their data.
 *
 * STRICT ALLOW-LIST construction. Never Object.assign / spread the raw summary
 * — every field is explicitly named below. Any field not listed here is dropped.
 *
 * DENY-LIST (NEVER included in the metadata payload):
 *   - results[].responseExcerpt        (PII risk: AI model verbatim text)
 *   - results[].canonicalCitations     (size + privacy: full URL list per cell)
 *   - results[].queryText              (private: customer's keyword strategy)
 *   - results[].extractionSources      (internal model debug data)
 *   - results[].competitorsUnverified  (internal model-disagreement signal)
 *   - results[].elapsedMs              (telemetry)
 *   - results[].inputTokens            (cost telemetry)
 *   - results[].outputTokens           (cost telemetry)
 *   - results[].costUsd                (cost telemetry)
 *   - sessionCostUsd                   (cost telemetry — customer API spend)
 *   - costByModel[]                    (cost telemetry breakdown)
 *   - outreachTemplates[]              (LLM-drafted PII: emails / pitch bodies)
 *   - llmActions[]                     (internal cache of LLM responses)
 *
 * Schema source-of-truth:
 *   docs/ecosystem/mc-architecture/10-metadata-schema-validated.md (v1.0)
 *
 * @module mc-metadata
 */

import { clusterQueries } from './topic-cluster.js';
import { computeComponents, computeUVI } from './visibility-index.js';

const SCHEMA_VERSION = '1.1';

/**
 * Build the metadata payload from the latest snapshot.
 *
 * @param {Object} summary    latest _summary.json
 * @param {Object[]} snapshots  full ordered snapshot history (for basket cutoff dates)
 * @param {Object} opts
 * @param {string} opts.trackerVersion   semver of the running tracker
 * @param {string} [opts.lang='en']      tracker config language
 * @param {Object} [opts.config]         parsed .aeo-tracker.json (for basketHistory)
 * @returns {Object} the metadata object — JSON-serialisable, ready for clipboard
 */
export function buildMcMetadata(summary, snapshots = [], opts = {}) {
  const trackerVersion = opts.trackerVersion || 'unknown';
  const lang = opts.lang || 'en';

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    tracker: {
      version: trackerVersion,
      runDate: summary.date,
    },
    identity: {
      brand: summary.brand || '',
      domain: summary.domain || '',
      lang,
    },
    aggregates: aggregates(summary),
    scores: scores(summary),
    perEngine: perEngine(summary),
    perCell: perCell(summary),
    topCompetitors: topCompetitors(summary),
    topCanonicalSources: topCanonicalSources(summary),
    topCitationDomains: topCitationDomains(summary),
    crawl: crawl(summary),
    authority: authority(summary),
    topics: topics(summary),
    basket: basket(summary, snapshots, opts.config),
    // v1.1 fields. Each is null if the underlying tracker section is absent.
    // Portal handles null per schema rule "if X is null, do NOT make
    // recommendations grounded in X".
    pageSignals: pageSignals(summary),
    entityGraph: entityGraph(summary),
    competitorPricing: competitorPricing(summary),
    regionContext: regionContext(summary),
    responseFreshness: responseFreshness(summary),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// v1.1: Page signals (own-domain HTML crawl)

function pageSignals(summary) {
  const ps = summary.pageSignals;
  if (!ps || !ps.homepage || ps.homepage.ok !== true) return null;
  const h = ps.homepage;
  return {
    domain: ps.domain || null,
    fetchedAt: h.fetchedAt || null,
    headings: {
      h1Count: numOr(h.headings?.h1?.count, 0),
      h2Count: numOr(h.headings?.h2?.count, 0),
      h1Samples: Array.isArray(h.headings?.h1?.samples) ? h.headings.h1.samples.slice(0, 3) : [],
    },
    answerCapsules: {
      totalH2: numOr(h.answerCapsules?.totalH2, 0),
      withCapsule: numOr(h.answerCapsules?.withCapsule, 0),
      coverage: numOr(h.answerCapsules?.coverage, 0),
    },
    schemaOrg: {
      blockCount: numOr(h.schemaOrg?.blockCount, 0),
      types: Array.isArray(h.schemaOrg?.types) ? h.schemaOrg.types.slice(0, 10) : [],
      hasOrganization: !!h.schemaOrg?.hasOrganization,
      hasFaqPage: !!h.schemaOrg?.hasFaqPage,
      hasBreadcrumb: !!h.schemaOrg?.hasBreadcrumb,
      hasPerson: !!h.schemaOrg?.hasPerson,
      hasArticle: !!h.schemaOrg?.hasArticle,
    },
    faq: {
      schemaCount: numOr(h.faq?.schemaCount, 0),
      heuristicCount: numOr(h.faq?.heuristicCount, 0),
      total: numOr(h.faq?.total, 0),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// v1.1: Entity graph (cross-platform sameAs verification)

function entityGraph(summary) {
  const eg = summary.entityGraph;
  if (!eg || eg.ok !== true) return null;
  return {
    domain: eg.domain || null,
    sameAsCount: numOr(eg.sameAsCount, 0),
    edges: Array.isArray(eg.edges) ? eg.edges.slice(0, 20).map(e => ({
      url: e.url,
      platform: e.platform || 'unknown',
      host: e.host || null,
      status: e.status || 'unreachable',
      confidence: e.confidence || 'low',
    })) : [],
    summary: {
      reciprocates: numOr(eg.summary?.reciprocates, 0),
      oneWay: numOr(eg.summary?.oneWay, 0),
      unreachable: numOr(eg.summary?.unreachable, 0),
      verifiedHost: numOr(eg.summary?.verifiedHost, 0),
      brokenLink: numOr(eg.summary?.brokenLink, 0),
      reciprocityRate: numOr(eg.summary?.reciprocityRate, 0),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// v1.1: Competitor pricing tiers (public competitor pricing pages)

/**
 * Maximum share of competitor-pricing rows allowed to be `tier: "unknown"`
 * OR `confidence: "low"` before the block is treated as low-signal and
 * suppressed from the MC metadata payload. A 5-row table with 4 unknowns
 * is noise dressed as data — the one usable row is better surfaced via
 * the qualitative competitor section. Raw data is still preserved in
 * `_summary.json::competitorPricing` for export consumers.
 */
const PRICING_LOW_SIGNAL_THRESHOLD = 0.8;

/**
 * Returns true when ≥PRICING_LOW_SIGNAL_THRESHOLD of competitor-pricing
 * rows have no usable verdict (`tier: "unknown"` or `confidence: "low"`).
 * Exposed for tests and downstream MD/HTML render gates.
 *
 * @param {Array<{tier?: string, confidence?: string}>} rows
 * @returns {boolean}
 */
export function isCompetitorPricingLowSignal(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return true;
  const lowSignal = rows.filter(
    r => (r?.tier || 'unknown') === 'unknown' || (r?.confidence || 'low') === 'low'
  ).length;
  return (lowSignal / rows.length) >= PRICING_LOW_SIGNAL_THRESHOLD;
}

function competitorPricing(summary) {
  const cp = summary.competitorPricing;
  if (!Array.isArray(cp) || cp.length === 0) return null;
  // Suppress block when overwhelmingly unknown/low — caller should not render
  // a 5-row table where only 1 row carries a real verdict. Raw data still
  // lives in `_summary.json::competitorPricing` for export consumers.
  if (isCompetitorPricingLowSignal(cp)) return null;
  return cp.slice(0, 10).map(c => ({
    name: c.name,
    domain: c.domain || null,
    tier: c.tier || 'unknown',
    entryPrice: typeof c.entryPrice === 'number' ? c.entryPrice : null,
    confidence: c.confidence || 'low',
    pricingSource: c.pricingSource || null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// v1.1: Region context (per-engine + aggregated geo signals)

/**
 * Returns true when `summary.regionContext` carries no usable region signal
 * — no `dominantRegion`, AND no per-cell signal with a `detectedRegion`.
 * This is the shape the tracker emits when `--geo` was not used (the field
 * still ships as `{ aggregate: { dominantRegion: null }, perCell: [] }`),
 * and rendering that object as if it were data is misleading. Exposed for
 * tests and downstream MD/HTML render gates.
 *
 * @param {Object} regionCtx  `summary.regionContext` shape
 * @returns {boolean}
 */
export function isRegionContextEmpty(regionCtx) {
  if (!regionCtx || !regionCtx.aggregate) return true;
  const cells = Array.isArray(regionCtx.perCell) ? regionCtx.perCell : [];
  const anyDetected = cells.some(c => c && c.detectedRegion);
  return !regionCtx.aggregate.dominantRegion && cells.length === 0 && !anyDetected;
}

function regionContext(summary) {
  const rc = summary.regionContext;
  if (!rc || !rc.aggregate) return null;
  // Suppress block when no region signal exists — `--geo` was not used and
  // the field carries empty defaults. Rendering the null/empty shape as if
  // it were data is misleading. Raw data still lives in `_summary.json`.
  if (isRegionContextEmpty(rc)) return null;
  return {
    aggregate: {
      dominantRegion: rc.aggregate.dominantRegion || null,
      confidence: rc.aggregate.confidence || 'none',
      mixedSignals: !!rc.aggregate.mixedSignals,
      perRegion: rc.aggregate.perRegion || {},
      perProvider: rc.aggregate.perProvider || {},
    },
    // Per-cell signals are useful for plan generation but don't include the
    // full TLD distribution arrays — keep aggregated counts only.
    perCell: Array.isArray(rc.perCell) ? rc.perCell.slice(0, 30).map(c => ({
      provider: c.provider,
      detectedRegion: c.detectedRegion,
      confidence: c.confidence || 'low',
      source: c.source || null,
    })) : [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// v1.1: Response freshness (training cutoff inference)
// Privacy: drops `cutoffPhrases` per-cell (verbatim LLM quotes — possible PII);
// retains only counts + verdicts.

function responseFreshness(summary) {
  const rf = summary.responseFreshness;
  if (!rf || !rf.aggregate) return null;
  const cells = Array.isArray(rf.perCell) ? rf.perCell : [];
  return {
    overall: rf.aggregate.overall || 'unknown',
    counts: {
      fresh: numOr(rf.aggregate.counts?.fresh, 0),
      stale: numOr(rf.aggregate.counts?.stale, 0),
      unknown: numOr(rf.aggregate.counts?.unknown, 0),
      total: numOr(rf.aggregate.counts?.total, 0),
    },
    perProvider: rf.aggregate.perProvider || {},
    // Drop verbatim cutoffPhrases (PII risk); keep verdicts + counts only
    perCell: cells.slice(0, 30).map(c => ({
      provider: c.provider,
      freshness: c.freshness || 'unknown',
      confidence: c.confidence || 'low',
      latestYearMentioned: typeof c.latestYearMentioned === 'number' ? c.latestYearMentioned : null,
      usedWebSearch: !!c.usedWebSearch,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregates

function aggregates(summary) {
  const results = summary.results || [];
  const totalQueries = new Set(results.map(r => r.query)).size;
  const providerCount = new Set(results.map(r => r.provider)).size;
  const regions = Array.from(new Set(results.map(r => r.region).filter(Boolean)));

  return {
    score: numOr(summary.score, 0),
    mentions: numOr(summary.mentions, 0),
    total: numOr(summary.total, results.length),
    totalQueries,
    providerCount,
    regions,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scores (UVI components — DELEGATED to lib/report/visibility-index.js so the
// MC JSON brand-context block stays byte-aligned with the markdown/HTML report.
//
// Earlier versions of this function re-implemented the formula inline and
// drifted on four axes:
//   - presence    counted `src` at 0.5 weight (canonical counts at 1.0)
//   - rank        used position decay × 10  (canonical uses × 15)
//   - sentiment   averaged all labels  (canonical excludes low-confidence
//                                       neutral tie-breaks — Bug 3)
//   - citation    keyed on `hasBrandInCitations` flag (canonical scans
//                                       `canonicalCitations` for domain substring)
//   - empty cells returned citation: null while populated cells returned 0–100
//
// Delegating to computeComponents/computeUVI eliminates the drift class.
// Returns the additional sample-size fields so downstream consumers can
// distinguish "measured 0" from "not measured this run".

function scores(summary) {
  const components = computeComponents(summary);
  return {
    uvi: numOr(summary.score, computeUVI(components)),
    presence: components.presence,
    sentiment: components.sentiment,
    rank: components.rank,
    citation: components.citation,
    sample: components.sample,
    sentimentSample: components.sentimentSample,
    rankSample: components.rankSample,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-engine aggregations

function perEngine(summary) {
  // Per-engine UVI sub-components — DELEGATED to visibility-index.js for the
  // same reason as scores() above. Each provider's cells are re-wrapped in a
  // single-provider summary so computeComponents sees them as a self-contained
  // run and produces canonical {presence, sentiment, rank, citation}.
  const results = summary.results || [];
  const byProvider = new Map();
  for (const r of results) {
    if (!byProvider.has(r.provider)) {
      byProvider.set(r.provider, {
        provider: r.provider,
        label: r.label || r.provider,
        model: r.model || null,
        cells: [],
      });
    }
    byProvider.get(r.provider).cells.push(r);
  }

  return Array.from(byProvider.values()).map(p => {
    const cells = p.cells;
    const total = cells.length;
    const hits = cells.filter(c => c.mention === 'yes' || c.mention === 'src').length;
    const pct = total === 0 ? 0 : Math.round((hits / total) * 100);

    const sub = computeComponents({ domain: summary.domain, results: cells });

    return {
      provider: p.provider,
      label: p.label,
      model: p.model,
      hits,
      total,
      pct,
      presence: sub.presence,
      sentiment: sub.sentiment,
      rank: sub.rank,
      citation: sub.citation,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-cell — strict allow-list (NO responseExcerpt, NO canonicalCitations,
// NO queryText, NO cost/token telemetry).

function perCell(summary) {
  const results = summary.results || [];
  return results.map(r => ({
    queryId: r.query,
    provider: r.provider,
    mention: r.mention || 'no',
    position: r.position == null ? null : r.position,
    citationCount: numOr(r.citationCount, 0),
    competitors: Array.isArray(r.competitors) ? r.competitors.slice(0, 10) : [],
    responseQuality: r.responseQuality || 'narrative',
    hasBrandInCitations: !!r.hasBrandInCitations,
    sentiment: r.sentiment ? {
      label: r.sentiment.label || 'neutral',
      confidence: r.sentiment.confidence || 'low',
      // Note: rationale dropped — can be verbose / contain quoted PII
    } : null,
    region: r.region || null,
    tag: r.tag || null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Top competitors / sources / citation domains

function topCompetitors(summary) {
  const list = Array.isArray(summary.topCompetitors) ? summary.topCompetitors : [];
  return list.slice(0, 10).map(c => ({
    name: c.name,
    mentionCount: numOr(c.count, 0),
    verified: c.verified !== false, // default to true (legacy entries)
  }));
}

function topCanonicalSources(summary) {
  const list = Array.isArray(summary.topCanonicalSources) ? summary.topCanonicalSources : [];
  return list.slice(0, 10).map(s => ({
    url: s.url,
    count: numOr(s.count, 0),
  }));
}

function topCitationDomains(summary) {
  // Aggregate from results[].citationDomains if present; fall back to topCanonicalSources by host.
  const byHost = new Map();
  for (const r of summary.results || []) {
    for (const d of r.citationDomains || []) {
      const host = (d.host || '').toLowerCase();
      if (!host) continue;
      byHost.set(host, (byHost.get(host) || 0) + numOr(d.count, 0));
    }
  }

  const classification = summary.citationClassification?.results || [];
  const classMap = new Map();
  for (const cls of classification) {
    classMap.set((cls.hostname || '').toLowerCase(), cls);
  }

  return Array.from(byHost.entries())
    .map(([host, count]) => {
      const cls = classMap.get(host) || {};
      return {
        host,
        count,
        category: cls.industry || null,
        onCategory: cls.onCategory == null ? null : !!cls.onCategory,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
}

// ─────────────────────────────────────────────────────────────────────────────
// Crawl

function crawl(summary) {
  const c = summary.crawlability || {};
  const s = c.summary || {};
  const robots = c.robots || {};
  const sitemap = c.sitemap || {};

  // Per-bot status from robots.groups (rule-based)
  const bots = [];
  const groups = robots.groups || [];
  for (const g of groups) {
    if (!g.userAgent) continue;
    bots.push({
      name: g.userAgent,
      status: g.allowsAll ? 'allowed'
        : g.disallowsAll ? 'blocked'
        : 'partial',
    });
  }

  return {
    hasRobotsTxt: !!s.hasRobots,
    hasLlmsTxt: !!s.hasLlmsTxt,
    hasSitemap: !!s.hasSitemap,
    sitemapUrlCount: numOr(sitemap.urlCount, 0),
    totalBots: numOr(s.totalBots, 0),
    allowedCount: numOr(s.allowedCount, 0),
    blockedCount: numOr(s.blockedCount, 0),
    bots,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Authority presence (Wikipedia + Reddit baseline + profile-specific extras
// like GitHub). Shape is additive: wiki/reddit always present even if empty
// so Mission Control's existing reader keeps working unchanged; new sources
// (`github`, future `hn`/`devto`) appear as extra keys only when computed.

function authority(summary) {
  const a = summary.authorityPresence || {};
  const wiki = a.wikipedia || {};
  const reddit = a.reddit || {};

  const out = {
    wikipedia: {
      found: !!wiki.found,
      type: wiki.found ? (wiki.isDisambiguation ? 'disambiguation' : 'article') : null,
      lastModified: wiki.lastModified || null,
    },
    reddit: {
      found: !!reddit.found,
      mentionCount: numOr(reddit.mentionCount, 0),
      topSubreddits: Array.isArray(reddit.topSubs)
        ? reddit.topSubs.slice(0, 5).map(s => typeof s === 'string' ? s : (s.name || ''))
            .filter(Boolean)
        : [],
    },
  };

  // Profile metadata — present on reports generated after the additive
  // upgrade. Older cached snapshots have no `.profile` field and `out.profile`
  // simply stays absent. Mission Control treats it as optional.
  if (a.profile && a.profile.type) {
    out.profile = { type: a.profile.type, extras: Array.isArray(a.profile.extras) ? a.profile.extras : [] };
  }

  // GitHub presence (dev-tool profile). Only emitted when fetched.
  if (a.github) {
    const gh = a.github;
    out.github = {
      found: !!gh.found,
      owner: gh.owner || null,
      ownerType: gh.ownerType || null,
      stars: numOr(gh.topRepo && gh.topRepo.stars, 0),
      forks: numOr(gh.topRepo && gh.topRepo.forks, 0),
      topRepoUrl: (gh.topRepo && gh.topRepo.url) || null,
    };
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Topic clusters (computed on-the-fly via topic-cluster module)

function topics(summary) {
  try {
    const clusters = clusterQueries(summary);
    return clusters.slice(0, 10).map(c => ({
      topic: c.topic,
      queryIds: (c.queries || []).map(q => q.id),
      hits: numOr(c.hits, 0),
      total: numOr(c.total, 0),
      rate: numOr(c.rate, 0),
    }));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Basket versioning. Reads `.aeo-tracker.json` basketVersion + basketHistory if
// available (config passed by caller). Falls back to v1 placeholder for legacy
// configs / standalone tests.

function basket(summary, snapshots, config) {
  const totalQueries = new Set((summary.results || []).map(r => r.query)).size;
  const earliestSnapshotDate = snapshots.length > 0 ? snapshots[0].date : summary.date;

  // Real basket history available — use it.
  if (config && Array.isArray(config.basketHistory) && config.basketHistory.length > 0) {
    const history = config.basketHistory;
    const current = history[history.length - 1];
    const initial = history[0];
    return {
      version: Number(config.basketVersion) || current.version || history.length,
      queriesAddedSince: current.since || earliestSnapshotDate,
      trendCutoff: initial.since || earliestSnapshotDate,
      totalQueries,
      kind: current.kind || 'initial',
    };
  }

  // Legacy fallback: assume v1 starting from earliest snapshot.
  return {
    version: 1,
    queriesAddedSince: earliestSnapshotDate,
    trendCutoff: earliestSnapshotDate,
    totalQueries,
    kind: 'initial',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
