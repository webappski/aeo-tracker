// Tests for the empty/low-signal render-decision patch added in the
// May-2026 dogfood patch:
//   BUG 1 — Visibility Trend + per-query sparklines suppressed when run count
//           is below the «meaningful» threshold (statistical noise dressed as
//           data when N < 4).
//   BUG 2 — Topical Visibility Clusters suppressed when topics.length < 3
//           (1 cluster = the whole brand, not a cluster).
//   BUG 3 — competitorPricing field dropped from MC metadata payload when
//           ≥80% of rows are tier=unknown OR confidence=low.
//   BUG 4 — regionContext field dropped from MC metadata payload when no
//           region signal exists (no --geo run, empty perCell, null
//           dominantRegion).
//   BUG 5 — «Where to get mentioned» deny-list filters generic dev-hosting
//           and dead tutorial sites; section suppressed with muted note when
//           nothing remains.
//
// Pure-function tests — no provider calls, no I/O. Build minimal snapshot
// fixtures inline so behaviour is local to the assertion.

import assert from 'node:assert/strict';
import {
  sectionTrend,
  sectionHistoricalTrend,
  sectionTopicClusters,
  sectionCanonicalSources,
  sectionActionableGaps,
  sectionNextSteps,
  topCitedHostsForProvider,
  isDenyListedOutreachHost,
  OUTREACH_HOST_DENY_LIST,
  TREND_MIN_RUNS,
  TOPIC_CLUSTER_MIN,
} from '../lib/report/sections.js';
import {
  buildMcMetadata,
  isCompetitorPricingLowSignal,
  isRegionContextEmpty,
} from '../lib/report/mc-metadata.js';
import { filterOwnDomainFromTopDomains } from '../lib/report/outreach-templates.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch(err => { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); });
}

// Build minimal snapshot fixtures inline. `score` is the only numeric field
// the trend block consumes; results[] keeps queries unique so sectionTrend
// has something to project sparklines over.
function buildSnapshot({ date, score, queries = ['Q1'] }) {
  return {
    date,
    score,
    brand: 'Acme',
    domain: 'acme.com',
    results: queries.map(q => ({
      query: q,
      queryText: `query ${q}`,
      provider: 'openai',
      mention: 'yes',
    })),
  };
}

// ─── BUG 1: Trend suppression below TREND_MIN_RUNS ───

console.log('\nBUG 1 — Visibility Trend + Trend per Query');

await test('TREND_MIN_RUNS constant is exported and is 4 (matches README)', () => {
  assert.equal(TREND_MIN_RUNS, 4);
});

await test('sectionHistoricalTrend suppressed at 2 runs → muted placeholder', () => {
  const snapshots = [
    buildSnapshot({ date: '2026-04-23', score: 10 }),
    buildSnapshot({ date: '2026-05-13', score: 20 }),
  ];
  const out = sectionHistoricalTrend(snapshots);
  assert.equal(out.includes('## Visibility Trend'), false, 'must NOT render the chart heading');
  assert.equal(out.includes('available from week 4'), true, 'must show muted placeholder');
  assert.equal(out.includes('2 of 4 runs collected'), true, 'must report current run count');
});

await test('sectionTrend (per-query sparklines) suppressed at 2 runs', () => {
  const snapshots = [
    buildSnapshot({ date: '2026-04-23', score: 10, queries: ['Q1', 'Q2'] }),
    buildSnapshot({ date: '2026-05-13', score: 20, queries: ['Q1', 'Q2'] }),
  ];
  const out = sectionTrend(snapshots);
  assert.equal(out.includes('## Trend per Query'), false, 'must NOT render per-query heading');
  assert.equal(out.includes('available from week 4'), true, 'must show muted placeholder');
});

