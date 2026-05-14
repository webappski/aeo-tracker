// Tests for the recommendation-surface filters added in the May-2026 dogfood
// patch:
//   BUG 1 — own-domain self-pitch across «Where to get mentioned», «Actionable
//           Gaps» and «Actions this week» (Next Steps).
//   BUG 3 — «Industry mismatch» panel threshold gating (off-share + confidence).
//
// Pure-function tests — no provider calls, no I/O. Build minimal snapshot
// fixtures inline so behaviour is local to the assertion.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  sectionCanonicalSources,
  sectionNextSteps,
  sectionActionableGaps,
  sectionDisambiguationWarning,
} from '../lib/report/sections.js';
import { normaliseOwnDomain, isOwnDomain } from '../lib/report/own-domain.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch(err => { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); });
}

// ─── normaliseOwnDomain / isOwnDomain ───

console.log('\nnormaliseOwnDomain / isOwnDomain');

await test('normaliseOwnDomain strips protocol, www, trailing slash, casing', () => {
  assert.equal(normaliseOwnDomain('https://WWW.TypelessForm.com/'), 'typelessform.com');
});

await test('normaliseOwnDomain returns "" for blank input', () => {
  assert.equal(normaliseOwnDomain(''), '');
  assert.equal(normaliseOwnDomain(null), '');
  assert.equal(normaliseOwnDomain(undefined), '');
});

await test('isOwnDomain matches exact domain and subdomains', () => {
  assert.equal(isOwnDomain('typelessform.com',       'typelessform.com'), true);
  assert.equal(isOwnDomain('www.typelessform.com',   'typelessform.com'), true);
  assert.equal(isOwnDomain('blog.typelessform.com',  'typelessform.com'), true);
  assert.equal(isOwnDomain('g2.com',                 'typelessform.com'), false);
  // Lookalike collision: a different domain ending in "...form.com" must NOT match.
  assert.equal(isOwnDomain('notypelessform.com',     'typelessform.com'), false);
});

await test('isOwnDomain returns false when ownDomain is blank', () => {
  assert.equal(isOwnDomain('anything.com', ''), false);
});

await test('normaliseOwnDomain strips :port, ?query, #fragment', () => {
  // Real failure shape from the May-2026 dogfood run: citation URLs
  // sometimes parsed into hosts with port suffixes / query leak, which
  // the original implementation passed through verbatim and missed.
  assert.equal(normaliseOwnDomain('typelessform.com:443'), 'typelessform.com');
  assert.equal(normaliseOwnDomain('https://typelessform.com:8443/blog'), 'typelessform.com');
  assert.equal(normaliseOwnDomain('typelessform.com?utm=x'), 'typelessform.com');
  assert.equal(normaliseOwnDomain('typelessform.com#section'), 'typelessform.com');
  assert.equal(normaliseOwnDomain('https://typelessform.com/?utm_source=openai'), 'typelessform.com');
});

await test('isOwnDomain matches port-suffixed and query-bearing hosts', () => {
  assert.equal(isOwnDomain('typelessform.com:443',                'typelessform.com'), true);
  assert.equal(isOwnDomain('typelessform.com?ref=openai',         'typelessform.com'), true);
  assert.equal(isOwnDomain('blog.typelessform.com:8080',          'typelessform.com'), true);
});

// ─── BUG 1: own-domain filter across sections ───

console.log('\nBUG 1 — own-domain not pitched to itself (sections)');

const BUG1_SNAPSHOT = {
  brand: 'Typeless Form',
  domain: 'typelessform.com',
  date: '2026-05-13',
  total: 9,
  // topDomains has the user's own domain at position 0 (the bug-trigger).
  topDomains: [
    { host: 'typelessform.com', count: 19, share: 0.30 },
    { host: 'g2.com',           count: 12, share: 0.19 },
    { host: 'capterra.com',     count: 8,  share: 0.13 },
  ],
  topCanonicalSources: [
    { url: 'https://typelessform.com/blog/post-a', count: 19 },
    { url: 'https://www.g2.com/categories/voice-forms', count: 12 },
    { url: 'https://capterra.com/p/voice-form', count: 8 },
  ],
  results: [
    {
      provider: 'openai', query: 'q1', queryText: 'q1 long text',
      mention: 'no', position: null,
      competitors: ['NoGood', 'Optimist'],
      competitorsUnverified: [],
      canonicalCitations: [
        // Own URL appears first in the cell — must be skipped.
        'https://typelessform.com/blog/post-a',
        'https://g2.com/cat',
      ],
    },
  ],
};

