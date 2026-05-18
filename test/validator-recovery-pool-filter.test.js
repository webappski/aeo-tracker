/**
 * Fix A regression (1.0.4): the `(validated)` rendering in `formatRecoveryPanel`
 * must only surface pool entries that pass the commercial-only criterion
 * (search_behavior == RETRIEVAL, or absent for static-only entries).
 *
 * Without this filter, the panel suggests queries via --keywords that the
 * validator re-rejects on the next run — the trust failure that prompted 1.0.4.
 *
 * Pool entries are expected to be enriched with search_behavior from
 * v.updatedCache at the panel call site (bin/aeo-tracker.js::printPanel).
 * These tests simulate that enrichment by passing search_behavior directly
 * on each candidatePool entry.
 */

import test from 'node:test';
import assert from 'node:assert';
import { formatRecoveryPanel } from '../lib/init/validator-recovery.js';

test('pool entries with search_behavior=retrieval-triggered appear in suggested', () => {
  const lines = formatRecoveryPanel({
    allBlockers: [{ query: 'bad', search_behavior: 'parametric-only' }],
    candidatePool: [
      { text: 'q-a', search_behavior: 'retrieval-triggered' },
      { text: 'q-b', search_behavior: 'retrieval-triggered' },
      { text: 'q-c', search_behavior: 'retrieval-triggered' },
    ],
    currentQueries: ['bad'],
    brand: 'acme', domain: 'https://acme.com',
    category: 'form builders',
    useColor: false,
  });
  const text = lines.join('\n');
  assert.match(text, /"q-a,q-b,q-c"/);
  assert.match(text, /from validated pool — both validator stages passed/);
});

test('pool entries with search_behavior=parametric-only or mixed are filtered OUT', () => {
  const lines = formatRecoveryPanel({
    allBlockers: [{ query: 'bad', search_behavior: 'parametric-only' }],
    candidatePool: [
      { text: 'q-good', search_behavior: 'retrieval-triggered' },
      { text: 'q-param', search_behavior: 'parametric-only' },
      { text: 'q-mixed', search_behavior: 'mixed' },
    ],
    currentQueries: ['bad'],
    brand: 'acme', domain: 'https://acme.com',
    category: 'form builders',
    useColor: false,
  });
  const text = lines.join('\n');
  // Only the retrieval-triggered entry survives the filter.
  assert.match(text, /q-good/);
  assert.doesNotMatch(text, /q-param/);
  assert.doesNotMatch(text, /q-mixed/);
});

// Intentional pass-through for the absence-of-data case (info-loss documented
// in plan: stale caches written by pre-1.0.4 may lack search_behavior). This
// test is the "documented exception" pattern from architect REV 2.
test('pool entries without search_behavior pass through (intentional info-loss exception)', () => {
  const lines = formatRecoveryPanel({
    allBlockers: [{ query: 'bad', search_behavior: 'parametric-only' }],
    candidatePool: [
      { text: 'q-legacy-a' },  // no search_behavior — older cache or skipped
      { text: 'q-legacy-b' },
      { text: 'q-legacy-c' },
    ],
    currentQueries: ['bad'],
    brand: 'acme', domain: 'https://acme.com',
    useColor: false,
  });
  const text = lines.join('\n');
  // All three legacy entries pass through (no LLM verdict ⇒ default acceptable).
  assert.match(text, /q-legacy-a/);
  assert.match(text, /q-legacy-b/);
  assert.match(text, /q-legacy-c/);
});

// ─── 8-cell matrix invariant (1.0.4 post-publish, cli-walkthrough catch) ───
// Recovery panel option 1 must contain EXACTLY 3 `--keywords` items OR
// be suppressed entirely. The CLI's own --keywords precondition rejects
// any other count. This invariant covers cells D (pool=1+unclean) and F
// (pool=2+unclean) that the original 1.0.4 implementation missed.

function countKeywordsInPanel(lines) {
  const text = lines.join('\n');
  const m = text.match(/--keywords="([^"]+)"/);
  if (!m) return null;  // option 1 not emitted
  return m[1].split(',').length;
}

function makeCell({ poolRetrievals, poolBlocked, category }) {
  const pool = [
    ...Array.from({ length: poolRetrievals }, (_, i) => ({
      text: `q-good-${i + 1}`, search_behavior: 'retrieval-triggered',
    })),
    ...Array.from({ length: poolBlocked }, (_, i) => ({
      text: `q-bad-${i + 1}`, search_behavior: 'parametric-only',
    })),
  ];
  return formatRecoveryPanel({
    allBlockers: [{ query: 'bad', search_behavior: 'parametric-only' }],
    candidatePool: pool,
    currentQueries: ['bad'],
    brand: 'acme', domain: 'https://acme.com',
    category,
    useColor: false,
  });
}