await test('sectionHistoricalTrend renders at 4 runs (threshold met)', () => {
  const snapshots = [
    buildSnapshot({ date: '2026-04-22', score: 10 }),
    buildSnapshot({ date: '2026-04-29', score: 15 }),
    buildSnapshot({ date: '2026-05-06', score: 20 }),
    buildSnapshot({ date: '2026-05-13', score: 25 }),
  ];
  const out = sectionHistoricalTrend(snapshots);
  assert.equal(out.includes('## Visibility Trend'), true, 'chart heading present');
  assert.equal(out.includes('available from week 4'), false, 'placeholder must be gone');
});

await test('sectionTrend renders at 4 runs (threshold met)', () => {
  const snapshots = Array.from({ length: 4 }, (_, i) =>
    buildSnapshot({ date: `2026-05-${10 + i}`, score: 10 * (i + 1), queries: ['Q1'] }),
  );
  const out = sectionTrend(snapshots);
  assert.equal(out.includes('## Trend per Query'), true, 'per-query heading present');
});

// ─── BUG 2: Topic clusters suppression below TOPIC_CLUSTER_MIN ───

console.log('\nBUG 2 — Topical Visibility Clusters');

await test('TOPIC_CLUSTER_MIN constant is exported and is 3', () => {
  assert.equal(TOPIC_CLUSTER_MIN, 3);
});

// Helper — build a snapshot where clusterQueries() naturally finds N clusters
// by giving N groups of 2 queries each sharing a distinctive token, and NO
// shared words across groups. The clusterer assigns each query to its
// highest-frequency token (≥2), so duplicate per-group keywords create a
// per-keyword bucket.
function snapshotWithClusters(groupTokens) {
  const fillers = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'zeta'];
  const results = [];
  groupTokens.forEach((tok, gi) => {
    const filler = fillers[gi % fillers.length];
    for (let i = 0; i < 2; i++) {
      results.push({
        query: `Q${gi}-${i}`,
        // Each cluster has a unique distinctive token (tok) repeated 2× +
        // a unique filler word repeated 2×. The distinctive token also
        // happens to be alphabetically last to disambiguate ties via the
        // "longer token wins" rule in clusterQueries.
        queryText: `${filler} ${tok}-bucket`,
        provider: 'openai',
        mention: 'yes',
      });
    }
  });
  return { date: '2026-05-13', score: 50, brand: 'Acme', domain: 'acme.com', results };
}

await test('sectionTopicClusters suppressed when 1 cluster surfaces', () => {
  const out = sectionTopicClusters([snapshotWithClusters(['crm'])]);
  assert.equal(out, '', '1 cluster = whole brand, not a cluster — must be empty');
});

await test('sectionTopicClusters suppressed when 2 clusters surface', () => {
  const out = sectionTopicClusters([snapshotWithClusters(['crm', 'invoice'])]);
  assert.equal(out, '', '2 clusters still below threshold');
});

await test('sectionTopicClusters renders at 3 clusters (threshold met)', () => {
  const out = sectionTopicClusters([snapshotWithClusters(['crm', 'invoice', 'payment'])]);
  assert.equal(out.includes('## Topical Visibility Clusters'), true, 'heading present at N=3');
});

// ─── BUG 3: competitorPricing low-signal suppression ───

console.log('\nBUG 3 — competitorPricing in MC metadata');

await test('isCompetitorPricingLowSignal: 4/5 unknown → true', () => {
  const rows = [
    { tier: 'unknown', confidence: 'low' },
    { tier: 'unknown', confidence: 'low' },
    { tier: 'unknown', confidence: 'low' },
    { tier: 'unknown', confidence: 'low' },
    { tier: 'free',    confidence: 'med' },
  ];
  assert.equal(isCompetitorPricingLowSignal(rows), true);
});

await test('isCompetitorPricingLowSignal: 1/5 unknown → false (4 usable)', () => {
  const rows = [
    { tier: 'free',    confidence: 'med' },
    { tier: 'low',     confidence: 'high' },
    { tier: 'mid',     confidence: 'high' },
    { tier: 'high',    confidence: 'high' },
    { tier: 'unknown', confidence: 'low' },
  ];
  assert.equal(isCompetitorPricingLowSignal(rows), false);
});

