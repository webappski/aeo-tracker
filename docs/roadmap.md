# Internal roadmap

Maintainer's working file for bugs and improvements found during dogfooding.
GitHub Issues are reserved for user-reported items — internal TODOs live here.

**Before any commit, Claude checks this file and flags open items relevant to the staged diff.**

---

## 1.0.4 — next patch

> All `[bug]` items from the original 1.0.3 list shipped in 1.0.3 (see Done section below).
> Remaining items below are the deferred UX redesign, the auto-substitute enhancement,
> CLI hygiene, and the placeholder-domain hint.

### [ux] Validator output reads as a fatal crash (it isn't)

**The single most important bug to fix in 1.0.3.** Reviewed with 3 user-persona agents (novice marketer, senior CLI power user, CLI UX designer) and one community-conventions research pass. Every reviewer flagged the same problem: this is **a successful pipeline waiting for the operator to choose 3 of 5 validated alternatives**, but it renders as a crash.

#### Observed output (what users actually see today)

```
  pipeline complete in 45552ms, est cost ~$0.0058

Selected queries (1 per intent bucket):
  commercial     score=90 high → enterprise voice form filling platform
  vertical       score=90 high → voice form filling for e-commerce stores
  problem        score=70 high → why voice form doesn't recognise date field

Alternatives (for swap):
  [90] vertical       (validated) voice form solution for healthcare clinics
  [90] vertical       (validated) voice form filling for legal firms
  [78] comparison     (validated) voice form widget versus typed form automation
  [78] comparison     (validated) voice form service vs chatbot form
  [78] comparison     (validated) voice form widget vs form builder plugin

  LLM industry-fit check — 3 flagged
  Commercial-only check — 1 non-commercial blocked

  Cannot auto-recover — 4 query/queries blocked by validator.

  Blocked:
    ✗ "enterprise voice form filling platform"     non-commercial (retrieval-triggered)
    ✗ "voice form filling for e-commerce stores"   non-commercial (retrieval-triggered)
    ✗ "why voice form doesn't recognise date field"  non-commercial (parametric-only)
    ✗ "why voice form doesn't recognise date field"  non-commercial (parametric-only)

  How to fix — pick one:
    1. Rerun with hand-picked queries: aeo-platform init --keywords="..."
    2. Keep blocked queries anyway: aeo-platform init --force
    3. Try again with --category hint
```

#### What each reviewer said

**Anna (novice marketer)** — *"My stomach dropped at 'Cannot auto-recover'. Four red ✗ in a row, the word 'Blocked', I'm sure the whole thing crashed. I felt great for ten seconds reading 'Selected queries score=90 high'. Then it all went wrong. I have no idea what 'retrieval-triggered' or 'parametric-only' means — my query said 'enterprise' and 'platform', those are commercial words to me. The same query is listed as blocked twice, did it double-fail? Most important missing thing: a plain-English 'here's what to do next' sentence."*

**Mark (senior dev)** — *"Semantic event: validator rejected 4/4 candidates as non-commercial; init produced no config and is awaiting operator input. It's a `plan` with zero applicable changes, not a failure. Don't paint guidance in alarm colours. Reference: cargo's `help:` and rustc's suggestion blocks use cyan/blue for exactly this. Exit code: 2 (precondition not met), same family as `grep` no-match. Diagnostics should be on stderr, not stdout."*

**Lena (CLI UX designer)** — proposed rendering below + 5 principles: (1) lead with the verdict, not the trace; (2) reserve red for actual failure; (3) name states by what the user does next ("needs review"), not by what the system did ("blocked"); (4) make the recommended path one keystroke; (5) demote, don't delete, escape hatches.

