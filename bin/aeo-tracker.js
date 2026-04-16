#!/usr/bin/env node

/**
 * @webappski/aeo-tracker v0.1.0
 * Open-source CLI for tracking brand visibility across AI answer engines.
 * https://webappski.com | MIT License
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

// ─── ANSI colors (zero-dep) ───
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', white: '\x1b[37m',
};

// ─── Config ───
const CONFIG_FILE = '.aeo-tracker.json';
const DEFAULT_CONFIG = {
  brand: '',
  domain: '',
  queries: ['', '', ''],
  providers: {
    openai: { model: 'gpt-4o-search-preview', env: 'OPENAI_API_KEY' },
    gemini: { model: 'gemini-2.0-flash', env: 'GEMINI_API_KEY' },
    anthropic: { model: 'claude-sonnet-4-6', env: 'ANTHROPIC_API_KEY' },
  },
};

// ─── API Callers ───

async function callOpenAI(query, apiKey, model) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      web_search_options: {},
      messages: [{ role: 'user', content: query }],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`OpenAI: ${json.error.message}`);
  const text = json.choices?.[0]?.message?.content || '';
  const citations = (json.choices?.[0]?.message?.annotations || [])
    .filter(a => a.url_citation).map(a => a.url_citation.url);
  return { text, citations, raw: json };
}

async function callGemini(query, apiKey, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: query }] }],
      tools: [{ google_search: {} }],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`Gemini: ${json.error.message}`);
  const text = (json.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('\n');
  const citations = (json.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
    .map(ch => ch.web?.uri).filter(Boolean);
  return { text, citations, raw: json };
}

async function callAnthropic(query, apiKey, model) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      messages: [{ role: 'user', content: query }],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`Anthropic: ${json.error.message}`);
  const text = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const citations = (json.content || [])
    .filter(b => b.type === 'web_search_tool_result')
    .flatMap(b => (b.content || []).map(c => c.url).filter(Boolean));
  return { text, citations, raw: json };
}

const PROVIDERS = {
  openai: { call: callOpenAI, label: 'ChatGPT (OpenAI)' },
  gemini: { call: callGemini, label: 'Gemini (Google)' },
  anthropic: { call: callAnthropic, label: 'Claude (Anthropic)' },
};

// ─── Mention Detection ───

function detectMention(text, citations, brand, domain) {
  const lowerText = text.toLowerCase();
  const lowerBrand = brand.toLowerCase();
  const lowerDomain = domain.toLowerCase();

  const inText = lowerText.includes(lowerBrand) || lowerText.includes(lowerDomain);
  const inCitations = citations.some(
    url => url.toLowerCase().includes(lowerDomain) || url.toLowerCase().includes(lowerBrand)
  );

  if (inText) return 'yes';
  if (inCitations) return 'src';
  return 'no';
}

function findPosition(text, brand, domain) {
  const lower = text.toLowerCase();
  const terms = [brand.toLowerCase(), domain.toLowerCase()];
  let earliest = Infinity;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx >= 0 && idx < earliest) earliest = idx;
  }
  if (earliest === Infinity) return null;
  const before = text.slice(0, earliest);
  const numberedItems = before.match(/^\d+[\.\)]/gm);
  return numberedItems ? numberedItems.length + 1 : 1;
}

function extractCompetitors(text, brand) {
  const lines = text.split('\n');
  const competitors = [];
  const brandLower = brand.toLowerCase();
  const NOISE = /^(step|note|warning|tip|important|key|example|q\d|how|what|why|use|get|set|add|the|a |an |for|with|from|your|this|our|that|make|improve|submit|stay|create|high|low|check|follow|free|best|top|new|first)/i;
  for (const line of lines) {
    const matches = line.match(/\*\*([^*]+)\*\*/g);
    if (matches) {
      for (const m of matches) {
        const name = m.replace(/\*\*/g, '').trim();
        if (name.length > 3 && name.length < 50 &&
            !name.toLowerCase().includes(brandLower) &&
            !name.includes(':') &&
            !name.includes('(') &&
            !NOISE.test(name) &&
            name.split(' ').length <= 5 &&
            /[A-Z]/.test(name.charAt(0))) {
          competitors.push(name);
        }
      }
    }
  }
  return [...new Set(competitors)].slice(0, 10);
}

// ─── Commands ───

