// Tests for the data-integrity fixes in lib/report/sections.js (v0.3.1):
//
//   BUG 1 — sectionKeyMetrics + sectionDiff: provider absent in one of the two
//           runs must NOT fabricate a regression delta or «yes → no» row.
//           Mixed-method comparisons (api ↔ manual-paste) are tagged.
//
//   BUG 4 — sectionCompetitorRadar: per-card «N mentions» must agree with the
//           authoritative topCompetitors[i].count (verified extractor tier).
//           Unverified entries render with the dashed-badge variant.
//
// Pure-function tests — no provider calls, no I/O. Build minimal snapshots
// inline so behaviour is local to each assertion.

import assert from 'node:assert/strict';
import {
  sectionKeyMetrics,
  sectionDiff,
  sectionCompetitorRadar,
} from '../lib/report/sections.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

// ─── BUG 1 — Key Metrics ──────────────────────────────────────────────────

console.log('\nsectionKeyMetrics — BUG 1: provider absent in prev');

test('Perplexity card reads "new this run" when prev had no perplexity cells', () => {
  const prev = {
    date: '2026-04-23',
    brand: 'TypelessForm',
    domain: 'typelessform.com',
    score: 33,
    results: [
      { query: 'q1', provider: 'openai',    mention: 'yes' },
      { query: 'q2', provider: 'openai',    mention: 'no'  },
      { query: 'q3', provider: 'openai',    mention: 'yes' },
      { query: 'q1', provider: 'gemini',    mention: 'no'  },
      { query: 'q2', provider: 'gemini',    mention: 'yes' },
      { query: 'q3', provider: 'gemini',    mention: 'no'  },
      { query: 'q1', provider: 'anthropic', mention: 'no'  },
      { query: 'q2', provider: 'anthropic', mention: 'no'  },
      { query: 'q3', provider: 'anthropic', mention: 'no'  },
    ],
  };
  const curr = {
    date: '2026-05-13',
    brand: 'TypelessForm',
    domain: 'typelessform.com',
    score: 42,
    results: [
      ...prev.results.map(r => ({ ...r })),
      { query: 'q1', provider: 'perplexity', mention: 'no', source: 'manual-paste' },
      { query: 'q2', provider: 'perplexity', mention: 'no', source: 'manual-paste' },
      { query: 'q3', provider: 'perplexity', mention: 'no', source: 'manual-paste' },
    ],
  };
  const md = sectionKeyMetrics([prev, curr]);
  // The bug produced «Perplexity ▼ −67pp» — we must NEVER show a negative pp
  // delta for a provider that wasn't in the previous run.
  assert.ok(!/Perplexity.*▼.*−?\d+pp/u.test(md) && !/Perplexity[\s\S]*?▼[\s\S]*?-\d+pp/u.test(md),
    'must not fabricate a downward pp delta for Perplexity (new in this run)');
  assert.ok(md.includes('new this run'),
    'expected "new this run" label for Perplexity when prev had no perplexity cells');
});

test('method-change between runs (api → manual-paste) is tagged', () => {
  const prev = {
    date: '2026-04-23',
    brand: 'X', domain: 'x.com', score: 50,
    results: [
      { query: 'q1', provider: 'anthropic', mention: 'yes', source: 'api' },
      { query: 'q2', provider: 'anthropic', mention: 'no',  source: 'api' },
    ],
  };
  const curr = {
    date: '2026-05-13',
    brand: 'X', domain: 'x.com', score: 50,
    results: [
      { query: 'q1', provider: 'anthropic', mention: 'yes', source: 'manual-paste' },
      { query: 'q2', provider: 'anthropic', mention: 'no',  source: 'manual-paste' },
    ],
  };
  const md = sectionKeyMetrics([prev, curr]);
  assert.ok(md.includes('method changed'),
    'expected "method changed" annotation on the anthropic delta');
});

// ─── BUG 1 — Diff table ────────────────────────────────────────────────────

console.log('\nsectionDiff — BUG 1: cells covered by only one run are excluded');

test('Perplexity Q1/Q3 "yes → no" row is NOT emitted when prev had no perplexity', () => {
  const prev = {
    date: '2026-04-23', brand: 'TypelessForm', domain: 'typelessform.com', score: 33,
    results: [
      { query: 'q1', provider: 'openai', mention: 'yes' },
      { query: 'q3', provider: 'openai', mention: 'yes' },
    ],
  };
  const curr = {
    date: '2026-05-13', brand: 'TypelessForm', domain: 'typelessform.com', score: 42,
    results: [
      { query: 'q1', provider: 'openai',     mention: 'yes' },
      { query: 'q3', provider: 'openai',     mention: 'yes' },
      { query: 'q1', provider: 'perplexity', mention: 'no', source: 'manual-paste' },
      { query: 'q3', provider: 'perplexity', mention: 'no', source: 'manual-paste' },
    ],
  };
  const md = sectionDiff([prev, curr]);
  assert.ok(!/Perplexity[\s\S]*?yes[\s\S]*?no/u.test(md),
    'must not fabricate a Perplexity yes→no row when prev had no perplexity');
});

test('genuine yes→no change still rendered', () => {
  const prev = {
    date: '2026-04-23', brand: 'X', domain: 'x.com', score: 100,
    results: [{ query: 'q1', provider: 'openai', mention: 'yes' }],
  };
  const curr = {
    date: '2026-05-13', brand: 'X', domain: 'x.com', score: 0,
    results: [{ query: 'q1', provider: 'openai', mention: 'no' }],
  };
  const md = sectionDiff([prev, curr]);
  assert.ok(/ChatGPT[\s\S]*?yes[\s\S]*?no/u.test(md), 'expected real ChatGPT yes→no row');
});

