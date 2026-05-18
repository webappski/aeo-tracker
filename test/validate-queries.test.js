// Regression tests for query validation. No external APIs — LLM provider is mocked.
// Run: node test/validate-queries.test.js
// Exit 0 = pass, exit 1 = fail.

import assert from 'node:assert/strict';
import { validateQueries } from '../lib/init/research/filter.js';
import { runTwoStageValidation, mergeCrossCheck, hasBlockers, CONFIDENCE_THRESHOLD } from '../lib/init/research/run-validation.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch(err => {
      failed++;
      console.log(`  ✗ ${name}`);
      console.log(`    ${err.message}`);
    });
}

// ─── Static validator (filter.js::validateQueries) ───
// Pure logic, no mocking needed. Exercises the AMBIGUOUS_ACRONYMS tripwire.

console.log('\nStatic validator (AMBIGUOUS_ACRONYMS)');

await test('flags bare AEO without expansion', () => {
  const issues = validateQueries(['best AEO agency 2026']);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].abbr, 'AEO');
  assert.match(issues[0].message, /Answer Engine Optimization/);
});

await test('accepts AEO when expansion present', () => {
  const issues = validateQueries(['best Answer Engine Optimization (AEO) agency 2026']);
  assert.equal(issues.length, 0);
});

await test('flags ERP without expansion', () => {
  const issues = validateQueries(['ERP consultants for manufacturing']);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].abbr, 'ERP');
});

await test('accepts fully written queries with no acronym', () => {
  const issues = validateQueries(['best machine learning platforms for enterprise']);
  assert.equal(issues.length, 0);
});

await test('handles empty / non-string inputs safely', () => {
  const issues = validateQueries([null, '', undefined, '   ']);
  assert.equal(issues.length, 0);
});

await test('case-insensitive expansion match', () => {
  const issues = validateQueries(['AEO (answer engine optimization) agencies']);
  assert.equal(issues.length, 0);
});

// ─── runTwoStageValidation with mocked LLM provider ───
// We stub providerCall to return deterministic JSON — tests the cache logic,
// stage sequencing, threshold application, and blocker aggregation.

console.log('\nrunTwoStageValidation (mocked LLM)');

function makeMockProvider(verdicts) {
  // verdicts: { [queryText]: { valid, confidence, alternate_meanings, search_behavior, reason } }
  return {
    name: 'mock',
    label: 'Mock',
    apiKey: 'test',
    model: 'mock-model',
    providerCall: async (prompt) => {
      const queries = [...prompt.matchAll(/^\s*(\d+)\.\s+"([^"]+)"/gm)].map(m => ({
        idx: Number(m[1]),
        text: m[2],
      }));
      const results = queries.map(({ idx, text }) => {
        const v = verdicts[text];
        if (!v) throw new Error(`mock: no verdict stubbed for "${text}"`);
        return {
          index: idx,
          query: text,
          alternate_meanings: v.alternate_meanings || ['A', 'B'],
          dominant_interpretation: v.dominant_interpretation || '',
          search_behavior: v.search_behavior || 'retrieval-triggered',
          valid: v.valid,
          confidence: v.confidence,
          reason: v.reason || 'mock',
        };
      });
      return {
        text: JSON.stringify({ results }),
        raw: { usage: { input_tokens: 100, output_tokens: 50 } },
      };
    },
  };
}

await test('blocks known bad query (AEO Poland customs)', async () => {
  const primary = makeMockProvider({
    'AEO consultants Poland': { valid: false, confidence: 0.95, dominant_interpretation: 'Customs' },
  });
  const v = await runTwoStageValidation({
    queries: ['AEO consultants Poland'],
    brand: 'Brand', domain: 'brand.com', category: 'AEO services',
    primary,
  });
  assert.equal(v.llmIssues.length, 1);
  assert.equal(v.staticIssues.length, 1, 'static check also catches bare AEO');
});

await test('accepts known good query (expanded form)', async () => {
  const primary = makeMockProvider({
    'best Answer Engine Optimization tools': { valid: true, confidence: 0.92 },
  });
  const v = await runTwoStageValidation({
    queries: ['best Answer Engine Optimization tools'],
    brand: 'Brand', domain: 'brand.com', category: 'AEO services',
    primary,
  });
  assert.equal(v.llmIssues.length, 0);
  assert.equal(v.staticIssues.length, 0);
});

