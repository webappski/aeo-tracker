/**
 * Phase 5 — intent-diverse selection (Guard 3).
 *
 * Algorithm:
 *   - Group candidates by intent (commercial, vertical, problem)
 *   - Pick top-scored candidate per bucket (NOT top-3 overall)
 *   - Fallback chain if bucket empty:
 *       commercial  → (vertical, problem, comparison)
 *       vertical    → (commercial, problem, comparison)
 *       problem     → (commercial, vertical, comparison)
 *   - Selected triplet MUST all be validated (Guard 4 — reject unvalidated for top-3)
 *   - Alternatives: top-5 from remaining pool, carrying `unverified` flag when not validated
 *
 * Comparison queries are excluded from required buckets — they score low when no named
 * competitors are known, and strategy comparisons (AEO vs SEO) add little AEO signal.
 * Problem-aware queries replaced them: buyers describing a symptom generate AI answers
 * that cite vendors, which is the core AEO visibility moment.
 *
 * Guard 6 — if vertical dominance detected (≥4 of top 5 are vertical), return
 * a `verticalDominance: true` flag so caller can re-score with per-intent features.
 */

const REQUIRED_INTENTS = ['commercial', 'vertical', 'problem'];

const FALLBACK_CHAIN = {
  commercial:  ['vertical', 'problem', 'comparison'],
  vertical:    ['commercial', 'problem', 'comparison'],
  problem:     ['commercial', 'vertical', 'comparison'],
};

/**
 * Group candidates by their final intent tag.
 */
function groupByIntent(candidates) {
  const groups = {};
  for (const c of candidates) {
    const i = c.intent || 'unknown';
    if (!groups[i]) groups[i] = [];
    groups[i].push(c);
  }
  // Sort each bucket by score descending
  for (const i of Object.keys(groups)) {
    groups[i].sort((a, b) => (b.score || 0) - (a.score || 0));
  }
  return groups;
}

/**
 * Detect vertical dominance per Guard 6. If the top-5 candidates by score are
 * mostly vertical, signal to caller that per-intent scoring should be applied.
 */
function detectVerticalDominance(candidates) {
  const top5 = [...candidates].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5);
  const verticalCount = top5.filter(c => c.intent === 'vertical').length;
  return { top5Count: top5.length, verticalCount, dominant: verticalCount >= 4 };
}

/**
 * Pick the top validated candidate from a bucket. Falls back through the chain
 * if the primary bucket is empty. Returns null if nothing available anywhere.
 * Tracks `fallbackUsed` so UX can warn the user.
 */
function pickForIntent(intent, groups, validatedOnly = true, usedTexts = new Set()) {
  const candidatesFor = (bucket) => (groups[bucket] || []).filter(c =>
    (!validatedOnly || c.validation === 'ok') && !usedTexts.has(c.text)
  );

  // Primary bucket
  const primary = candidatesFor(intent);
  if (primary.length > 0) return { candidate: primary[0], intent, fallbackUsed: null };

  // Fallback chain
  for (const fallback of (FALLBACK_CHAIN[intent] || [])) {
    const fb = candidatesFor(fallback);
    if (fb.length > 0) return { candidate: fb[0], intent, fallbackUsed: fallback };
  }
  return null;
}

/**
 * Select top-3 (one per required intent) plus alternatives pool.
 *
 * @param {Array} candidates   scored + validated candidate list
 * @returns {{
 *   selected: Array<{ intent, candidate, fallbackUsed }>,
 *   alternatives: Array<{ ...candidate, unverified: boolean }>,
 *   warnings: string[],
 *   verticalDominance: { dominant, verticalCount, top5Count }
 * }}
 */
