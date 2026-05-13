// Tests for the two-model LLM competitor extractor. Covers prompt shape,
// response parsing, hallucination filter, self-brand filter, merge semantics,
// and partial-failure degradation.

import assert from 'node:assert/strict';
import {
  buildExtractorPrompt,
  parseExtractorResponse,
  filterHallucinations,
  applyBrandSelfFilter,
  mergeExtractions,
  extractWithSingleModel,
  extractWithTwoModels,
} from '../lib/report/extract-competitors-llm.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch(err => { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); });
}

// ─── buildExtractorPrompt ───

console.log('\nbuildExtractorPrompt');

await test('includes source text and brand name', () => {
  const p = buildExtractorPrompt({ text: 'Consider **NoGood**.', brand: 'Webappski', domain: 'webappski.com' });
  assert.ok(p.includes('Consider **NoGood**.'));
  assert.ok(p.includes('Webappski'));
  assert.ok(p.includes('webappski.com'));
});

await test('prompt instructs STRICT JSON with brands key', () => {
  const p = buildExtractorPrompt({ text: 't', brand: 'b', domain: 'd.com' });
  assert.ok(/STRICT JSON/i.test(p));
  assert.ok(p.includes('"brands"'));
});

await test('category is injected into prompt when provided', () => {
  const p = buildExtractorPrompt({
    text: 't', brand: 'b', domain: 'd.com',
    category: 'Answer Engine Optimization services',
  });
  assert.ok(p.includes('Answer Engine Optimization services'));
  assert.ok(/DIRECT ALTERNATIVE/i.test(p));
});

await test('no category → no category-line injected (prompt stays backward-compatible)', () => {
  const p = buildExtractorPrompt({ text: 't', brand: 'b', domain: 'd.com' });
  assert.ok(!p.includes('USER CATEGORY:'));
});

await test('prompt mentions platform/source exclusions (Reddit, G2, Trustpilot)', () => {
  const p = buildExtractorPrompt({ text: 't', brand: 'b', domain: 'd.com', category: 'AEO' });
  // These exclusions drive the fix for methodology-query false positives.
  assert.ok(/Reddit/.test(p));
  assert.ok(/G2/.test(p));
  assert.ok(/Trustpilot/.test(p));
});

await test('BUG 2: prompt instructs category-grounded yes/no for Big Tech retailers, STT infra, unrelated industries', () => {
  // Acceptance text from the May-2026 dogfood patch: explicit exclusion of
  // (a) Big Tech / retailers used as examples or customers,
  // (b) infrastructure providers one tier below the user's category,
  // (c) name-dropped companies from unrelated industries.
  const p = buildExtractorPrompt({
    text: 't', brand: 'TypelessForm', domain: 'typelessform.com',
    category: 'voice form filling solution for e-commerce checkout',
  });
  assert.ok(/VENDOR or PRODUCT in the same category/i.test(p),
    'prompt must phrase the test as category-grounded yes/no');
  assert.ok(/EXAMPLES, CUSTOMERS, or CASE STUDIES/i.test(p),
    'prompt must call out the "Big Tech as customer" exclusion');
  assert.ok(/Whisper|AssemblyAI|Deepgram/.test(p),
    'prompt must name STT infrastructure as one-tier-below exclusion');
  assert.ok(/Amazon, Walmart, and Starbucks/.test(p),
    'prompt must include the retailer-as-customer example');
});

// ─── parseExtractorResponse ───

console.log('\nparseExtractorResponse');

await test('parses plain JSON', () => {
  assert.deepEqual(parseExtractorResponse('{"brands":["NoGood","Omniscient"]}'), ['NoGood', 'Omniscient']);
});

await test('strips ```json code fences', () => {
  const raw = '```json\n{"brands":["X"]}\n```';
  assert.deepEqual(parseExtractorResponse(raw), ['X']);
});

await test('extracts JSON from prose preamble', () => {
  const raw = 'Here is the answer:\n\n{"brands":["X","Y"]}';
  assert.deepEqual(parseExtractorResponse(raw), ['X', 'Y']);
});

await test('throws on empty string', () => {
  assert.throws(() => parseExtractorResponse(''), /empty/i);
});

await test('throws on missing brands array', () => {
  assert.throws(() => parseExtractorResponse('{"results":[]}'), /brands.*array/i);
});

await test('throws on non-JSON prose', () => {
  assert.throws(() => parseExtractorResponse('I cannot extract brands.'), /no \{\.\.\.\} block/i);
});

await test('filters non-string and empty entries from brands array', () => {
  const raw = '{"brands":["X",null,42,"","  Y  "]}';
  assert.deepEqual(parseExtractorResponse(raw), ['X', 'Y']);
});

