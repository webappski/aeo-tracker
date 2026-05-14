// Tests for validator-recovery (v0.2.4): auto-recovery of blocked queries
// when commercial-only validator flags informationalIssues. Covers:
//   - isRecoverable type guard (safe-substitute predicate)
//   - tryAutoRecover intent-diversity ranking + edge cases
//   - formatRecoveryPanel shape (pre-filled --keywords, fallback templates)
//   - formatAutoPromoteWarning (R1 measurement-semantics disclosure)
//   - promptBlockedQueryReplacement branches (replace/manual/abort, Enter-default)

import assert from 'node:assert/strict';
import {
  isRecoverable,
  tryAutoRecover,
  formatRecoveryPanel,
  formatAutoPromoteWarning,
  promptBlockedQueryReplacement,
} from '../lib/init/validator-recovery.js';

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    const p = fn();
    if (p && typeof p.then === 'function') {
      return p.then(
        () => { passed++; results.push({ name, ok: true }); },
        err => { failed++; results.push({ name, ok: false, err: err.message }); }
      );
    }
    passed++;
    results.push({ name, ok: true });
  } catch (err) {
    failed++;
    results.push({ name, ok: false, err: err.message });
  }
}

// ─── isRecoverable ───

test('isRecoverable: informationalIssue (has search_behavior) → true', () => {
  assert.equal(isRecoverable({ query: 'x', search_behavior: 'mixed' }), true);
});

test('isRecoverable: staticIssue (message, no search_behavior) → false', () => {
  assert.equal(isRecoverable({ query: 'AEO Poland', message: 'ambiguous acronym' }), false);
});

test('isRecoverable: llmIssue (valid/confidence, no search_behavior) → false', () => {
  assert.equal(isRecoverable({ query: 'x', valid: false, confidence: 0.3 }), false);
});

test('isRecoverable: null → false (defensive)', () => {
  assert.equal(isRecoverable(null), false);
});

// ─── tryAutoRecover ───

const typelessformQueries = [
  { text: 'best voice form filling software 2026', intent: 'commercial' },
  { text: 'voice form filling for healthcare intake', intent: 'vertical' },
  { text: 'high form abandonment on mobile checkout', intent: 'problem' },
];
const typelessformPool = [
  { text: 'voice form filling for ecommerce checkout', intent: 'vertical', score: 90 },
  { text: 'voice form filling vs web chat forms', intent: 'comparison', score: 78 },
  { text: 'voice form filling vs autofill tools', intent: 'comparison', score: 78 },
  { text: 'voice form widget vs form builder', intent: 'comparison', score: 78 },
  { text: 'speech to text vs voice form filling', intent: 'comparison', score: 78 },
];

test('tryAutoRecover: 1 blocker, intent-diversity picks comparison over already-used vertical', () => {
  const blockers = [{ query: 'high form abandonment on mobile checkout', search_behavior: 'mixed' }];
  const r = tryAutoRecover({ blockers, queries: typelessformQueries, candidatePool: typelessformPool });
  assert.equal(r.substitutions.length, 1);
  assert.equal(r.substitutions[0].replacementIntent, 'comparison');
  assert.equal(r.substitutions[0].original, 'high form abandonment on mobile checkout');
  assert.equal(r.unresolvedBlockers.length, 0);
  assert.equal(r.newQueries[2], r.substitutions[0].replacement);
  // Intent diversity: final set must contain 3 unique intents
  const finalIntents = new Set(['commercial', 'vertical', r.substitutions[0].replacementIntent]);
  assert.equal(finalIntents.size, 3);
});

test('tryAutoRecover: 2 blockers, both recovered with intent diversity', () => {
  const blockers = [
    { query: 'voice form filling for healthcare intake', search_behavior: 'mixed' },
    { query: 'high form abandonment on mobile checkout', search_behavior: 'mixed' },
  ];
  const r = tryAutoRecover({ blockers, queries: typelessformQueries, candidatePool: typelessformPool });
  assert.equal(r.substitutions.length, 2);
  assert.equal(r.unresolvedBlockers.length, 0);
  // After removing the two blocked queries, the only surviving intent is 'commercial'.
  // First sub should take 'vertical' (highest-score non-commercial), second 'comparison'.
  const intents = r.substitutions.map(s => s.replacementIntent);
  assert.ok(intents.includes('vertical'), `expected vertical in ${intents}`);
  assert.ok(intents.includes('comparison'), `expected comparison in ${intents}`);
});