export function selectTopThree(candidates, { validationSkipped = false } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
      selected: [],
      alternatives: [],
      warnings: ['No candidates available after filter/validation'],
      infos: [],
      verticalDominance: { top5Count: 0, verticalCount: 0, dominant: false },
    };
  }

  const groups = groupByIntent(candidates);
  const verticalDominance = detectVerticalDominance(candidates);

  const warnings = [];
  const infos = [];

  if (verticalDominance.dominant) {
    warnings.push(`Guard 6 trigger: ${verticalDominance.verticalCount} of top ${verticalDominance.top5Count} are vertical — consider per-intent re-scoring`);
  }

  // When validation was skipped (single-provider mode), NO candidates carry validation='ok',
  // so we can't enforce Guard 4. Surface this once up front instead of N per-bucket warnings.
  if (validationSkipped) {
    infos.push('Single-provider mode — candidates not cross-validated. See alternatives labelled (unverified).');
  }

  const selected = [];
  const usedTexts = new Set();
  const validatedOnly = !validationSkipped; // skip the validated-only pass entirely when there's no validator

  for (const intent of REQUIRED_INTENTS) {
    let pick = pickForIntent(intent, groups, validatedOnly, usedTexts);
    if (!pick && validatedOnly) {
      pick = pickForIntent(intent, groups, /*validatedOnly*/ false, usedTexts);
      if (pick) {
        warnings.push(`${intent}: no validated candidate available, falling back to unvalidated "${pick.candidate.text}"`);
      }
    }
    if (!pick) {
      warnings.push(`${intent}: no candidate available anywhere; bucket and all fallbacks empty`);
      continue;
    }
    if (pick.fallbackUsed) {
      warnings.push(`${intent}: no candidate in primary bucket, used fallback from "${pick.fallbackUsed}"`);
    }
    selected.push(pick);
    usedTexts.add(pick.candidate.text);
  }

  // Alternatives: top 5 remaining by score, mixed across buckets
  const remainder = candidates.filter(c => !usedTexts.has(c.text));
  remainder.sort((a, b) => (b.score || 0) - (a.score || 0));
  const alternatives = remainder.slice(0, 5).map(c => ({
    ...c,
    unverified: c.validation !== 'ok',
  }));

  return { selected, alternatives, warnings, infos, verticalDominance };
}

/**
 * Format selection result for human display. Returns an array of printable
 * lines. Intent labels lowercased, fallbacks marked clearly.
 */
export function formatSelection(result) {
  const lines = [];
  lines.push('Selected queries (1 per intent bucket):');
  for (const pick of result.selected) {
    const { candidate, intent, fallbackUsed } = pick;
    const score = candidate.score ?? '?';
    const confidence = candidate.confidence || 'unknown';
    const fallbackNote = fallbackUsed ? ` [fallback from ${fallbackUsed}]` : '';
    lines.push(`  ${intent.padEnd(14)} score=${score} ${confidence}${fallbackNote}`);
    lines.push(`    → ${candidate.text}`);
  }
  if (result.alternatives.length > 0) {
    lines.push('');
    lines.push('Alternatives (for swap):');
    for (const alt of result.alternatives) {
      // 1.0.4 Fix A.1d: (validated) tag now requires BOTH stages — category
      // validation (!alt.unverified) AND commercial-only / industry-fit
      // (search_behavior absent OR equal to 'retrieval-triggered'). Without
      // this, a candidate could be `validation === 'ok'` but parametric-only,
      // and the user would copy it as a --keywords suggestion only to have
      // the commercial-only check re-block it on the next run.
      const passedBothStages = !alt.unverified
        && (!alt.search_behavior || alt.search_behavior === 'retrieval-triggered');
      const label = passedBothStages ? '(validated)' : '(unverified)';
      lines.push(`  [${alt.score}] ${alt.intent.padEnd(14)} ${label} ${alt.text}`);
    }
  }
  if (result.infos && result.infos.length > 0) {
    lines.push('');
    for (const i of result.infos) lines.push(`  ℹ ${i}`);
  }
  if (result.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of result.warnings) lines.push(`  ⚠ ${w}`);
  }
  return lines;
}

export { REQUIRED_INTENTS, FALLBACK_CHAIN };
