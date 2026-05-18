/**
 * 1.0.8 — recovery panel render label must show the REAL block reason.
 *
 * Pre-1.0.8 contradiction: a query with `valid:false, search_behavior:retrieval-triggered`
 * would render as «non-commercial (search_behavior: retrieval-triggered)» —
 * a contradiction (retrieval-triggered IS commercial). The bug: label branched
 * on `search_behavior` presence, which won over the actual `valid:false`
 * reason.
 *
 * 1.0.8 label order: valid:false → "LLM rejected: ...", search_behavior
 * !== retrieval → "non-commercial", static issue → message, fallback → reason.
 */

import test from 'node:test';
import assert from 'node:assert';
import { formatRecoveryPanel } from '../lib/init/validator-recovery.js';

function findReasonLine(lines, queryText) {
  const idx = lines.findIndex(l => l.includes(`✗ "${queryText}"`));
  return idx >= 0 ? lines[idx + 1] : null;  // reason is on next line
}

const baseArgs = {
  candidatePool: [],
  currentQueries: ['q1', 'q2', 'q3'],
  brand: 'acme',
  domain: 'acme.com',
  useColor: false,
};

test('valid:false → "LLM rejected: <reason>"', () => {
  const lines = formatRecoveryPanel({
    ...baseArgs,
    allBlockers: [
      { query: 'q1', valid: false, reason: 'too vague — overlaps with form-builder space' },
    ],
  });
  const reasonLine = findReasonLine(lines, 'q1');
  assert.ok(reasonLine.includes('LLM rejected'), `expected "LLM rejected" prefix; got: ${reasonLine}`);
  assert.ok(reasonLine.includes('too vague'), `expected the reason text; got: ${reasonLine}`);
});

test('valid:false WITHOUT reason → "LLM rejected as invalid"', () => {
  const lines = formatRecoveryPanel({
    ...baseArgs,
    allBlockers: [{ query: 'q1', valid: false }],
  });
  const reasonLine = findReasonLine(lines, 'q1');
  assert.ok(reasonLine.includes('LLM rejected as invalid'), `got: ${reasonLine}`);
});

test('CRITICAL: valid:false + retrieval-triggered → "LLM rejected" (NOT "non-commercial")', () => {
  // This is the 1.0.7 dogfood contradiction. Pre-1.0.8 rendered:
  //   non-commercial (search_behavior: retrieval-triggered)
  // which is internally contradictory.
  const lines = formatRecoveryPanel({
    ...baseArgs,
    allBlockers: [
      {
        query: 'q1',
        valid: false,
        search_behavior: 'retrieval-triggered',
        reason: 'low industry-fit overlap',
      },
    ],
  });
  const reasonLine = findReasonLine(lines, 'q1');
  assert.ok(reasonLine.includes('LLM rejected'), `valid:false must dominate; got: ${reasonLine}`);
  assert.ok(!reasonLine.includes('non-commercial'),
    `1.0.7 bug: must NOT render "non-commercial" when search_behavior=retrieval; got: ${reasonLine}`);
});

test('parametric-only → "non-commercial (parametric-only)"', () => {
  const lines = formatRecoveryPanel({
    ...baseArgs,
    allBlockers: [{ query: 'q1', valid: true, search_behavior: 'parametric-only' }],
  });
  const reasonLine = findReasonLine(lines, 'q1');
  assert.ok(reasonLine.includes('non-commercial'), `got: ${reasonLine}`);
  assert.ok(reasonLine.includes('parametric-only'), `got: ${reasonLine}`);
});

test('mixed → "non-commercial (mixed)"', () => {
  const lines = formatRecoveryPanel({
    ...baseArgs,
    allBlockers: [{ query: 'q1', valid: true, search_behavior: 'mixed' }],
  });
  const reasonLine = findReasonLine(lines, 'q1');
  assert.ok(reasonLine.includes('non-commercial (search_behavior: mixed)'), `got: ${reasonLine}`);
});

test('static issue (acronym ambiguity) → message field shown', () => {
  const lines = formatRecoveryPanel({
    ...baseArgs,
    allBlockers: [
      { query: 'AEO in Poland', kind: 'acronym', message: 'acronym AEO is ambiguous (also means customs office)' },
    ],
  });
  const reasonLine = findReasonLine(lines, 'AEO in Poland');
  assert.ok(reasonLine.includes('acronym AEO is ambiguous'), `got: ${reasonLine}`);
});

test('retrieval-triggered + valid:true does NOT reach recovery panel (defensive)', () => {
  // Such a query would not be in dedupedBlockers in production. If somehow
  // present (bug elsewhere), the label falls back to `reason` or default.
  const lines = formatRecoveryPanel({
    ...baseArgs,
    allBlockers: [{ query: 'q1', valid: true, search_behavior: 'retrieval-triggered' }],
  });
  const reasonLine = findReasonLine(lines, 'q1');
  // Should NOT label as "non-commercial" (it isn't), should NOT label "LLM rejected" (valid).
  assert.ok(!reasonLine.includes('non-commercial'), `got: ${reasonLine}`);
  assert.ok(!reasonLine.includes('LLM rejected'), `got: ${reasonLine}`);
  // Falls through to last branch — "unspecified block reason".
  assert.ok(reasonLine.includes('unspecified'), `expected fallback wording; got: ${reasonLine}`);
});