// ─── filterHallucinations ───

console.log('\nfilterHallucinations');

await test('keeps only names present in source text (case-insensitive)', () => {
  const src = 'We use **NoGood** and **omniscient digital**.';
  assert.deepEqual(
    filterHallucinations(['NoGood', 'Omniscient Digital', 'HubSpot'], src),
    ['NoGood', 'Omniscient Digital'],
  );
});

await test('empty source → everything dropped', () => {
  assert.deepEqual(filterHallucinations(['X'], ''), []);
});

// ─── applyBrandSelfFilter ───

console.log('\napplyBrandSelfFilter');

await test('removes own brand case-insensitively', () => {
  const out = applyBrandSelfFilter(['NoGood', 'Webappski', 'webappski inc'], 'Webappski', 'webappski.com');
  assert.deepEqual(out, ['NoGood']);
});

await test('removes entries containing the domain core', () => {
  const out = applyBrandSelfFilter(['NoGood', 'webappski'], 'Brand', 'webappski.com');
  assert.deepEqual(out, ['NoGood']);
});

await test('short domain cores (<4 chars) are not used', () => {
  // "ab.com" has domain core "ab" — too short to filter, would hit false positives.
  const out = applyBrandSelfFilter(['Absolute', 'Abacus'], 'Brand', 'ab.com');
  assert.deepEqual(out, ['Absolute', 'Abacus']);
});

// ─── mergeExtractions ───

console.log('\nmergeExtractions');

await test('intersection → verified, symmetric difference → unverified', () => {
  const { verified, unverified } = mergeExtractions(
    ['NoGood', 'Omniscient', 'Minuttia'],
    ['NoGood', 'Omniscient', 'HubSpot'],
  );
  assert.deepEqual(verified.sort(), ['NoGood', 'Omniscient'].sort());
  assert.deepEqual(unverified.sort(), ['Minuttia', 'HubSpot'].sort());
});

await test('case-insensitive merge, keeps first-seen casing', () => {
  const { verified } = mergeExtractions(['NoGood'], ['nogood']);
  assert.deepEqual(verified, ['NoGood']); // primary (a) seen first
});

await test('whitespace variants collapse', () => {
  const { verified } = mergeExtractions(['Pol-Agent'], ['Pol-Agent']);
  assert.equal(verified.length, 1);
});

await test('empty inputs yield empty output', () => {
  assert.deepEqual(mergeExtractions([], []), { verified: [], unverified: [] });
});

await test('null-tolerant', () => {
  assert.deepEqual(mergeExtractions(null, ['X']), { verified: [], unverified: ['X'] });
  assert.deepEqual(mergeExtractions(['X'], null), { verified: [], unverified: ['X'] });
});

// ─── extractWithSingleModel (mocked provider) ───

console.log('\nextractWithSingleModel');

function mockProvider(jsonResponse) {
  return async () => ({ text: jsonResponse, raw: {} });
}

await test('end-to-end: extracts, filters hallucinations, filters self-brand', async () => {
  const source = 'We recommend **NoGood** and **Omniscient Digital**. Webappski is ok.';
  const { brands } = await extractWithSingleModel({
    text: source,
    brand: 'Webappski',
    domain: 'webappski.com',
    providerCall: mockProvider('{"brands":["NoGood","Omniscient Digital","Webappski","HubSpotHallucinated"]}'),
    providerName: 'openai',
    apiKey: 'fake',
    model: 'gpt-5.4-mini',
  });
  // Webappski filtered by self-filter; HubSpotHallucinated filtered by hallucination check
  assert.deepEqual(brands.sort(), ['NoGood', 'Omniscient Digital'].sort());
});

await test('empty source returns empty without calling provider', async () => {
  let called = false;
  const { brands } = await extractWithSingleModel({
    text: '',
    brand: 'X', domain: 'x.com',
    providerCall: async () => { called = true; return { text: '', raw: {} }; },
    providerName: 'openai', apiKey: 'k', model: 'm',
  });
  assert.deepEqual(brands, []);
  assert.equal(called, false, 'provider should not be called for empty text');
});

await test('provider parse error propagates', async () => {
  await assert.rejects(
    () => extractWithSingleModel({
      text: 'x',
      brand: 'b', domain: 'd.com',
      providerCall: async () => ({ text: 'not json', raw: {} }),
      providerName: 'openai', apiKey: 'k', model: 'm',
    }),
    /extractor response/i,
  );
});

// ─── extractWithTwoModels (the main entry point) ───