test('tryAutoRecover: pool too small → unresolvedBlockers populated', () => {
  const blockers = [
    { query: 'q1', search_behavior: 'mixed' },
    { query: 'q2', search_behavior: 'mixed' },
  ];
  const queries = [{ text: 'q1' }, { text: 'q2' }, { text: 'q3' }];
  const smallPool = [{ text: 'alt1', intent: 'commercial', score: 80 }];
  const r = tryAutoRecover({ blockers, queries, candidatePool: smallPool });
  assert.equal(r.substitutions.length, 1);
  assert.equal(r.unresolvedBlockers.length, 1);
  assert.equal(r.unresolvedBlockers[0].query, 'q2');
});

test('tryAutoRecover: empty pool → all blockers unresolved', () => {
  const blockers = [{ query: 'q1', search_behavior: 'mixed' }];
  const queries = [{ text: 'q1' }, { text: 'q2' }, { text: 'q3' }];
  const r = tryAutoRecover({ blockers, queries, candidatePool: [] });
  assert.equal(r.substitutions.length, 0);
  assert.equal(r.unresolvedBlockers.length, 1);
  assert.deepEqual(r.newQueries, ['q1', 'q2', 'q3']); // unchanged
});

test('tryAutoRecover: alternative already in queries is skipped', () => {
  const blockers = [{ query: 'q3', search_behavior: 'mixed' }];
  const queries = [{ text: 'q1', intent: 'commercial' }, { text: 'q2', intent: 'vertical' }, { text: 'q3', intent: 'problem' }];
  const pool = [
    { text: 'q1', intent: 'commercial', score: 95 }, // duplicate — must skip
    { text: 'alt1', intent: 'comparison', score: 70 },
  ];
  const r = tryAutoRecover({ blockers, queries, candidatePool: pool });
  assert.equal(r.substitutions[0].replacement, 'alt1');
});

test('tryAutoRecover: no intent data → falls back to highest-score any', () => {
  const blockers = [{ query: 'q1', search_behavior: 'mixed' }];
  const queries = [{ text: 'q1' }, { text: 'q2' }, { text: 'q3' }];
  const pool = [
    { text: 'low', score: 50 },
    { text: 'high', score: 90 },
  ];
  const r = tryAutoRecover({ blockers, queries, candidatePool: pool });
  assert.equal(r.substitutions[0].replacement, 'high');
});

// ─── formatRecoveryPanel ───

test('formatRecoveryPanel: shows pre-filled --keywords from pool', () => {
  const lines = formatRecoveryPanel({
    allBlockers: [{ query: 'bad query', search_behavior: 'mixed' }],
    candidatePool: typelessformPool,
    currentQueries: typelessformQueries.map(q => q.text),
    brand: 'typelessform',
    domain: 'https://typelessform.com',
    useColor: false,
  });
  const text = lines.join('\n');
  assert.match(text, /Cannot auto-recover/);
  assert.match(text, /--keywords=/);
  assert.match(text, /voice form filling vs web chat forms/); // from pool
  assert.match(text, /aeo-platform init --yes/);
});

test('formatRecoveryPanel: empty pool uses editable templates', () => {
  const lines = formatRecoveryPanel({
    allBlockers: [{ query: 'bad', search_behavior: 'mixed' }],
    candidatePool: [],
    currentQueries: ['bad'],
    brand: 'acme',
    domain: 'https://acme.com',
    useColor: false,
  });
  const text = lines.join('\n');
  assert.match(text, /best acme alternatives 2026/);
  assert.match(text, /editable templates/);
});

