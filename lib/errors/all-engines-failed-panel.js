// Actionable output when every engine in `run` returned mention === 'error'.
// Distinct from research-failure-panel.js because:
//   - run has MULTIPLE queries × MULTIPLE engines, so we group by engine
//   - the user already has a valid .aeo-tracker.json; the fix is about
//     restoring access to engines, not reconfiguring queries
//   - skipping the run entirely (analog of --keywords in init) isn't an
//     option; instead we nudge toward fixing billing or removing engines

import { classifyProviderError, PROVIDER_BILLING_URLS } from '../providers/classify-error.js';
import { PROVIDER_LABELS } from '../init/keys.js';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

/**
 * Build the "all engines failed" panel.
 *
 * @param {Object} opts
 * @param {Array<{provider:string,label:string,model:string,error:string}>} opts.errorResults
 *   Subset of `results` where mention === 'error'. Same shape as summary.results.
 * @param {Object=} opts.providerConfig  From config.providers — gives env var names
 * @param {boolean} opts.useColor
 * @returns {string[]}  Lines ready for console.log
 */
export function formatAllEnginesFailedPanel({ errorResults, providerConfig = {}, useColor = true }) {
  const c = useColor
    ? { red: RED, yellow: YELLOW, dim: DIM, bold: BOLD, reset: RESET }
    : { red: '', yellow: '', dim: '', bold: '', reset: '' };

  // Group errors by (provider, model) — same engine likely fails the same way
  // across all queries, so we dedupe and show the most informative message.
  const grouped = new Map();
  for (const r of errorResults) {
    const key = `${r.provider}/${r.model}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        provider: r.provider,
        label: r.label || PROVIDER_LABELS[r.provider] || r.provider,
        model: r.model,
        count: 0,
        firstError: r.error || 'no error message',
        classified: classifyProviderError(new Error(r.error || '')),
      });
    }
    grouped.get(key).count++;
  }

  const byEngine = [...grouped.values()];
  const lines = [];

  lines.push('');
  lines.push(`${c.red}${c.bold}  All engines failed — no mentions could be recorded this run.${c.reset}`);
  lines.push('');
  lines.push(`${c.bold}  What broke (grouped by engine):${c.reset}`);

  for (const g of byEngine) {
    const reason = g.classified.reason;
    lines.push(`    ${c.yellow}✗ ${g.label}${c.reset} (${g.model}) — ${reason} · ${g.count} ${g.count === 1 ? 'query' : 'queries'} affected`);
    const shortErr = g.firstError.length > 160 ? g.firstError.slice(0, 160) + '...' : g.firstError;
    lines.push(`      ${c.dim}"${shortErr}"${c.reset}`);
    const envVar = providerConfig[g.provider]?.env;
    if (envVar) lines.push(`      ${c.dim}read from $${envVar}${c.reset}`);
  }

  lines.push('');
  lines.push(`${c.bold}  How to fix — pick one:${c.reset}`);
  lines.push('');

  // Option 1: top up billing for engines that hit billing errors.
  const billingEngines = byEngine.filter(g => g.classified.category === 'billing');
  if (billingEngines.length > 0) {
    lines.push(`    ${c.bold}1.${c.reset} Top up billing on the failed providers:`);
    for (const g of billingEngines) {
      const url = PROVIDER_BILLING_URLS[g.provider];
      if (url) lines.push(`         ${g.label}: ${url}`);
    }
    lines.push('');
  }

  // Option 2: regenerate keys for auth failures.
  const authEngines = byEngine.filter(g => g.classified.category === 'auth');
  if (authEngines.length > 0) {
    const n = billingEngines.length > 0 ? '2' : '1';
    lines.push(`    ${c.bold}${n}.${c.reset} Regenerate API keys for the failed providers (the old keys may be revoked or typo'd):`);
    for (const g of authEngines) {
      const envVar = providerConfig[g.provider]?.env;
      const hint = envVar ? ` (currently read from $${envVar})` : '';
      lines.push(`         ${g.label}${hint}`);
    }
    lines.push('');
  }

  // Option 3: wait + retry for rate-limits.
  const rateLimitedEngines = byEngine.filter(g => g.classified.category === 'rate-limit');
  if (rateLimitedEngines.length > 0) {
    const n = (billingEngines.length > 0 ? 1 : 0) + (authEngines.length > 0 ? 1 : 0) + 1;
    lines.push(`    ${c.bold}${n}.${c.reset} Wait 1-2 minutes and re-run — rate limits reset quickly:`);
    lines.push(`         ${c.dim}aeo-tracker run${c.reset}`);
    lines.push('');
  }

  // Option 4 (network/site-fetch): infrastructure issue. Rerun when restored.
  const infraEngines = byEngine.filter(g => ['network', 'site-fetch'].includes(g.classified.category));
  if (infraEngines.length > 0) {
    const n = (billingEngines.length > 0 ? 1 : 0) + (authEngines.length > 0 ? 1 : 0) + (rateLimitedEngines.length > 0 ? 1 : 0) + 1;
    lines.push(`    ${c.bold}${n}.${c.reset} Check your internet connection and retry — every engine reported a network-level failure:`);
    lines.push(`         ${c.dim}aeo-tracker run${c.reset}`);
    lines.push('');
  }

  // Always-on escape hatch: remove the offending engine from config.
  // If NONE of the above matched (all "other"), this is the only advice we can give.
  const optionN = 1 + (billingEngines.length > 0 ? 1 : 0) + (authEngines.length > 0 ? 1 : 0)
                    + (rateLimitedEngines.length > 0 ? 1 : 0) + (infraEngines.length > 0 ? 1 : 0);
  lines.push(`    ${c.bold}${optionN}.${c.reset} Temporarily remove a failing engine from .aeo-tracker.json (keep the others running):`);
  lines.push(`         ${c.dim}edit the "providers" section, delete the entry for the failing provider${c.reset}`);
  lines.push('');

  lines.push(`${c.dim}  No report was generated for this run — previous runs in aeo-responses/ are unaffected.${c.reset}`);

  return lines;
}