console.log('\nextractWithTwoModels (parallel cross-check)');

const SOURCE = 'Top agencies: **NoGood**, **Omniscient Digital**, **Minuttia**, **HubSpot**.';

await test('both models agree → all in verified', async () => {
  const result = await extractWithTwoModels({
    text: SOURCE, brand: 'X', domain: 'x.com',
    primary:   { name: 'openai', providerCall: mockProvider('{"brands":["NoGood","Omniscient Digital"]}'), apiKey: 'k', model: 'gpt-5.4-mini' },
    secondary: { name: 'gemini', providerCall: mockProvider('{"brands":["NoGood","Omniscient Digital"]}'), apiKey: 'k', model: 'gemini-2.5-flash' },
  });
  assert.deepEqual(result.verified.sort(), ['NoGood', 'Omniscient Digital'].sort());
  assert.deepEqual(result.unverified, []);
});

await test('models disagree → disagreements land in unverified', async () => {
  const result = await extractWithTwoModels({
    text: SOURCE, brand: 'X', domain: 'x.com',
    primary:   { name: 'openai', providerCall: mockProvider('{"brands":["NoGood","Minuttia"]}'),  apiKey: 'k', model: 'gpt-5.4-mini' },
    secondary: { name: 'gemini', providerCall: mockProvider('{"brands":["NoGood","HubSpot"]}'),   apiKey: 'k', model: 'gemini-2.5-flash' },
  });
  assert.deepEqual(result.verified, ['NoGood']);
  assert.deepEqual(result.unverified.sort(), ['Minuttia', 'HubSpot'].sort());
});

await test('primary fails → secondary brands all go to unverified, no crash', async () => {
  const result = await extractWithTwoModels({
    text: SOURCE, brand: 'X', domain: 'x.com',
    primary:   { name: 'openai', providerCall: async () => { throw new Error('rate limit'); }, apiKey: 'k', model: 'gpt-5.4-mini' },
    secondary: { name: 'gemini', providerCall: mockProvider('{"brands":["NoGood"]}'),           apiKey: 'k', model: 'gemini-2.5-flash' },
  });
  assert.deepEqual(result.verified, []);
  assert.deepEqual(result.unverified, ['NoGood']);
  assert.ok(result.sources.primary.error, 'primary error should be recorded');
});

await test('secondary fails → primary brands go to unverified', async () => {
  const result = await extractWithTwoModels({
    text: SOURCE, brand: 'X', domain: 'x.com',
    primary:   { name: 'openai', providerCall: mockProvider('{"brands":["NoGood"]}'),           apiKey: 'k', model: 'gpt-5.4-mini' },
    secondary: { name: 'gemini', providerCall: async () => { throw new Error('503'); },         apiKey: 'k', model: 'gemini-2.5-flash' },
  });
  assert.deepEqual(result.verified, []);
  assert.deepEqual(result.unverified, ['NoGood']);
  assert.ok(result.sources.secondary.error);
});

await test('both fail → empty result, no crash', async () => {
  const result = await extractWithTwoModels({
    text: SOURCE, brand: 'X', domain: 'x.com',
    primary:   { name: 'openai', providerCall: async () => { throw new Error('e'); }, apiKey: 'k', model: 'm' },
    secondary: { name: 'gemini', providerCall: async () => { throw new Error('e'); }, apiKey: 'k', model: 'm' },
  });
  assert.deepEqual(result.verified, []);
  assert.deepEqual(result.unverified, []);
});

await test('hallucinations from one model filtered before merge', async () => {
  // Primary invents "FakeBrand" not in source. Secondary lists real ones.
  // FakeBrand should NOT appear anywhere in output.
  const result = await extractWithTwoModels({
    text: SOURCE, brand: 'X', domain: 'x.com',
    primary:   { name: 'openai', providerCall: mockProvider('{"brands":["NoGood","FakeBrand"]}'), apiKey: 'k', model: 'gpt' },
    secondary: { name: 'gemini', providerCall: mockProvider('{"brands":["NoGood"]}'),             apiKey: 'k', model: 'gem' },
  });
  assert.deepEqual(result.verified, ['NoGood']);
  assert.deepEqual(result.unverified, []);
  assert.ok(!result.sources.primary.brands.includes('FakeBrand'), 'hallucination must be dropped from sources too');
});

