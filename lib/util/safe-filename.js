// Sanitise an arbitrary string into a filename component that is safe on
// Windows, macOS and Linux.
//
// Two layers of escaping:
//   1. Strip everything outside [a-z 0-9 . -] and lowercase. This already
//      kills the Windows-illegal characters < > : " | ? * \ / and any
//      whitespace, control codes, or unicode that would surprise a shell.
//   2. Prefix with `_` if the result matches a Windows reserved device name
//      (CON, PRN, AUX, NUL, COM1–9, LPT1–9 — case-insensitive, with or
//      without an extension). Windows refuses to create such files at all,
//      so a model named e.g. `aux-mini` would crash a run with EINVAL.
//
// Used by the run pipeline when composing names like
//   q1-openai-gpt-5-search-api.json
// and by the report side when reading them back.

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * @param {string} input
 * @returns {string}
 */
export function sanitizeForFilename(input) {
  const safe = String(input).replace(/[^a-z0-9.-]/gi, '-').toLowerCase();
  if (WIN_RESERVED.test(safe)) return '_' + safe;
  return safe;
}