await test('isCompetitorPricingLowSignal: empty array → true (no data)', () => {
  assert.equal(isCompetitorPricingLowSignal([]), true);
});

await test('buildMcMetadata: competitorPricing dropped when 4/5 unknown', () => {
  const summary = {
    date: '2026-05-13', brand: 'Acme', domain: 'acme.com', results: [],
    competitorPricing: [
      { name: 'A', tier: 'unknown', confidence: 'low' },
      { name: 'B', tier: 'unknown', confidence: 'low' },
      { name: 'C', tier: 'unknown', confidence: 'low' },
      { name: 'D', tier: 'unknown', confidence: 'low' },
      { name: 'E', tier: 'free',    confidence: 'med' },
    ],
  };
  const md = buildMcMetadata(summary, [], { trackerVersion: '0.3.1' });
  assert.equal(md.competitorPricing, null, 'low-signal block must be null');
});

await test('buildMcMetadata: competitorPricing rendered when 4/5 usable', () => {
  const summary = {
    date: '2026-05-13', brand: 'Acme', domain: 'acme.com', results: [],
    competitorPricing: [
      { name: 'A', tier: 'free', confidence: 'med' },
      { name: 'B', tier: 'low',  confidence: 'high' },
      { name: 'C', tier: 'mid',  confidence: 'high' },
      { name: 'D', tier: 'high', confidence: 'high' },
      { name: 'E', tier: 'unknown', confidence: 'low' },
    ],
  };
  const md = buildMcMetadata(summary, [], { trackerVersion: '0.3.1' });
  assert.ok(Array.isArray(md.competitorPricing), 'block must render as array');
  assert.equal(md.competitorPricing.length, 5);
});

// ─── BUG 4: regionContext suppressed when empty ───

console.log('\nBUG 4 — regionContext in MC metadata');

await test('isRegionContextEmpty: null dominant + empty perCell → true', () => {
  const rc = { aggregate: { dominantRegion: null, confidence: 'none' }, perCell: [] };
  assert.equal(isRegionContextEmpty(rc), true);
});

await test('isRegionContextEmpty: dominantRegion present → false', () => {
  const rc = { aggregate: { dominantRegion: 'DE', confidence: 'high' }, perCell: [] };
  assert.equal(isRegionContextEmpty(rc), false);
});

await test('isRegionContextEmpty: perCell has detectedRegion → false', () => {
  const rc = {
    aggregate: { dominantRegion: null, confidence: 'none' },
    perCell: [{ provider: 'gemini', detectedRegion: 'US', confidence: 'med' }],
  };
  assert.equal(isRegionContextEmpty(rc), false);
});

await test('isRegionContextEmpty: missing aggregate → true', () => {
  assert.equal(isRegionContextEmpty(null), true);
  assert.equal(isRegionContextEmpty({}), true);
});

await test('buildMcMetadata: regionContext dropped when no --geo signal', () => {
  const summary = {
    date: '2026-05-13', brand: 'Acme', domain: 'acme.com', results: [],
    regionContext: {
      aggregate: { dominantRegion: null, confidence: 'none' },
      perCell: [],
    },
  };
  const md = buildMcMetadata(summary, [], { trackerVersion: '0.3.1' });
  assert.equal(md.regionContext, null, 'empty regionContext must be null');
});

await test('buildMcMetadata: regionContext rendered when --geo produced signal', () => {
  const summary = {
    date: '2026-05-13', brand: 'Acme', domain: 'acme.com', results: [],
    regionContext: {
      aggregate: { dominantRegion: 'DE', confidence: 'high' },
      perCell: [{ provider: 'gemini', detectedRegion: 'DE', confidence: 'high' }],
    },
  };
  const md = buildMcMetadata(summary, [], { trackerVersion: '0.3.1' });
  assert.ok(md.regionContext, 'real region signal must render');
  assert.equal(md.regionContext.aggregate.dominantRegion, 'DE');
});