await test('Where to get mentioned: own domain absent from rendered table', () => {
  const md = sectionCanonicalSources([BUG1_SNAPSHOT]);
  assert.ok(md.length > 0, 'section should render with external domains');
  assert.ok(!md.includes('typelessform.com'), 'own domain must NOT appear in the table');
  assert.ok(md.includes('g2.com'),            'external domains must remain');
  assert.ok(md.includes('capterra.com'),      'external domains must remain');
});

await test('Actionable Gaps: action does not pitch own domain ("alongside" or "Get listed on")', () => {
  const md = sectionActionableGaps([BUG1_SNAPSHOT]);
  assert.ok(md.length > 0, 'section should render when gaps + competitors exist');
  assert.ok(!/typelessform\.com/.test(md), 'own domain must NOT appear in any Actionable Gaps row');
  // Sanity: action falls back to the next non-own host (g2.com) for the «alongside» variant.
  assert.ok(/g2\.com/.test(md) || /capterra\.com/.test(md) || /vs/.test(md),
    'falls back to external host or vs-page wording');
});

await test('Actions this week: no «Pitch a guest post on typelessform.com» step', () => {
  const md = sectionNextSteps([BUG1_SNAPSHOT]);
  // sectionNextSteps may emit other steps; just assert the self-pitch step is absent.
  assert.ok(!/Pitch a guest post.*typelessform\.com/.test(md),
    'must not suggest pitching the user\'s own domain to itself');
});

await test('subdomain of own domain is also filtered', () => {
  const snap = {
    ...BUG1_SNAPSHOT,
    topCanonicalSources: [
      { url: 'https://blog.typelessform.com/post', count: 12 },
      { url: 'https://g2.com/x',                   count: 6 },
    ],
    topDomains: [
      { host: 'blog.typelessform.com', count: 12, share: 0.5 },
      { host: 'g2.com',                count: 6,  share: 0.25 },
    ],
  };
  const md = sectionCanonicalSources([snap]);
  assert.ok(!md.includes('typelessform.com'), 'subdomain of own must also be filtered');
  assert.ok(md.includes('g2.com'));
});

// ─── BUG 3: Industry mismatch threshold gating ───

console.log('\nBUG 3 — Industry-mismatch panel threshold');

function snapWithClassification(off, on) {
  return {
    brand: 'X', domain: 'x.com',
    citationClassification: {
      offCategoryDomains: off,
      onCategoryDomains:  on,
    },
    results: [],
  };
}

await test('suppressed: off-share below 30% (one off, three on)', () => {
  const md = sectionDisambiguationWarning([snapWithClassification(
    [{ hostname: 'customs.pl', industry: 'EU customs', confidence: 'high' }],
    [
      { hostname: 'g2.com',       industry: 'reviews', confidence: 'high' },
      { hostname: 'capterra.com', industry: 'reviews', confidence: 'high' },
      { hostname: 'reddit.com',   industry: 'forum',   confidence: 'high' },
    ],
  )]);
  assert.equal(md, '', 'below 30% off-share → panel suppressed');
});

await test('suppressed: off-share ≥ 30% but mostly low-confidence verdicts (real BUG 3 case)', () => {
  // Mirrors the typelessform.com dogfood: 2 off-category entries both flagged
  // as low-confidence «UNKNOWN / likely noise». Panel must NOT fire.
  const md = sectionDisambiguationWarning([snapWithClassification(
    [
      { hostname: 'sayfill.com',     industry: 'UNKNOWN / likely noise', confidence: 'low' },
      { hostname: 'agentfillai.com', industry: 'UNKNOWN / likely noise', confidence: 'low' },
    ],
    [
      { hostname: 'g2.com', industry: 'reviews', confidence: 'high' },
      { hostname: 'capterra.com', industry: 'reviews', confidence: 'high' },
    ],
  )]);
  assert.equal(md, '', 'low-confidence off-category entries → panel suppressed');
});

await test('fires: off-share ≥ 30% AND ≥ 70% high-confidence', () => {
  const md = sectionDisambiguationWarning([snapWithClassification(
    [
      { hostname: 'customs.pl',    industry: 'EU customs',     confidence: 'high' },
      { hostname: 'aeotrade.com',  industry: 'export logistics', confidence: 'high' },
    ],
    [
      { hostname: 'g2.com', industry: 'reviews', confidence: 'high' },
      { hostname: 'reddit.com', industry: 'forum', confidence: 'high' },
    ],
  )]);
  assert.ok(md.includes('Industry mismatch'), 'high-confidence systematic mismatch → panel renders');
  assert.ok(md.includes('customs.pl'));
});

