// Recovery layer for the commercial-only validator gate in init --auto.
//
// Problem it solves: the research pipeline produces 3 selected queries + up to
// 5 validated alternatives (candidatePool). If the commercial-only validator
// blocks 1-3 of the selected queries, the old code aborted — throwing away the
// 5 already-validated alternatives sitting in memory. User had to re-read,
// copy-paste, rerun. This module turns that abort into either a silent
// substitution (auto-promote, --yes mode) or a numbered prompt (TTY).
//
// Scope (hard):
//   - Recovery is ONLY for informationalIssues (wrong-intent blockers).
//   - staticIssues (acronym) and llmIssues (confidence) → not auto-recoverable
//     because a swap may introduce the same problem. Caller falls back to
//     the existing abort-with-actionable-panel path for those.
//
// Re-validation after substitution is free: alternatives come from the
// research pipeline's own validationCache, so the second runTwoStageValidation
// call hits the cache for every substituted query — ~0ms, $0.

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

/**
 * @typedef {Object} CandidateEntry
 * @property {string}  text       Query text
 * @property {string=} intent     Intent bucket: 'commercial'|'vertical'|'comparison'|'problem'|'informational'
 * @property {number=} score      Research pipeline score (0-100)
 * @property {boolean=} unverified True when cross-model validation disagreed
 */

/**
 * @typedef {Object} QueryWithIntent
 * @property {string}  text
 * @property {string=} intent
 */

/**
 * @typedef {Object} Substitution
 * @property {string} original       Blocked query text
 * @property {string} originalIntent Intent of the blocked query (may be undefined)
 * @property {string} replacement    Replacement query text
 * @property {string} replacementIntent
 * @property {number} score          Replacement's research score
 * @property {string} searchBehavior The blocker's search_behavior ('mixed' | 'parametric')
 */

/**
 * Type guard: is this blocker auto-recoverable via substitution?
 * Only informationalIssues (shape: { query, search_behavior, ... }) are safe.
 * staticIssues ({ query, message }) and llmIssues (low-confidence verdicts)
 * are NOT safe — a substitution may introduce the same problem.
 *
 * @param {Object} blocker
 * @returns {boolean}
 */
export function isRecoverable(blocker) {
  return blocker != null
    && typeof blocker.query === 'string'
    && typeof blocker.search_behavior === 'string';
}

/**
 * Given a set of blockers (informationalIssues only), a queries list, and
 * the candidatePool, return substitutions that maximize intent diversity in
 * the final 3-query set.
 *
 * Ranking rule (intent diversity, per senior review Q1):
 *   1. surviving_intents = intents of queries NOT in blockers
 *   2. for each blocker (processed in blocker order):
 *        pick = highest-scored alternative with intent ∉ surviving_intents
 *               AND text ∉ already-used queries
 *        fallback: highest-scored alternative regardless of intent bucket
 *        after pick: add pick.intent to surviving_intents
 *   3. unresolved = blockers for which no alternative was available
 *
 * @param {Object} opts
 * @param {Object[]} opts.blockers               informationalIssues array
 * @param {QueryWithIntent[]} opts.queries       current 3 queries with their intents
 * @param {CandidateEntry[]} opts.candidatePool  up to 5 validated alternatives
 * @returns {{
 *   substitutions: Substitution[],
 *   unresolvedBlockers: Object[],
 *   newQueries: string[]
 * }}
 */
export function tryAutoRecover({ blockers, queries, candidatePool }) {
  const blockedTexts = new Set(blockers.map(b => b.query));
  const usedTexts = new Set(queries.map(q => q.text));
  const survivingIntents = new Set(
    queries.filter(q => !blockedTexts.has(q.text) && q.intent).map(q => q.intent)
  );

  // Sort pool by score desc — cheap, runs once per recover call
  const sortedPool = [...candidatePool].sort((a, b) => (b.score || 0) - (a.score || 0));

  const substitutions = [];
  const unresolvedBlockers = [];

  for (const blocker of blockers) {
    const blockedQuery = queries.find(q => q.text === blocker.query);
    const originalIntent = blockedQuery?.intent;

    const diverseIdx = sortedPool.findIndex(c =>
      !usedTexts.has(c.text) && c.intent && !survivingIntents.has(c.intent)
    );
    const fallbackIdx = sortedPool.findIndex(c => !usedTexts.has(c.text));

    const pickIdx = diverseIdx >= 0 ? diverseIdx : fallbackIdx;
    if (pickIdx < 0) {
      unresolvedBlockers.push(blocker);
      continue;
    }

    const pick = sortedPool[pickIdx];
    substitutions.push({
      original: blocker.query,
      originalIntent: originalIntent || '',
      replacement: pick.text,
      replacementIntent: pick.intent || '',
      score: pick.score || 0,
      searchBehavior: blocker.search_behavior,
    });

    usedTexts.add(pick.text);
    if (pick.intent) survivingIntents.add(pick.intent);
  }

  const subByOriginal = new Map(substitutions.map(s => [s.original, s.replacement]));
  const newQueries = queries.map(q => subByOriginal.get(q.text) || q.text);

  return { substitutions, unresolvedBlockers, newQueries };
}

