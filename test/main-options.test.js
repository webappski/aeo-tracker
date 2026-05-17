// Drift catcher for lib/providers/main-options.js.
//
// MAIN_OPTIONS_BY_PROVIDER is consumed silently by mainCall in cmdRun. If
// someone edits the map and drops reasoning_effort / thinking — there's no
// runtime error, just silent quality regression (user pays for main-tier model
// without the reasoning bonus). These deepStrictEqual assertions are the only
// thing standing between "thinking always on" and "thinking accidentally off".

import assert from 'node:assert/strict';
import { MAIN_OPTIONS_BY_PROVIDER } from '../lib/providers/main-options.js';
import { PROVIDERS } from '../lib/providers/index.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nMAIN_OPTIONS_BY_PROVIDER per-provider invariants');

test('openai: reasoning_effort=high (mid+thinking policy)', () => {
  assert.deepStrictEqual(MAIN_OPTIONS_BY_PROVIDER.openai, { reasoning_effort: 'high' });
});

test('anthropic: extended thinking enabled, budget=16k', () => {
  assert.deepStrictEqual(MAIN_OPTIONS_BY_PROVIDER.anthropic, {
    thinking: { type: 'enabled', budget_tokens: 16000 },
  });
});

test('gemini: empty object (thinkingLevel auto-injected by regex in gemini.js)', () => {
  assert.deepStrictEqual(MAIN_OPTIONS_BY_PROVIDER.gemini, {});
});

test('perplexity: empty object (reasoning built-in for sonar-reasoning*)', () => {
  assert.deepStrictEqual(MAIN_OPTIONS_BY_PROVIDER.perplexity, {});
});

console.log('\nMAIN_OPTIONS_BY_PROVIDER coverage invariants');

test('every PROVIDERS key has a MAIN_OPTIONS entry (no missing providers)', () => {
  const expected = Object.keys(PROVIDERS).sort();
  const actual = Object.keys(MAIN_OPTIONS_BY_PROVIDER).sort();
  assert.deepStrictEqual(actual, expected,
    `MAIN_OPTIONS_BY_PROVIDER coverage drift: PROVIDERS=${expected.join(',')} vs MAIN_OPTIONS=${actual.join(',')}`);
});

test('no extra providers in MAIN_OPTIONS beyond known PROVIDERS', () => {
  for (const key of Object.keys(MAIN_OPTIONS_BY_PROVIDER)) {
    assert.ok(key in PROVIDERS, `unknown provider "${key}" in MAIN_OPTIONS — typo?`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
