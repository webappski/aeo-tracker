// Tests for the outreach template generator. Covers prompt shape, JSON parse,
// graceful no-op on empty topDomains, and stub-driven end-to-end.

import assert from 'node:assert/strict';
import {
  buildOutreachPrompt,
  parseOutreachResponse,
  generateOutreachTemplates,
  filterOwnDomainFromTopDomains,
} from '../lib/report/outreach-templates.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch(err => { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); });
}

// ─── buildOutreachPrompt ───

console.log('\nbuildOutreachPrompt');

await test('lists top domains with citation count and share', () => {
  const p = buildOutreachPrompt({
    brand: 'Acme', domain: 'acme.com', category: 'CRM',
    topDomains: [
      { host: 'g2.com', count: 19, share: 0.193 },
      { host: 'capterra.com', count: 17, share: 0.169 },
    ],
  });
  assert.ok(p.includes('Acme'));
  assert.ok(p.includes('CRM'));
  assert.ok(p.includes('g2.com'));
  assert.ok(p.includes('19×'));
  assert.ok(/19\.3%/.test(p));
});

await test('caps prompt domains at 3', () => {
  const p = buildOutreachPrompt({
    brand: 'A', domain: 'a.com', category: 'X',
    topDomains: [
      { host: 'a.com', count: 5, share: 0.5 },
      { host: 'b.com', count: 3, share: 0.3 },
      { host: 'c.com', count: 1, share: 0.1 },
      { host: 'd.com', count: 1, share: 0.1 },
    ],
  });
  assert.ok(p.includes('a.com'));
  assert.ok(p.includes('c.com'));
  assert.ok(!p.includes('d.com'));
});

await test('demands STRICT JSON with templates array', () => {
  const p = buildOutreachPrompt({ brand: 'b', domain: 'd', category: 'c', topDomains: [{host:'x.com',count:1,share:1}] });
  assert.ok(/STRICT JSON/i.test(p));
  assert.ok(p.includes('"templates"'));
  assert.ok(p.includes('"subject"'));
  assert.ok(p.includes('"body"'));
});

// ─── parseOutreachResponse ───

console.log('\nparseOutreachResponse');

await test('parses array of templates', () => {
  const raw = JSON.stringify({
    templates: [
      { host: 'g2.com', subject: 'Hi from Acme', body: 'Saw your CRM article...', why: 'top citation' },
    ],
  });
  const out = parseOutreachResponse(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].host, 'g2.com');
  assert.equal(out[0].subject, 'Hi from Acme');
});

await test('strips ```json fences', () => {
  const out = parseOutreachResponse('```json\n{"templates":[{"host":"a.com","subject":"S","body":"B"}]}\n```');
  assert.equal(out[0].host, 'a.com');
});

await test('drops malformed entries (missing required fields)', () => {
  const raw = JSON.stringify({
    templates: [
      { host: 'ok.com', subject: 'S', body: 'B' },
      { host: 'bad.com' }, // missing subject/body
      { subject: 'S2', body: 'B2' }, // missing host
    ],
  });
  const out = parseOutreachResponse(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].host, 'ok.com');
});

await test('rejects non-JSON', () => {
  assert.throws(() => parseOutreachResponse('definitely not json no braces here'), /not JSON/);
});

await test('rejects missing templates array', () => {
  assert.throws(() => parseOutreachResponse('{"foo":1}'), /missing "templates"/);
});

await test('truncates over-long subject', () => {
  const long = 'x'.repeat(500);
  const out = parseOutreachResponse(JSON.stringify({
    templates: [{ host: 'a.com', subject: long, body: 'b' }],
  }));
  assert.equal(out[0].subject.length, 200);
});

// ─── generateOutreachTemplates (with stub providerCall) ───

console.log('\ngenerateOutreachTemplates');

await test('empty topDomains → no LLM call, empty result', async () => {
  let called = false;
  const r = await generateOutreachTemplates({
    brand: 'b', domain: 'd.com', category: 'c',
    topDomains: [],
    providerName: 'stub',
    providerCall: async () => { called = true; return { text: '{}', raw: {} }; },
    apiKey: 'k', model: 'm',
  });
  assert.equal(r.templates.length, 0);
  assert.equal(called, false);
});

await test('missing brand or category → no LLM call', async () => {
  let called = false;
  const r = await generateOutreachTemplates({
    brand: '', domain: 'd.com', category: 'c',
    topDomains: [{ host: 'a.com', count: 1, share: 1 }],
    providerName: 'stub',
    providerCall: async () => { called = true; return { text: '{}', raw: {} }; },
    apiKey: 'k', model: 'm',
  });
  assert.equal(r.templates.length, 0);
  assert.equal(called, false);
});

