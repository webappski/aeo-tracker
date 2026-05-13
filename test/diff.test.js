// Tests for cross-run diff logic. Covers the data-integrity contract that
// a (provider, query) cell only contributes to the diff when BOTH runs
// measured it — a missing provider in run N−1 must NOT produce a fabricated
// regression in run N. See BUG 1 in the v0.3.1 maintenance notes.

import assert from 'node:assert/strict';
import { diff } from '../lib/diff.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\ndiff — cellChanges');

test('provider absent in prev → no cellChange row emitted', () => {
  const a = {
    score: 33,
    results: [
      { query: 'q1', provider: 'openai', mention: 'yes' },
      { query: 'q1', provider: 'gemini', mention: 'no' },
    ],
  };
  const b = {
    score: 42,
    results: [
      { query: 'q1', provider: 'openai',     mention: 'yes' },
      { query: 'q1', provider: 'gemini',     mention: 'yes' },
      // perplexity is new in run B — must NOT fabricate "missing → no" or "yes → no"
      { query: 'q1', provider: 'perplexity', mention: 'no' },
    ],
  };
  const d = diff(a, b);
  const perplexityChanges = d.cellChanges.filter(c => c.provider === 'perplexity');
  assert.equal(perplexityChanges.length, 0,
    `expected no perplexity diff rows when prev had no perplexity, got ${JSON.stringify(perplexityChanges)}`);
});

test('provider dropped in current → no fabricated "yes → missing" row', () => {
  const a = {
    score: 50,
    results: [
      { query: 'q1', provider: 'openai',     mention: 'yes' },
      { query: 'q1', provider: 'perplexity', mention: 'yes' },
    ],
  };
  const b = {
    score: 50,
    results: [
      { query: 'q1', provider: 'openai', mention: 'yes' },
    ],
  };
  const d = diff(a, b);
  assert.equal(d.cellChanges.length, 0,
    `dropping perplexity from config is not a regression, got ${JSON.stringify(d.cellChanges)}`);
});

test('errored cells in prev are not comparable → skipped', () => {
  const a = {
    score: 0,
    results: [
      { query: 'q1', provider: 'openai', mention: 'error' },
    ],
  };
  const b = {
    score: 100,
    results: [
      { query: 'q1', provider: 'openai', mention: 'yes' },
    ],
  };
  const d = diff(a, b);
  assert.equal(d.cellChanges.length, 0, 'error → yes is not a measurable cell change');
});

test('real mention change is still emitted', () => {
  const a = { score: 0, results: [{ query: 'q1', provider: 'openai', mention: 'no' }] };
  const b = { score: 100, results: [{ query: 'q1', provider: 'openai', mention: 'yes' }] };
  const d = diff(a, b);
  assert.equal(d.cellChanges.length, 1);
  assert.equal(d.cellChanges[0].was, 'no');
  assert.equal(d.cellChanges[0].now, 'yes');
  assert.equal(d.cellChanges[0].mixedMethod, false);
});

test('mixed-method change (api ↔ manual-paste) is tagged mixedMethod: true', () => {
  const a = { score: 50, results: [{ query: 'q1', provider: 'anthropic', mention: 'yes', source: 'api' }] };
  const b = { score: 0, results: [{ query: 'q1', provider: 'anthropic', mention: 'no', source: 'manual-paste' }] };
  const d = diff(a, b);
  assert.equal(d.cellChanges.length, 1);
  assert.equal(d.cellChanges[0].mixedMethod, true);
});

test('competitor movement still tracked (independent of cellChanges fix)', () => {
  const a = {
    score: 0, results: [],
    topCompetitors: [{ name: 'CompA', count: 3 }],
  };
  const b = {
    score: 0, results: [],
    topCompetitors: [{ name: 'CompA', count: 3 }, { name: 'CompB', count: 1 }],
  };
  const d = diff(a, b);
  assert.equal(d.newCompetitors.length, 1);
  assert.equal(d.newCompetitors[0].name, 'CompB');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
