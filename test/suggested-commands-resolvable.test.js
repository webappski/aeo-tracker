/**
 * Static-grep invariant: every "aeo-platform init --yes" string literal in
 * lib/errors/ and lib/init/ must include at least one of --auto, --manual,
 * --keywords. Otherwise the CLI's own precondition (bin/aeo-tracker.js:886)
 * would reject the suggestion — the exact class of bug that produced the
 * 1.0.2 trust failure.
 *
 * Glob-based on purpose: future panels added to lib/errors/ or lib/init/
 * are auto-covered without remembering to update this test.
 *
 * Scope (1.0.4 architect nit): this test scans only lines containing the
 * literal `aeo-platform init --yes`. Commands that intentionally OMIT --yes
 * (e.g. validator-recovery option 3, the interactive --manual escape hatch
 * added in 1.0.4 Fix C) are outside this test's scope by design. The
 * --yes-less form is an always-works fallback and doesn't need a mode-flag
 * guard. If you add a new panel that emits an --yes suggestion, this test
 * will catch a missing mode flag automatically.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

const targets = [
  ...walk(join(repoRoot, 'lib/errors')),
  ...walk(join(repoRoot, 'lib/init')),
];

const MODE_RE = /--auto|--manual|--keywords/;

const violations = [];
for (const file of targets) {
  const src = readFileSync(file, 'utf-8');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('aeo-platform init --yes')) {
      // Suggestion text may be split across template literals; scan this line
      // plus the next 4 to catch multi-line `\` continuations.
      const window = lines.slice(i, i + 5).join(' ');
      if (!MODE_RE.test(window)) {
        violations.push(`${relative(repoRoot, file)}:${i + 1} — missing mode flag in suggestion`);
      }
      // 1.0.4 post-publish: also catch the cells-D-and-F regression class.
      // Any emitted --keywords="..." must contain exactly 3 comma-separated
      // items, matching the CLI's own precondition gate at
      // bin/aeo-tracker.js cmdInit. Static-grep approximates "3 items" by
      // counting commas inside the literal; runtime template interpolation
      // (`${finalQueries.join(',')}`) is opaque to this scan, so we only
      // flag string literals with a wrong static count.
      const m = lines[i].match(/--keywords="([^$"][^"]*)"/);
      if (m) {
        const itemCount = m[1].split(',').filter(s => s.trim().length > 0).length;
        if (itemCount !== 3) {
          violations.push(`${relative(repoRoot, file)}:${i + 1} — --keywords literal has ${itemCount} items (must be exactly 3)`);
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`Found ${violations.length} unreachable suggestion(s):\n${violations.join('\n')}`);
  process.exit(1);
}

console.log(`OK: scanned ${targets.length} files, all "aeo-platform init --yes" suggestions include a mode flag`);
