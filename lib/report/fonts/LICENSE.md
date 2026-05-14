# Bundled fonts — provenance & licensing

Three variable woff2 files bundled with `aeo-platform` for the HTML
report renderer. All three are licensed under the **SIL Open Font License 1.1**
(OFL), which permits embedding, redistribution, and modification.

| File | Family | Author / Foundry | License |
|---|---|---|---|
| `Fraunces-Variable-latin.woff2` | Fraunces | Undercase Type | [OFL 1.1](https://github.com/undercasetype/Fraunces/blob/main/OFL.txt) |
| `Geist-Variable-latin.woff2` | Geist | Vercel | [OFL 1.1](https://github.com/vercel/geist-font/blob/main/LICENSE.TXT) |
| `JetBrainsMono-Variable-latin.woff2` | JetBrains Mono | JetBrains s.r.o. | [OFL 1.1](https://github.com/JetBrains/JetBrainsMono/blob/master/OFL.txt) |

**Subset:** Latin only (Basic Latin + IPA + extended punctuation per Google
Fonts' `latin` charset). Latin-extended, Cyrillic, Greek, Vietnamese subsets
are NOT included to keep the per-report payload small.

**Origin:** Files were fetched from Google Fonts' woff2 endpoint
(`fonts.gstatic.com`) with a Chrome user-agent so that the CSS API returned
variable-font woff2 (rather than static-weight TTFs). The fetch URLs are
documented in `lib/report/fonts/index.js` history.

**Update procedure:** when Google Fonts updates a family (e.g. Fraunces v38 →
v39), re-run the fetch with the latest CSS API URL and replace the woff2
file. Verify the file is still <100KB and still a `Web Open Font Format
(Version 2)` per `file(1)`.

**Why bundled instead of CDN?** Two reasons:
1. The HTML report is meant to work **offline** — emailable, archivable,
   PDF-printable from disconnected machines.
2. `aeo-platform` is zero-runtime-dependency. Embedding the fonts at build
   time keeps that promise (no `fetch()` at report render time).

If the bundled fonts cause problems for your distribution (license review,
file-size budget), open an issue — a `--fonts=cdn` opt-out can be added.
For now, bundled is the only mode.