async function cmdInit() {
  if (existsSync(CONFIG_FILE)) {
    console.log(`${c.yellow}Config already exists: ${CONFIG_FILE}${c.reset}`);
    console.log(`Edit it manually or delete and run init again.`);
    return;
  }

  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  console.log(`\n${c.bold}@webappski/aeo-tracker — init${c.reset}\n`);

  const brand = await ask(`Brand name (e.g. webappski): `);
  const domain = await ask(`Domain (e.g. webappski.com): `);
  console.log(`\nEnter 3 unbranded test queries (one per line):`);
  const q1 = await ask(`Q1 (commercial intent): `);
  const q2 = await ask(`Q2 (informational intent): `);
  const q3 = await ask(`Q3 (vertical intent): `);

  rl.close();

  const config = { ...DEFAULT_CONFIG, brand, domain, queries: [q1, q2, q3] };
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log(`\n${c.green}Created ${CONFIG_FILE}${c.reset}`);
  console.log(`\nSet your API keys as environment variables:`);
  console.log(`  export OPENAI_API_KEY=sk-...`);
  console.log(`  export GEMINI_API_KEY=AI...`);
  console.log(`  export ANTHROPIC_API_KEY=sk-ant-...\n`);
  console.log(`Then run: ${c.cyan}aeo-tracker run${c.reset}`);
}

async function cmdRun(options) {
  // Load config
  if (!existsSync(CONFIG_FILE)) {
    console.error(`${c.red}No ${CONFIG_FILE} found. Run: aeo-tracker init${c.reset}`);
    process.exit(1);
  }

  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
  const { brand, domain, queries, providers: providerConfig } = config;

  if (!brand || !domain || !queries?.length) {
    console.error(`${c.red}Invalid config. brand, domain, and queries are required.${c.reset}`);
    process.exit(1);
  }

  // Check API keys
  const activeProviders = [];
  for (const [name, cfg] of Object.entries(providerConfig || DEFAULT_CONFIG.providers)) {
    const envKey = cfg.env || `${name.toUpperCase()}_API_KEY`;
    const apiKey = process.env[envKey];
    if (apiKey) {
      activeProviders.push({ name, model: cfg.model, apiKey, ...PROVIDERS[name] });
    } else {
      console.log(`${c.dim}Skipping ${name} (no ${envKey} set)${c.reset}`);
    }
  }

  if (activeProviders.length === 0) {
    console.error(`${c.red}No API keys found. Set at least one: OPENAI_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY${c.reset}`);
    process.exit(1);
  }

  const date = new Date().toISOString().split('T')[0];
  const responseDir = join('aeo-responses', date);
  await mkdir(responseDir, { recursive: true });

  console.log(`\n${c.bold}@webappski/aeo-tracker — run${c.reset}`);
  console.log(`${c.dim}Brand: ${brand} | Domain: ${domain} | Date: ${date}${c.reset}`);
  console.log(`${c.dim}Providers: ${activeProviders.map(p => p.label).join(', ')}${c.reset}`);
  console.log(`${c.dim}Queries: ${queries.length}${c.reset}\n`);

  // Run all checks in parallel
  const results = [];
  const tasks = [];

  for (let qi = 0; qi < queries.length; qi++) {
    const query = queries[qi];
    for (const provider of activeProviders) {
      tasks.push((async () => {
        const tag = `Q${qi + 1}/${provider.name}`;
        try {
          process.stdout.write(`${c.dim}  Running ${tag}...${c.reset}`);
          const { text, citations, raw } = await provider.call(query, provider.apiKey, provider.model);

          // Save raw response
          const rawFile = join(responseDir, `q${qi + 1}-${provider.name}.json`);
          await writeFile(rawFile, JSON.stringify(raw, null, 2));

          const mention = detectMention(text, citations, brand, domain);
          const position = mention === 'yes' ? findPosition(text, brand, domain) : null;
          const competitors = extractCompetitors(text, brand);

          results.push({
            query: `Q${qi + 1}`,
            queryText: query,
            provider: provider.name,
            label: provider.label,
            model: provider.model,
            mention,
            position,
            citationCount: citations.length,
            competitors,
            hasBrandInCitations: citations.some(u =>
              u.toLowerCase().includes(domain.toLowerCase())
            ),
          });
          const icon = mention === 'yes' ? `${c.green}YES` : mention === 'src' ? `${c.yellow}SRC` : `${c.red}NO`;
          process.stdout.write(`\r  ${icon}${c.reset} ${tag} (${citations.length} citations)\n`);
        } catch (err) {
          process.stdout.write(`\r  ${c.red}ERR${c.reset} ${tag}: ${err.message}\n`);
          results.push({
            query: `Q${qi + 1}`, queryText: query,
            provider: provider.name, label: provider.label,
            model: provider.model, mention: 'error',
            position: null, citationCount: 0,
            competitors: [], error: err.message,
          });
        }
      })());
    }
  }

  await Promise.all(tasks);

  // ─── Summary ───
  const total = results.filter(r => r.mention !== 'error').length;
  const mentions = results.filter(r => r.mention === 'yes' || r.mention === 'src').length;
  const score = total > 0 ? Math.round((mentions / total) * 100) : 0;
  const errors = results.filter(r => r.mention === 'error').length;

  console.log(`\n${c.bold}${'═'.repeat(60)}${c.reset}`);
  console.log(`${c.bold}  AEO VISIBILITY REPORT — ${brand}${c.reset}`);
  console.log(`${c.bold}${'═'.repeat(60)}${c.reset}\n`);

  // Per-query table
  console.log(`${c.bold}  Query                                      ${activeProviders.map(p => p.name.padEnd(12)).join('')}${c.reset}`);
  console.log(`  ${'─'.repeat(44)}${activeProviders.map(() => '─'.repeat(12)).join('')}`);

  for (let qi = 0; qi < queries.length; qi++) {
    const label = `Q${qi + 1}: ${queries[qi].slice(0, 40)}`;
    const cells = activeProviders.map(p => {
      const r = results.find(r => r.query === `Q${qi + 1}` && r.provider === p.name);
      if (!r) return c.dim + 'skip'.padEnd(12) + c.reset;
      if (r.mention === 'yes') return c.green + c.bold + 'YES'.padEnd(12) + c.reset;
      if (r.mention === 'src') return c.yellow + 'SRC'.padEnd(12) + c.reset;
      if (r.mention === 'error') return c.red + 'ERR'.padEnd(12) + c.reset;
      return c.red + 'no'.padEnd(12) + c.reset;
    });
    console.log(`  ${label.padEnd(44)}${cells.join('')}`);
  }

  console.log(`\n${c.bold}  Score: ${score}%${c.reset} (${mentions}/${total} checks returned a mention)`);
  if (errors > 0) console.log(`  ${c.yellow}${errors} checks failed (API errors)${c.reset}`);

  // Top competitors
  const allCompetitors = {};
  for (const r of results) {
    for (const comp of r.competitors) {
      allCompetitors[comp] = (allCompetitors[comp] || 0) + 1;
    }
  }
  const sortedCompetitors = Object.entries(allCompetitors)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  if (sortedCompetitors.length > 0) {
    console.log(`\n${c.bold}  Top competitors mentioned instead:${c.reset}`);
    for (const [name, count] of sortedCompetitors) {
      console.log(`    ${c.cyan}${name}${c.reset} (${count} checks)`);
    }
  }

  console.log(`\n${c.dim}  Raw responses saved to: ${responseDir}/${c.reset}`);
  console.log(`${c.dim}  Run weekly for trends. Full methodology: webappski.com/blog/aeo-visibility-challenge-week-1${c.reset}\n`);

  // Save summary JSON
  const summary = {
    date,
    brand,
    domain,
    score,
    mentions,
    total,
    errors,
    results: results.map(({ raw, ...r }) => r),
    topCompetitors: sortedCompetitors.map(([name, count]) => ({ name, count })),
  };
  await writeFile(join(responseDir, '_summary.json'), JSON.stringify(summary, null, 2));

  process.exit(mentions > 0 ? 0 : 1);
}