test('formatRecoveryPanel: includes --force escape hatch and --category hint', () => {
  const lines = formatRecoveryPanel({
    allBlockers: [{ query: 'q1', search_behavior: 'parametric' }],
    candidatePool: [],
    currentQueries: ['q1'],
    brand: 'b', domain: 'https://d.com', useColor: false,
  });
  const text = lines.join('\n');
  assert.match(text, /--force/);
  assert.match(text, /not recommended/);
  assert.match(text, /--category=/);
});

test('formatRecoveryPanel: handles static/llm blockers (different reason shape)', () => {
  const lines = formatRecoveryPanel({
    allBlockers: [
      { query: 'AEO Poland', message: 'ambiguous acronym' },
      { query: 'some query', valid: false, reason: 'low confidence' },
    ],
    candidatePool: [],
    currentQueries: ['AEO Poland', 'some query', 'q3'],
    brand: 'b', domain: 'https://d.com', useColor: false,
  });
  const text = lines.join('\n');
  assert.match(text, /ambiguous acronym/);
  assert.match(text, /low confidence/);
});

// ─── formatAutoPromoteWarning ───

test('formatAutoPromoteWarning: discloses measurement shift (R1)', () => {
  const sub = {
    original: 'high form abandonment on mobile checkout',
    originalIntent: 'problem',
    replacement: 'voice form filling vs web chat forms',
    replacementIntent: 'comparison',
    score: 78,
    searchBehavior: 'mixed',
  };
  const lines = formatAutoPromoteWarning(sub, false);
  const text = lines.join('\n');
  assert.match(text, /blocked/);
  assert.match(text, /Auto-swapped/);
  assert.match(text, /problem → comparison/);
  assert.match(text, /visibility score tracks the new question/);
  assert.match(text, /--force/);
  assert.match(text, /--keywords=/);
});

// ─── promptBlockedQueryReplacement ───

function mkAsk(responses) {
  let i = 0;
  return async () => responses[i++];
}

test('promptBlockedQueryReplacement: Enter → recommended (first)', async () => {
  const choice = await promptBlockedQueryReplacement({
    blocker: { query: 'bad', search_behavior: 'mixed' },
    available: typelessformPool,
    ask: mkAsk(['']),
    useColor: false,
  });
  assert.equal(choice.action, 'replace');
  assert.equal(choice.text, typelessformPool[0].text);
});

test('promptBlockedQueryReplacement: "2" → second option', async () => {
  const choice = await promptBlockedQueryReplacement({
    blocker: { query: 'bad', search_behavior: 'mixed' },
    available: typelessformPool,
    ask: mkAsk(['2']),
    useColor: false,
  });
  assert.equal(choice.text, typelessformPool[1].text);
});

test('promptBlockedQueryReplacement: "m" → manual', async () => {
  const choice = await promptBlockedQueryReplacement({
    blocker: { query: 'bad', search_behavior: 'mixed' },
    available: typelessformPool,
    ask: mkAsk(['m']),
    useColor: false,
  });
  assert.equal(choice.action, 'manual');
});

test('promptBlockedQueryReplacement: "a" → abort', async () => {
  const choice = await promptBlockedQueryReplacement({
    blocker: { query: 'bad', search_behavior: 'mixed' },
    available: typelessformPool,
    ask: mkAsk(['a']),
    useColor: false,
  });
  assert.equal(choice.action, 'abort');
});

test('promptBlockedQueryReplacement: out-of-range typo → falls back to recommended', async () => {
  const choice = await promptBlockedQueryReplacement({
    blocker: { query: 'bad', search_behavior: 'mixed' },
    available: typelessformPool,
    ask: mkAsk(['99']),
    useColor: false,
  });
  assert.equal(choice.action, 'replace');
  assert.equal(choice.text, typelessformPool[0].text);
});

// ─── Summary ───

await Promise.allSettled(results.map(r => r));
setTimeout(() => {
  console.log('');
  for (const r of results) {
    console.log(r.ok ? `✓ ${r.name}` : `✗ ${r.name}\n    ${r.err}`);
  }
  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}, 50);
