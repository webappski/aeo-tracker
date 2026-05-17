# Changelog

All notable changes to `aeo-platform` (formerly `@webappski/aeo-tracker`).

## [1.0.0] — 2026-05-13

**Renamed: `@webappski/aeo-tracker` → `aeo-platform`.** The «tracker» name described only the measurement layer; the tool now spans measure → audit → diagnose → recommend → plan-generate → track. The new package name reflects the full scope.

### Breaking changes

1. **npm package name changed** from `@webappski/aeo-tracker` to `aeo-platform` (bare, unscoped). Existing `npm install @webappski/aeo-tracker` will continue to install the old package but will receive NO new versions on that name. Migrate with:

   ```bash
   npm uninstall -g @webappski/aeo-tracker
   npm install -g aeo-platform
   ```

   Project-dependency users with `^0.3.0` caret in `package.json` will stay on the old buggy 0.3.x branch — manually edit `package.json` to `"aeo-platform": "^1.0.0"`.

2. **CLI command `aeo-tracker` preserved as a built-in alias.** Both `aeo-platform run/init/report` and `aeo-tracker run/init/report` work. Existing scripts and muscle memory unaffected. New documentation prefers `aeo-platform`.

3. **`engines.node` bumped** from `>=18.0.0` to `>=20.0.0` (Node 18 reached EOL April 2025; `pnpm` with `engine-strict=true` refuses install on EOL Node).

4. **Old package `@webappski/aeo-tracker` will be deprecated** on npm 2-4 weeks after `aeo-platform@1.0.0` reaches stability. A patch release on the old name (`0.2.8`) will replace `latest` dist-tag with a stable 0.2.7-based codebase + redirect banner README, so default installs of the old name get a working tool with migration guidance.

### What stays the same

- All CLI command names and flags (via the `aeo-tracker` bin alias)
- All configuration files (`.aeo-tracker.json`)
- All API surfaces (`_summary.json` schema, raw response paths)
- Raw response folder structure (`aeo-responses/YYYY-MM-DD/`)
- Report output folder structure (`aeo-reports/YYYY-MM-DD/`)

**What changed:**

- Package name: `@webappski/aeo-tracker` → `aeo-platform` (bare, no scope)
- New canonical CLI command: `aeo-platform` (alongside backward-compatible `aeo-tracker`)
- `engines.node`: `>=18.0.0` → `>=20.0.0` (Node 18 reached EOL in April 2025; `pnpm` with `engine-strict=true` refuses install on EOL Node)
- README rewritten: hero positions the tool as an AEO/GEO **platform** (audit + diagnose + recommend + plan), not just a tracker
- Maintainer byline updated: Webappski (Organization) + Alex Isa (lead maintainer) — replaces prior personal byline
- Competitor pricing claims removed from README and docs (we describe pricing **model**, not specific amounts — those shift and are not ours to publish)
- Render fixes from the 0.3.x feature release bundled in (see «Bundled fixes» below)

**Migration path for existing users:**

- `npm i -g aeo-platform` — install the new package
- Old `@webappski/aeo-tracker@<1.0.0`: `npm deprecate` flag (eventually) will display a redirect notice on install
- Same-day stable patch on the old name (`@webappski/aeo-tracker@0.2.8`) repoints `latest` dist-tag from buggy `0.3.x` back to the proven `0.2.7` codebase, with a redirect README. Pinned consumers of `0.3.x` are unaffected
- Project-dep users with caret `^0.3.0` stay on the buggy `0.3.x` branch — manually edit `package.json` to `"aeo-platform": "^1.0.0"`

**Bundled fixes (from agent-pass audit work):**

- UVI breakdown popover (`<details>` with `ⓘ` icon) — exposes per-axis math (presence/sentiment/rank/citation, applied weights, contribution, re-norm banner when components null)
- Rank-component honest handling: when no cell has position data, rank is excluded and weights re-normalised; no more hardcoded `50/100` phantom value
- Sentiment composite excludes low-confidence «neutral» tie-breaks; displays effective sample size `n=K high-confidence cells`
- Two-model competitor extractor: category-grounded prompt; retailers-mentioned-as-customers (Amazon/Walmart/Starbucks) no longer flagged as competitors; cross-check splits unverified into a separate bucket with dashed badge
- «Actionable Gaps» section respects the dashed badge for unverified competitors and uses a softened «Cross-check this cell» action
- Outreach denylist hardened: bare-apex entries for developer-hosting domains (`github.io`, `gitlab.io`, `netlify.app`, `vercel.app`, `glitch.me`, `pages.dev`, `web.app`, `firebaseapp.com`); trailing-dot + `www.` normalisation
- Own-domain filter strips `:port`, `?query`, `#fragment` suffixes; LLM action prompts filter own-domain before assembly (no more self-pitch)
- Hero «Citations earned» KPI renamed to «Lift opportunities» with honest framing (the metric measures «cited but not named» — a lift opportunity count, not total citations)
- «Discoverability Score» renamed to «AI-Bot Crawl Readiness» with a caveat that it measures technical access, not actual visibility in AI answers
- «UTM-Tagged Citations» renamed to «Engine-Auto-Tagged Citations» with honest framing (the UTMs are auto-appended by AI engines, not user-configured)
- Trend chart suppressed below 4 runs (statistical noise floor); topic clusters suppressed below 3 (no meaningful clustering at N=1)
- competitorPricing section suppressed when ≥80% of rows are `tier: unknown`
- regionContext block suppressed when `--geo` was not used
- «How your score compares» anchoring baselines removed (no sourced methodology behind the bands)
- Engine-specific actions cards now pull from actual run citations (per engine), with generic playbook only as fallback when an engine has zero citations
- Industry-mismatch panel fires only when ≥30% off-share AND ≥70% of off-category verdicts are `confidence: high` (no more false-positive panel on classifier failures)
- mc-metadata `scores` and `perEngine` delegate to `computeUVI` byte-for-byte (the paste-into-AI JSON brand-context block now matches the markdown UVI exactly)
- Radar polygon Mentions axis uses verified count (`topCompetitors[i].count`); no more discrepancy between bar chart and radar
- Cross-run delta: provider absent in previous run reports «new this run» instead of a fabricated −67pp regression; method-change between runs tagged `mixedMethod`

