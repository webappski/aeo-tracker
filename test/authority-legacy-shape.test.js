// Unit test: backwards-compat for legacy authorityPresence shape.
//
// Reports cached BEFORE the 2026 additive-shape upgrade have:
//   { brand, ranAt, wikipedia: {...}, reddit: {...} }
// (no `profile`, no `github`).
//
// Both `sectionAuthorityPresence` (HTML render) and `mc-metadata.authority()`
// (Mission Control export) must read this shape without crashing AND emit
// the same row/data as they did before the upgrade.

import { sectionAuthorityPresence } from '../lib/report/sections.js';
import { buildMcMetadata } from '../lib/report/mc-metadata.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

// Legacy snapshot: pre-additive shape — no profile, no github.
const LEGACY_SNAPSHOT = {
  date: '2026-01-15',
  brand: 'LegacyBrand',
  domain: 'legacybrand.com',
  results: [],
  authorityPresence: {
    brand: 'LegacyBrand',
    ranAt: '2026-01-15T12:00:00Z',
    wikipedia: {
      found: true,
      title: 'LegacyBrand',
      type: 'standard',
      isDisambiguation: false,
      extract: 'LegacyBrand is a fictional test fixture.',
      pageUrl: 'https://en.wikipedia.org/wiki/LegacyBrand',
      lastModified: '2025-12-01T00:00:00Z',
    },
    reddit: {
      found: true,
      mentionCount: 7,
      capped: false,
      topSubs: [{ name: 'testing', count: 4 }, { name: 'devops', count: 3 }],
      sampleTitle: 'Anyone tried LegacyBrand?',
      url: 'https://www.reddit.com/search.json?q=LegacyBrand',
    },
  },
};

console.log('authority backwards-compat — legacy shape (no profile, no github)');

// ─── sectionAuthorityPresence ──────────────────────────────────────────

test('sectionAuthorityPresence renders legacy shape without crash', () => {
  const out = sectionAuthorityPresence([LEGACY_SNAPSHOT]);
  assert(typeof out === 'string', 'expected string output');
  assert(out.length > 0, 'expected non-empty output');
});

test('legacy render contains Wikipedia row with good badge', () => {
  const out = sectionAuthorityPresence([LEGACY_SNAPSHOT]);
  assert(out.includes('**Wikipedia**'), 'expected Wikipedia row label');
  assert(out.includes('Article exists'), 'expected good-tone "Article exists" badge');
});

test('legacy render contains Reddit row with mention count', () => {
  const out = sectionAuthorityPresence([LEGACY_SNAPSHOT]);
  assert(out.includes('**Reddit**'), 'expected Reddit row label');
  assert(out.includes('7'), 'expected mention count 7 in output');
});

test('legacy render does NOT add GitHub row (profile=default)', () => {
  const out = sectionAuthorityPresence([LEGACY_SNAPSHOT]);
  assert(!out.includes('**GitHub**'), 'should not have GitHub row for default profile');
});

test('legacy render shows no caveat (default profile)', () => {
  const out = sectionAuthorityPresence([LEGACY_SNAPSHOT]);
  // Default profile.caveat is empty string → no extra italic block above the table.
  // Heuristic: the intro line ends with "trained on." and the very next non-empty
  // line should be the table header, not a second italic line.
  assert(!/rarely populated/i.test(out), 'should not include dev-tool caveat for legacy default profile');
});

// ─── mc-metadata.authority() ──────────────────────────────────────────

test('mc-metadata builds without crash on legacy shape', () => {
  // buildMcMetadata expects (latest, snapshots, opts); pass minimal viable inputs.
  const md = buildMcMetadata(LEGACY_SNAPSHOT, [LEGACY_SNAPSHOT], { trackerVersion: 'test', lang: 'en' });
  assert(md && typeof md === 'object', 'expected metadata object');
});

