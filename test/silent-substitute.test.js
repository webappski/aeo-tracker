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
      c.valid = verdict.valid;
    }
  }
  // 1.0.8: mirror the production PASS predicate exactly. valid:true required
  // (was: only search_behavior checked). Legacy graceful for missing verdict.
  const PASS = (c) => {
    const verdict = verdicts.find(v => v.query === c.text);
    if (!verdict) return true;
    return verdict.valid === true
        && verdict.search_behavior === SEARCH_BEHAVIORS.RETRIEVAL;
  };
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

// 1.0.8: all verdicts now include `valid` field — substitution PASS requires
// valid:true AND retrieval-triggered (mirror of run-validation.js after 1.0.8).
function v(query, search_behavior, valid = true) {
  return { query, valid, search_behavior };
}

test('Case 1: all 5 pass (valid:true + retrieval) → top-3 unchanged', () => {
  const sr = makeSelectResult({ topScores: [90, 80, 70], altScores: [60, 50] });
  const verdicts = ['top-1', 'top-2', 'top-3', 'alt-1', 'alt-2']
    .map(q => v(q, 'retrieval-triggered'));
  const { commercialPassingCount, selectResult } = runSubstitution(sr, verdicts);
  assert.equal(commercialPassingCount, 5);
  assert.deepEqual(
    selectResult.selected.map(s => s.candidate.text),
    ['top-1', 'top-2', 'top-3'],
  );
});

test('Case 2: 1 of top-3 fails search_behavior → swap with highest-score spare', () => {
  const sr = makeSelectResult({ topScores: [90, 80, 70], altScores: [85, 50] });
  const verdicts = [
    v('top-1', 'retrieval-triggered'),
    v('top-2', 'retrieval-triggered'),
    v('top-3', 'parametric-only'),        // FAIL — non-commercial
    v('alt-1', 'retrieval-triggered'),
    v('alt-2', 'retrieval-triggered'),
  ];
  const { commercialPassingCount, selectResult } = runSubstitution(sr, verdicts);
  assert.equal(commercialPassingCount, 4);
  const texts = selectResult.selected.map(s => s.candidate.text);
  assert.ok(texts.includes('alt-1'), 'alt-1 promoted to top-3');
  assert.ok(!texts.includes('top-3'), 'parametric-only top-3 dropped');
});

test('Case 3: 2 of top-3 fail → swap both', () => {
  const sr = makeSelectResult({ topScores: [90, 80, 70], altScores: [85, 75] });
  const verdicts = [
    v('top-1', 'retrieval-triggered'),
    v('top-2', 'mixed'),                   // FAIL
    v('top-3', 'parametric-only'),         // FAIL
    v('alt-1', 'retrieval-triggered'),
    v('alt-2', 'retrieval-triggered'),
  ];
  const { commercialPassingCount, selectResult } = runSubstitution(sr, verdicts);
  assert.equal(commercialPassingCount, 3);
  const texts = selectResult.selected.map(s => s.candidate.text).sort();
  assert.deepEqual(texts, ['alt-1', 'alt-2', 'top-1']);
});

test('Case 4: 3 of 5 fail → no substitution (recovery panel fires)', () => {
  const sr = makeSelectResult({ topScores: [90, 80, 70], altScores: [60, 50] });
  const verdicts = [
    v('top-1', 'parametric-only'),
    v('top-2', 'mixed'),
    v('top-3', 'parametric-only'),
    v('alt-1', 'retrieval-triggered'),
    v('alt-2', 'retrieval-triggered'),
  ];
  const { commercialPassingCount, selectResult } = runSubstitution(sr, verdicts);
  assert.equal(commercialPassingCount, 2);
  assert.deepEqual(
    selectResult.selected.map(s => s.candidate.text),
    ['top-1', 'top-2', 'top-3'],
  );
});

// NEW 1.0.8 — valid:false coverage. Pre-1.0.8 substitution missed this.
test('1.0.8 Case 6: valid:false + retrieval → FAIL (was PASS pre-1.0.8)', () => {
  const sr = makeSelectResult({ topScores: [90, 80, 70], altScores: [85, 60] });
  const verdicts = [
    v('top-1', 'retrieval-triggered'),
    v('top-2', 'retrieval-triggered', false),   // valid:false — NEW: should FAIL
    v('top-3', 'retrieval-triggered'),
    v('alt-1', 'retrieval-triggered'),
    v('alt-2', 'retrieval-triggered'),
  ];
  const { commercialPassingCount, selectResult } = runSubstitution(sr, verdicts);
  assert.equal(commercialPassingCount, 4,
    'valid:false now drops out of substitution (was 5 in 1.0.7)');
  const texts = selectResult.selected.map(s => s.candidate.text);
  assert.ok(!texts.includes('top-2'), 'valid:false top-2 silently dropped');
  assert.ok(texts.includes('alt-1'), 'alt-1 promoted to top-3');
});

test('1.0.8 Case 7: valid:true + low confidence → PASS (1.0.8 trust-valid rule)', () => {
  // Pre-1.0.8 a confidence-only block here; 1.0.8 trusts valid:true.
  const sr = makeSelectResult({ topScores: [90, 80, 70], altScores: [60, 50] });
  const verdicts = [
    { query: 'top-1', valid: true, search_behavior: 'retrieval-triggered', confidence: 0.62 },
    { query: 'top-2', valid: true, search_behavior: 'retrieval-triggered', confidence: 0.65 },
    { query: 'top-3', valid: true, search_behavior: 'retrieval-triggered', confidence: 0.55 },
    { query: 'alt-1', valid: true, search_behavior: 'retrieval-triggered', confidence: 0.50 },
    { query: 'alt-2', valid: true, search_behavior: 'retrieval-triggered', confidence: 0.60 },
  ];
  const { commercialPassingCount } = runSubstitution(sr, verdicts);
  assert.equal(commercialPassingCount, 5,
    'all valid:true must pass regardless of low confidence (1.0.8 trust-valid)');
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
