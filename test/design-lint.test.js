// Design-lint smoke test — guards against three classes of regressions that
// have bitten this codebase during the 2026 editorial redesign:
//
//   1. Legacy palette — a set of hex values inherited from v0.3-era
//      copy-paste (the same hex you'd find in a Tailwind palette, but
//      Tailwind itself is NOT a dependency — `package.json#dependencies`
//      is empty). The 2026 editorial system replaced them with --paper /
//      --ink / --warn / --bad-soft / --good-soft tokens.
//
//   2. Inline `style="font-size:..."` in cell markup. Type ramp lives in
//      CSS tokens + data-size variants; markup shouldn't carry font-size.
//
//   3. Backticks inside the renderCss() CSS-comment block. renderCss is
//      one giant `…` template literal — any backtick in a CSS comment
//      closes the outer template and breaks parsing. (Bit us twice.)
//
// If any of these patterns reappears, this test fails. Add it to CI.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let passed = 0;
let failed = 0;
let warned = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    if (err.softOnly) {
      warned++;
      console.log(`  ⚠ ${name}\n    ${err.message}`);
    } else {
      failed++;
      console.log(`  ✗ ${name}\n    ${err.message}`);
    }
  }
}
function softFail(msg) {
  const e = new Error(msg);
  e.softOnly = true;
  return e;
}

// HARD-fail set: every Tailwind hex / inline font-size / backtick in this
// file must be zero. These files were rebuilt in the 2026 editorial pass.
const HARD_FILES = [
  'lib/report/html.js',
  'lib/report/mc-bridge.js',
];

// SOFT-warn set: sections.js carries v0.3-era markdown-generation functions
// with embedded inline styles. Many output markdown that's later wrapped
// into HTML cells. Full cleanup is a separate refactor; for now we log
// regressions but don't fail CI. New code should still use report tokens.
const SOFT_FILES = [
  'lib/report/sections.js',
];

const ALL_FILES = [...HARD_FILES, ...SOFT_FILES];
const sources = {};
const commentRanges = {};
for (const rel of ALL_FILES) {
  const body = await readFile(resolve(ROOT, rel), 'utf-8');
  sources[rel] = body;
  // Pre-compute /* ... */ comment ranges so hex inside doc-comments
  // (e.g. "Replaces v0.5 #fef9c3 with --warn-soft") doesn't count as
  // a regression. We strip line comments too (//) for safety.
  commentRanges[rel] = computeCommentRanges(body);
}
const isHard = (path) => HARD_FILES.includes(path);

function computeCommentRanges(body) {
  const ranges = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === '/' && body[i + 1] === '*') {
      const end = body.indexOf('*/', i + 2);
      const stop = end === -1 ? body.length : end + 2;
      ranges.push([i, stop]);
      i = stop;
    } else if (body[i] === '/' && body[i + 1] === '/') {
      const nl = body.indexOf('\n', i + 2);
      const stop = nl === -1 ? body.length : nl;
      ranges.push([i, stop]);
      i = stop;
    } else {
      i++;
    }
  }
  return ranges;
}

function inComment(ranges, idx) {
  // Ranges are sorted by start; linear scan is fine for our sizes.
  for (const [a, b] of ranges) {
    if (idx >= a && idx < b) return true;
    if (a > idx) return false;
  }
  return false;
}

// ─── 1. Legacy palette ──────────────────────────────────────────────────
// The exact hex strings that used to live in inline-styled blocks before
// the 2026 redesign. Listed individually so the failure message points at
// the specific hex that crept back in. (Names in the comments match the
// well-known Tailwind palette, but Tailwind itself is not a runtime
// dependency — these are just industry-default hex values that the old
// code copy-pasted, now superseded by report tokens.)
const LEGACY_PALETTE = [
  '#fef9c3', // yellow-100
  '#dcfce7', // green-100
  '#fee2e2', // red-100
  '#fef3c7', // amber-100
  '#e2e8f0', // slate-200
  '#0f172a', // slate-900
  '#1e293b', // slate-800
  '#475569', // slate-600
  '#64748b', // slate-500
  '#854d0e', // yellow-800
  '#b91c1c', // red-700
  '#15803d', // green-700
  '#f8fafc', // slate-50
];

console.log('design-lint — guards against redesign regressions');