// ─── BUG 5: Outreach host deny-list ───

console.log('\nBUG 5 — Where to get mentioned: deny-list');

await test('OUTREACH_HOST_DENY_LIST includes documented developer/static hosts', () => {
  // Wildcard subdomain entries (the normal citation shape).
  const wildcards = ['.github.io', '.github.com', '.gitlab.io', '.netlify.app', '.vercel.app', '.glitch.me'];
  for (const e of wildcards) assert.ok(OUTREACH_HOST_DENY_LIST.includes(e), `missing wildcard entry: ${e}`);
  // Bare apex entries — github.com is deliberately EXCLUDED (the bare apex is
  // a legitimate outreach surface for repos / awesome-lists / READMEs).
  const bareApexes = ['github.io', 'gitlab.io', 'netlify.app', 'vercel.app', 'glitch.me', 'pages.dev', 'web.app', 'firebaseapp.com'];
  for (const e of bareApexes) assert.ok(OUTREACH_HOST_DENY_LIST.includes(e), `missing bare-apex entry: ${e}`);
  assert.ok(!OUTREACH_HOST_DENY_LIST.includes('github.com'),
    'github.com bare apex must remain a legitimate outreach target (repos, READMEs, awesome-lists)');
});

await test('OUTREACH_HOST_DENY_LIST includes documented tutorial sites', () => {
  const expected = ['teamtreehouse.com', 'w3schools.com', 'tutorialspoint.com'];
  for (const e of expected) assert.ok(OUTREACH_HOST_DENY_LIST.includes(e), `missing entry: ${e}`);
});

await test('isDenyListedOutreachHost: wildcard suffix matches subdomains', () => {
  assert.equal(isDenyListedOutreachHost('alice.github.io'), true);
  assert.equal(isDenyListedOutreachHost('my-project.vercel.app'), true);
  assert.equal(isDenyListedOutreachHost('demo.glitch.me'), true);
});

await test('isDenyListedOutreachHost: exact match for tutorial sites', () => {
  assert.equal(isDenyListedOutreachHost('teamtreehouse.com'), true);
  assert.equal(isDenyListedOutreachHost('w3schools.com'), true);
  assert.equal(isDenyListedOutreachHost('tutorialspoint.com'), true);
});

await test('isDenyListedOutreachHost: legitimate publications pass through', () => {
  assert.equal(isDenyListedOutreachHost('techcrunch.com'), false);
  assert.equal(isDenyListedOutreachHost('css-tricks.com'), false);
  assert.equal(isDenyListedOutreachHost('smashingmagazine.com'), false);
});

await test('isDenyListedOutreachHost: defensive on bad input', () => {
  assert.equal(isDenyListedOutreachHost(''), false);
  assert.equal(isDenyListedOutreachHost(null), false);
  assert.equal(isDenyListedOutreachHost(undefined), false);
});

await test('sectionCanonicalSources strips deny-listed hosts from the table', () => {
  const snapshot = {
    brand: 'Acme', domain: 'acme.com', results: [],
    topCanonicalSources: [
      { url: 'https://alice.github.io/post', count: 5 },
      { url: 'https://teamtreehouse.com/tutorial-x', count: 4 },
      { url: 'https://css-tricks.com/article-y', count: 3 },
      { url: 'https://smashingmagazine.com/feature-z', count: 2 },
    ],
    citationClassification: null, // no classification → all hosts on-category
  };
  const out = sectionCanonicalSources([snapshot]);
  assert.equal(out.includes('css-tricks.com'), true, 'legit publisher must remain');
  assert.equal(out.includes('smashingmagazine.com'), true, 'legit publisher must remain');
  assert.equal(out.includes('github.io'), false, 'github.io must be stripped');
  assert.equal(out.includes('teamtreehouse.com'), false, 'teamtreehouse must be stripped');
});