await test('flags concept-vs-vendor confusion', async () => {
  const primary = makeMockProvider({
    'best machine learning': { valid: false, confidence: 0.80, dominant_interpretation: 'Courses/tutorials' },
  });
  const v = await runTwoStageValidation({
    queries: ['best machine learning'],
    brand: 'MLTool', domain: 'mltool.com', category: 'ML platform',
    primary,
  });
  assert.equal(v.llmIssues.length, 1);
});

await test('flags domain collision (apple for fruit company)', async () => {
  const primary = makeMockProvider({
    'apple integrations': { valid: false, confidence: 0.90, dominant_interpretation: 'Apple Inc.' },
  });
  const v = await runTwoStageValidation({
    queries: ['apple integrations'],
    brand: 'FreshApples', domain: 'freshapples.com', category: 'Fruit distribution',
    primary,
  });
  assert.equal(v.llmIssues.length, 1);
});

await test('1.0.8: low confidence does NOT flag when valid=true (trust LLM verdict)', async () => {
  // 1.0.8 changed run-validation.js:186 from `!valid || confidence < threshold`
  // to just `!valid`. Real commercial queries routinely score 0.55-0.70 because
  // LLM accounts for alternate meanings; jejтогда жёсткий порог отвергал
  // нормальные запросы. Confidence stays in cache for audit only.
  const primary = makeMockProvider({
    'CRM for small teams': { valid: true, confidence: 0.55 },
  });
  const v = await runTwoStageValidation({
    queries: ['CRM for small teams'],
    brand: 'Brand', domain: 'brand.com', category: 'CRM software',
    primary,
  });
  assert.equal(v.llmIssues.length, 0,
    'valid:true must accept regardless of confidence (1.0.8 trust-valid rule)');
  // Confidence still present in cache for downstream audit / display.
  assert.equal(v.updatedCache[0].confidence, 0.55);
});

await test('commercial-only default: parametric-only query blocked as informational', async () => {
  const primary = makeMockProvider({
    'history of search engines': {
      valid: true, confidence: 0.85, search_behavior: 'parametric-only',
    },
  });
  const v = await runTwoStageValidation({
    queries: ['history of search engines'],
    brand: 'Brand', domain: 'brand.com', category: 'Search',
    primary,
  });
  assert.equal(v.llmIssues.length, 0, 'no industry-fit issue');
  assert.equal(v.informationalIssues.length, 1, 'commercial-only default must block parametric queries');
  assert.ok(hasBlockers(v), 'hasBlockers must return true when only informationalIssues present');
});

await test('commercial-only default: "mixed" search_behavior also blocked', async () => {
  const primary = makeMockProvider({
    'how to measure AI visibility': {
      valid: true, confidence: 0.9, search_behavior: 'mixed',
    },
  });
  const v = await runTwoStageValidation({
    queries: ['how to measure AI visibility'],
    brand: 'Brand', domain: 'brand.com', category: 'AEO',
    primary,
  });
  assert.equal(v.informationalIssues.length, 1);
  assert.ok(hasBlockers(v));
});

await test('retrieval-triggered query passes commercial-only filter', async () => {
  const primary = makeMockProvider({
    'best CRMs 2026': {
      valid: true, confidence: 0.95, search_behavior: 'retrieval-triggered',
    },
  });
  const v = await runTwoStageValidation({
    queries: ['best CRMs 2026'],
    brand: 'Brand', domain: 'brand.com', category: 'CRM',
    primary,
  });
  assert.equal(v.informationalIssues.length, 0);
  assert.equal(v.llmIssues.length, 0);
  assert.ok(!hasBlockers(v));
});

await test('commercialOnly=false opts out — parametric surfaced but not blocked', async () => {
  const primary = makeMockProvider({
    'history of search engines': {
      valid: true, confidence: 0.85, search_behavior: 'parametric-only',
    },
  });
  const v = await runTwoStageValidation({
    queries: ['history of search engines'],
    brand: 'Brand', domain: 'brand.com', category: 'Search',
    primary,
    commercialOnly: false,
  });
  assert.equal(v.informationalIssues.length, 0, 'opt-out disables commercial filter');
  assert.equal(v.parametricQueries.length, 1, 'but parametric list still populated for UI');
  assert.ok(!hasBlockers(v));
});