await test('suppressed: empty classification (no domains classified at all)', () => {
  const md = sectionDisambiguationWarning([snapWithClassification([], [])]);
  assert.equal(md, '');
});

await test('fired panel uses the v0.3.0 CLI flag form, not the obsolete --refresh-keywords', () => {
  // The pre-fix copy suggested `aeo-tracker init --refresh-keywords --category=...`
  // — but `--refresh-keywords` is NOT a recognised flag in v0.3.0+ (only
  // --queries-only, --add-queries, --replace-queries exist in parseArgs).
  // Pasting the suggested command would have produced «unknown option» errors.
  const md = sectionDisambiguationWarning([snapWithClassification(
    [
      { hostname: 'customs.pl',    industry: 'EU customs',     confidence: 'high' },
      { hostname: 'aeotrade.com',  industry: 'export logistics', confidence: 'high' },
    ],
    [
      { hostname: 'g2.com', industry: 'reviews', confidence: 'high' },
    ],
  )]);
  assert.ok(md.includes('--queries-only'),
    'must reference --queries-only (the v0.3.0 mechanism for re-running query gen)');
  assert.ok(!md.includes('--refresh-keywords'),
    'must NOT reference the non-existent --refresh-keywords flag');
  assert.ok(md.includes('--category='),
    'must show the --category override that drives the actual disambiguation');
});

await test('threshold edge: classifier has only one off-category entry → no fire', () => {
  // Single-entry pool — share is high (100% if it's the only off), confidence
  // could be high, BUT base rate is tiny. The 30% off-share threshold against
  // a one-entry pool is satisfied trivially. Test what behaviour the threshold
  // pair actually produces: with on=2 and off=1, off-share = 1/3 ≈ 33.3% > 30%
  // AND high-conf-share = 100% ≥ 70% — so the panel SHOULD fire. This pins the
  // threshold pair's behaviour on the smallest non-trivial pool.
  const md = sectionDisambiguationWarning([snapWithClassification(
    [{ hostname: 'customs.pl', industry: 'EU customs', confidence: 'high' }],
    [
      { hostname: 'g2.com',       industry: 'reviews', confidence: 'high' },
      { hostname: 'capterra.com', industry: 'reviews', confidence: 'high' },
    ],
  )]);
  // 1/(1+2) = 33% ≥ 30%, 1/1 = 100% ≥ 70% → fires
  assert.ok(md.includes('Industry mismatch'),
    'one-third off-share with high confidence still trips the threshold (documented behaviour)');
});

await test('threshold edge: single off-category + 5 on-category → suppressed (below 30%)', () => {
  // The «one acronym collision in an otherwise correct vertical» case the
  // 30% threshold is designed to filter out. 1 off / 6 total = 16.7% < 30%.
  const md = sectionDisambiguationWarning([snapWithClassification(
    [{ hostname: 'customs.pl', industry: 'EU customs', confidence: 'high' }],
    [
      { hostname: 'g2.com',       industry: 'reviews', confidence: 'high' },
      { hostname: 'capterra.com', industry: 'reviews', confidence: 'high' },
      { hostname: 'reddit.com',   industry: 'forum',   confidence: 'high' },
      { hostname: 'wikipedia.org', industry: 'reference', confidence: 'high' },
      { hostname: 'producthunt.com', industry: 'launchpad', confidence: 'high' },
    ],
  )]);
  assert.equal(md, '', 'isolated off-category entry in an otherwise correct pool is suppressed');
});

// ─── BUG: Actionable Gaps must downgrade unverified-tier competitors ───
//
// Reproduces the May-2026 typelessform.com Q2/Gemini cell — gpt-5.4-mini
// flagged retailers-as-customers (Amazon/Walmart/Starbucks) as competitors,
// gemini-2.5-flash returned empty, so the two-model extractor parked them in
// `competitorsUnverified`. The Actionable Gaps renderer was treating the
// unverified-tier as if it were verified — producing a bold-red
// «Pitch vellis.financial to add typelessform alongside Amazon» action that
// the README explicitly promises will not happen.
//
// Fixture: test/fixtures/q2-gemini-unverified-retailers.json (real run trim).

console.log('\nBUG — Actionable Gaps respects verified vs unverified competitor tiers');

const Q2_GEMINI_CELL = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'q2-gemini-unverified-retailers.json'), 'utf-8')
);
delete Q2_GEMINI_CELL._README;

