/**
 * Fix A REV 4 regression (1.0.4): after init time pool-validation, the
 * (validated) label in `formatSelection` output must reflect BOTH validator
 * stages — category-validation (`!alt.unverified`) AND industry-fit
 * (search_behavior === 'retrieval-triggered' OR absent).
 *
 * Without this combined check, a query with `validation === 'ok'` but
 * `search_behavior === 'parametric-only'` would still render as (validated)
 * — and that's exactly the trust violation 1.0.4 fixes.
 *
 * We don't drive the full init flow here (would need API keys, network).
 * We test `formatSelection` directly with synthetic selectResult inputs
 * that mirror what cmdInit produces after the Fix A mutation pass.
 */

import test from 'node:test';
import assert from 'node:assert';
import { formatSelection } from '../lib/init/research/select.js';

function makeSelectResult(alternatives) {
  return {
    selected: [
      {
        candidate: { text: 'sel-q1', intent: 'commercial', score: 90, confidence: 'high' },
        intent: 'commercial',
      },
    ],
    alternatives,
    warnings: [],
    infos: [],
  };
}

test('(validated) tag: candidate passing both stages renders as (validated)', () => {
  const lines = formatSelection(makeSelectResult([
    { text: 'q-good', intent: 'vertical', score: 90, unverified: false, search_behavior: 'retrieval-triggered' },
  ]));
  const text = lines.join('\n');
  assert.match(text, /\(validated\) q-good/);
  assert.doesNotMatch(text, /\(unverified\) q-good/);
});

test('(validated) tag: candidate with parametric-only renders as (unverified) NOT (validated)', () => {
  // This is the core 1.0.4 regression-catch. Pre-1.0.4, this candidate
  // would have rendered as (validated) because alt.unverified was false
  // (category-validation passed) — but commercial-only would re-block it.
  const lines = formatSelection(makeSelectResult([
    { text: 'q-bad', intent: 'problem', score: 70, unverified: false, search_behavior: 'parametric-only' },
  ]));
  const text = lines.join('\n');
  assert.match(text, /\(unverified\) q-bad/);
  assert.doesNotMatch(text, /\(validated\) q-bad/);
});

test('(validated) tag: candidate with mixed search_behavior renders as (unverified)', () => {
  const lines = formatSelection(makeSelectResult([
    { text: 'q-mixed', intent: 'comparison', score: 78, unverified: false, search_behavior: 'mixed' },
  ]));
  const text = lines.join('\n');
  assert.match(text, /\(unverified\) q-mixed/);
});

test('(validated) tag: candidate without search_behavior (degraded path) renders as (validated)', () => {
  // Documented exception: when pool-validation fails (no provider, LLM
  // error, etc.) alts arrive without search_behavior. Falls through to
  // legacy `unverified`-only check. This preserves the graceful degradation
  // path described in plan §Risks #1.
  const lines = formatSelection(makeSelectResult([
    { text: 'q-legacy', intent: 'vertical', score: 80, unverified: false /* no search_behavior */ },
  ]));
  const text = lines.join('\n');
  assert.match(text, /\(validated\) q-legacy/);
});

test('(validated) tag: candidate failing category-validation (unverified=true) stays (unverified)', () => {
  // Pre-existing behaviour preserved. Whatever search_behavior says,
  // unverified=true wins — first stage failed.
  const lines = formatSelection(makeSelectResult([
    { text: 'q-cat-fail', intent: 'vertical', score: 60, unverified: true, search_behavior: 'retrieval-triggered' },
  ]));
  const text = lines.join('\n');
  assert.match(text, /\(unverified\) q-cat-fail/);
});

test('(validated) tag: mixed list — only commercial-passable alts get the badge', () => {
  // Combined scenario mirroring a real init: 5 alts back from research,
  // 2 pass both stages, 3 fail commercial-only.
  const lines = formatSelection(makeSelectResult([
    { text: 'q-1', intent: 'vertical', score: 90, unverified: false, search_behavior: 'retrieval-triggered' },
    { text: 'q-2', intent: 'vertical', score: 90, unverified: false, search_behavior: 'retrieval-triggered' },
    { text: 'q-3', intent: 'problem', score: 70, unverified: false, search_behavior: 'parametric-only' },
    { text: 'q-4', intent: 'comparison', score: 78, unverified: false, search_behavior: 'mixed' },
    { text: 'q-5', intent: 'commercial', score: 75, unverified: false, search_behavior: 'parametric-only' },
  ]));
  const text = lines.join('\n');
  assert.match(text, /\(validated\) q-1/);
  assert.match(text, /\(validated\) q-2/);
  assert.match(text, /\(unverified\) q-3/);
  assert.match(text, /\(unverified\) q-4/);
  assert.match(text, /\(unverified\) q-5/);
});
