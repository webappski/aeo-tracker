// TTY-aware spinner for long-running phases in init --auto.
//
// Problem it solves: between "[brainstorm] started" and "[brainstorm] done"
// the pipeline can spend 10+ seconds on an LLM call. The user sees a static
// stdout and can't tell the difference between "working" and "hung on network".
//
// Design constraints (from project conventions):
//   - TTY-only: if stdout is not a terminal (CI, pipe, --yes in a script),
//     all methods no-op and the existing flat log emits unchanged. No \r
//     tricks in non-TTY output — they break grep and CI log parsers.
//   - NO_COLOR respected: drops Unicode braille frames, falls back to cycling
//     ASCII dots. Readable in dumb terminals.
//   - Zero dependencies: pure process.stdout writes.
//   - Caller owns the final line. spinner.stop(finalLine) clears the
//     in-place render and writes the caller's preferred final text —
//     the existing logPhase output shape stays intact.

const FRAMES_UNICODE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAMES_ASCII = ['.  ', '.. ', '...', ' ..', '  .', '   '];
const INTERVAL_MS = 80;
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CLEAR_LINE = '\r\x1b[2K';

/**
 * @typedef {Object} Spinner
 * @property {(label: string) => void} start
 * @property {(label: string) => void} update
 * @property {(finalLine?: string) => void} stop
 * @property {() => void} cleanup  idempotent — safe to call from process handlers
 */

/**
 * @param {Object} [opts]
 * @param {NodeJS.WritableStream} [opts.stream]   default: process.stdout
 * @param {boolean} [opts.isTTY]                  override for tests; default: stream.isTTY
 * @param {boolean} [opts.useColor]               default: !process.env.NO_COLOR && isTTY
 * @param {boolean} [opts.useUnicode]             override; default: useColor && not legacy Windows console
 * @returns {Spinner}
 */
export function createSpinner(opts = {}) {
  const stream = opts.stream || process.stdout;
  const isTTY = opts.isTTY !== undefined ? opts.isTTY : !!stream.isTTY;
  const useColor = opts.useColor !== undefined ? opts.useColor : (isTTY && !process.env.NO_COLOR);
  // Unicode braille renders fine on Windows Terminal, VSCode integrated
  // terminal, iTerm, and any modern Linux/macOS terminal. The legacy
  // ConHost (Windows 10 default for cmd.exe / PowerShell pre-2022) without
  // an explicit UTF-8 codepage shows the frames as boxes. WT_SESSION is set
  // inside Windows Terminal; TERM_PROGRAM is set by VSCode, iTerm, etc —
  // either presence indicates a terminal that handles Unicode.
  const isLegacyWinConsole = process.platform === 'win32'
    && !process.env.WT_SESSION
    && !process.env.TERM_PROGRAM;
  const useUnicode = opts.useUnicode !== undefined
    ? opts.useUnicode
    : (useColor && !isLegacyWinConsole);
  const frames = useUnicode ? FRAMES_UNICODE : FRAMES_ASCII;

  let timer = null;
  let frameIdx = 0;
  let currentLabel = '';
  let startedAt = 0;
  let sigintHandler = null;

  function render() {
    const elapsed = formatElapsed(Date.now() - startedAt);
    const frame = frames[frameIdx % frames.length];
    frameIdx++;
    const colored = useColor
      ? `${DIM}${frame} ${currentLabel} ${elapsed}${RESET}`
      : `${frame} ${currentLabel} ${elapsed}`;
    stream.write(CLEAR_LINE + colored);
  }

  function clearLine() {
    if (isTTY) stream.write(CLEAR_LINE);
  }

  function start(label) {
    if (!isTTY) return;
    if (timer) stop(); // previous phase never called stop — drop it silently
    currentLabel = label;
    startedAt = Date.now();
    frameIdx = 0;
    render();
    timer = setInterval(render, INTERVAL_MS);
    if (!sigintHandler) {
      sigintHandler = () => { cleanup(); };
      process.once('SIGINT', sigintHandler);
    }
  }

  function update(label) {
    if (!isTTY || !timer) return;
    currentLabel = label;
    // Skip a full render here — next tick (≤80ms) will reflect the change.
    // Avoids double-write jitter when attempt/update events arrive back-to-back.
  }

  function stop(finalLine) {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    clearLine();
    if (finalLine !== undefined) {
      stream.write(finalLine);
      if (!finalLine.endsWith('\n')) stream.write('\n');
    }
    if (sigintHandler) {
      process.off('SIGINT', sigintHandler);
      sigintHandler = null;
    }
  }

  function cleanup() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    clearLine();
    if (sigintHandler) {
      process.off('SIGINT', sigintHandler);
      sigintHandler = null;
    }
  }

  return { start, update, stop, cleanup };
}

/**
 * Format ms as "NNNms" / "N.Ns" / "Nm Ns". Used in the spinner elapsed display
 * and exported so tests can assert format without constructing a spinner.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatElapsed(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}