function snapshotWithCell(cell, extraResults = []) {
  return {
    brand: 'TypelessForm',
    domain: 'typelessform.com',
    date: '2026-05-13',
    total: 1 + extraResults.length,
    topDomains: [],
    topCanonicalSources: [],
    results: [cell, ...extraResults],
  };
}

await test('Q2/Gemini fixture (Amazon/Walmart/Starbucks unverified-only) → no bold-red «Pitch» action', () => {
  const md = sectionActionableGaps([snapshotWithCell(Q2_GEMINI_CELL)]);
  assert.ok(md.length > 0, 'section should render — unverified-only cell still surfaces, just softened');
  // Strong pitch wording with «alongside Amazon/Walmart/Starbucks» was the bug.
  assert.ok(!/Pitch \*\*[^*]+\*\* to add .* alongside (Amazon|Walmart|Starbucks)/.test(md),
    'must NOT promote unverified retailers to a «Pitch X alongside Amazon» action');
  // Softened diagnostic wording is the contract — README promises «dashed
  // badges = weaker signal, surfaced honestly».
  assert.ok(/Cross-check this cell|only one extractor model flagged/i.test(md),
    'must use the softened «Cross-check this cell» wording for unverified-only rows');
});

await test('unverified-tier badges carry the dashed-variant attribute', () => {
  const md = sectionActionableGaps([snapshotWithCell(Q2_GEMINI_CELL)]);
  // Reuse the existing cell-badge shape with a `data-unverified="1"` attr —
  // styles.css applies the dashed border via the [data-unverified] selector.
  assert.ok(/data-unverified="1"/.test(md),
    'unverified competitor chips must carry the dashed-variant data attribute');
  assert.ok(md.includes('Amazon') && md.includes('Walmart') && md.includes('Starbucks'),
    'unverified brand names are still visible in the table (so the reader sees what was flagged)');
});

await test('cell with zero verified AND zero unverified is excluded entirely', () => {
  // No displacement signal at all — keeping the row would add noise.
  const emptyCell = {
    query: 'Q3', provider: 'openai',
    queryText: 'where to find best coffee in toronto',
    mention: 'no', competitors: [], competitorsUnverified: [],
    canonicalCitations: [],
  };
  const md = sectionActionableGaps([snapshotWithCell(emptyCell)]);
  assert.equal(md, '', 'no verified + no unverified competitors → section does not render this cell');
});

await test('mixed verified + unverified row gets the strong action, not the softened one', () => {
  // Verified takes priority: when at least one model-agreed competitor exists,
  // the action is the standard «Pitch X alongside Y» — unverified names still
  // appear as dashed chips in the «Cited instead» column, but they do not
  // trigger the diagnostic copy.
  const mixedCell = {
    query: 'Q4', provider: 'openai',
    queryText: 'voice autofill checkout',
    mention: 'no',
    competitors: ['AnveVoice'],
    competitorsUnverified: ['NoisyRetailer'],
    canonicalCitations: ['https://g2.com/voice-form'],
  };
  const md = sectionActionableGaps([snapshotWithCell(mixedCell)]);
  assert.ok(/Pitch \*\*g2\.com\*\* to add TypelessForm alongside AnveVoice/.test(md),
    'mixed row uses the standard pitch action targeting the VERIFIED competitor');
  assert.ok(!/Cross-check this cell/.test(md),
    'mixed row does not use softened wording — verified bucket is non-empty');
  // The unverified chip is still rendered with the dashed variant so the reader
  // sees what the cross-check disagreed on.
  assert.ok(/NoisyRetailer/.test(md) && /data-unverified="1"/.test(md),
    'unverified chip still appears with the dashed-variant attribute');
});

await test('verified-only cell uses the standard solid-red badge (no dashed attr)', () => {
  const verifiedCell = {
    query: 'Q5', provider: 'gemini',
    queryText: 'voice autofill',
    mention: 'no',
    competitors: ['AnveVoice', 'SayFill'],
    competitorsUnverified: [],
    canonicalCitations: ['https://g2.com/x'],
  };
  const md = sectionActionableGaps([snapshotWithCell(verifiedCell)]);
  // AnveVoice's chip must be the solid-tone variant, not dashed.
  const anveChip = md.match(/<span class="cell-badge"[^>]*>AnveVoice<\/span>/);
  assert.ok(anveChip, 'verified competitor must render as solid cell-badge');
  assert.ok(!/AnveVoice[^<]*<\/span>.*data-unverified/.test(md),
    'verified-only cell must NOT carry the data-unverified attribute');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