**Tests:** +95 new test assertions across 8 new files; 30+ test suites pass.

**Why now:** at 101 weekly downloads we are well below the 1500-DL break-even where rename cost compounds; renaming after that point loses real signal. Two independent senior npm-migration audits confirmed the timing.

## [0.3.2] — 2026-05-13

**Re-publish of 0.3.1 with the full intended file set.** The original `npm publish` for `[0.3.1]` packed the working tree before the complete staging was finalised — the tarball missed `lib/report/own-domain.js` (new module) and likely additional parallel-diff fixes that depend on it (`outreach-templates.js::filterOwnDomainFromTopDomains`, `sections.js::topCitedHostsForProvider`/`isDenyListedOutreachHost`, the additive `_summary.json::scores` sub-component fields).

`[0.3.1]` is published on npm but technically broken: `test/own-domain.test.js` references `lib/report/own-domain.js` which is not in the tarball, and the four downstream call-sites that should filter own-domain from outreach surfaces silently fall back to the pre-fix behavior. 0.3.2 is a same-day patch shipping the complete intended `[0.3.1]` scope.

### Fixed (vs published 0.3.1 tarball)

- Ships `lib/report/own-domain.js` (the dependency missing from 0.3.1).
- Ships the full sections.js refactor (own-domain filtering in 4 surfaces, AI-Bot Crawl Readiness rename, sectionBaseline placeholder, UTM by-origin split).
- Ships the mc-metadata.js additive schema expansion (`scores.{presence,sentiment,rank,citation,sample,sentimentSample,rankSample}` + per-engine breakdown).
- Ships the 7 new test files referenced by the [0.3.1] CHANGELOG entry.

### Unchanged

- `[0.3.1]` CHANGELOG entry below describes the intended scope of both releases. No new features in 0.3.2 vs the documented 0.3.1 scope — this is strictly a re-publish to fix the incomplete tarball.

## [0.3.1] — 2026-05-13

Patch release on top of v0.3.0. Two themes: (a) closing the docs-vs-reality drift flagged by an independent persona review (solo founder / agency operator / B2B SaaS lead) — outreach kill-switch was documented as a working feature in 5+ places; (b) fixing a real dogfooding bug where AI suggested the user pitch their own brand, plus surfacing the UVI sub-components for clients consuming `_summary.json` directly. **No breaking changes** — CLI surface unchanged, config schema unchanged, `_summary.json` schema additively extended (consumers reading 0.3.0 fields still work).

### Fixed — own-domain pitching bug (real dogfooding regression)

A run on `typelessform.com` had `topCanonicalSources[]` led by the user's own domain (because AI engines already cite their pages). Without filtering, four downstream surfaces targeted that own domain for outreach:
1. «Actionable Gaps» «What to do» column → *"Get listed on typelessform.com"*
2. «Where to get mentioned» table → first row was typelessform.com
3. «Outreach Email Templates» → drafted *"Hi Typeless Form team"* email
4. «Actions this week» → *"Pitch a guest post on typelessform.com"*

All four surfaces now filter own-domain (incl. www-prefix and any subdomain). Centralised in a new shared module so the four call-sites use the same canonicalisation + subdomain-spoof guard (`foo.com.evil.com` is **not** treated as a subdomain of `foo.com`).

- New module: `lib/report/own-domain.js` — pure helpers `normaliseOwnDomain(host)` and `isOwnDomain(host, ownDomain)`. Handles scheme strip / `www.` strip / trailing slash / path / query / fragment / port. 30 unit tests in `test/own-domain.test.js` including the spoof guard.
- New helper `outreach-templates.js::filterOwnDomainFromTopDomains` — drops own-domain before drafting outreach.
- New helper `sections.js::topCitedHostsForProvider(results, provider, ownDomain, …)` — provider-aware top-host extractor that respects own-domain.
- New helper `sections.js::isDenyListedOutreachHost` — deny-list for hosts that should never be outreach targets (review platforms, search engines, social — additional to own-domain).
- `bin/aeo-tracker.js` post-run summary now uses `externalSources` instead of raw `topCanonicalSources` when surfacing pitch targets to the operator.

### Added — UVI sub-components in `_summary.json::scores`

Previously, `_summary.json::scores` exposed only `uvi` (composite 0–100). Consumers reading `_summary.json` directly (BI pipelines, paste-into-AI brand-context block, downstream dashboards) had no way to see *why* a UVI moved between runs. Now `scores` additively exposes:

- `presence`, `sentiment`, `rank`, `citation` — the 4 sub-components UVI is computed from (each 0–100).
- `sample`, `sentimentSample`, `rankSample` — denominators used to compute each sub-component, so consumers can tell a sub-score apart from "not enough data yet" cases.
- `scores.perEngine[].{presence, sentiment, rank, citation}` — same breakdown per engine, so the paste-into-AI 30-mission plan generator can ground recommendations in which engine is the weakest on which axis.

Schema change is **additive only**. 0.3.0 consumers that read `scores.uvi` keep working without changes. New fields are computed inside `lib/report/mc-metadata.js::scores()` using helpers from `lib/report/visibility-index.js`.

### Added — sections.js refinements

- `sectionBaseline()` — placeholder section for the first run, when historical comparisons can't be computed yet. Surfaces "what to expect next week" instead of empty blocks.
- `trendNotYetPlaceholder(runCount)` — friendlier copy when the 8-week trend chart can't render (auto-replaces stale "Flat at zero" placeholder).
- `splitUtmByOrigin(utm)` — separates UTM citations into own-domain vs external buckets so the UTM section doesn't conflate "your link got cited" with "someone else's link got cited".
- `isSignalBearingSentiment(s)` (in `lib/report/visibility-index.js`) — guards UVI sentiment sub-component against `null` / `'unknown'` sentiment labels that would otherwise pollute the average.

