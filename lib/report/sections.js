import { heatmap, barchart, sparkline, deltaArrow, radar, combinedRadar } from '../svg/index.js';
import { extractQuotes } from './extract-quotes.js';
import { sentimentToScore } from './sentiment-classify.js';
import { aggregateByCategory } from './domain-category.js';
import { computeComponents, computeUVI, computeDiscoverability } from './visibility-index.js';
import { clusterQueries } from './topic-cluster.js';
import { aggregateUtmCitations } from './utm-tracker.js';

const PROVIDER_LABELS = {
  openai: 'ChatGPT',
  gemini: 'Gemini',
  anthropic: 'Claude',
  perplexity: 'Perplexity',
};

export function providerLabel(p) {
  return PROVIDER_LABELS[p] || p;
}

/**
 * Escape HTML-significant characters in user/LLM/3rd-party strings before they
 * are interpolated into markdown sections that may be piped through mdToHtml.
 * mdToHtml deliberately passes raw `<` through (so sections can embed inline
 * <span>, <details>, inline SVG), so any unescaped attacker-controlled string
 * would XSS. CODING_STANDARDS.md mandates escaping user data in HTML.
 *
 * Use for: brand, queryText, competitor names, sentiment.rationale, outreach
 * template fields, Wikipedia/Reddit content. Do NOT use for hostnames already
 * derived from new URL().hostname (those are URL-spec-clean).
 */
