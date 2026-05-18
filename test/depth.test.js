import assert from 'node:assert/strict';
import { deriveTrainingModel, daysSinceLastFullRun } from '../lib/providers/non-search-model.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nderiveTrainingModel');

test('openai: gpt-5-search-api → gpt-5',
  () => assert.equal(deriveTrainingModel('openai', 'gpt-5-search-api'), 'gpt-5'));

test('openai: gpt-4o-search-preview → gpt-4o',
  () => assert.equal(deriveTrainingModel('openai', 'gpt-4o-search-preview'), 'gpt-4o'));

test('openai: gpt-4o-search → gpt-4o (plain -search suffix used by current catalog)',
  () => assert.equal(deriveTrainingModel('openai', 'gpt-4o-search'), 'gpt-4o'));

test('openai: gpt-4o-search-preview-2024-12-17 → gpt-4o (dated suffix stripped)',
  () => assert.equal(deriveTrainingModel('openai', 'gpt-4o-search-preview-2024-12-17'), 'gpt-4o'));

test('openai: gpt-5 (no suffix) → gpt-5 (unchanged)',
  () => assert.equal(deriveTrainingModel('openai', 'gpt-5'), 'gpt-5'));

test('gemini: same model returned (web-search is request flag, not model variant)',
  () => assert.equal(deriveTrainingModel('gemini', 'gemini-2.5-pro'), 'gemini-2.5-pro'));

test('anthropic: same model returned',
  () => assert.equal(deriveTrainingModel('anthropic', 'claude-sonnet-4-6'), 'claude-sonnet-4-6'));

test('perplexity: null (search-only by design)',
  () => assert.equal(deriveTrainingModel('perplexity', 'sonar-pro'), null));

test('unknown provider: passthrough',
  () => assert.equal(deriveTrainingModel('unknown', 'some-model'), 'some-model'));

test('empty inputs → null',
  () => {
    assert.equal(deriveTrainingModel('', 'gpt-5'), null);
    assert.equal(deriveTrainingModel('openai', ''), null);
    assert.equal(deriveTrainingModel(null, null), null);
  });

console.log('\ndaysSinceLastFullRun');

test('null lastFullRun → null',
  () => assert.equal(daysSinceLastFullRun(null), null));

test('malformed date → null',
  () => assert.equal(daysSinceLastFullRun('not-a-date'), null));

test('14 days ago → 14',
  () => {
    const today = new Date('2026-05-14T00:00:00Z');
    assert.equal(daysSinceLastFullRun('2026-04-30', today), 14);
  });

test('today → 0',
  () => {
    const today = new Date('2026-05-14T00:00:00Z');
    assert.equal(daysSinceLastFullRun('2026-05-14', today), 0);
  });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
