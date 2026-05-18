// Tests for lib/util/spinner.js.
// Uses a captured mock stream so we can assert exact bytes — avoids real TTY
// side effects during test runs.

import assert from 'node:assert/strict';
import { createSpinner, formatElapsed } from '../lib/util/spinner.js';

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

function mockStream(isTTY) {
  const writes = [];
  return {
    isTTY,
    writes,
    write(chunk) { writes.push(chunk); return true; },
  };
}

// ─── formatElapsed ───

test('formatElapsed: sub-second → Nms', () => {
  assert.equal(formatElapsed(0), '0ms');
  assert.equal(formatElapsed(42), '42ms');
  assert.equal(formatElapsed(999), '999ms');
});

test('formatElapsed: seconds → N.Ns', () => {
  assert.equal(formatElapsed(1000), '1.0s');
  assert.equal(formatElapsed(3500), '3.5s');
  assert.equal(formatElapsed(59_900), '59.9s');
});

test('formatElapsed: minutes → Nm Ns', () => {
  assert.equal(formatElapsed(60_000), '1m 0s');
  assert.equal(formatElapsed(125_000), '2m 5s');
});

// ─── TTY detection ───

test('createSpinner: non-TTY → all methods are no-op', async () => {
  const s = mockStream(false);
  const sp = createSpinner({ stream: s });
  sp.start('anything');
  await new Promise(r => setTimeout(r, 120)); // let a timer fire if it were started
  sp.update('more');
  assert.equal(s.writes.length, 0, 'non-TTY must not write while running');
  sp.stop(); // no final line — should stay silent
  assert.equal(s.writes.length, 0);
});

test('createSpinner: non-TTY + stop(finalLine) → writes the line once, appends newline', () => {
  const s = mockStream(false);
  const sp = createSpinner({ stream: s });
  sp.stop('  [brainstorm] done (20)');
  assert.equal(s.writes.length, 2);
  assert.equal(s.writes[0], '  [brainstorm] done (20)');
  assert.equal(s.writes[1], '\n');
});

test('createSpinner: non-TTY + stop(finalLine with trailing \\n) → no double newline', () => {
  const s = mockStream(false);
  const sp = createSpinner({ stream: s });
  sp.stop('  [done]\n');
  assert.equal(s.writes.join(''), '  [done]\n');
});

// ─── TTY rendering ───

test('createSpinner: TTY renders initial frame immediately on start()', () => {
  const s = mockStream(true);
  const sp = createSpinner({ stream: s, useColor: false });
  sp.start('[brainstorm] running...');
  assert.ok(s.writes.length >= 1, 'first render must happen synchronously');
  const first = s.writes[0];
  assert.ok(first.includes('\r\x1b[2K'), 'must begin with clear-line escape');
  assert.ok(first.includes('[brainstorm] running...'), 'label must appear');
  sp.stop(); // cleanup timer
});

test('createSpinner: TTY useColor=false uses ASCII dots (no Unicode)', () => {
  const s = mockStream(true);
  const sp = createSpinner({ stream: s, useColor: false });
  sp.start('x');
  const first = s.writes[0];
  // Must not contain any braille frame or ANSI dim code
  const hasUnicode = /[\u2800-\u28FF]/.test(first);
  const hasAnsiDim = first.includes('\x1b[2m');
  assert.equal(hasUnicode, false, 'ASCII mode must not emit braille chars');
  assert.equal(hasAnsiDim, false, 'ASCII mode must not emit dim ANSI code');
  sp.stop();
});

test('createSpinner: TTY useColor=true + useUnicode=true \u2192 Unicode frame + dim color', () => {
  const s = mockStream(true);
  // useUnicode is now an explicit opt \u2014 on legacy Windows ConHost the spinner
  // auto-falls-back to ASCII even with useColor=true, so the test pins both.
  const sp = createSpinner({ stream: s, useColor: true, useUnicode: true });
  sp.start('x');
  const first = s.writes[0];
  const hasUnicode = /[\u2800-\u28FF]/.test(first);
  assert.equal(hasUnicode, true, 'unicode mode must use braille frames');
  assert.ok(first.includes('\x1b[2m'), 'must include dim ANSI code');
  assert.ok(first.includes('\x1b[0m'), 'must include reset ANSI code');
  sp.stop();
});

test('createSpinner: useColor=true but useUnicode=false \u2192 ASCII dots, still coloured', () => {
  const s = mockStream(true);
  const sp = createSpinner({ stream: s, useColor: true, useUnicode: false });
  sp.start('x');
  const first = s.writes[0];
  const hasUnicode = /[\u2800-\u28FF]/.test(first);
  assert.equal(hasUnicode, false, 'useUnicode=false must not emit braille');
  assert.ok(first.includes('\x1b[2m'), 'useColor=true must still wrap in dim ANSI');
  sp.stop();
});

test('createSpinner: TTY stop(finalLine) clears line then writes final + newline', () => {
  const s = mockStream(true);
  const sp = createSpinner({ stream: s, useColor: false });
  sp.start('label');
  s.writes.length = 0; // clear preamble
  sp.stop('  [brainstorm] done (20)');
  const combined = s.writes.join('');
  assert.ok(combined.startsWith('\r\x1b[2K'), 'stop must clear the spinner line first');
  assert.ok(combined.includes('[brainstorm] done (20)'));
  assert.ok(combined.endsWith('\n'));
});

test('createSpinner: start() while previous phase still active transitions cleanly', () => {
  const s = mockStream(true);
  const sp = createSpinner({ stream: s, useColor: false });
  sp.start('phase A');
  s.writes.length = 0;
  sp.start('phase B'); // should drop A silently, open B
  const combined = s.writes.join('');
  assert.ok(combined.includes('phase B'), 'second phase label must render');
  sp.stop();
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