export function escMd(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Truncate URL keeping hostname visible; drop `https://` prefix because the
 * SVG label column is ~180px wide — the scheme eats budget without adding info.
 * Result like "aeodirectory.com/aeo/det…" fits and stays parseable.
 */
function shortenUrlKeepHost(u, maxLen = 30) {
  if (!u) return u;
  try {
    const url = new URL(u);
    const host = url.hostname.replace(/^www\./, '');
    const tail = url.pathname === '/' ? '' : (url.pathname + url.search);
    const combined = host + tail;
    if (combined.length <= maxLen) return combined;
    if (host.length >= maxLen - 2) return host.slice(0, maxLen - 1) + '…';
    const budget = maxLen - host.length - 1; // reserve 1 char for ellipsis
    return host + tail.slice(0, budget) + '…';
  } catch {
    // Malformed URL (no protocol, invalid host, etc.) — gracefully degrade
    // to a raw-string truncation. Display path only; we never use the
    // unparsed value for routing. Logging would be noise — these come from
    // LLM-extracted citations and a few per run are expected.
    return u.length > maxLen ? u.slice(0, maxLen - 1) + '…' : u;
  }
}

/** Per-provider hit ratio. Returns { hits, total, rate }. */
function providerStats(results, provider) {
  const rs = results.filter(r => r.provider === provider && r.mention !== 'error');
  const hits = rs.filter(r => r.mention === 'yes' || r.mention === 'src').length;
  return { hits, total: rs.length, rate: rs.length > 0 ? hits / rs.length : 0 };
}

// ─── Section: Header (with corner score badge — P9) ───

/**
 * Map score to traffic-light status: color + emoji + label + actionable verb.
 */
export function trafficLight(score) {
  if (typeof score !== 'number') return { emoji: '⚪', color: '#94a3b8', label: 'NO DATA', verb: 'run first audit' };
  if (score === 0)   return { emoji: '🔴', color: '#ef4444', label: 'INVISIBLE', verb: 'establish presence' };
  if (score < 25)    return { emoji: '🟠', color: '#f97316', label: 'EMERGING',  verb: 'broaden coverage' };
  if (score < 60)    return { emoji: '🟡', color: '#eab308', label: 'PRESENT',   verb: 'deepen authority' };
  return { emoji: '🟢', color: '#10b981', label: 'STRONG',    verb: 'defend position' };
}

export function sectionHeader(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const first = snapshots[0];
  const generated = new Date().toISOString().slice(0, 10);
  const period = snapshots.length > 1
    ? `${first.date} → ${latest.date} (${snapshots.length} runs)`
    : `${latest.date} (first run)`;
  const tl = trafficLight(latest.score);

  return `# ${tl.emoji} ${latest.score}% · AEO Report — ${escMd(latest.brand)}

${escMd(latest.domain)} · ${period} · generated ${generated}
`;
}

// ─── Section: Hero card (P1) — scanner-friendly headline ───

/**
 * The single most important block in the report. Appears above Summary and
 * all tables. Uses emoji traffic light + big score + plain-English subtext +
 * inline "what to do this week" hook.
 *
 * Designed to convey {status, trend, action} in one scannable eye-fixation.
 */
export function sectionHero(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const prev = snapshots.length > 1 ? snapshots[snapshots.length - 2] : null;
  const tl = trafficLight(latest.score);

  const scoreDelta = prev ? latest.score - prev.score : null;
  const trendMarker = scoreDelta === null
    ? '▪ BASELINE'
    : scoreDelta > 0 ? `▲ +${scoreDelta}pp vs ${prev.date}`
    : scoreDelta < 0 ? `▼ ${scoreDelta}pp vs ${prev.date}`
    : '▪ no change';

  return `## ${tl.emoji} Your AEO visibility — ${tl.label}

# ${latest.score}%

${trendMarker} · **${latest.mentions} of ${latest.total} checks returned a mention**

> Focus this week: **${tl.verb}**. See actionable steps at the bottom of this report.
`;
}

// ─── Section: Comparison baseline (P10) — answers "is 0% bad?" ───

/**
 * Context for the raw number. Tells the user where their score sits relative
 * to rough industry baselines. Shown only on first-run or low scores to avoid
 * condescension when user is actually doing fine.
 */
export function sectionBaseline(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  if (latest.score >= 60) return ''; // Don't patronise strong brands

  const markerAt = (low, high) =>
    latest.score >= low && latest.score <= high ? ' ← you are here' : '';

  return `### How your score compares

\`\`\`
Pre-revenue brand, Week 1–2:           0–15%${markerAt(0, 15)}
6-month-old brand with SEO investment: 20–45%${markerAt(20, 45)}
Established category leader:            60–85%${markerAt(60, 100)}
\`\`\`

_Rough baselines from Webappski's own weekly audits and client work. 0% at Week 1 is the norm for new brands — the tool is designed to track you from invisible to strong over months, not to grade you today._
`;
}

// ─── Section: Executive Summary (plain-English abstract) ───

export function sectionExecutiveSummary(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const { mentions, total, brand } = latest;
  const providers = [...new Set(latest.results.map(r => r.provider))];
  const stats = providers.map(p => ({ p, ...providerStats(latest.results, p) }));
  const visible = stats.filter(s => s.hits > 0);
  const invisible = stats.filter(s => s.hits === 0);
  const strongest = [...visible].sort((a, b) => b.rate - a.rate)[0];

  let narrative;

  const safeBrand = escMd(brand);

  if (mentions === 0) {
    narrative =
      `**${safeBrand}** is **not mentioned** by any of the ${providers.length} AI engine${providers.length === 1 ? '' : 's'} tested. ` +
      `All ${total} checks returned zero mentions — AI engines cite other products in your category instead (see "Tracked Competitors" below).`;
    if (snapshots.length === 1) {
      narrative += `\n\nThis is common for new brands or brands without established AEO presence. It's your **baseline**, not a failure.`;
    }
  } else if (visible.length === providers.length) {
    narrative =
      `**${safeBrand}** is mentioned across **all ${providers.length} AI engines** tested (${mentions} of ${total} checks). ` +
      `You have broad AI visibility — the focus shifts to position improvements and competitor pressure (see sections below).`;
  } else {
    const visStr = visible.map(s => `${providerLabel(s.p)} (${s.hits}/${s.total})`).join(', ');
    const invStr = invisible.map(s => providerLabel(s.p)).join(', ');
    narrative =
      `**${safeBrand}** is visible on **${visStr}** but **invisible on ${invStr}** (${mentions} of ${total} checks). ` +
      `Your strongest channel is **${providerLabel(strongest.p)}** (${strongest.hits}/${strongest.total}). ` +
      `The gap between engines points to engine-specific differences in training data and web-search source pools.`;
  }

  return `## Summary — ${safeBrand}'s AI Visibility

${narrative}
`;
}

// ─── Section: Key Metrics — score cards (HTML, rendered by marked.js) ───

export function sectionKeyMetrics(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const prev = snapshots.length > 1 ? snapshots[snapshots.length - 2] : null;
  const providers = [...new Set(latest.results.map(r => r.provider))];

  const tl = trafficLight(latest.score);
  const scoreDelta = prev ? latest.score - prev.score : null;
  const overallDelta = scoreDelta !== null
    ? (scoreDelta > 0 ? `▲ +${scoreDelta}pp` : scoreDelta < 0 ? `▼ ${scoreDelta}pp` : '▪ no change')
    : '▪ baseline';

  function card(label, value, sub, delta, color) {
    return `<div class="sc" style="border-top:4px solid ${color}"><div class="sc-lbl">${label}</div><div class="sc-val" style="color:${color}">${value}</div><div class="sc-sub">${sub}</div><div class="sc-delta">${delta}</div></div>`;
  }

  const cards = [card('Overall', `${latest.score}%`, tl.label, overallDelta, tl.color)];

  for (const p of providers) {
    const { hits, total, rate } = providerStats(latest.results, p);
    if (total === 0) continue;
    const pct = Math.round(rate * 100);
    const ptl = trafficLight(pct);
    let pDelta = '▪ baseline';
    if (prev) {
      const ps = providerStats(prev.results, p);
      if (ps.total > 0) {
        const prevPct = Math.round(ps.rate * 100);
        const d = pct - prevPct;
        pDelta = d > 0 ? `▲ +${d}pp` : d < 0 ? `▼ ${d}pp` : '▪ no change';
      }
    }
    cards.push(card(providerLabel(p), `${hits}/${total}`, `${pct}% hit rate`, pDelta, ptl.color));
  }

  return `## Key Metrics

<div class="score-cards">${cards.join('')}</div>
`;
}

// ─── Section: Engine Radar (P2) ───

/**
 * Per-engine hit-rate in a single radar visualisation. Reveals shape of
 * visibility: balanced (similar across engines), skewed (one engine dominates),
 * or zero (empty polygon).
 */
export function sectionEngineRadar(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const providers = [...new Set(latest.results.map(r => r.provider))];
  if (providers.length < 3) return ''; // Radar needs 3+ axes

  const axes = providers.map(p => {
    const s = providerStats(latest.results, p);
    return { label: providerLabel(p), value: Math.round(s.rate * 100) };
  });

  return `## Engine coverage at a glance

_Each axis is one AI engine; the further out the polygon stretches, the more queries the engine mentions your brand for. A tiny polygon or red-dotted axis means "invisible to that engine" — that's your gap._

${radar({ axes })}
`;
}

// ─── Section: AI × Query Matrix (with intro) ───

export function sectionMatrix(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const queries = [...new Set(latest.results.map(r => r.query))].sort();
  const providers = [...new Set(latest.results.map(r => r.provider))];

  const rows = providers.map(providerLabel);
  const cells = providers.map(p => queries.map(q => {
    const r = latest.results.find(x => x.provider === p && x.query === q);
    return r ? r.mention : 'missing';
  }));

  return `## AI × Query Matrix — ${latest.date}

| | | |
|---|---|---|
| 🟢 **YES** | your brand appeared in the answer text | strong signal |
| 🟡 **SRC** | your brand was only in cited sources | weak signal |
| 🔴 **NO** | not mentioned anywhere | gap |
| ⬜ **—** | not tested / provider skipped | no data |

${heatmap({ rows, cols: queries, cells })}
`;
}

// ─── Section: Engine-specific actions (per-engine HTML cards) ───

const ENGINE_TIPS = {
  openai: {
    name: 'ChatGPT', color: '#10a37f', icon: '🤖',
    why: 'ChatGPT grounds answers in Bing search results. Review platforms and community Q&A are its highest-weight sources.',
    tips: [
      'Get listed on G2, Capterra, or Product Hunt — ChatGPT cites review platforms heavily',
      'Answer questions on Reddit and Quora with your tool mentioned by name',
      'Publish a comparison post (Your Tool vs Alternatives) on your blog or Medium',
    ],
  },
  gemini: {
    name: 'Gemini', color: '#4285f4', icon: '✦',
    why: 'Gemini grounds responses in Google Search results. Domain authority and structured data carry more weight here than on other engines.',
    tips: [
      'Earn citations from high-DR sites Google already indexes for your keywords',
      'Add FAQ schema markup to your landing page (Gemini follows Google\u2019s structured data signals)',
      'Get featured in a roundup post on any high-authority tech blog or newsletter',
    ],
  },
  anthropic: {
    name: 'Claude', color: '#d97757', icon: '◆',
    why: 'Claude uses training data (web crawl + curated sources) and Brave search. Developer ecosystems and product launch pages are over-represented in its training corpus.',
    tips: [
      'Publish on npm or create a GitHub repo \u2014 Claude\u2019s training data over-represents dev ecosystems',
      'Write a detailed post on dev.to or Medium: "How I built X with [Your Tool]"',
      'Launch on Product Hunt \u2014 PH pages are in Claude\u2019s training corpus',
    ],
  },
  perplexity: {
    name: 'Perplexity', color: '#5046e4', icon: '⊕',
    why: 'Perplexity runs real-time multi-source web search. Freshness and breadth of coverage matter more than authority.',
    tips: [
      'Publish fresh content weekly — Perplexity prioritises recency over domain authority',
      'Post answers on Reddit and Quora threads about your category (Perplexity indexes them in real time)',
      'Submit to niche directories and link aggregators in your vertical',
    ],
  },
};

export function sectionEngineActions(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const providers = [...new Set(latest.results.map(r => r.provider))];
  const stats = providers.map(p => ({ p, ...providerStats(latest.results, p) })).filter(s => s.total > 0);

  const cardsHtml = stats.map(s => {
    const meta = ENGINE_TIPS[s.p];
    if (!meta) return '';
    const pct = Math.round(s.rate * 100);
    const tl = trafficLight(pct);
    const badge = `<span class="ea-badge" style="background:${tl.color}20;color:${tl.color}">${tl.label} ${pct}%</span>`;
    const tipsList = meta.tips.map(t => `<li>${t}</li>`).join('');
    const urgent = s.hits === 0 ? ' ea-card--urgent' : '';
    return `<div class="ea-card${urgent}" style="border-left:4px solid ${meta.color}"><div class="ea-header"><span class="ea-icon">${meta.icon}</span><span class="ea-name">${meta.name}</span>${badge}</div><p class="ea-why">${meta.why}</p><ul class="ea-tips">${tipsList}</ul></div>`;
  }).filter(Boolean).join('');

  if (!cardsHtml) return '';

  return `## Engine-specific actions

_Each AI engine pulls from different source pools — the same content can rank on one engine and be invisible on another._

<div class="engine-actions">${cardsHtml}</div>
`;
}

// ─── Section: Visibility Breakdown (per-engine plain-English) ───

export function sectionVisibilityBreakdown(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const providers = [...new Set(latest.results.map(r => r.provider))];

  const rows = providers.map(p => {
    const { hits, total, rate } = providerStats(latest.results, p);
    let label, verdict;
    if (total === 0) {
      label = '❓'; verdict = 'not tested';
    } else if (rate >= 0.66) {
      label = '✅'; verdict = `strong (${hits}/${total})`;
    } else if (rate >= 0.34) {
      label = '⚠️'; verdict = `partial (${hits}/${total})`;
    } else if (rate > 0) {
      label = '⚠️'; verdict = `weak (${hits}/${total})`;
    } else {
      label = '❌'; verdict = `invisible (0/${total})`;
    }
    return `| ${label} | **${providerLabel(p)}** | ${verdict} |`;
  });

  return `## Where AI Engines Stand on Your Brand

| | Engine | Status |
|---|---|---|
${rows.join('\n')}

_Read this as the first "so what" of the report. **✅ Strong** = consistent citations; **⚠️ Partial/Weak** = visibility exists but inconsistent, likely fixable with targeted content; **❌ Invisible** = the engine has no reason to know about you yet — typically means you need citations on sources the engine trusts._
`;
}

// ─── Section: Verbatim Quotes ───

export function sectionVerbatimQuotes(snapshots, rawResponses) {
  const latest = snapshots[snapshots.length - 1];
  const blocks = [];

  for (const r of latest.results) {
    if (r.mention === 'no' || r.mention === 'error') continue;
    const key = `${r.query}|${r.provider}`;
    const raw = rawResponses?.[key];
    if (!raw) continue;

    const { snippets, citationOnly } = extractQuotes(raw, latest.brand, latest.domain, r.canonicalCitations || []);

    if (snippets.length > 0) {
      blocks.push(`**${providerLabel(r.provider)}, ${escMd(r.query)}:**\n> "${escMd(snippets[0])}"`);
    } else if (citationOnly) {
      blocks.push(`**${providerLabel(r.provider)}, ${escMd(r.query)} — citation only:**\n> Brand appears only as a source URL in the answer:\n> \`${escMd(citationOnly)}\``);
    }
    if (blocks.length >= 6) break;
  }

  if (blocks.length === 0) return '';
  return `## What AI Engines Actually Said

_The exact sentences AI engines generated that mention your brand. These are your current "AI snippets" — what a user actually reads when they ask about your category. Quote-worthy snippets make strong social content._

${blocks.join('\n\n')}
`;
}

// ─── Section: Diff ───

export function sectionDiff(snapshots) {
  if (snapshots.length < 2) {
    return `## What Changed

_This is your first run — there's nothing to compare yet. Trends (gained/lost mentions, competitor movement) become visible starting with your second weekly run._
`;
  }

  const prev = snapshots[snapshots.length - 2];
  const curr = snapshots[snapshots.length - 1];

  const changes = [];
  const seenKeys = new Set();
  for (const r of curr.results) {
    const key = `${r.query}|${r.provider}`;
    seenKeys.add(key);
    const pr = prev.results.find(p => p.query === r.query && p.provider === r.provider);
    const was = pr ? pr.mention : 'missing';
    if (was !== r.mention) changes.push({ provider: r.provider, query: r.query, was, now: r.mention });
  }
  for (const r of prev.results) {
    const key = `${r.query}|${r.provider}`;
    if (!seenKeys.has(key)) {
      changes.push({ provider: r.provider, query: r.query, was: r.mention, now: 'missing' });
    }
  }

  if (changes.length === 0) {
    return `## What Changed (${prev.date} → ${curr.date})

_No cell changes between runs — stable visibility for this cycle._
`;
  }

  const rows = changes.map(ch => {
    const gained = (ch.was === 'no' || ch.was === 'missing') && (ch.now === 'yes' || ch.now === 'src');
    const lost = (ch.was === 'yes' || ch.was === 'src') && (ch.now === 'no' || ch.now === 'missing');
    const sign = gained ? 1 : lost ? -1 : 0;
    return `| ${deltaArrow({ value: sign })} | ${providerLabel(ch.provider)} | ${ch.query} | ${ch.was} | ${ch.now} |`;
  });

  return `## What Changed (${prev.date} → ${curr.date})

| Δ | Provider | Query | Was | Now |
|---|---|---|---|---|
${rows.join('\n')}
`;
}

// ─── Section: Trend per Query ───

export function sectionTrend(snapshots) {
  // P8 — first-run placeholder instead of hiding the section entirely
  if (snapshots.length < 2) {
    const latest = snapshots[snapshots.length - 1];
    const score = latest.score || 0;
    // ASCII-style preview: week 1 marker + 11 weeks ahead
    const marker = score > 0 ? '●' : '○';
    const weeks = [`W1 ${marker}`, 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10', 'W11', 'W12'];
    return `## Trend per query

_You're on Week 1 of tracking. Sparklines populate from Week 2 onward — come back after \`aeo-tracker run\` next week._

\`\`\`
${weeks.join('   ')}
\`\`\`

_Tracking intent: you're establishing a baseline now. Real signal appears around Week 4 when short-term noise averages out._
`;
  }

  const queries = [...new Set(snapshots.flatMap(s => s.results.map(r => r.query)))].sort();
  const latest = snapshots[snapshots.length - 1];

  const lines = queries.map(q => {
    const values = snapshots.map(s => {
      const rs = s.results.filter(r => r.query === q && r.mention !== 'error');
      if (rs.length === 0) return null;
      const hits = rs.filter(r => r.mention === 'yes' || r.mention === 'src').length;
      return Math.round((hits / rs.length) * 100);
    });
    const sp = sparkline({ values });
    const qText = latest.results.find(r => r.query === q)?.queryText || q;
    return `- ${sp} **${escMd(q)}:** ${escMd(qText)}`;
  });

  return `## Trend per Query

_Each sparkline shows how often AI engines mentioned your brand for that query over the tracked period. Up = gaining visibility, flat = stable, down = losing ground._

${lines.join('\n')}
`;
}

// ─── Section: Tracked Competitors ───

export function sectionCompetitors(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const tracked = latest.topCompetitors || [];
  if (tracked.length === 0) return '';

  // Build YOU row first (accent), then competitors, sorted desc
  const you = { label: `YOU (${escMd(latest.brand)})`, value: latest.mentions || 0, accent: true };
  const compItems = tracked.slice(0, 8).map(c => ({ label: escMd(c.name), value: c.count }));
  const items = [you, ...compItems];

  return `## Competitors vs you

_Your brand's mention count vs each tracked competitor, counted across all checks this run. If a competitor dominates here, that's where AI-engine mindshare sits — invest your content/PR budget in closing the gap._

${barchart({ items })}
`;
}

// ─── Section: Canonical Sources ───

/**
 * Heuristic URL-type classification. Returns short tag for display.
 */
function classifyUrlType(url) {
  const u = String(url).toLowerCase();
  // Malformed URL falls back to the lowercased raw string — classification
  // still pattern-matches against the same hostname-shaped substring.
  const h = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return u; } })();
  if (/g2\.com|capterra\.com|producthunt\.com|trustradius\.com|getapp\.com|trustpilot\.com|softwareadvice\.com/.test(h)) return 'review-platform';
  if (/reddit\.com|news\.ycombinator|quora\.com|stackoverflow\.com/.test(h)) return 'community';
  if (/wikipedia\.org/.test(h)) return 'encyclopedia';
  if (/linkedin\.com/.test(h)) return 'social';
  if (/youtube\.com|youtu\.be/.test(h)) return 'video';
  if (/github\.com/.test(h)) return 'code';
  if (/directory|catalog|listings?/.test(u)) return 'directory';
  if (/\/blog|\/posts?|\/articles?|medium\.com|substack\.com|dev\.to/.test(u)) return 'blog';
  if (/reuters\.|bloomberg\.|wired\.|techcrunch\.|forbes\./.test(h)) return 'news';
  if (/agency|consultancy|studio/.test(h)) return 'agency';
  return 'blog';
}