/**
 * Interactive TTY prompt for a single blocked query. Returns replacement text,
 * 'MANUAL' (caller should re-prompt for free-text), or null (user chose abort).
 *
 * Prompt format (per senior review Q2): 4 options (1-N / m / a), no [f]
 * — global --force covers "keep original". Default Enter = recommended (1).
 *
 * @param {Object} opts
 * @param {Object} opts.blocker           one informationalIssues entry
 * @param {CandidateEntry[]} opts.available  pool filtered to non-used, top-4
 * @param {(q: string) => Promise<string>} opts.ask  matches the init ask helper
 * @param {boolean} [opts.useColor]
 * @returns {Promise<{action:'replace',text:string}|{action:'manual'}|{action:'abort'}>}
 */
export async function promptBlockedQueryReplacement({ blocker, available, ask, useColor = true }) {
  const c = useColor
    ? { red: RED, yellow: YELLOW, green: GREEN, dim: DIM, bold: BOLD, reset: RESET }
    : { red: '', yellow: '', green: '', dim: '', bold: '', reset: '' };

  console.log('');
  console.log(`${c.yellow}  Query blocked:${c.reset} "${blocker.query}"`);
  console.log(`${c.dim}    search_behavior: ${blocker.search_behavior} — produces tutorial answers, not vendor lists${c.reset}`);
  console.log('');
  console.log(`${c.bold}  Choose a replacement:${c.reset}`);

  const shown = available.slice(0, 4);
  shown.forEach((cand, i) => {
    const marker = i === 0 ? ` ${c.green}← recommended${c.reset}` : '';
    const intent = cand.intent ? `${cand.intent}, ` : '';
    const score = cand.score != null ? `score ${cand.score}` : '';
    console.log(`    ${c.bold}[${i + 1}]${c.reset} ${cand.text}  ${c.dim}(${intent}${score})${c.reset}${marker}`);
  });
  console.log(`    ${c.bold}[m]${c.reset} type your own replacement`);
  console.log(`    ${c.bold}[a]${c.reset} abort — edit queries manually with --keywords`);
  console.log('');

  const range = shown.length === 1 ? '1' : `1-${shown.length}`;
  const ans = (await ask(`  Pick [${range}/m/a] (Enter = 1): `)).trim().toLowerCase();

  if (ans === 'a') return { action: 'abort' };
  if (ans === 'm') return { action: 'manual' };
  const picked = ans === '' ? 1 : parseInt(ans, 10);
  if (Number.isFinite(picked) && picked >= 1 && picked <= shown.length) {
    return { action: 'replace', text: shown[picked - 1].text };
  }
  // Invalid input → treat as recommended (Enter default). Robust to typos.
  return { action: 'replace', text: shown[0].text };
}

/**
 * Actionable panel printed in --yes mode when recovery cannot finish silently:
 * multi-blocked with safer-default panel behavior, OR pool exhausted, OR any
 * non-informational blocker present. Gives the user a copy-paste --keywords
 * command pre-populated from the validated pool.
 *
 * @param {Object} opts
 * @param {Object[]} opts.allBlockers        static + llm + informational (full picture)
 * @param {CandidateEntry[]} opts.candidatePool
 * @param {string[]} opts.currentQueries     current 3 queries
 * @param {string} opts.brand
 * @param {string} opts.domain
 * @param {boolean} [opts.useColor]
 * @returns {string[]} lines ready for console.log
 */