// ─── BUG 4 — Radar mention count ───────────────────────────────────────────

console.log('\nsectionCompetitorRadar — BUG 4: count agrees with topCompetitors[i]');

test('radar card meta uses topCompetitors[i].count (4) not unverified-inflated count (5)', () => {
  // Reproduces the live bug: AnveVoice appears in 4 cells as verified, plus
  // 1 cell where only one extractor model agreed (unverified). topCompetitors
  // shows count=4 (verified tier). Radar was reading both pools and reporting 5.
  const latest = {
    date: '2026-05-13',
    brand: 'TypelessForm',
    domain: 'typelessform.com',
    score: 42,
    results: [
      { query: 'q1', provider: 'openai',     mention: 'no', competitors: ['AnveVoice'], competitorsUnverified: [] },
      { query: 'q2', provider: 'openai',     mention: 'no', competitors: ['AnveVoice'], competitorsUnverified: [] },
      { query: 'q3', provider: 'openai',     mention: 'no', competitors: ['AnveVoice'], competitorsUnverified: [] },
      { query: 'q1', provider: 'gemini',     mention: 'no', competitors: ['AnveVoice'], competitorsUnverified: [] },
      { query: 'q2', provider: 'gemini',     mention: 'no', competitors: [],            competitorsUnverified: ['AnveVoice'] },
    ],
    topCompetitors: [{ name: 'AnveVoice', count: 4, verified: true }],
  };
  const md = sectionCompetitorRadar([latest]);
  assert.ok(md.includes('4 mentions'), 'expected "4 mentions" from topCompetitors[i].count');
  assert.ok(!md.includes('5 mentions'), 'must not show 5 (unverified-inflated count)');
});

test('unverified competitor entry renders with dashed-badge variant', () => {
  const latest = {
    date: '2026-05-13',
    brand: 'X', domain: 'x.com', score: 0,
    results: [],
    topCompetitors: [{ name: 'WeakSignal', count: 2, verified: false }],
  };
  const md = sectionCompetitorRadar([latest]);
  assert.ok(md.includes('radar-card-meta--unverified'),
    'expected radar-card-meta--unverified class on the dashed variant');
  assert.ok(md.includes('weaker signal') || md.includes('one extractor model'),
    'expected hover-title to explain the weaker-signal status');
});

test('verified competitor entry does NOT carry the unverified class', () => {
  const latest = {
    date: '2026-05-13',
    brand: 'X', domain: 'x.com', score: 0,
    results: [],
    topCompetitors: [{ name: 'StrongSignal', count: 3, verified: true }],
  };
  const md = sectionCompetitorRadar([latest]);
  assert.ok(!md.includes('radar-card-meta--unverified'),
    'verified entries must not carry the dashed-badge class');
});

test('radar SVG Mentions axis paints from VERIFIED count, not unverified-inflated raw', () => {
  // Same fixture as the «4 vs 5 mentions» test above, but here we verify the
  // SVG polygon itself paints from the verified count — earlier code passed
  // s.mentions (capped from rawMentions = 5 → 100) to the radar primitive
  // while the «N mentions» label read 4 (= 80). Both surfaces must agree.
  // MENTION_SCORE_PER_HIT = 20, so:
  //   verified=4 → mentions axis value = 80   (correct, aligned with label)
  //   raw=5      → mentions axis value = 100  (buggy, polygon paints fuller)
  const latest = {
    date: '2026-05-13',
    brand: 'TypelessForm',
    domain: 'typelessform.com',
    score: 42,
    results: [
      { query: 'q1', provider: 'openai', mention: 'no', competitors: ['AnveVoice'], competitorsUnverified: [] },
      { query: 'q2', provider: 'openai', mention: 'no', competitors: ['AnveVoice'], competitorsUnverified: [] },
      { query: 'q3', provider: 'openai', mention: 'no', competitors: ['AnveVoice'], competitorsUnverified: [] },
      { query: 'q1', provider: 'gemini', mention: 'no', competitors: ['AnveVoice'], competitorsUnverified: [] },
      { query: 'q2', provider: 'gemini', mention: 'no', competitors: [], competitorsUnverified: ['AnveVoice'] },
    ],
    topCompetitors: [{ name: 'AnveVoice', count: 4 }],
  };
  const md = sectionCompetitorRadar([latest]);

  // Extract Mentions-axis numeric value rendered into the SVG. The radar()
  // primitive surfaces axis values as `data-value="N"` attributes on its
  // label elements (one per axis). We assert that AnveVoice's Mentions axis
  // carries 80 (= verified count × MENTION_SCORE_PER_HIT) and never 100.
  const mentionsAxisValues = [...md.matchAll(/data-axis="Mentions"\s+data-value="(\d+)"/g)]
    .map(m => Number(m[1]));
  assert.ok(mentionsAxisValues.length >= 2,
    `expected ≥2 Mentions-axis values (user + competitor), got ${mentionsAxisValues.length} — radar primitive may not emit data-axis/data-value attributes; verify in lib/svg/radar.js`);
  // The competitor row (index 1, since user is index 0) is the one we care about.
  assert.notEqual(mentionsAxisValues[1], 100,
    'Mentions axis must NOT paint 100 — that comes from rawMentions=5 (unverified-inflated)');
  assert.equal(mentionsAxisValues[1], 80,
    'Mentions axis must paint 80 (= verified count 4 × MENTION_SCORE_PER_HIT 20)');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
