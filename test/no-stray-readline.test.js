// Architectural invariant: the only place that creates a readline or reads
// process.stdin directly is lib/util/prompt.js. Every command shares one
// prompter from the dispatcher.
//
// This test exists because the original bug class was caused by multiple
// readline instances competing on the same stdin (one in cmdInit, one in
// runValidationFlow). A unit test alone cannot prevent that from being
// reintroduced in some new code path. This test scans the whole repo and
// fails if anyone reaches for createInterface or process.stdin events
// outside the sanctioned module.
//
// Escape hatch: add `// allow-stray-stdin` on the same line if a future use
// case genuinely needs direct stdin access. The marker makes the deviation
// explicit and reviewable.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_FILE = join('lib', 'util', 'prompt.js');

// Anything that touches stdin lifecycle directly.
const FORBIDDEN_PATTERNS = [
  { name: 'createInterface', re: /\bcreateInterface\s*\(/ },
  { name: 'process.stdin.on(', re: /process\.stdin\.on\s*\(/ },
  { name: 'process.stdin.once(', re: /process\.stdin\.once\s*\(/ },
  { name: 'process.stdin.read(', re: /process\.stdin\.read\s*\(/ },
  { name: 'process.stdin.addListener(', re: /process\.stdin\.addListener\s*\(/ },
  { name: 'process.stdin.resume(', re: /process\.stdin\.resume\s*\(/ },
  { name: 'process.stdin.setRawMode(', re: /process\.stdin\.setRawMode\s*\(/ },
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'test', 'aeo-responses']);
const ALLOW_MARKER = /\/\/\s*allow-stray-stdin\b/;

async function* walkJsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsFiles(full);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      yield full;
    }
  }
}

const violations = [];

for await (const file of walkJsFiles(ROOT)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (rel === ALLOWED_FILE.replace(/\\/g, '/')) continue;

  const src = await readFile(file, 'utf-8');
  const lines = src.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ALLOW_MARKER.test(line)) continue;
    for (const { name, re } of FORBIDDEN_PATTERNS) {
      if (re.test(line)) {
        violations.push({ file: rel, lineNo: i + 1, name, line: line.trim() });
      }
    }
  }
}

if (violations.length > 0) {
  console.log('Stray stdin/readline use detected outside lib/util/prompt.js:\n');
  for (const v of violations) {
    console.log(`  ${v.file}:${v.lineNo}  [${v.name}]`);
    console.log(`    ${v.line}`);
  }
  console.log('\nIf this is intentional, add `// allow-stray-stdin` to the line.');
  console.log('Otherwise, route stdin access through lib/util/prompt.js.');
}

assert.equal(violations.length, 0, `${violations.length} stray stdin/readline use(s) found`);
console.log('  ✓ no stray stdin/readline use outside lib/util/prompt.js');
