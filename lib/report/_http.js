/**
 * HTTP utility for free-API authority checkers (wikipedia, reddit, github,
 * hn, dev.to, npm). Thin wrapper around lib/util/fetch-with-timeout.js — that
 * module owns the timeout/signal mechanics; this file just adds the authority-
 * specific defaults (User-Agent identifying the project so rate-limit blocks
 * point at us, JSON Accept header).
 *
 * Public name `fetchWithTimeout` is preserved for backward compatibility with
 * authority-presence.js / authority-github.js imports.
 */

import { fetchWithTimeout as universalFetchWithTimeout } from '../util/fetch-with-timeout.js';

export const FETCH_TIMEOUT_MS = 8000;
export const USER_AGENT = 'aeo-platform (https://github.com/webappski/aeo-platform)';

/**
 * Wraps native `fetch` with: timeout (delegated to universal wrapper), default
 * JSON Accept, project User-Agent. Caller can override any header via opts.headers.
 * Returns the Response (no auto-JSON parse — caller decides based on status).
 *
 * @param {string} url
 * @param {object} opts — passed through to fetch + optional `timeoutMs`
 *                        (default 8s — short, since authority sources are
 *                        small JSON endpoints we don't want to wait on).
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, opts = {}) {
  const { timeoutMs, kind: _ignoredKind, ...fetchInit } = opts;
  return universalFetchWithTimeout(url, {
    ...fetchInit,
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json', ...(opts.headers || {}) },
  }, {
    // `??` (not `||`) so explicit `timeoutMs: 0` is preserved — universal
    // wrapper treats it as "disable timeout" via its own clamp.
    timeoutMs: timeoutMs ?? FETCH_TIMEOUT_MS,
    kind: 'site',
  });
}