export function formatRecoveryPanel({
  allBlockers, candidatePool, currentQueries, brand, domain, useColor = true,
}) {
  const c = useColor
    ? { red: RED, yellow: YELLOW, green: GREEN, dim: DIM, bold: BOLD, reset: RESET }
    : { red: '', yellow: '', green: '', dim: '', bold: '', reset: '' };

  const lines = [];
  lines.push('');
  lines.push(`${c.red}${c.bold}  Cannot auto-recover — ${allBlockers.length} query/queries blocked by validator.${c.reset}`);
  lines.push('');
  lines.push(`${c.bold}  Blocked:${c.reset}`);
  for (const b of allBlockers) {
    const reason = b.search_behavior
      ? `non-commercial (search_behavior: ${b.search_behavior})`
      : b.message || b.reason || 'low-confidence LLM verdict';
    lines.push(`    ${c.yellow}✗${c.reset} "${b.query}"`);
    lines.push(`      ${c.dim}${reason}${c.reset}`);
  }
  lines.push('');
  lines.push(`${c.bold}  How to fix — pick one:${c.reset}`);
  lines.push('');

  // Option 1 — pre-filled --keywords command. Take up to 3 best alternatives
  // from the validated pool, falling back to user-editable templates when pool
  // is exhausted. Pool is small (≤5) and pre-validated → safest default.
  const unusedPool = candidatePool.filter(c => !currentQueries.includes(c.text));
  const suggested = unusedPool.slice(0, 3).map(c => c.text);
  const fillers = [
    `best ${brand} alternatives 2026`,
    `top ${brand} competitors`,
    `${brand} vs alternatives`,
  ];
  const finalQueries = suggested.length === 3
    ? suggested
    : [...suggested, ...fillers.slice(suggested.length)].slice(0, 3);
  const poolNote = suggested.length === 3
    ? ' (from validated pool)'
    : suggested.length > 0
      ? ` (${suggested.length} from validated pool, rest are editable templates)`
      : ' (editable templates — replace with your own)';

  lines.push(`    ${c.bold}1.${c.reset} Rerun with hand-picked queries${poolNote}:`);
  lines.push(`         ${c.dim}aeo-platform init --yes \\${c.reset}`);
  lines.push(`         ${c.dim}  --brand=${brand} \\${c.reset}`);
  lines.push(`         ${c.dim}  --domain=${domain} \\${c.reset}`);
  lines.push(`         ${c.dim}  --keywords="${finalQueries.join(',')}"${c.reset}`);
  lines.push('');

  // Option 2 — --force escape hatch. Mention but do NOT recommend for
  // non-commercial blockers: they'll produce 0% visibility scores and pollute
  // the trend signal. Kept in the list because it's the one-command unblock.
  lines.push(`    ${c.bold}2.${c.reset} Keep the blocked query/queries anyway (not recommended):`);
  lines.push(`         ${c.dim}aeo-platform init --yes --auto --force \\${c.reset}`);
  lines.push(`         ${c.dim}  --brand=${brand} --domain=${domain}${c.reset}`);
  lines.push(`         ${c.dim}(0% visibility on non-commercial queries pollutes weekly trend data)${c.reset}`);
  lines.push('');

  // Option 3 — category override. Sometimes wrong-intent queries are a
  // symptom of mis-inferred category. Worth suggesting.
  lines.push(`    ${c.bold}3.${c.reset} Try again with an explicit category hint (different alternatives may surface):`);
  lines.push(`         ${c.dim}aeo-platform init --yes --auto \\${c.reset}`);
  lines.push(`         ${c.dim}  --brand=${brand} --domain=${domain} \\${c.reset}`);
  lines.push(`         ${c.dim}  --category="<your niche in one phrase>"${c.reset}`);
  lines.push('');

  return lines;
}

/**
 * Compose a single warning line for --yes mode when auto-promotion succeeds.
 * Per senior review R1: disclose measurement-semantics shift so the user
 * knows their visibility score now tracks a different intent than intended.
 *
 * @param {Substitution} sub
 * @param {boolean} [useColor]
 * @returns {string[]}
 */
export function formatAutoPromoteWarning(sub, useColor = true) {
  const c = useColor
    ? { yellow: YELLOW, green: GREEN, dim: DIM, bold: BOLD, reset: RESET }
    : { yellow: '', green: '', dim: '', bold: '', reset: '' };

  const intentShift = sub.originalIntent && sub.replacementIntent
    ? `${sub.originalIntent} → ${sub.replacementIntent}`
    : `search_behavior: ${sub.searchBehavior} → retrieval-triggered`;

  return [
    `${c.yellow}  ⚠ Query "${sub.original}" blocked (${sub.searchBehavior}).${c.reset}`,
    `${c.dim}    Auto-swapped with validated alternative:${c.reset} ${c.green}"${sub.replacement}"${c.reset}${sub.replacementIntent ? ` ${c.dim}(${sub.replacementIntent}, score ${sub.score})${c.reset}` : ''}`,
    `${c.dim}    Measurement shifts (${intentShift}) — your visibility score tracks the new question.${c.reset}`,
    `${c.dim}    Keep original: add --force. Pick your own 3 queries: use --keywords="...".${c.reset}`,
  ];
}
