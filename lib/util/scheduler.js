// Adaptive token-budget scheduler. Pre-plans task fire-times so a burst of
// parallel cells doesn't blast through the TPM ceiling.
//
// Why it exists: `await Promise.all(tasks)` fires N cells concurrently. With
// CONCURRENCY_LIMIT=2 and a small TPM window (e.g. OpenAI tier-1 6k TPM for
// search models), even 2 parallel ~2500-token calls eat 5000 tokens of the
// 6000 budget — and any 3rd cell hits 429 before tokens age out of the 60s
// window. The TPM ledger (Fix 3) catches this reactively, but a proactive
// scheduler is honest with the user about ETA: instead of "wait for a 429
// then retry then maybe 429 again", we pre-pace and say "this run takes ~65s".
//
// The scheduler degrades gracefully: when limit is null/unknown, all tasks
// fire at t=0 (= current `Promise.all` behaviour). The ledger still catches
// surprises.

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_ESTIMATE_TOKENS = 2500;  // matches openai search default in tpm-ledger.js

/**
 * Plan when to fire each task so cumulative token cost per 60s window stays
 * under `limit * 0.9` (10% headroom for provider accounting jitter).
 *
 * Algorithm: greedy packing into N-second windows.
 *   - Task fits in current window if (windowSum + cost) ≤ budget
 *   - Otherwise rotate to next window, reset windowSum
 *
 * Returns Array<{ taskIdx, fireAt }> where fireAt is ms from schedule start.
 *
 * Worked example: 3 tasks × 2500 tokens, limit=6000 (OpenAI tier-1 search):
 *   budget = 5400
 *   task 0 → window 0 (sum=2500 ≤ 5400)         fireAt=0
 *   task 1 → window 0 (sum=5000 ≤ 5400)         fireAt=0
 *   task 2 → next window (5000+2500 > 5400)     fireAt=60000
 *   Real wall-clock: task 2 finishes ~t=65s (60s gap + ~5s call), NOT 120s.
 *
 * @param {Array<{estimatedTokens?: number}>} tasks
 * @param {number|null} limit                   TPM cap. null = unknown → no pacing.
 * @param {number} [windowMs=60_000]
 * @returns {Array<{taskIdx: number, fireAt: number}>}
 */
export function planSchedule(tasks, limit, windowMs = DEFAULT_WINDOW_MS) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  if (!Number.isFinite(limit) || limit <= 0) {
    // No known limit → fire everything immediately, let ledger catch any
    // surprises. Matches the pre-scheduler `Promise.all` behaviour.
    return tasks.map((_, i) => ({ taskIdx: i, fireAt: 0 }));
  }
  const budget = limit * 0.9;
  const schedule = [];
  let windowIdx = 0;
  let windowSum = 0;
  for (let i = 0; i < tasks.length; i++) {
    const cost = tasks[i].estimatedTokens || DEFAULT_ESTIMATE_TOKENS;
    // Rotate to next window if this task doesn't fit (but never push an
    // empty window — we always start the next window with this task).
    if (windowSum + cost > budget && windowSum > 0) {
      windowIdx++;
      windowSum = 0;
    }
    schedule.push({ taskIdx: i, fireAt: windowIdx * windowMs });
    windowSum += cost;
  }
  return schedule;
}

/**
 * Execute task functions on the schedule. Returns a Promise.all-equivalent
 * result array (same shape and order as input). Each task fires at its
 * planned timestamp; tasks within the same window run concurrently
 * (semaphore-limited downstream).
 *
 * Implementation note: we use one shared `start` timestamp so all delays
 * are relative to the same origin. Per-task setTimeout fires `fn()` then
 * forwards its resolution / rejection to the outer Promise.
 *
 * @template T
 * @param {Array<() => Promise<T>>} taskFns
 * @param {Array<{taskIdx: number, fireAt: number}>} schedule  same length as taskFns
 * @returns {Promise<T[]>}
 */
export async function runScheduled(taskFns, schedule) {
  if (!Array.isArray(taskFns) || taskFns.length === 0) return [];
  const start = Date.now();
  return Promise.all(taskFns.map((fn, i) => {
    const fireAt = schedule[i]?.fireAt ?? 0;
    const delay = Math.max(0, fireAt - (Date.now() - start));
    if (delay === 0) return fn();
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        fn().then(resolve, reject);
      }, delay);
    });
  }));
}
