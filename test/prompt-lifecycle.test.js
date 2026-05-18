// Tests for lib/util/prompt.js — the single owner of stdin/readline lifecycle.
//
// These tests defend the class of bugs that produced "readline was closed"
// during `aeo-platform init --auto --strict-validation`: stdin getting closed
// before a deferred async prompt, multiple readline instances on one stdin,
// and silent failures when stdin is closed externally.

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPrompter } from '../lib/util/prompt.js';

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

function mockTTY(isTTY = true) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = isTTY;
  output.isTTY = isTTY;
  return { input, output };
}

// ─── Test A — Lazy creation. nonInteractive must never touch stdin. ───

await test('A: nonInteractive=true returns defaults without touching stdin', async () => {
  const { input, output } = mockTTY(true);
  // Spy: count reads from input. PassThrough.read() is the underlying call.
  let readCount = 0;
  const origRead = input.read.bind(input);
  input.read = (...args) => { readCount++; return origRead(...args); };

  const prompter = createPrompter({ nonInteractive: true, input, output });
  const a = await prompter.ask('Q1: ', 'default-A');
  const b = await prompter.ask('Q2: ', 'default-B');
  assert.equal(a, 'default-A');
  assert.equal(b, 'default-B');
  assert.equal(readCount, 0, 'readline should not have been created');
  prompter.close();
});

// ─── Test B — Regression for the original bug. ───
// Create prompter, ask, wait 100ms (simulating an LLM call), ask again.
// Must not throw "readline was closed".

await test('B: long async between asks does not break the prompter', async () => {
  const { input, output } = mockTTY(true);
  const prompter = createPrompter({ nonInteractive: false, input, output });

  const p1 = prompter.ask('Q1: ');
  input.write('first answer\n');
  const a1 = await p1;
  assert.equal(a1, 'first answer');

  await new Promise(r => setTimeout(r, 100));

  const p2 = prompter.ask('Q2: ');
  input.write('second answer\n');
  const a2 = await p2;
  assert.equal(a2, 'second answer');

  prompter.close();
});

// ─── Test C — Use-after-close gives a readable error. ───

await test('C: ask after close() throws a readable error', async () => {
  const { input, output } = mockTTY(true);
  const prompter = createPrompter({ nonInteractive: false, input, output });
  prompter.close();
  await assert.rejects(
    () => prompter.ask('Q: '),
    /Prompter was already closed/,
  );
});

// ─── Test D — close() is idempotent. ───

await test('D: close() is idempotent and isClosed() reflects state', () => {
  const { input, output } = mockTTY(true);
  const prompter = createPrompter({ nonInteractive: false, input, output });
  assert.equal(prompter.isClosed(), false);
  prompter.close();
  prompter.close();
  prompter.close();
  assert.equal(prompter.isClosed(), true);
});

// ─── Test E — Wiring check: cmdRun has a local ask wired to prompter. ───
// Defends against the latent ReferenceError where cmdRun used `ask` without
// defining it (the value was only in cmdInit's scope).

await test('E: cmdRun in bin/aeo-tracker.js wires ask from options.prompter', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(join(here, '..', 'bin', 'aeo-tracker.js'), 'utf-8');

  const start = src.indexOf('async function cmdRun(');
  assert.ok(start > 0, 'cmdRun definition not found');
  // Body up to the next top-level function declaration.
  const after = src.indexOf('\nasync function ', start + 1);
  const body = src.slice(start, after > 0 ? after : src.length);

  // The fix: ask must be defined inside cmdRun before any use, sourced from
  // options.prompter. The previous (broken) code referenced bare `ask`.
  assert.ok(
    /const ask = options\.prompter\.ask/.test(body),
    'cmdRun must define `const ask = options.prompter.ask` (regression: was undefined)',
  );
  // And the depth=auto stale-baseline prompt must use it.
  assert.ok(/await ask\(/.test(body), 'cmdRun must call await ask(...)');
});

// ─── Test F — External close (Ctrl+D / pipe end) is detected. ───

await test('F: external stdin close → next ask throws a readable error', async () => {
  const { input, output } = mockTTY(true);
  const prompter = createPrompter({ nonInteractive: false, input, output });

  // Force readline creation via a first ask.
  const p1 = prompter.ask('Q1: ');
  input.write('hello\n');
  await p1;

  // Simulate Ctrl+D / broken pipe — close stdin from the outside.
  input.end();
  // Let readline's 'close' event propagate.
  await new Promise(r => setImmediate(r));

  assert.equal(prompter.isClosed(), true, 'prompter should detect external close');
  await assert.rejects(
    () => prompter.ask('Q2: '),
    /Input stream closed/,
  );
});

// ─── Test G — Auto-non-interactive when stdin is not a TTY. ───
// Defends `echo "y" | aeo-platform init` against accidental behaviour changes.

await test('G: stdin not a TTY → auto non-interactive, defaults returned', async () => {
  const { input, output } = mockTTY(false); // not a TTY
  // No explicit nonInteractive — must be inferred from !isTTY.
  const prompter = createPrompter({ input, output });
  const a = await prompter.ask('Q: ', 'fallback');
  assert.equal(a, 'fallback');
  prompter.close();
});

// ─── Summary ───

for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else console.log(`  ✗ ${r.name}\n    ${r.err}`);
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
