// Cross-platform "open this file/URL in the user's default browser".
//
// Why a helper: the in-tree call site used `execSync('start "<path>"')` on
// Windows, which fails because `start` is a cmd.exe builtin (not a binary)
// and execSync without `shell: true` tries to spawn it as an executable.
// The user sees a stray PowerShell window instead of a browser.
//
// Behaviour:
//   - win32:  cmd /c start "" "<target>"   (the empty "" is start's window
//             title — without it, start treats the next quoted arg as title
//             and never opens the file)
//   - darwin: open "<target>"
//   - other:  xdg-open "<target>"          (Linux, BSD, etc)
//
// We spawn detached + stdio:ignore + unref() so the parent process exits
// cleanly without waiting for the browser. Errors (e.g. xdg-open missing
// on a headless Linux box) surface via the 'error' event — callers get a
// boolean back so they can fall back to printing the path.

import { spawn } from 'node:child_process';

/**
 * @param {string} target  absolute path or URL
 * @returns {Promise<boolean>} true if the OS handler was launched, false on error
 */
export function openInBrowser(target) {
  return new Promise((resolve) => {
    const p = process.platform;
    let cmd, args;
    if (p === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '""', target];
    } else if (p === 'darwin') {
      cmd = 'open';
      args = [target];
    } else {
      cmd = 'xdg-open';
      args = [target];
    }
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.unref();
      // Resolve on next tick — if spawn was going to fail synchronously
      // ('error' event fires async on next tick), we'd hear about it first.
      setImmediate(() => resolve(true));
    } catch {
      resolve(false);
    }
  });
}