await test('sectionCanonicalSources: zero remaining → muted note, no table', () => {
  const snapshot = {
    brand: 'Acme', domain: 'acme.com', results: [],
    topCanonicalSources: [
      { url: 'https://alice.github.io/post', count: 5 },
      { url: 'https://teamtreehouse.com/x',  count: 4 },
      { url: 'https://w3schools.com/y',      count: 3 },
    ],
    citationClassification: null,
  };
  const out = sectionCanonicalSources([snapshot]);
  assert.equal(out.includes('No high-authority outreach targets'), true, 'muted note must surface');
  assert.equal(out.includes('| Site | Type | About |'), false, 'no table when all denylisted');
});

await test('isDenyListedOutreachHost: case-insensitive against mixed-case input', () => {
  // Hostnames are case-insensitive per RFC 3986; defensive coverage against
  // upstream extractors that don't normalise.
  assert.equal(isDenyListedOutreachHost('Alice.Github.IO'), true);
  assert.equal(isDenyListedOutreachHost('W3SCHOOLS.COM'), true);
});

await test('isDenyListedOutreachHost: bare apex of developer-hosting domains is denied', () => {
  // Regression — May-2026 typelessform.com dogfood run rendered «Pitch a
  // mention or guest post on github.io» in the «Where to get mentioned»
  // table. The bare apex of github.io / vercel.app / netlify.app / etc. has
  // no editorial surface; it is the hosting platform itself, not a publisher.
  // Both wildcard (`alice.github.io`) and bare (`github.io`) forms must be
  // denied per provider — see OUTREACH_HOST_DENY_LIST docs.
  assert.equal(isDenyListedOutreachHost('github.io'),       true);
  assert.equal(isDenyListedOutreachHost('gitlab.io'),       true);
  assert.equal(isDenyListedOutreachHost('vercel.app'),      true);
  assert.equal(isDenyListedOutreachHost('netlify.app'),     true);
  assert.equal(isDenyListedOutreachHost('glitch.me'),       true);
  assert.equal(isDenyListedOutreachHost('pages.dev'),       true);
  assert.equal(isDenyListedOutreachHost('web.app'),         true);
  assert.equal(isDenyListedOutreachHost('firebaseapp.com'), true);
});

await test('isDenyListedOutreachHost: defensive normalisation (trailing dot, www., mixed case)', () => {
  // Hostnames are case-insensitive (RFC 3986). DNS-root form `host.` and
  // www-prefix form `www.host` both appear in extractor output; the matcher
  // must canonicalise before comparing.
  assert.equal(isDenyListedOutreachHost('github.io.'),       true,  'trailing dot');
  assert.equal(isDenyListedOutreachHost('GitHub.IO'),        true,  'mixed case bare apex');
  assert.equal(isDenyListedOutreachHost('www.github.io'),    true,  'www-prefix bare apex');
  assert.equal(isDenyListedOutreachHost('Alice.Github.IO.'), true,  'subdomain + trailing dot');
});

// ─── BUG 5 spillover surfaces — same deny-list must apply everywhere ───

console.log('\nBUG 5 — deny-list must apply across ALL outreach surfaces');

await test('topCitedHostsForProvider strips deny-listed hosts', () => {
  // Engine-actions card was previously recommending «Pitch <github.io>» when
  // a github.io page was the most-cited host for an engine. Same deny-list as
  // sectionCanonicalSources must apply or the two surfaces disagree.
  const results = [
    { provider: 'openai', canonicalCitations: [
      'https://alice.github.io/a', 'https://alice.github.io/b',
      'https://css-tricks.com/x',
    ]},
  ];
  const out = topCitedHostsForProvider(results, 'openai', 'acme.com', 5);
  assert.deepEqual(out, ['css-tricks.com'], 'github.io must be filtered');
});

