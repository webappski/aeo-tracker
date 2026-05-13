import assert from 'node:assert/strict';
import { computeComponents, computeUVI, computeDiscoverability } from '../lib/report/visibility-index.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\ncomputeComponents');

test('all-mentions-positive perfect run', () => {
  const c = computeComponents({
    domain: 'acme.com',
    results: [
      { mention: 'yes', position: 1, sentiment: { label: 'positive' }, canonicalCitations: ['https://acme.com/x'] },
      { mention: 'yes', position: 1, sentiment: { label: 'positive' }, canonicalCitations: ['https://acme.com/y'] },
    ],
  });
  assert.equal(c.presence, 100);
  assert.equal(c.sentiment, 100);
  assert.equal(c.rank, 100);
  assert.equal(c.citation, 100);
});

test('zero mentions yields no-signal: presence/citation 0, sentiment/rank null', () => {
  const c = computeComponents({
    domain: 'acme.com',
    results: [
      { mention: 'no', position: null, canonicalCitations: [] },
      { mention: 'no', position: null, canonicalCitations: [] },
    ],
  });
  assert.equal(c.presence, 0);
  // sentiment/rank are null (signal absent) — not 50, not 0. A 0 reading
  // would let them be averaged into the UVI weighted sum at full weight,
  // which is what produced phantom-neutral inflation in earlier versions.
  assert.equal(c.sentiment, null);
  assert.equal(c.rank, null);
  assert.equal(c.citation, 0);
});

test('error cells excluded from sample', () => {
  const c = computeComponents({
    domain: 'a.com',
    results: [
      { mention: 'yes', position: 1, canonicalCitations: [] },
      { mention: 'error' },
    ],
  });
  assert.equal(c.sample, 1);
  assert.equal(c.presence, 100);
});

test('rank degrades with position', () => {
  const c = computeComponents({
    domain: 'a.com',
    results: [{ mention: 'yes', position: 5, canonicalCitations: [] }],
  });
  // 100 - (5-1)*15 = 40
  assert.equal(c.rank, 40);
});

test('empty results → presence 0, sentiment/rank null (no signal)', () => {
  const c = computeComponents({ results: [] });
  assert.equal(c.presence, 0);
  assert.equal(c.sentiment, null); // null = absent signal; not 0, not phantom-neutral 50
  assert.equal(c.rank, null);
  assert.equal(computeUVI(c), 0); // weightSum collapses to 0 when all components null/0
});

// ─── BUG 2 — rank null when never measured ───

test('rank: all-null position cells → rank null (excluded from UVI)', () => {
  const c = computeComponents({
    domain: 'acme.com',
    results: [
      { mention: 'yes', position: null, sentiment: { label: 'positive', confidence: 'high' }, canonicalCitations: ['https://acme.com/x'] },
      { mention: 'yes', position: null, sentiment: { label: 'positive', confidence: 'high' }, canonicalCitations: ['https://acme.com/y'] },
    ],
  });
  // No cell has a numeric position → rank null, NOT a 50 fallback.
  assert.equal(c.rank, null);
  assert.equal(c.rankSample, 0);
  // UVI re-normalises remaining weights. presence + sentiment + citation
  // (0.35 + 0.25 + 0.20 = 0.80) → re-weighted to 1.0 →
  // (100*0.35 + 100*0.25 + 100*0.20) / 0.80 = 100.
  assert.equal(computeUVI(c), 100);
});

test('rank: mixed null/numeric positions use only numeric cells', () => {
  const c = computeComponents({
    domain: 'a.com',
    results: [
      { mention: 'yes', position: 1,    canonicalCitations: [] },
      { mention: 'yes', position: null, canonicalCitations: [] },
      { mention: 'yes', position: 3,    canonicalCitations: [] },
    ],
  });
  // (100 + 70) / 2 = 85
  assert.equal(c.rank, 85);
  assert.equal(c.rankSample, 2);
});

// ─── BUG 3 — sentiment: low-confidence neutrals excluded ───

test('sentiment: low-confidence neutral tie-breaks excluded from composite', () => {
  const c = computeComponents({
    domain: 'a.com',
    results: [
      { mention: 'yes', position: 1, sentiment: { label: 'positive', confidence: 'high' }, canonicalCitations: [] },
      { mention: 'yes', position: 1, sentiment: { label: 'positive', confidence: 'high' }, canonicalCitations: [] },
      { mention: 'yes', position: 2, sentiment: { label: 'neutral',  confidence: 'low'  }, canonicalCitations: [] },
      { mention: 'yes', position: 2, sentiment: { label: 'neutral',  confidence: 'low'  }, canonicalCitations: [] },
      { mention: 'yes', position: 2, sentiment: { label: 'neutral',  confidence: 'low'  }, canonicalCitations: [] },
    ],
  });
  // Only the 2 high-confidence positives count → 100/100, n=2. Without the
  // exclusion the 3 fake neutrals would drag this to (200+150)/5 = 70.
  assert.equal(c.sentiment, 100);
  assert.equal(c.sentimentSample, 2);
});

