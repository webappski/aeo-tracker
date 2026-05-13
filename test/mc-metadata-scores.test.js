// Tests for the MC metadata `scores()` and `perEngine()` blocks. These ship
// in the JSON brand-context the operator pastes into Mission Control and were
// drifting from `lib/report/visibility-index.js` on four axes:
//
//   - presence    counted `src` at 0.5  vs canonical 1.0
//   - rank        decay × 10            vs canonical × 15
//   - sentiment   averaged all labels   vs canonical excludes low-conf neutrals
//   - citation    `hasBrandInCitations` vs canonical canonical-citation substring
//
// `scores()` now delegates to `computeComponents` so the JSON block is byte-
// aligned with the markdown UVI table. These tests pin that contract.

import assert from 'node:assert/strict';
import { buildMcMetadata } from '../lib/report/mc-metadata.js';
import { computeComponents, computeUVI } from '../lib/report/visibility-index.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nmc-metadata.scores — byte-aligned with visibility-index');

test('scores agrees with computeComponents for a typical run', () => {
  const summary = {
    date: '2026-05-13', brand: 'X', domain: 'x.com', score: 42,
    results: [
      { provider: 'openai', query: 'q1', mention: 'yes', position: 1,
        sentiment: { label: 'positive', confidence: 'high' },
        canonicalCitations: ['https://x.com/a'] },
      { provider: 'openai', query: 'q2', mention: 'src', position: null,
        sentiment: { label: 'neutral', confidence: 'high' },
        canonicalCitations: ['https://x.com/b'] },
      { provider: 'openai', query: 'q3', mention: 'no', position: null,
        canonicalCitations: [] },
    ],
  };
  const md = buildMcMetadata(summary, [summary]);
  const canonical = computeComponents(summary);
  assert.equal(md.scores.presence,  canonical.presence,  'presence drift');
  assert.equal(md.scores.sentiment, canonical.sentiment, 'sentiment drift');
  assert.equal(md.scores.rank,      canonical.rank,      'rank drift');
  assert.equal(md.scores.citation,  canonical.citation,  'citation drift');
});

test('scores excludes low-confidence neutral tie-breaks (Bug 3 propagates)', () => {
  const summary = {
    date: '2026-05-13', brand: 'X', domain: 'x.com', score: 0,
    results: [
      { provider: 'openai', query: 'q1', mention: 'yes', position: 1,
        sentiment: { label: 'positive', confidence: 'high' },
        canonicalCitations: [] },
      { provider: 'openai', query: 'q2', mention: 'yes', position: 1,
        sentiment: { label: 'positive', confidence: 'high' },
        canonicalCitations: [] },
      { provider: 'openai', query: 'q3', mention: 'yes', position: 1,
        sentiment: { label: 'neutral', confidence: 'low' },
        canonicalCitations: [] },
      { provider: 'openai', query: 'q4', mention: 'yes', position: 1,
        sentiment: { label: 'neutral', confidence: 'low' },
        canonicalCitations: [] },
      { provider: 'openai', query: 'q5', mention: 'yes', position: 1,
        sentiment: { label: 'neutral', confidence: 'low' },
        canonicalCitations: [] },
    ],
  };
  const md = buildMcMetadata(summary, [summary]);
  assert.equal(md.scores.sentiment, 100,
    'low-confidence neutral tie-breaks must NOT drag a 100/100 sentiment down to 70');
  assert.equal(md.scores.sentimentSample, 2, 'effective sample = 2 high-confidence cells');
});

test('scores returns rank null (not 50) when no cell has position data', () => {
  const summary = {
    date: '2026-05-13', brand: 'X', domain: 'x.com', score: 0,
    results: [
      { provider: 'openai', query: 'q1', mention: 'yes', position: null,
        sentiment: { label: 'positive', confidence: 'high' },
        canonicalCitations: ['https://x.com/a'] },
    ],
  };
  const md = buildMcMetadata(summary, [summary]);
  assert.equal(md.scores.rank, null);
  assert.equal(md.scores.rankSample, 0);
});

test('scores returns null components when run has zero cells', () => {
  const summary = {
    date: '2026-05-13', brand: 'X', domain: 'x.com', score: 0,
    results: [],
  };
  const md = buildMcMetadata(summary, [summary]);
  assert.equal(md.scores.presence,  0);
  assert.equal(md.scores.sentiment, null);
  assert.equal(md.scores.rank,      null);
  // Citation MUST be 0 (not null) — share-of-cells with 0 cells is 0 by
  // construction, same as `computeComponents`. Earlier ad-hoc impl returned
  // null only here and 0 elsewhere; the JSON consumer cannot distinguish
  // those without a contract this test pins.
  assert.equal(md.scores.citation, 0);
});

test('perEngine block agrees with computeComponents per provider', () => {
  const summary = {
    date: '2026-05-13', brand: 'X', domain: 'x.com', score: 50,
    results: [
      { provider: 'openai', query: 'q1', mention: 'yes', position: 1,
        sentiment: { label: 'positive', confidence: 'high' },
        canonicalCitations: ['https://x.com/p'] },
      { provider: 'gemini', query: 'q1', mention: 'no', position: null,
        canonicalCitations: [] },
    ],
  };
  const md = buildMcMetadata(summary, [summary]);
  const oai = md.perEngine.find(p => p.provider === 'openai');
  const gem = md.perEngine.find(p => p.provider === 'gemini');

  const oaiSub = computeComponents({ domain: 'x.com', results: summary.results.filter(r => r.provider === 'openai') });
  const gemSub = computeComponents({ domain: 'x.com', results: summary.results.filter(r => r.provider === 'gemini') });

  assert.equal(oai.presence,  oaiSub.presence);
  assert.equal(oai.sentiment, oaiSub.sentiment);
  assert.equal(oai.rank,      oaiSub.rank);
  assert.equal(oai.citation,  oaiSub.citation);
  assert.equal(gem.presence,  gemSub.presence);
  assert.equal(gem.sentiment, gemSub.sentiment); // null — no sentiment data
  assert.equal(gem.rank,      gemSub.rank);      // null — no position data
});

test('scores.uvi falls back to computeUVI when summary.score is missing', () => {
  const summary = {
    date: '2026-05-13', brand: 'X', domain: 'x.com',
    results: [
      { provider: 'openai', query: 'q1', mention: 'yes', position: 1,
        sentiment: { label: 'positive', confidence: 'high' },
        canonicalCitations: ['https://x.com/a'] },
    ],
  };
  const md = buildMcMetadata(summary, [summary]);
  const expected = computeUVI(computeComponents(summary));
  assert.equal(md.scores.uvi, expected);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
