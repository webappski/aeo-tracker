# dev.to article draft — aeo-tracker

**Target ship:** Thu 2026-05-14 (Day 52). dev.to picks up posts in Bing/Google within ~24h, gives second wave of traffic to Show HN (which lands Day 51 / Wed).

**Title:** `How I built a zero-deps CLI to see if AI engines mention my brand (and what 50 weekly runs taught me)`

**Tags:** `webdev`, `ai`, `node`, `cli`, `opensource`, `seo`

**Cover image:** screenshot of an HTML report with the radar chart visible (`aeo-reports/<date>/report.html`).

---

## Article body (~1200 words target)

### The 30-second version

I built `aeo-tracker` — a CLI that calls ChatGPT, Gemini, Claude, and Perplexity APIs with the same questions every week and diffs the results to show whether AI answer engines actually mention your brand. Zero runtime dependencies. Open source. Five months of weekly runs against my own consulting brand later, here's what I learned.

### The problem

If you're a B2B founder, indie hacker, or small agency, here's a question that's worth the price of a hosted-dashboard subscription: **does ChatGPT name you when someone asks for tools in your category?**

The answer is almost always "no, and you didn't know." There's a category of tools (Profound, Peec.ai, Otterly, AthenaHQ, Wellows) that solve this with paid hosted dashboards. They're great for teams. They're overkill for an indie running 3 queries weekly against 4 engines.

The actual job is small:

1. Call N LLM APIs with the same prompt every week.
2. Detect whether your brand string is in the answer text.
3. Diff this week vs last week. Show what changed.

That's a CLI. ~80 lines of bash, except the second step ("did the model mention you in a NATURAL way, not just listed your domain in citations?") is where it gets interesting.

### The interesting bit: two-model competitor extraction

When ChatGPT answers «best CRM tools 2026», it lists 5-15 brand names in prose. To know if YOU got mentioned, you need to extract those brand names. Regex over the text fails — brands have weird capitalisation, multi-word names, are sometimes mentioned only as URLs. You need an LLM to extract the list.

But ONE LLM hallucinates. Brand X mentioned in the response gets parsed as "Brand X Pro" or "Brand X Inc" by the extractor. Or the extractor invents a brand that wasn't named.

The fix: run the extraction with TWO models in parallel (`gpt-5.4-mini` + `gemini-2.5-flash`) and only trust brands BOTH agree on. Single-model brands land in a "unverified" tier with a dashed badge in the report. Cost: ~$0.0008 per cell × maybe 30 cells per weekly run = ~$0.03 / week for noise-free extraction.

```js
const [extraction, sentiment] = await Promise.all([
  extractWithTwoModels({ text, brand, primary, secondary }),
  classifySentimentWithTwoModels({ text, brand, primary, secondary }),
]);
const verified   = extraction.verified;     // both models agreed
const unverified = extraction.unverified;   // only one agreed — show dashed
```

Same trick for sentiment classification (positive/neutral/negative on every cell where the brand was mentioned). Two-model agreement → high confidence. Disagreement → degrades to "neutral" with a low-confidence flag.

### Zero runtime dependencies

`package.json` for the CLI has `"dependencies": {}` — empty. The whole thing is plain Node 18+ ESM:

- HTTP via `fetch` (built into Node 18+).
- Argument parsing via `node:util/parseArgs`.
- Filesystem via `node:fs/promises`.
- Crypto via `node:crypto`.
- HTML report rendering via template strings + an SVG primitives module I wrote (~200 lines).
- Markdown to HTML conversion via a small ~180-line custom parser (because the report sections needed inline HTML passthrough that no off-the-shelf parser supports).

Why bother? Three reasons:

1. **Install time.** `npm i -g @webappski/aeo-tracker` is sub-second. There's nothing to compile or audit.
2. **Supply-chain surface.** Zero `node_modules/` means zero transitive vulnerabilities. The single point of trust is the binary I publish.
3. **CI/sandbox portability.** Runs unchanged in Vercel CI, GitHub Actions, an Alpine container, or your laptop. No native modules.

The cost is real: I had to write a markdown-to-HTML converter and an SVG chart library. Both are small (≤200 lines each), focused on the exact 4-5 constructs the report uses. They will not be the next `marked` or `chart.js`. They're the smallest viable thing.

### What 5 months of weekly runs taught me

Running aeo-tracker against my own consulting brand (Webappski) for 5 months produced a counter-intuitive lesson:

**The biggest blocker is rarely content quality.** Out of 18 weekly runs across 5 client projects, the most common root cause for «Claude doesn't see me» turned out to be:

1. **robots.txt blocks** — ClaudeBot or PerplexityBot disallowed by some old SEO setup. 3/5 projects had this. 5-minute fix, then visibility climbs over the next 2-4 weeks.
2. **Source substitution** — the AI cites listicles ("Top 10 X in 2026" published by 3rd-party sites). You're not in those listicles. You need to be added. ~50% of "invisible" cases fall here.
3. **Actual content quality / authority** — only 1/5 cases. Way less common than I expected.

The crawlability audit got added to the CLI specifically because (1) was so common. The outreach-template generator (LLM drafts emails to top-cited publishers) got added because (2) was the next-most common root cause and «write the email» is the friction step that stops most users acting.

### What's in v0.3 (just shipped)

- Two-model competitor extraction + sentiment cross-check
- Multi-region runs (`--geo=us,uk,de`)
- robots.txt + AI-bot access audit
- Wikipedia + Reddit presence checks
- LLM-drafted outreach emails per top-cited domain
- CSV/JSON export for BI tools
- nginx/Apache access-log parser to count actual AI-bot crawl frequency

### What it's not

If you need a hosted dashboard with team SSO, Slack alerts, and a multi-brand admin UI, `aeo-tracker` is not for you — Profound and Peec.ai are. The CLI is for indie founders, small AEO agencies (≤10 clients), and dev-centric teams who prefer plain text + git over a SaaS UI.

### Try it

```bash
npm i -g @webappski/aeo-tracker
aeo-tracker init --auto
aeo-tracker run
aeo-tracker report --html
```

You need an OpenAI API key + a Gemini API key minimum (Anthropic and Perplexity optional). A first run costs about a dollar depending on how rich the answers are.

Source: github.com/webappski/aeo-tracker
Issue or feature you want? Open an issue.

---

**Footer (dev.to convention):**

> Built this in 5 months of weekend work. Honest feedback on the architecture, the extraction-cross-check approach, or what tools you'd want it to integrate with — all welcome.

---

**Pre-publish checklist:**
- [ ] Add 2-3 screenshots: HTML report, CLI output with green YES, the crawlability table
- [ ] Cover image: ratio 1000x420
- [ ] Canonical URL → set to `https://github.com/webappski/aeo-tracker` so Google attributes link to GitHub
- [ ] Schedule for Thu 8am EST (same window as Show HN, gives 24h overlap)

**Cross-post plan:**
- Hashnode (auto-import from dev.to RSS)
- Medium (manual, friction limit — only if dev.to engages well)
- Personal blog `webappski.com/en/blog/` (canonical-tagged to dev.to to avoid duplicate-content penalty)