test('matrix cell A (pool=0, clean category): option 1 has exactly 3 keywords (all fillers)', () => {
  const count = countKeywordsInPanel(makeCell({ poolRetrievals: 0, poolBlocked: 0, category: 'form filling' }));
  assert.equal(count, 3);
});

test('matrix cell B (pool=0, unclean): option 1 suppressed entirely', () => {
  const count = countKeywordsInPanel(makeCell({ poolRetrievals: 0, poolBlocked: 0, category: '' }));
  assert.equal(count, null, 'option 1 must be suppressed when finalQueries.length !== 3');
});

test('matrix cell C (pool=1, clean): option 1 has exactly 3 keywords (1 alt + 2 fillers)', () => {
  const count = countKeywordsInPanel(makeCell({ poolRetrievals: 1, poolBlocked: 0, category: 'form filling' }));
  assert.equal(count, 3);
});

test('matrix cell D (pool=1, unclean): option 1 SUPPRESSED (was the regression)', () => {
  // Without top-up at the cmdInit level, formatRecoveryPanel sees pool=1
  // and no clean category. Pre-1.0.4-safety-net it would have emitted
  // --keywords="q-good-1" (1 keyword) and the CLI would have rejected it.
  // Safety net (showOption1 = finalQueries.length === 3) suppresses cleanly.
  const count = countKeywordsInPanel(makeCell({ poolRetrievals: 1, poolBlocked: 0, category: '' }));
  assert.equal(count, null);
});

test('matrix cell E (pool=2, clean): option 1 has exactly 3 keywords (2 alts + 1 filler)', () => {
  const count = countKeywordsInPanel(makeCell({ poolRetrievals: 2, poolBlocked: 0, category: 'form filling' }));
  assert.equal(count, 3);
});

test('matrix cell F (pool=2, unclean): option 1 SUPPRESSED (was the user-observed bug)', () => {
  // Same regression class as D, the cell the maintainer observed on
  // typelessform.com. Safety net suppresses.
  const count = countKeywordsInPanel(makeCell({ poolRetrievals: 2, poolBlocked: 0, category: '' }));
  assert.equal(count, null);
});

test('matrix cell G (pool=3, clean): option 1 has exactly 3 keywords (3 alts)', () => {
  const count = countKeywordsInPanel(makeCell({ poolRetrievals: 3, poolBlocked: 0, category: 'form filling' }));
  assert.equal(count, 3);
});

test('matrix cell H (pool=3, unclean): option 1 has exactly 3 keywords (3 alts, fillers ignored)', () => {
  const count = countKeywordsInPanel(makeCell({ poolRetrievals: 3, poolBlocked: 0, category: '' }));
  assert.equal(count, 3);
});

test('mixed pool: only RETRIEVAL entries fill the first 3 slots, fillers cover the rest', () => {
  const lines = formatRecoveryPanel({
    allBlockers: [{ query: 'bad', search_behavior: 'parametric-only' }],
    candidatePool: [
      { text: 'q-good-1', search_behavior: 'retrieval-triggered' },
      { text: 'q-good-2', search_behavior: 'retrieval-triggered' },
      { text: 'q-bad-1',  search_behavior: 'parametric-only' },
      { text: 'q-bad-2',  search_behavior: 'mixed' },
      { text: 'q-bad-3',  search_behavior: 'parametric-only' },
    ],
    currentQueries: ['bad'],
    brand: 'acme', domain: 'https://acme.com',
    category: 'voice form filling',
    useColor: false,
  });
  const text = lines.join('\n');
  // First 2 slots = the 2 RETRIEVAL entries; 3rd slot = the third category
  // filler (`categoryFillers.slice(suggested.length)` = `slice(2)` = the
  // platforms filler — preserving filler-array order means we take from
  // the unused tail, not from the start).
  assert.match(text, /q-good-1/);
  assert.match(text, /q-good-2/);
  assert.match(text, /voice form filling platforms/);
  // Parametric/mixed entries do not appear anywhere.
  assert.doesNotMatch(text, /q-bad-1/);
  assert.doesNotMatch(text, /q-bad-2/);
  assert.doesNotMatch(text, /q-bad-3/);
  // Partial-pool poolNote variant (architect REV 2 scenario audit).
  assert.match(text, /2 from validated pool, rest are category templates/);
});
