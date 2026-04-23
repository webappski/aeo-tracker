#!/usr/bin/env node

/**
 * @webappski/aeo-tracker v0.5.0
 * Open-source CLI for tracking brand visibility across AI answer engines.
 * https://webappski.com | MIT License
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { CONFIG_FILE, DEFAULT_CONFIG, SUGGEST_MODELS, CLASSIFY_MODELS, PROVIDER_PRIORITY } from '../lib/config.js';
import { PROVIDERS } from '../lib/providers/index.js';
import { detectMention, findPosition, extractUrls } from '../lib/mention.js';
import { diff } from '../lib/diff.js';
import { renderMarkdown, parseRawResponse } from '../lib/report/markdown.js';
import { renderHtml } from '../lib/report/html.js';
import { classifyCitations } from '../lib/report/classify-citations.js';
import { discoverModels } from '../lib/providers/discover.js';
import { extractUsage, calcCost } from '../lib/providers/pricing.js';
// Stable dependencies used in hot paths (init + run + queries-only) — promoted
// from dynamic imports for clarity and cold-start speed.
import { runTwoStageValidation, formatValidationResult, hasBlockers } from '../lib/init/research/run-validation.js';
import { classifyResponseQuality } from '../lib/report/response-quality.js';
import { extractWithTwoModels } from '../lib/report/extract-competitors-llm.js';
import { PROVIDER_LABELS, detectStandardKeys, heuristicKeyMatch } from '../lib/init/keys.js';
import { detectGeography } from '../lib/init/fetch-site.js';
import { classifyProviderError } from '../lib/providers/classify-error.js';
import { formatResearchFailurePanel } from '../lib/init/research-failure-panel.js';
import { formatAllEnginesFailedPanel } from '../lib/errors/all-engines-failed-panel.js';
import { formatUnexpectedErrorPanel } from '../lib/errors/unexpected-error-panel.js';

/**
 * Safely extract a human-readable message from any caught value.
 * `catch (err)` receives an `unknown` — err may be a string, a number, null,
 * or a proper Error. `.message` is only defined on Error subclasses, so guard.
 */
const errMsg = (err) => (err instanceof Error ? err.message : String(err));

// ─── ANSI colors (zero-dep) ───
// Disable ANSI when stdout is not a TTY (piped to file, CI logs) or NO_COLOR is set (no-color.org convention).
// This keeps CI log files clean — no \x1b[...m noise in GitHub Actions / GitLab CI output.
const USE_COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const c = USE_COLOR
  ? {
      reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
      red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
      blue: '\x1b[34m', cyan: '\x1b[36m', white: '\x1b[37m',
    }
  : {
      reset: '', bold: '', dim: '',
      red: '', green: '', yellow: '',
      blue: '', cyan: '', white: '',
    };

// ─── LLM-based action recommendations ───

async function deriveActionsWithLLM(latest, prev, category, { providerName, providerCall, apiKey, model }) {
  const PLABELS = { openai: 'ChatGPT', gemini: 'Gemini', anthropic: 'Claude', perplexity: 'Perplexity' };
  const providers = [...new Set(latest.results.map(r => r.provider))];

  const engineLines = providers.map(p => {
    const rs = latest.results.filter(r => r.provider === p && r.mention !== 'error');
    const hits = rs.filter(r => r.mention === 'yes' || r.mention === 'src').length;
    const perQuery = rs.map(r => `    Q: "${r.queryText || r.query}" → ${r.mention}`).join('\n');
    return `  ${PLABELS[p] || p}: ${hits}/${rs.length} mentions\n${perQuery}`;
  }).join('\n');

  const compLines = (latest.topCompetitors || []).slice(0, 8)
    .map(c => `  - ${c.name} (${c.count} checks)`).join('\n') || '  (none detected)';

  const srcLines = (latest.topCanonicalSources || []).slice(0, 8)
    .map(s => `  ${s.count}× ${s.url}`).join('\n') || '  (none)';

  const prevNote = prev
    ? `Previous score: ${prev.score}% (${latest.score >= prev.score ? '+' : ''}${latest.score - prev.score}pp change)`
    : 'First run — no historical comparison available.';

  const prompt = `You are a senior AEO (Answer Engine Optimization) consultant. Analyse this visibility data and write 3–5 concrete, specific, actionable recommendations.

BRAND: ${latest.brand}
DOMAIN: ${latest.domain}
CATEGORY: ${category}
CURRENT SCORE: ${latest.score}% (${latest.mentions}/${latest.total} checks returned a mention)
${prevNote}

RESULTS BY ENGINE:
${engineLines}

COMPETITORS FOUND IN AI ANSWERS:
${compLines}

TOP SOURCES AI KEEPS CITING FOR THIS VERTICAL:
${srcLines}

Rules:
- Be specific. Name the exact query, source, or competitor — not generic advice.
- Each action must be completable this week by one person.
- Prioritise gaps (brand invisible) over polish.
- If a canonical source appears ≥2×, recommend pitching it specifically.
- If a competitor dominates, explain exactly where and how to displace them.

Return STRICT JSON only:
{
  "actions": [
    {
      "kind": "gap|compete|defend|win",
      "priority": "high|med|low",
      "engines": ["openai"],
      "title": "Max 8 words",
      "detail": "1–2 sentences, specific and actionable."
    }
  ]
}

engines = array of provider names (openai/gemini/anthropic/perplexity), empty if cross-engine.`;

  const { text, raw } = await providerCall(prompt, apiKey, model, { webSearch: false });

  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
    else throw new Error('Could not parse actions response');
  }
  if (!Array.isArray(parsed?.actions) || parsed.actions.length === 0) {
    throw new Error('LLM returned empty actions array');
  }

  const usage = extractUsage(providerName, raw);
  const costDetail = calcCost(model, usage) || { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: 0 };
  return {
    actions: parsed.actions,
    costInfo: {
      provider: providerName, model, label: 'action-recommendations',
      requests: 1,
      inputTokens: costDetail.inputTokens,
      outputTokens: costDetail.outputTokens,
      costUsd: costDetail.costUsd,
    },
  };
}

// ─── Provider helpers ───

const PROVIDER_MODULES = {
  openai:    '../lib/providers/openai.js',
  anthropic: '../lib/providers/anthropic.js',
  gemini:    '../lib/providers/gemini.js',
};
const PROVIDER_CALL_FN = { openai: 'callOpenAI', anthropic: 'callAnthropic', gemini: 'callGemini' };

// ─── Replay mode ───
// Serves cached raw provider responses from aeo-responses/DATE/*.json instead
// of hitting the live APIs. Two legitimate use-cases:
//   1. Iterating on report/parser/UI locally without burning API credits.
//   2. Re-generating a summary with new extractor logic from historical data.
// Stale-data caveat: the raw engine responses reflect the capture date, not
// today — citations and competitor sets may have drifted. Activated by:
//   aeo-tracker run --replay                    # replay the most recent snapshot
//   aeo-tracker run --replay-from=2026-04-22    # replay a specific date