await test('sectionActionableGaps: cellHost skips deny-listed hosts', () => {
  // r.canonicalCitations[0] is github.io — the «Pitch X to add Acme alongside
  // CompetitorY» row must skip past it to the next non-deny-listed host.
  const snapshot = {
    brand: 'Acme', domain: 'acme.com',
    results: [{
      query: 'Q1', queryText: 'best crm', provider: 'openai',
      mention: 'no',
      competitors: ['Rival'], competitorsUnverified: [],
      canonicalCitations: ['https://my-project.github.io/post', 'https://g2.com/listing'],
    }],
    topDomains: [],
    topCanonicalSources: [],
  };
  const out = sectionActionableGaps([snapshot]);
  assert.equal(out.includes('Pitch **g2.com**'), true, 'must pick g2.com after skipping github.io');
  assert.equal(out.includes('github.io'), false, 'github.io must not surface');
});

await test('sectionActionableGaps: topDomainHost skips deny-listed top domain', () => {
  // No per-cell citations → fallback to topDomains[0]. The first entry is
  // github.io (deny-listed); the action must pick the next external host.
  const snapshot = {
    brand: 'Acme', domain: 'acme.com',
    results: [{
      query: 'Q1', queryText: 'best crm', provider: 'openai',
      mention: 'no',
      competitors: ['Rival'], competitorsUnverified: [],
      canonicalCitations: [],
    }],
    topDomains: [
      { host: 'my-project.github.io', count: 10 },
      { host: 'capterra.com',         count: 5 },
    ],
    topCanonicalSources: [],
  };
  const out = sectionActionableGaps([snapshot]);
  assert.equal(out.includes('Get listed on **capterra.com**'), true, 'must pick capterra after skipping github.io');
  assert.equal(out.includes('github.io'), false);
});

await test('sectionNextSteps: «pitch top source» skipped when top source is deny-listed', () => {
  // topCanonicalSources[0] is a github.io page; the «pitch a guest post»
  // step must not fire — there is no editor on a tenant container.
  const snapshot = {
    brand: 'Acme', domain: 'acme.com',
    score: 10,
    results: [],
    topCanonicalSources: [
      { url: 'https://alice.github.io/post', count: 9 },
    ],
    topCompetitors: [],
    citationClassification: null,
  };
  const out = sectionNextSteps([snapshot]);
  assert.equal(out.includes('alice.github.io'), false, 'github.io must not appear in next steps');
  assert.equal(out.includes('guest post / mention'), false, 'no «pitch guest post» step for deny-listed host');
});

await test('filterOwnDomainFromTopDomains strips deny-listed hosts (outreach LLM)', () => {
  // Outreach LLM was previously $0.001-burning drafts to alice.github.io.
  // Helper must filter both own-domain AND deny-listed hosts before the
  // prompt is built or the LLM is called.
  const out = filterOwnDomainFromTopDomains(
    [
      { host: 'acme.com',                count: 9, share: 0.30 },  // own
      { host: 'alice.github.io',         count: 8, share: 0.25 },  // denied
      { host: 'my-project.netlify.app',  count: 5, share: 0.18 },  // denied
      { host: 'g2.com',                  count: 4, share: 0.15 },  // keep
    ],
    'acme.com',
  );
  assert.deepEqual(out.map(d => d.host), ['g2.com']);
});

// ─── BUG 5b: bare-apex of developer-hosting domains leaks through ───
//
// May-2026 typelessform.com dogfood run: «Where to get mentioned» rendered
// `| github.io | Blog / agency | … | Pitch a mention or guest post |`.
// Root cause: the denylist entry `.github.io` was scoped to subdomains only,
// so the bare apex fell through every outreach surface. Fix added bare-apex
// entries to OUTREACH_HOST_DENY_LIST for every hosting provider. This block
// asserts the mixed scenario (bare apex + subdomain in same fixture) is
// suppressed across every outreach action surface in the report.

console.log('\nBUG 5b — bare-apex hosting domains must be denied across all outreach surfaces');

