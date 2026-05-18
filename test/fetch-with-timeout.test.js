// Tests for lib/util/fetch-with-timeout.js — universal HTTP timeout wrapper.
// Covers signal composition + timeout normalization + kind-based defaults.

import assert from 'node:assert/strict';

const { fetchWithTimeout, _internals } = await import('../lib/util/fetch-with-timeout.js');

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); });
}

const originalFetch = globalThis.fetch;
function restore() { globalThis.fetch = originalFetch; }

console.log('\nfetchWithTimeout — success path');

await test('returns Response when fetch resolves before timeout', async () => {
  globalThis.fetch = async () => ({ status: 200, ok: true });
  const res = await fetchWithTimeout('https://example.com', {}, { timeoutMs: 5000 });
  assert.equal(res.status, 200);
});

console.log('\nfetchWithTimeout — timeout error normalization');

await test('fetch rejection with name=TimeoutError → re-thrown as ETIMEDOUT', async () => {
  globalThis.fetch = async () => {
    const e = new Error('timed out');
    e.name = 'TimeoutError';
    throw e;
  };
  let caught;
  try {
    await fetchWithTimeout('https://example.com', {}, { timeoutMs: 1000 });
  } catch (err) { caught = err; }
  assert.equal(caught?.name, 'TimeoutError');
  assert.equal(caught?.code, 'ETIMEDOUT');
});

await test('external pre-aborted signal → AbortError (not timeout)', async () => {
  globalThis.fetch = async (url, init) => {
    if (init.signal?.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    return { status: 200 };
  };
  const ac = new AbortController();
  ac.abort();
  let caught;
  try {
    await fetchWithTimeout('https://example.com', { signal: ac.signal }, { timeoutMs: 5000 });
  } catch (err) { caught = err; }
  assert.notEqual(caught?.code, 'ETIMEDOUT');
});

await test('network error (non-timeout) re-thrown unchanged', async () => {
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  let caught;
  try {
    await fetchWithTimeout('https://example.com', {}, { timeoutMs: 5000 });
  } catch (err) { caught = err; }
  assert.equal(caught.code, undefined);
  assert.match(caught.message, /ECONNREFUSED/);
});

console.log('\nfetchWithTimeout — kind defaults');

await test('bootstrap kind = 30s, runtime = 60s, site = 15s', () => {
  assert.equal(_internals.DEFAULT_TIMEOUTS.bootstrap, 30_000);
  assert.equal(_internals.DEFAULT_TIMEOUTS.runtime, 60_000);
  assert.equal(_internals.DEFAULT_TIMEOUTS.site, 15_000);
});

await test('explicit timeoutMs overrides kind default', () => {
  assert.equal(_internals.resolveTimeout({ timeoutMs: 7777, kind: 'bootstrap' }), 7777);
});

await test('sub-1000ms timeoutMs refused (returns null)', () => {
  assert.equal(_internals.resolveTimeout({ timeoutMs: 1 }), null);
});

await test('accepts sub-second values >=10ms (tests need this)', () => {
  assert.equal(_internals.resolveTimeout({ timeoutMs: 100 }), 100);
});

restore();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
