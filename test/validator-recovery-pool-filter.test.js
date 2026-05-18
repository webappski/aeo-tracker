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
