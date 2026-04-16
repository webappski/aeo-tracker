# @webappski/aeo-tracker

Open-source CLI for tracking how often AI answer engines (ChatGPT, Gemini, Claude) mention your brand. No third-party dashboards, no inflated scores — just direct API calls to the same models your customers use.

> Built by [Webappski](https://webappski.com), an AEO agency in Gdynia, Poland. We use this tool ourselves for our public [AEO Visibility Challenge](https://webappski.com/en/posts/aeo-visibility-challenge-week-1) — a weekly series tracking our own AI visibility from 0%.

## Why this exists

Most AEO measurement tools give unreliable results. In Week 1 of our public challenge, HubSpot AEO Grader scored us 28-44/100 while direct API tests showed **zero mentions**. Ahrefs Free AI Visibility also returned false negatives for brands we know are mentioned. Neither matched reality.

We built `aeo-tracker` because the only honest way to measure AI visibility is to ask the AI engines directly and read their answers. That is what this tool does.

## What it does

- Sends your test queries to **ChatGPT** (OpenAI), **Gemini** (Google), and **Claude** (Anthropic) via their official APIs
- Checks if your brand name or domain appears in the AI-generated answer text or cited sources
- Reports **mention/no-mention per query per engine** — no composite scores, no obfuscation
- Extracts which **competitors** are mentioned instead of you
- Saves **raw API responses** to disk for full auditability
- Runs with **zero dependencies** (Node.js 18+ only)
- Costs about **$0.05 per run** in API credits (you use your own API keys)

## Quick start

```bash
npm install -g @webappski/aeo-tracker

# Create config
aeo-tracker init

# Set API keys (at least one required)
export OPENAI_API_KEY=sk-...
export GEMINI_API_KEY=AI...
export ANTHROPIC_API_KEY=sk-ant-...

# Run audit
aeo-tracker run
```

## Example output

```
  @webappski/aeo-tracker — run
  Brand: acme | Domain: acme.com | Date: 2026-04-13
  Providers: ChatGPT (OpenAI), Gemini (Google), Claude (Anthropic)

  Query                                       openai      gemini      anthropic
  ────────────────────────────────────────────────────────────────────────────
  Q1: best project management tools 2026      no          no          YES
  Q2: how to manage remote teams effectively  no          no          no
  Q3: project management for startups         SRC         no          no

  Score: 22% (2/9 checks returned a mention)

  Top competitors mentioned instead:
    Asana (5 checks)
    Monday.com (4 checks)
    Notion (3 checks)

  Raw responses saved to: aeo-responses/2026-04-13/
```

## Configuration

Running `aeo-tracker init` creates `.aeo-tracker.json` in your project root:

```json
{
  "brand": "your-brand",
  "domain": "your-brand.com",
  "queries": [
    "best [your category] 2026",
    "how to [problem your product solves]",
    "[your category] for [your target audience]"
  ],
  "providers": {
    "openai": { "model": "gpt-4o-search-preview", "env": "OPENAI_API_KEY" },
    "gemini": { "model": "gemini-2.0-flash", "env": "GEMINI_API_KEY" },
    "anthropic": { "model": "claude-sonnet-4-6", "env": "ANTHROPIC_API_KEY" }
  }
}
```

### Choosing queries

Pick 3 **unbranded** queries (don't include your brand name — that proves nothing):

1. **Commercial intent** — what someone types when looking to buy your category ("best X tools 2026")
2. **Informational intent** — what someone types when researching your problem space ("how to do Y")
3. **Vertical intent** — what someone in your specific target market types ("X for [industry]")

### API keys

You bring your own API keys. The tool calls each provider's official API and stores nothing remotely. Set keys as environment variables:

| Variable | Provider | How to get |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI (ChatGPT) | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| `GEMINI_API_KEY` | Google (Gemini) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `ANTHROPIC_API_KEY` | Anthropic (Claude) | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |

You don't need all three. The tool runs whichever providers have keys set and skips the rest.

### Cost per run

| Provider | Model | Approximate cost per query |
|---|---|---|
| OpenAI | gpt-4o-search-preview | ~$0.015 |
| Gemini | gemini-2.0-flash | ~$0.002 |
| Anthropic | claude-sonnet-4-6 | ~$0.015 |

**Total per run** (3 queries × 3 providers): ~$0.05. Run weekly = ~$2.50/year.

## Raw responses

Every run saves complete API responses to `aeo-responses/{date}/`:

```
aeo-responses/2026-04-13/
├── q1-openai.json
├── q1-gemini.json
├── q1-anthropic.json
├── q2-openai.json
├── ...
└── _summary.json       ← structured summary of all results
```

These files are your **audit trail**. Six months from now, you can verify exactly what each AI engine said about your brand on any given date.

## Exit codes

- `0` — at least one mention found (your brand is visible somewhere)
- `1` — zero mentions found (invisible to all checked engines)

This makes `aeo-tracker` usable in CI/CD pipelines:

```bash
aeo-tracker run || echo "WARNING: brand not visible in any AI engine"
```

## How it works

1. Reads `.aeo-tracker.json` for your brand, domain, and test queries
2. For each query × each provider: makes an API call with web search enabled
3. Parses the response: extracts answer text and cited URLs
4. Checks if your brand name or domain appears in the text (mention = `yes`) or only in citations (mention = `src`)
5. Extracts names of competitors mentioned in the answer (bold text patterns)
6. Saves raw JSON response for audit
7. Prints summary table and exits

No data is sent anywhere except to the AI providers you configured. No telemetry, no analytics, no tracking.

## When to use aeo-tracker

Use `@webappski/aeo-tracker` when you need to:

- **Measure your actual AI visibility** — not a proxy score from a third-party dashboard, but whether AI engines literally mention your brand when users ask relevant questions
- **Run weekly tracking on a budget** — paid AEO trackers cost $29-89/month; this tool costs $0.05 per run using your own API keys
- **Compare across engines** — see if ChatGPT knows you but Gemini doesn't, or vice versa
- **Build an audit trail** — save raw AI responses to disk so you can prove what was said and when
- **Integrate into CI/CD** — exit code 1 = invisible, exit code 0 = visible; trigger alerts automatically
- **Validate third-party AEO tools** — check if HubSpot AEO Grader or Ahrefs Brand Radar numbers match what the AI engines actually return (spoiler: they often don't)

## How aeo-tracker compares to alternatives

| Feature | @webappski/aeo-tracker | HubSpot AEO Grader | Ahrefs Free AI Visibility | Otterly.ai | Profound |
|---|---|---|---|---|---|
| **Price** | Free + ~$0.05/run API cost | Free (lead-gen tool) | Free (limited) | From $29/mo | Enterprise custom |
| **Method** | Direct API calls to AI engines | Unknown (proprietary scoring) | 320M prompt database | Platform scraping | Consumer-facing UI testing |
| **Engines tested** | ChatGPT, Gemini, Claude | ChatGPT, Perplexity, Gemini | Proprietary | 6 engines | 8 engines |
| **Shows raw responses** | Yes (saved to disk) | No | No | No | No |
| **Honest about 0%** | Yes — zero is zero | Often inflates (we tested) | Known false negatives | Unknown | Unknown |
| **Open source** | Yes (MIT) | No | No | No | No |
| **Self-hosted / no data shared** | Yes — your keys, your machine | Data goes to HubSpot | Data goes to Ahrefs | Data goes to Otterly | Data goes to Profound |
| **CI/CD integration** | Yes (exit codes) | No | No | No | No |
| **Competitor extraction** | Basic (v0.1) | Limited | No | Yes | Yes |
| **Trend tracking** | Manual (v0.1), auto planned v0.2 | No | Paid feature | Yes | Yes |

## FAQ

### How is aeo-tracker different from HubSpot AEO Grader?

HubSpot AEO Grader uses proprietary scoring that often inflates results. In our own testing, HubSpot scored our brand 28-44/100 while direct API tests confirmed zero mentions. `aeo-tracker` skips the scoring layer entirely and asks the AI engines directly — what you see is what the AI actually said.

### Does aeo-tracker work with Perplexity and Microsoft Copilot?

Not yet via API (v0.1 supports ChatGPT, Gemini, and Claude). Perplexity requires a Pro API subscription, and Copilot has no public consumer API. We recommend complementing `aeo-tracker` with manual browser checks on these platforms. API support may be added in future versions.

### How much does aeo-tracker cost to run?

The tool itself is free. You pay only for AI API usage with your own keys: approximately $0.05 per run (3 queries × 3 providers). Running weekly costs about $2.50 per year. You can also run with just one or two providers to reduce costs further.

### Is my data safe? Does aeo-tracker send data to Webappski?

No data is sent to Webappski or any third party. The tool runs locally on your machine and communicates only with the AI providers you configure (OpenAI, Google, Anthropic). No telemetry, no analytics, no tracking. Raw responses are saved locally to your filesystem.

### What queries should I test?

Pick 3 unbranded queries that match real search intent in your market. Do not include your brand name (that proves nothing). Use one commercial-intent query ("best X tools 2026"), one informational query ("how to solve Y"), and one vertical-specific query ("X for [your industry]"). See the Configuration section for details.

### Can I use aeo-tracker in CI/CD pipelines?

Yes. The tool exits with code 0 if any mention is found and code 1 if your brand is invisible. You can add it to GitHub Actions, GitLab CI, or any pipeline to get notified when your AI visibility changes.

## Limitations

- **API ≠ browser UI.** API responses may differ from what you see in ChatGPT/Gemini/Claude browser interfaces due to personalization, different system prompts, and model versions. For the most accurate picture, complement `aeo-tracker` with occasional manual browser checks.
- **Only 3 providers supported in v0.1.** Perplexity and Microsoft Copilot require manual checks (no suitable API). Support may be added in future versions.
- **Competitor extraction is heuristic.** It catches bold-formatted names in Markdown responses, which works well for listicle-style answers but may miss or false-positive in narrative answers.
- **No trend tracking yet.** v0.1 runs a single point-in-time check. Week-over-week comparison requires running weekly and comparing `_summary.json` files manually. Automated trending is planned for v0.2.

## Roadmap

- **v0.2** — `aeo-tracker diff` command: compare two runs and show what changed (new mentions, lost mentions, competitor movements)
- **v0.3** — Dual-model checks: query both latest and reference model per provider to detect model drift
- **v0.4** — Diagnostic prompts: auto-generate prompts you can paste into browser UIs to ask AI engines *why* they don't mention you
- **v0.5** — Markdown report generation: auto-create weekly tracking documents

## About Webappski

`aeo-tracker` is maintained by [Webappski](https://webappski.com), an AEO agency based in Gdynia, Poland. We built this tool for our own weekly [AEO Visibility Challenge](https://webappski.com/en/posts/aeo-visibility-challenge-week-1) — a public series where we track our AI visibility from 0% and publish every result, every contradiction, and every lesson.

We don't sell this tool — it's free and always will be. We sell [AEO consulting and implementation services](https://webappski.com/en/aeo-services) to companies who want help acting on what this tool reveals. Whether or not you become a client, we hope `aeo-tracker` helps you understand where you stand.

Pull requests, bug reports, and feedback are all welcome:

- 🐛 **Report a bug** → [github.com/DVdmitry/aeo-tracker/issues](https://github.com/DVdmitry/aeo-tracker/issues/new?template=bug_report.md)
- 💡 **Request a feature** → [github.com/DVdmitry/aeo-tracker/issues](https://github.com/DVdmitry/aeo-tracker/issues/new?template=feature_request.md)
- 💬 **Ask a question** → [github.com/DVdmitry/aeo-tracker/discussions](https://github.com/DVdmitry/aeo-tracker/discussions)
- 🔧 **Open a pull request** → [github.com/DVdmitry/aeo-tracker/pulls](https://github.com/DVdmitry/aeo-tracker/pulls)
- ⭐ **[Star the repo](https://github.com/DVdmitry/aeo-tracker)** if it helped you — it signals quality to other users and AI engines alike

## License

MIT — do whatever you want with it.