for (const hex of LEGACY_PALETTE) {
  test(`no legacy hex ${hex} in source`, () => {
    const hardOffenders = [];
    const softOffenders = [];
    for (const [path, body] of Object.entries(sources)) {
      const lower = body.toLowerCase();
      let idx = lower.indexOf(hex.toLowerCase());
      while (idx !== -1) {
        // Skip hex inside /* ... */ or // comments — doc-comments that
        // mention old Tailwind values for migration context are legitimate.
        if (!inComment(commentRanges[path], idx)) {
          const line = body.slice(0, idx).split('\n').length;
          (isHard(path) ? hardOffenders : softOffenders).push(`${path}:${line}`);
        }
        idx = lower.indexOf(hex.toLowerCase(), idx + 1);
      }
    }
    if (hardOffenders.length > 0) {
      throw new Error(
        `${hex} found in HARD-set: ${hardOffenders.join(', ')}. ` +
        `Use report tokens (--bad-soft / --good-soft / --warn-soft / --paper-2 / --ink-2 etc.).`,
      );
    }
    if (softOffenders.length > 0) {
      // Truncate the file:line list to keep output readable while keeping
      // the count visible for progress tracking.
      const head = softOffenders.slice(0, 5).join(', ');
      const more = softOffenders.length > 5 ? `, +${softOffenders.length - 5} more` : '';
      throw softFail(
        `${hex} — ${softOffenders.length} occurrence${softOffenders.length === 1 ? '' : 's'} in legacy section helpers: ${head}${more}. See TECH_DEBT.md.`,
      );
    }
  });
}

// ─── 2. Inline font-size in markup ──────────────────────────────────────
// Type ramp lives in CSS classes and data-size variants. Markup should
// never declare font-size directly.
test('no inline style="font-size: ..." in markup', () => {
  const hardOffenders = [];
  const softOffenders = [];
  for (const [path, body] of Object.entries(sources)) {
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/style="[^"]*font-size:/.test(line)) {
        // hero-kpi-num exception: 22px override for long topComp brand names.
        if (line.includes('hero-kpi-num') && line.includes('22px')) continue;
        (isHard(path) ? hardOffenders : softOffenders).push(`${path}:${i + 1}`);
      }
    }
  }
  if (hardOffenders.length > 0) {
    throw new Error(
      `Inline font-size in HARD-set: ${hardOffenders.join(', ')}. ` +
      `Use a data-size attr (.big-num[data-size="36"]) or a class with var(--t-display-N).`,
    );
  }
  if (softOffenders.length > 0) {
    throw softFail(
      `Inline font-size in legacy section helpers (${softOffenders.length} occurrence${softOffenders.length === 1 ? '' : 's'}). Tech debt.`,
    );
  }
});

// ─── 3. No CSS body inside renderCss template literal ──────────────────
// As of 2026-05 the CSS lives in lib/report/styles.css (read via
// readFileSync). renderCss() should be a one-line `return STYLES_CSS;`
// helper — anyone re-introducing a backtick-template CSS body would be
// re-opening the bug class the extract was meant to close.
test('renderCss returns STYLES_CSS constant, not an inline template', () => {
  const html = sources['lib/report/html.js'];
  const m = /function renderCss\(\)\s*\{([\s\S]*?)\n\}/.exec(html);
  if (!m) throw new Error('renderCss function not found in lib/report/html.js');
  const body = m[1];
  if (/return\s*`/.test(body)) {
    throw new Error(
      'renderCss body contains a template literal — CSS belongs in lib/report/styles.css, not inline. ' +
      'This protects against the backtick-in-CSS-comment bug class.',
    );
  }
});

// Legacy backtick scanner kept for any future renderCss-like function that
// embeds CSS in a template. Currently unused since the extract — keep as a
// regression guard.
test('no orphan backtick groups in renderCss range (legacy)', () => {
  const html = sources['lib/report/html.js'];
  const lines = html.split('\n');

  let inRenderCss = false;
  let backtickCount = 0;
  const offenders = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inRenderCss && /^function renderCss\(\)/.test(line)) {
      inRenderCss = true;
      continue;
    }
    if (!inRenderCss) continue;

    for (let j = 0; j < line.length; j++) {
      if (line[j] === '`') {
        backtickCount++;
        if (backtickCount > 2) {
          offenders.push(`lib/report/html.js:${i + 1}:${j + 1}`);
        }
      }
    }

    if (backtickCount >= 2 && /^\}/.test(line)) break;
  }

  if (offenders.length > 0) {
    throw new Error(
      `Stray backticks in renderCss CSS body at: ${offenders.join(', ')}. ` +
      `Backticks close the outer template and cause "Invalid left-hand side expression in postfix operation". ` +
      `Use plain text or single-quotes for emphasis in CSS comments.`,
    );
  }
});

console.log(`\n${passed} passed, ${failed} failed, ${warned} soft-warn`);
if (failed > 0) process.exit(1);
