// Actionable error output for the case when every research provider in the
// PROVIDER_PRIORITY list failed (billing, auth, rate-limit) during init --auto.
//
// Philosophy: never leave the user at "auto-suggest failed, aborting" without a
// copy-pastable path to success. Three options in decreasing cost order:
//   1) Top-up (small money, no command changes) — preferred for most users
//   2) Skip brainstorm with --keywords (zero LLM cost) — works immediately
//   3) Unset the offending env var (same config, different provider) — fastest
//      when one provider is broken but the other two are fine

import { PROVIDER_BILLING_URLS } from '../providers/classify-error.js';
import { PROVIDER_LABELS } from './keys.js';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

/**
 * @typedef {Object} ProviderAttempt
 * @property {string} provider       'openai' | 'anthropic' | 'gemini'
 * @property {string} label          Display label, e.g. 'OpenAI (ChatGPT)'
 * @property {string|null} envVar    Env var name the key was read from
 * @property {string} rawError       Original provider error message
 * @property {{category:string,reason:string,retryable:boolean}} classified
 */

/**
 * Format the failure panel as an array of console lines. Kept pure (no direct
 * console.log) so tests can assert on exact output without stdout capture.
 *
 * @param {Object} opts
 * @param {ProviderAttempt[]} opts.attempts   Every provider tried + why it failed
 * @param {string} opts.brand                 For composing the copy-paste command
 * @param {string} opts.domain                Fully-qualified URL for the command
 * @param {boolean} opts.useColor             False for plain text (tests, CI logs)
 * @returns {string[]} lines ready for console.log
 */
export function formatResearchFailurePanel({ attempts, brand, domain, useColor = true }) {
  const c = useColor
    ? { red: RED, yellow: YELLOW, dim: DIM, bold: BOLD, reset: RESET }
    : { red: '', yellow: '', dim: '', bold: '', reset: '' };

  const lines = [];
  lines.push('');
  lines.push(`${c.red}${c.bold}  All research providers failed — init cannot brainstorm queries on its own.${c.reset}`);
  lines.push('');
  lines.push(`${c.bold}  Attempted (in priority order):${c.reset}`);

  for (const a of attempts) {
    const reason = a.classified?.reason || 'unknown error';
    lines.push(`    ${c.yellow}✗ ${a.label}${c.reset} — ${reason}`);
    if (a.rawError) {
      // Truncate very long error bodies to keep the panel readable.
      const shortErr = a.rawError.length > 160 ? a.rawError.slice(0, 160) + '...' : a.rawError;
      lines.push(`      ${c.dim}"${shortErr}"${c.reset}`);
    }
    if (a.envVar) {
      lines.push(`      ${c.dim}read from $${a.envVar}${c.reset}`);
    }
  }

  lines.push('');
  lines.push(`${c.bold}  How to fix — pick one:${c.reset}`);
  lines.push('');

  // Option 1: top up whichever provider the user prefers (target the cheapest
  // fix first). Show URLs only for providers we actually attempted — no point
  // pointing at Perplexity billing if Perplexity wasn't involved in init.
  const billingAttempts = attempts.filter(a => a.classified?.category === 'billing');
  if (billingAttempts.length > 0) {
    lines.push(`    ${c.bold}1.${c.reset} Top up billing on one of these providers (brainstorm costs ~$0.01):`);
    for (const a of billingAttempts) {
      const url = PROVIDER_BILLING_URLS[a.provider];
      if (url) lines.push(`         ${PROVIDER_LABELS[a.provider] || a.label}: ${url}`);
    }
    lines.push('');
  }

  // Option 2: skip the brainstorm entirely via --keywords. Works for everyone,
  // bypasses all LLMs, costs $0 at init time. This is the most reliable fallback.
  const optNum = billingAttempts.length > 0 ? '2' : '1';
  lines.push(`    ${c.bold}${optNum}.${c.reset} Skip brainstorm — provide 3-5 queries yourself (zero LLM cost):`);
  lines.push(`         ${c.dim}aeo-tracker init --yes \\${c.reset}`);
  lines.push(`         ${c.dim}  --brand=${brand} \\${c.reset}`);
  lines.push(`         ${c.dim}  --domain=${domain} \\${c.reset}`);
  lines.push(`         ${c.dim}  --keywords="query 1,query 2,query 3,query 4,query 5"${c.reset}`);
  lines.push('');

  // Option 3: unset the offending env var. Only helpful if user has 2+ keys and
  // one is broken — show command only when we have a known envVar to unset.
  const unsettable = attempts.find(a => a.envVar);
  if (unsettable && attempts.length > 1) {
    const nextNum = billingAttempts.length > 0 ? '3' : '2';
    lines.push(`    ${c.bold}${nextNum}.${c.reset} Hide the failing provider for this run (skip it in priority):`);
    lines.push(`         ${c.dim}env -u ${unsettable.envVar} aeo-tracker init --yes \\${c.reset}`);
    lines.push(`         ${c.dim}  --brand=${brand} --domain=${domain} --auto${c.reset}`);
    lines.push('');
  }

  return lines;
}