await test('cache hit: no LLM call for queries already verified', async () => {
  let called = 0;
  const primary = {
    name: 'mock', apiKey: 'x', model: 'x',
    providerCall: async () => { called++; return { text: '{"results":[]}', raw: {} }; },
  };
  const v = await runTwoStageValidation({
    queries: ['q1', 'q2'],
    brand: 'B', domain: 'b.com', category: 'X',
    primary,
    validationCache: [
      { query: 'q1', valid: true, confidence: 0.9, alternate_meanings: [], search_behavior: 'mixed', reason: 'cached' },
      { query: 'q2', valid: true, confidence: 0.9, alternate_meanings: [], search_behavior: 'mixed', reason: 'cached' },
    ],
  });
  assert.equal(called, 0, 'providerCall should not be invoked when cache covers all queries');
  assert.equal(v.cacheHits, 2);
  assert.equal(v.cacheMisses, 0);
});

await test('cache miss: LLM called only for uncached queries', async () => {
  let callCount = 0;
  let calledWith = null;
  const primary = {
    name: 'mock', apiKey: 'x', model: 'x',
    providerCall: async (prompt) => {
      callCount++;
      calledWith = prompt;
      return {
        text: JSON.stringify({
          results: [{ index: 1, query: 'q3', valid: true, confidence: 0.9, alternate_meanings: ['A', 'B'], search_behavior: 'mixed', reason: 'fresh' }],
        }),
        raw: {},
      };
    },
  };
  const v = await runTwoStageValidation({
    queries: ['q1', 'q2', 'q3'],
    brand: 'B', domain: 'b.com', category: 'X',
    primary,
    validationCache: [
      { query: 'q1', valid: true, confidence: 0.9, alternate_meanings: [], search_behavior: 'mixed', reason: 'cached' },
      { query: 'q2', valid: true, confidence: 0.9, alternate_meanings: [], search_behavior: 'mixed', reason: 'cached' },
    ],
  });
  assert.equal(callCount, 1, 'one LLM call for the single cache-miss query');
  assert.match(calledWith, /q3/, 'LLM prompt contains the uncached query');
  assert.ok(!calledWith.includes('"q1"') || calledWith.split('"q1"').length <= 2, 'cached queries not re-sent');
  assert.equal(v.cacheHits, 2);
  assert.equal(v.cacheMisses, 1);
});

await test('updatedCache drops orphaned entries from old config', async () => {
  const primary = makeMockProvider({});
  const v = await runTwoStageValidation({
    queries: ['only-current'],
    brand: 'B', domain: 'b.com', category: 'X',
    primary,
    validationCache: [
      { query: 'only-current', valid: true, confidence: 0.9, alternate_meanings: [], search_behavior: 'mixed', reason: 'cached' },
      { query: 'stale-from-old-config', valid: true, confidence: 0.9, alternate_meanings: [], search_behavior: 'mixed', reason: 'should be dropped' },
    ],
  });
  assert.equal(v.updatedCache.length, 1, 'orphaned cache entries are pruned');
  assert.equal(v.updatedCache[0].query, 'only-current');
});

await test('no primary provider: LLM stage skipped, static still runs', async () => {
  const v = await runTwoStageValidation({
    queries: ['best AEO agency'],
    brand: 'B', domain: 'b.com', category: 'AEO',
    primary: null,
  });
  assert.equal(v.staticIssues.length, 1, 'static catches AEO');
  assert.equal(v.llmIssues.length, 0, 'no LLM available → no LLM issues');
  assert.equal(v.llmSkipped, true);
});

// ─── mergeCrossCheck voting logic ───

console.log('\nmergeCrossCheck (multi-model voting)');

const mkVerdict = (overrides) => ({
  query: 'q', valid: true, confidence: 0.9,
  alternate_meanings: [], dominant_interpretation: '', search_behavior: 'mixed',
  reason: '', ...overrides,
});

await test('unanimous valid → valid, confidence = avg', () => {
  const m = mergeCrossCheck(
    mkVerdict({ valid: true, confidence: 0.90, reason: 'A' }),
    mkVerdict({ valid: true, confidence: 0.70, reason: 'B' }),
  );
  assert.equal(m.valid, true);
  assert.ok(Math.abs(m.confidence - 0.80) < 0.001);
  assert.equal(m.modelAgreement, 'unanimous');
});

await test('unanimous invalid → invalid, confidence = max (strong rejection signal)', () => {
  const m = mergeCrossCheck(
    mkVerdict({ valid: false, confidence: 0.60, reason: 'customs' }),
    mkVerdict({ valid: false, confidence: 0.95, reason: 'not AEO' }),
  );
  assert.equal(m.valid, false);
  assert.equal(m.confidence, 0.95);
  assert.equal(m.modelAgreement, 'unanimous');
});