### Added — coverage tests for previously-untested surfaces

7 new test files (~600 LOC), all green on `npm test`:

- `test/own-domain.test.js` — 30 unit tests for the new pure helpers, including subdomain-spoof safety.
- `test/diff.test.js` — `lib/diff.js` delta computation.
- `test/sections-recommendations.test.js` — actions section grounded in real data fields.
- `test/sections-copy.test.js` — guards against stale or misleading prose in section renderers.
- `test/sections-data-integrity.test.js` — verifies sections never reference undefined `summary.*` fields.
- `test/report-empty-blocks.test.js` — verifies empty-block placeholders render without crashing on first-run data.
- `test/mc-metadata-scores.test.js` — guards the new sub-component schema (regression test for the additive expansion).

### Fixed — documentation drift

- **Outreach kill-switch disclosure.** The outreach-template generator caches drafts in `_summary.json::outreachTemplates` but rendering in HTML + Markdown is muted via kill-switch (`html.js:367`, `markdown.js:84`) — see note under [0.3.0] below. **0.3.0 README documented the feature in 5+ places without warning the user about the muted rendering, including a screenshot caption claiming to show outreach-draft cards that no fresh install can produce.** README §04 Citations now carries a yellow callout explaining the kill-switch and the workaround (pitch top-3 domains by hand using citation context). README §04 Citations tail screenshot caption flagged with "rendering muted in 0.3.x" qualifier. Re-enables in 0.3.1+ once the publisher / competitor / community domain-type classifier ships.
- **Hero example replaced.** Line 41 hero pitch used an "email editors of firstpagesage.com to get added to their AEO agency list — cited 2× by AI this run" example — which is literally the killed feature. Replaced with a live-feature example referencing the `05 Actions` mission stack instead.
- **Listicle-pitch KPI honesty.** README §01 Overview previously described the listicle-pitch KPI as "surfaces the canonical sources that get cited 2×+ across engines (the pages your outreach budget should target)" — implying URLs the user can immediately pitch. Reality is a count + ratio. Rephrased to describe what 0.3.x ships (descriptive count) with explicit note that the actionable URL grid + `[Copy pitch]` + state tracking lands in 0.4.
- **Discoverability Score → AI-Bot Crawl Readiness rename.** The 0-100 composite over crawlability inputs (robots 30% · bots-not-blocked 25% · sitemap 25% · llms.txt 20%) was named «Discoverability Score» in 0.3.0 — implying it measured discoverability in answer engines. It only measures TECHNICAL access for AI crawlers (robots.txt allows / sitemap present / llms.txt present), not actual answer-pool inclusion (which is driven by off-page authority — Wikipedia / Reddit / review platforms). Renamed to «AI-Bot Crawl Readiness» across the HTML/markdown reports + README description, with explicit note disambiguating it from answer-pool inclusion.
- **Security & Privacy box** added to README `Key facts` — explicit one-liner on no telemetry, no traffic to webappski.com, API keys never written to disk, no SOC2 (single-developer tool — bus-factor honesty).
- **Known limitations in 0.3.x section** added below `Key facts` — surfaces both the outreach kill-switch and the listicle KPI gap before installation, not after.
- **CHANGELOG narrative competitor list** aligned with README's 11 commercial vendors (Otterly / Profound / Peec / Bluefish / AthenaHQ / Goodie / HubSpot AEO Grader / Evertune / Ahrefs Brand Radar / Semrush AI Toolkit / Discovered Labs) — previous draft mentioned Wellows / OneGlanse / Brandlight / Knowatoa which weren't in README.
- **CHANGELOG `[0.3.0]` heading date** corrected from `2026-05-09` (internal milestone) to `2026-05-13` (actual npm publish date).
- **CODING_STANDARDS.md** — new «Template literals» section documenting the backtick-in-comment trap (a stray backtick inside `<!-- … -->` or `/* … */` inside a template-literal-returning function closes the template literal and produces a misleading SyntaxError far below).

### Changed — bridge card redesign (HTML report promote-card)

- DIY and Webappski end-nodes now have parallel geometry (256×88 each) — DIY was previously 168×48 and read as a "lesser option" visually, contradicting the open-source-first marketing.
- Status pills inside each box: **FREE** top-left for DIY, **PRE-RELEASE** top-left for Webappski.
- `?` chip top-right INSIDE each box — replaces the orphan «↓ details · hover» footnote text that was previously positioned BELOW the box. Tap and hover both supported via the existing `aria-haspopup="true"` `<button>` overlay.
- Webappski meta-line «pre-release · $29 per plan · 30 missions» (285px wide) previously overflowed the 192px box and read as detached; now fits comfortably inside the 256px box, with `pre-release` lifted to the pill.
- `priceLabel` default `'$29 once'` → `'$29 per plan'` (kills the «once» / «one-time» / «at-launch-time» semantic collision).
- `priceMetaLine` default `'pre-release · $29 once'` → `'$29 per plan · 30 missions'`.
- Footer line `'$29 once when it ships · demo + signup on the same page.'` → `'$29 per plan · one-time, no subscription · demo + signup on the linked page.'` (resolves «same page» antecedent ambiguity).

### Changed — package.json

- `version` bumped to `0.3.1`.
- 7 new test scripts wired into the root `test` chain.
- Description references «30-mission AEO plan (≈1–3 hours per mission, work at your pace)» instead of bare «30-day plan» (avoids the «30 days × 8 hours = 240 hours» misreading).

## [0.3.0] — 2026-05-13

