// Unit tests for lib/init/keys.js — standard detection + heuristic matcher.
// Does NOT cover bin/aeo-tracker.js Stage 3 interactive prompt (hard to unit-test
// readline without a harness); that flow is exercised manually + covered by snapshot
// of error paths via the `stillMissingRequired` hard-fail guard.

import assert from 'node:assert/strict';
import { detectStandardKeys, heuristicKeyMatch, PROVIDER_LABELS } from '../lib/init/keys.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

// Synthetic env — 40-char dummy values pass MIN_KEY_LEN (20).
const FAKE = 'x'.repeat(40);

console.log('\ndetectStandardKeys');

test('finds all four when standard names set', () => {
  const env = {
    OPENAI_API_KEY:    FAKE,
    GEMINI_API_KEY:    FAKE,
    ANTHROPIC_API_KEY: FAKE,
    PERPLEXITY_API_KEY: FAKE,
  };
  const out = detectStandardKeys(env);
  assert.equal(out.openai,     'OPENAI_API_KEY');
  assert.equal(out.gemini,     'GEMINI_API_KEY');
  assert.equal(out.anthropic,  'ANTHROPIC_API_KEY');
  assert.equal(out.perplexity, 'PERPLEXITY_API_KEY');
});

test('returns null for each provider when env is empty', () => {
  const out = detectStandardKeys({});
  for (const p of ['openai', 'gemini', 'anthropic', 'perplexity']) {
    assert.equal(out[p], null);
  }
});

test('ignores short (dummy / partial) values — standard name alone is checked, value length is heuristic-only', () => {
  // detectStandardKeys currently doesn't enforce length — it only checks presence.
  // This documents current behavior; length is validated in Stage 3 prompt flow + bin.
  const out = detectStandardKeys({ OPENAI_API_KEY: 'short' });
  assert.equal(out.openai, 'OPENAI_API_KEY');
});

console.log('\nheuristicKeyMatch');

test('catches OPENAI-prefixed variants ending in KEY/TOKEN/API', () => {
  const env = {
    OPENAI_API_KEY_DEV: FAKE,
    OPENAI_TOKEN:       FAKE,
    GPT_API_KEY:        FAKE,
  };
  const out = heuristicKeyMatch(env);
  assert.deepEqual(out.openai.sort(), ['GPT_API_KEY', 'OPENAI_API_KEY_DEV', 'OPENAI_TOKEN']);
});

test('catches Anthropic aliases (CLAUDE_*)', () => {
  const env = { CLAUDE_API_KEY: FAKE, CLAUDE_TOKEN: FAKE, ANTHROPIC_KEY_DEV: FAKE };
  const out = heuristicKeyMatch(env);
  assert.deepEqual(out.anthropic.sort(), ['ANTHROPIC_KEY_DEV', 'CLAUDE_API_KEY', 'CLAUDE_TOKEN']);
});

test('catches Gemini aliases (GOOGLE_AI_*, GEMINI_*)', () => {
  const env = { GEMINI_KEY_PROD: FAKE, GOOGLE_AI_TOKEN: FAKE, GOOGLE_GENAI_API_KEY: FAKE };
  const out = heuristicKeyMatch(env);
  assert.deepEqual(out.gemini.sort(), ['GEMINI_KEY_PROD', 'GOOGLE_AI_TOKEN', 'GOOGLE_GENAI_API_KEY']);
});

test('catches Perplexity aliases (PPLX_*, PERPLEXITY_*)', () => {
  const env = { PPLX_API_KEY: FAKE, PERPLEXITY_TOKEN: FAKE };
  const out = heuristicKeyMatch(env);
  assert.deepEqual(out.perplexity.sort(), ['PERPLEXITY_TOKEN', 'PPLX_API_KEY']);
});

test('REJECTS names not starting with a provider keyword', () => {
  // These are real-world patterns that the regex WON'T match due to ^ anchor.
  // Documents the limitation that Stage 3 interactive prompt is there to cover.
  const env = {
    MY_OPENAI_KEY:      FAKE,   // prefix MY_
    DEV_ANTHROPIC_KEY:  FAKE,   // prefix DEV_
    SECRET_AI_TOKEN:    FAKE,   // no provider keyword
    AZURE_OPENAI_KEY:   FAKE,   // AZURE_ prefix
    API_OPEN_AI:        FAKE,   // prefix API_, also OPEN_AI not OPENAI
  };
  const out = heuristicKeyMatch(env);
  // None of these should match any provider.
  for (const p of ['openai', 'gemini', 'anthropic', 'perplexity']) {
    assert.equal(out[p].length, 0, `${p} should have matched nothing, got: ${out[p].join(', ')}`);
  }
});

test('ignores values shorter than MIN_KEY_LEN (20 chars)', () => {
  const env = {
    OPENAI_API_KEY_DEV: 'short',           // too short, ignored
    GPT_TOKEN:          'x'.repeat(19),    // 19 chars, below threshold
    CLAUDE_KEY:         'x'.repeat(20),    // exactly 20 — still below (< MIN_KEY_LEN, strict)
  };
  const out = heuristicKeyMatch(env);
  // 20 is < 20 is false, so CLAUDE_KEY at exactly 20 should pass
  // Wait, `if (value.length < MIN_KEY_LEN)` — 20 < 20 is false, so it passes
  assert.deepEqual(out.openai, []);
  assert.deepEqual(out.anthropic, ['CLAUDE_KEY']);
});

test('anchored regex: name starting with OPENAI matches only OpenAI, not Anthropic', () => {
  // OPENAI_ANTHROPIC_KEY starts with OPENAI — matches openai pattern only.
  // The ^ anchor in the regex means each name can match at most one provider,
  // based on the prefix. That's desired behavior — predictable, no ambiguity.
  const env = { OPENAI_ANTHROPIC_KEY: FAKE };
  const out = heuristicKeyMatch(env);
  assert.ok(out.openai.includes('OPENAI_ANTHROPIC_KEY'), 'should match openai (starts with OPENAI)');
  assert.equal(out.anthropic.length, 0, 'must NOT match anthropic (does not start with CLAUDE/ANTHROPIC)');
});

test('skips exact standard names (already handled by detectStandardKeys)', () => {
  const env = { OPENAI_API_KEY: FAKE };
  const out = heuristicKeyMatch(env);
  assert.deepEqual(out.openai, []);
});

console.log('\nPROVIDER_LABELS');

test('exposes human-readable labels for all four providers', () => {
  assert.ok(PROVIDER_LABELS.openai.includes('OpenAI'));
  assert.ok(PROVIDER_LABELS.gemini.includes('Gemini'));
  assert.ok(PROVIDER_LABELS.anthropic.includes('Claude'));
  assert.ok(PROVIDER_LABELS.perplexity.includes('Perplexity'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