await test('split → invalid, confidence = min (conservative block)', () => {
  const m = mergeCrossCheck(
    mkVerdict({ valid: true,  confidence: 0.85 }),
    mkVerdict({ valid: false, confidence: 0.55 }),
  );
  assert.equal(m.valid, false);
  assert.equal(m.confidence, 0.55);
  assert.equal(m.modelAgreement, 'split');
  assert.match(m.reason, /disagree/i);
});

await test('split preserves both verdicts in sources[]', () => {
  const m = mergeCrossCheck(
    mkVerdict({ valid: true, confidence: 0.9, model: 'gpt-5.4-mini', reason: 'approved' }),
    mkVerdict({ valid: false, confidence: 0.7, model: 'claude-haiku-4-5', reason: 'rejected' }),
  );
  assert.equal(m.sources.length, 2);
  assert.equal(m.sources[0].model, 'gpt-5.4-mini');
  assert.equal(m.sources[0].valid, true);
  assert.equal(m.sources[1].model, 'claude-haiku-4-5');
  assert.equal(m.sources[1].valid, false);
});

await test('alternate_meanings merged uniquely, capped at 5', () => {
  const m = mergeCrossCheck(
    mkVerdict({ alternate_meanings: ['A', 'B', 'C'] }),
    mkVerdict({ alternate_meanings: ['C', 'D', 'E', 'F', 'G'] }),
  );
  assert.equal(m.alternate_meanings.length, 5);
  assert.ok(m.alternate_meanings.includes('A'));
  assert.ok(m.alternate_meanings.includes('E'));
});

await test('search_behavior: any retrieval-triggered wins', () => {
  const m = mergeCrossCheck(
    mkVerdict({ search_behavior: 'parametric-only' }),
    mkVerdict({ search_behavior: 'retrieval-triggered' }),
  );
  assert.equal(m.search_behavior, 'retrieval-triggered');
});

await test('returns the other when one side is null', () => {
  const a = mkVerdict({ valid: true });
  assert.deepEqual(mergeCrossCheck(a, null), a);
  assert.deepEqual(mergeCrossCheck(null, a), a);
});

// ─── runTwoStageValidation with secondary provider (cross-check path) ───

console.log('\nruntwoStageValidation + cross-check');

await test('strict mode: both models agree valid → query passes', async () => {
  let primaryCalls = 0, secondaryCalls = 0;
  const mk = (counter, valid, conf) => ({
    name: 'mock', apiKey: 'x', model: `mock-${counter === 'p' ? 'primary' : 'secondary'}`,
    providerCall: async (prompt) => {
      if (counter === 'p') primaryCalls++; else secondaryCalls++;
      return {
        text: JSON.stringify({ results: [{ index: 1, query: 'good query', valid, confidence: conf, alternate_meanings: ['A', 'B'], search_behavior: 'mixed', reason: `${counter} verdict` }] }),
        raw: { usage: { input_tokens: 10, output_tokens: 5 } },
      };
    },
  });
  const primary = mk('p', true, 0.9);
  const secondary = mk('s', true, 0.85);
  const v = await runTwoStageValidation({
    queries: ['good query'],
    brand: 'B', domain: 'b.com', category: 'X',
    primary, secondary,
  });
  assert.equal(primaryCalls, 1);
  assert.equal(secondaryCalls, 1, 'strict mode calls both providers');
  assert.equal(v.llmIssues.length, 0);
  assert.equal(v.llmResults[0].modelAgreement, 'unanimous');
});

await test('strict mode: models split → query blocked, sources visible', async () => {
  const mk = (valid, conf, label) => ({
    name: 'mock', apiKey: 'x', model: label,
    providerCall: async () => ({
      text: JSON.stringify({ results: [{ index: 1, query: 'split query', valid, confidence: conf, alternate_meanings: [], search_behavior: 'mixed', reason: `${label} verdict` }] }),
      raw: {},
    }),
  });
  const v = await runTwoStageValidation({
    queries: ['split query'],
    brand: 'B', domain: 'b.com', category: 'X',
    primary: mk(true, 0.9, 'modelA'),
    secondary: mk(false, 0.6, 'modelB'),
  });
  assert.equal(v.llmIssues.length, 1, 'split counts as blocker');
  const verdict = v.llmResults[0];
  assert.equal(verdict.modelAgreement, 'split');
  assert.equal(verdict.valid, false);
  assert.equal(verdict.sources.length, 2);
});

// ─── Summary ───

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