Major feature release on top of v0.2.7. **No breaking changes** to the v0.2.x CLI surface, config schema, or `_summary.json` consumers. Single jump on npm covering an internal dev cycle (tracked locally as 0.3.0 → 0.4.0 → 0.5.0 → 0.6.0 between 2026-04-23 and 2026-04-27, plus the security review and `--depth` work in early May, finalised + published 2026-05-13).

The core narrative: catch up to hosted competitors (Otterly, Profound, Peec.ai, Bluefish, AthenaHQ, Goodie, HubSpot AEO Grader, Evertune, Ahrefs Brand Radar, Semrush AI Toolkit, Discovered Labs) on capability without giving up the open-source / direct-API positioning.

### Costs (read before running)

- `aeo-tracker run` LLM cost is unchanged unless queries trigger brand mentions. Each cell with a mention now adds a two-model sentiment classification call: **~$0.0008 per mention** (skip-on-no-mention, cached in `_summary.json`). Typical run of 9 cells with 3 mentions: **+$0.0024**.
- `aeo-tracker report` adds **~$0.003 one-off** for outreach-template drafts to the top-3 cited domains (single classify-tier LLM call, cached in `_summary.json::outreachTemplates` — re-running `report` does **not** re-spend).
- `aeo-tracker run --geo=us,uk,de,...` multiplies LLM cost linearly by region count.
- `aeo-tracker run --depth=full` doubles LLM cost (web pass + training-data pass).
- All other new modules — crawlability audit, page signals, entity-graph reciprocity, competitor pricing tier, region context, response freshness, ads detector, UTM tracker, topic clusters — are **$0** (no LLM calls). Wikipedia / Reddit / pricing-page checks use free public APIs / direct HTTP.
- Skip optional `report` fetches with `--no-authority` (Wikipedia + Reddit), `--no-page-signals`, `--no-entity-graph`, `--no-pricing` if you are behind a corporate VPN, hitting rate limits, or want a fully offline report.

### Added — analysis & report sections

- **Brand sentiment scoring (two-model cross-check).** Per-cell `positive | neutral | negative` label + one-line rationale + confidence tier (`high` / `low` / `single-model`). Reuses the same `gpt-5.4-mini + gemini-2.5-flash` pair as competitor extraction. ~$0.0008 per cell with a brand mention; skipped on `mention === 'no' | 'error'`. Stored as `results[].sentiment`. New module: `lib/report/sentiment-classify.js`.
- **Domain share-of-voice table.** Aggregates `canonicalCitations` by hostname → top-10 publishers with citation count + share %. New summary field `topDomains`; new section `sectionDomainShareOfVoice()`. Backwards-compat: section computes on the fly for older snapshots.
- **Historical 8-week trend chart.** Wide-format sparkline over last 8 snapshots with date+score tick row below. Auto-skipped on first run.
- **Outreach email templates for top-3 cited domains.** One classify-tier LLM call drafts a short, specific email (subject < 60 chars, body < 150 words, soft CTA) per top-3 publisher. Cached in `_summary.json::outreachTemplates`. New module: `lib/report/outreach-templates.js`.
  - **Note (2026-05-13) — rendering disabled in 0.3.0 final cut.** The pitch generator currently treats every domain in the citation pool as a publisher, which means direct competitors (scrunch.io, minonta.com, peec.ai etc.) get drafted outreach emails alongside legitimate listicle editors — not actionable advice. The cache layer (`_summary.json::outreachTemplates`) still populates so no data is lost; rendering in both HTML and Markdown reports is muted via a kill-switch (`lib/report/html.js:367`, `lib/report/markdown.js:84`). Re-enables in 0.3.1+ once the publisher / competitor / community domain-type classifier ships. See `TECH_DEBT.md` for the restoration path.
- **Competitor 4-axis radar.** Side-by-side radars (presence / sentiment / rank / mentions) for the user's brand vs top-3 competitors.
- **AI-bot crawlability audit (zero-LLM).** Pure-HTTP audit of `/robots.txt`, `/llms.txt`, `/sitemap.xml`. Maps GPTBot, OAI-SearchBot, ChatGPT-User, Google-Extended, GoogleOther, ClaudeBot, Claude-Web, anthropic-ai, PerplexityBot, Perplexity-User, CCBot, Bytespider to one of `allowed | blocked | partial | unspecified`. Cost: zero (no LLM, ~3 HTTPS GETs). New module: `lib/report/crawlability-audit.js`.
- **Domain category breakdown.** Static rule-based classifier mapping topDomains to semantic buckets (Reviews / Forums / Q&A / News / Reference / Social / Agency / Blog / Docs / Vendor / Gov-Edu / Other). Per-row outreach hint. New module: `lib/report/domain-category.js`.
- **Funnel / intent tags on queries.** `.aeo-tracker.json::queries[]` now accepts both string form (legacy) and `{ q, tag }` form. Visibility split per tag in a new section. Auto-hidden when no tags defined. New module: `lib/config/queries-normalize.js`.
- **Actionable gap matrix.** Top-8 cells where competitors were cited but the user wasn't, each with a one-line concrete action grounded in this run's data (cell host / topDomain / comparison-page suggestion).
- **Unified Visibility Index (UVI).** Single 0-100 composite score (presence 35% · sentiment 25% · rank 20% · citation 20%). Inspired by Rankability's SPI but open — every weight is in `lib/report/visibility-index.js`, every component is rendered alongside the composite.
- **Discoverability Score.** 0-100 composite derived from crawlability inputs (robots 30% · bots-not-blocked 25% · sitemap 25% · llms.txt 20%). No extra fetches.
- **Topical Visibility Clusters.** Rule-based query grouping by most-frequent shared content word. Visibility per cluster. Zero-LLM. New module: `lib/report/topic-cluster.js`.
- **Authority-source presence with dynamic profile detection.** Wikipedia REST API + Reddit search JSON checks by default — free public APIs, no auth. Cached in `_summary.json::authorityPresence`. Disambiguation pages flagged separately. **Dev-tool / AEO-studio brands additionally get a GitHub row** (with disambiguation guard — `owner === brandSlug || owner === domainRoot` — to avoid surfacing wrong repos for popular brand names like Spotify). Detection inputs: category text → pageSignals H1/H2 fallback → domain TLD. Caveat note appears above the table for dev-tool segment («Wikipedia and Reddit are rarely populated for dev tools — the GitHub row below carries the meaningful signal»). Schema is **additive** — old `{wikipedia, reddit}` snapshots render via backwards-compat fallback. Optional `GITHUB_TOKEN` env var lifts unauth 60/h limit to 5000/h. New modules: `lib/report/authority-presence.js`, `lib/report/authority-profiles.js`, `lib/report/authority-github.js`, `lib/report/_http.js` (shared fetch util). New tests: `test/authority-profiles.test.js`, `test/authority-github.test.js`, `test/authority-legacy-shape.test.js`.
- **AI Ads / sponsored-content detector.** Heuristic precision-over-recall scanner for inline disclosure markers (`Sponsored`, `[paid]`, `(advertisement)`) and ad-network domain citations (DoubleClick, Taboola, Outbrain, Criteo). New module: `lib/report/ads-detector.js`.
- **UTM citation tracker.** Surfaces UTM-tagged URLs from your own domain when AI engines cite them. Aggregates by `utm_source` / `utm_campaign` / engine. New module: `lib/report/utm-tracker.js`.
- **Top-domains aggregation helper.** `lib/report/top-domains.js` — `computeTopDomains()` — replaces duplicated logic in `cmdRun` + `cmdRunManual`.

