/**
 * 1.0.6 — silent substitution in cmdInit.
 *
 * Cannot drive the full cmdInit flow without API keys, so these tests
 * exercise the substitution LOGIC by simulating the post-substitution
 * state of `selectResult` and asserting:
 *   - When ≥3 of 5 pass, top-3 are the highest-score passing entries
 *   - When <3 pass, selectResult stays as-is (recovery panel fires)
 *
 * The full substitution block lives in bin/aeo-tracker.js and the
 * cli-walkthrough skill (Step 4c) verifies it end-to-end.
 */

import test from 'node:test';
import assert from 'node:assert';

const SEARCH_BEHAVIORS = {
  RETRIEVAL: 'retrieval-triggered',
  PARAMETRIC: 'parametric-only',
  MIXED: 'mixed',
};

// Mirror of the substitution-block predicate in bin/aeo-tracker.js — kept
// here so the unit test can validate it standalone without spinning up
// the whole cmdInit flow.
function runSubstitution(selectResult, verdicts) {
  if (verdicts.length === 0) {
    return { commercialPassingCount: null, selectResult };
  }
  const allFive = [
    ...selectResult.selected.map(s => s.candidate),
    ...selectResult.alternatives,
  ];
  for (const c of allFive) {
    const verdict = verdicts.find(v => v.query === c.text);
    if (verdict) {
      c.search_behavior = verdict.search_behavior;
      c.confidence = verdict.confidence;
    }
  }
  const PASS = (c) =>
    c.search_behavior === SEARCH_BEHAVIORS.RETRIEVAL
    || (!verdicts.find(v => v.query === c.text));
  const passing = allFive.filter(PASS);
  const commercialPassingCount = passing.length;
  if (commercialPassingCount >= 3) {
    passing.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    selectResult.selected = passing.slice(0, 3).map(c => ({
      intent: c.intent || 'commercial', candidate: c, fallbackUsed: null,
    }));
    selectResult.alternatives = passing.slice(3).map(c => ({ ...c }));
  }
  return { commercialPassingCount, selectResult };
}

function makeSelectResult({ topScores, altScores }) {
  return {
    selected: topScores.map((score, i) => ({
      intent: 'commercial', fallbackUsed: null,
      candidate: { text: `top-${i + 1}`, intent: 'commercial', score, validation: 'ok' },
    })),
    alternatives: altScores.map((score, i) => ({
      text: `alt-${i + 1}`, intent: 'commercial', score, validation: 'ok',
    })),
  };
}

test('Case 1: all 5 pass → top-3 unchanged (by original ordering, score-sorted)', () => {
  const sr = makeSelectResult({ topScores: [90, 80, 70], altScores: [60, 50] });
  const verdicts = ['top-1', 'top-2', 'top-3', 'alt-1', 'alt-2']
    .map(q => ({ query: q, search_behavior: 'retrieval-triggered' }));
  const { commercialPassingCount, selectResult } = runSubstitution(sr, verdicts);
  assert.equal(commercialPassingCount, 5);
  assert.deepEqual(
    selectResult.selected.map(s => s.candidate.text),
    ['top-1', 'top-2', 'top-3'],
    'top-3 stays as the highest-score passing entries',
  );
});

test('Case 2: 1 of top-3 fails → swap with highest-score spare', () => {
  const sr = makeSelectResult({ topScores: [90, 80, 70], altScores: [85, 50] });
  // top-3 fails commercial-only; alt-1 (score 85) passes
  const verdicts = [
    { query: 'top-1', search_behavior: 'retrieval-triggered' },
    { query: 'top-2', search_behavior: 'retrieval-triggered' },
    { query: 'top-3', search_behavior: 'parametric-only' },  // FAIL
    { query: 'alt-1', search_behavior: 'retrieval-triggered' },
    { query: 'alt-2', search_behavior: 'retrieval-triggered' },
  ];
  const { commercialPassingCount, selectResult } = runSubstitution(sr, verdicts);
  assert.equal(commercialPassingCount, 4);
  const texts = selectResult.selected.map(s => s.candidate.text);
  assert.ok(texts.includes('alt-1'), 'alt-1 (highest-score spare) promoted to top-3');
  assert.ok(!texts.includes('top-3'), 'failed top-3 (parametric-only) silently dropped');
});

test('Case 3: 2 of top-3 fail → swap both with 2 passing spares', () => {
  const sr = makeSelectResult({ topScores: [90, 80, 70], altScores: [85, 75] });
  const verdicts = [
    { query: 'top-1', search_behavior: 'retrieval-triggered' },
    { query: 'top-2', search_behavior: 'mixed' },               // FAIL
    { query: 'top-3', search_behavior: 'parametric-only' },     // FAIL
    { query: 'alt-1', search_behavior: 'retrieval-triggered' },
    { query: 'alt-2', search_behavior: 'retrieval-triggered' },
  ];
  const { commercialPassingCount, selectResult } = runSubstitution(sr, verdicts);
  assert.equal(commercialPassingCount, 3);
  const texts = selectResult.selected.map(s => s.candidate.text).sort();
  assert.deepEqual(texts, ['alt-1', 'alt-2', 'top-1']);
});

test('Case 4: 3 of 5 fail → no substitution, selectResult unchanged (recovery panel fires)', () => {
  const sr = makeSelectResult({ topScores: [90, 80, 70], altScores: [60, 50] });
  const verdicts = [
    { query: 'top-1', search_behavior: 'parametric-only' },     // FAIL
    { query: 'top-2', search_behavior: 'mixed' },               // FAIL
    { query: 'top-3', search_behavior: 'parametric-only' },     // FAIL
    { query: 'alt-1', search_behavior: 'retrieval-triggered' },
    { query: 'alt-2', search_behavior: 'retrieval-triggered' },
  ];
  const { commercialPassingCount, selectResult } = runSubstitution(sr, verdicts);
  assert.equal(commercialPassingCount, 2, 'only 2 of 5 passed — substitution does not fire');
  // selectResult.selected unchanged — top-3 still the original (failing) entries
  assert.deepEqual(
    selectResult.selected.map(s => s.candidate.text),
    ['top-1', 'top-2', 'top-3'],
  );
});

test('Case 5: empty verdicts → no substitution (graceful degrade)', () => {
  const sr = makeSelectResult({ topScores: [90, 80, 70], altScores: [60, 50] });
  const { commercialPassingCount, selectResult } = runSubstitution(sr, []);
  assert.equal(commercialPassingCount, null, 'null signals "validation skipped"');
  // selectResult unchanged
  assert.deepEqual(
    selectResult.selected.map(s => s.candidate.text),
    ['top-1', 'top-2', 'top-3'],
  );
});