function _extractFromRaw(providerName, raw) {
  if (providerName === 'anthropic') {
    const text = (raw.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const citations = (raw.content || [])
      .filter(b => b.type === 'web_search_tool_result')
      .flatMap(b => (b.content || []).map(c => c.url).filter(Boolean));
    return { text, citations };
  }
  if (providerName === 'openai') {
    const text = raw.choices?.[0]?.message?.content || '';
    const citations = (raw.choices?.[0]?.message?.annotations || [])
      .filter(a => a.url_citation).map(a => a.url_citation.url);
    return { text, citations };
  }
  if (providerName === 'gemini') {
    const text = (raw.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('\n');
    const citations = (raw.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
      .map(ch => {
        const web = ch.web; if (!web?.uri) return null;
        const isRedirect = /^https?:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//.test(web.uri);
        if (isRedirect) {
          const t = web.title;
          if (t && /^[\w-]+(?:\.[\w-]+)+(?:\/|$)/.test(t)) return t.startsWith('http') ? t : `https://${t}`;
          return null;
        }
        return web.uri;
      })
      .filter(Boolean);
    return { text, citations };
  }
  if (providerName === 'perplexity') {
    const text = raw.choices?.[0]?.message?.content || '';
    const citations = raw.citations || raw.choices?.[0]?.message?.citations || [];
    return { text, citations };
  }
  return { text: '', citations: [] };
}

async function _tryReplay(qi, provider, srcDate) {
  const safeModel = provider.model.replace(/[^a-z0-9.-]/gi, '-');
  const replayPath = join('aeo-responses', srcDate, `q${qi}-${provider.name}-${safeModel}.json`);
  if (!existsSync(replayPath)) return null;
  const raw = JSON.parse(await readFile(replayPath, 'utf-8'));
  const { text, citations } = _extractFromRaw(provider.name, raw);
  return { text, citations, raw };
}

async function _resolveReplaySource(explicitDate) {
  if (explicitDate) return explicitDate;
  const { readdirSync } = await import('node:fs');
  if (!existsSync('aeo-responses')) return null;
  const dates = readdirSync('aeo-responses')
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  return dates[dates.length - 1] || null;
}

/**
 * Build a resolved provider descriptor ready for research/brainstorm calls.
 * @param {string} name              Provider key — 'openai' | 'anthropic' | 'gemini'
 * @param {string} envVarName        The env var name holding the API key
 */
async function makeResearchProvider(name, envVarName) {
  const callFn = (await import(PROVIDER_MODULES[name]))[PROVIDER_CALL_FN[name]];
  return {
    name,
    providerCall: callFn,
    apiKey: process.env[envVarName],
    model: SUGGEST_MODELS[name],
    label: PROVIDER_LABELS[name],
  };
}

/**
 * List all available research providers in PROVIDER_PRIORITY order. The retry
 * loop in init walks this array on billing/auth/rate-limit errors — first
 * provider that returns a successful research result wins; if all fail, the
 * actionable error panel enumerates what was tried.
 * @param {Object} providerKeyMap  { providerName: envVarName } — any subset
 * @returns {Promise<Array>} zero or more provider descriptors in priority order
 */
async function listResearchProviders(providerKeyMap) {
  const hasKey = (name) => providerKeyMap[name] && process.env[providerKeyMap[name]];
  const available = PROVIDER_PRIORITY.filter(hasKey);
  return Promise.all(available.map(name => makeResearchProvider(name, providerKeyMap[name])));
}

/**
 * Build { primary, validator } for the research pipeline. Backwards-compatible
 * wrapper over listResearchProviders — picks first as primary, second as
 * cross-model validator. Used by validation paths that don't need retry logic
 * (they're already defensive via runValidationFlow).
 * @param {Object} providerKeyMap  { providerName: envVarName } — any subset of providers
 * Returns { primary: null } if no key is available in the environment.
 */
async function buildResearchProviders(providerKeyMap) {
  const providers = await listResearchProviders(providerKeyMap);
  return {
    primary: providers[0] || null,
    validator: providers[1] || null,
  };
}

/**
 * Resolve the two-model competitor-extraction providers (OpenAI + Gemini at
 * their CLASSIFY_MODELS tier). Hard-fails if either key is missing — single-model
 * extraction isn't supported to keep the cross-check signal honest.
 */
async function buildExtractionProviders(providerConfig) {
  const mkProvider = async (name) => {
    const envVar = providerConfig?.[name]?.env || `${name.toUpperCase()}_API_KEY`;
    const apiKey = process.env[envVar];
    if (!apiKey) return null;
    const callFn = (await import(PROVIDER_MODULES[name]))[PROVIDER_CALL_FN[name]];
    return {
      name,
      providerCall: callFn,
      apiKey,
      model: CLASSIFY_MODELS[name],
      label: PROVIDER_LABELS[name],
    };
  };
  // Parallel — two dynamic imports + env lookups independent of each other.
  const [primary, secondary] = await Promise.all([mkProvider('openai'), mkProvider('gemini')]);
  if (!primary || !secondary) {
    const missing = [!primary && 'OpenAI', !secondary && 'Gemini'].filter(Boolean).join(' + ');
    throw new Error(`Two-model competitor extractor requires both OpenAI and Gemini API keys — missing: ${missing}. See README for setup.`);
  }
  return { primary, secondary };
}

/**
 * Shared two-stage validation flow used by init, init --queries-only, and run.
 * Handles console I/O, cost display, interactive y/N fallback, and abort logic.
 * Returns the validation object (includes updatedCache to persist in config).
 */
async function runValidationFlow({
  queries, brand, domain, category, geography = [],
  primary, secondary = null, validationCache = [],
  nonInteractive = false, force = false, strictValidation = false,
  onAbort,
}) {
  const willCallLLM = primary && (validationCache || []).length === 0
    ? queries.length > 0
    : queries.some(q => !(validationCache || []).find(c => c.query === q));

  // Override model with CLASSIFY_MODELS (Haiku / 4o-mini) — classification task, not generation.
  // ~10× cheaper than SUGGEST_MODELS at equivalent accuracy for structured judgements.
  const classifyPrimary = primary
    ? { ...primary, model: CLASSIFY_MODELS[primary.name] || primary.model }
    : null;
  const classifySecondary = (strictValidation && secondary)
    ? { ...secondary, model: CLASSIFY_MODELS[secondary.name] || secondary.model }
    : null;

  if (willCallLLM && classifyPrimary) {
    const who = classifySecondary
      ? `${classifyPrimary.label} + ${classifySecondary.label} (strict cross-check)`
      : classifyPrimary.label;
    process.stdout.write(`${c.dim}  Validating queries via ${who}... ${c.reset}`);
  }

  const v = await runTwoStageValidation({
    queries, brand, domain, category, geography,
    primary: classifyPrimary, secondary: classifySecondary, validationCache,
  });

  if (willCallLLM) {
    const cost = v.costInfo?.costUsd ? `$${v.costInfo.costUsd.toFixed(4)}` : '';
    console.log(`${c.dim}${cost ? `(${cost})` : ''}${c.reset}`);
  } else if (v.cacheHits > 0) {
    console.log(`${c.dim}  ✓ validation cache hit for all ${v.cacheHits} query/queries (no LLM cost)${c.reset}`);
  }

  const lines = formatValidationResult(v);
  for (const line of lines) console.log(`  ${c.yellow}${line}${c.reset}`);

  if (!hasBlockers(v)) {
    if (lines.length === 0) console.log(`${c.green}  ✓ All queries pass validation${c.reset}`);
    return v;
  }

  if (force) {
    console.log(`${c.yellow}  --force set — proceeding despite blockers.${c.reset}`);
    return v;
  }
  if (nonInteractive) {
    console.error(`${c.red}✗ Aborted — queries failed validation. Fix queries or pass --force.${c.reset}`);
    if (onAbort) onAbort(); else process.exit(1);
    return v;
  }

  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise(resolve => {
    rl.question(`${c.yellow}Save/run anyway? [y/N] ${c.reset}`, a => { rl.close(); resolve(a.trim()); });
  });
  if (!/^y/i.test(ans)) {
    console.log(`${c.yellow}Aborted. Tip: aeo-tracker init --queries-only to regenerate.${c.reset}`);
    if (onAbort) onAbort(); else process.exit(0);
  }
  return v;
}

// ─── Commands ───

async function cmdInit(opts = {}) {
  const nonInteractive = opts.yes === true;

  const { createInterface } = await import('node:readline');
  const rl = nonInteractive ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = nonInteractive
    ? async (_q, def = '') => def
    : (q) => new Promise(resolve => rl.question(q, resolve));
  const closeRl = () => rl && rl.close();

  console.log(`\n${c.bold}@webappski/aeo-tracker — init${opts.queriesOnly ? ' --queries-only' : ''}${c.reset}\n`);

  // ── --queries-only: re-suggest queries without touching the rest of config ──
  if (opts.queriesOnly) {
    if (!existsSync(CONFIG_FILE)) {
      console.error(`${c.red}No ${CONFIG_FILE} found. Run: aeo-tracker init${c.reset}`);
      closeRl();
      process.exit(1);
    }
    const existing = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
    const { brand, domain: existingDomain, providers: existingProviders } = existing;
    if (!brand || !existingDomain) {
      console.error(`${c.red}Config is missing brand or domain — run aeo-tracker init first${c.reset}`);
      closeRl();
      process.exit(1);
    }

    console.log(`${c.dim}  Brand: ${brand} | Domain: ${existingDomain}${c.reset}`);
    console.log(`${c.dim}  Existing queries:${c.reset}`);
    (existing.queries || []).forEach((q, i) => console.log(`    Q${i + 1}: ${q}`));

    // Build provider key map from existing config + standard env var names
    const standard = detectStandardKeys();
    const existingKeyMap = {};
    for (const p of PROVIDER_PRIORITY) {
      const envName = existingProviders?.[p]?.env || standard[p];
      if (envName) existingKeyMap[p] = envName;
    }
    const { primary, validator } = await buildResearchProviders(existingKeyMap);
    if (!primary) {
      console.error(`${c.red}No API key found. Ensure at least one provider key is in the environment.${c.reset}`);
      closeRl();
      process.exit(1);
    }

    const { normalizeUrl, fetchSite, parseSiteContent, detectAudience } = await import('../lib/init/fetch-site.js');
    const fullUrl = normalizeUrl(existingDomain);

    console.log(`\n${c.dim}  Fetching ${fullUrl}...${c.reset}`);
    let site;
    try {
      const { html } = await fetchSite(fullUrl);
      site = parseSiteContent(html);
    } catch (err) {
      console.error(`${c.red}Failed to fetch site: ${errMsg(err)}${c.reset}`);
      closeRl();
      process.exit(1);
    }

    const categoryDescription = existing.category || '';
    const audienceTags = detectAudience(site);
    const geoTags = detectGeography(existingDomain, site);

    const { research } = await import('../lib/init/research/research.js');
    const { selectTopThree, formatSelection } = await import('../lib/init/research/select.js');
    console.log(`${c.dim}  [brainstorm → filter → score → validate]${c.reset}\n`);

    let newQueries = [];
    let newCandidatePool = [];
    try {
      const researchResult = await research({
        brand, domain: existingDomain, site, category: categoryDescription,
        audienceTags, geoTags, primary, validator,
        logPhase: ({ phase, status, details }) => {
          const parts = [`${c.dim}  [${phase}]`, status];
          if (details?.count !== undefined) parts.push(`(${details.count})`);
          if (details?.kept !== undefined) parts.push(`kept=${details.kept} rejected=${details.rejected}`);
          if (details?.topScore !== undefined) parts.push(`topScore=${details.topScore}`);
          console.log(parts.join(' ') + c.reset);
        },
      });
      const selectResult = selectTopThree(researchResult.candidates, { validationSkipped: !validator });
      console.log(`\n${c.dim}  pipeline cost ~$${researchResult.trace.estimatedCostUsd.toFixed(4)}${c.reset}\n`);
      for (const line of formatSelection(selectResult)) console.log(line);

      const accept = (nonInteractive ? 'y' : (await ask(`\nReplace queries? [Y]es / [e]dit / [n]o: `, 'y'))).trim();
      if (/^e/i.test(accept)) {
        for (let i = 0; i < selectResult.selected.length; i++) {
          const cand = selectResult.selected[i].candidate;
          const v = (await ask(`  Q${i + 1} [${cand.text}]: `, cand.text)).trim();
          newQueries.push(v || cand.text);
        }
      } else if (!/^n/i.test(accept)) {
        newQueries = selectResult.selected.map(s => s.candidate.text);
      }
      if (selectResult.alternatives.length > 0) {
        newCandidatePool = selectResult.alternatives.slice(0, 5).map(a => ({
          text: a.text, intent: a.intent, score: a.score, unverified: !!a.unverified,
        }));
      }
    } catch (err) {
      console.error(`${c.red}Research failed: ${errMsg(err)}${c.reset}`);
      closeRl();
      process.exit(1);
    }

    if (newQueries.length !== 3) {
      console.log(`${c.yellow}Aborted — no queries saved.${c.reset}`);
      closeRl();
      return;
    }

    // Two-stage validation (same contract as full init path).
    const validationQ = await runValidationFlow({
      queries: newQueries,
      brand, domain: existingDomain,
      category: categoryDescription,
      geography: geoTags || [],
      primary, secondary: validator,
      validationCache: existing.validationCache || [],
      nonInteractive,
      force: opts.force,
      strictValidation: opts.strictValidation,
      onAbort: () => { closeRl(); process.exit(nonInteractive ? 1 : 0); },
    });

    const updated = { ...existing, queries: newQueries };
    if (newCandidatePool.length > 0) updated.candidatePool = newCandidatePool;
    if (validationQ?.updatedCache?.length > 0) {
      updated.validationCache = validationQ.updatedCache;
    }
    const tmpPath = CONFIG_FILE + '.tmp';
    await writeFile(tmpPath, JSON.stringify(updated, null, 2));
    const { rename } = await import('node:fs/promises');
    await rename(tmpPath, CONFIG_FILE);

    console.log(`\n${c.green}✓ Queries updated in ${CONFIG_FILE}${c.reset}`);
    newQueries.forEach((q, i) => console.log(`  Q${i + 1}: ${q}`));
    console.log(`\nNext: ${c.cyan}aeo-tracker run${c.reset}\n`);
    closeRl();
    return;
  }

  // P0.1 preconditions for non-interactive mode
  if (nonInteractive) {
    if (!opts.brand || !opts.domain) {
      console.error(`${c.red}--yes requires --brand and --domain${c.reset}`);
      process.exit(1);
    }
    if (!opts.auto && !opts.manual) {
      console.error(`${c.red}--yes requires either --auto or --manual${c.reset}`);
      process.exit(1);
    }
  }

  // A7: existing config
  if (existsSync(CONFIG_FILE)) {
    if (nonInteractive) {
      console.log(`${c.yellow}${CONFIG_FILE} exists — overwriting (--yes mode)${c.reset}`);
    } else {
      const ans = (await ask(`${c.yellow}${CONFIG_FILE} already exists. Overwrite? [y/N] ${c.reset}`, 'n')).trim();
      if (!/^y/i.test(ans)) { closeRl(); console.log('Aborted.'); return; }
    }
  }

  // Step 1 — brand + domain
  const brand = (opts.brand || (await ask(`Brand name (e.g. webappski): `, ''))).trim();
  if (!brand) { console.error(`${c.red}Brand is required${c.reset}`); closeRl(); process.exit(1); }

  // P2.2: short brand warning
  if (brand.length <= 3) {
    console.log(`${c.yellow}⚠ Brand "${brand}" is very short. Mention detection may produce false positives (e.g. "AI" matches every "ai" word in answers).${c.reset}`);
    if (!nonInteractive) {
      const cont = (await ask(`Continue anyway? [y/N] `, 'n')).trim();
      if (!/^y/i.test(cont)) { closeRl(); process.exit(0); }
    }
  }

  const domainRaw = (opts.domain || (await ask(`Domain (e.g. webappski.com, or full URL): `, ''))).trim();
  if (!domainRaw) { console.error(`${c.red}Domain is required${c.reset}`); closeRl(); process.exit(1); }

  const { normalizeUrl, extractDomain, fetchSite, parseSiteContent, detectSiteIssues, inferCategory, detectAudience } = await import('../lib/init/fetch-site.js');
  const fullUrl = normalizeUrl(domainRaw);
  const domain = extractDomain(domainRaw);

  // Step 2 — detect API keys
  const providerKey = {};
  const standard = detectStandardKeys();
  const heuristic = heuristicKeyMatch();

  console.log(`\n${c.bold}Checking environment for API keys...${c.reset}`);

  const standardFound = Object.entries(standard).filter(([, n]) => n);
  if (standardFound.length > 0) {
    for (const [p, n] of standardFound) {
      console.log(`  ${c.green}✓${c.reset} ${PROVIDER_LABELS[p]}: ${n}`);
      providerKey[p] = n;
    }
  } else {
    console.log(`  ${c.dim}Standard names not set${c.reset}`);
  }

  const missingAfterStandard = Object.keys(PROVIDER_LABELS).filter(p => !providerKey[p]);
  const heuristicCandidates = missingAfterStandard
    .map(p => [p, heuristic[p]])
    .filter(([, names]) => names.length > 0);

  if (heuristicCandidates.length > 0) {
    console.log(`\n  ${c.bold}Heuristic match — these look like API keys under non-standard names:${c.reset}`);
    for (const [p, names] of heuristicCandidates) {
      console.log(`    ${c.yellow}?${c.reset} ${PROVIDER_LABELS[p]}: ${names.join(', ')}`);
    }
    const use = (nonInteractive ? 'y' : (await ask(`Use these? [Y/n] `, 'y'))).trim();
    if (!/^n/i.test(use)) {
      for (const [p, names] of heuristicCandidates) {
        if (names.length === 1 || nonInteractive) {
          providerKey[p] = names[0];
        } else {
          console.log(`  Multiple candidates for ${PROVIDER_LABELS[p]}:`);
          names.forEach((n, i) => console.log(`    [${i + 1}] ${n}`));
          const pick = (await ask(`  Pick [1-${names.length}] or Enter to skip: `, '')).trim();
          const idx = Number(pick) - 1;
          if (idx >= 0 && idx < names.length) providerKey[p] = names[idx];
        }
      }
    }
  }

  // Step 3 — interactive per-provider fallback for anything stages 1+2 missed.
  // Runs even when SOME providers were found — so a user with OpenAI under the
  // standard name + Gemini under a non-matching custom name is still prompted for
  // the missing required provider (instead of silently proceeding → hard-failing
  // later at `run` because the two-model extractor can't start).
  const REQUIRED_PROVIDERS = ['openai', 'gemini'];
  const OPTIONAL_PROVIDERS = ['anthropic', 'perplexity'];
  const MAX_ATTEMPTS = 3;

  // Detect when a user pastes an ACTUAL API key instead of an env var NAME.
  // This is the most common confusion — the prompt says "env var name" but
  // someone under time pressure just pastes what's in their clipboard.
  // All major AI providers use recognisable prefixes for their key values.
  const looksLikeActualKey = (s) =>
    /^(sk-[a-z]|AIzaSy|sk-ant-|pplx-|ya29\.|gsk_)/i.test(s);

  const verifyEnvVar = (name) => {
    // Safety: user pasted the KEY VALUE instead of the env var NAME.
    // Never log the value; just nudge them toward the correct input.
    if (looksLikeActualKey(name)) {
      return {
        ok: false,
        reason: `that looks like an API key value, not an env var name. Please type the NAME of the variable that holds your key (e.g. OPENAI_API_KEY or MY_OPENAI_KEY) — your actual key stays in your shell env, aeo-tracker only needs to know which variable to read`,
      };
    }
    // Env var names must be [A-Z_][A-Z0-9_]* (POSIX). Detect invalid chars early.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return { ok: false, reason: `"${name}" isn't a valid env var name — names can only contain letters, digits, and underscores, and cannot start with a digit` };
    }
    const value = process.env[name];
    if (value === undefined) return { ok: false, reason: `$${name} is not set in your shell — check the name (case-sensitive) or set the variable first via ~/.zshrc` };
    if (value.length < 20) return { ok: false, reason: `$${name} is set, but the value is too short (${value.length} chars) — real API keys are 40+ chars, so this looks like a typo` };
    return { ok: true, length: value.length };
  };

  if (!nonInteractive) {
    const missingRequired = REQUIRED_PROVIDERS.filter(p => !providerKey[p]);
    const missingOptional = OPTIONAL_PROVIDERS.filter(p => !providerKey[p]);

    if (missingRequired.length > 0 || missingOptional.length > 0) {
      console.log(`\n${c.yellow}Some API keys weren't auto-detected. Type the env var name (not the key itself) — or Enter to skip optional providers:${c.reset}`);
    }

    // Required: loop until entered OR attempts exhausted.
    for (const p of missingRequired) {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !providerKey[p]; attempt++) {
        const tag = attempt === 1 ? '(required)' : `(required, attempt ${attempt}/${MAX_ATTEMPTS})`;
        const name = (await ask(`  ${PROVIDER_LABELS[p]} env var name ${tag}: `, '')).trim();
        if (!name) {
          console.log(`    ${c.yellow}⚠ ${PROVIDER_LABELS[p]} cannot be skipped — it's required for the two-model competitor extractor.${c.reset}`);
          continue;
        }
        const v = verifyEnvVar(name);
        if (!v.ok) {
          console.log(`    ${c.red}✗ ${name}: ${v.reason}${c.reset}`);
          continue;
        }
        providerKey[p] = name;
        console.log(`    ${c.green}✓ verified (${v.length} chars)${c.reset}`);
      }
    }

    // Optional: one shot per provider, Enter to skip.
    for (const p of missingOptional) {
      const name = (await ask(`  ${PROVIDER_LABELS[p]} env var name (Enter to skip — optional): `, '')).trim();
      if (!name) continue;
      const v = verifyEnvVar(name);
      if (!v.ok) {
        console.log(`    ${c.yellow}⚠ ${name}: ${v.reason} — skipping ${PROVIDER_LABELS[p]}${c.reset}`);
        continue;
      }
      providerKey[p] = name;
      console.log(`    ${c.green}✓ verified (${v.length} chars)${c.reset}`);
    }
  }

  // Hard-fail if any REQUIRED provider is still missing after all stages.
  // In interactive mode this triggers only if user exhausted attempts or left
  // blank every time. In non-interactive mode it triggers if stages 1+2 didn't
  // find the key (Step 3 is skipped).
  const stillMissingRequired = REQUIRED_PROVIDERS.filter(p => !providerKey[p]);
  if (stillMissingRequired.length > 0) {
    console.log(`\n${c.red}Missing required keys: ${stillMissingRequired.map(p => PROVIDER_LABELS[p]).join(', ')}${c.reset}`);
    console.log(`aeo-tracker requires BOTH OpenAI and Gemini keys — they power the two-model competitor extractor in addition to being engine columns in the report.`);
    console.log(`\nGet them (2 minutes):`);
    console.log(`  OpenAI: https://platform.openai.com/api-keys`);
    console.log(`  Gemini: https://aistudio.google.com/apikey`);
    console.log(`\nAdd to ~/.zshrc (or equivalent):`);
    console.log(`  export OPENAI_API_KEY=sk-proj-...`);
    console.log(`  export GEMINI_API_KEY=AIzaSy...`);
    console.log(`Then: source ~/.zshrc && aeo-tracker init\n`);
    closeRl();
    process.exit(1);
  }

  console.log(`\n${c.green}Configured providers: ${Object.keys(providerKey).map(p => PROVIDER_LABELS[p]).join(', ')}${c.reset}`);

  // Step 4 — manual or auto
  let mode;
  if (nonInteractive) {
    mode = opts.auto ? 'auto' : 'manual';
  } else {
    const modeAns = (await ask(
      `\nHow should I configure queries and competitors?\n  [1] Manual — I'll type them\n  [2] Auto — analyze my site with an LLM and suggest\nChoose [1/2]: `,
      '1'
    )).trim();
    mode = modeAns === '2' ? 'auto' : 'manual';
  }

  let queries = [];
  let categoryDescription = '';
  let suggestionLang = '';
  let config_candidatePool = [];

  // P2: BYO keywords (`--keywords="q1,q2,q3"`) — skip brainstorm entirely, $0 LLM cost
  if (opts.keywords) {
    const list = String(opts.keywords).split(',').map(s => s.trim()).filter(Boolean);
    if (list.length !== 3) {
      console.error(`${c.red}--keywords requires exactly 3 comma-separated queries (got ${list.length})${c.reset}`);
      closeRl();
      process.exit(1);
    }
    queries = list;
    console.log(`\n${c.green}Using --keywords (BYO mode, $0 LLM cost):${c.reset}`);
    queries.forEach((q, i) => console.log(`  Q${i + 1}: ${q}`));
    mode = 'keywords';
  }

  if (mode === 'auto') {
    const researchProviders = await listResearchProviders(providerKey);
    if (researchProviders.length === 0) {
      console.log(`${c.yellow}No LLM-capable provider configured (need OpenAI, Anthropic, or Gemini). Falling back to manual.${c.reset}`);
    } else {
      const primaryForDisplay = researchProviders[0];
      // P1.6: privacy reassurance
      console.log(`\n${c.bold}Auto-suggest will:${c.reset}`);
      console.log(`  1. Fetch ${fullUrl} from your machine`);
      console.log(`  2. Extract title, meta, headings, first 2KB of body text`);
      console.log(`  3. Send that excerpt to ${primaryForDisplay.label} (${primaryForDisplay.model}) via YOUR API key`);
      if (researchProviders.length > 1) {
        const fallbacks = researchProviders.slice(1).map(p => p.label).join(', ');
        console.log(`     ${c.dim}(falls back to ${fallbacks} if the primary provider has a billing/auth/rate-limit issue)${c.reset}`);
      }
      console.log(`  4. Show you the suggested queries + competitors before saving`);
      console.log(`  ${c.dim}Your API key never leaves this machine. No telemetry. No analytics. No traffic to webappski.com.${c.reset}`);
      const go = (nonInteractive ? 'y' : (await ask(`Continue? [Y/n] `, 'y'))).trim();
      if (!/^n/i.test(go)) {
        try {
          process.stdout.write(`${c.dim}  Fetching ${fullUrl}...${c.reset} `);
          const { html, finalUrl } = await fetchSite(fullUrl);
          console.log(`(${html.length.toLocaleString()} bytes, via ${finalUrl})`);

          const site = parseSiteContent(html);
          const issues = detectSiteIssues(site, html);
          if (issues.includes('BOT_PROTECTED')) console.log(`  ${c.yellow}⚠ Bot protection detected (Cloudflare). Content may be unreliable.${c.reset}`);
          if (issues.includes('SPA_OR_EMPTY')) console.log(`  ${c.yellow}⚠ Site looks JS-rendered (SPA). Auto-suggest may produce generic results.${c.reset}`);
          if (issues.includes('TINY_HTML')) console.log(`  ${c.yellow}⚠ Very little HTML returned (${html.length} bytes).${c.reset}`);
          if (issues.length > 0 && !nonInteractive) {
            const cont = (await ask(`Continue anyway? [y/N] `, 'n')).trim();
            if (!/^y/i.test(cont)) throw new Error('user aborted after site issues');
          }

          // P0.4: brand-on-site check
          const allSiteText = `${site.title} ${site.metaDesc} ${(site.h1 || []).join(' ')} ${(site.h2 || []).join(' ')} ${site.text || ''}`.toLowerCase();
          if (!allSiteText.includes(brand.toLowerCase())) {
            console.log(`${c.yellow}⚠ Brand "${brand}" not found anywhere on ${fullUrl}.${c.reset}`);
            console.log(`  Possible: typo in brand, wrong domain, or brand not on homepage.`);
            if (!nonInteractive) {
              const cont = (await ask(`Continue anyway? [y/N] `, 'n')).trim();
              if (!/^y/i.test(cont)) throw new Error('aborted: brand not found on site');
            }
          }

          // P1: category description — the single most important disambiguator.
          // Webappski case showed that a brand like "AEO services" can match the wrong industry
          // (customs) without an explicit category. Priority: --category flag > interactive prompt > auto-infer.
          const autoCategory = inferCategory(site, brand);
          const audienceTags = detectAudience(site);
          const geoTags = detectGeography(domain, site);
          if (opts.category) {
            categoryDescription = opts.category.trim();
            console.log(`${c.dim}  Category (from --category flag): ${categoryDescription}${c.reset}`);
          } else if (nonInteractive) {
            categoryDescription = autoCategory;
            console.log(`${c.yellow}  No --category flag — using auto-inferred from site:${c.reset}`);
            console.log(`    "${categoryDescription}"`);
            console.log(`${c.dim}  Pass --category="..." next time to override if this is off.${c.reset}`);
          } else {
            console.log(`\n${c.bold}What does your company do?${c.reset} (one sentence — used to disambiguate queries)`);
            console.log(`${c.dim}  Auto-inferred from your site:${c.reset}`);
            console.log(`    "${autoCategory}"`);
            const answer = (await ask(`  Press Enter to accept, or type a custom description: `, '')).trim();
            categoryDescription = answer || autoCategory;
          }
          if (audienceTags.length > 0) console.log(`${c.dim}  Detected audience: ${audienceTags.join(', ')}${c.reset}`);
          if (geoTags.length > 0) console.log(`${c.dim}  Detected geography: ${geoTags.join(', ')}${c.reset}`);

          // LLM retry loop: walk researchProviders in priority order. Success
          // on any provider sets `llmSucceeded = true` and exits the loop.
          // Billing/auth/rate-limit errors are logged and we try the next
          // provider. Non-retryable errors (real bugs, malformed requests)
          // bubble to the outer catch so they're not silently swallowed.
          const attempts = [];
          let llmSucceeded = false;

          for (let i = 0; i < researchProviders.length; i++) {
            const primary = researchProviders[i];
            const validator = researchProviders.find((_, j) => j !== i) || null;

            if (i === 0 && !validator) {
              console.log(`${c.yellow}  ⚠ Cross-model validation skipped — only one LLM provider available (single-model bias risk).${c.reset}`);
            }
            if (i > 0) {
              console.log(`${c.dim}  Retrying brainstorm with ${primary.label}...${c.reset}`);
            }

            try {
              // --light flag: fall back to v0.4.x single-shot suggest (faster, cheaper, less thorough)
              if (opts.light) {
                const { suggestConfig, detectAmbiguousQueries } = await import('../lib/init/suggest.js');
                if (i === 0) console.log(`${c.dim}  [light mode] single-shot suggest — no brainstorm, no validation${c.reset}`);
                const s = await suggestConfig({
                  brand, domain, site, categoryDescription,
                  providerCall: (p, k, m) => primary.providerCall(p, k, m, { webSearch: false }),
                  apiKey: primary.apiKey, model: primary.model,
                  onAttempt: ({ estimate }) => console.log(`${c.dim}  Asking ${primary.label}... (~$${estimate.usd.toFixed(4)})${c.reset}`),
                });
                queries = s.queries;
                suggestionLang = s.language || site.lang;
                const ambiguous = detectAmbiguousQueries(queries);
                if (ambiguous.length > 0) {
                  console.log(`${c.yellow}  ⚠ ${ambiguous.length} ambiguous acronyms detected — consider --auto (full research) next time${c.reset}`);
                }
              } else {
                // Full research pipeline (v0.5 default)
                const { research } = await import('../lib/init/research/research.js');
                const { selectTopThree, formatSelection } = await import('../lib/init/research/select.js');

                if (i === 0) console.log(`${c.dim}  [full pipeline] brainstorm → filter → score → cross-model validate${c.reset}`);
                const t0 = Date.now();
                const researchResult = await research({
                  brand, domain, site, category: categoryDescription,
                  audienceTags, geoTags,
                  primary, validator,
                  logPhase: ({ phase, status, details }) => {
                    const parts = [`${c.dim}  [${phase}]`, status];
                    if (details?.count !== undefined) parts.push(`(${details.count})`);
                    if (details?.kept !== undefined) parts.push(`kept=${details.kept} rejected=${details.rejected}`);
                    if (details?.topScore !== undefined) parts.push(`topScore=${details.topScore}`);
                    if (details?.validator) parts.push(`via ${details.validator}`);
                    if (details?.passed !== undefined) parts.push(`passed=${details.passed} rejected=${details.rejected ?? details.failed}`);
                    if (details?.reason) parts.push(`— ${details.reason}`);
                    console.log(parts.join(' ') + c.reset);

                  },
                });
                const selectResult = selectTopThree(researchResult.candidates, { validationSkipped: !validator });
                const elapsed = Date.now() - t0;

                console.log(`\n${c.dim}  pipeline complete in ${elapsed}ms, est cost ~$${researchResult.trace.estimatedCostUsd.toFixed(4)}${c.reset}\n`);

                // Display selected + alternatives
                for (const line of formatSelection(selectResult)) console.log(line);

                const accept = (nonInteractive ? 'y' : (await ask(`\nAccept selected queries? [Y]es / [e]dit / [n]o: `, 'y'))).trim();
                if (/^e/i.test(accept)) {
                  const edited = [];
                  for (let j = 0; j < selectResult.selected.length; j++) {
                    const cand = selectResult.selected[j].candidate;
                    const v = (await ask(`  Q${j + 1} [${cand.text}]: `, cand.text)).trim();
                    edited.push(v || cand.text);
                  }
                  queries = edited;
                } else if (!/^n/i.test(accept)) {
                  queries = selectResult.selected.map(s => s.candidate.text);
                }

                // Persist candidate pool for future swap-without-LLM (D3)
                if (selectResult.alternatives.length > 0) {
                  config_candidatePool = selectResult.alternatives.slice(0, 5).map(a => ({
                    text: a.text, intent: a.intent, score: a.score,
                    unverified: !!a.unverified,
                  }));
                }
                suggestionLang = site.lang || 'en';
              }

              llmSucceeded = true;
              break;
            } catch (llmErr) {
              const classified = classifyProviderError(llmErr);
              attempts.push({
                provider: primary.name,
                label: primary.label,
                envVar: providerKey[primary.name] || null,
                rawError: errMsg(llmErr),
                classified,
              });

              if (!classified.retryable) {
                // Not a billing/auth/rate-limit issue — this is a real bug.
                // Surface the full context (which providers we tried first,
                // and why each failed) BEFORE rethrowing, so the user sees
                // the same actionable panel they'd see for all-retryable
                // failures — just followed by the raw bug for the developer
                // to file. Previously this block dropped `attempts` on the
                // floor and the user saw only the final TypeError.
                if (attempts.length > 1) {
                  for (const line of formatResearchFailurePanel({
                    attempts, brand, domain: fullUrl, useColor: USE_COLOR,
                  })) {
                    console.log(line);
                  }
                  console.log(`${c.dim}  The last attempt above (${primary.label}) failed with an unclassified error that's likely a bug in aeo-tracker. Raw message follows.${c.reset}`);
                  console.log('');
                }
                throw llmErr;
              }

              console.log(`${c.yellow}  ${primary.label} failed: ${classified.reason}${c.reset}`);
              if (i < researchProviders.length - 1) {
                console.log(`${c.dim}  Trying next provider in priority order...${c.reset}`);
              }
            }
          }

          if (!llmSucceeded) {
            // Every research provider returned a billing/auth/rate-limit error.
            // Show the actionable panel so the user has a copy-pastable path
            // to success instead of a bare "aborting" message.
            for (const line of formatResearchFailurePanel({
              attempts, brand, domain: fullUrl, useColor: USE_COLOR,
            })) {
              console.log(line);
            }
            if (nonInteractive) {
              console.error(`${c.red}Non-interactive mode — cannot prompt for manual input. Aborting.${c.reset}`);
              closeRl();
              process.exit(1);
            }
            console.log(`${c.dim}  Falling back to manual input.${c.reset}`);
          }
        } catch (err) {
          // Non-retryable errors from LLM loop (real bugs) OR errors from the
          // fetch/parse/category steps above. Both land here; we show the same
          // message, since it's a hard failure either way.
          console.log(`${c.yellow}  Auto-suggest failed: ${errMsg(err)}${c.reset}`);
          if (nonInteractive) {
            console.error(`${c.red}Cannot fall back to manual in non-interactive mode. Aborting.${c.reset}`);
            closeRl();
            process.exit(1);
          }
          console.log(`${c.dim}  Falling back to manual input.${c.reset}`);
        }
      }
    }
  }

  // Manual fallback
  if (queries.length === 0) {
    if (nonInteractive) {
      console.error(`${c.red}No queries — non-interactive --manual mode requires pre-configured queries (not yet supported via flags). Use --auto or drop --yes.${c.reset}`);
      closeRl();
      process.exit(1);
    }
    console.log(`\n${c.bold}Enter 3 unbranded test queries:${c.reset}`);
    console.log(`${c.dim}  Templates:${c.reset}`);
    console.log(`${c.dim}    Commercial:    "best <your category> 2026"${c.reset}`);
    console.log(`${c.dim}    Informational: "how to <problem you solve>"${c.reset}`);
    console.log(`${c.dim}    Vertical:      "<your category> for <audience>"${c.reset}`);
    for (let i = 1; i <= 3; i++) {
      const label = i === 1 ? 'commercial' : i === 2 ? 'informational' : 'vertical';
      const q = (await ask(`  Q${i} (${label}): `, '')).trim();
      if (q) queries.push(q);
    }
  }
  closeRl();

  // P0.2: final queries guard
  if (queries.length !== 3) {
    console.error(`${c.red}Error: need exactly 3 queries, got ${queries.length}. Aborting without saving config.${c.reset}`);
    process.exit(1);
  }

  // Two-stage validation (static acronym + LLM industry-fit). Single shared helper —
  // see lib/init/research/run-validation.js. Cache written to config below so `run`
  // can trust verdicts without re-paying $0.005 on every invocation.
  const validationProviders = await buildResearchProviders(providerKey);
  const _geoForValidation = (typeof geoTags !== 'undefined' && geoTags) ? geoTags : detectGeography(domain, {});
  const validation = await runValidationFlow({
    queries,
    brand, domain,
    category: categoryDescription,
    geography: _geoForValidation,
    primary: validationProviders.primary,
    secondary: validationProviders.validator,
    validationCache: [], // fresh config — no prior cache
    nonInteractive,
    force: opts.force,
    strictValidation: opts.strictValidation,
  });

  // P1.3: MODELS from single source of truth
  const MODELS = Object.fromEntries(
    Object.entries(DEFAULT_CONFIG.providers).map(([k, v]) => [k, v.model])
  );
  const providers = {};
  for (const [p, envName] of Object.entries(providerKey)) {
    providers[p] = { model: MODELS[p], env: envName };
  }

  const config = { brand, domain, category: categoryDescription || '', queries, regressionThreshold: 10, providers };
  if (config_candidatePool.length > 0) {
    config.candidatePool = config_candidatePool;
  }
  // Persist validation verdicts so `run` can trust them without re-paying per invocation.
  if (validation?.updatedCache?.length > 0) {
    config.validationCache = validation.updatedCache;
  }

  // D2: atomic write
  const tmpPath = CONFIG_FILE + '.tmp';
  await writeFile(tmpPath, JSON.stringify(config, null, 2));
  const { rename } = await import('node:fs/promises');
  await rename(tmpPath, CONFIG_FILE);

  console.log(`\n${c.green}✓ Created ${CONFIG_FILE}${c.reset}`);
  console.log(`  Brand: ${brand} | Domain: ${domain}`);
  console.log(`  Queries: ${queries.length}, Providers: ${Object.keys(providers).length}`);
  console.log(`\nNext: ${c.cyan}aeo-tracker run${c.reset}\n`);
}

// Maps model ID prefixes to short display labels. More specific entries first.
const MODEL_SHORT_LABELS = [
  [/^gpt-5-search-api/,          'gpt/5-search'],
  [/^gpt-5\.(\d+)-(mini|nano|pro)/, (_, v, t) => `gpt/5.${v}-${t}`],
  [/^gpt-5\.(\d+)/,              (_, v) => `gpt/5.${v}`],
  [/^gpt-5-(mini|nano)/,         (_, t) => `gpt/5-${t}`],
  [/^gpt-5/,                     'gpt/5'],
  [/^gpt-4o-(mini|search)/,      (_, t) => `gpt/4o-${t}`],
  [/^gpt-4o/,                    'gpt/4o'],
  [/^gpt-/,                      'gpt/'],
  [/^claude-(haiku|sonnet|opus)/, (_, t) => `claude/${t}`],
  [/^gemini-(\d+\.\d+)-(pro|flash)/, (_, v, t) => `gemini/${v}-${t}`],
  [/^gemini-(\d+\.\d+)/,         (_, v) => `gemini/${v}`],
  [/^sonar-(reasoning-pro|pro)/,  (_, t) => `sonar/${t}`],
  [/^sonar/,                     'sonar'],
];

function _modelColLabel(provider, modelId) {
  const clean = modelId
    .replace(/-preview$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '');
  for (const [pattern, label] of MODEL_SHORT_LABELS) {
    if (pattern.test(clean)) {
      return typeof label === 'function' ? clean.replace(pattern, label) : label;
    }
  }
  return `${provider}/${clean}`;
}

async function cmdRun(options = {}) {
  const silent = options.json === true;
  const origLog = console.log;
  const origWrite = process.stdout.write.bind(process.stdout);
  if (silent) {
    console.log = () => {};
    process.stdout.write = () => true;
  }

  // Load config
  if (!existsSync(CONFIG_FILE)) {
    console.error(`${c.red}No ${CONFIG_FILE} found. Run: aeo-tracker init${c.reset}`);
    process.exit(1);
  }

  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
  const { brand, domain, queries, providers: providerConfig } = config;

  if (!brand || !domain || !queries?.length) {
    console.error(`${c.red}Invalid config. brand, domain, and queries are required.${c.reset}`);
    process.exit(1);
  }

  // Discover current search-capable models for each configured provider
  console.log(`\n${c.dim}Discovering current models…${c.reset}`);
  const activeProviders = [];
  for (const [name, cfg] of Object.entries(providerConfig || DEFAULT_CONFIG.providers)) {
    const envKey = cfg.env || `${name.toUpperCase()}_API_KEY`;
    const apiKey = process.env[envKey];
    if (!apiKey) {
      console.log(`${c.dim}  skip ${name} — no ${envKey}${c.reset}`);
      continue;
    }
    const discovered = await discoverModels(name, apiKey, cfg.baseURL);
    const models = discovered ?? (cfg.model ? [cfg.model] : null);
    if (!models || models.length === 0) {
      console.log(`${c.dim}  skip ${name} — no models discovered${c.reset}`);
      continue;
    }
    console.log(`  ${c.green}✓${c.reset} ${name}: ${models.join(', ')}`);
    for (const modelId of models) {
      activeProviders.push({ name, model: modelId, colLabel: _modelColLabel(name, modelId), apiKey, ...PROVIDERS[name] });
    }
  }

  if (activeProviders.length === 0) {
    console.error(`${c.red}No API keys found. Set at least one: OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY, or PERPLEXITY_API_KEY${c.reset}`);
    process.exit(1);
  }

  const date = new Date().toISOString().split('T')[0];
  const responseDir = join('aeo-responses', date);
  await mkdir(responseDir, { recursive: true });

  console.log(`\n${c.bold}@webappski/aeo-tracker — run${c.reset}`);
  console.log(`${c.dim}Brand: ${brand} | Domain: ${domain} | Date: ${date}${c.reset}`);
  console.log(`${c.dim}Models: ${activeProviders.map(p => p.colLabel).join(', ')}${c.reset}`);
  console.log(`${c.dim}Queries: ${queries.length}${c.reset}\n`);

  // Pre-flight: two-stage validation with cache lookup.
  // Cache-hit (validated at init) → trust, no LLM cost.
  // Cache-miss (user hand-edited .aeo-tracker.json) → auto-run LLM validator inline
  // with visible cost, abort if any query fails. --force skips the whole gate.
  {
    const runProviders = await buildResearchProviders(Object.fromEntries(
      Object.entries(providerConfig || {}).map(([name, cfg]) => [name, cfg.env || `${name.toUpperCase()}_API_KEY`])
    ));
    await runValidationFlow({
      queries,
      brand, domain,
      category: config.category || '',
      geography: [], // run-time has no site context; cache usually covers this
      primary: runProviders.primary,
      secondary: runProviders.validator,
      validationCache: config.validationCache || [],
      nonInteractive: true,       // run is always "CI-like" — no interactive prompt during API spend
      force: options.force,
      strictValidation: options.strictValidation,
    });
  }

  // Resolve two-model competitor-extraction providers. Hard-fails if either key
  // is missing (see buildExtractionProviders). Done up-front so the user sees the
  // error BEFORE any paid API calls are made.
  let extractionProviders;
  try {
    extractionProviders = await buildExtractionProviders(providerConfig);
  } catch (err) {
    console.error(`\n${c.red}✗ ${errMsg(err)}${c.reset}`);
    process.exit(1);
  }
  console.log(`${c.dim}  Extractor: ${extractionProviders.primary.model} + ${extractionProviders.secondary.model} (parallel cross-check)${c.reset}\n`);

  // Load today's existing _summary.json — skip checks that already succeeded
  const summaryPath = join(responseDir, '_summary.json');
  let existingSummary = null;
  const skipKeys = new Set();
  if (existsSync(summaryPath)) {
    try {
      existingSummary = JSON.parse(await readFile(summaryPath, 'utf-8'));
      for (const r of existingSummary.results || []) {
        if (r.mention !== 'error') skipKeys.add(`${r.query}:${r.provider}:${r.model}`);
      }
    } catch { /* corrupt file — run fresh */ }
  }
  if (skipKeys.size > 0) {
    console.log(`${c.dim}  ${skipKeys.size} check${skipKeys.size !== 1 ? 's' : ''} already succeeded today — retrying only errors${c.reset}\n`);
  }

  // Replay mode (see replay-mode block at top of file)
  let replaySrcDate = null;
  if (options.replay) {
    replaySrcDate = await _resolveReplaySource(options.replayFrom);
    if (!replaySrcDate) {
      console.error(`${c.red}--replay: no prior aeo-responses/YYYY-MM-DD folder found${c.reset}`);
      process.exit(1);
    }
    console.log(`${c.yellow}  [replay] serving cached responses from aeo-responses/${replaySrcDate}/${c.reset}\n`);
  }
  // End replay

  // Run all checks in parallel
  const results = [];
  const tasks = [];
  // Extraction cost accumulates across all cells (each cell fires two LLM calls).
  const extractionCostTotal = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  for (let qi = 0; qi < queries.length; qi++) {
    const query = queries[qi];
    for (const provider of activeProviders) {
      tasks.push((async () => {
        const tag = `Q${qi + 1}/${provider.colLabel}`;
        const skipKey = `Q${qi + 1}:${provider.name}:${provider.model}`;
        if (skipKeys.has(skipKey)) return;
        const t0 = Date.now();
        try {
          process.stdout.write(`${c.dim}  Running ${tag}...${c.reset}`);
          // Replay mode (see replay-mode block at top of file)
          const replayed = replaySrcDate ? await _tryReplay(qi + 1, provider, replaySrcDate) : null;
          // End replay
          const { text, citations, raw } = replayed
            || await provider.call(query, provider.apiKey, provider.model);
          const elapsedMs = Date.now() - t0;

          // Save raw response
          const safeModel = provider.model.replace(/[^a-z0-9.-]/gi, '-');
          const rawFile = join(responseDir, `q${qi + 1}-${provider.name}-${safeModel}.json`);
          await writeFile(rawFile, JSON.stringify(raw, null, 2));

          const mention = detectMention(text, citations, brand, domain);
          const position = mention === 'yes' ? findPosition(text, brand, domain) : null;
          // Two-model LLM extraction. "competitors" = both models agreed (strong signal).
          // "competitorsUnverified" = only one model agreed (weaker — rendered with dashed badge).
          const extraction = await extractWithTwoModels({
            text, brand, domain,
            category: config.category || '',
            primary: extractionProviders.primary,
            secondary: extractionProviders.secondary,
          });
          const competitors = extraction.verified;
          const competitorsUnverified = extraction.unverified;
          const canonicalCitations = [...new Set(citations)];
          // Categorise the response so the UI can distinguish "engine refused / returned nothing"
          // from "engine wrote prose but no extractable list". The extraction union (verified +
          // unverified) is the full set of names either model saw — best signal for quality.
          const responseQuality = classifyResponseQuality({
            text, citations,
            competitors: [...competitors, ...competitorsUnverified],
          });

          const usage = extractUsage(provider.name, raw);
          let costInfo = calcCost(provider.model, usage) || { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: 0 };
          // Replay mode (see replay-mode block at top of file)
          if (replayed) costInfo = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
          // End replay

          // Extraction cost for this cell — tracked separately so we can report it
          // aggregated at the bottom instead of per-cell.
          extractionCostTotal.inputTokens  += extraction.costInfo.inputTokens  || 0;
          extractionCostTotal.outputTokens += extraction.costInfo.outputTokens || 0;
          extractionCostTotal.costUsd      += extraction.costInfo.costUsd      || 0;

          // Store per-model extractionSources ONLY when the two models disagreed
          // (something landed in the unverified tier). On unanimous agreement both
          // source-lists equal `competitors`, so storing them is redundant and bloats
          // the summary JSON ~3× across a year of weekly snapshots.
          const storeSources = competitorsUnverified.length > 0
            || !!extraction.sources.primary?.error
            || !!extraction.sources.secondary?.error;
          results.push({
            query: `Q${qi + 1}`,
            queryText: query,
            provider: provider.name,
            label: provider.label,
            model: provider.model,
            mention,
            position,
            citationCount: citations.length,
            canonicalCitations,
            competitors,
            competitorsUnverified,
            ...(storeSources ? { extractionSources: extraction.sources } : {}),
            responseQuality,
            hasBrandInCitations: citations.some(u =>
              u.toLowerCase().includes(domain.toLowerCase())
            ),
            responseExcerpt: String(text || '').slice(0, 1500),
            elapsedMs,
            inputTokens: costInfo.inputTokens,
            outputTokens: costInfo.outputTokens,
            costUsd: costInfo.costUsd,
          });
          const icon = mention === 'yes' ? `${c.green}YES` : mention === 'src' ? `${c.yellow}SRC` : `${c.red}NO`;
          const costStr = costInfo.costUsd > 0 ? ` $${costInfo.costUsd.toFixed(4)}` : '';
          // Replay mode (see replay-mode block at top of file)
          const replayTag = replayed ? ` ${c.yellow}[replay]${c.reset}` : '';
          // End replay
          process.stdout.write(`\r  ${icon}${c.reset} ${tag}${replayTag} (${citations.length} citations, ${elapsedMs}ms${costStr})\n`);
        } catch (err) {
          const elapsedMs = Date.now() - t0;
          process.stdout.write(`\r  ${c.red}ERR${c.reset} ${tag}: ${errMsg(err)}\n`);
          results.push({
            query: `Q${qi + 1}`, queryText: query,
            provider: provider.name, label: provider.label,
            model: provider.model, mention: 'error',
            position: null, citationCount: 0,
            canonicalCitations: [],
            competitors: [],
            elapsedMs,
            error: errMsg(err),
          });
        }
      })());
    }
  }

  await Promise.all(tasks);

  // Merge newly-run results with successful results carried over from prior run today
  if (existingSummary) {
    const keptOld = (existingSummary.results || []).filter(r => r.mention !== 'error');
    results.push(...keptOld);
  }

  // ─── Summary ───
  const total = results.filter(r => r.mention !== 'error').length;
  const mentions = results.filter(r => r.mention === 'yes' || r.mention === 'src').length;
  const score = total > 0 ? Math.round((mentions / total) * 100) : 0;
  const errors = results.filter(r => r.mention === 'error').length;

  console.log(`\n${c.bold}${'═'.repeat(60)}${c.reset}`);
  console.log(`${c.bold}  AEO VISIBILITY REPORT — ${brand}${c.reset}`);
  console.log(`${c.bold}${'═'.repeat(60)}${c.reset}\n`);

  // Per-query table
  const colW = 16;
  console.log(`${c.bold}  Query                                      ${activeProviders.map(p => p.colLabel.slice(0, colW - 1).padEnd(colW)).join('')}${c.reset}`);
  console.log(`  ${'─'.repeat(44)}${activeProviders.map(() => '─'.repeat(colW)).join('')}`);

  for (let qi = 0; qi < queries.length; qi++) {
    const label = `Q${qi + 1}: ${queries[qi].slice(0, 40)}`;
    const cells = activeProviders.map(p => {
      const r = results.find(r => r.query === `Q${qi + 1}` && r.provider === p.name && r.model === p.model);
      if (!r) return c.dim + 'skip'.padEnd(colW) + c.reset;
      if (r.mention === 'yes') return c.green + c.bold + 'YES'.padEnd(colW) + c.reset;
      if (r.mention === 'src') return c.yellow + 'SRC'.padEnd(colW) + c.reset;
      if (r.mention === 'error') return c.red + 'ERR'.padEnd(colW) + c.reset;
      return c.red + 'no'.padEnd(colW) + c.reset;
    });
    console.log(`  ${label.padEnd(44)}${cells.join('')}`);
  }

  console.log(`\n${c.bold}  Score: ${score}%${c.reset} (${mentions}/${total} checks returned a mention)`);
  if (errors > 0) console.log(`  ${c.yellow}${errors} checks failed (API errors)${c.reset}`);

  // Aggregate per-cell LLM-extracted brand lists. Both models agreed → r.competitors
  // (strong). Only one agreed → r.competitorsUnverified (weaker, dashed badge).
  // No aggregate classifier step needed — filtering happened at extract time.
  const verifiedCounts = {};
  const unverifiedCounts = {};
  for (const r of results) {
    for (const name of r.competitors || [])            verifiedCounts[name]   = (verifiedCounts[name]   || 0) + 1;
    for (const name of r.competitorsUnverified || [])  unverifiedCounts[name] = (unverifiedCounts[name] || 0) + 1;
  }
  const classifiedCompetitors = Object.entries(verifiedCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  // Unverified entries that were never verified in ANY cell — surfaced separately
  // in stdout and stored in summary for audit.
  const verifiedSet = new Set(Object.keys(verifiedCounts));
  const unverifiedOnlyEntries = Object.entries(unverifiedCounts)
    .filter(([name]) => !verifiedSet.has(name))
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  const classificationCostInfo = extractionCostTotal.costUsd > 0 ? {
    provider: `${extractionProviders.primary.name}+${extractionProviders.secondary.name}`,
    model:    `${extractionProviders.primary.model}+${extractionProviders.secondary.model}`,
    label:    'competitor-extraction',
    requests: results.length * 2,
    inputTokens:  extractionCostTotal.inputTokens,
    outputTokens: extractionCostTotal.outputTokens,
    costUsd:      extractionCostTotal.costUsd,
  } : null;
  console.log(`${c.dim}  Extraction: ${Object.keys(verifiedCounts).length} brands verified (both models), ${unverifiedOnlyEntries.length} unverified (one model only) — $${extractionCostTotal.costUsd.toFixed(4)}${c.reset}`);

  if (classifiedCompetitors.length > 0) {
    console.log(`\n${c.bold}  Top competitors mentioned instead:${c.reset}`);
    for (const [name, count] of classifiedCompetitors) {
      console.log(`    ${c.cyan}${name}${c.reset} (${count} checks)`);
    }
  }

  // Audit log: unverified-only names (exactly one model found them). Useful for
  // spotting model disagreements — if a known brand keeps landing here, one of the
  // extractor models has a systematic blind spot worth investigating.
  if (unverifiedOnlyEntries.length > 0) {
    console.log(`\n${c.dim}  Unverified (only one of two models found):${c.reset}`);
    for (const { name, count } of unverifiedOnlyEntries.slice(0, 10)) {
      console.log(`    ${c.dim}- ${name}  (${count} cell${count !== 1 ? 's' : ''})${c.reset}`);
    }
    if (unverifiedOnlyEntries.length > 10) {
      console.log(`    ${c.dim}(+ ${unverifiedOnlyEntries.length - 10} more — see _summary.json)${c.reset}`);
    }
  }

  // Canonical sources (URLs AI engines keep citing for our vertical)
  const sourceMap = {};
  for (const r of results) {
    for (const url of (r.canonicalCitations || [])) {
      sourceMap[url] = (sourceMap[url] || 0) + 1;
    }
  }
  const topCanonicalSources = Object.entries(sourceMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([url, count]) => ({ url, count }));

  if (topCanonicalSources.length > 0) {
    console.log(`\n${c.bold}  Top canonical sources (pages AI cites for your vertical):${c.reset}`);
    for (const { url, count } of topCanonicalSources.slice(0, 5)) {
      const short = url.length > 80 ? url.slice(0, 77) + '...' : url;
      console.log(`    ${c.dim}${count}×${c.reset} ${short}`);
    }
    if (topCanonicalSources.length > 5) {
      console.log(`    ${c.dim}(${topCanonicalSources.length - 5} more in _summary.json)${c.reset}`);
    }
  }

  console.log(`\n${c.dim}  Raw responses saved to: ${responseDir}/${c.reset}`);
  console.log(`${c.dim}  Run weekly for trends. Full methodology: webappski.com/blog/aeo-visibility-challenge-week-1${c.reset}\n`);

  const regressionThreshold = typeof config.regressionThreshold === 'number' ? config.regressionThreshold : 10;

  // Session cost breakdown
  const costMap = {};
  for (const r of results) {
    if (!r.costUsd) continue;
    const key = `${r.provider}/${r.model}`;
    if (!costMap[key]) costMap[key] = { provider: r.provider, model: r.model, label: r.label || r.provider, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    costMap[key].requests++;
    costMap[key].inputTokens  += r.inputTokens  || 0;
    costMap[key].outputTokens += r.outputTokens || 0;
    costMap[key].costUsd      += r.costUsd      || 0;
  }
  const costByModel = Object.values(costMap);
  if (classificationCostInfo) costByModel.push(classificationCostInfo);
  const sessionCostUsd = Math.round(costByModel.reduce((s, v) => s + v.costUsd, 0) * 1_000_000) / 1_000_000;

  if (sessionCostUsd > 0) {
    console.log(`\n${c.bold}  Session cost: $${sessionCostUsd.toFixed(4)}${c.reset}`);
    for (const m of costByModel) {
      console.log(`    ${c.dim}${m.model}${c.reset}  ${m.inputTokens + m.outputTokens} tok  $${m.costUsd.toFixed(4)}`);
    }
  }

  // Save summary JSON
  const summary = {
    date,
    brand,
    domain,
    score,
    mentions,
    total,
    errors,
    regressionThreshold,
    sessionCostUsd,
    costByModel,
    results: results.map(({ raw, ...r }) => r),
    topCompetitors: classifiedCompetitors.map(([name, count]) => ({ name, count })),
    // Unverified-only tier: names where only one of the two extractor models agreed.
    // Aggregated here for audit logs / dashboards — per-cell info is in results[].competitorsUnverified.
    unverifiedOnly: unverifiedOnlyEntries,
    topCanonicalSources,
  };
  await writeFile(join(responseDir, '_summary.json'), JSON.stringify(summary, null, 2));

  // ─── Exit code decision ───
  // 0 = score stable or improved
  // 1 = score dropped more than regressionThreshold (default 10pp)
  // 2 = all checks returned zero mentions
  // 3 = all providers errored
  let previousScore = null;
  try {
    const { readdirSync } = await import('node:fs');
    const allDates = readdirSync('aeo-responses')
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < date)
      .sort();
    const prevDate = allDates[allDates.length - 1];
    if (prevDate) {
      const prev = JSON.parse(await readFile(join('aeo-responses', prevDate, '_summary.json'), 'utf-8'));
      if (typeof prev.score === 'number') previousScore = prev.score;
    }
  } catch {
    // no previous data — first run
  }

  let exitCode;
  if (results.length > 0 && errors === results.length) {
    exitCode = 3;
  } else if (mentions === 0) {
    exitCode = 2;
  } else if (previousScore !== null && score - previousScore < -regressionThreshold) {
    exitCode = 1;
  } else {
    exitCode = 0;
  }

  // Exit code 3: every engine returned mention === 'error'. Show the
  // actionable panel so the user has copy-pastable fixes instead of exiting
  // silently with just a non-zero status code. Skipped in --json mode
  // because JSON consumers parse stdout programmatically — the exitCode +
  // per-result .error fields in the JSON already tell them everything.
  if (exitCode === 3 && !silent) {
    const errorResults = results.filter(r => r.mention === 'error');
    for (const line of formatAllEnginesFailedPanel({
      errorResults,
      providerConfig: config.providers || {},
      useColor: USE_COLOR,
    })) {
      console.error(line);
    }
  }

  if (silent) {
    console.log = origLog;
    process.stdout.write = origWrite;
    const jsonOut = {
      ...summary,
      exitCode,
      previousScore,
      scoreDelta: previousScore !== null ? score - previousScore : null,
    };
    origWrite(JSON.stringify(jsonOut, null, 2) + '\n');
  }

  process.exit(exitCode);
}


// ─── HTML report helpers ───


function buildHtmlSummary(snapshots, rawResponses) {
  const latest = snapshots[snapshots.length - 1];
  const prev = snapshots.length > 1 ? snapshots[snapshots.length - 2] : null;
  const brand = latest.brand || '';
  const domain = latest.domain || '';

  // Unique, ordered query list (Q1…Qn from the latest run)
  const queryOrder = [];
  for (const r of latest.results) {
    if (!queryOrder.find(q => q.id === r.query)) {
      queryOrder.push({ id: r.query, text: r.queryText || r.query });
    }
  }

  // Unique engines, one column per provider (deduplicated by provider only)
  const engineList = [];
  for (const r of latest.results) {
    if (!engineList.find(e => e.provider === r.provider)) {
      engineList.push({ provider: r.provider, label: r.label || r.provider, model: r.model || '' });
    }
  }

  // Per-engine visibility + delta + tiny trend series (per provider+model)
  const engines = engineList.map(en => {
    const rows = latest.results.filter(r => r.provider === en.provider && r.model === en.model);
    const hits = rows.filter(r => r.mention === 'yes' || r.mention === 'src').length;
    const total = rows.length;
    const pct = total ? Math.round((hits / total) * 100) : 0;
    const cells = queryOrder.map(q => {
      const c = rows.find(r => r.query === q.id);
      if (!c) return 'missing';
      if (c.mention === 'error' && c.error) return { status: 'error', message: c.error };
      return c.mention;
    });
    const series = snapshots.map(s => {
      const er = (s.results || []).filter(r => r.provider === en.provider && r.model === en.model);
      const h = er.filter(r => r.mention === 'yes' || r.mention === 'src').length;
      return er.length ? Math.round((h / er.length) * 100) : 0;
    });
    const prevPct = prev ? (function () {
      const pr = (prev.results || []).filter(r => r.provider === en.provider && r.model === en.model);
      const h = pr.filter(r => r.mention === 'yes' || r.mention === 'src').length;
      return pr.length ? Math.round((h / pr.length) * 100) : null;
    })() : null;
    const delta = prevPct == null ? null : pct - prevPct;
    return {
      provider: en.provider, model: en.model,
      label: en.label, kind: en.model,
      cells, pct, hits, total, delta, series,
    };
  });

  // Coverage buckets for the hero mini-bar
  const coverage = latest.results.reduce((acc, r) => {
    acc.total += 1;
    if (r.mention === 'yes')        acc.yes += 1;
    else if (r.mention === 'src')   acc.src += 1;
    else if (r.mention === 'error') acc.error += 1;
    else                            acc.no += 1;
    return acc;
  }, { yes: 0, src: 0, no: 0, error: 0, total: 0 });

  // Competitors
  const compList = latest.topCompetitors || [];
  const competitors = [
    { name: domain, count: coverage.yes + coverage.src, accent: true },
    ...compList.map(c => ({ name: c.name, count: c.count })),
  ];

  // Canonical sources — flag rows whose host matches our domain
  const sources = (latest.topCanonicalSources || []).slice(0, 10).map(s => ({
    url: s.url,
    count: s.count,
    accent: s.url.toLowerCase().includes(domain.toLowerCase()),
  }));

  const actions = latest.llmActions || [];

  // Per-cell verified/unverified brands come straight from the two-model LLM extractor:
  //   r.competitors            — both models agreed (strong signal, solid badge)
  //   r.competitorsUnverified  — only one model agreed (weaker signal, dashed badge)
  // Legacy summaries (pre-two-model extractor) had a single "competitors" list —
  // those still render, just without the unverified tier.
  const positionMatrix = queryOrder.map(q => {
    const columns = engineList.map(en => {
      const r = latest.results.find(x => x.query === q.id && x.provider === en.provider);
      const verifiedCells  = (r?.competitors           || []).map(name => ({ name, unverified: false }));
      const unverifiedCells = (r?.competitorsUnverified || []).map(name => ({ name, unverified: true  }));
      return {
        provider: en.provider,
        label: en.label,
        mention: r?.mention ?? 'missing',
        position: r?.position ?? null,
        competitors: [...verifiedCells, ...unverifiedCells].slice(0, 4),
        responseExcerpt: r?.responseExcerpt ?? null,
        responseQuality: r?.responseQuality ?? null,
      };
    });
    return { query: q.text, columns };
  });

  // Cost data from latest run
  const costBreakdown = latest.costByModel || [];
  const sessionCostUsd = latest.sessionCostUsd || 0;
  const costTrend = snapshots.map(s => Math.round((s.sessionCostUsd || 0) * 10000) / 10000);
  const totalCostUsd = Math.round(costTrend.reduce((s, v) => s + v, 0) * 1_000_000) / 1_000_000;

  return {
    meta: {
      brand, domain,
      date: latest.date,
      prevDate: prev?.date || null,
      runId: `run_${latest.date.replace(/-/g, '').slice(-6)}`,
      queryCount: queryOrder.length,
      providerCount: engineList.length,
    },
    score: latest.score,
    scorePrev: prev?.score ?? null,
    coverage,
    trend: snapshots.map(s => s.score),
    queries: queryOrder.map(q => q.text),
    engines,
    competitors,
    sources,
    positionMatrix,
    sessionCostUsd,
    totalCostUsd,
    costBreakdown,
    costTrend,
    quotes: [],
    citationOnly: [],
    actions,
  };
}

// ─── Commands (report) ───

async function cmdReport(args = {}) {
  const { readdirSync } = await import('node:fs');
  const responsesDir = 'aeo-responses';

  if (!existsSync(responsesDir)) {
    console.error(`${c.red}No aeo-responses/ directory found. Run: aeo-tracker run${c.reset}`);
    process.exit(1);
  }

  const dates = readdirSync(responsesDir)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();

  const snapshots = [];
  for (const date of dates) {
    const p = join(responsesDir, date, '_summary.json');
    if (existsSync(p)) snapshots.push(JSON.parse(await readFile(p, 'utf-8')));
  }

  if (snapshots.length === 0) {
    console.error(`${c.red}No _summary.json files found in aeo-responses/. Run: aeo-tracker run${c.reset}`);
    process.exit(1);
  }

  const latest = snapshots[snapshots.length - 1];
  const rawResponses = {};
  for (const r of latest.results) {
    const qi = String(r.query).replace(/^Q/, '');
    const key = `${r.query}|${r.provider}`;
    try {
      if (r.source === 'manual-paste') {
        const txtPath = join(responsesDir, latest.date, `q${qi}-${r.provider}-manual.txt`);
        if (existsSync(txtPath)) rawResponses[key] = await readFile(txtPath, 'utf-8');
      } else {
        const jsonPath = join(responsesDir, latest.date, `q${qi}-${r.provider}.json`);
        if (existsSync(jsonPath)) {
          const raw = JSON.parse(await readFile(jsonPath, 'utf-8'));
          rawResponses[key] = parseRawResponse(r.provider, raw);
        }
      }
    } catch {
      // raw missing or malformed — skip; sections degrade gracefully
    }
  }

  // ─── Citation classification (LLM-based, cached) ───
  // Classify top cited domains against brand's category. Universal — works for any
  // language or country. Result cached in _summary.json; costs $0 on subsequent runs.
  if (!latest.citationClassification && (latest.topCanonicalSources || []).length > 0) {
    let cfg = {};
    let cfgReadError = null;
    try {
      cfg = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
    } catch (err) {
      cfgReadError = err;
    }

    const brand = latest.brand || cfg.brand || '';
    const category = cfg.category || '';
    const providersCfg = { ...DEFAULT_CONFIG.providers, ...(cfg.providers || {}) };

    if (cfgReadError) {
      console.log(`  ${c.dim}Citation classification skipped: could not read ${CONFIG_FILE} (${errMsg(cfgReadError)})${c.reset}`);
    } else if (!category) {
      console.log(`  ${c.dim}Citation classification skipped: no category in ${CONFIG_FILE}. Re-run: aeo-tracker init${c.reset}`);
    } else {
      // Pick first provider with an available API key
      const providerEntry = Object.entries(providersCfg).find(([, p]) => process.env[p.env]);

      if (!providerEntry) {
        console.log(`  ${c.dim}Citation classification skipped: no API key found in environment${c.reset}`);
      } else {
        const [providerKey, providerCfg] = providerEntry;
        const providerCall = PROVIDERS[providerKey]?.call;
        if (providerCall) {
          console.log(`  ${c.dim}Classifying citations via ${PROVIDERS[providerKey].label}...${c.reset}`);
          try {
            const classification = await classifyCitations({
              brand, category,
              topCanonicalSources: latest.topCanonicalSources,
              providerCall,
              apiKey: process.env[providerCfg.env],
              model: providerCfg.model,
            });
            latest.citationClassification = classification;
            // Atomic write — avoids partial writes and race conditions
            const summaryPath = join('aeo-responses', latest.date, '_summary.json');
            const tmpPath = summaryPath + '.tmp-' + Date.now();
            await writeFile(tmpPath, JSON.stringify(latest, null, 2));
            const { rename } = await import('node:fs/promises');
            await rename(tmpPath, summaryPath);
            const off = classification.offCategoryDomains.length;
            if (off > 0) {
              console.log(`  ${c.yellow}⚠ ${off} cited domain${off !== 1 ? 's' : ''} classified as off-category${c.reset}`);
            } else {
              console.log(`  ${c.green}✓ All cited domains match brand category${c.reset}`);
            }
          } catch (err) {
            console.log(`  ${c.dim}Citation classification skipped: ${errMsg(err)}${c.reset}`);
            if (process.env.DEBUG) console.error(err.stack);
          }
        }
      }
    }
  } else if (latest.citationClassification) {
    console.log(`  ${c.dim}Citation classification loaded from cache${c.reset}`);
  }

  // ─── LLM action recommendations (cached) ───
  if (!latest.llmActions) {
    let cfg = {};
    try { cfg = JSON.parse(await readFile(CONFIG_FILE, 'utf-8')); } catch { /* skip */ }
    const category = cfg.category || '';
    const providersCfg = { ...DEFAULT_CONFIG.providers, ...(cfg.providers || {}) };
    const providerEntry = Object.entries(providersCfg).find(([, p]) => process.env[p.env]);
    if (providerEntry && category) {
      const [providerKey, providerCfg] = providerEntry;
      const providerCall = PROVIDERS[providerKey]?.call;
      if (providerCall) {
        const prev = snapshots.length > 1 ? snapshots[snapshots.length - 2] : null;
        console.log(`  ${c.dim}Generating recommendations via ${PROVIDERS[providerKey].label}...${c.reset}`);
        try {
          const { actions, costInfo } = await deriveActionsWithLLM(latest, prev, category, {
            providerName: providerKey,
            providerCall,
            apiKey: process.env[providerCfg.env],
            model: SUGGEST_MODELS[providerKey] || providerCfg.model,
          });
          latest.llmActions = actions;
          if (!latest.costByModel) latest.costByModel = [];
          latest.costByModel.push(costInfo);
          latest.sessionCostUsd = Math.round(
            (latest.costByModel.reduce((s, v) => s + (v.costUsd || 0), 0)) * 1_000_000
          ) / 1_000_000;
          const summaryPath = join('aeo-responses', latest.date, '_summary.json');
          const tmpPath = summaryPath + '.tmp-' + Date.now();
          await writeFile(tmpPath, JSON.stringify(latest, null, 2));
          const { rename } = await import('node:fs/promises');
          await rename(tmpPath, summaryPath);
          console.log(`  ${c.green}✓ ${actions.length} recommendations generated${c.reset}`);
        } catch (err) {
          console.log(`  ${c.yellow}⚠ Recommendations skipped: ${errMsg(err)}${c.reset}`);
        }
      }
    }
  } else {
    console.log(`  ${c.dim}Recommendations loaded from cache${c.reset}`);
  }

  const md = renderMarkdown(snapshots, rawResponses);

  const outDir = join('aeo-reports', latest.date);
  await mkdir(outDir, { recursive: true });
  const outPath = args.output || join(outDir, 'report.md');
  await writeFile(outPath, md);

  // v0.6 — HTML sibling output (zero runtime JS, Google Fonts via CDN)
  let htmlOutPath = null;
  if (args.html) {
    htmlOutPath = args.output
      ? args.output.replace(/\.md$/, '') + '.html'
      : join(outDir, 'report.html');
    const html = renderHtml(buildHtmlSummary(snapshots, rawResponses));
    await writeFile(htmlOutPath, html);
  }

  const loadedQuotes = Object.keys(rawResponses).length;
  console.log(`\n${c.bold}@webappski/aeo-tracker — report${c.reset}`);
  console.log(`  ${snapshots.length} run${snapshots.length !== 1 ? 's' : ''} loaded (${snapshots[0].date} → ${latest.date})`);
  console.log(`  ${loadedQuotes} raw response${loadedQuotes !== 1 ? 's' : ''} available for verbatim quotes`);
  console.log(`  Latest score: ${c.bold}${latest.score}%${c.reset}`);
  console.log(`\n${c.green}Report written: ${outPath}${c.reset}`);
  if (htmlOutPath) console.log(`${c.green}HTML report:   ${htmlOutPath}${c.reset}`);

  if (args.noOpen) {
    console.log(`${c.dim}(browser open skipped — pass without --no-open to open automatically)${c.reset}\n`);
  } else if (htmlOutPath) {
    const { execSync } = await import('node:child_process');
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    execSync(`${opener} "${htmlOutPath}"`);
    console.log(`${c.green}Opened in browser: ${htmlOutPath}${c.reset}\n`);
  } else {
    await cmdPreview({ input: outPath });
  }

  process.exit(0);
}

// ─── Commands (preview) ───

async function cmdPreview(args = {}) {
  const responsesDir = 'aeo-responses';
  if (!existsSync(responsesDir)) {
    console.error(`${c.red}No aeo-responses/ found. Run: aeo-tracker run && aeo-tracker report${c.reset}`);
    process.exit(1);
  }

  const { readdirSync } = await import('node:fs');
  const dates = readdirSync(responsesDir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const latest = dates[dates.length - 1];
  if (!latest) {
    console.error(`${c.red}No runs found.${c.reset}`);
    process.exit(1);
  }

  // Find or generate report.md
  const reportPath = args.input || join('aeo-reports', latest, 'report.md');
  if (!existsSync(reportPath)) {
    console.log(`${c.yellow}No report.md found — generating...${c.reset}`);
    await cmdReport({});
  }

  const markdownContent = await readFile(reportPath, 'utf-8');

  // Embed markdown as JSON string — handles all escaping automatically
  const mdJson = JSON.stringify(markdownContent);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>AEO Report — ${latest}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=Fraunces:opsz,wght@9..144,700;9..144,900&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/marked@9/marked.min.js"><\/script>
<style>
/* AEO Report — Status Board (Variant B)
   4 zones: STATUS | ENGINES + ACTIONS | DETAILS
   Each zone answers one question. Scan in <10s. */
:root{
  --bg:#e8e8e2; --white:#fff; --c2:#f4f4f0; --c3:#ebebea;
  --ink:#111110; --t2:#5f5f58; --t3:#9f9f96;
  --line:#ddddd4; --lines:#c4c4bc;
  --amber:#d97706; --amberBg:#fffbeb; --amberLine:#fde68a;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{background:var(--bg)}
body{
  font-family:"DM Sans",system-ui,-apple-system,sans-serif;
  font-size:15px;line-height:1.65;color:var(--ink);
  background:var(--bg);min-height:100vh;padding:0 16px 80px;
  -webkit-font-smoothing:antialiased;animation:fi .3s ease both;
}
@keyframes fi{from{opacity:0}to{opacity:1}}
#root{
  max-width:960px;margin:0 auto;background:var(--white);
  box-shadow:0 0 0 1px rgba(0,0,0,.07),0 8px 32px rgba(0,0,0,.1);
  border-radius:8px;overflow:hidden;
}

/* Zone 1 — Status banner */
.z-status{display:flex;align-items:center;gap:40px;padding:32px 48px;color:#fff;flex-wrap:wrap}
.z-status__score{
  font-family:"Fraunces",Georgia,serif;font-weight:900;
  font-size:clamp(5rem,13vw,8.5rem);line-height:.9;letter-spacing:-.05em;
  color:rgba(255,255,255,.95);flex-shrink:0;
  animation:sup .55s cubic-bezier(.2,.8,.2,1) both;
}
@keyframes sup{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}
.z-status{animation:zoneIn .42s ease both}
.z-row{animation:zoneIn .42s ease .07s both}
.report-body{animation:zoneIn .42s ease .14s both}
@keyframes zoneIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.z-status__meta{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}
.z-status__label{
  font-family:"JetBrains Mono",monospace;font-size:.95rem;font-weight:700;
  letter-spacing:.2em;text-transform:uppercase;color:#fff;margin-bottom:4px;
}
.z-status__brand{font-size:.92rem;color:rgba(255,255,255,.92);font-weight:600}
.z-status__dates{font-family:"JetBrains Mono",monospace;font-size:.66rem;color:rgba(255,255,255,.5);letter-spacing:.02em}
.z-status__trend-badge{
  display:inline-flex;align-items:center;gap:5px;margin-top:8px;
  background:rgba(0,0,0,.2);border-radius:3px;padding:4px 9px;
  font-family:"JetBrains Mono",monospace;font-size:.68rem;font-weight:600;
  color:rgba(255,255,255,.9);letter-spacing:.02em;width:fit-content;
}
.z-status__pct{font-size:.45em;vertical-align:.12em;font-weight:700;opacity:.75;letter-spacing:0}

/* Engine pills bar */
.z-engines-bar{
  display:grid;grid-template-columns:20% 80%;align-items:start;
  background:var(--white);
  border-top:1px solid var(--line);border-bottom:1px solid var(--line);
}
.z-engines-bar__left{
  padding:16px 24px 16px 48px;border-right:1px solid var(--line);
  display:flex;flex-direction:column;gap:8px;
}
.z-engines-bar__right{
  padding:16px 28px 16px 28px;
  display:flex;flex-direction:column;gap:8px;
}
.z-engines-bar__lbl,.z-queries-lbl{
  font-family:"JetBrains Mono",monospace;font-size:1rem;font-weight:700;
  letter-spacing:.06em;text-transform:uppercase;color:var(--t2);
}
.z-engines-bar__pills{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.z-queries-list{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.z-query-pill{
  display:inline-flex;align-items:center;
  padding:3px 10px;border:1.5px solid var(--lines);border-radius:6px;
  background:var(--c3);font-size:.82rem;color:var(--ink);font-weight:500;
}
/* Fix 1 — engine pill: same radius 6px, unified language */
.z-engine-pill{
  display:inline-flex;align-items:center;gap:5px;
  padding:3px 9px 3px 4px;border:1.5px solid var(--lines);border-radius:6px;
  background:var(--c3);
}
.z-engine-pill__av{
  width:18px;height:18px;border-radius:4px;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;
  font-family:"JetBrains Mono",monospace;font-size:.56rem;font-weight:700;color:#fff;
}
/* Fix 2 — engine name heavier than value */
.z-engine-pill__name{font-size:.8rem;font-weight:600;color:var(--ink)}
.z-engine-pill__val{font-family:"JetBrains Mono",monospace;font-size:.72rem;font-weight:700;margin-left:2px}

/* Actions — full width */
.z-section-title--amber{
  font-family:"JetBrains Mono",monospace;font-size:.70rem;font-weight:700;
  text-transform:uppercase;letter-spacing:.12em;
  color:#92400e;background:var(--amberBg);border-bottom:1px solid var(--amberLine);
  padding:12px 48px 10px;
}

/* Actions */
.z-actions{background:var(--amberBg)}
.z-action-list{list-style:none;padding:0;margin:0}
.z-action-item{
  display:flex;align-items:flex-start;gap:10px;padding:14px 48px;
  border-bottom:1px solid var(--amberLine);
}
.z-action-item:last-child{border-bottom:none}
.z-action-item::before{content:"→";color:var(--amber);font-family:"JetBrains Mono",monospace;font-weight:700;flex-shrink:0;line-height:1.55;}
.z-action-item input{display:none}
.z-action-main{flex:1;min-width:0}
.z-action-label{font-size:.84rem;line-height:1.5;color:var(--ink)}
.z-action-label strong{color:#78350f;font-weight:600}
.z-action-label code{background:#fde68a;color:#78350f;font-size:.78em;padding:1px 4px;border-radius:2px;font-family:"JetBrains Mono",monospace}
.z-action-label a{color:var(--amber)}
.z-action-item em{display:block;margin-top:4px;color:#92400e;font-style:normal;font-size:.77rem;line-height:1.5}
.z-action-time{font-family:"JetBrains Mono",monospace;font-size:.62rem;font-weight:700;background:rgba(120,53,15,.18);border-radius:2px;padding:2px 7px;color:#78350f;white-space:nowrap;flex-shrink:0;align-self:flex-start;margin-top:2px}

/* Zone 4 — Details */
.report-body{padding:0 48px 64px;background:var(--white)}
@media(max-width:580px){.report-body{padding:0 20px 48px}}
.report-body h2{
  font-family:"JetBrains Mono",monospace;font-size:.72rem;font-weight:700;
  letter-spacing:.12em;text-transform:uppercase;color:var(--t2);
  margin:48px 0 14px;border:none;background:none;padding:0 0 9px;
  border-bottom:1px solid var(--line);
}
.report-body h3{font-size:.95rem;font-weight:700;color:var(--ink);margin:22px 0 7px;letter-spacing:-.01em}
.report-body p{margin:10px 0}
.report-body em{color:var(--t2);font-style:italic}
.report-body strong{color:var(--ink);font-weight:600}
.report-body a{color:var(--amber);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}
.report-body ul,.report-body ol{padding-left:20px;margin:8px 0}
.report-body li{margin:4px 0}
.report-body code{font-family:"JetBrains Mono",monospace;font-size:.82em;background:var(--c2);color:var(--ink);padding:2px 6px;border-radius:3px}
.report-body pre{font-family:"JetBrains Mono",monospace;font-size:.78rem;line-height:1.55;background:var(--c2);color:var(--ink);border:1px solid var(--line);border-radius:4px;padding:14px 18px;overflow-x:auto;margin:14px 0}
.report-body pre code{background:none;padding:0}

/* Bloomberg tables */
.report-body table{width:100%;border-collapse:collapse;margin:14px 0;font-size:.86rem;font-variant-numeric:tabular-nums lining-nums;background:transparent;border-radius:0}
.report-body thead{border-top:1.5px solid var(--ink);border-bottom:1px solid var(--lines)}
.report-body th{background:transparent!important;background-image:none!important;color:var(--ink)!important;padding:9px 14px!important;text-align:left!important;font-family:"JetBrains Mono",monospace!important;font-size:.62rem!important;font-weight:700!important;letter-spacing:.1em!important;text-transform:uppercase!important;border:none!important;white-space:nowrap!important}
.report-body td{padding:10px 14px!important;background:transparent!important;border:none!important;border-bottom:1px solid var(--line)!important;vertical-align:top!important;color:var(--ink)!important}
.report-body tbody tr:last-child td{border-bottom:1.5px solid var(--ink)!important}
.report-body tbody tr:nth-child(even) td{background:var(--c2)!important}
.report-body tbody tr:hover td{background:var(--line)!important;transition:background .1s}
.report-body hr{border:none;border-top:1px solid var(--line);margin:44px 0 18px}

/* Blockquote */
.report-body blockquote{border-left:2px solid var(--amber);padding:10px 16px;margin:14px 0;background:#fffbeb;color:var(--t2);border-radius:0}
.report-body blockquote p{margin:0;font-size:.92rem}
.report-body blockquote strong{color:var(--ink)}

/* Warning */
.report-body .warning{background:#fff7ed!important;border:1px solid #fed7aa!important;border-radius:4px!important;padding:14px 18px!important;margin:16px 0!important;box-shadow:none!important}
.report-body .warning h2{margin-top:0!important;border:none!important}

/* Score cards — hidden (shown in dashboard instead) */
.report-body .score-cards,.report-body h2[data-zone="metrics"]{display:none!important}

/* Engine action cards */
.report-body .engine-actions{display:grid!important;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))!important;gap:10px!important;margin:14px 0!important}
.report-body .ea-card{background:var(--c2)!important;border:1px solid var(--line)!important;border-left:3px solid!important;border-radius:4px!important;padding:15px 17px!important;box-shadow:none!important;transform:none!important;transition:background .12s!important}
.report-body .ea-card:hover{background:var(--line)!important}
.report-body .ea-card--urgent{background:#fff7ed!important}
.report-body .ea-header{display:flex!important;align-items:center!important;gap:8px!important;margin-bottom:9px!important}
.report-body .ea-name{font-weight:600!important;font-size:.88rem!important;color:var(--ink)!important}
.report-body .ea-badge{font-family:"JetBrains Mono",monospace!important;font-size:.61rem!important;font-weight:700!important;padding:2px 6px!important;border-radius:3px!important;margin-left:auto!important;letter-spacing:.06em!important;text-transform:uppercase!important}
.report-body .ea-why{font-size:.8rem!important;color:var(--t2)!important;margin:0 0 9px!important;line-height:1.5!important}
.report-body .ea-tips{padding-left:17px!important;margin:0!important}
.report-body .ea-tips li{font-size:.8rem!important;margin:4px 0!important;color:var(--ink)!important}

/* SVG charts */
.report-body svg{max-width:100%;height:auto;display:block;margin:14px 0}
.report-body li svg{display:inline-block!important;margin:0 6px -3px!important;vertical-align:middle!important}
.report-body svg text[fill="#0f172a"]{fill:var(--ink)!important}
.report-body svg text[fill="#475569"]{fill:var(--t2)!important}
.report-body svg text[fill="#64748b"]{fill:var(--t3)!important}
.report-body svg rect[fill="#475569"]{fill:var(--t2)!important}

/* Competitor table overrides */
.report-body div[style*="overflow-x:auto"]{margin:14px 0!important}
.report-body div[style*="overflow-x:auto"]>table{border-top:1.5px solid var(--ink)!important;border-collapse:collapse!important;border-radius:0!important;box-shadow:none!important;background:transparent!important}
.report-body div[style*="overflow-x:auto"] th{background:transparent!important;background-image:none!important;color:var(--ink)!important;padding:9px 14px!important;font-family:"JetBrains Mono",monospace!important;font-size:.61rem!important;font-weight:700!important;letter-spacing:.1em!important;text-transform:uppercase!important;border:none!important;white-space:nowrap!important}
.report-body div[style*="overflow-x:auto"] td{background:transparent!important;border-bottom:1px solid var(--line)!important;border-left:none!important;border-right:none!important;border-top:none!important;padding:10px 14px!important;vertical-align:top!important;font-size:.84rem!important;color:var(--ink)!important}
.report-body div[style*="overflow-x:auto"] tbody tr:nth-child(even) td{background:var(--c2)!important}
.report-body div[style*="overflow-x:auto"] tbody tr:last-child td{border-bottom:1.5px solid var(--ink)!important}
.report-body div[style*="overflow-x:auto"] td[style*="#fff9f9"]{background:#fff7ed!important;box-shadow:inset 2px 0 0 #dc2626!important}
.report-body div[style*="overflow-x:auto"] span[style*="#fee2e2"]{background:transparent!important;color:#dc2626!important;border:none!important;padding:0!important}
.report-body div[style*="overflow-x:auto"] span[style*="#9f1239"],.report-body div[style*="overflow-x:auto"] span[style*="fecdd3"],.report-body div[style*="overflow-x:auto"] span[style*="#fff0f0"]{background:transparent!important;color:#dc2626!important;border:1px solid rgba(220,38,38,.35)!important;border-radius:3px!important;font-family:"JetBrains Mono",monospace!important;font-size:.67rem!important;font-weight:500!important;padding:1px 5px!important}

/* Footer */
.report-body hr+p,.report-body p:last-child{font-family:"JetBrains Mono",monospace;font-size:.66rem;color:var(--t3);letter-spacing:.04em;margin-top:10px}
.report-body hr+p em{font-style:normal}
.report-body hr+p code{background:transparent;color:var(--t2);padding:0}

@media print{body{background:#fff!important}}
</style>
</head>
<body>
<div id="root"></div>
<script>
  const md = ${mdJson};
  marked.setOptions({ gfm: true, breaks: false });
  document.getElementById('root').innerHTML = marked.parse(md);

  // Original warning logic — unchanged
  document.querySelectorAll('h2').forEach(function(h) {
    if (h.textContent.indexOf('\u26a0') !== -1) {
      var sec = document.createElement('div');
      sec.className = 'warning';
      var node = h.nextSibling, sib = [];
      while (node && node.tagName !== 'H2' && node.tagName !== 'H1') {
        sib.push(node); node = node.nextSibling;
      }
      h.parentNode.insertBefore(sec, h);
      sec.appendChild(h);
      sib.forEach(function(s){ sec.appendChild(s); });
    }
  });

  // Dashboard restructure
  (function(){
    var root = document.getElementById('root');
    var h1s = root.querySelectorAll('h1');
    var pageH1 = h1s[0], heroH1 = h1s[1];
    var score = heroH1 ? (parseInt(heroH1.textContent) || 0) : 0;

    var titleTxt = pageH1 ? pageH1.textContent : '';
    var bm = titleTxt.match(/AEO Report\s*[\u2014\-]+\s*(.+)$/);
    var brand = bm ? bm[1].trim() : titleTxt;

    var metaEl = pageH1 && pageH1.nextElementSibling && pageH1.nextElementSibling.tagName === 'P'
                 ? pageH1.nextElementSibling : null;
    var metaTxt = metaEl ? metaEl.textContent.trim() : '';

    var trendTxt = '';
    if (heroH1 && heroH1.nextElementSibling && heroH1.nextElementSibling.tagName === 'P')
      trendTxt = heroH1.nextElementSibling.textContent.trim();

    var focusTxt = '';
    if (heroH1) {
      var fn = heroH1.nextElementSibling;
      while (fn && fn.tagName !== 'H2') {
        if (fn.tagName === 'BLOCKQUOTE') { focusTxt = fn.textContent.trim(); break; }
        fn = fn.nextElementSibling;
      }
    }

    var tlBg = score>=60?'#059669':score>=25?'#d97706':score>=1?'#ea580c':'#dc2626';
    var tlLbl = score>=60?'STRONG':score>=25?'PRESENT':score>=1?'EMERGING':'INVISIBLE';

    // Engine data — only X/Y cards (engines), skip Overall percentage card
    var AVATAR_MAP={'ChatGPT':'GP','Gemini':'GE','Claude':'CL','Perplexity':'PP','OpenAI':'OA'};
    var engines = [];
    root.querySelectorAll('.sc').forEach(function(card){
      var lbl=card.querySelector('.sc-lbl'), val=card.querySelector('.sc-val'), sub=card.querySelector('.sc-sub');
      if(!lbl||!val) return;
      var name=lbl.textContent.trim(), value=val.textContent.trim(), color=val.style.color||tlBg, pct=0;
      if(value.indexOf('/')===-1) return; // skip Overall and non-engine cards
      var p=value.split('/'),h=parseInt(p[0])||0,t=parseInt(p[1])||1;
      pct=Math.round(h/t*100);
      engines.push({name:name,value:value,color:color,pct:pct,sub:sub?sub.textContent.trim():''});
    });

    // Actions
    var actItems=[], actH2=null;
    Array.from(root.querySelectorAll('h2')).forEach(function(h){
      if(/actions this week/i.test(h.textContent)) actH2=h;
    });
    if(actH2){
      var an=actH2.nextElementSibling;
      while(an && an.tagName!=='H2'){
        if(an.tagName==='UL'||an.tagName==='OL')
          Array.from(an.children).forEach(function(li){actItems.push(li.innerHTML);});
        an=an.nextElementSibling;
      }
    }

    function xe(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

    // Parse metaTxt into clean parts
    var domain='', dateRange='', runCount='';
    if(metaTxt){
      var dm=metaTxt.match(/\b([a-z0-9][a-z0-9.-]*\.[a-z]{2,6})\b/i);
      if(dm) domain=dm[1];
      var dtm=metaTxt.match(/(\d{4}-\d{2}-\d{2})\s*[\u2192>-]+\s*(\d{4}-\d{2}-\d{2})/);
      if(dtm) dateRange=dtm[1]+' \u2192 '+dtm[2];
      var rm=metaTxt.match(/(\d+)\s+runs?/i);
      if(rm) runCount=rm[1]+' runs';
    }

    // Parse trend into badge parts
    var trendBadge='';
    if(trendTxt){
      var tArr=trendTxt.split(/\s*\u00b7\s*/);
      var delta=tArr[0]?tArr[0].trim():'';
      var checks=tArr[1]?tArr[1].trim():'';
      trendBadge=(delta?xe(delta):'')+(checks?' \u00b7 '+xe(checks):'');
    }

    // Build Zone 1
    var metaLine=xe(brand)+(domain?' \u00b7 '+xe(domain):'');
    var datesLine=(dateRange?xe(dateRange):'')+((dateRange&&runCount)?' \u00b7 ':'')+xe(runCount);
    var z1='<div class="z-status" style="background:'+tlBg+'">'
      +'<div class="z-status__score">'+score+'<span class="z-status__pct">%</span></div>'
      +'<div class="z-status__meta">'
      +'<div class="z-status__label">'+xe(tlLbl)+'</div>'
      +'<div class="z-status__brand">'+metaLine+'</div>'
      +(datesLine.trim()?'<div class="z-status__dates">'+datesLine+'</div>':'')
      +(trendBadge?'<div class="z-status__trend-badge">'+trendBadge+'</div>':'')
      +'</div></div>';

    // Extract tested queries from DOM
    var queries=[];
    Array.from(root.querySelectorAll('h2')).forEach(function(h2){
      if(!/trend per query/i.test(h2.textContent)) return;
      var n=h2.nextElementSibling;
      while(n&&n.tagName!=='H2'){
        if(n.tagName==='UL'||n.tagName==='OL'){
          Array.from(n.querySelectorAll('li')).forEach(function(li){
            var clone=li.cloneNode(true);
            Array.from(clone.querySelectorAll('svg')).forEach(function(s){s.remove();});
            var txt=clone.textContent.trim().replace(/^[A-Z0-9]+:\s*/,'');
            if(txt) queries.push(txt);
          });
        }
        n=n.nextElementSibling;
      }
    });
    // Fallback: Competitor Intelligence table first column
    if(queries.length===0){
      Array.from(root.querySelectorAll('h2')).forEach(function(h2){
        if(!/competitor intelligence/i.test(h2.textContent)) return;
        var n=h2.nextElementSibling;
        while(n&&n.tagName!=='H2'){
          if(n.querySelectorAll){
            Array.from(n.querySelectorAll('tbody tr td:first-child')).forEach(function(td){
              var t=td.textContent.trim();
              if(t) queries.push(t);
            });
          }
          n=n.nextElementSibling;
        }
      });
    }

    // Build engine pills bar
    var hasQ=queries.length>0;
    var engBar='<div class="z-engines-bar">'
      +'<div class="z-engines-bar__left">'
      +'<span class="z-engines-bar__lbl">Coverage</span>'
      +'<div class="z-engines-bar__pills">';
    engines.forEach(function(e){
      var initials=AVATAR_MAP[e.name]||e.name.substring(0,2).toUpperCase();
      engBar+='<span class="z-engine-pill">'
        +'<span class="z-engine-pill__av" style="background:'+e.color+'">'+initials+'</span>'
        +'<span class="z-engine-pill__name">'+xe(e.name)+'</span>'
        +'<span class="z-engine-pill__val" style="color:'+e.color+'">'+xe(e.value)+'</span>'
        +'</span>';
    });
    engBar+='</div></div>'
      +'<div class="z-engines-bar__right">';
    if(hasQ){
      var qlbl='Checked against '+queries.length+' quer'+(queries.length===1?'y':'ies');
      engBar+='<span class="z-queries-lbl">'+qlbl+'</span>'
        +'<div class="z-queries-list">';
      queries.forEach(function(q){
        engBar+='<span class="z-query-pill">'+xe(q)+'</span>';
      });
      engBar+='</div>';
    }
    engBar+='</div></div>';

    // Build Zone 3 (actions)
    var z3='<div class="z-actions"><div class="z-section-title z-section-title--amber">\u26a1 Actions This Week</div><ul class="z-action-list">';
    if(actItems.length>0)
      actItems.slice(0,7).forEach(function(i){
        // Strip hidden checkbox
        var html=i.replace(/<input[^>]*>/g,'').trim();
        // Extract time estimate after em-dash
        var timeBadge='';
        var sep=' \u2014 ';
        var di=html.indexOf(sep);
        if(di!==-1){
          var after=html.slice(di+sep.length);
          if(after.charAt(0)==='~'){
            var ei=after.indexOf('<em');
            timeBadge=(ei===-1?after:after.slice(0,ei)).trim();
            html=html.slice(0,di)+(ei===-1?'':after.slice(ei));
          }
        }
        // Split label and description (em)
        var emStart=html.indexOf('<em');
        var labelPart=(emStart===-1?html:html.slice(0,emStart)).trim();
        var descPart=emStart===-1?'':html.slice(emStart);
        var timeHtml=timeBadge?'<span class="z-action-time">'+timeBadge+'</span>':'';
        z3+='<li class="z-action-item">'
          +'<div class="z-action-main">'
          +'<div class="z-action-label">'+labelPart+'</div>'
          +descPart
          +'</div>'
          +timeHtml
          +'</li>';
      });
    else z3+='<li class="z-action-item">No actions found — run a fresh report.</li>';
    z3+='</ul></div>';

    var dash=document.createElement('div');
    dash.id='dashboard';
    dash.innerHTML=z1+engBar+z3;
    root.insertBefore(dash, root.firstChild);

    // Hide replaced sections
    function hideBlock(pat){
      Array.from(root.querySelectorAll('h2,h3')).forEach(function(h){
        if(!pat.test(h.textContent)) return;
        h.style.display='none';
        var n=h.nextElementSibling;
        while(n && n.tagName!=='H2' && n.tagName!=='H1'){
          n.style.display='none'; n=n.nextElementSibling;
        }
      });
    }
    if(pageH1) pageH1.style.display='none';
    if(metaEl) metaEl.style.display='none';
    if(heroH1){
      heroH1.style.display='none';
      var hn=heroH1.nextElementSibling;
      while(hn && hn.tagName!=='H2'){hn.style.display='none';hn=hn.nextElementSibling;}
    }
    hideBlock(/your aeo visibility/i);
    hideBlock(/key metrics/i);
    hideBlock(/actions this week/i);
    hideBlock(/how your score compares/i);

    // Wrap remaining nodes in .report-body
    var body=document.createElement('div');
    body.className='report-body';
    Array.from(root.children).forEach(function(c){
      if(c.id!=='dashboard') body.appendChild(c);
    });
    root.appendChild(body);
  })();
<\/script>
</body>
</html>`;

  const { tmpdir } = await import('node:os');
  const htmlPath = join(tmpdir(), `aeo-report-${latest}.html`);
  await writeFile(htmlPath, html, 'utf-8');

  const { execSync } = await import('node:child_process');
  const opener = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  execSync(`${opener} "${htmlPath}"`);

  console.log(`\n${c.green}Opened in browser: ${htmlPath}${c.reset}\n`);
}

// ─── Commands (run-manual) ───

async function cmdRunManual(argv) {
  // Parse: aeo-tracker run-manual <provider> --from-dir <dir>
  let providerName = null;
  let fromDir = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from-dir' && argv[i + 1]) { fromDir = argv[i + 1]; i++; }
    else if (!argv[i].startsWith('--') && !providerName) { providerName = argv[i]; }
  }

  if (!providerName) {
    console.error(`${c.red}Usage: aeo-tracker run-manual <provider> --from-dir <dir>${c.reset}`);
    console.error(`${c.dim}Providers: ${Object.keys(PROVIDERS).join(', ')}${c.reset}`);
    process.exit(1);
  }
  if (!PROVIDERS[providerName]) {
    console.error(`${c.red}Unknown provider: ${providerName}${c.reset}`);
    console.error(`${c.dim}Valid: ${Object.keys(PROVIDERS).join(', ')}${c.reset}`);
    process.exit(1);
  }
  if (!fromDir || !existsSync(fromDir)) {
    console.error(`${c.red}--from-dir <dir> required; directory must exist and contain q1.txt, q2.txt, q3.txt${c.reset}`);
    process.exit(1);
  }
  if (!existsSync(CONFIG_FILE)) {
    console.error(`${c.red}No ${CONFIG_FILE} found. Run: aeo-tracker init${c.reset}`);
    process.exit(1);
  }

  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
  const { brand, domain, queries } = config;
  const providerCfg = (config.providers || DEFAULT_CONFIG.providers)[providerName] || PROVIDERS[providerName];
  const providerLabel = PROVIDERS[providerName].label;
  const modelUsed = providerCfg.model || 'manual';

  const date = new Date().toISOString().split('T')[0];
  const responseDir = join('aeo-responses', date);
  await mkdir(responseDir, { recursive: true });

  console.log(`\n${c.bold}@webappski/aeo-tracker — run-manual${c.reset}`);
  console.log(`${c.dim}Provider: ${providerLabel} | Source: ${fromDir}${c.reset}\n`);

  let extractionProvidersManual;
  try {
    extractionProvidersManual = await buildExtractionProviders(config.providers);
  } catch (err) {
    console.error(`\n${c.red}✗ ${errMsg(err)}${c.reset}`);
    process.exit(1);
  }
  console.log(`${c.dim}  Extractor: ${extractionProvidersManual.primary.model} + ${extractionProvidersManual.secondary.model} (parallel)${c.reset}\n`);

  const newResults = [];
  for (let qi = 0; qi < queries.length; qi++) {
    const query = queries[qi];
    const queryFile = join(fromDir, `q${qi + 1}.txt`);
    const tag = `Q${qi + 1}/${providerName}`;

    if (!existsSync(queryFile)) {
      console.log(`  ${c.dim}SKIP${c.reset} ${tag} (no ${queryFile})`);
      continue;
    }

    const text = await readFile(queryFile, 'utf-8');
    const citations = extractUrls(text);
    const mention = detectMention(text, citations, brand, domain);
    const position = mention === 'yes' ? findPosition(text, brand, domain) : null;
    const extractionManual = await extractWithTwoModels({
      text, brand, domain,
      category: config.category || '',
      primary:   extractionProvidersManual.primary,
      secondary: extractionProvidersManual.secondary,
    });
    const competitors           = extractionManual.verified;
    const competitorsUnverified = extractionManual.unverified;
    const canonicalCitations = [...new Set(citations)];
    const responseQuality = classifyResponseQuality({
      text, citations,
      competitors: [...competitors, ...competitorsUnverified],
    });

    // Save raw paste for audit
    const rawFile = join(responseDir, `q${qi + 1}-${providerName}-manual.txt`);
    await writeFile(rawFile, text);

    const storeManualSources = competitorsUnverified.length > 0
      || !!extractionManual.sources.primary?.error
      || !!extractionManual.sources.secondary?.error;
    newResults.push({
      query: `Q${qi + 1}`,
      queryText: query,
      provider: providerName,
      label: providerLabel,
      model: modelUsed,
      source: 'manual-paste',
      mention,
      position,
      citationCount: citations.length,
      canonicalCitations,
      competitors,
      competitorsUnverified,
      ...(storeManualSources ? { extractionSources: extractionManual.sources } : {}),
      responseQuality,
      hasBrandInCitations: citations.some(u => u.toLowerCase().includes(domain.toLowerCase())),
      elapsedMs: null,
    });

    const icon = mention === 'yes' ? `${c.green}YES` : mention === 'src' ? `${c.yellow}SRC` : `${c.red}NO`;
    console.log(`  ${icon}${c.reset} ${tag} (${citations.length} URLs extracted)`);
  }

  if (newResults.length === 0) {
    console.error(`\n${c.red}No query files found in ${fromDir}. Expected q1.txt, q2.txt, q3.txt${c.reset}`);
    process.exit(1);
  }

  // ─── Merge with existing _summary.json for today (if any) ───
  const summaryPath = join(responseDir, '_summary.json');
  let existing = null;
  if (existsSync(summaryPath)) {
    existing = JSON.parse(await readFile(summaryPath, 'utf-8'));
  }

  // Remove prior results for this provider (overwrite behaviour)
  const keptResults = (existing?.results || []).filter(r => r.provider !== providerName);
  const allResults = [...keptResults, ...newResults];

  // Recompute aggregates
  const total = allResults.filter(r => r.mention !== 'error').length;
  const mentions = allResults.filter(r => r.mention === 'yes' || r.mention === 'src').length;
  const score = total > 0 ? Math.round((mentions / total) * 100) : 0;
  const errors = allResults.filter(r => r.mention === 'error').length;

  const allCompetitors = {};
  for (const r of allResults) {
    for (const comp of (r.competitors || [])) allCompetitors[comp] = (allCompetitors[comp] || 0) + 1;
  }
  const sortedCompetitors = Object.entries(allCompetitors).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const sourceMap = {};
  for (const r of allResults) {
    for (const url of (r.canonicalCitations || [])) sourceMap[url] = (sourceMap[url] || 0) + 1;
  }
  const topCanonicalSources = Object.entries(sourceMap)
    .sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([url, count]) => ({ url, count }));

  const regressionThreshold = existing?.regressionThreshold
    ?? (typeof config.regressionThreshold === 'number' ? config.regressionThreshold : 10);

  const summary = {
    date,
    brand,
    domain,
    score,
    mentions,
    total,
    errors,
    regressionThreshold,
    results: allResults,
    topCompetitors: sortedCompetitors.map(([name, count]) => ({ name, count })),
    topCanonicalSources,
  };
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));

  console.log(`\n${c.bold}  Merged into: ${summaryPath}${c.reset}`);
  console.log(`  Score: ${c.bold}${score}%${c.reset} (${mentions}/${total} across ${new Set(allResults.map(r => r.provider)).size} providers)\n`);

  // Exit-code parity with `run` (README contract). run-manual doesn't call APIs,
  // so code 3 (all providers errored) is unreachable here.
  let previousScore = null;
  try {
    const { readdirSync } = await import('node:fs');
    const allDates = readdirSync('aeo-responses')
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < date)
      .sort();
    const prevDate = allDates[allDates.length - 1];
    if (prevDate) {
      const prev = JSON.parse(await readFile(join('aeo-responses', prevDate, '_summary.json'), 'utf-8'));
      if (typeof prev.score === 'number') previousScore = prev.score;
    }
  } catch { /* no previous run — first one */ }

  let exitCode;
  if (mentions === 0) exitCode = 2;
  else if (previousScore !== null && score - previousScore < -regressionThreshold) exitCode = 1;
  else exitCode = 0;

  process.exit(exitCode);
}

// ─── Commands (diff) ───

async function cmdDiff(argv) {
  const { readdirSync } = await import('node:fs');
  const responsesDir = 'aeo-responses';

  if (!existsSync(responsesDir)) {
    console.error(`${c.red}No aeo-responses/ directory found. Run: aeo-tracker run${c.reset}`);
    process.exit(1);
  }

  const allDates = readdirSync(responsesDir)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();

  // Parse args: aeo-tracker diff [dateA] [dateB] | --last N | --since DATE
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--last' && argv[i + 1]) { args.last = Number(argv[i + 1]); i++; }
    else if (argv[i] === '--since' && argv[i + 1]) { args.since = argv[i + 1]; i++; }
    else if (!argv[i].startsWith('--')) {
      if (!args.dateA) args.dateA = argv[i];
      else if (!args.dateB) args.dateB = argv[i];
    }
  }

  let dateA, dateB;
  if (args.last) {
    if (allDates.length < args.last) {
      console.error(`${c.yellow}Only ${allDates.length} runs found, need ${args.last}.${c.reset}`);
      process.exit(1);
    }
    dateA = allDates[allDates.length - args.last];
    dateB = allDates[allDates.length - 1];
  } else if (args.since) {
    dateA = args.since;
    dateB = allDates[allDates.length - 1];
  } else if (args.dateA && args.dateB) {
    dateA = args.dateA; dateB = args.dateB;
  } else {
    if (allDates.length < 2) {
      console.error(`${c.yellow}Need at least 2 runs to diff. Found ${allDates.length}.${c.reset}`);
      process.exit(1);
    }
    dateA = allDates[allDates.length - 2];
    dateB = allDates[allDates.length - 1];
  }

  const load = async (d) => {
    const p = join(responsesDir, d, '_summary.json');
    if (!existsSync(p)) throw new Error(`No _summary.json for ${d}`);
    return JSON.parse(await readFile(p, 'utf-8'));
  };

  let summaryA, summaryB;
  try {
    [summaryA, summaryB] = await Promise.all([load(dateA), load(dateB)]);
  } catch (err) {
    console.error(`${c.red}${errMsg(err)}${c.reset}`);
    process.exit(1);
  }

  const result = diff(summaryA, summaryB);

  console.log(`\n${c.bold}@webappski/aeo-tracker — diff${c.reset}`);
  console.log(`${c.dim}Brand: ${summaryA.brand}${c.reset}`);
  console.log(`${c.dim}From: ${dateA} — score ${summaryA.score}% (${summaryA.mentions}/${summaryA.total})${c.reset}`);
  console.log(`${c.dim}To:   ${dateB} — score ${summaryB.score}% (${summaryB.mentions}/${summaryB.total})${c.reset}`);
  const deltaColor = result.scoreDelta > 0 ? c.green : result.scoreDelta < 0 ? c.red : c.dim;
  const deltaSign = result.scoreDelta > 0 ? '+' : '';
  console.log(`${c.bold}Score delta: ${deltaColor}${deltaSign}${result.scoreDelta}pp${c.reset}\n`);

  if (result.cellChanges.length > 0) {
    console.log(`${c.bold}  Cell changes:${c.reset}`);
    for (const ch of result.cellChanges) {
      const gained = (ch.was === 'no' || ch.was === 'missing') && (ch.now === 'yes' || ch.now === 'src');
      const lost = (ch.was === 'yes' || ch.was === 'src') && (ch.now === 'no' || ch.now === 'missing');
      const arrow = gained ? `${c.green}↑ Gained${c.reset}` : lost ? `${c.red}↓ Lost  ${c.reset}` : `${c.yellow}~ Moved ${c.reset}`;
      console.log(`    ${arrow}  ${ch.provider.padEnd(10)} ${ch.query.padEnd(4)} ${String(ch.was).padEnd(7)} → ${ch.now}`);
    }
  } else {
    console.log(`${c.dim}  No cell changes between runs.${c.reset}`);
  }

  if (result.newCompetitors.length > 0) {
    console.log(`\n${c.bold}  New competitors:${c.reset}`);
    for (const { name, count } of result.newCompetitors) {
      console.log(`    ${c.cyan}+ ${name}${c.reset} (${count} mentions)`);
    }
  }
  if (result.lostCompetitors.length > 0) {
    console.log(`\n${c.bold}  Competitors that fell off:${c.reset}`);
    for (const { name, count } of result.lostCompetitors) {
      console.log(`    ${c.dim}- ${name} (was ${count})${c.reset}`);
    }
  }
  if (result.sourcesMovement.gained.length > 0) {
    console.log(`\n${c.bold}  New canonical sources:${c.reset}`);
    for (const { url, count } of result.sourcesMovement.gained.slice(0, 5)) {
      const short = url.length > 70 ? url.slice(0, 67) + '...' : url;
      console.log(`    ${c.green}+${c.reset} ${short} (${count}×)`);
    }
  }
  if (result.sourcesMovement.lost.length > 0) {
    console.log(`\n${c.bold}  Sources no longer cited:${c.reset}`);
    for (const { url, count } of result.sourcesMovement.lost.slice(0, 5)) {
      const short = url.length > 70 ? url.slice(0, 67) + '...' : url;
      console.log(`    ${c.dim}- ${short} (was ${count}×)${c.reset}`);
    }
  }
  console.log('');

  const regressionThreshold =
    summaryB.regressionThreshold ?? summaryA.regressionThreshold ?? 10;
  if (result.scoreDelta < -regressionThreshold) process.exit(1);
  process.exit(0);
}

// ─── CLI Entry ───

const HELP = `
${c.bold}@webappski/aeo-tracker${c.reset} — Track brand visibility in AI answer engines

${c.bold}Usage:${c.reset}
  aeo-tracker init                    Create .aeo-tracker.json config
  aeo-tracker init --queries-only     Re-suggest queries without changing brand/domain/providers
  aeo-tracker run          Run visibility audit (reads config, calls APIs)
  aeo-tracker run --json   Same, but print structured JSON to stdout (for CI pipelines)
  aeo-tracker run --replay [--replay-from=YYYY-MM-DD]
                           Replay mode — rebuild today's summary from cached raw responses
                           instead of calling APIs. Zero API cost. Useful for: iterating on
                           the report/parser locally, re-generating a summary with updated
                           extractor logic against historical data. Defaults to the most
                           recent captured snapshot unless --replay-from is given.
  aeo-tracker run-manual P --from-dir D   Import manual paste responses for provider P
                                          from directory D containing q1.txt, q2.txt, q3.txt
                                          (for engines without a usable API: Perplexity, Copilot,
                                          ChatGPT Pro UI, Claude.ai). Merges into today's summary.
  aeo-tracker diff A B     Compare two runs by date (YYYY-MM-DD); shows delta table
  aeo-tracker diff --last N       Compare the last N runs (default: 2)
  aeo-tracker diff --since DATE   Compare a date with the latest run
  aeo-tracker report       Generate markdown report with inline SVG charts and verbatim
                           AI quotes from all past runs. Output: aeo-reports/<date>/report.md
  aeo-tracker report --output path.md   Custom output path
  aeo-tracker report --html             Also emit report.html (single-file, offline-ready, zero runtime JS)
  aeo-tracker --help       Show this help
  aeo-tracker --version    Show version

${c.bold}Query validation:${c.reset}
  Queries are validated at init (static acronym + LLM industry-fit check). Verdicts are
  cached in .aeo-tracker.json so run doesn't re-pay. If you hand-edit queries, run will
  auto-validate the new ones inline (shows cost). Known failure mode: "AEO consultants
  Poland" means customs in Poland, not Answer Engine Optimization — always expand acronyms.
  ${c.bold}--force${c.reset}                Bypass validation gate (for research on cross-industry interpretation noise)
  ${c.bold}--strict-validation${c.reset}    Cross-check query validation with 2 LLM providers (unanimous approve OR flag as split).
                         2× validation cost. Use when reliability > latency (e.g. CI pipelines).

${c.bold}Exit codes (after run):${c.reset}
  0                        Score stable or improved
  1                        Score dropped more than regressionThreshold (default: 10pp vs previous run)
  2                        All checks returned zero mentions
  3                        All providers errored

${c.bold}Environment variables:${c.reset}
  ${c.bold}Required${c.reset} (both — for the two-model competitor extractor):
    OPENAI_API_KEY           OpenAI API key (ChatGPT column + extractor)
    GEMINI_API_KEY           Google AI API key (Gemini column + extractor)
  ${c.bold}Optional${c.reset} (each adds one engine column to the report):
    ANTHROPIC_API_KEY        Anthropic API key (Claude column)
    PERPLEXITY_API_KEY       Perplexity API key (Perplexity column)
  ${c.bold}Debug${c.reset}:
    AEO_DEBUG=1              Print raw stack traces alongside actionable panels
                             (for bug reports — see github.com/DVdmitry/aeo-tracker/issues)
    NO_COLOR=1               Strip ANSI escape codes from output (auto-detected
                             on non-TTY; set explicitly in CI logs if you see garbage)

${c.bold}Quick start:${c.reset}
  export OPENAI_API_KEY=sk-...        # required
  export GEMINI_API_KEY=AIza...       # required
  aeo-tracker init --yes --brand=X --domain=x.com --auto
  aeo-tracker run
  aeo-tracker report --html

${c.bold}About:${c.reset}
  Built by Webappski (https://webappski.com), an AEO agency.
  We use this tool ourselves for our public AEO Visibility Challenge.
  Read Week 1: webappski.com/blog/aeo-visibility-challenge-week-1

  Source: github.com/DVdmitry/aeo-tracker
  License: MIT
`;

const { values, positionals } = parseArgs({
  options: {
    help:    { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'v', default: false },
    yes:     { type: 'boolean', short: 'y', default: false },
    brand:   { type: 'string' },
    domain:  { type: 'string' },
    category:{ type: 'string' },
    auto:    { type: 'boolean', default: false },
    manual:  { type: 'boolean', default: false },
    light:   { type: 'boolean', default: false },
    keywords:{ type: 'string' },
    'queries-only': { type: 'boolean', default: false },
    output:  { type: 'string' },
    'no-open': { type: 'boolean', default: false },
    html:    { type: 'boolean', default: false },
    json:    { type: 'boolean', default: false },
    last:    { type: 'string' },
    since:   { type: 'string' },
    'from-dir': { type: 'string' },
    force:   { type: 'boolean', default: false },
    'strict-validation': { type: 'boolean', default: false },
    // Replay mode (see replay-mode block at top of file)
    replay:  { type: 'boolean', default: false },
    'replay-from': { type: 'string' },
    // End replay
  },
  allowPositionals: true,
  strict: false,
});
const command = positionals[0];

// Top-level dispatcher wrapped in try/catch. Any error that escapes the
// command-specific error handling (config corruption, filesystem issues,
// unclassified provider edge cases, real bugs) lands here — formatUnexpectedErrorPanel
// turns the raw stack into an actionable panel before exiting with code 1.
// Exceptions: process.exit() from inside a command won't trigger this catch
// (that's intentional — the command already handled its own exit).
try {
  if (values.help || (!command && !values.version)) {
    console.log(HELP);
  } else if (values.version) {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf-8'));
    console.log(pkg.version);
  } else if (command === 'init') {
    await cmdInit({ ...values, strictValidation: values['strict-validation'] });
  } else if (command === 'run') {
    await cmdRun({
      json: values.json,
      force: values.force,
      strictValidation: values['strict-validation'],
      // Replay mode (see replay-mode block at top of file)
      replay: values.replay,
      replayFrom: values['replay-from'],
      // End replay
    });
  } else if (command === 'run-manual') {
    await cmdRunManual(process.argv.slice(3));
  } else if (command === 'diff') {
    await cmdDiff(process.argv.slice(3));
  } else if (command === 'report') {
    await cmdReport({ output: values.output, noOpen: values['no-open'], html: values.html });
  } else if (command === 'preview') {
    await cmdPreview({ input: values.output });
  } else {
    console.error(`${c.red}Unknown command: ${command}${c.reset}`);
    console.log(HELP);
    process.exit(1);
  }
} catch (err) {
  for (const line of formatUnexpectedErrorPanel({ err, command, useColor: USE_COLOR })) {
    console.error(line);
  }
  // Emit raw stack to stderr for debugging when requested — keeps the panel
  // clean by default, but doesn't hide the stack from developers who need it.
  if (process.env.AEO_DEBUG === '1' && err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
}
