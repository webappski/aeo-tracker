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

test('zero mentions yields all zeros (no signal, not phantom-neutral)', () => {
  const c = computeComponents({
    domain: 'acme.com',
    results: [
      { mention: 'no', position: null, canonicalCitations: [] },
      { mention: 'no', position: null, canonicalCitations: [] },
    ],
  });
  assert.equal(c.presence, 0);
  assert.equal(c.sentiment, 0); // was 50; phantom-neutral inflated UVI to 13/100 for 0/0/0 runs
  assert.equal(c.rank, 0);
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

test('empty results → all zeros (no signal)', () => {
  const c = computeComponents({ results: [] });
  assert.equal(c.presence, 0);
  assert.equal(c.sentiment, 0); // was 50; corrected so empty runs read 0/100 not 13/100
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
