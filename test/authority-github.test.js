// Unit test: GitHub authority source.
//
// Disambiguation is the critical guard — naive search ranks by stars
// and would surface unrelated repos for popular brand names (Spotify →
// spotify/web-api-examples, Uber → some random repo with "uber" in the
// name, etc.). The owner-match gate (`owner === brandSlug` or matches
// domain root) is mandatory; this suite locks it.

import { checkGitHub } from '../lib/report/authority-github.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch(err => { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); });
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

// Minimal mock-fetch helper — returns a Response-shaped object based on
// the URL the source requested. Each test wires up its own scenario.
function mockFetch(routes) {
  return async function (url) {
    for (const [pattern, response] of routes) {
      if (typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url)) {
        const r = typeof response === 'function' ? await response(url) : response;
        return {
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          json: async () => r.body,
        };
      }
    }
    throw new Error(`mockFetch: no route for ${url}`);
  };
}

console.log('authority-github — checkGitHub() disambiguation');

await test('deterministic owner lookup: /users/:brand exists → trusted, no search', async () => {
  // Route order matters — repos pattern must match before the bare /users/ pattern
  // (the repos URL contains "/users/webappski/repos" and would otherwise match the
  // user lookup route).
  const fetchImpl = mockFetch([
    [/\/users\/[^/]+\/repos/, { status: 200, body: [{ name: 'aeo-tracker', full_name: 'webappski/aeo-tracker', html_url: 'https://github.com/webappski/aeo-tracker', stargazers_count: 42, forks_count: 3, pushed_at: '2026-04-01T00:00:00Z', description: 'AEO tracker' }] }],
    ['/users/webappski', { status: 200, body: { login: 'webappski', type: 'User', followers: 5, public_repos: 7, html_url: 'https://github.com/webappski' } }],
  ]);
  const r = await checkGitHub({ brand: 'Webappski', domain: 'webappski.com', fetchImpl });
  assert(r.found === true, `expected found, got ${JSON.stringify(r)}`);
  assert(r.owner === 'webappski', `expected owner=webappski, got ${r.owner}`);
  assert(r.topRepo && r.topRepo.stars === 42, `expected top repo stars=42, got ${JSON.stringify(r.topRepo)}`);
});

await test('owner 404 + search returns wrong-owner top hit → REJECTED (Spotify case)', async () => {
  // The "Spotify" trap: /search/repositories?q=Spotify returns 100s of
  // unrelated repos by stars. Top hit owner != "spotify" → must reject.
  const fetchImpl = mockFetch([
    ['/users/spotify', { status: 404, body: {} }],
    ['/search/repositories', { status: 200, body: { items: [
      { name: 'web-api-examples', owner: { login: 'random-user', html_url: 'https://github.com/random-user', type: 'User' }, stargazers_count: 99999, forks_count: 100, pushed_at: '2026-04-01T00:00:00Z', html_url: 'https://github.com/random-user/web-api-examples', full_name: 'random-user/web-api-examples', description: 'demos' },
    ] } }],
  ]);
  const r = await checkGitHub({ brand: 'Spotify', domain: 'spotify.com', fetchImpl });
  assert(r.found === false, `expected NOT found (disambiguation should reject), got ${JSON.stringify(r)}`);
  assert(r.searched === true, 'expected searched=true marker');
});

await test('owner 404 + search matches owner via domain root → ACCEPTED', async () => {
  // Brand "Acme Co" → brandSlug = "acme-co". But the actual GitHub org is
  // "acme" (domain root) — the search hit should be accepted via the
  // domain-slug branch of the owner-match gate.
  const fetchImpl = mockFetch([
    ['/users/acme-co', { status: 404, body: {} }],
    ['/search/repositories', { status: 200, body: { items: [
      { name: 'sdk', owner: { login: 'acme', html_url: 'https://github.com/acme', type: 'Organization' }, stargazers_count: 200, forks_count: 10, pushed_at: '2026-04-01T00:00:00Z', html_url: 'https://github.com/acme/sdk', full_name: 'acme/sdk', description: '' },
    ] } }],
  ]);
  const r = await checkGitHub({ brand: 'Acme Co', domain: 'acme.com', fetchImpl });
  assert(r.found === true, `expected found via domain-root match, got ${JSON.stringify(r)}`);
  assert(r.owner === 'acme', `expected owner=acme, got ${r.owner}`);
});

await test('no brand → soft fail, no fetch attempt', async () => {
  const r = await checkGitHub({ brand: '', domain: 'x.com', fetchImpl: () => { throw new Error('should not fetch'); } });
  assert(r.found === false, 'expected found=false');
  assert(r.error === 'no brand', `expected error=no brand, got ${r.error}`);
});

await test('GitHub rate limit (403) on search → exposes actionable error', async () => {
  const fetchImpl = mockFetch([
    ['/users/', { status: 404, body: {} }],
    ['/search/', { status: 403, body: {} }],
  ]);
  const r = await checkGitHub({ brand: 'Webappski', domain: 'webappski.com', fetchImpl });
  assert(r.found === false, 'expected found=false on rate-limit');
  assert(/rate-limited/.test(r.error || ''), `expected rate-limit hint in error, got ${r.error}`);
});

await test('GITHUB_TOKEN env wired into Authorization header', async () => {
  process.env.GITHUB_TOKEN = 'test-token-123';
  let capturedAuth = null;
  const fetchImpl = async (url, opts = {}) => {
    capturedAuth = (opts.headers && opts.headers.Authorization) || null;
    return { ok: true, status: 200, json: async () => ({ login: 'webappski', type: 'User', followers: 0, public_repos: 0, html_url: 'https://github.com/webappski' }) };
  };
  await checkGitHub({ brand: 'Webappski', domain: 'webappski.com', fetchImpl });
  assert(capturedAuth === 'Bearer test-token-123', `expected Bearer auth, got ${capturedAuth}`);
  delete process.env.GITHUB_TOKEN;
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