await test('happy path with stub provider', async () => {
  const r = await generateOutreachTemplates({
    brand: 'Acme', domain: 'acme.com', category: 'CRM',
    topDomains: [{ host: 'g2.com', count: 5, share: 0.5 }],
    providerName: 'stub',
    providerCall: async () => ({
      text: JSON.stringify({ templates: [{ host: 'g2.com', subject: 'Hi', body: 'Body', why: 'top' }] }),
      raw: { usage: { prompt_tokens: 100, completion_tokens: 50 } },
    }),
    apiKey: 'k', model: 'gpt-test',
  });
  assert.equal(r.templates.length, 1);
  assert.equal(r.templates[0].host, 'g2.com');
  assert.ok(r.costInfo);
});

// ─── filterOwnDomainFromTopDomains (BUG 1 — own-domain self-pitch) ───

console.log('\nfilterOwnDomainFromTopDomains (own-domain self-pitch guard)');

await test('strips the user\'s own domain from topDomains', () => {
  const out = filterOwnDomainFromTopDomains(
    [
      { host: 'typelessform.com', count: 19, share: 0.30 },
      { host: 'g2.com',           count: 12, share: 0.19 },
      { host: 'capterra.com',     count: 8,  share: 0.13 },
    ],
    'typelessform.com',
  );
  assert.deepEqual(out.map(d => d.host), ['g2.com', 'capterra.com']);
});

await test('strips subdomains of the user\'s own domain', () => {
  const out = filterOwnDomainFromTopDomains(
    [
      { host: 'blog.typelessform.com', count: 5, share: 0.5 },
      { host: 'g2.com',                count: 5, share: 0.5 },
    ],
    'typelessform.com',
  );
  assert.deepEqual(out.map(d => d.host), ['g2.com']);
});

await test('handles www-prefixed and protocol-prefixed config values', () => {
  const out = filterOwnDomainFromTopDomains(
    [{ host: 'typelessform.com', count: 1, share: 1 }, { host: 'g2.com', count: 1, share: 1 }],
    'https://www.typelessform.com/',
  );
  assert.deepEqual(out.map(d => d.host), ['g2.com']);
});

await test('no own-domain config → identity passthrough', () => {
  const input = [{ host: 'a.com', count: 1, share: 1 }];
  assert.deepEqual(filterOwnDomainFromTopDomains(input, ''), input);
});

await test('generateOutreachTemplates: own-domain-only list returns empty without LLM call', async () => {
  let called = false;
  const r = await generateOutreachTemplates({
    brand: 'Typeless Form',
    domain: 'typelessform.com',
    category: 'voice form filling',
    topDomains: [{ host: 'typelessform.com', count: 19, share: 0.3 }],
    providerName: 'stub',
    providerCall: async () => { called = true; return { text: '{}', raw: {} }; },
    apiKey: 'k', model: 'm',
  });
  assert.equal(r.templates.length, 0, 'no self-pitch emails generated');
  assert.equal(called, false, 'LLM should not be invoked when all candidates are own-domain');
});

await test('generateOutreachTemplates: own-domain stripped, external domains still pitched', async () => {
  let promptSent = '';
  const r = await generateOutreachTemplates({
    brand: 'Typeless Form',
    domain: 'typelessform.com',
    category: 'voice form filling',
    topDomains: [
      { host: 'typelessform.com', count: 19, share: 0.3 },
      { host: 'g2.com',           count: 12, share: 0.19 },
    ],
    providerName: 'stub',
    providerCall: async (prompt) => {
      promptSent = prompt;
      return {
        text: JSON.stringify({ templates: [{ host: 'g2.com', subject: 'Hi', body: 'B', why: 'top' }] }),
        raw: { usage: { prompt_tokens: 50, completion_tokens: 20 } },
      };
    },
    apiKey: 'k', model: 'gpt-test',
  });
  // The user's own domain still appears in the «USER:» context block (the
  // prompt tells the LLM whose brand we are pitching FOR), but it must NOT
  // appear in the TOP-CITED PUBLISHERS list — that list drives outreach
  // targets and is the surface the dogfood bug fired on.
  const publishersBlock = promptSent.split('TOP-CITED PUBLISHERS')[1] || '';
  assert.ok(!publishersBlock.includes('typelessform.com'),
    'own domain must not appear in the TOP-CITED PUBLISHERS section of the prompt');
  assert.ok(publishersBlock.includes('g2.com'),
    'external domain must remain in the TOP-CITED PUBLISHERS section');
  assert.equal(r.templates.length, 1);
  assert.equal(r.templates[0].host, 'g2.com');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