**Community conventions research** — `cargo`, `eslint`, `pnpm`, `gh`, `vercel`, `stripe`, `terraform plan`+Sentinel: consensus is **yellow + the word `warn`/`warning`** for recoverable validation failures, never red. **No scary Unicode** (`✗`, `✘`) for recoverable cases — reserved for hard failures. **Diagnostics → stderr, payload → stdout** (so `| jq`, `| pbcopy`, `> file` stay clean). **Exit 0 when the user has a clear next action** (eslint warnings, cargo warnings). Always name the next step inline (cargo's `help:` pattern).

#### Recommended rendering for 1.0.3

```
aeo-platform — init

  Almost there: 3 of 3 picks need your approval before we can save the config.

  Setup found 15 strong query candidates for typelessform.com. The strict
  commercial-only validator (used by the AEO scoring model) didn't approve
  the 3 it auto-picked, so we're handing the choice back to you.

  Pipeline                                                              ok
    fetch · brainstorm · filter · score · validate · simulate
    20 generated  ·  15 validated  ·  ~$0.006  ·  45s

  Auto-picks needing review                                       3 of 3
    ~  "enterprise voice form filling platform"
       reason: retrieval-triggered — AI would return guides, not a vendor list
    ~  "voice form filling for e-commerce stores"
       reason: retrieval-triggered — AI would return guides, not a vendor list
    ~  "why voice form doesn't recognise date field"
       reason: parametric-only — AI answers from memory, never lists vendors

  Validated alternatives — pick any 3                            5 ready
    [a]  voice form solution for healthcare clinics            score 90
    [b]  voice form filling for legal firms                    score 90
    [c]  voice form widget versus typed form automation        score 78
    [d]  voice form service vs chatbot form                    score 78
    [e]  voice form widget vs form builder plugin              score 78

  What next?
  > 1  Use top-3 validated alternatives [a][b][c]   (press Enter — recommended)
    2  Pick my own from the list above              type letters, e.g. "a c e"
    3  Choose with shell command                    aeo-platform init --keywords="..."
    4  Keep the auto-picks anyway                   aeo-platform init --force

  > _
```

#### Concrete fix list for 1.0.3

1. **Headline rewrite.** Replace `Cannot auto-recover — 4 query/queries blocked by validator.` with **`Almost there: N of M picks need your approval before we can save the config.`** Lead with the verdict; the operator's pulse drops on line 3.
2. **Section title.** `Blocked:` → **`Auto-picks needing review`**. The validator didn't block the operator's intent — it queued auto-suggestions for review.
3. **Glyph.** `✗` (red, fail) → `~` (default, "almost"). Red and `✗` belong to hard failures only.
4. **Colour palette.**
   - Default/white for body
   - **Dim grey** for the pipeline trace (it's done, it's reference)
   - **Cyan** for the `ok` pipeline badge and `>` cursor (cargo's blue family)
   - **Yellow** only for the 3 review items — npm's `warn`, cargo's `warning:`
   - **Green** reserved for the final "✓ Saved .aeo-tracker.json"
   - **No red anywhere in this path.** Red signals "you broke something", which is false here.
5. **Plain-English reason on each rejected query.** Replace `non-commercial (search_behavior: retrieval-triggered)` with **`reason: retrieval-triggered — AI would return guides, not a vendor list`** (and the analogous one-liner for parametric-only). The taxonomy term is fine as a tag, but it must be paired with a sentence Anna can read.
6. **Dedupe the Blocked list** (linked to `[bug]` above) — by query string before rendering.
7. **One-keystroke default.** The `--yes` flag promised non-interactive completion; the operator who used it expects this. In `--yes` mode with ≥3 validated alternatives score ≥80, **auto-substitute and proceed** (see `[enhancement]` below). In interactive mode, the default action is Enter = "use top-3 validated alternatives", labelled **recommended**.
8. **Numbered options → letter-keyed alternatives.** Numbered options for shell commands look like error codes. Use `[a]`–`[e]` for the alternatives list, then numbered actions only for the four real next-step paths.
9. **Stdout vs stderr.** Move all diagnostic banners (`Checking...`, `Fetching...`, `[brainstorm] done`, the review block) to **stderr**. Stdout reserved for the eventual saved-config summary or `--json` output. Enables `aeo-platform init ... | jq` pipes.
10. **Exit code.** Currently exits 1 on this path. Per cargo / eslint / gh conventions, this is **exit 0** (interactive mode, user has clear next action) or **exit 2** in `--yes` mode where the user explicitly opted out of interaction and we cannot auto-substitute. Never exit 1 — that's "tool broke", which is false.
11. **Drop duplicated marketing copy.** `Your API key never leaves this machine. No telemetry. No analytics.` is fine on first-run but adds noise on subsequent inits. Print once per profile or gate behind `--verbose`.
12. **Verbose-gate pipeline stages.** `[brainstorm] done (20)` / `[filter] done kept=20 rejected=0` / `[score]` / `[validate]` / `[simulate]` — collapse to a single progress line by default; expose full trace under `--verbose`.

#### Migration note

Keep the old shell-command snippets in the help text (`aeo-platform init --keywords="..."` etc.) — power users will copy them. They just shouldn't be the primary call-to-action when a one-keystroke path exists.

---

### [docs] README quickstart should mention `--keywords` alongside `--auto`

Since 1.0.3 `--keywords` is a first-class third mode (zero LLM cost, BYO 3 queries). README's quickstart shows only `--auto`; users discover `--keywords` only by hitting an error panel. Add a one-line mention right after the `--auto` quickstart block:

```
Or supply your own queries (zero LLM cost, no auto-suggest):
  aeo-platform init --yes --brand=YOURBRAND --domain=YOURDOMAIN.COM \
    --keywords="best X for Y,top X 2026,X vs Y"
```

Also update the "Full quickstart for first-time terminal users" section step 6 to mention the choice between `--auto` (LLM brainstorm) and `--keywords` (BYO).

**Why deferred from 1.0.3**: patch should not require README changes per semver convention; bundling with the 1.0.4 UX redesign (which also reshapes the validator-recovery panel where `--keywords` is suggested) keeps documentation and code in sync.

---

### [enhancement] Auto-substitute in --yes mode

When validator blocks all selected queries but has ≥3 validated alternatives
with score ≥80, `--yes` should **auto-substitute** instead of printing
"How to fix — pick one" and exiting. The operator chose `--yes` precisely to
avoid manual intervention.

**Fix**:
- If `blocked >= selected count` AND `alternatives.filter(score >= 80).length >= blocked count` → auto-swap top-N by score.
- Print a single substitution line at the top of the review block:
  `✓ Auto-swapped 3 auto-picks → 3 top-scored alternatives (score ≥80): healthcare clinics, legal firms, widget vs typed form automation`
- Escape hatch: `--no-auto-substitute` for users who want the old behaviour.
- Log the swap to `_summary.json::initSubstitutions` so the report knows queries were swapped (helpful for the diff command in week 2).
- In interactive mode (no `--yes`), this becomes the default `> 1` action (press Enter).

---

### [chore] CLI hygiene pass

Reviewer Mark flagged general CLI conventions worth fixing alongside the validator pass:

- **Glyph audit**: `?` / `✗` are emoji-adjacent. Standardise on labelled prefixes (`warn:`, `note:`, `help:`) or single-char glyphs that match cargo (`!` for warn, `>` for prompt).
- **`--json` mode**: machine-readable output for CI. `terraform`, `kubectl`, `gh` all have one. Required for headless cron usage.
- **Stream discipline**: diagnostics to stderr, results to stdout. Audit every `console.log` in `bin/aeo-tracker.js` against this rule.
- **Exit code map**: document in README — 0 success, 1 generic failure, 2 precondition-not-met (validator gave operator a choice; non-interactive mode without enough alternatives), 3 API errors, 130 user Ctrl-C. Mirror gh / eslint convention.
- **`--verbose` flag**: gate pipeline-stage trace lines behind it. Default output keeps headline + result.

---

### [ux] Placeholder-domain hint

Reviewer Anna's secondary observation: when a user copy-pastes the README quickstart literally (`--brand=YOURBRAND --domain=YOURDOMAIN.COM`), they hit `Auto-suggest failed: fetch failed` with no hint that `YOURDOMAIN.COM` is a placeholder.

**Fix**: maintain a small known-placeholder list (`YOURDOMAIN.COM`, `EXAMPLE.COM`, `BRAND`, `YOURBRAND`, `mybrand.com`). When the supplied `--domain` or `--brand` matches one, print:

```
  Heads up: --domain=YOURDOMAIN.COM looks like a README placeholder.
  Replace it with your real domain (e.g. --domain=acme.io) and re-run.
```

…and exit with code 2 (usage error). This catches the most common first-run mistake before the slow `fetch failed` cycle.

---

## Done

### 1.0.4 — published 2026-05-18

- `[bug · P0]` Pool top-up — when initial pool validation leaves <3 RETRIEVAL queries (cells D pool=1+unclean and F pool=2+unclean), tool autonomously generates missing queries via dedicated LLM call. Caught by newly-created `cli-walkthrough` skill before 1.0.4 reached npm.
- `[bug · P0]` `(validated)` tag in Alternatives pool meant only industry-fit passed — pool now enriched from `v.updatedCache` at panel call-site and filtered through commercial-only (`RETRIEVAL`) before rendering
- `[bug · P0]` Recovery filler templates switched from brand-archetype (`${brand} vs alternatives` etc.) to category-archetype (`best ${category} 2026` etc.), domain-agnostic, with ≤4-word length-guard to reject long marketing-sentence categories from `inferCategory()`
- `[bug · architectural]` Recovery panel option 3 = drop `--yes` and switch to interactive `--manual` (always-works escape hatch for brands too new for LLM context); `--force` demoted to option 4
- Architect-review skill expanded with mandatory scenario-wide audit duty (Step 2 + Step 4); caught Fix A's dead-code premise in REV 1 before implementation

### 1.0.3 — published 2026-05-18

- `[bug · P0 · regression]` Suggested fix commands rejected by the same CLI — systemic across 5 sites; fixed by relaxing precondition + 3 panel rewrites + glob-based static-grep invariant test
- `[bug]` Duplicate query in Blocked list — dedupe in `formatRecoveryPanel` with specificity ranking
- `[bug]` Duplicate `Configured providers:` line — second concatenation removed
- `[bug · P1]` `run-manual` silently skips missing query files — pre-flight 3-file check moved before extractor build for instant diagnostic
- `[bug · P1]` `init --auto --force` degrades trend data — `--force` demoted to last option with visible yellow warning in `validator-recovery`
- `[bug · P2]` `diff --since=DATE` raw error — now lists available dates before `load()` calls
- `[bug · P2]` `crawl-stats` OOMs on large logs — switched to `createReadStream` + `readline` streaming
- First release shipped via the new `/release-flow` skill (plan reviewed by IT-architect agent through 3 revisions before APPROVED, then implementation re-reviewed)

### 1.0.2 — published 2026-05-18

- Provider resilience layer (retry / TPM ledger / scheduler / rate-limits)
- Readline lifecycle fix (singleton `lib/util/prompt.js`)
- Windows quickstart docs (PowerShell + CMD)
- HTTP 408 added to transient classifiers
- Gemini API key moved from URL to `x-goog-api-key` header
- README drops misleading proxy instruction