const TYPE_META = {
  'review-platform': { label: 'Review platform', action: 'Create or claim your listing' },
  'community':       { label: 'Community',        action: 'Engage in relevant threads' },
  'encyclopedia':    { label: 'Encyclopedia',     action: 'Add your tool to comparison pages' },
  'directory':       { label: 'Directory',        action: 'Submit your product' },
  'blog':            { label: 'Blog / agency',    action: 'Pitch a mention or guest post' },
  'agency':          { label: 'Agency',           action: 'Pitch a case study or mention' },
  'news':            { label: 'News',             action: 'Pitch a story or press release' },
  'social':          { label: 'Social',           action: 'Engage and post relevant content' },
  'video':           { label: 'Video',            action: 'Pitch a demo or interview' },
  'code':            { label: 'Code / OSS',       action: 'Contribute or open an issue' },
};

export function sectionCanonicalSources(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const sources = latest.topCanonicalSources || [];
  if (sources.length === 0) return '';

  const hasClassification = latest.citationClassification != null;
  const onCategoryHosts = hasClassification
    ? new Set((latest.citationClassification?.onCategoryDomains || []).map(d => d.hostname))
    : null;
  const industryByHost = new Map(
    (latest.citationClassification?.onCategoryDomains || []).map(d => [d.hostname, d.industry])
  );

  // Group by hostname, filter to on-category only when classification available
  const byHost = new Map();
  for (const s of sources) {
    try {
      const host = new URL(s.url).hostname.replace(/^www\./, '');
      if (hasClassification && !onCategoryHosts.has(host)) continue;
      const existing = byHost.get(host) || { host, total: 0, type: classifyUrlType(s.url) };
      existing.total += s.count;
      byHost.set(host, existing);
    } catch { /* malformed URL — skip */ }
  }

  const grouped = [...byHost.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  if (grouped.length === 0) {
    return `## Where to get mentioned

_No relevant citation targets found yet. Fix the category mismatch (see warning above) and re-run._
`;
  }

  const rows = grouped.map(g => {
    const meta = TYPE_META[g.type] || TYPE_META['blog'];
    const industry = industryByHost.get(g.host) || meta.label;
    return `| \`${escMd(g.host)}\` | ${meta.label} | ${escMd(industry)} | ${meta.action} |`;
  }).join('\n');

  return `## Where to get mentioned

_AI engines cite these sites when answering queries in your category. Getting mentioned here is the fastest path to AEO visibility — one mention on a high-trust site propagates across all engines that rely on it._

| Site | Type | About | Your action |
|---|---|---|---|
${rows}
`;
}

// ─── Section: Next Steps (actionable) ───

export function sectionNextSteps(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const providers = [...new Set(latest.results.map(r => r.provider))];
  const stats = providers.map(p => ({ p, ...providerStats(latest.results, p) }));
  const invisible = stats.filter(s => s.hits === 0 && s.total > 0);
  const partial = stats.filter(s => s.hits > 0 && s.hits < s.total);
  const topSrc = latest.topCanonicalSources?.[0];
  const topCompetitor = latest.topCompetitors?.[0];

  // P6 — short, scannable, checkbox-friendly. Each step = {label, why, estimate}
  const steps = [];

  if (invisible.length > 0) {
    steps.push({
      label: `Target invisible engines (${invisible.map(s => providerLabel(s.p)).join(', ')})`,
      why: 'Different engines pull from different source pools — need one citation on the relevant pool per engine',
      estimate: '~2h research',
    });
  }
  if (partial.length > 0) {
    steps.push({
      label: `Fill query gaps on ${partial.map(s => providerLabel(s.p)).join(', ')}`,
      why: 'You\'re mentioned on some queries but not others — map failing queries to content gaps',
      estimate: '~1h audit',
    });
  }
  if (topSrc) {
    // Malformed URL: fall back to raw url string for the host comparison.
    // Off-host classification then misses a few edge cases, which is the
    // intended behaviour — we'd rather suggest a low-priority outreach
    // step than crash the section.
    const host = (() => { try { return new URL(topSrc.url).hostname.replace(/^www\./, ''); } catch { return topSrc.url; } })();
    const offHosts = new Set((latest.citationClassification?.offCategoryDomains || []).map(d => d.hostname));
    if (!offHosts.has(host)) {
      steps.push({
        label: `Pitch a guest post / mention on \`${escMd(host)}\``,
        why: `AI engines cite it ${topSrc.count}× for your queries — single mention propagates to multiple engines`,
        estimate: '~30min outreach',
      });
    }
  }
  if (topCompetitor && topCompetitor.count >= 2) {
    steps.push({
      label: `Reverse-engineer ${escMd(topCompetitor.name)}'s citation footprint`,
      why: `Appears in ${topCompetitor.count}/${latest.total} of your checks — where AI cites them, it could cite you`,
      estimate: '~1h research',
    });
  }
  if (snapshots.length === 1) {
    steps.push({
      label: 'Re-run `aeo-tracker run` next week',
      why: 'One snapshot is a baseline, not a trend. Week-over-week diff is where the tool becomes actionable',
      estimate: '~2min',
    });
  }

  if (steps.length === 0) return '';

  const checkboxes = steps.map(s =>
    `- [ ] **${s.label}** — ${s.estimate}\n      _${s.why}_`
  ).join('\n');

  return `## Actions this week

_Copy-paste into Todoist / Linear / your tracker of choice. Ordered by impact; pick 1–2 if you're time-constrained._

${checkboxes}
`;
}

// ─── Section: Disambiguation Warning (P4) ───

/**
 * Reads precomputed LLM citation classification from snapshot.citationClassification.
 * Shows a warning when ≥2 cited domains are off-category, regardless of score.
 *
 * Classification is computed once in cmdReport via classifyCitations() and cached
 * in _summary.json — this function is pure sync and costs $0 on subsequent runs.
 */
export function sectionDisambiguationWarning(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  if (!latest) return '';

  const classification = latest.citationClassification;
  if (!classification || !Array.isArray(classification.offCategoryDomains)) return '';
  if (classification.offCategoryDomains.length < 2) return '';

  const offList = classification.offCategoryDomains
    .map(d => `- \`${escMd(d.hostname)}\` — ${escMd(d.industry)}`)
    .join('\n');

  const count = classification.offCategoryDomains.length;
  const total = (classification.offCategoryDomains.length + classification.onCategoryDomains.length);

  return `## ⚠ Industry mismatch detected in AI citations

**${count} of ${total} cited domains belong to a different industry** (classified by LLM, not regex):

${offList}

AI engines are interpreting your queries in the wrong vertical. This happens with ambiguous terms (e.g. "AEO" matches both Answer Engine Optimization and EU customs certification).

Fix: re-run init with an explicit disambiguating category:

\`\`\`
aeo-tracker init --refresh-keywords --category="<your category> — NOT <the wrong industry>"
\`\`\`

Example: \`"Answer Engine Optimization services — NOT customs/Authorized Economic Operator"\`
`;
}

// ─── Section: Competitor Intelligence — full query × engine matrix ───

export function sectionCompetitorIntelligence(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const queries = [...new Set(latest.results.map(r => r.query))].sort();
  const providers = [...new Set(latest.results.map(r => r.provider))];

  if (providers.length === 0 || queries.length === 0) return '';

  // Count total gaps to decide whether section is worth showing
  let totalGaps = 0;
  const matrix = queries.map(q => {
    const firstR = latest.results.find(r => r.query === q);
    const qText = firstR?.queryText || q;
    return {
      query: q,
      short: qText,
      full: qText,
      cells: providers.map(p => {
        const r = latest.results.find(x => x.query === q && x.provider === p);
        if (!r || r.mention === 'error') return { status: 'missing', competitors: [] };
        const cited = (r.competitors || []).slice(0, 4);
        if (r.mention !== 'yes' && r.mention !== 'src') totalGaps++;
        return { status: r.mention, competitors: cited };
      }),
    };
  });

  // tone-driven badge via .cell-badge[data-tone]. Replaces v0.3 inline
  // Tailwind hex (#dcfce7/#15803d/#fef9c3/#854d0e/#fee2e2/#b91c1c/#f1f5f9/
  // #94a3b8) with report tokens. Markup binds to CSS in styles.css.
  const badge = (content, tone) =>
    `<span class="cell-badge" data-tone="${tone}">${content}</span>`;

  const engineHeaders = providers.map(p =>
    `<th>${providerLabel(p)}</th>`
  ).join('');

  const tableRows = matrix.map(row => {
    const cells = row.cells.map(cell => {
      let content;
      if (cell.status === 'yes') {
        content = badge('✓ YOU', 'good');
      } else if (cell.status === 'src') {
        content = badge('SRC', 'warn');
      } else if (cell.status === 'missing' || cell.status === 'error') {
        content = badge('—', 'muted');
      } else if (cell.competitors.length === 0) {
        content = badge('❌', 'bad');
      } else {
        const comps = cell.competitors
          .map(c => `<span class="cintel-comp">${escMd(c)}</span>`)
          .join(' ');
        content = `<div>${badge('❌', 'bad')}</div><div class="cintel-comps">${comps}</div>`;
      }
      return `<td class="cintel-cell" data-status="${cell.status}">${content}</td>`;
    }).join('');

    return `<tr><td class="cintel-query">${escMd(row.short)}</td>${cells}</tr>`;
  }).join('');

  const gapNote = totalGaps > 0
    ? `_${totalGaps} gap${totalGaps !== 1 ? 's' : ''} found — red cells show who AI cited instead of you._`
    : '_Your brand appeared in all tested queries._';

  return `## Competitor Intelligence

${gapNote}

<div class="cintel-table-wrap"><table class="cintel-table"><thead><tr><th>Query</th>${engineHeaders}</tr></thead><tbody>${tableRows}</tbody></table></div>
`;
}

// ─── Section: Brand Sentiment (NEW v0.3) ───
//
// Renders how each AI engine portrays the brand: positive / neutral / negative.
// Pulls r.sentiment from results — populated by classifySentimentWithTwoModels.
// Cells without sentiment (mention=no/error) are dashed out.

// Sentiment label → tone + glyph. Tone drives colour via
// `.cell-badge[data-tone="..."]` so palette decisions live in the editorial
// token system (replaces v0.3 inline Tailwind hex for fg/bg).
const SENTIMENT_BADGE = {
  positive: { tone: 'good',  icon: '👍', label: 'Positive' },
  neutral:  { tone: 'muted', icon: '◌',  label: 'Neutral'  },
  negative: { tone: 'bad',   icon: '👎', label: 'Negative' },
};

export function sectionSentiment(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const withSentiment = latest.results.filter(r => r.sentiment && r.sentiment.label);
  if (withSentiment.length === 0) return '';

  const counts = { positive: 0, neutral: 0, negative: 0 };
  for (const r of withSentiment) counts[r.sentiment.label] = (counts[r.sentiment.label] || 0) + 1;
  const total = withSentiment.length;

  const summary = ['positive', 'neutral', 'negative']
    .filter(k => counts[k] > 0)
    .map(k => `${SENTIMENT_BADGE[k].icon} **${counts[k]}** ${SENTIMENT_BADGE[k].label.toLowerCase()}`)
    .join(' · ');

  const rows = withSentiment.map(r => {
    const b = SENTIMENT_BADGE[r.sentiment.label] || SENTIMENT_BADGE.neutral;
    const conf = r.sentiment.confidence === 'high' ? ''
      : ` <span class="sent-conf">(${escMd(r.sentiment.confidence)})</span>`;
    const badge = `<span class="cell-badge" data-tone="${b.tone}">${b.icon} ${b.label}</span>${conf}`;
    const rationale = escMd(r.sentiment.rationale || '').replace(/\|/g, '\\|');
    return `| ${providerLabel(r.provider)} | ${escMd(r.query)} | ${badge} | ${rationale} |`;
  }).join('\n');

  return `## How AI Engines Portray Your Brand

_${summary} across ${total} mention${total !== 1 ? 's' : ''}. Sentiment is cross-checked by two classifier models — disagreements degrade to "neutral" with a low-confidence flag._

| Engine | Query | Sentiment | Why |
|---|---|---|---|
${rows}
`;
}

// ─── Section: Domain Share-of-Voice (NEW v0.3) ───
//
// Aggregates canonicalCitations by hostname → table of domains with their
// share of total citations. This is the "outreach map" — which publishers
// actually drive AI visibility in your category.

export function sectionDomainShareOfVoice(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  let domains = latest.topDomains;

  // Backwards-compat: compute on the fly for older _summary.json files.
  if (!Array.isArray(domains) || domains.length === 0) {
    const hostMap = {};
    let total = 0;
    for (const r of latest.results || []) {
      for (const url of (r.canonicalCitations || [])) {
        try {
          const host = new URL(url).hostname.replace(/^www\./, '');
          hostMap[host] = (hostMap[host] || 0) + 1;
          total++;
        } catch { /* skip */ }
      }
    }
    domains = Object.entries(hostMap)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([host, count]) => ({ host, count, share: total > 0 ? count / total : 0 }));
  }

  if (!domains || domains.length === 0) return '';

  const top = domains.slice(0, 10);
  const maxCount = top[0]?.count || 1;
  const rows = top.map(d => {
    const pct = (d.share * 100).toFixed(1);
    const barWidth = Math.round((d.count / maxCount) * 100);
    const bar = `<span class="share-bar" style="--bar-w:${barWidth}%"></span>`;
    return `| **${escMd(d.host)}** | ${d.count} | ${pct}% | ${bar} |`;
  }).join('\n');

  return `## Where AI Engines Get Their Answers — Domain Share of Voice

_The publishers AI cites when describing your category. Pitching the top 3 is the highest-leverage AEO move surfaced by the data — see "Outreach templates" section below for ready-to-send drafts._

| Domain | Citations | Share | |
|---|---:|---:|---|
${rows}
`;
}