await test('end-to-end: bare github.io + alice.github.io never reach any outreach surface', () => {
  const snapshot = {
    brand: 'Acme', domain: 'acme.com', score: 10,
    results: [{
      query: 'Q1', queryText: 'best crm', provider: 'openai',
      mention: 'no',
      competitors: ['Rival'], competitorsUnverified: [],
      canonicalCitations: [
        'https://github.io/something',         // hallucinated bare apex
        'https://alice.github.io/something',   // real-shape subdomain
        'https://g2.com/listing',              // legit publisher
      ],
    }],
    topCanonicalSources: [
      { url: 'https://github.io/something',       count: 9 },  // hallucinated bare
      { url: 'https://alice.github.io/something', count: 7 },  // subdomain
      { url: 'https://g2.com/listing',            count: 5 },
    ],
    topDomains: [
      { host: 'github.io',        count: 9, share: 0.40 },  // hallucinated bare
      { host: 'alice.github.io',  count: 7, share: 0.31 },  // subdomain
      { host: 'g2.com',           count: 5, share: 0.22 },
    ],
    topCompetitors: [{ name: 'Rival', count: 1 }],
    citationClassification: null,
  };

  // Surface 1: «Where to get mentioned» table
  const canonical = sectionCanonicalSources([snapshot]);
  assert.equal(canonical.includes('github.io'), false,
    'github.io (bare or subdomain) must NOT appear in «Where to get mentioned»');
  assert.equal(canonical.includes('g2.com'), true,
    'legit publisher must still appear');

  // Surface 2: per-engine «Pitch <host>» card input
  const topHosts = topCitedHostsForProvider(snapshot.results, 'openai', 'acme.com', 5);
  assert.equal(topHosts.includes('github.io'), false,
    'github.io bare must not surface to engine-actions card');
  assert.equal(topHosts.includes('alice.github.io'), false,
    'alice.github.io subdomain must not surface to engine-actions card');
  assert.deepEqual(topHosts, ['g2.com'],
    'only legit publisher must reach engine-actions card');

  // Surface 3: «Actions this week» «pitch top source» step
  const nextSteps = sectionNextSteps([snapshot]);
  assert.equal(nextSteps.includes('github.io'), false,
    'github.io must not appear in «Actions this week»');

  // Surface 4: «Actionable Gaps» — «Pitch X to add brand alongside …»
  const gaps = sectionActionableGaps([snapshot]);
  assert.equal(gaps.includes('github.io'), false,
    'github.io must not appear as a «Pitch …» target in Actionable Gaps');
  assert.equal(gaps.includes('g2.com'), true,
    'legit publisher must reach Actionable Gaps');

  // Surface 5: outreach-template LLM prompt input (topDomains)
  const outreachInput = filterOwnDomainFromTopDomains(snapshot.topDomains, 'acme.com');
  assert.deepEqual(outreachInput.map(d => d.host), ['g2.com'],
    'outreach LLM must receive only legit publishers — no github.io spend');
});

await test('end-to-end: all-denylisted citations → muted fallback, no leak', () => {
  // Every candidate is denylisted (bare or subdomain across all hosting
  // providers). The fallback message must surface and no row must render.
  const snapshot = {
    brand: 'Acme', domain: 'acme.com', score: 5,
    results: [],
    topCanonicalSources: [
      { url: 'https://github.io/post',           count: 9 },
      { url: 'https://vercel.app/x',             count: 7 },
      { url: 'https://my-project.netlify.app/y', count: 6 },
      { url: 'https://w3schools.com/z',          count: 4 },
    ],
    citationClassification: null,
  };
  const out = sectionCanonicalSources([snapshot]);
  assert.equal(out.includes('No high-authority outreach targets surfaced this run.'), true,
    'muted fallback must surface when every candidate is denylisted');
  assert.equal(out.includes('| Site | Type | About |'), false,
    'no table when every candidate is denylisted');
  assert.equal(out.includes('github.io'), false);
  assert.equal(out.includes('vercel.app'), false);
  assert.equal(out.includes('netlify.app'), false);
  assert.equal(out.includes('w3schools.com'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
