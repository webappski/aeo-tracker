/**
 * Shared HTTP utility for free-API authority checkers (wikipedia, reddit,
 * github, hn, dev.to, npm). Extracted from authority-presence.js so adding
 * each new source doesn't copy-paste the AbortController boilerplate.
 *
 * Every authority source obeys the same contract: native `fetch`, timeout
 * via AbortController, identifying User-Agent so rate-limit blocks point
 * at us (not at "anonymous traffic"), JSON Accept header.
 */

export const FETCH_TIMEOUT_MS = 8000;
export const USER_AGENT = 'aeo-platform (https://github.com/webappski/aeo-platform)';

/**
 * Wraps native `fetch` with: timeout (AbortController), default JSON Accept,
 * project User-Agent. Caller can override any header. Returns the Response
 * (no auto-JSON parse — caller decides based on status).
 *
 * @param {string} url
 * @param {object} opts — passed through to fetch + optional `timeoutMs`
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json', ...(opts.headers || {}) },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}
