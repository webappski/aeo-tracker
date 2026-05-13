# Tech Debt — aeo-tracker

Tracked deviations from `CODING_STANDARDS.md`. Each entry: source, scope, why it isn't fixed yet, what makes the fix safe to attempt.

The `npm run test:design-lint` job surfaces design-system regressions automatically — soft-warns for items listed here, hard-fails for new violations in cleaned-up files.

## Active items

### 1. File sizes above 300-line default

Allowed exceptions per `CODING_STANDARDS.md`:

| File | Lines (approx.) | Status |
|---|---|---|
| `bin/aeo-tracker.js` | 3300+ | Active debt — CLI entry, decomposition planned |
| `lib/report/html.js` | ~1380 | Reduced from 3900+ via CSS extract (2026-05) |
| `lib/report/sections.js` | 1800+ | Active debt — palette/font-size cleanup done (2026-05); only file-size split remaining |
| `lib/report/mc-bridge.js` | ~395 | Reduced from 2340+ via CSS extract (2026-05) |

**Status of html.js / mc-bridge.js:** below 1500 lines, no longer
hot-pathed for inline-CSS concerns. CSS bodies live in dedicated `.css`
files (read via `readFileSync` at module load) — Node ESM still bundles
them as zero-deps (no runtime npm packages), the IDE gets proper CSS
highlighting, and the backtick-in-CSS-comment bug class is eliminated.

**Still-active large files:**
- `bin/aeo-tracker.js` — CLI orchestration; the obvious split is per-command
  modules under `lib/cli/`. Untouched in this pass.
- `lib/report/sections.js` — markdown section renderers. Splitting per
  function is feasible but each function is small (≤50 lines); the file
  is large because there are 30+ functions in one place.

---

## Recently resolved (2026-05 editorial redesign)

- ✓ Tailwind palette in `sectionOutreachTemplates` — moved to `.outreach-*` CSS
- ✓ Tailwind palette in `sectionAuthorityPresence` — moved to `.auth-badge[data-tone]`
- ✓ Tailwind palette in `sectionAdsDetection` — moved to `.ads-sample` CSS
- ✓ Tailwind palette in `sectionHistoricalTrend` — moved to `.trend-*` CSS
- ✓ Tailwind palette in `sectionCrawlability` — moved to `.crawl-badge[data-tone]` /
  `.file-check[data-tone]`, ACCESS_BADGE reduced to `{tone, icon, label}`
- ✓ Tailwind palette in `sectionCompetitorIntelligence` — moved to `.cintel-*` /
  `.cell-badge[data-tone]` CSS; gradient header swapped for `--editor` token
- ✓ Tailwind palette in `sectionSentiment` — SENTIMENT_BADGE reduced to
  `{tone, icon, label}`; badge bound via `.cell-badge[data-tone]`; confidence
  flag → `.sent-conf`
- ✓ Tailwind palette in `sectionDomainShareOfVoice` — `.share-bar` primitive
  with `--bar-w` width hook
- ✓ Tailwind palette in `sectionCompetitorRadar` — `.radar-grid` / `.radar-card`
  / `.radar-card-name` / `.radar-card-meta` driven by `data-tone="you|competitor"`,
  radar SVG inherits via `currentColor`
- ✓ Tailwind palette in `sectionDomainCategories` — muted "+N more" via `.dom-more`
- ✓ Tailwind palette in `sectionFunnelBreakdown` — `.share-bar[data-tone]` +
  `.rate-text[data-tone]`
- ✓ Tailwind palette in `sectionActionableGaps` — competitor chips use
  `.cell-badge[data-tone="bad"]`
- ✓ Tailwind palette in `sectionGeoComparison` — `.geo-table` / `.geo-cell[data-tone]`
- ✓ Tailwind palette in `sectionUnifiedVisibilityIndex` — `.score-block` hero
  + `.share-bar[data-tone]` rows
- ✓ Tailwind palette in `sectionDiscoverability` — `.score-block.score-block-row`
  variant + `.score-block-body-*`
- ✓ Tailwind palette in `sectionTopicClusters` — `.rate-text[data-tone]`
- ✓ All inline `style="font-size:..."` in legacy MD-generation functions
  removed; tips list bound to `.auth-tips`. `npm run test:design-lint`
  reports 16/16 passing, 0 soft-warn.
- ✓ `lib/report/html.js` shrunk from 3900+ to ~1380 lines — CSS body
  extracted to `lib/report/styles.css`
- ✓ `lib/report/mc-bridge.js` shrunk from 2340+ to ~395 lines — CSS body
  extracted to `lib/report/mc-bridge.css`
- ✓ Backtick-in-CSS-comment bug class eliminated — CSS no longer lives in
  a template literal, so the parser never sees it as JS
- ✓ Bridge card own colour tokens — now inherits report `:root`
- ✓ `<details>` collapsible Outreach drafts — rendered static
- ✓ Two backtick-inside-CSS-comment bugs — `test/design-lint.test.js` now guards
- ✓ Magic numbers in `radarStatsForBrand` — named as `RANK_DECAY_PER_POSITION`,
  `MENTION_SCORE_PER_HIT`, `SENTIMENT_NEUTRAL_FALLBACK`
- ✓ Silent `catch {}` blocks — annotated with intent comments (no behaviour change)
- ✓ JSDoc added to `sectionOutreachTemplates`, `sectionAuthorityPresence`,
  `sectionAdsDetection`
- ✓ Border-radius tokens consolidated — `--r-xs` / `--r-sm` / `--r-md` / `--r-lg`
- ✓ Inline `font-size` in cell HTML (cost row, big-num) — moved to CSS classes
  and `data-size` attribute