### Added — new CLI flags & commands

- **`aeo-tracker run --geo=us,uk,de,...`** — runs every query under multiple regional contexts. 12 regions: `us, uk, de, fr, es, it, ca, au, in, br, jp, nl`. Cost multiplies linearly with region count; warned explicitly before spending. Region tag on each result + region suffix in raw response filenames. Manual-paste path normalises queries but does not loop regions. Differentiation: most paid competitors are single-region or charge for regional coverage; we're free.
- **`aeo-tracker run --depth=<web|full|auto>`** — selects how many LLM passes per cell.
  - `web` (default) — single web-search pass. Identical to v0.2.7 behaviour.
  - `full` — adds a second training-data pass (no web search) where supported (OpenAI / Gemini / Anthropic). Perplexity is search-only by design and is auto-skipped. Cost ~2× web-only. Distinguishes "absent from current SERPs" from "absent from training corpus".
  - `auto` — defaults to `web`; prompts when the last training-data baseline is older than 14 days (or never run). Lets corpus drift get re-measured at a sparse cadence without weekly waste.
  - New module: `lib/providers/non-search-model.js` — `deriveTrainingModel()` strips `-search-api` / `-search-preview[-YYYY-MM-DD]` suffixes for OpenAI; Gemini and Anthropic toggle web-search via request flags so the model name stays the same.
  - Tracked in `_summary.json::lastFullRun` (date of most recent `depth=full` run) for the auto-prompt logic.
- **`aeo-tracker export [--format=csv|json] [--output=path]`** — flatten every `_summary.json` snapshot into a tabular file for BI ingestion (Looker Studio, Google Sheets, Tableau). One row per result cell with 17 columns. RFC 4180 quoting. New module: `lib/report/csv-export.js`.
- **`aeo-tracker crawl-stats --log-file=path`** — parse Apache/nginx access logs (Combined Log Format + CLF) and count AI-bot crawl frequency per bot, with first-seen / last-seen / top-5 paths. New module: `lib/report/log-parser.js`.
- **`aeo-tracker report --refresh-cache <fields>`** — force-refresh cached fields in `_summary.json` before the report runs, so site-changed signals (own-domain crawl, authority presence, robots.txt, etc.) refetch instead of reading stale data. CSV format or `all` shortcut: `aeo-tracker report --refresh-cache=pageSignals,authorityPresence` or `--refresh-cache=all`. Invalid field names fail fast with the full valid-fields list. Refreshable fields: `pageSignals`, `authorityPresence`, `crawlability`, `citationClassification`, `outreachTemplates`, `entityGraph`, `competitorPricing`, `llmActions`, `adsDetected`.

### Added — HTML report (editorial bento layout)

`aeo-tracker report --html` produces a single-file editorial-bento report: KPI hero with animated UVI counter, sticky outline rail with scroll-spy, six bento sections (`#overview` / `#visibility` / `#competitors` / `#citations` / `#actions` / `#diagnostics`), promote row (planner-prompt bridge + sponsor card), footer reprise, print stylesheet.