test('mc-metadata authority emits wiki+reddit for legacy shape', () => {
  const md = buildMcMetadata(LEGACY_SNAPSHOT, [LEGACY_SNAPSHOT], { trackerVersion: 'test', lang: 'en' });
  const a = md.authority;
  assert(a && a.wikipedia, 'authority.wikipedia missing');
  assert(a.wikipedia.found === true, `wikipedia.found expected true, got ${a.wikipedia.found}`);
  assert(a.wikipedia.type === 'article', `wikipedia.type expected article, got ${a.wikipedia.type}`);
  assert(a.reddit && a.reddit.found === true, 'reddit.found expected true');
  assert(a.reddit.mentionCount === 7, `reddit.mentionCount expected 7, got ${a.reddit.mentionCount}`);
});

test('mc-metadata authority omits profile + github on legacy shape (additive)', () => {
  const md = buildMcMetadata(LEGACY_SNAPSHOT, [LEGACY_SNAPSHOT], { trackerVersion: 'test', lang: 'en' });
  const a = md.authority;
  assert(a.profile === undefined, `profile should be absent on legacy shape, got ${JSON.stringify(a.profile)}`);
  assert(a.github === undefined, `github should be absent on legacy shape, got ${JSON.stringify(a.github)}`);
});

// ─── new shape coexists (additive) ────────────────────────────────────

const ADDITIVE_SNAPSHOT = {
  ...LEGACY_SNAPSHOT,
  authorityPresence: {
    ...LEGACY_SNAPSHOT.authorityPresence,
    profile: { type: 'dev-tool', extras: ['github'], caveat: 'caveat text' },
    github: {
      found: true,
      owner: 'legacybrand',
      ownerType: 'organization',
      ownerUrl: 'https://github.com/legacybrand',
      topRepo: {
        name: 'tool',
        fullName: 'legacybrand/tool',
        url: 'https://github.com/legacybrand/tool',
        stars: 123,
        forks: 5,
        lastPush: '2026-04-01T00:00:00Z',
        description: 'A test tool',
      },
    },
  },
};

test('additive shape renders GitHub row', () => {
  const out = sectionAuthorityPresence([ADDITIVE_SNAPSHOT]);
  assert(out.includes('**GitHub**'), 'expected GitHub row in additive shape');
  assert(out.includes('123'), 'expected stars count');
});

test('additive shape with wiki+reddit found → caveat suppressed (not relevant)', () => {
  // ADDITIVE_SNAPSHOT inherits wikipedia.found=true + reddit.found=true from
  // LEGACY_SNAPSHOT. The «rarely populated for dev tools» caveat would be a
  // false statement here — the row IS populated. Suppress.
  const out = sectionAuthorityPresence([ADDITIVE_SNAPSHOT]);
  assert(!out.includes('caveat text'), 'caveat should be suppressed when wiki+reddit are found');
});

const DEVTOOL_NEGATIVE_SNAPSHOT = {
  ...ADDITIVE_SNAPSHOT,
  authorityPresence: {
    ...ADDITIVE_SNAPSHOT.authorityPresence,
    // Override wiki+reddit to NOT found — simulates Webappski-style brand.
    wikipedia: { found: false },
    reddit: { found: false, mentionCount: 0, topSubs: [] },
  },
};

test('dev-tool with wiki+reddit both ✗ → caveat IS shown (relevant framing)', () => {
  const out = sectionAuthorityPresence([DEVTOOL_NEGATIVE_SNAPSHOT]);
  assert(out.includes('caveat text'), 'caveat should appear when wiki+reddit both missing for dev-tool');
});

test('additive shape mc-metadata emits github + profile', () => {
  const md = buildMcMetadata(ADDITIVE_SNAPSHOT, [ADDITIVE_SNAPSHOT], { trackerVersion: 'test', lang: 'en' });
  const a = md.authority;
  assert(a.profile && a.profile.type === 'dev-tool', `expected profile.type=dev-tool, got ${JSON.stringify(a.profile)}`);
  assert(a.github && a.github.stars === 123, `expected github.stars=123, got ${JSON.stringify(a.github)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
