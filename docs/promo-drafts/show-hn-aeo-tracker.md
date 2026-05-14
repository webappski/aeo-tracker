# Show HN draft — aeo-tracker

**Target post slot:** Wed 2026-05-13 (Day 51), 8:00am EST. Sweet spot for Show HN traffic.

**Title (under 80 chars):**

```
Show HN: aeo-tracker – CLI to see if AI engines mention your brand
```

Backup variants:
- `Show HN: aeo-tracker – open-source CLI for tracking ChatGPT/Gemini/Claude visibility`
- `Show HN: I built a CLI to track if AI answer engines cite my brand`

**URL:** `https://github.com/webappski/aeo-tracker`

**Body (the first comment — HN convention):**

```
Hey HN — I run a small AEO consulting practice and got tired of paying for hosted
AI-visibility dashboards (Profound, Peec.ai, Otterly) when the actual job is just
"call N LLM APIs with the same prompts every week and diff the results."

aeo-tracker is the CLI version of that. It calls the official ChatGPT, Gemini, Claude,
and Perplexity APIs with your queries, detects whether your brand was named in the answer
or only in citations, runs a two-model cross-check on competitor extraction (so it doesn't
hallucinate brands that aren't in the response), and writes a single-file HTML report
with inline SVG charts. Zero runtime npm dependencies — the whole thing is plain Node 18+
ESM, ~3000 lines, ~330 tests.

What's in v0.3 (just shipped):

- Sentiment cross-check on every brand mention (two-classifier merge)
- Multi-region runs via --geo=us,uk,de,fr,... (cost multiplies, you get a warning)
- robots.txt audit for the 12 main AI bots (catches "Claude doesn't see me" mysteries
  that turn out to be Disallow: / for ClaudeBot)
- Wikipedia + Reddit presence checks (free public APIs, no auth)
- LLM-drafted outreach emails for the top-3 cited publishers in your category
- CSV export for Looker/Sheets ingestion
- nginx/Apache log parser to count actual AI-bot crawl frequency on your site

Why it might be useful to you:
- You're an indie founder watching AI search take traffic and want a few-cents-per-run baseline.
- You're a dev-centric agency with ≤10 clients and don't need a hosted UI.
- You want to see the raw responses on disk (aeo-responses/<date>/) and own the data.

What it's not: a hosted dashboard with team SSO, Slack alerts, multi-brand UI. If you
need those, Profound and Peec.ai are still the right pick — they solve collaboration,
which a CLI deliberately doesn't.

The full README has a "Compared to alternatives" table with honest tradeoffs against
Profound, Otterly, Peec.ai, HubSpot, and Ahrefs:
https://github.com/webappski/aeo-tracker#compared-to-alternatives

Install: `npm i -g @webappski/aeo-tracker` then `aeo-tracker init --auto`

Happy to answer questions on architecture (two-model extractor, SVG report renderer,
classify-tier LLM cost tradeoffs), AEO strategy, or whether you're getting cited at all
for your category.
```

**Self-comment plan (post 30 min after submission to seed discussion):**

```
One thing I learned building this — the biggest single gap between "Claude doesn't see me"
and "fix" is usually robots.txt blocking ClaudeBot, not content. We added the crawlability
audit specifically because three out of the first five projects we ran this against had
ClaudeBot or PerplexityBot disallowed by some old SEO setup nobody remembered. 5-minute fix,
weeks of "why doesn't Claude know us" misery saved.
```

**Engagement protocol:**
- Post → wait 5 min → submit self-comment above (HN expects OP to engage early)
- Reply to every top-level comment within first 2h — front-page algorithm weights this heavily
- If someone asks about specific competitor (Profound/Peec/Otterly), DO NOT trash them.
  Honest comparison wins HN; bashing competitors loses.
- If someone says «just write a bash script», agree partially: «yeah, the v0.0.1 was 80
  lines of bash. The CLI exists because cross-checking two LLMs on competitor extraction
  is where the noise floor drops below false-positive rate.»

**Risks to anticipate:**
- "Why not just use Profound's free tier?" → Profound has no free tier as of 2026-04;
  it's a paid hosted dashboard. Our pay-only-for-your-LLM-API-spend model beats that
  for indie scale.
- "Doesn't Claude already have a bot? Why CLI?" → CLI runs against API, not bot. Different
  layer — you're observing what the model says, not optimizing for what the bot crawls.
- "Show me the raw responses." → Link `aeo-responses/2026-04-23/` example in repo (need
  to commit a sanitised one before posting — Block A item for Day 47).

**Success metric:** ≥30 upvotes in first hour = front-page candidate. ≥100 by end of day = win.