await test('self-brand filtered even if both models return it', async () => {
  const text = 'Check **Webappski** and **NoGood**.';
  const result = await extractWithTwoModels({
    text, brand: 'Webappski', domain: 'webappski.com',
    primary:   { name: 'openai', providerCall: mockProvider('{"brands":["Webappski","NoGood"]}'), apiKey: 'k', model: 'm' },
    secondary: { name: 'gemini', providerCall: mockProvider('{"brands":["Webappski","NoGood"]}'), apiKey: 'k', model: 'm' },
  });
  assert.deepEqual(result.verified, ['NoGood']);
});

// ─── BUG 2 fixture: real Gemini Q2 response excerpt, category = voice-form-filling ───
//
// The fixture mentions Amazon / Walmart / Starbucks (retailers as customers
// of voice UX) and STT-infra (Whisper / AssemblyAI / Deepgram / Web Speech
// API) — none of which are competitors to a voice-form-filling product. The
// May-2026 dogfood run incorrectly classified them as competitors; the
// category-grounded prompt + cross-check must now exclude them all.
//
// We assert two things:
//   1. The category-grounded prompt embeds the source text and category.
//   2. When both models correctly return brands: [] under the new prompt
//      semantics, the merged extractor returns no competitors — the
//      cross-check pipeline propagates the empty result instead of falling
//      back to one model's output.

console.log('\nBUG 2 — fixture: voice-form-filling Q2 with retailer/STT-infra distractors');

const FIXTURE_PATH = new URL('./fixtures/gemini-q2-voice-checkout-excerpt.txt', import.meta.url);
const { readFile } = await import('node:fs/promises');
const fixtureText = await readFile(FIXTURE_PATH, 'utf-8');

await test('fixture sanity: contains Amazon, Walmart, Starbucks, Whisper, AssemblyAI, vellis', () => {
  for (const name of ['Amazon', 'Walmart', 'Starbucks', 'Whisper', 'AssemblyAI', 'vellis.financial']) {
    assert.ok(fixtureText.includes(name), `fixture should contain "${name}"`);
  }
});

await test('prompt for fixture includes category and source text', () => {
  const p = buildExtractorPrompt({
    text: fixtureText,
    brand: 'TypelessForm',
    domain: 'typelessform.com',
    category: 'voice form filling solution for e-commerce checkout',
  });
  assert.ok(p.includes('voice form filling solution for e-commerce checkout'));
  assert.ok(p.includes('Walmart'));
  assert.ok(p.includes('vellis.financial'));
});

await test('both models correctly return [] under new prompt → no Amazon/Walmart/Starbucks/vellis as competitors', async () => {
  // Simulates both models doing the right thing under the category-grounded prompt:
  // retailers as customers + STT infra + unrelated fintech all excluded.
  const result = await extractWithTwoModels({
    text: fixtureText,
    brand: 'TypelessForm', domain: 'typelessform.com',
    category: 'voice form filling solution for e-commerce checkout',
    primary:   { name: 'openai', providerCall: async () => ({ text: '{"brands":[]}', raw: {} }), apiKey: 'k', model: 'gpt-5.4-mini' },
    secondary: { name: 'gemini', providerCall: async () => ({ text: '{"brands":[]}', raw: {} }), apiKey: 'k', model: 'gemini-2.5-flash' },
  });
  assert.deepEqual(result.verified, []);
  assert.deepEqual(result.unverified, []);
  for (const name of ['Amazon', 'Walmart', 'Starbucks', 'vellis.financial', 'Whisper', 'AssemblyAI']) {
    assert.ok(!result.verified.includes(name),
      `${name} must NOT be a verified competitor`);
    assert.ok(!result.unverified.includes(name),
      `${name} must NOT be an unverified competitor`);
  }
});

await test('one model regresses (still lists retailers) → they land only in unverified, not verified', async () => {
  // Cross-check resilience: if ONE model still returns Amazon/Walmart/Starbucks
  // under the new prompt, the merge tier puts them in `unverified` only. The
  // «verified» (rendered prominently) tier must stay clean.
  const result = await extractWithTwoModels({
    text: fixtureText,
    brand: 'TypelessForm', domain: 'typelessform.com',
    category: 'voice form filling solution for e-commerce checkout',
    primary:   { name: 'openai', providerCall: async () => ({ text: '{"brands":["Amazon","Walmart","Starbucks"]}', raw: {} }), apiKey: 'k', model: 'm' },
    secondary: { name: 'gemini', providerCall: async () => ({ text: '{"brands":[]}', raw: {} }), apiKey: 'k', model: 'm' },
  });
  assert.deepEqual(result.verified, [], 'cross-check disagreement → verified tier must be empty');
  // They appear in unverified (the dashed-badge tier), but never as «verified competitors».
  assert.ok(['Amazon', 'Walmart', 'Starbucks'].every(n => result.unverified.includes(n)));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