test('sentiment: all low-conf-neutral → sentiment null, UVI re-weights', () => {
  const c = computeComponents({
    domain: 'a.com',
    results: [
      { mention: 'yes', position: 1, sentiment: { label: 'neutral', confidence: 'low' }, canonicalCitations: [] },
      { mention: 'yes', position: 1, sentiment: { label: 'neutral', confidence: 'low' }, canonicalCitations: [] },
    ],
  });
  assert.equal(c.sentiment, null);
  assert.equal(c.sentimentSample, 0);
  // presence=100, rank=100, citation=0 — sentiment excluded.
  // (100*0.35 + 100*0.20 + 0*0.20) / 0.75 = 73.33 → 73.
  assert.equal(computeUVI(c), 73);
});

test('sentiment: failed/empty confidence treated as no-signal', () => {
  const c = computeComponents({
    domain: 'a.com',
    results: [
      { mention: 'yes', position: 1, sentiment: { label: 'neutral',  confidence: 'failed' }, canonicalCitations: [] },
      { mention: 'yes', position: 1, sentiment: { label: 'positive', confidence: 'high'   }, canonicalCitations: [] },
    ],
  });
  assert.equal(c.sentiment, 100);
  assert.equal(c.sentimentSample, 1);
});

test('sentiment: low-confidence positive (not neutral) kept as signal', () => {
  // Low-confidence + non-neutral label means one model said positive and the
  // other failed — single-model fallback, NOT a tie-break. Still real signal.
  const c = computeComponents({
    domain: 'a.com',
    results: [
      { mention: 'yes', position: 1, sentiment: { label: 'positive', confidence: 'single-model' }, canonicalCitations: [] },
    ],
  });
  assert.equal(c.sentiment, 100);
  assert.equal(c.sentimentSample, 1);
});

console.log('\ncomputeUVI');

test('weighted sum of components', () => {
  const c = { presence: 100, sentiment: 100, rank: 100, citation: 100, sample: 5 };
  assert.equal(computeUVI(c), 100);
});

test('zero-everything → 0', () => {
  const c = { presence: 0, sentiment: 0, rank: 0, citation: 0, sample: 5 };
  assert.equal(computeUVI(c), 0);
});

test('mixed components → weighted result', () => {
  const c = { presence: 80, sentiment: 60, rank: 40, citation: 20, sample: 5 };
  // 80*0.35 + 60*0.25 + 40*0.20 + 20*0.20 = 28 + 15 + 8 + 4 = 55
  assert.equal(computeUVI(c), 55);
});

test('custom weights respected', () => {
  const c = { presence: 100, sentiment: 0, rank: 0, citation: 0, sample: 5 };
  assert.equal(computeUVI(c, { presence: 1, sentiment: 0, rank: 0, citation: 0 }), 100);
});

console.log('\ncomputeDiscoverability');

test('full readiness → 100', () => {
  const r = computeDiscoverability({
    summary: { totalBots: 12, blockedCount: 0, allowedCount: 12, hasRobots: true, hasLlmsTxt: true, hasSitemap: true },
  });
  assert.equal(r.score, 100);
});

test('robots missing → drops by 30%', () => {
  const r = computeDiscoverability({
    summary: { totalBots: 12, blockedCount: 0, allowedCount: 12, hasRobots: false, hasLlmsTxt: true, hasSitemap: true },
  });
  // 0*0.3 + 100*0.25 + 100*0.25 + 100*0.20 = 0 + 25 + 25 + 20 = 70
  assert.equal(r.score, 70);
});

test('all bots blocked → bot share component is 0', () => {
  const r = computeDiscoverability({
    summary: { totalBots: 12, blockedCount: 12, allowedCount: 0, hasRobots: true, hasLlmsTxt: true, hasSitemap: true },
  });
  // 100*0.3 + 0*0.25 + 100*0.25 + 100*0.20 = 30 + 0 + 25 + 20 = 75
  assert.equal(r.score, 75);
});

test('null crawlability → null result', () => {
  assert.equal(computeDiscoverability(null), null);
  assert.equal(computeDiscoverability({}), null);
});

test('breakdown notes are descriptive', () => {
  const r = computeDiscoverability({
    summary: { totalBots: 12, blockedCount: 3, allowedCount: 9, hasRobots: true, hasLlmsTxt: false, hasSitemap: true },
  });
  assert.ok(r.breakdown.llmsTxt.note.includes('missing'));
  assert.ok(r.breakdown.bots.note.includes('9/12'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
