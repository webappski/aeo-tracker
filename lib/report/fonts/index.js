/**
 * Self-hosted variable fonts for the HTML report.
 *
 * Three latin-subset variable woff2 files are bundled inside the npm package
 * (no network dependency at runtime). Each is base64-encoded once per process
 * and embedded into the report's `<style>` block via `@font-face` rules.
 *
 * Sources (originally fetched from Google Fonts woff2 endpoint, latin subset):
 *   - Fraunces           — variable opsz (9..144) + wght (200..800), display serif
 *   - Geist              — variable wght (300..700), neo-grotesk sans
 *   - JetBrains Mono     — variable wght (400..600), monospace
 *
 * Total ~127KB raw → ~169KB base64. Adds ~170KB to every generated report.html.
 * Trade-off: keeps the report single-file offline-ready (works in email, file://,
 * disconnected archive) at the cost of a one-time payload increase. v0.4 used
 * the Google Fonts CDN; v0.5 swaps to embedded for the same reason `aeo-platform`
 * has zero npm dependencies — the CLI's job is to produce a self-contained artifact.
 *
 * Licensing: all three families ship under SIL Open Font License 1.1 (OFL).
 * License files in this directory document their provenance.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// Map family name → bundled woff2 filename. Each is one variable file; the
// browser interpolates weights from the variable axes — no separate file
// per weight needed.
const FAMILIES = [
  { name: 'Fraunces',        file: 'Fraunces-Variable-latin.woff2' },
  { name: 'Geist',           file: 'Geist-Variable-latin.woff2' },
  { name: 'JetBrains Mono',  file: 'JetBrainsMono-Variable-latin.woff2' },
];

let _cached = null;

/**
 * Returns the @font-face CSS block with all three families embedded as
 * base64 data URIs. Cached after first call (loads ~127KB from disk once).
 *
 * @returns {string} CSS containing three @font-face rules
 */
export function getFontFaceCss() {
  if (_cached) return _cached;
  const blocks = FAMILIES.map(({ name, file }) => {
    const path = join(HERE, file);
    const bytes = readFileSync(path);
    const b64 = bytes.toString('base64');
    return `@font-face {
  font-family: '${name}';
  font-style: normal;
  font-weight: 200 800;
  font-display: swap;
  src: url(data:font/woff2;base64,${b64}) format('woff2');
}`;
  });
  _cached = blocks.join('\n');
  return _cached;
}