// ─── Section: Historical 8-week Trend (NEW v0.3) ───
//
// Multi-snapshot visibility line. Always renders if ≥2 snapshots exist; for
// ≥8 it shows the last 8 (one per weekly cadence). Same sparkline primitive
// as per-query trend, but at full hero width.

// Window for the trend block — keeps the chart legible regardless of how
// many historical snapshots the user accumulates. Latest run is always
// at the right edge.
const TREND_WINDOW = 8;
const TREND_MIN_POINTS = 2;
const TREND_SPARK_WIDTH = 480;
const TREND_SPARK_HEIGHT = 80;

/**
 * Renders the multi-snapshot visibility trend block (sparkline + per-run tick row).
 *
 * Reads `snapshots[].score` over the last `TREND_WINDOW` runs. Returns ''
 * when fewer than `TREND_MIN_POINTS` numeric scores are available — comparing
 * a 1-run trend would mislead. Tick row shows `MM-DD` date + score per run.
 *
 * Markup binds to `.trend-block` / `.trend-delta[data-tone]` / `.trend-tick`
 * CSS classes in renderCss() so colour and spacing live in the editorial
 * token system. Replaces v0.3 inline-styled slate hex values.
 *
 * @param {Array} snapshots — chronological run snapshots; needs ≥2 with
 *   numeric `score` for the section to render.
 * @returns {string} markdown+HTML string, or '' when too few data points.
 */
export function sectionHistoricalTrend(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length < TREND_MIN_POINTS) return '';

  const recent = snapshots.slice(-TREND_WINDOW);
  const values = recent.map(s => typeof s.score === 'number' ? s.score : null);
  const present = values.filter(v => v !== null);
  if (present.length < TREND_MIN_POINTS) return '';

  const spark = sparkline({ values, width: TREND_SPARK_WIDTH, height: TREND_SPARK_HEIGHT });
  const first = present[0];
  const last = present[present.length - 1];
  const delta = last - first;
  const arrow = delta > 0 ? `↑ +${delta}` : delta < 0 ? `↓ ${delta}` : '→ flat';
  const trendTone = delta > 0 ? 'pos' : delta < 0 ? 'neg' : 'flat';

  const dateRange = `${recent[0].date} → ${recent[recent.length - 1].date}`;
  const tickRow = recent
    .map(s => `<td class="trend-tick">${(s.date || '').slice(5)}<br/><strong class="trend-tick-val">${s.score ?? '—'}%</strong></td>`)
    .join('');

  return `## Visibility Trend — last ${recent.length} run${recent.length !== 1 ? 's' : ''}

_${dateRange} · <span class="trend-delta" data-tone="${trendTone}">${arrow} pts</span> overall. Each tick = one weekly run._

<div class="trend-block">
${spark}
<table class="trend-ticks"><tr>${tickRow}</tr></table>
</div>
`;
}

// ─── Section: Outreach Email Templates (NEW v0.3) ───
//
// Renders the LLM-generated outreach emails for the top-3 cited domains.
// Source field is latest.outreachTemplates — populated by generateOutreachTemplates
// during cmdReport. Cached, so re-running `aeo-tracker report` doesn't re-spend.

/**
 * Renders ready-to-send outreach drafts for top-cited publishers.
 *
 * Reads `snapshots[-1].outreachTemplates` (LLM-generated cache populated
 * by generateOutreachTemplates during cmdReport). Returns an empty string
 * when no templates are available — caller must tolerate '' as a valid
 * «no section» signal.
 *
 * Output format: markdown heading + per-template `<article class="outreach-item">`
 * blocks. Markup binds to `.outreach-*` CSS classes in renderCss() so styling
 * lives in the editorial token system, not inline (anti-pattern fixed
 * 2026-05; see Tech Debt for remaining legacy MD-generators that still
 * inline-style with Tailwind hex).
 *
 * Security: LLM fields (host/subject/body/why) are third-party-controlled
 * (competitor-extraction context), so every interpolation passes through
 * escMd() before reaching HTML.
 *
 * @param {Array} snapshots — chronological run snapshots; last element
 *   carries `outreachTemplates: Array<{host, subject, body, why?}>`.
 * @returns {string} markdown+HTML string, or '' when no templates exist.
 */
export function sectionOutreachTemplates(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const templates = latest.outreachTemplates;
  if (!Array.isArray(templates) || templates.length === 0) return '';

  // LLM-generated fields (host/subject/body/why) are escaped before HTML
  // interpolation — they originate from competitor-extraction context which
  // includes 3rd-party text, so a literal `<script>` could otherwise leak in.
  // Markup binds to .outreach-* CSS classes defined in renderCss() — no
  // inline styles, so every token (paper, line, accent-tint, --display
  // serif) lives in the report's design system.
  const blocks = templates.map((t, i) => {
    const subject = escMd(String(t.subject || '').replace(/\n/g, ' '));
    const body = escMd(String(t.body || '')).replace(/\n/g, '<br/>');
    const why = t.why
      ? `<div class="outreach-why"><span class="outreach-why-tag">why this domain</span><span class="outreach-why-text">${escMd(t.why)}</span></div>`
      : '';
    return `<article class="outreach-item">
  <header class="outreach-head">
    <span class="outreach-num">${String(i + 1).padStart(2, '0')}</span>
    <span class="outreach-host">${escMd(t.host)}</span>
  </header>
  <div class="outreach-field outreach-subject"><span class="outreach-field-label">subject</span><span class="outreach-field-value">${subject}</span></div>
  <div class="outreach-body">${body}</div>
  ${why}
</article>`;
  }).join('\n');

  return `## Outreach Email Templates — top-${templates.length} domains

_Ready-to-send pitches for the publishers AI cites most. Personalise the article reference before sending — these are starting drafts, not finished emails. Generated once per report run and cached._

${blocks}
`;
}