- **Self-hosted variable fonts.** Three latin-subset variable woff2 files bundled inside the npm package (Fraunces display serif, Geist sans, JetBrains Mono — all SIL OFL 1.1) are base64-embedded at render time. Zero CDN dependency; the report works offline, in email, from `file://`. Total ~170KB per `report.html`. Loader: `lib/report/fonts/index.js`. Provenance + license: `lib/report/fonts/LICENSE.md`.
- **Hero KPI strip** — UVI / mention rate / citations / top competitor in a 4-cell bento. UVI counts 0 → target on first paint with `prefers-reduced-motion` guard. Hero narrative is context-aware: 4 templates pick based on `(mentions, citations)` tuple — `cited but never named` is the actionable lift case (engines see your domain, just haven't promoted it to a named brand).
- **Promote row** — bridge card (planner prompt copy) on the left, sponsor card on the right. Bridge has 5 states (`success` / `limited` / `expand` / `stale` / `fallback`) selected by `(daysSinceRun, queryCount, navigator.clipboard)`. Success path shows a top-center toast on copy, not a modal. Pre-flight gate disables the button when `queryCount < 10` or `daysSinceRun > 30`; tooltip on hover explains which condition failed and the exact CLI command to fix.
- **Bento sections** — six numbered panels of `.cell.span-N` (2/3/4/6 column widths). Empty sections still render their numbered header + dashed `.cell-empty` placeholder so the rail stays continuous (no `01 02 03 — 05 06` holes that read as broken builds).
- **Per-engine color tokens with fallback chain** — `--eng-gpt` (green), `--eng-gem` (blue), `--eng-cla` (purple), `--eng-perp` (teal). Unknown providers fall through `var(--c, var(--ink-3))`.
- **Section content:**
  - `01 Overview` — score trend chart (in-place SVG with axes + annotation), listicle-pitch KPI, topic cluster bars, top-3 gaps preview.
  - `02 Visibility` — per-engine cards, query × engine matrix (Mention/Position/Sentiment sub-toggle), regions cell when `--geo` was used, verbatim quotes when populated.
  - `03 Competitors` — most-named brands list (dark cell) + 4-axis radar.
  - `04 Citations` — domain share-of-voice with own-domain marker, by-category breakdown, outreach drafts.
  - `05 Actions` — heuristic day-by-day plan (Day labels with Week-fallback when distribution is skewed; chip hidden entirely when uncomputable).
  - `06 Diagnostics` — site-readiness composite, authority presence, per-engine session cost, geo indicator, AI ads, UTM citations.
- **Footer reprise** — Mission Control CTA only when bridge metadata was provided.
- **Print stylesheet** — every section stacks naturally for PDF export; rail/footer-reprise hidden, ghost SVG hidden, dark cells inverted.
- **Stale artifact cleanup** — `aeo-tracker report --html` sweeps orphaned `report.{md,html}` from older date dirs in `aeo-reports/` so post-rewrite layout drift can't mislead a reader who opens the wrong file.

### Changed — visual redesign (editorial bento, canonical pass)

Pixel-aligned to the v2 editorial-bento prototype (`handoff 3/templates/`). No structural changes to data flow, schema, or section order — purely typography, spacing, and component-shape adjustments.

- **Canonical CSS lifted into `renderCss()`.** Stylesheet now mirrors `templates/styles.css` verbatim: `.mast-title` jumps to 64px display weight 300 with `--opsz 144`, hero number to 180px with `--opsz 144 --SOFT 100` (was 168px), engine-pill animation (`@keyframes pulse`), `.eng-pill` shrinks to 8px with shadowed glow, hero card gets 20px radius + radial accent gradient + 38/40 padding, `.rail` becomes a sticky 50-z bar with full-width backdrop-blur and 3px scaleX accent underline (was 1px border-bottom), `.cell` borders bump to 16px / padding 22-24, `.eng-card` gets a top accent strip via `::before`, `.matrix-toggle` becomes a dark-pill segmented control. `.btn-solid` (ink-on-paper) joins `.btn-accent` and `.btn-ghost`.
- **Combined 4-axis radar.** Section 03 (Competitors) replaces the four per-brand radar grid with a single overlay chart: brand polygon (orange) over Top-N competitor average (dark, fill-opacity 0.18). Top-N average is per-axis arithmetic mean of the top-3 competitors by mentions count; if fewer than 3 are present, averages over all available (no zero-padding). New helper: `lib/svg/combined-radar.js` (~50 LoC, viewBox 0 0 280 240, hand-drawn polygons matching canonical reference). Headline branches off the gap: «Behind on every axis», «Ahead on N of 4 axes», «Mixed vs top-3 avg».
- **MC bridge wrapper aligned with canonical class names.** Outer element is now `<article class="promote-card bridge mc-bridge mc-bridge-compact" id="mc-bridge">` (was `<section class="mc-bridge mc-bridge-compact">`). The 5-state machine (`success` / `limited` / `expand` / `stale` / `fallback`), all IDs targeted by `bridgeJs`, and the `[data-mc-trigger]` delegation handler are unchanged. Compact-variant inner padding zeroed because the outer `.promote-card` now provides the 24×26 padding.
- **Footer-reprise + colophon refined.** Footer reprise picks up a 56px top margin, 28×32 padding, 16px radius, accent radial-gradient on the right edge, and the heading climbs to 22px display; colophon spacing tightens to 12px gap with `--line-strong` separator dot.

- **Markdown → HTML converter** for legacy section markdown (`sectionDomainShareOfVoice` etc.). Zero-deps, `lib/report/markdown-to-html.js`. Handles headers, pipe tables, bold/italic/code/links, blockquotes, bullet lists, inline raw HTML pass-through.
- `renderHtml(summary, snapshots, opts)` — second arg unlocks markdown sections. `opts.mcMetadata` enables the bridge.

### Changed

- **`aeo-tracker report` now writes the bento HTML by default and opens it in the browser.** Both `report.md` and `report.html` are written every time. Use `--no-html` to skip the HTML write + browser open (useful for CI / email-only flows). The legacy markdown→TMP-HTML preview path (and the undocumented `aeo-tracker preview` command) was removed — the single-file bento HTML is the canonical view. The `--html` flag is kept as a no-op so existing scripts keep working.
- **`extractWithTwoModels` + `classifySentimentWithTwoModels` run in parallel** via `Promise.all` per cell (previously sequential). Halves the per-cell wall-clock for runs with mentions.
- **`persistSnapshot()` helper** centralises atomic `_summary.json` writes (tmp + rename) — replaces 5 inline duplicated blocks across cache writers (citation classification, LLM actions, authority, crawlability, outreach). Random suffix is now `pid+Date.now()+randomBytes(4)` to avoid collisions on double-press.
- **Region loop in `cmdRun`** properly indented; skipKey format unified to 5-component `query:region:provider:model:mode` in both load and lookup paths.
- **Repository URL** consolidated under the `webappski` GitHub organization across README, error panels, help text.
- **Authority block CLI log line** changed from «Checking Wikipedia + Reddit for X…» to «Checking authority signals for X…» (now includes GitHub when dev-tool profile fires).
- **Authority section header copy:** «Wikipedia and Reddit are two off-page signals…» → «Off-page signals AI engines weight heavily…» (segment-neutral, since dev-tool brands now also surface GitHub).
- **`bin/aeo-tracker.js` execution order:** page-signals crawl now runs **before** the authority block (was after) — authority profile detection reads pageSignals H1/H2 as a category proxy.

### Fixed

- **TDZ crash on `aeo-tracker run --geo=...`.** Cost-warn line referenced `activeProviders.length` before the const declaration. Moved warning to fire after provider discovery. Reproducer in `/tmp/geo_crash.mjs` confirmed the fix.
- **Cache-resume mismatch on non-geo runs.** Existing-summary load built 3-component skipKeys but the run-loop lookup used 4-component keys — non-geo runs lost resume-after-error behaviour silently. Now both sides use a 5-component key including `mode`.
- **Discoverability note misleading.** Showed `allowedCount/total` while the score formula used `notBlocked = allowed + partial + unspecified`. A site with no robots.txt would score 100/100 but the note read `0/12 bots not blocked`. Note now matches the formula.
- **`parseGeoFlag` inconsistent return shape.** Returned bare `[]` for falsy input vs `{ regions, invalid }` for valid. Consistent shape now.
- **Reddit query escape.** `brand` containing embedded `"` produced an unbalanced quoted search. Strips quotes before wrapping multi-word brand names.

### Security

- **XSS hardening for HTML report.** `escMd()` helper (escapes `& < >`) applied to every user / LLM / third-party data interpolation in `lib/report/sections.js`: brand, queryText, competitor names, sentiment rationale, outreach template fields (subject / body / why / host), Wikipedia extract, Reddit subreddit names, UTM source/medium/campaign, ad sample snippets, topic cluster examples, region labels, industry classifier output.
- **URL scheme allowlist in markdown→HTML.** `isSafeUrl()` permits only `https?:`, `mailto:`, `tel:`, anchors and relative paths in `[label](url)`. `javascript:`, `data:`, `vbscript:` are rewritten to `#`.
- **Idempotent label escape.** `escapeHtmlIdempotent()` on link-label content — escapes raw `<` and `>` for defence-in-depth without double-encoding pre-escaped `&amp;` from upstream `escMd()`.

### Tooling

- `package.json` bumped `0.2.7 → 0.3.0`.
- 23 new test scripts wired into root `test`: `test:sentiment`, `test:outreach`, `test:crawlability`, `test:category`, `test:queries`, `test:geo`, `test:mdhtml`, `test:htmlrender`, `test:uvi`, `test:topics`, `test:csv`, `test:logs`, `test:authority`, `test:ads`, `test:utm`, `test:topdomains`, `test:depth`. Plus 4 regression tests for XSS hardening and URL scheme allowlist in `test:mdhtml`.
- `test:imports` extended with all 16 new modules (`sentiment-classify`, `outreach-templates`, `crawlability-audit`, `domain-category`, `geo-context`, `markdown-to-html`, `visibility-index`, `topic-cluster`, `csv-export`, `log-parser`, `authority-presence`, `ads-detector`, `utm-tracker`, `queries-normalize`, `top-domains`, `non-search-model`).
- `--help` documents `--geo`, `--depth`, `aeo-tracker export`, `aeo-tracker crawl-stats`.

**All 25 test suites green.**

---

> Internal dev-cycle history (NOT separate npm releases — collapsed into 0.3.0 above, kept here for git-archaeology only):
> - 2026-04-27 — internal milestone "0.3.0" (sentiment, share-of-voice, trend, outreach, competitor radar)
> - 2026-04-27 — internal milestone "0.4.0" (crawlability, domain categories, funnel tags, actionable gaps, `--geo`)
> - 2026-04-27 — internal milestone "0.5.0" (UVI, discoverability score, topic clusters, markdown→HTML bridge)
> - 2026-04-27 — internal milestone "0.6.0" (CSV export, crawl-stats, authority presence, ads detector, UTM tracker)
> - 2026-05-04 — security review pass (XSS hardening) + `--depth` feature

## [0.2.5] — 2026-04-23

Patch release. **No breaking changes.** Two UX quality-of-life improvements surfaced by dogfood testing of 0.2.4.

### Added — live TTY spinner during long pipeline phases

Previously: `init --auto` printed `[brainstorm] started` and then sat silently for 10+ seconds while the LLM worked. Users could not distinguish "working" from "network hang" — a poor signal for a 51-second pipeline.

**Fix — `lib/util/spinner.js`:** a TTY-aware spinner renders a live, in-place progress frame with elapsed counter between every `started` and `done`/`failed`/`skipped` event from `research()`. Wired into both `init --auto` and `init --queries-only` call sites via a new `makePipelineReporter(spinner)` helper — the existing `logPhase` callback shape and final-line formatting are preserved byte-for-byte.

**Design constraints:**
- **TTY-only.** `process.stdout.isTTY === false` (CI, pipes, `--yes` in a script) → all spinner methods are no-op; the original flat log emits unchanged, keeping logs grep-able.
- **`NO_COLOR=1` respected.** Drops the Unicode braille frames for a cycling ASCII dots fallback (`.  ` / `.. ` / `...`).
- **Zero dependencies.** Raw `process.stdout.write` with `\r\x1b[2K` clear-line sequences.
- **SIGINT cleanup.** Registers a one-shot handler so Ctrl+C doesn't leave a half-rendered line in the terminal.

**10 new tests** in `test/spinner.test.js`: `formatElapsed` (ms/s/m formatting), non-TTY no-op with stream capture, `NO_COLOR` ASCII fallback, Unicode + dim-ANSI color mode, final-line emission (with and without trailing newline), clean transition between phases.

### Added — "Next" hint after `run` and `run-manual`

Mirrors the existing post-`init` convention (`Next: aeo-tracker run`). After a successful `run` (exitCode 0/1/2), the command now prints:

```
Next: aeo-tracker report --html  (or 'aeo-tracker report' for markdown-only)
```

Guards:
- **Skipped on exitCode 3** (all engines errored) — no data to report; the `all-engines-failed` panel has already given the user next steps
- **Skipped in `--json` mode** — programmatic consumers parse JSON; a hint line would corrupt their pipeline

Philosophical choice: **no auto-run** of `report --html` after `run`. Reasons: `run` often lives in CI/cron where an HTML file is useless; auto-open browser hangs on headless machines; `run && report --html` as an explicit UNIX chain is the convention the README already teaches. The hint is the least-surprise nudge.

**159 total tests green** (149 + 10 new).

## [0.2.4] — 2026-04-23

Patch release. **No breaking changes.** Extends the 0.2.2 actionable-panel philosophy from provider errors into the validator gate — the last hard-abort path in `init --auto`.

### Added — validator auto-recovery

Previously: `init --auto` ran the research pipeline (~51 sec, ~$0.006), produced 3 selected queries + up to 5 validated alternatives in the `candidatePool`, then sent the 3 queries through the commercial-only validator. If the validator blocked any query (e.g. a `problem`-intent query that produces tutorial-style answers rather than a vendor list), init aborted — discarding the 5 already-validated alternatives and forcing the user to copy-paste queries into `--keywords` and rerun the whole pipeline.

This violated the no-silent-fatal-aborts rule (established in 0.2.2). The recovery was data-available but logic-absent.

**Fix — `lib/init/validator-recovery.js`:**

1. **Intent-diversity auto-promotion.** When the validator blocks N queries and `candidatePool` contains N unused validated alternatives, init picks replacements that maximize intent-bucket diversity in the final 3-query set. Rule: highest-scored alternative with an intent bucket not already present in the surviving (non-blocked) queries, falling back to highest-score-any when no bucket diversity is available. For the typelessform case — blocked=`problem` with pool=`[vertical:90, comparison:78×4]` — the tool skips `vertical:90` (already covered by a surviving query) and picks `comparison:78`, yielding a final set with 3 unique intents.

2. **`--yes` (non-interactive) behavior.** Single blocker + recoverable → silent auto-promote with a warning line disclosing the measurement-semantics shift (per senior review: *"measurement shifts from problem→comparison — your visibility score will track a different question than you intended"*). Multi-blocker → actionable panel with a pre-filled `--keywords="..."` command built from the validated pool (safer default — user reviews substitutions before rerunning).

3. **TTY (interactive) behavior.** Numbered prompt per blocker: 4 options `[1-4/m/a]` with Enter = recommended (highest-intent-diversity pick). No `[f] keep original` — global `--force` covers that path, reducing prompt clutter per senior review.

4. **Scope discipline — recovery is narrow by design.** Only `informationalIssues` blockers (wrong intent / `search_behavior !== 'retrieval-triggered'`) are auto-recoverable. `staticIssues` (acronym tripwire) and `llmIssues` (low-confidence verdicts) fall through to the actionable panel — a substitution may introduce the same problem, so silent swap is unsafe. The type guard `isRecoverable(blocker)` gates this.

5. **Re-validation is free.** Substituted queries come from the pipeline's own validationCache, so the second `runTwoStageValidation` call hits the cache for every query — ~0ms, $0.

6. **`runValidationFlow` stays untouched structurally.** Added one opt-in flag `returnBlockersInsteadOfAbort` (default `false`, fully backward-compatible for the 3 existing call sites). Recovery is a new wrapper `runValidationWithRecovery` in `bin/aeo-tracker.js` — wrap, not refactor.

**20 new tests** in `test/validator-recovery.test.js`: `isRecoverable` type-guard branches (informational vs static vs llm), `tryAutoRecover` intent-diversity ranking (1-blocker, 2-blockers, pool-exhausted, empty-pool, duplicate-in-queries, no-intent-data fallback), `formatRecoveryPanel` output shape (pre-filled --keywords from pool, editable templates when pool empty, --force + --category hints, static/llm blocker reason rendering), `formatAutoPromoteWarning` measurement-shift disclosure, `promptBlockedQueryReplacement` all 5 branches (Enter-default, numeric pick, `[m]` manual, `[a]` abort, typo → fallback to recommended). Full suite: **149 tests green**.

### Added — `config_queryIntents` persistence for recovery

The research pipeline's `selectResult.selected[].candidate.intent` now persists in-memory (`config_queryIntents` parallel to `queries`) so validator-recovery can enforce intent-diversity ranking. Not written to `.aeo-tracker.json` — it's transient state, regenerated on next `init`.

## [0.2.3] — 2026-04-23

Republish of the 0.2.2 payload. The `0.2.2` slot on npm was occupied by an earlier partial publish, so the full resilience + error-coverage release ships under `0.2.3`. **No code differences vs the intended 0.2.2** — same tests (129/129 green), same features, same config. See [0.2.2 notes](#022--2026-04-23) below for the complete changelog.

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
- **GitHub URL in HTML report footer** corrected (`webappski/aeo-tracker` → `webappski/aeo-tracker`).
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

**Fields retained for backward compatibility:** old configs with a `competitors: [...]` field are still readable (field is silently ignored — competitor detection is now fully automatic via the two-model extractor). Missing `category` and `validationCache` fields fall back safely. Outdated model names in `providers[].model` (e.g. `gpt-4o-search-preview`) are auto-replaced by the latest available model via `discoverModels` at run start — no user action needed. (Note: this auto-replace behaviour was later removed; current versions require `aeo-platform init` to refresh model selection.)

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

> _Earlier development history (pre-2026-04-23 internal version-numbering experiments) is archived in git log only. Those entries used non-canonical version numbers that were later reset before the v0.2.0 npm publishing line._
