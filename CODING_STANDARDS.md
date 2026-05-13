# Coding standards — `@webappski/aeo-tracker`

Conventions for contributors. Enforced by reviewers (no automated linter yet; add one if the project grows).

## Module system

- **ESM only.** `package.json` has `"type": "module"`. No CommonJS.
- `.js` extension always in imports (`from './foo.js'`, not `./foo`). Node needs it for bare-spec ESM.
- One default export per module; prefer **named exports** for testability.

## Zero runtime dependencies

This project ships with `"dependencies": {}` empty. Do not add runtime `npm` packages. Dev-only testing/linting tooling in `devDependencies` is allowed. Rationale: install time, supply-chain surface, portability (users running in sandboxed CI).

## Documentation

- **Public API (exported functions / consts) MUST have JSDoc.** Document *why* the function exists and any non-obvious failure mode — not just params.
- Magic numbers MUST be named constants with JSDoc explaining how the value was chosen (see `EMPTY_TEXT_MAX`, `NARRATIVE_CITATION_MAX` in `lib/report/response-quality.js` for examples).
- Internal helpers can skip JSDoc if their body is ≤10 lines and name is self-explanatory.

## File size

| Limit | Rule |
|---|---|
| **300 lines** | Default max per file (including comments/whitespace). |
| Allowed exceptions | `bin/aeo-tracker.js` (CLI entry, will be decomposed in a future release), `lib/report/html.js` (single-file HTML renderer — part of the "zero deps" trade-off), `lib/report/sections.js` (markdown section renderers — same trade-off), `lib/report/mc-bridge.js` (single-file CSS+HTML+JS bundle for inline injection of the Mission Control bridge block — same "zero deps inline template" trade-off as `html.js`/`sections.js`; three exports `bridgeCss`/`bridgeMarkup`/`bridgeJs`). These are tech debt, not a licence to keep growing — new code should live in new small modules. |
| **Function max** | 50 lines. |
| **Cyclomatic complexity** | ≤10 branches. If higher, extract sub-functions. |
| **Params** | ≤4. If higher, switch to `options` object. |

## Template literals

Files that return template-literal strings (`lib/report/html.js::renderHtml`, `lib/report/mc-bridge.js::bridgeMarkup`/`bridgeJs`, anywhere a function returns a backtick-wrapped multi-line string) **must NOT contain backticks in their inner HTML / SVG / CSS / JS comments**. A stray backtick inside `<!-- … -->` or `/* … */` closes the surrounding template literal and produces a `SyntaxError: Unexpected token …` on an unrelated line far below the actual cause. Use straight `"…"` quotes in comments instead. Same rule applies to the `${…}` interpolation — never write a literal `${` inside a comment without escaping it, or it triggers an interpolation parse on garbage.

```js
// BAD — backtick in SVG comment closes the bridgeMarkup template literal
return `
  <!-- chip with "`?`" icon top-right -->
  <g>...</g>
`;

// GOOD — straight quotes in the inner comment
return `
  <!-- chip with "?" icon top-right -->
  <g>...</g>
`;
```

## Error handling

```js
// BAD — err.message is undefined when err is not an Error
} catch (err) {
  console.error(err.message);
}

// GOOD — defensive unwrap
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
}
```

- Every `catch` must either log, rethrow, or return a meaningful fallback. No silent `catch {}` blocks.
- In ESM top-level code, always wrap async work in try/catch or `.catch(err => ...)` — unhandled rejections crash Node 20+.
- Custom error codes when the caller needs to branch on error kind. Plain `throw new Error(msg)` is fine for one-off failures.

## Purity & testability

- Prefer **pure functions** (no I/O, no side effects) over stateful classes where the domain allows. Pure functions are trivially testable.
- Inject provider calls as function args (dependency injection), not globals. See `extractWithSingleModel({ providerCall, ... })` in `lib/report/extract-competitors-llm.js`.
- Every new pure helper should have at least one test in `test/<module>.test.js`.

## Security

- **Never commit API keys or tokens.** `.env` files are gitignored; `.aeo-tracker.json` may contain provider env-var *names* but never values.
- **Escape user data in HTML.** Every `${...}` interpolation in `lib/report/html.js` that pulls from `summary.*` or user input must go through `esc()`.
- **No `eval`, no `Function(...)` constructor, no dynamic script injection.**
- **No `console.log` of full response payloads in production paths.** Raw responses land on disk (`aeo-responses/<date>/`), not in stdout.

## Naming

- **Functions:** verb + noun. `createSession`, `validateField`, `extractWithTwoModels`.
- **Booleans:** `is` / `has` / `can` / `should` prefix. `isActive`, `hasError`.
- **Constants:** `UPPER_SNAKE_CASE`. `MAX_RETRIES`, `CONFIDENCE_THRESHOLD`.
- **Files:** `kebab-case.js`. `classify-intent.js`, `extract-competitors-llm.js`.
- **No single-letter variable names** except in tight scopes (array `.map(x => x.id)` acceptable; 50-line function with `x`/`y`/`z` not).
- **Avoid shadowing built-ins.** No inner `function resolve()` shadowing `Promise.resolve`, no `String` / `Array` / `Number` as variable names.

## Logging

- User-facing output uses the global `c` palette (bold/dim/green/yellow/red) in `bin/aeo-tracker.js`. Respect `NO_COLOR` env var.
- `stdout` is reserved for human-readable progress / final summary. Errors go to `stderr` via `console.error()`.
- Cost lines always include the `$` figure.

## Tests

- `npm test` runs every assertion across syntax / imports / CLI smoke / unit suites.
- New pure functions → add tests in `test/<name>.test.js` before merging.
- No `.only`, no `.skip` committed. Use them locally, revert before PR.
- Snapshot fixtures (if any) live in `test/fixtures/` with a `README.md` explaining rotation policy.

## Commits

- One logical change per commit. No "WIP" or "stuff".
- Commit message: imperative mood, short subject (≤72 chars), optional body explaining *why*.
- Reference the CHANGELOG entry being added in the same commit.

## Versioning

- Semver strict. `0.x.y` still follows: breaking changes bump the minor (`0.1 → 0.2`), non-breaking features bump the patch (`0.2.0 → 0.2.1`).
- Every release has a CHANGELOG entry with `### Breaking changes` subsection when applicable.