// ─── Section: Competitor Radar (NEW v0.3) ───
//
// 4-axis radar (presence, sentiment, rank-strength, mentions) for the user's
// brand vs top-3 competitors. Uses the existing radar() SVG primitive.
// Variant A (chosen): 4 small radars side-by-side — single radar with 4 polygons
// is hard to parse on mobile.

// Radar rank axis: a brand named at position #1 scores 100, each subsequent
// position decays by RANK_DECAY_PER_POSITION. Chosen so the curve lands
// within the radar's [0, 100] scale across realistic ranks (1–7): #1=100,
// #2=85, #3=70, #4=55, #5=40, #6=25, #7=10, #8+=0. Linear (not log) so the
// chart stays readable for non-specialist readers.
const RANK_DECAY_PER_POSITION = 15;

// Radar mention axis: each named/cited hit contributes
// MENTION_SCORE_PER_HIT, capped at 100. 5+ mentions in a run = full bar.
// Tuned against typical run sizes (3-engine × 3-query = 9 cells), where 5
// hits represents «consistently named», not «one lucky hit».
const MENTION_SCORE_PER_HIT = 20;

// Radar sentiment axis fallback for unscored cells: 50 = neutral mid-bar
// (radar polygon doesn't collapse to centre on missing sentiment).
const SENTIMENT_NEUTRAL_FALLBACK = 50;

/**
 * Compute the four radar-axis scores (presence, sentiment, rank, mentions)
 * for a given brand across the latest run.
 *
 * Score ranges: each axis 0–100. `presence` = fraction of engines that
 * named the brand at least once. `sentiment` = mean sentiment score across
 * positive/neutral/negative tags (50 when unscored). `rank` = mean rank
 * decay (see RANK_DECAY_PER_POSITION). `mentions` = capped hit count (see
 * MENTION_SCORE_PER_HIT). Pure function — safe to memoize per (latest, brand).
 *
 * @param {object} latest — last snapshot in `snapshots` array.
 * @param {string} brandName — exact brand name (case-insensitive match).
 * @returns {{name, presence, sentiment, rank, mentions, rawMentions}}.
 */
function radarStatsForBrand(latest, brandName) {
  const results = latest.results || [];
  const providers = [...new Set(results.map(r => r.provider))];
  const total = providers.length || 1;

  let presenceCount = 0;
  let sentimentSum = 0; let sentimentN = 0;
  let rankSum = 0;     let rankN = 0;
  let mentionTotal = 0;

  const isUserBrand = (latest.brand || '').toLowerCase() === brandName.toLowerCase();

  for (const p of providers) {
    const cells = results.filter(r => r.provider === p);
    let mentioned = false;
    for (const r of cells) {
      if (isUserBrand) {
        if (r.mention === 'yes' || r.mention === 'src') {
          mentioned = true;
          mentionTotal++;
          if (r.sentiment?.label) {
            sentimentSum += sentimentToScore(r.sentiment.label);
            sentimentN++;
          }
          if (typeof r.position === 'number' && r.position > 0) {
            rankSum += Math.max(0, 100 - (r.position - 1) * RANK_DECAY_PER_POSITION);
            rankN++;
          }
        }
      } else {
        const allCompetitors = [...(r.competitors || []), ...(r.competitorsUnverified || [])];
        if (allCompetitors.some(c => c.toLowerCase() === brandName.toLowerCase())) {
          mentioned = true;
          mentionTotal++;
        }
      }
    }
    if (mentioned) presenceCount++;
  }

  const presence = (presenceCount / total) * 100;
  const sentiment = sentimentN > 0 ? sentimentSum / sentimentN : SENTIMENT_NEUTRAL_FALLBACK;
  const rank = rankN > 0 ? rankSum / rankN : (mentionTotal > 0 ? SENTIMENT_NEUTRAL_FALLBACK : 0);
  const mentionScore = Math.min(100, mentionTotal * MENTION_SCORE_PER_HIT);

  return {
    name: brandName,
    presence: Math.round(presence),
    sentiment: Math.round(sentiment),
    rank: Math.round(rank),
    mentions: Math.round(mentionScore),
    rawMentions: mentionTotal,
  };
}

export function sectionCompetitorRadar(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const topCompetitors = (latest.topCompetitors || []).slice(0, 3);
  if (topCompetitors.length === 0) return '';

  const userStats = radarStatsForBrand(latest, latest.brand);
  const competitorStats = topCompetitors.map(c => radarStatsForBrand(latest, c.name));

  // radar() SVG primitive paints its polygon with #f59e0b (amber) by default
  // — we override with currentColor so the surrounding .radar-card[data-tone]
  // (which sets color via --editor / --ink-4 token) propagates into the SVG.
  // Replaces v0.3 inline Tailwind hex (#4f46e5/#94a3b8/#eef2ff/#f8fafc/
  // #e2e8f0/#0f172a/#64748b) with report tokens via .radar-* classes.
  const buildRadar = (s, isUser) => {
    const axes = [
      { label: 'Presence', value: s.presence },
      { label: 'Sentiment', value: s.sentiment },
      { label: 'Rank', value: s.rank },
      { label: 'Mentions', value: s.mentions },
    ];
    const tone = isUser ? 'you' : 'competitor';
    const svgRaw = radar({ axes, size: 220 });
    const svg = svgRaw.replace(
      'fill="#f59e0b" fill-opacity="0.18" stroke="#f59e0b"',
      'fill="currentColor" fill-opacity="0.18" stroke="currentColor"',
    );
    return `<div class="radar-card" data-tone="${tone}">
<div class="radar-card-name">${isUser ? '★ ' : ''}${escMd(s.name)}</div>
<div class="radar-card-meta">${s.rawMentions} mention${s.rawMentions !== 1 ? 's' : ''}</div>
${svg}
</div>`;
  };

  const cards = [userStats, ...competitorStats].map((s, i) => buildRadar(s, i === 0)).join('');

  return `## Brand vs Top-3 Competitors — 4-axis Radar

_Each axis is normalised 0–100. **Presence** = share of engines that mention the brand. **Sentiment** = average tone (50 = neutral). **Rank** = average position strength when listed (higher = earlier). **Mentions** = total mention count, capped at 100._

<div class="radar-grid">
${cards}
</div>
`;
}

/**
 * HTML-only combined radar — single SVG with brand polygon overlaid on
 * top-3-competitor average. Returns raw SVG markup ready to embed inside a
 * .cell-body in the v0.5 bento layout. Markdown report keeps using
 * sectionCompetitorRadar() above for its 2×2 grid form.
 *
 * Top-3 avg formula: per-axis arithmetic mean of the top-3 competitors by
 * mentions count. If <3 competitors are present, average over whatever exists
 * (no zero-padding).
 *
 * @param {Array} snapshots
 * @returns {{svg: string, brand: string, axes: object} | null}
 */
export function competitorRadarHtml(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const topCompetitors = (latest.topCompetitors || []).slice(0, 3);
  if (topCompetitors.length === 0) return null;

  const userAxes = radarStatsForBrand(latest, latest.brand);
  const competitorAxesList = topCompetitors.map(c => radarStatsForBrand(latest, c.name));
  const avg = (key) =>
    competitorAxesList.reduce((s, c) => s + (c[key] || 0), 0) / competitorAxesList.length;
  const avgAxes = {
    presence: Math.round(avg('presence')),
    mentions: Math.round(avg('mentions')),
    rank: Math.round(avg('rank')),
    sentiment: Math.round(avg('sentiment')),
  };

  const svg = combinedRadar({
    userAxes,
    avgAxes,
    userLabel: latest.brand,
    avgLabel: competitorAxesList.length === 3 ? 'Top-3 avg' : `Top-${competitorAxesList.length} avg`,
  });
  return { svg, brand: latest.brand, userAxes, avgAxes };
}

// ─── Section: Crawlability Audit (NEW v0.4) ───
//
// Renders robots.txt + /llms.txt + sitemap.xml status plus per-bot access
// matrix. Source: latest.crawlability — populated by auditCrawlability() in
// cmdReport. The "blocked" rows are surfaced loud because they often explain
// "Claude doesn't see me" mysteries cheaper than any content audit can.

// Access state → tone + glyph + label. Tone drives the colour via
// `.crawl-badge[data-tone="..."]` CSS in renderCss(), so colour decisions
// live in the editorial token system, not in this lookup table.
const ACCESS_BADGE = {
  allowed:     { tone: 'good',  icon: '✓', label: 'Allowed' },
  blocked:     { tone: 'bad',   icon: '✗', label: 'Blocked' },
  partial:     { tone: 'warn',  icon: '◐', label: 'Partial' },
  unspecified: { tone: 'muted', icon: '—', label: 'Unspecified' },
};

/**
 * Renders the AI-Bot Crawlability Audit section (robots.txt / llms.txt /
 * sitemap.xml status + per-bot allow/block matrix grouped by provider).
 *
 * Reads `snapshots[-1].crawlability` populated by auditCrawlability() in
 * cmdReport. Returns '' when no audit has been performed (e.g. --no-crawl
 * flag or pre-v0.3 snapshot).
 *
 * Markup uses `.file-check[data-tone]` for the three site-config status
 * spans and `.crawl-badge[data-tone]` for the per-bot access pills.
 * Replaces v0.3 inline-styled Tailwind hex (#15803d / #b91c1c / #854d0e /
 * #dcfce7 / #fee2e2 / #fef9c3 / #f1f5f9 / #64748b) with report tokens.
 *
 * @param {Array} snapshots — chronological runs; last must carry
 *   `crawlability: { summary, botAccess, robots, sitemap }`.
 * @returns {string} markdown+HTML string, or '' when no crawl audit.
 */
