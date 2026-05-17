/**
 * Smoke-test the CLI dispatcher: --version and --help must exit 0 without
 * crashing. Replaces the previous `npm run test:cli` shell one-liner that
 * piped help to /dev/null — that path doesn't exist on Windows, so the
 * test always failed there and masked real CLI regressions.
 *
 * spawnSync with stdio:'pipe' captures output instead of streaming it,
 * keeping `npm test` quiet on success.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJ = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(PROJ, 'bin', 'aeo-tracker.js');

function run(arg) {
  const r = spawnSync(process.execPath, [BIN, arg], { stdio: 'pipe', encoding: 'utf-8' });
  if (r.status !== 0) {
    console.error(`CLI ${arg} exited ${r.status}`);
    if (r.stderr) console.error(r.stderr);
    process.exit(1);
  }
  if (!r.stdout || r.stdout.trim().length === 0) {
    console.error(`CLI ${arg} produced no output`);
    process.exit(1);
  }
}

run('--version');
run('--help');
console.log('OK: CLI works');
