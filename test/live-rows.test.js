import assert from 'node:assert/strict';
import { createLiveRows } from '../lib/util/live-rows.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

// Minimal Writable-stream stub that captures every write into an array.
function makeSpyStream({ isTTY }) {
  const chunks = [];
  return {
    isTTY,
    write(s) { chunks.push(String(s)); return true; },
    chunks,
    text() { return chunks.join(''); },
  };
}

console.log('\nlive-rows non-TTY (CI / pipe) behaviour');

test('add() prints a structured start line', () => {
  const stream = makeSpyStream({ isTTY: false });
  const live = createLiveRows({ stream, useColor: false, useUnicode: false, animate: stream.isTTY });
  live.add('t1', 'Q1/gpt');
  // Should contain the label + status text, no ANSI escapes.
  const out = stream.text();
  assert.ok(out.includes('Q1/gpt'), `expected label in output: ${JSON.stringify(out)}`);
  assert.ok(out.includes('queued'), `expected status detail: ${JSON.stringify(out)}`);
  assert.doesNotMatch(out, /\x1b\[/, 'non-TTY output should have no ANSI codes');
});

test('update() in non-TTY is silent (no extra writes)', () => {
  const stream = makeSpyStream({ isTTY: false });
  const live = createLiveRows({ stream, useColor: false, useUnicode: false, animate: stream.isTTY });
  live.add('t1', 'Q1');
  const writesBefore = stream.chunks.length;
  live.update('t1', { status: 'cooldown', detail: '58s waiting' });
  assert.equal(stream.chunks.length, writesBefore, 'update() should not write in non-TTY');
});

test('finish() prints one structured end line', () => {
  const stream = makeSpyStream({ isTTY: false });
  const live = createLiveRows({ stream, useColor: false, useUnicode: false, animate: stream.isTTY });
  live.add('t1', 'Q1');
  live.finish('t1', { status: 'done', detail: 'YES (12 citations)' });
  const out = stream.text();
  assert.ok(out.includes('YES (12 citations)'), `expected final detail: ${JSON.stringify(out)}`);
  // Two lines total: one from add, one from finish.
  const newlines = (out.match(/\n/g) || []).length;
  assert.equal(newlines, 2, `expected 2 lines, got ${newlines}`);
});

test('log() prints immediately in non-TTY (no buffering)', () => {
  const stream = makeSpyStream({ isTTY: false });
  const live = createLiveRows({ stream, useColor: false, useUnicode: false, animate: stream.isTTY });
  live.log('  [tokens] openai:gpt-5: input=100 output=200 total=300');
  const out = stream.text();
  assert.ok(out.includes('[tokens]'), 'log should print inline in non-TTY');
});

test('start() / stop() are no-ops in non-TTY', () => {
  const stream = makeSpyStream({ isTTY: false });
  const live = createLiveRows({ stream, useColor: false, useUnicode: false, animate: stream.isTTY });
  live.start();
  live.stop();
  // No animation loop should have started; nothing extra written.
  assert.equal(stream.text(), '', 'non-TTY start/stop should not write anything');
});

console.log('\nlive-rows TTY (animated) behaviour');

test('add() reserves a terminal row immediately with a newline', () => {
  const stream = makeSpyStream({ isTTY: true });
  const live = createLiveRows({ stream, useColor: false, useUnicode: false, animate: stream.isTTY });
  live.add('t1', 'Q1');
  const out = stream.text();
  assert.ok(out.endsWith('\n'), 'add() must end with \\n to reserve a row');
  assert.ok(out.includes('Q1'), 'output should contain the label');
});

test('start() hides the cursor and stop() restores it', () => {
  const stream = makeSpyStream({ isTTY: true });
  const live = createLiveRows({ stream, useColor: false, useUnicode: false, animate: stream.isTTY });
  live.add('t1', 'Q1');
  live.start();
  assert.ok(stream.text().includes('\x1b[?25l'), 'start should hide cursor');
  live.stop();
  assert.ok(stream.text().includes('\x1b[?25h'), 'stop should restore cursor');
});

test('stop() flushes buffered logs after the row block', () => {
  const stream = makeSpyStream({ isTTY: true });
  const live = createLiveRows({ stream, useColor: false, useUnicode: false, animate: stream.isTTY });
  live.add('t1', 'Q1');
  live.start();
  live.log('  [tokens] foo');
  live.log('  [tokens] bar');
  // Before stop, logs are buffered:
  assert.doesNotMatch(stream.text(), /\[tokens\] foo/);
  live.stop();
  // After stop, both flushed:
  assert.match(stream.text(), /\[tokens\] foo/);
  assert.match(stream.text(), /\[tokens\] bar/);
});

test('add() is idempotent — same id twice does not duplicate', () => {
  const stream = makeSpyStream({ isTTY: true });
  const live = createLiveRows({ stream, useColor: false, useUnicode: false, animate: stream.isTTY });
  live.add('t1', 'Q1');
  const lenAfterFirst = stream.chunks.length;
  live.add('t1', 'Q1 duplicate');
  assert.equal(stream.chunks.length, lenAfterFirst, 'duplicate add should not write again');
});

test('finish() on unknown id is a no-op', () => {
  const stream = makeSpyStream({ isTTY: true });
  const live = createLiveRows({ stream, useColor: false, useUnicode: false, animate: stream.isTTY });
  // Should not throw.
  live.finish('never-added', { status: 'done', detail: 'whatever' });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
