// Single owner of process.stdin / readline lifecycle for the CLI.
//
// Why this module exists:
//   Earlier versions of bin/aeo-tracker.js created readline interfaces in two
//   places (cmdInit, runValidationFlow) and closed them at various branch exits.
//   The combination produced bugs like:
//     - "readline was closed" mid-init when an unconditional close fired before
//       the recovery prompt was ever reached.
//     - ReferenceError in cmdRun where ask() was lexically undefined.
//     - Two readline instances competing on the same stdin.
//   This module is the only place createInterface is called. Every command
//   that needs to prompt receives a prompter from the top-level dispatcher.
//
// Guarantees:
//   - Lazy: createInterface runs on first ask() in interactive mode, never in
//     non-interactive mode. echo "y" | aeo-platform init never touches readline.
//   - Auto-non-interactive: if process.stdin.isTTY is false and nonInteractive
//     was not explicitly set, prompter assumes non-interactive (returns
//     defaults, no readline).
//   - External close detection: if the underlying readline closes itself
//     (Ctrl+D from the user, parent process killed the pipe), future asks
//     throw a readable error instead of hanging or surfacing
//     ERR_USE_AFTER_CLOSE.
//   - process.on('exit') hook: readline closes synchronously on every
//     exit path. The dispatcher always calls process.exit(0|1), which
//     fires 'exit' synchronously — callers don't need try/finally per
//     branch.

import { createInterface } from 'node:readline';

/**
 * @typedef {Object} Prompter
 * @property {(question: string, defaultValue?: string) => Promise<string>} ask
 * @property {() => void} close
 * @property {() => boolean} isClosed
 */

/**
 * @param {Object} [opts]
 * @param {boolean} [opts.nonInteractive]  explicit override; if omitted,
 *   derived from `!process.stdin.isTTY`
 * @param {NodeJS.ReadableStream} [opts.input]   default: process.stdin (tests)
 * @param {NodeJS.WritableStream} [opts.output]  default: process.stdout (tests)
 * @returns {Prompter}
 */
export function createPrompter(opts = {}) {
  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  const nonInteractive = opts.nonInteractive !== undefined
    ? opts.nonInteractive
    : !input.isTTY;

  let rl = null;
  let closed = false;
  let externallyClosed = false;

  function ensureRl() {
    if (rl) return rl;
    rl = createInterface({ input, output });
    rl.on('close', () => {
      // Distinguish self-close (our close() set `closed` first) from
      // external close (Ctrl+D, broken pipe). Self-close arrives after we
      // already flipped the flag — nothing to do. External close happens
      // while `closed` is still false — flip both flags so future asks
      // throw a readable error.
      if (!closed) {
        closed = true;
        externallyClosed = true;
      }
    });
    return rl;
  }

  function close() {
    if (closed) return;
    closed = true;
    if (rl) {
      try { rl.close(); } catch { /* readline already torn down */ }
    }
  }

  // Synchronous exit hook: Node runs 'exit' listeners before the process
  // actually stops, even on process.exit(N). This is the safety net for
  // every code path that doesn't (or can't) call close() explicitly.
  process.on('exit', close);

  async function ask(question, defaultValue = '') {
    if (nonInteractive) return defaultValue;
    if (closed) {
      if (externallyClosed) {
        throw new Error('Input stream closed (Ctrl+D or pipe end) — cannot prompt further');
      }
      throw new Error('Prompter was already closed — ask() called after close()');
    }
    const interface_ = ensureRl();
    return new Promise(resolve => interface_.question(question, resolve));
  }

  return {
    ask,
    close,
    isClosed: () => closed,
  };
}
