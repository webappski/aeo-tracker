# Changelog

All notable changes to `@webappski/aeo-tracker`.

## [0.2.2] — 2026-04-23

Patch release. **No breaking changes, no behavioural changes for existing users with standard env var names.** Bundles the 0.2.1 work (README + internal code quality) with two targeted UX fixes: non-standard env var naming + research-provider resilience.

### Added — init research-provider resilience

Previously: `init --auto` picked ONE research provider (priority #1 in `PROVIDER_PRIORITY`) for the brainstorm pipeline. If that single provider returned 402 (credit balance empty), 401 (invalid key), or 429 (rate-limit), the whole init crashed with a generic *"Auto-suggest failed / Aborting"* message — even when the user had two other working keys in their environment.

This was inconsistent with how `run` handles the same errors: a single engine's billing issue becomes a red `status: 'error'` cell in the report; other engines keep working. Init should be equally error-tolerant.

**Two complementary fixes:**

**1. `PROVIDER_PRIORITY` reordered** from `['anthropic', 'openai', 'gemini']` to `['openai', 'gemini', 'anthropic']`. Required providers (per README contract) now come first, optional providers last. Matches the declared user-facing model.

**2. Retry loop in the auto-suggest pipeline.** Init now walks `PROVIDER_PRIORITY` until one provider succeeds. Billing/auth/rate-limit errors trigger automatic retry with the next provider; real bugs (TypeError, SyntaxError, malformed requests) bubble up as before — they're not silently swallowed.

**Actionable failure panel.** When every available provider fails (rare — requires all configured billings to be empty), init prints a structured panel listing every attempt, the classified reason, and three copy-pastable fixes:

```
  All research providers failed — init cannot brainstorm queries on its own.

  Attempted (in priority order):
    ✗ OpenAI (ChatGPT) — empty billing balance
      "You exceeded your current quota..."
    ✗ Google (Gemini) — empty billing balance
      "Billing account ... is disabled"

  How to fix — pick one:

    1. Top up billing on one of these providers (brainstorm costs ~$0.01):
         OpenAI (ChatGPT): https://platform.openai.com/settings/organization/billing/overview
         Google (Gemini):  https://aistudio.google.com/apikey

    2. Skip brainstorm — provide 3-5 queries yourself (zero LLM cost):
         aeo-tracker init --yes \
           --brand=YOURBRAND \
           --domain=https://yourdomain.com \
           --keywords="query 1,query 2,query 3,query 4,query 5"

    3. Hide the failing provider for this run (skip it in priority):
         env -u OPENAI_API_KEY_DEV aeo-tracker init --yes \
           --brand=YOURBRAND --domain=https://yourdomain.com --auto
```

**Error classification** (see `lib/providers/classify-error.js`) catches billing-error phrasings from all four providers (OpenAI "exceeded your current quota", Anthropic "credit balance is too low", Google "billing account disabled"), auth errors (401, invalid key, `invalid x-api-key`), and rate-limit (429, "resource exhausted", "rate_limit"). Non-matching errors — TypeError, SyntaxError, generic 500 — are explicitly NOT retryable, because retrying a real bug across providers would mask the root cause.

**20 new tests** in `test/research-resilience.test.js` cover classification for real error strings from each provider, panel formatting edge cases (single-provider attempts, long error messages, color-off mode), and option numbering logic (Option 1 "top up" appears only when there are billing errors; Option 3 "env -u" appears only when 2+ providers were attempted).



### Added — README TL;DR section

New `## TL;DR` block right after the tagline: one-line positioning statement + three-command install/run chain + cost line with links to get keys + navigational hints ("never opened a terminal before?" → Path B, "want full context?" → Key facts). Appears before the detailed paragraphs so readers can decide in 5 seconds whether to keep reading or copy-paste and go.

AEO-benefit: AI crawlers strongly prefer atomic first-sentence claims + structured code blocks as citable answers. The new opening sentence (*"checks whether ChatGPT, Gemini, Claude, and Perplexity mention your brand — runs locally, reads your keys from shell env"*) is phrased to match the primary user query (*"how do I check if ChatGPT mentions my brand"*) rather than generic marketing copy, which improves the chance AI engines quote it verbatim.

### Added — full error-coverage matrix

Expanded from provider-only classification (v0.2.2 preview) to every failure path in the tool. Three complementary layers:

**1. Universal error classifier** (`lib/providers/classify-error.js`). Old `classifyProviderError` now also detects: network errors (ECONNREFUSED, ETIMEDOUT, ENOTFOUND, EAI_AGAIN via both `err.code` and regex on `.message`), bot-protection pages (Cloudflare / captcha phrases), SSL/certificate failures on user's domain, filesystem issues (EACCES, ENOSPC, EROFS, EPERM), and config-file corruption (SyntaxError on `.aeo-tracker.json`). Each category carries a `reason` + `fixHint` so downstream panels can generate actionable output without re-parsing the error.

Categories split into **retryable across providers** (billing/auth/rate-limit — init's research loop walks them) and **NOT retryable** (network/filesystem/config — retrying with Gemini won't fix a broken disk). Unclassified errors fall into `other` so they bubble to the bug-report link instead of being silently swallowed.

**2. `run` command: "all engines failed" panel** (`lib/errors/all-engines-failed-panel.js`). When every engine returns `mention === 'error'` (exit code 3), the command now prints a grouped breakdown: each engine with its classified reason, count of affected queries, and the env var the key was read from. Followed by option-numbered fixes: top-up links for billing failures, key-regeneration hints for auth failures, wait-and-retry for rate-limits, infra-check for network errors. Always includes a final escape hatch ("remove the failing engine from .aeo-tracker.json"). Skipped in `--json` mode so programmatic consumers still parse clean JSON.

**3. Top-level global catch** in `bin/aeo-tracker.js` (wraps the entire command dispatcher). Any error that escapes the command-specific error handling — config corruption at startup, filesystem issues, unclassified edge cases, real bugs — now lands in `formatUnexpectedErrorPanel` instead of as a raw Node stack trace. The panel shows the command that crashed, a classified headline (e.g. "Network error during `aeo-tracker run`"), a truncated error message, 2-3 concrete next steps per category, and a bug-report link for `other` errors. Raw stack is still printed to stderr when `AEO_DEBUG=1` so developers can dig in.

**Result:** every failure path in aeo-tracker now prints either a resolved result, a command-specific actionable panel, or (worst case) the top-level unexpected-error panel with next steps. Raw Node stack traces reach the user only in `AEO_DEBUG=1` mode.

19 new tests in `test/research-resilience.test.js` cover all new categories (ECONNREFUSED via err.code, SSL, EACCES, ENOSPC, ENOENT→config, bare-SyntaxError-stays-other), plus formatters for both new panels (grouping, option numbering, truncation).

### Added — per-provider interactive key prompt

Previously: if `aeo-tracker init` found SOME API keys via stages 1+2 (standard names, regex heuristic) but not others, it silently proceeded with partial config — then hard-failed at `run` because the two-model extractor requires both OpenAI + Gemini. Users with partial-standard / partial-custom naming were stuck.

Now: Stage 3 (interactive prompt) runs for EVERY missing provider after stages 1+2, not all-or-nothing. The old `[y/N]` gate is gone — the tool just asks directly:

```
Some API keys weren't auto-detected. Type the env var name (not the key itself):
  OpenAI (ChatGPT) env var name (required): MY_OPENAI_KEY
    ✓ verified (164 chars)
  Google (Gemini) env var name (required): MY_GEMINI_VAR
    ✓ verified (39 chars)
  Anthropic (Claude) env var name (Enter to skip — optional):   ← Enter
  Perplexity env var name (Enter to skip — optional):           ← Enter
```

Required providers (OpenAI + Gemini) retry up to 3 times on bad input (blank, env var not set, value too short). Optional providers (Anthropic + Perplexity) accept Enter to skip. Each confirmed name is written to `.aeo-tracker.json::providers[].env`; actual key values stay in `process.env`.

**Safety against accidental key paste.** The prompt asks for the env var NAME (e.g. `MY_OPENAI_KEY`), not the key itself. If a user — under time pressure — pastes an actual key value (`sk-proj-...`, `AIzaSy...`, `sk-ant-...`, `pplx-...`), `init` detects the provider-specific prefix, rejects the input, and prints an explicit nudge: *"That looks like an API key value, not an env var name — please type the NAME of the variable that holds your key"*. The pasted value is never logged, never displayed back, never written to disk. Only the confirmed env var **name** lands in `.aeo-tracker.json::providers[].env`.

Additionally, env var names themselves are validated against POSIX rules (`[A-Z_][A-Z0-9_]*`) — catches typos like dots or dashes in the name before confusing downstream errors.

If all 3 attempts are exhausted for a required provider, init hard-fails with explicit guidance pointing to shell-profile setup. In CI (`--yes`), Stage 3 is skipped — the user must either use standard env var names or pre-seed `.aeo-tracker.json` with explicit `providers[].env` fields.

### Changed — 0.2.1 content merged in

All 0.2.1-planned changes included here. Consolidation decision: ship one larger patch instead of two smaller ones.

Previously in the 0.2.1 entry:

### Added

- **`CODING_STANDARDS.md`** — project-level conventions (ESM only, JSDoc on public API, max-lines limits, error-handling patterns, naming, security). Source of truth for contributors.
- **Webappski sponsor card in the HTML report**, positioned directly under the Visibility Score hero. Soft call-to-action for teams who want implementation help; fully local (no tracking pixels).
- **Exported constants** `SEARCH_BEHAVIORS = Object.freeze({ RETRIEVAL, PARAMETRIC, MIXED })` from `lib/init/research/validate-query-llm.js`. Replaces magic string literals across the validator.
- **Named constants** for the sponsor-card brightness hover (`.sponsor-cta`) with rationale comment — readable palette, not a magic number.
- **Delegated keyboard handler** on `.pm-cell-clickable` — one document-level `keydown` listener replaces per-cell inline `onkeydown` attributes. Same a11y behaviour, cleaner markup.

### Changed

- **Replay mode productized.** `--replay` and `--replay-from` flags are now documented in `--help`. The "REMOVE OR COMMENT OUT BEFORE COMMIT" markers scattered through the code were author dev-notes; productizing them is net-positive (lets users rebuild summaries from historical responses without API cost).
- **`buildExtractionProviders` parallelized.** OpenAI and Gemini providers now resolve via `Promise.all` instead of sequentially — saves ~30 ms of cold-import latency on every run.
- **Inner `resolve` → `mkProvider`** rename to stop shadowing `Promise.resolve`.
- **`extractionSources` stored conditionally.** Per-cell extractor source arrays (per-model brand lists) are now written to `_summary.json` only when the two models disagreed or one failed. On unanimous agreement the sources are redundant — omitting them keeps the summary ~3× smaller over a year of weekly snapshots.
- **`runOne` in `extractWithTwoModels` rewritten** from `.then(success, error)` callback form to an idiomatic async/`try`/`catch` block.
- **GitHub URL in HTML report footer** corrected (`webappski/aeo-tracker` → `DVdmitry/aeo-tracker`).
- **CLI `--help` text** cleaned up: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY` sections now distinguish required vs optional explicitly; Source URL corrected.

### Fixed

- **`err.message` in `catch` blocks** — replaced every site in `bin/aeo-tracker.js` with a defensive `err instanceof Error ? err.message : String(err)` guard via new `errMsg(err)` helper. Prevents `undefined` messages when a non-Error value is thrown (rare in practice, but the defensive guard is free).
- **README consistency pass (25 findings from agent-review):**
  - Price figures unified across 7+ locations to canonical trio: $0.20 min / $0.50 recommended / $0.55 full (~$0.80–$2.40/month).
  - `aeo-tracker paste` reference in FAQ (which does not exist as a command) replaced with correct `run-manual perplexity --from-dir <dir>`.
  - Date placeholders in "What changes over time" table switched from concrete `2026-04-19` to relative `Day 0 / +7 / +28` + `YYYY-MM-DD` paths.
  - Duplicate screenshot eliminated — hero image swapped to `screenshot-05-actions.png` (recommended-actions card, the stronger demo).
  - Config example and 60-second-init transcript use `YOURBRAND` / `YOURDOMAIN.COM` / `YOURCATEGORY` placeholders instead of `acme.com` or `Webappski` — unambiguous for new readers.
  - Added Quickstart block (3 commands, ~60 seconds) at the top of the document.
  - Added "Your first run will show 0% — that's normal" section to frame the baseline emotionally for first-time users.
  - Added shields.io badges (npm version, MIT, Node ≥18, GitHub stars) under the H1.
  - Added "Is aeo-tracker an Otterly alternative?" FAQ (completeness with existing Profound / Peec.ai entries).
  - Table of contents now includes Limitations and Behind this tool anchors.
  - Roadmap section tightened: historic version details collapsed into a one-line CHANGELOG reference.
  - Limitations expanded from 4 to 7 items (week-over-week stochastic variance, provider rate limits, single-brand scope).
  - FAQ "best AEO tool for B2B SaaS" rewritten with an honest "when to choose something else" block (Profound for dashboards, Peec.ai for team workflows, Otterly for wider engine coverage).
  - "How accurate is AI visibility tracking?" + related FAQ content added for AEO discoverability.
  - Entity coverage tightened: `Answer Engine Optimization` repeats 4–6 times across the top 100 lines for AI-cite signal.

### Infrastructure

- **`.gitignore`** — added `.idea/`, `.vscode/`, `.claude/`, `aeo-reports/`, `*.tgz`. Prevents IDE state, local Claude settings, generated reports, and npm pack tarballs from entering commits.
- **Test coverage maintained:** 77 tests across 5 suites (validator, extractor, response-quality, pipeline, smoke). All green.
- **Package integrity verified:** `npm pack --dry-run` shows 54 files, ~820 kB, no dev artifacts leaked into the tarball.

---

## [0.2.0] — 2026-04-23

### ⚠ Breaking changes (upgrading from 0.1.x)

**1. `aeo-tracker run` now requires both `OPENAI_API_KEY` and `GEMINI_API_KEY`.**
The new two-model LLM competitor extractor needs both providers. Previously any single key was sufficient to run the audit. If you previously ran with only one of those keys — or with only Anthropic/Perplexity — you must set both before the next run. The tool hard-fails before spending any API credits. See the updated [API keys section in README](./README.md#api-keys) for links to obtain keys.

**2. `aeo-tracker run` now rejects non-commercial queries by default.**
A new commercial-only validator blocks methodological / informational queries (e.g. "how to measure AI search visibility", "what is Answer Engine Optimization") because they produce tutorial-style AI answers without vendor lists, polluting the trend signal with structural "0% visibility" scores. If your `.aeo-tracker.json` was generated by 0.1.3 and contains such a query, the next `run` will hard-fail with a clear error. Fix via one of:

- `aeo-tracker init --queries-only` to regenerate queries through the new validator pipeline (recommended)
- Hand-edit `.aeo-tracker.json` to replace the flagged query with a commercial one like "best X 2026" / "top X for Y" / "X consultants for Z"
- Temporary escape hatch: `aeo-tracker run --force` (use only for cross-industry interpretation research)

**Fields retained for backward compatibility:** old configs with a `competitors: [...]` field are still readable (field is silently ignored — competitor detection is now fully automatic via the two-model extractor). Missing `category` and `validationCache` fields fall back safely. Outdated model names in `providers[].model` (e.g. `gpt-4o-search-preview`) are auto-replaced by the latest available model via `discoverModels` at run start — no user action needed.

### Added — Full HTML report

The tool now produces a rich HTML report in addition to markdown. Covers hero score with trend sparkline, per-engine cards, query × engine heatmap, a per-cell `Position in AI answers` grid with verified/unverified competitor tiers, coverage radar, competitors bar chart, canonical sources, verbatim quotes, LLM-generated recommended actions, and session cost breakdown. Self-contained — inline SVG, inline CSS, zero external assets.

- **Interactive cell drill-down** in the Position grid. Click (or keyboard Tab + Enter) any cell to open a bottom panel with the full raw AI response for that query × engine pair. `View response →` affordance with hover animation and focus ring.
- **Verified / unverified competitor tiers** rendered inline. Solid badge = both extraction models agreed. Dashed badge with `?` superscript = only one model agreed (weak signal, fail-visible).
- **Coverage ring + traffic-light hero** — invisible / emerging / present / strong — matches the score bucket at a glance.

### Added — Two-model LLM competitor extractor

Replaces the previous regex + aggregate-classifier pipeline with a semantic extractor.

- Runs `gpt-5.4-mini` + `gemini-2.5-flash` in parallel against each per-cell response text.
- Merge strategy: intersection → verified, symmetric difference → unverified, union filtered for hallucinations (every returned name must appear verbatim in source text).
- `category`-aware prompt: extractor is told the user's competitive category (e.g. "Answer Engine Optimization services") and explicitly excludes data sources / review platforms / social networks / publications (Reddit, G2, Trustpilot, LinkedIn, TechCrunch, Wired, Yelp) unless the user's category names them.
- Three concrete counter-examples in the prompt: geography-dependent acronym, concept-vs-vendor confusion, domain collision.
- Cost: ~$0.008 per run at CLASSIFY_MODELS tier.

Deleted: `lib/mention.js::extractCompetitors` (regex), `lib/report/classify-brands.js` (aggregate classifier), `lib/report/bucket-brands.js` (tiering from classifier outputs), and all five filter dictionaries (NOISE_START, METRIC_KEYWORDS, IMPERATIVE_START, CONCEPTUAL_SEPARATOR, BRAND_ALLOWLIST).

### Added — Commercial-only query validator

Non-commercial queries are now rejected by default at `init` and at `run`.

- Validator already classified `search_behavior` as `retrieval-triggered | parametric-only | mixed`. New default: only `retrieval-triggered` passes. `parametric-only` and `mixed` produce blockers before any API is called.
- Rationale: methodological queries ("how to get recommended by AI") return tutorial-style answers with no ranked vendor list. Scoring them as 0% visibility conflates "wrong format of response" with "brand not ranked" and pollutes the trend chart.
- Opt-out at library level: `commercialOnly: false` in `runTwoStageValidation` (surfaced as `parametricQueries` list for content-marketing use cases). CLI flag for opt-out deferred until a real user requests it.

### Added — Response quality classifier

Per-cell `responseQuality` field distinguishes three states the old report rendered identically as "not listed":

- `empty` — engine refused / returned <200 chars and 0 citations. Shown as "no answer" in the grid.
- `narrative` — engine wrote prose but no extractable vendor list (competitors empty + fewer than 3 citations). Shown as "narrative response".
- `rich` — normal structured response. Default rendering.

Thresholds live in named constants (`EMPTY_TEXT_MAX = 200`, `NARRATIVE_CITATION_MAX = 3`) with boundary tests.

### Added — Validation cache

`validationCache` field in `.aeo-tracker.json` stores LLM verdicts keyed by exact query text. `run` trusts the cache; if the user edits a query by a single character, cache miss triggers inline re-validation with visible cost. Prevents re-running the same industry-fit check every week.

### Added — Cross-model query validation (opt-in)

`--strict-validation` runs validator through two providers in parallel. Unanimous valid → avg confidence. Unanimous invalid → max confidence (strong reject). Split → blocked with both verdicts shown for audit. Pure merge helper (`mergeCrossCheck`) reused by the extractor's parallel merge logic.

### Added — LLM-generated recommended actions

At `report` time, an LLM reads the run summary + prior snapshot + category and produces prioritised, engine-aware action cards: "Email editors of firstpagesage.com to add [Brand] to their AEO list", "Publish alternatives page for First Page Sage", etc. Cached in `_summary.json::llmActions` so repeat renders don't re-bill.

### Added — a11y + keyboard navigation on clickable cells

Position grid cells now have `role="button"`, `tabindex="0"`, `aria-label`, and keyboard handler (Enter / Space opens the response panel). Focus ring renders as 2px inset outline in accent colour; animation respects `prefers-reduced-motion`.

### Added — Tests

77 tests across 4 suites: static + LLM query validator (with cross-check merge), two-model extractor (parse / hallucination / self-brand / merge / partial failure), response-quality boundary tests, end-to-end pipeline integration with mocked providers.

### Fixed

- Definition-list extractor bug where Gemini format `**Brand:**` caused the brand name to be rejected by the old regex extractor. Two-model LLM extractor handles all formatting variants natively.
- Customs-consultancy drift on queries like "AEO consultants Poland". Static acronym validator catches bare `AEO` without the `Answer Engine Optimization` expansion. LLM validator catches additional cases (e.g. "AEO status" as customs term) via geography-aware prompt.
- Methodology queries inflating "0% visibility" signal. Commercial-only validator blocks them at init time.

### Documentation

- `test/fixtures/README.md` — rotation policy for regression fixtures.
- Expanded CHANGELOG entry honestly describing the architectural change (this entry).

---

## [0.5.0] — 2026-04-19

### Added — Keyword research pipeline (major UX)

**Replaces v0.4.0's single-shot auto-suggest with a multi-phase research pipeline.** Rationale: single-shot guessing produced ambiguous queries on the Webappski case — in Poland, "AEO" more commonly means "Authorized Economic Operator" (customs) than "Answer Engine Optimization", and the old approach silently measured the wrong industry. This release reframes query generation as research: brainstorm → filter → score → cross-model validate → select.

- **Explicit category description (`--category` flag / interactive prompt)** — new step before LLM call asks "What does your company do?" The answer becomes the authoritative context for disambiguation. Auto-inferred fallback from site content used when unset.
- **Brainstorm phase** — 1 LLM call generates ~25 candidate queries across 5 intent buckets (commercial, informational, vertical, problem, comparison). Non-negotiable prompt rules include acronym expansion and ≥3-industry vertical diversity.
- **Local filter phase** — rejects branded, duplicate, too-short/long, and bare-ambiguous-acronym candidates with explicit reasons.
- **Language-aware intent classifier** — reconciliation between brainstorm's tag and linguistic classification (EN/PL/DE supported; other languages fall back to brainstorm tag).
- **Scoring** — 0–100 per candidate based on word-count sweet-spot, recency markers, specificity, long-tail structure, comparison structure, language match.
- **Cross-model validation** — second LLM call using a DIFFERENT provider from brainstorm catches category-mismatches the first model missed (e.g. bare "AEO" that means customs). Skipped gracefully in single-provider mode.
- **Intent-diverse selection** — picks exactly 1 commercial + 1 informational + 1 vertical (not top-3 by score). Fallback chain if a bucket is empty.
- **Candidate pool** — 5 alternatives saved to `.aeo-tracker.json` under `candidatePool` for future swap without re-running LLM.
- **Disambiguation warning in `aeo-tracker report`** — if score is 0% and top canonical sources suggest a different industry than the brand's site, the report now includes a warning suggesting `--refresh-keywords --category="<tighter>"`.

### Added — Multiple init modes

- **`--light` flag** — bypasses the research pipeline, uses v0.4.x-style single-shot suggest. Cost ~$0.003 instead of ~$0.005. For users who trust the LLM and want speed.
- **`--keywords="q1,q2,q3"` flag (BYO)** — skip brainstorm entirely, provide your own 3 queries. $0 LLM cost. For power users / migration from other tooling.
- **Single-provider mode** — if only one LLM provider has a configured API key, cross-model validation is skipped with a single info message (not N per-bucket warnings). Candidates are presented labelled `(unverified)`.

### Added — Benchmark discipline

Internal benchmark on 5 reference brands (TypelessForm, Webappski, Linear, Notion, Stripe) before release. Scoring rubric documented in `docs/benchmark-ideals.md`. Raw results in `docs/benchmark-results.md`.

- **Strict score: 11/15 (73%)** semantic matches where intent + topic + specificity align tightly with manually-written ideals.
- **Lenient score: 14/15 (93%)** where partial matches (same bucket and topic, slight variation in sub-intent) also count.
- Both above internal ≥7/15 (47%) threshold.
- Cost tight: mean $0.0050 per brand, max/min 1.10×.
- Hallucination rate on competitor suggestions ~12% (vs ~40% observed on pre-v0.5 single-shot runs).

**Honesty clause:** lenient scoring is shown as a secondary metric, not the headline, to avoid the same inflated-score pattern we criticise in third-party AEO graders. The strict number is the one to cite.

### Changed

- `aeo-tracker init` now defaults to the full research pipeline. Old behaviour available via `--light`.
- `lib/init/suggest.js` remains exported as the `--light` path; v0.5 does not delete it.
- `.aeo-tracker.json` may now contain a `candidatePool` field (additive; v0.4.x configs still readable).

### Fixed

- **Validator bias on narrowed audience** (Guard 5). When `CATEGORY_DESCRIPTION` included `"for X audience"`, the cross-model validator previously rejected legitimate vertical-expansion candidates (e.g. "AEO for healthcare" when category said "for SaaS"). Validator now receives a broadened category, stripping the audience qualifier, and correctly approves cross-audience vertical queries.
- **Per-bucket single-provider warnings noise.** v0.5.0 initial implementation emitted 3 warnings ("no validated candidate for X, falling back to unvalidated") in single-provider mode — one per intent bucket. Replaced with a single info message up-front.

### Added — Report visual upgrades (folded from v0.5.1 plan)

- **Hero card with traffic-light status** (`🔴 INVISIBLE` / `🟠 EMERGING` / `🟡 PRESENT` / `🟢 STRONG`) — scannable in 1 second.
- **Big score readout** in hero (e.g. `# 8%`) with trend marker (▲/▼/▪ BASELINE vs previous run).
- **Score badge in H1 title** (e.g. `# AEO Report — Webappski · 🟠 8% EMERGING`) stays visible while scrolling.
- **Baseline comparison block** — tells the user whether `0%` is catastrophic or the expected Week-1 norm. Shown only for score <60%.
- **Radar chart** (`lib/svg/radar.js`) — per-engine hit rate on polar axes. Shape reveals skew (one engine strong, others 0) or uniform invisibility.
- **YOU row accented in competitor barchart** (indigo `#6366f1`) — user sees their own count next to competitor counts instead of mentally comparing.
- **Actions checkbox card moved to top** of render order with markdown `[ ]` format + effort estimate + rationale per action. Copy-paste into Todoist/Linear.
- **Icon legend for heatmap** (🟢/🟡/🔴/⬜) as 4-row table replacing prose legend.
- **Domain-grouped canonical sources** — collapses `example.com/page/A` + `/B` + `/C` into `example.com (3 pages, directory)`. Shows where authority concentrates, not individual URLs.
- **First-run trend placeholder** — when only 1 snapshot exists, shows "W1 ● W2 W3 ... W12" horizon instead of hiding the section.

### Deferred to v0.5.1

- `aeo-tracker init --refresh-keywords` (drift-guarded in-place refresh)
- Opt-in anonymised telemetry (P5)
- Per-intent scoring refactor (Guard 6 full implementation — detection currently flags the issue but doesn't re-score)
- Competitor suggestions integrated into the research pipeline (currently fetched via a separate single-shot suggest call)
- Strengthening of the informational bucket in brainstorm (Linear case: fell back from comparison)

### Notes

- v0.4.0 was completed on disk but **never published to npm**. All of its features (smart init, markdown report, rich exit codes, manual paste mode, inline SVG, verbatim quotes) ship bundled into v0.5.0 as the cohesive first public release.
- Guards 1–5 are fully implemented; Guard 6 is detected and warned but the per-intent scoring refactor is deferred.

---

## [0.4.0] — 2026-04-19 (internal only, not published)

### Added — Smart `init` with auto-suggest (major UX)
- **Three-stage API key detection** — (1) standard names (`OPENAI_API_KEY`, etc.), (2) heuristic regex match for custom names (e.g. `OPENAI_API_KEY_DEV`, `CLAUDE_KEY`), (3) direct prompt for non-standard names when nothing else matches. `init` writes whichever names the user actually uses — no manual config edits needed afterward.
- **Auto-configure queries and competitors from your site** — `aeo-tracker init` now asks "manual or auto?". Auto mode fetches your URL, extracts title/meta/headings, sends the excerpt to an LLM (Claude Sonnet / GPT-4o / Gemini — whichever key is available), and suggests 3 unbranded queries + up to 5 competitors in the site's detected language. User reviews and can accept / edit / reject. One-time cost: ~$0.01.
- **Defensive fetching** — follows redirects, 10s timeout, sends descriptive `User-Agent`, normalizes input (prepends `https://` if missing), flags JS-only SPAs, Cloudflare challenges, and tiny HTML pages with a warning before proceeding.
- **Robust LLM JSON parsing** — strips markdown code fences, extracts first `{...}` block, retries once on parse failure, falls back to manual input on second failure.
- **Prompt-injection mitigation** — scraped site content is fenced inside explicit `<<<BEGIN_SITE_CONTENT … END_SITE_CONTENT>>>` markers with an instruction that content inside is untrusted.
- **Privacy consent before LLM call** — explicit "I will fetch X, extract Y, send to Z" summary with y/n prompt. No silent exfiltration.
- **Atomic config writes** — config is written to `.aeo-tracker.json.tmp` then renamed. Ctrl-C mid-init leaves no partial state.
- **Existing-config overwrite prompt** — previously `init` aborted silently if `.aeo-tracker.json` existed. Now asks `[y/N]`.

### Added — Phase B (markdown report + SVG primitives)
- **`lib/init/`** — three new modules for smart init: `keys.js` (3-stage detection), `fetch-site.js` (timeout/redirect/SPA-detect/privacy), `suggest.js` (prompt-building + JSON parsing + retry).
- **`lib/svg/`** — four zero-dependency inline SVG primitives: `heatmap`, `barchart`, `sparkline`, `deltaArrow`. Neutral tailwind palette (`#10b981` / `#ef4444` / `#94a3b8`), fixed — never brand colours.
- **`lib/report/extract-quotes.js`** — pulls verbatim sentences around brand/domain mentions from raw AI responses. Sentence-boundary breaking, markdown noise stripping, snippet dedup, citation-only fallback per D5.
- **`lib/report/sections.js`** — deterministic section builders for the report: header, top numbers, AI × Query matrix (heatmap), diff, trend (sparklines), verbatim quotes, tracked competitors (barchart), canonical sources (barchart), footer.
- **`lib/report/markdown.js`** — aggregates sections into a complete markdown document. Also exports `parseRawResponse(provider, raw)` which derives plain text from saved API response JSON per provider shape.
- **New `aeo-tracker report`** — builds `aeo-reports/<date>/report.md` from all prior `_summary.json` files plus raw responses for the latest run. Inline SVG charts, verbatim AI quotes, graceful degradation when only one run exists.

### Removed
- **Old HTML/Chart.js report generator** (deprecated since 0.3.0) — deleted. Replaced by markdown-first engine above. No external CDN dependency anymore.

### Notes
- End-to-end smoke-test passed on manual-paste fixtures from 0.3.1 — report correctly extracted two verbatim Perplexity quotes, rendered heatmap and barcharts inline, degraded diff/trend sections gracefully for single-run data.
- Opt-in dual-model (`previousModel` per provider) is **not** shipped in 0.4.0 — decision deferred. It doubles API cost without adding value-signal today; will ship only if a real need appears.
- Next: 0.5.0 HTML wrapper for the markdown report (single-file, zero-deps).

## [0.3.1] — 2026-04-18

### Added
- **`aeo-tracker run-manual <provider> --from-dir <dir>`** — paste-based mode for engines without a usable API. Reads `q1.txt`, `q2.txt`, `q3.txt` from the given directory, extracts URLs via regex, runs the same mention/competitor/source detection pipeline as auto runs. Merges into today's `_summary.json` (recomputing aggregates), overwriting prior results for the same provider.
- `extractUrls(text)` in `lib/mention.js` — regex-based URL extractor with trailing-punctuation stripping.
- Per-result `source` field (`"api"` or `"manual-paste"`) to distinguish origins in downstream tooling.

### Use case
Perplexity (Pro-only API), Microsoft Copilot (no consumer API), ChatGPT Pro UI, Claude.ai — all can now feed into the same pipeline. Manual results participate in `diff`, exit codes, future reports without special-casing.

## [0.3.0] — 2026-04-18

### Added
- **Perplexity provider** via Sonar API (`sonar` model, ~$0.005/query). Set `PERPLEXITY_API_KEY` to enable.
- **`aeo-tracker diff`** command — compare two runs by date, `--last N`, or `--since DATE`. Prints cell changes, competitor movements, canonical-source movements, and a score delta.
- **Explicit competitors list** in config (`competitors: [...]`). When set, the tool does case-insensitive exact detection with position tracking, reported as `trackedCompetitors` in `_summary.json`. The heuristic `**Bold Name**` extractor remains as fallback.
- **Canonical sources tracking** — dedup'd citation URLs per check (`canonicalCitations`) and aggregated (`topCanonicalSources`) across the run. Surfaces the pages AI engines keep citing for your vertical.
- **`--json` flag** on `run` — structured JSON to stdout, ANSI/progress suppressed. Pipe to `jq` in CI.
- **Rich exit codes** (`0/1/2/3`) — state-based instead of binary. `regressionThreshold` config field (default 10pp) controls the regression threshold. The `diff` command uses the same scheme.
- **Per-provider latency** in `_summary.json` (`elapsedMs`). Free drift signal — silent model swaps often change wall-time.

### Changed
- Code reorganised into `lib/` modules: `config.js`, `mention.js`, `diff.js`, `providers/{openai,gemini,anthropic,perplexity,index}.js`. `bin/aeo-tracker.js` kept as a thin CLI dispatcher. No behaviour change from the refactor alone.
- `_summary.json` gains additive fields (`regressionThreshold`, `trackedCompetitors`, `topCanonicalSources`, per-result `canonicalCitations`, `explicitCompetitors`, `elapsedMs`). **Non-breaking** — old consumers that ignore unknown fields continue to work; files written by v0.2.x remain readable.

### Deprecated
- The existing `report` command (HTML + Chart.js via CDN) prints a `[DEPRECATED]` warning. It still works. v0.4.0 replaces it with a markdown-first engine using inline SVG, removing the external CDN dependency. See `docs/v0.5-report-generator-plan.md`.

### Notes
- Default cost per run now **$0.065** (all four providers at 3 queries each); **$0.05** if Perplexity is omitted. No change for existing configs without Perplexity.
- Semver stays on `0.x` while the public surface is still moving. A v1.0.0 bump is reserved for after 0.5.0 has been exercised in the field.

## [0.2.0] — 2026-03-XX
- Initial public release. `init` + `run` commands, ChatGPT/Gemini/Claude via official APIs, raw-response storage, competitor extraction.