export function sectionCrawlability(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const audit = latest.crawlability;
  if (!audit || !audit.botAccess) return '';

  const s = audit.summary;
  const fileCheck = (label, found, extra = '') => {
    const icon = found ? '✅' : '❌';
    const tone = found ? 'good' : 'bad';
    return `<span class="file-check" data-tone="${tone}">${icon} ${label}</span>${extra ? ` <span class="file-check-meta">${extra}</span>` : ''}`;
  };

  const fileLine = [
    fileCheck('robots.txt', s.hasRobots, audit.robots.bytes ? `(${audit.robots.bytes} bytes)` : ''),
    fileCheck('llms.txt',   s.hasLlmsTxt),
    fileCheck('sitemap.xml', s.hasSitemap, audit.sitemap.urlCount ? `(${audit.sitemap.urlCount} URLs)` : ''),
  ].join(' &nbsp;·&nbsp; ');

  // Group by provider for cleaner reading
  const byProvider = {};
  for (const bot of audit.botAccess) {
    if (!byProvider[bot.provider]) byProvider[bot.provider] = [];
    byProvider[bot.provider].push(bot);
  }

  const rows = Object.entries(byProvider).map(([provider, bots]) => {
    const cells = bots.map(b => {
      const a = ACCESS_BADGE[b.access] || ACCESS_BADGE.unspecified;
      return `<span class="crawl-badge" data-tone="${a.tone}">${a.icon} ${b.label}</span>`;
    }).join('');
    return `| **${provider}** | ${cells} |`;
  }).join('\n');

  let warning = '';
  if (s.blockedCount > 0) {
    const blockedNames = audit.botAccess.filter(b => b.access === 'blocked').map(b => b.label).join(', ');
    warning = `\n> ⚠️ **${s.blockedCount} bot${s.blockedCount !== 1 ? 's' : ''} blocked by robots.txt** — ${blockedNames}. These engines cannot crawl your site, so they cannot cite you. Fix in your \`robots.txt\` before content investment.\n`;
  }
  if (!s.hasLlmsTxt) {
    warning += `\n> 💡 No \`/llms.txt\` found — emerging convention for LLM-friendly summaries. Adding one (5 min) gives engines a fast-path to your key facts. See [llmstxt.org](https://llmstxt.org).\n`;
  }

  return `## AI-Bot Crawlability Audit

_${fileLine}_
${warning}
| AI Engine | Bots & Access |
|---|---|
${rows}

_Source: \`${audit.robots.url}\` (HTTP ${audit.robots.status ?? 'n/a'}). Re-audit on every \`aeo-tracker report\`._
`;
}

// ─── Section: Domain Category Breakdown (NEW v0.4) ───
//
// Aggregates topDomains by static-rule classification (Reviews / Forums /
// News / Reference / etc.) into a single table. Each category includes a
// "what to do" hint that tells the user the outreach modality for that
// bucket — pitching G2 (review) is a different play than pitching Reddit
// (forum) or Wikipedia (reference).

export function sectionDomainCategories(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const topDomains = latest.topDomains;
  if (!Array.isArray(topDomains) || topDomains.length === 0) return '';

  const categories = aggregateByCategory(topDomains);
  if (categories.length === 0) return '';

  const rows = categories.map(cat => {
    const pct = (cat.share * 100).toFixed(1);
    const examples = cat.domains.slice(0, 3).map(d => escMd(d.host)).join(', ');
    const more = cat.domains.length > 3 ? ` <span class="dom-more">+${cat.domains.length - 3} more</span>` : '';
    return `| ${cat.icon} **${escMd(cat.label)}** | ${cat.count} | ${pct}% | ${examples}${more} | ${escMd(cat.why)} |`;
  }).join('\n');

  return `## Citation Source Breakdown — by Category

_How AI gets its answers about your category. Each row maps to a different outreach play — reviews and forums need very different tactics._

| Category | Citations | Share | Top examples | Outreach move |
|---|---:|---:|---|---|
${rows}
`;
}

// ─── Section: Funnel / Intent Breakdown (NEW v0.4) ───
//
// Visibility aggregated by user-defined query tags from .aeo-tracker.json.
// Tags are arbitrary — common useful sets: ToFu/MoFu/BoFu funnel stages,
// "comparison/howto/vendor-listing" intents, regions, languages.
// Hidden when no tags are defined — zero impact on existing configs.

export function sectionFunnelBreakdown(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const tagged = (latest.results || []).filter(r => !!r.tag);
  if (tagged.length === 0) return '';

  const byTag = new Map();
  for (const r of tagged) {
    if (!byTag.has(r.tag)) byTag.set(r.tag, { tag: r.tag, total: 0, mentions: 0, errors: 0 });
    const bucket = byTag.get(r.tag);
    bucket.total++;
    if (r.mention === 'yes' || r.mention === 'src') bucket.mentions++;
    if (r.mention === 'error') bucket.errors++;
  }

  const sorted = Array.from(byTag.values()).sort((a, b) => {
    const aRate = a.total > 0 ? a.mentions / a.total : 0;
    const bRate = b.total > 0 ? b.mentions / b.total : 0;
    return bRate - aRate;
  });

  const rows = sorted.map(t => {
    const rate = t.total > 0 ? Math.round((t.mentions / t.total) * 100) : 0;
    const tone = rate >= 60 ? 'good' : rate >= 25 ? 'warn' : 'bad';
    const verdict = rate >= 60 ? 'strong' : rate >= 25 ? 'present' : rate > 0 ? 'emerging' : 'invisible';
    const barW = Math.max(2, rate);
    const bar = `<span class="share-bar" data-tone="${tone}" style="--bar-w:${barW}%"></span>`;
    return `| **${escMd(t.tag)}** | ${t.mentions}/${t.total} | <span class="rate-text" data-tone="${tone}">${rate}%</span> ${verdict} | ${bar} |`;
  }).join('\n');

  return `## Visibility by Funnel Stage / Intent Tag

_Visibility split across the tags you defined in \`.aeo-tracker.json\`. A common pattern: high ToFu, zero BoFu — means AI knows your category but not why to choose you._

| Tag | Hits | Rate | |
|---|---|---|---|
${rows}
`;
}

// ─── Section: Actionable Gap Matrix (NEW v0.4) ───
//
// For every cell where the brand was NOT mentioned but competitors were,
// surface a one-line concrete action. Cross-references topDomains so the
// recommendation references real publishers from this run, not generic advice.

