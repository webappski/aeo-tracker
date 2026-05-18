/**
 * 1.0.8 — recovery panel header text shows both counts honestly.
 *
 * Pre-1.0.8 header was «only X of 5 commercial candidates passed validation»,
 * which counted only commercial-only filter. When llmIssues blocked some
 * queries that PASSED commercial-only (e.g. confidence < threshold pre-1.0.8),
 * the header read «5 of 5 passed» but recovery panel still fired — a math
 * lie.
 *
 * 1.0.8 header: «N of 5 commercial-OK, M blocked by LLM verdict» when
 * commercialPassingCount is threaded from cmdInit. Legacy fallback when
 * count is null (--keywords mode).
 */

import test from 'node:test';
import assert from 'node:assert';
import { formatRecoveryPanel } from '../lib/init/validator-recovery.js';

function getHeaderLine(lines) {
  return lines.find(l => l.includes('Cannot auto-recover'));
}

const baseArgs = {
  candidatePool: [],
  currentQueries: ['q1', 'q2', 'q3'],
  brand: 'acme',
  domain: 'acme.com',
  useColor: false,
};

test('1.0.8 header: 5 commercial-OK + 1 LLM-blocked → both counts shown', () => {
  const lines = formatRecoveryPanel({
    ...baseArgs,
    allBlockers: [{ query: 'q1', valid: false, reason: 'rejected' }],
    commercialPassingCount: 5,
  });
  const header = getHeaderLine(lines);
  assert.ok(header.includes('5 of 5 commercial-OK'), `got: ${header}`);
  assert.ok(header.includes('1 blocked by LLM verdict'), `got: ${header}`);
});

test('1.0.8 header: 3 commercial-OK + 2 blocked → reflects both', () => {
  const lines = formatRecoveryPanel({
    ...baseArgs,
    allBlockers: [
      { query: 'q1', valid: false },
      { query: 'q2', valid: false },
    ],
    commercialPassingCount: 3,
  });
  const header = getHeaderLine(lines);
  assert.ok(header.includes('3 of 5 commercial-OK'), `got: ${header}`);
  assert.ok(header.includes('2 blocked by LLM verdict'), `got: ${header}`);
});

test('legacy fallback (commercialPassingCount=null) → "N query/queries blocked"', () => {
  // --keywords mode doesn't run substitution → count stays null → legacy wording
  const lines = formatRecoveryPanel({
    ...baseArgs,
    allBlockers: [{ query: 'q1', valid: false }],
    // commercialPassingCount omitted (= undefined, falls through legacy branch)
  });
  const header = getHeaderLine(lines);
  assert.ok(header.includes('1 query/queries blocked by validator'), `got: ${header}`);
});

test('legacy header does NOT mention "commercial-OK"', () => {
  const lines = formatRecoveryPanel({
    ...baseArgs,
    allBlockers: [{ query: 'q1', valid: false }],
  });
  const header = getHeaderLine(lines);
  assert.ok(!header.includes('commercial-OK'),
    `legacy fallback must not use new wording; got: ${header}`);
});

test('1.0.7 regression guard: header does NOT lie when commercial pass but LLM blocks', () => {
  // Pre-1.0.8: header would say "5 of 5 commercial candidates passed validation"
  // even when 3 were llmIssues-blocked. Must not regress.
  const lines = formatRecoveryPanel({
    ...baseArgs,
    allBlockers: [
      { query: 'q1', valid: false },
      { query: 'q2', valid: false },
      { query: 'q3', valid: false },
    ],
    commercialPassingCount: 5,
  });
  const header = getHeaderLine(lines);
  assert.ok(!header.match(/^[^,]*passed validation$/i),
    `must NOT just say "5 of 5 passed validation" when 3 are blocked; got: ${header}`);
  assert.ok(header.includes('3 blocked'), `should reflect 3 blocked; got: ${header}`);
});
