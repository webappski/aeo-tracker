// Unit test: authority profile detection.
//
// The profile decides which extra authority sources fire on top of the
// always-on wiki+reddit baseline. Wrong detection ships irrelevant data
// (e.g. fetching GitHub for a restaurant chain) or misses signal (e.g.
// not fetching GitHub for an obvious CLI tool) — both are user-visible
// regressions. This suite locks the matrix.

import { getAuthorityProfile } from '../lib/report/authority-profiles.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

console.log('authority-profiles — getAuthorityProfile()');

// ─── dev-tool detection ────────────────────────────────────────────────

test('category "open-source CLI" → dev-tool, extras includes github', () => {
  const p = getAuthorityProfile({ brand: 'X', domain: 'x.io', category: 'open-source CLI for whatever' });
  assert(p.type === 'dev-tool', `expected dev-tool, got ${p.type}`);
  assert(p.extras.includes('github'), `expected github in extras, got ${p.extras}`);
  assert(typeof p.caveat === 'string' && p.caveat.length > 0, 'expected caveat for dev-tool');
});

test('category "Node.js SDK" → dev-tool', () => {
  const p = getAuthorityProfile({ brand: 'X', domain: 'x.com', category: 'Node.js SDK for stripe' });
  assert(p.type === 'dev-tool', `expected dev-tool, got ${p.type}`);
});

test('domain ".dev" alone (no category) → dev-tool', () => {
  const p = getAuthorityProfile({ brand: 'X', domain: 'foo.dev', category: '' });
  assert(p.type === 'dev-tool', `expected dev-tool, got ${p.type}`);
});

// ─── saas detection ────────────────────────────────────────────────────

test('category "B2B SaaS platform" → saas, no github extra', () => {
  const p = getAuthorityProfile({ brand: 'X', domain: 'x.com', category: 'B2B SaaS analytics platform' });
  assert(p.type === 'saas', `expected saas, got ${p.type}`);
  assert(!p.extras.includes('github'), 'saas should NOT trigger github extra in Phase 1');
});

// ─── consumer detection ────────────────────────────────────────────────

test('category "consumer e-commerce" → consumer', () => {
  const p = getAuthorityProfile({ brand: 'X', domain: 'x.com', category: 'consumer e-commerce brand' });
  assert(p.type === 'consumer', `expected consumer, got ${p.type}`);
});

// ─── default fallback ─────────────────────────────────────────────────

test('no signals at all → default, extras empty, no caveat', () => {
  const p = getAuthorityProfile({ brand: 'X', domain: 'x.com', category: 'something unclassifiable' });
  assert(p.type === 'default', `expected default, got ${p.type}`);
  assert(p.extras.length === 0, `expected empty extras, got ${p.extras}`);
  assert(!p.caveat, 'default should not have caveat');
});

test('completely empty input → default (no crash)', () => {
  const p = getAuthorityProfile({});
  assert(p.type === 'default', `expected default, got ${p.type}`);
});

// ─── pageSignals heading fallback ─────────────────────────────────────

test('empty category but pageSignals H1 mentions "AEO Studio" → dev-tool', () => {
  const p = getAuthorityProfile({
    brand: 'Webappski', domain: 'webappski.com', category: '',
    pageSignals: {
      homepage: {
        headings: {
          h1: { samples: ['AEO Studio Webappski — answer-engine optimization'] },
          h2: { samples: ['How we work'] },
        },
      },
    },
  });
  assert(p.type === 'dev-tool', `expected dev-tool from heading fallback, got ${p.type}`);
});

test('empty category, pageSignals H2 mentions "AI visibility" → dev-tool', () => {
  const p = getAuthorityProfile({
    brand: 'X', domain: 'x.com', category: '',
    pageSignals: {
      homepage: { headings: { h1: { samples: ['Some headline'] }, h2: { samples: ['AI visibility audits'] } } },
    },
  });
  assert(p.type === 'dev-tool', `expected dev-tool via H2, got ${p.type}`);
});

test('AEO-studio hybrid: headings mention both "B2B SaaS" and "ChatGPT" → dev-tool wins (not saas)', () => {
  // Real-world Webappski case: H1 = «Get your B2B SaaS cited by ChatGPT,
  // Claude, Gemini, and Perplexity». Without explicit dev-tool priority on
  // engine names, the saas regex would grab «B2B SaaS» first and the brand
  // would lose its dev-tool authority signal (GitHub).
  const p = getAuthorityProfile({
    brand: 'Webappski', domain: 'webappski.com', category: '',
    pageSignals: {
      homepage: {
        headings: {
          h1: { samples: ['Get your B2B SaaS cited by ChatGPT, Claude, Gemini, and Perplexity'] },
          h2: { samples: ['What We Do', 'Featured in AI Answers'] },
        },
      },
    },
  });
  assert(p.type === 'dev-tool', `expected dev-tool (AEO studio overrides saas via engine names), got ${p.type}`);
  assert(p.extras.includes('github'), 'expected github in extras for AEO studio');
});

test('malformed pageSignals shape → no crash, falls back to default', () => {
  const p = getAuthorityProfile({
    brand: 'X', domain: 'x.com', category: '',
    pageSignals: { homepage: null },
  });
  assert(p.type === 'default', `expected default, got ${p.type}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