export function sectionActionableGaps(snapshots, opts = {}) {
  const latest = snapshots[snapshots.length - 1];
  const results = latest.results || [];
  const topDomains = Array.isArray(latest.topDomains) ? latest.topDomains : [];
  const topDomainHost = topDomains[0]?.host;

  const gaps = results.filter(r => {
    if (r.mention === 'yes' || r.mention === 'src') return false;
    if (r.mention === 'error') return false;
    const comps = [...(r.competitors || []), ...(r.competitorsUnverified || [])];
    return comps.length > 0;
  });

  if (gaps.length === 0) return '';

  // Pick top N most actionable: prefer cells with most competitors (clearest displacement target).
  // `opts.limit` lets callers (e.g. Overview tab) request a smaller slice (top-3 preview).
  const limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : 8;
  const prioritised = gaps
    .map(r => {
      const comps = [...(r.competitors || []), ...(r.competitorsUnverified || [])];
      return { r, comps, weight: comps.length };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);

  const rows = prioritised.map(({ r, comps }) => {
    const topComp = comps[0];
    const cellHost = (() => {
      const urls = r.canonicalCitations || [];
      for (const u of urls) {
        try { return new URL(u).hostname.replace(/^www\./, ''); } catch { /* skip */ }
      }
      return null;
    })();

    const safeBrand = escMd(latest.brand);
    const safeQuery = escMd((r.queryText || r.query).slice(0, 50));
    const safeQueryShort = escMd((r.queryText || r.query).slice(0, 40));
    const safeTopComp = escMd(topComp);

    let action;
    if (cellHost) {
      action = `Pitch **${escMd(cellHost)}** to add ${safeBrand} alongside ${safeTopComp}`;
    } else if (topDomainHost) {
      action = `Get listed on **${escMd(topDomainHost)}** (top citation source overall) for "${safeQuery}..."`;
    } else {
      action = `Publish a comparison page: "${safeBrand} vs ${safeTopComp}" targeting "${safeQueryShort}..."`;
    }

    const compsBadge = comps.slice(0, 3).map(c => `<span class="cell-badge" data-tone="bad">${escMd(c)}</span>`).join(' ');

    return `| ${escMd(r.query)} | ${providerLabel(r.provider)} | ${compsBadge} | ${action} |`;
  }).join('\n');

  return `## Actionable Gaps — what to fix this week

_Top ${prioritised.length} cells where competitors are cited but you aren't. Each row is one outreach or content move tied to a real domain or competitor surfaced by this run._

| Query | Engine | Cited instead | What to do |
|---|---|---|---|
${rows}
`;
}

// ─── Section: Geographic Comparison (NEW v0.4) ───
//
// When --geo flag was used at run time, results carry a `region` field. Show
// visibility per region, broken down by engine. Highlights "you're strong in
// US but invisible in DE" patterns that single-region runs would miss.

export function sectionGeoComparison(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const results = latest.results || [];
  const withRegion = results.filter(r => !!r.region);
  if (withRegion.length === 0) return '';

  const regions = [...new Set(withRegion.map(r => r.region))].sort();
  const providers = [...new Set(withRegion.map(r => r.provider))];

  const cellRate = (region, provider) => {
    const cells = withRegion.filter(r => r.region === region && r.provider === provider && r.mention !== 'error');
    if (cells.length === 0) return null;
    const hits = cells.filter(r => r.mention === 'yes' || r.mention === 'src').length;
    return { hits, total: cells.length, rate: Math.round((hits / cells.length) * 100) };
  };

  const headerCells = providers.map(p => `<th class="geo-th-engine">${providerLabel(p)}</th>`).join('');

  const rows = regions.map(region => {
    const sample = withRegion.find(r => r.region === region);
    const label = escMd(sample?.regionLabel || region.toUpperCase());
    const cells = providers.map(p => {
      const stat = cellRate(region, p);
      if (!stat) return `<td class="geo-empty">—</td>`;
      const tone = stat.rate >= 60 ? 'good' : stat.rate >= 25 ? 'warn' : stat.rate > 0 ? 'bad' : 'muted';
      return `<td class="geo-cell" data-tone="${tone}">${stat.rate}%<span class="geo-cell-frac">${stat.hits}/${stat.total}</span></td>`;
    }).join('');
    return `<tr><td class="geo-region">${label}</td>${cells}</tr>`;
  }).join('');

  const totalCells = withRegion.length;
  const totalHits = withRegion.filter(r => r.mention === 'yes' || r.mention === 'src').length;

  return `## Visibility by Region

_Multi-region run with \`--geo\`. Each query was wrapped with a region-context preamble and sent to every engine — the LLM tailored its competitor list to that market. ${totalHits}/${totalCells} cells across ${regions.length} regions._

<div class="geo-table-wrap"><table class="geo-table"><thead><tr><th class="geo-th-region">Region</th>${headerCells}</tr></thead><tbody>${rows}</tbody></table></div>

_Use this to find geographic blind spots — strong in US but invisible in DE typically means a localised content / partnerships gap._
`;
}

// ─── Section: Unified Visibility Index (NEW v0.5) ───
//
// Single 0-100 score combining presence, sentiment, rank-strength and citation
// share with documented weights. Inspired by Rankability's SPI but open —
// every component is shown alongside the composite so the user can see what
// dragged the index down.

export function sectionUnifiedVisibilityIndex(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  if (!latest || !latest.results || latest.results.length === 0) return '';

  const c = computeComponents(latest);
  const uvi = computeUVI(c);

  const tone = uvi >= 70 ? 'good' : uvi >= 40 ? 'warn' : uvi > 0 ? 'bad' : 'muted';
  const verdict = uvi >= 70 ? 'STRONG' : uvi >= 40 ? 'PRESENT' : uvi > 0 ? 'EMERGING' : 'INVISIBLE';

  const componentRow = (label, value, weight, hint) => {
    const t = value >= 60 ? 'good' : value >= 25 ? 'warn' : value > 0 ? 'bad' : 'muted';
    const barW = Math.max(2, value);
    return `| **${label}** | <span class="rate-text" data-tone="${t}">${value}/100</span> | ${(weight * 100).toFixed(0)}% | <span class="share-bar" data-tone="${t}" style="--bar-w:${barW}%"></span> | ${hint} |`;
  };

  const rows = [
    componentRow('Presence',  c.presence,  0.35, 'share of cells where brand was mentioned'),
    componentRow('Sentiment', c.sentiment, 0.25, 'avg tone (50 = neutral)'),
    componentRow('Rank',      c.rank,      0.20, 'avg position strength when listed'),
    componentRow('Citation',  c.citation,  0.20, 'share of cells with brand domain in citations'),
  ].join('\n');

  return `## Unified Visibility Index (UVI)

<div class="score-block">
<div class="score-block-label">Unified Visibility Index</div>
<div class="score-block-num" data-tone="${tone}">${uvi}<span class="score-block-frac"> / 100</span></div>
<div class="score-block-verdict" data-tone="${tone}">${verdict}</div>
<div class="score-block-meta">Composite of 4 signals · sample size ${c.sample} cell${c.sample !== 1 ? 's' : ''}</div>
</div>

| Component | Score | Weight | | Meaning |
|---|---:|---:|---|---|
${rows}

_The UVI is a transparent composite — weights are defined in \`lib/report/visibility-index.js\`. Use the per-component scores to spot which dimension dragged the index down: low **Presence** → invest in citations, low **Sentiment** → PR work, low **Rank** → competitor displacement, low **Citation** → site-level discoverability._
`;
}

// ─── Section: Discoverability Score (NEW v0.5) ───
//
// Composite score derived from crawlability audit data. No extra fetches —
// just summarises whether the brand's site is even findable by AI engines.

export function sectionDiscoverability(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const result = computeDiscoverability(latest?.crawlability);
  if (!result) return '';

  const tone = result.score >= 70 ? 'good' : result.score >= 40 ? 'warn' : 'bad';
  const rows = Object.entries(result.breakdown).map(([key, b]) => {
    const t = b.value >= 60 ? 'good' : b.value >= 25 ? 'warn' : 'bad';
    return `| **${key}** | <span class="rate-text" data-tone="${t}">${b.value}/100</span> | ${(b.weight * 100).toFixed(0)}% | ${b.note} |`;
  }).join('\n');

  return `## Discoverability Score

<div class="score-block score-block-row">
<div class="score-block-num" data-tone="${tone}">${result.score}<span class="score-block-frac">/100</span></div>
<div class="score-block-body">
<div class="score-block-body-title">Site readiness for AI crawlers</div>
<div class="score-block-body-note">Derived from robots.txt, AI bot access matrix, sitemap.xml, and /llms.txt presence — no extra HTTP requests beyond the crawlability audit.</div>
</div>
</div>

| Signal | Score | Weight | Note |
|---|---:|---:|---|
${rows}
`;
}

// ─── Section: Topic Clusters (NEW v0.5) ───
//
// Groups queries by shared content words → per-cluster visibility. Surfer's
// "Topical Map" framing made open and free. AEO is a cluster game, not a
// query game — fixing one query fixes the cluster.

export function sectionTopicClusters(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const clusters = clusterQueries(latest);
  if (clusters.length === 0) return '';
  if (clusters.length === 1 && clusters[0].topic === 'uncategorised') return '';

  const rows = clusters.map(cl => {
    const t = cl.rate >= 60 ? 'good' : cl.rate >= 25 ? 'warn' : cl.rate > 0 ? 'bad' : 'muted';
    const exampleQueries = cl.queries.slice(0, 3).map(q => `<code>${escMd(q.text.slice(0, 50)).replace(/\|/g, '\\|')}${q.text.length > 50 ? '…' : ''}</code>`).join(' · ');
    return `| **${escMd(cl.topic)}** | ${cl.queries.length} | <span class="rate-text" data-tone="${t}">${cl.rate}%</span> (${cl.hits}/${cl.total}) | ${exampleQueries} |`;
  }).join('\n');

  return `## Topical Visibility Clusters

_Queries grouped by shared content words → visibility at the cluster level. AEO is a cluster game: fixing one query usually fixes the whole topic. Cluster keys are the most-frequent shared word across each group._

| Topic | Queries | Visibility | Examples |
|---|---:|---|---|
${rows}
`;
}

// ─── Section: Authority Presence (NEW v0.6) ───
//
// Wikipedia + Reddit presence. Off-page signals AI engines weight heavily.
// Free public APIs, cached in _summary.json::authorityPresence.

/**
 * Renders the Authority-Source Presence cell (Wikipedia + Reddit status).
 *
 * Reads `snapshots[-1].authorityPresence` (free-API scan, cached). Returns
 * '' when scan didn't run (e.g. report --no-authority flag).
 *
 * Output uses `.auth-badge[data-tone="good|warn|bad"]` CSS classes so badge
 * colours bind to report tokens (--good / --warn / --bad). Replaces v0.5
 * inline Tailwind hex (#fef9c3 / #dcfce7 / #fee2e2) which outshone the
 * warm-paper system.
 *
 * Security: Wikipedia extract is third-party text — passed through escMd()
 * before HTML interpolation.
 *
 * @param {Array} snapshots — chronological runs; last element carries
 *   `authorityPresence: { wikipedia, reddit }` shape.
 * @returns {string} markdown+HTML string, or '' when no authority data.
 */
/**
 * Per-source row builders. Each returns `{ label, badge, detail, tips }`
 * for the table. Adding a new source = adding one builder here. The
 * orchestrator already returns an additive shape — new sources appear
 * as extra keys (e.g. `ap.hn`, `ap.devto`) and only render if present.
 */
const SOURCE_BUILDERS = {
  wikipedia: (src, profile) => {
    if (!src) return null;
    const badge = src.found
      ? (src.isDisambiguation
          ? `<span class="auth-badge" data-tone="warn">⚠ Disambiguation page</span>`
          : `<span class="auth-badge" data-tone="good">✓ Article exists</span>`)
      : `<span class="auth-badge" data-tone="bad">✗ No article</span>`;
    const link = src.found
      ? `[View on Wikipedia](${src.pageUrl})`
      : `[Create one](${src.queryUrl || 'https://en.wikipedia.org/wiki/Wikipedia:Your_first_article'})`;
    const extract = src.found && src.extract
      ? `<br/><span class="auth-extract">"${escMd(src.extract)}…"</span>`
      : '';
    const tips = [];
    // Wikipedia "earn coverage" advice is not actionable for dev-tools —
    // a CLI/SDK rarely meets WP:NCORP notability. The caveat note above
    // the table already explains why the ✗ is expected for this segment;
    // surfacing the tip too is noise. Disambiguation tip stays because it's
    // a real fixable problem regardless of segment.
    if (!src.found && profile?.type !== 'dev-tool') {
      tips.push('No Wikipedia article — earn coverage in 3+ independent reliable sources first, then a third party can create one (you cannot create your own per WP:COI).');
    }
    if (src.isDisambiguation) tips.push('Wikipedia entry is a disambiguation — your brand competes for the term. Earn enough notability to claim the primary topic.');
    return { label: 'Wikipedia', badge, detail: `${link}${extract}`, tips };
  },

  reddit: (src, profile) => {
    if (!src) return null;
    const badge = src.found
      ? `<span class="auth-badge" data-tone="good">✓ ${src.mentionCount}${src.capped ? '+' : ''} posts</span>`
      : `<span class="auth-badge" data-tone="bad">✗ Not discussed</span>`;
    const detail = (src.topSubs || []).map(s => `<code>r/${escMd(s.name)}</code> (${s.count})`).join(' · ')
      || '<span class="auth-empty">No discussion yet — see hints below</span>';
    // Reddit advice is segment-specific. Dev-tools should hit r/programming /
    // r/webdev / r/devops; consumer brands their category subs. The generic
    // "find subreddits in your category" wording works for both — keep tip
    // even for dev-tool because it's still actionable (unlike Wikipedia for
    // dev-tools).
    const tips = src.found
      ? []
      : ['No Reddit discussion — find subreddits in your category (search bar) and answer questions with verifiable expertise. Do not spam.'];
    return { label: 'Reddit', badge, detail, tips };
  },

  github: (src) => {
    if (!src) return null;
    const tips = [];
    let badge, detail;
    if (src.found && src.topRepo) {
      const r = src.topRepo;
      // Tone: "good" only when there's real traction (≥10 stars OR a namesake
      // repo). A 0-star non-namesake side project is a weak signal — surface
      // it as "warn" so the row reads honestly.
      const hasTraction = (r.stars >= 10) || r.namesake;
      const tone = hasTraction ? 'good' : 'warn';
      const flagshipNote = r.namesake ? ' · flagship' : '';
      badge = `<span class="auth-badge" data-tone="${tone}">${tone === 'good' ? '✓' : '◐'} ${r.stars} ★ · ${r.forks} forks${flagshipNote}</span>`;
      detail = `[${escMd(r.fullName)}](${r.url})${r.description ? `<br/><span class="auth-extract">"${escMd(r.description)}…"</span>` : ''}`;
      // If we couldn't find the namesake repo, hint that the org has activity
      // but no flagship — the actionable next step is ranking up the brand's
      // primary repo.
      if (!r.namesake && r.stars < 10) {
        tips.push('GitHub org exists but the flagship repo isn\'t earning stars yet. Pin the brand\'s primary repo (rename to match the brand if needed) and seed it with a strong README + demo.');
      }
    } else if (src.found) {
      badge = `<span class="auth-badge" data-tone="warn">◐ org exists, no repos</span>`;
      detail = `[${escMd(src.owner)}](${src.ownerUrl})`;
      tips.push('GitHub org exists but no public repos — ship the brand\'s flagship project as open-source. AI engines weight GitHub stars as authority for dev-tool brands.');
    } else {
      badge = `<span class="auth-badge" data-tone="bad">✗ No org found</span>`;
      detail = '<span class="auth-empty">Reserve the org name; ship a public repo for AI engines to index.</span>';
      tips.push('No GitHub org under the brand slug — reserve it (free) and publish a public repo. AI engines weight GitHub presence heavily for dev-tool brands.');
    }
    if (src.error && /rate-limited/i.test(src.error)) {
      tips.push('GitHub API rate-limited unauthenticated (60/h). Set GITHUB_TOKEN env var for 5000/h.');
    }
    return { label: 'GitHub', badge, detail, tips };
  },
};

// Stable order so a dev-tool report reads: GitHub (primary) → Wikipedia →
// Reddit (rarely populated for this segment). For default profile the wiki
// remains first.
function sourceOrder(profileType) {
  if (profileType === 'dev-tool') return ['github', 'wikipedia', 'reddit'];
  return ['wikipedia', 'reddit', 'github'];
}

export function sectionAuthorityPresence(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const ap = latest.authorityPresence;
  if (!ap) return '';

  // Profile may be absent on cached snapshots from before the additive
  // upgrade. Fall back to legacy display (wiki+reddit only) — never crash
  // on missing fields. New shape: `ap.profile = {type, extras, caveat}`.
  const profile = ap.profile || { type: 'default', extras: [], caveat: '' };

  // Build rows for every present source in stable order.
  const order = sourceOrder(profile.type);
  const rows = [];
  const allTips = [];
  for (const key of order) {
    const build = SOURCE_BUILDERS[key];
    if (!build) continue;
    const built = build(ap[key], profile);
    if (!built) continue;
    rows.push(`| **${built.label}** | ${built.badge} | ${built.detail} |`);
    allTips.push(...built.tips);
  }

  // Profile caveat — a one-liner sitting just above the table that frames
  // why some rows look "bad" for a segment (e.g. dev tools rarely have
  // Wikipedia articles, so the ✗ is not a real authority gap).
  //
  // Only render when the framing is actually relevant: for dev-tool the
  // caveat helps explain wiki/reddit ✗ — but if wiki OR reddit found, the
  // caveat reads as a false statement («rarely populated» while staring
  // at the populated row). Suppress in that case.
  const wikiFound  = ap.wikipedia && ap.wikipedia.found;
  const redditFound= ap.reddit    && ap.reddit.found;
  const caveatStillRelevant = profile.caveat && !wikiFound && !redditFound;
  const caveat = caveatStillRelevant
    ? `\n\n<p class="auth-caveat">${escMd(profile.caveat)}</p>`
    : '';

  // Tips rendered static (no <details>) so the section stays consistent
  // with the rest of the 2026 editorial report. Each source contributes
  // its own tips; the orchestrator collects them in source order.
  let advisory = '';
  if (allTips.length > 0) {
    // Plain `<li>` (no emoji bullet) — editorial 2026 lets typography carry
    // the visual weight via .auth-advisory-head + .auth-tips list-style
    // tokens. The 💡-prefix from v0.5 read as 2022 «friendly tutorial».
    const tipItems = allTips.map(t => `<li>${t}</li>`).join('');
    advisory = `\n<div class="auth-advisory"><h4 class="auth-advisory-head">Why this matters · ${allTips.length} hint${allTips.length !== 1 ? 's' : ''}</h4><ul class="auth-tips">${tipItems}</ul></div>\n`;
  }

  return `## Authority-Source Presence

_Off-page signals AI engines weight heavily — they're part of the ground-truth corpus most LLMs trained on._${caveat}

| Source | Status | Detail |
|---|---|---|
${rows.join('\n')}
${advisory}`;
}

// ─── Section: AI Ads Detection (NEW v0.6) ───
//
// Heuristic disclosure scan. Flags responses that include sponsored markers
// or ad-network citations. Precision-over-recall — false positives undermine
// the signal, so we only count what's explicitly disclosed.

/**
 * Renders the AI Ads / Sponsored-Content Detection section.
 *
 * Reads `snapshots[-1].adsDetected` (heuristic scan output). Returns '' when
 * the scan didn't run. When 0 ad signals found, renders a «scanned, clean»
 * stanza; when ≥1, renders a per-provider summary + up to 5 sample blocks
 * via `.ads-sample` CSS class (warn-tinted, report tokens).
 *
 * Sample-block markup replaces v0.5 inline Tailwind palette (#fef9c3
 * + #854d0e + #1e293b) — see Tech Debt entry.
 *
 * Security: snippet content originates from LLM responses; escMd() applied.
 *
 * @param {Array} snapshots — chronological runs; last carries `adsDetected`.
 * @returns {string} markdown+HTML string, or '' when no ads-scan data.
 */
export function sectionAdsDetection(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const ads = latest.adsDetected;
  if (!ads) return '';

  if (ads.totalCellsWithAdSignal === 0) {
    return `## AI Ads / Sponsored-Content Detection

_${ads.totalCellsScanned} cell${ads.totalCellsScanned !== 1 ? 's' : ''} scanned for sponsored markers and ad-network citations — none found this run. As AI engines roll out ad inventory, this section will surface paid placements automatically._
`;
  }

  const providerRows = Object.entries(ads.byProvider)
    .sort((a, b) => b[1] - a[1])
    .map(([p, count]) => `| ${providerLabel(p)} | ${count} cell${count !== 1 ? 's' : ''} |`)
    .join('\n');

  // Ad-sample blocks — bound to .ads-sample CSS class (report tokens).
  // Replaces v0.5 inline Tailwind (#fef9c3 yellow + #854d0e + #1e293b)
  // with --warn-soft / --warn / --ink-2 so samples sit in the warm-paper
  // system instead of looking like an embedded Notion callout.
  const sampleBlocks = (ads.samples || []).slice(0, 5).map(s => {
    const snip = escMd(s.snippet || '');
    return `<div class="ads-sample">
  <div class="ads-sample-meta">${providerLabel(s.provider)} · ${escMd(s.query)} · <code class="ads-sample-kind">${escMd(s.kind)}</code></div>
  <div class="ads-sample-snip">"${snip}"</div>
</div>`;
  }).join('');

  return `## AI Ads / Sponsored-Content Detection

_${ads.totalCellsWithAdSignal} of ${ads.totalCellsScanned} cells contained an ad signal — sponsored markers in the response text or ad-network citations. As AI engines roll out commercial inventory, distinguishing paid from organic citations becomes critical._

| Engine | Cells with ad signal |
|---|---|
${providerRows}

${sampleBlocks}
`;
}

// ─── Section: UTM Citation Tracker (NEW v0.6) ───
//
// Surfaces UTM-tagged URLs from your own domain when AI engines cite them.
// Empty when no UTMs detected — degrades gracefully for users who don't tag.

export function sectionUtmCitations(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const utm = aggregateUtmCitations(latest.results, latest.domain);
  if (utm.totalUtmCitations === 0) return '';

  const sourceRows = utm.bySource.map(s => `| ${escMd(s.source)} | ${s.count} |`).join('\n');
  const campaignRows = utm.byCampaign.map(c => `| ${escMd(c.campaign)} | ${c.count} |`).join('\n');
  const sampleRows = utm.samples.map(s =>
    `| ${providerLabel(s.provider)} | ${escMd(s.query)} | ${escMd(s.source) || '—'} | ${escMd(s.medium) || '—'} | ${escMd(s.campaign) || '—'} |`
  ).join('\n');

  return `## UTM-Tagged Citations

_${utm.totalUtmCitations} citation${utm.totalUtmCitations !== 1 ? 's' : ''} on your own domain carried UTM parameters this run. If you UTM-tag pages you want AI to send traffic to, this is your AEO attribution table — pair with GA4 acquisition reports to close the loop._

### By source
| utm_source | Citations |
|---|---:|
${sourceRows}

### By campaign
| utm_campaign | Citations |
|---|---:|
${campaignRows}

### Sample cells
| Engine | Query | Source | Medium | Campaign |
|---|---|---|---|---|
${sampleRows}
`;
}

// ─── Section: Footer ───

export function sectionFooter(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  return `---

### Need help getting cited by AI answer engines?

**[Webappski](https://webappski.com/en/aeo-services)** is the AEO agency behind \`aeo-tracker\`. We run weekly audits like this one, implement the kinds of actions this report recommends (third-party placements, comparison pages, authority building), and publish what we learn openly at [webappski.com/blog](https://webappski.com/en/posts/aeo-visibility-challenge-week-1). If you want a second opinion on your numbers — or help turning them around — [talk to us](https://webappski.com/en/aeo-services).

---

_Generated by @webappski/aeo-tracker. Raw responses: \`aeo-responses/${escMd(latest.date)}/\`. Re-run: \`aeo-tracker report\`._
`;
}

// ─── Section: AEO Mission Control bridge (markdown) ───
//
// Renders a "Generate metadata" section for the markdown report. Markdown
// can't have buttons / modals — so this is a static section with the JSON
// payload embedded in a fenced ```json block. Terminal users can `cat` /
// `grep` the report and copy the JSON manually. The HTML report renders an
// interactive bridge (see lib/report/mc-bridge.js).
//
// @param {Object[]} snapshots
// @param {Object} metadata     pre-built metadata payload (see mc-metadata.js)
// @returns {string} markdown
export function sectionMcMetadataMd(snapshots, metadata) {
  if (!metadata) return '';
  const queries = metadata.aggregates?.totalQueries ?? 0;
  const groundingNote = queries < 7
    ? `\n_⚠ Only ${queries} queries this run — for full plan grounding, expand additively: \`aeo-tracker init --queries=10 --add-queries\`._`
    : queries < 10
    ? `\n_${queries} queries — enough to draft a plan; ≥10 unlocks full per-engine confidence._`
    : '';

  const json = JSON.stringify(metadata, null, 2);

  return `---

## Generate metadata for AEO Mission Control

Copy the JSON below and paste it into your project page at [webappski.com/en/portal/aeo-mission-control](https://webappski.com/en/portal/aeo-mission-control). Webappski generates a personalised 30-mission AEO plan (≈1–3 hours per mission, work at your pace) grounded in this exact data — turnaround 1-3 business days during the founder-only beta. Your raw responses, queries, and API spend stay on your machine. Only the metadata in this block is uploaded.${groundingNote}

\`\`\`json
${json}
\`\`\`

> 💡 Open the HTML report (\`aeo-tracker report --html\`) for an interactive **Generate metadata** button with one-click clipboard copy.
`;
}