// ─── CLI Entry ───

const HELP = `
${c.bold}@webappski/aeo-tracker${c.reset} — Track brand visibility in AI answer engines

${c.bold}Usage:${c.reset}
  aeo-tracker init         Create .aeo-tracker.json config
  aeo-tracker run          Run visibility audit (reads config, calls APIs)
  aeo-tracker --help       Show this help
  aeo-tracker --version    Show version

${c.bold}Environment variables:${c.reset}
  OPENAI_API_KEY           OpenAI API key (for ChatGPT via gpt-4o-search-preview)
  GEMINI_API_KEY           Google AI API key (for Gemini via gemini-2.0-flash)
  ANTHROPIC_API_KEY        Anthropic API key (for Claude via claude-sonnet-4-6)

${c.bold}Quick start:${c.reset}
  aeo-tracker init                    # create config
  export OPENAI_API_KEY=sk-...        # set at least one API key
  aeo-tracker run                     # run audit

${c.bold}About:${c.reset}
  Built by Webappski (https://webappski.com), an AEO agency.
  We use this tool ourselves for our public AEO Visibility Challenge.
  Read Week 1: webappski.com/blog/aeo-visibility-challenge-week-1

  Source: github.com/nicecatch-webappski/aeo-tracker
  License: MIT
`;

const command = process.argv[2];

if (!command || command === '--help' || command === '-h') {
  console.log(HELP);
} else if (command === '--version' || command === '-v') {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf-8'));
  console.log(pkg.version);
} else if (command === 'init') {
  await cmdInit();
} else if (command === 'run') {
  await cmdRun();
} else {
  console.error(`${c.red}Unknown command: ${command}${c.reset}`);
  console.log(HELP);
  process.exit(1);
}
