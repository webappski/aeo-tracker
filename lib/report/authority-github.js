/**
 * GitHub authority source — for dev-tool / OSS / CLI brands.
 *
 * Returns presence + reach stats for the brand's GitHub org / top repo.
 * **Disambiguation is critical**: a naive `?q=Spotify` search returns 100s
 * of unrelated repos by stars. We only count when:
 *
 *   - `/users/:owner` exists with owner.login === brandSlug, OR
 *   - top search hit's owner.login matches brandSlug or domain root, OR
 *   - top search hit's owner.html_url is referenced from the brand's
 *     own domain (resolved via page-signals if available).
 *
 * Without this guard the section would surface a false-positive link to
 * a wrong repo — worse than showing «not found».
 *
 * Auth: optional `process.env[opts.tokenEnv]` (default GITHUB_TOKEN) lifts
 * rate from 60/h unauth → 5000/h. Token name lives in `.aeo-tracker.json`
 * per project convention (config stores the env-var *name*, never the
 * value). No crash if unset — degrade to unauth.
 */

import { fetchWithTimeout } from './_http.js';

/**
 * Slug-ify a brand name for `:owner` lookup: lowercase, strip spaces,
 * keep alphanumerics + hyphens. GitHub allows `-` in owner; not `_` or `.`.
 */
function brandToOwnerSlug(brand) {
  return String(brand || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/**
 * Root of a domain for owner-match check: `webappski.com` → `webappski`.
 * Strips known subdomains (www) and TLD; returns lowercased label.
 */
function domainToOwnerSlug(domain) {
  return String(domain || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('.')[0] || '';
}

/**
 * Check GitHub for a brand's presence.
 *
 * @param {object} input
 * @param {string} input.brand — display name
 * @param {string} [input.domain] — owned domain (used for disambiguation)
 * @param {string} [input.tokenEnv='GITHUB_TOKEN'] — env var name (not value)
 * @param {Function} [input.fetchImpl=fetchWithTimeout] — injectable for tests
 * @returns {Promise<object>} `{ found, owner, ownerType, topRepo?: {...}, error? }`
 */
export async function checkGitHub({ brand, domain, tokenEnv = 'GITHUB_TOKEN', fetchImpl = fetchWithTimeout } = {}) {
  if (!brand || typeof brand !== 'string') {
    return { found: false, error: 'no brand' };
  }
  const brandSlug  = brandToOwnerSlug(brand);
  const domainSlug = domainToOwnerSlug(domain);

  // Owner candidates we accept as "this brand's org/user" — gate against
  // false positives like Spotify→spotify/web-api-examples.
  const acceptOwners = new Set([brandSlug, domainSlug].filter(Boolean));

  if (!brandSlug) {
    return { found: false, error: 'brand has no slugable characters', accept: Array.from(acceptOwners) };
  }

  const token = (tokenEnv && process.env[tokenEnv]) || '';
  const authHeader = token ? { 'Authorization': `Bearer ${token}` } : {};

  // Step 1 — deterministic owner lookup. If `/users/:brandSlug` exists,
  // we trust it without further disambiguation. Most dev brands own their
  // namespace.
  const ownerUrl = `https://api.github.com/users/${encodeURIComponent(brandSlug)}`;
  try {
    const res = await fetchImpl(ownerUrl, { headers: { ...authHeader, 'Accept': 'application/vnd.github+json' } });
    if (res.status === 404) {
      // Step 2 fallthrough below.
    } else if (!res.ok) {
      return { found: false, status: res.status, url: ownerUrl, error: `HTTP ${res.status}` };
    } else {
      const owner = await res.json();
      const ownerType = (owner.type || '').toLowerCase(); // "user" | "organization"
      const topRepo = await fetchTopRepo({ owner: owner.login, brandSlug, domainSlug, fetchImpl, authHeader });
      return {
        found: true,
        owner: owner.login,
        ownerType,
        ownerUrl: owner.html_url,
        followers: owner.followers || 0,
        publicRepos: owner.public_repos || 0,
        topRepo,
      };
    }
  } catch (err) {
    return { found: false, error: err.message || String(err), url: ownerUrl };
  }

  // Step 2 — fall back to search, but only accept hits with matching owner.
  // Without this disambiguation gate, search ranks by stars and would
  // surface a popular-but-unrelated repo.
  const searchUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(brand)}&per_page=5`;
  try {
    const res = await fetchImpl(searchUrl, { headers: { ...authHeader, 'Accept': 'application/vnd.github+json' } });
    if (res.status === 403) {
      return { found: false, status: 403, url: searchUrl, error: 'rate-limited — set GITHUB_TOKEN env for 5000/h' };
    }
    if (!res.ok) {
      return { found: false, status: res.status, url: searchUrl, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    const match = items.find(it => acceptOwners.has(String(it.owner?.login || '').toLowerCase()));
    if (!match) {
      return { found: false, searched: true, url: searchUrl, accept: Array.from(acceptOwners) };
    }
    return {
      found: true,
      owner: match.owner.login,
      ownerType: (match.owner.type || '').toLowerCase(),
      ownerUrl: match.owner.html_url,
      topRepo: {
        name: match.name,
        fullName: match.full_name,
        url: match.html_url,
        stars: match.stargazers_count || 0,
        forks: match.forks_count || 0,
        lastPush: match.pushed_at || null,
        description: typeof match.description === 'string' ? match.description.slice(0, 200) : '',
      },
    };
  } catch (err) {
    return { found: false, error: err.message || String(err), url: searchUrl };
  }
}

/**
 * After confirming the owner, pull the «flagship» repo:
 *
 *   1. If a repo's name matches the brand slug or domain root (e.g.
 *      `webappski/aeo-tracker` for brand «aeo-tracker», `webappski/webappski`,
 *      etc.), prefer it — it's the brand's namesake project, the most
 *      meaningful authority signal even if it has 0 stars today.
 *   2. Else fall back to top repo by stars.
 *
 * Naive top-by-stars surfaces side projects (e.g. `webappski/awesome-a11y`
 * — a 0-star resource list) instead of the actual flagship tool. Pulling
 * a wider 10-repo window + a relevance heuristic fixes that without
 * needing to know the brand's repo name a priori.
 *
 * Soft-fail if the listing endpoint hiccups — the owner-existence finding
 * is still the primary signal.
 */
async function fetchTopRepo({ owner, brandSlug, domainSlug, fetchImpl, authHeader }) {
  const url = `https://api.github.com/users/${encodeURIComponent(owner)}/repos?sort=stars&direction=desc&per_page=10&type=owner`;
  try {
    const res = await fetchImpl(url, { headers: { ...authHeader, 'Accept': 'application/vnd.github+json' } });
    if (!res.ok) return null;
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) return null;

    // Strategy (in order):
    //   1. Namesake match — repo.name matches brand / domain root.
    //      «webappski/aeo-tracker» wins over «webappski/awesome-a11y»
    //      when brand is «aeo-tracker». Strongest signal regardless of stars.
    //   2. If top-by-stars has real traction (≥1 star), pick it.
    //   3. Otherwise top by recent push — active flagship beats stale
    //      starless top. A 2-year-old README list (0 stars) is a worse
    //      signal than yesterday's active project (0 stars).
    const candidates = [brandSlug, domainSlug].filter(Boolean).map(s => s.toLowerCase());
    const namesake = list.find(r => {
      const n = String(r.name || '').toLowerCase();
      return candidates.some(c => n === c || n.includes(c) || c.includes(n));
    });

    let pick;
    let pickReason;
    if (namesake) {
      pick = namesake;
      pickReason = 'namesake';
    } else if ((list[0].stargazers_count || 0) >= 1) {
      pick = list[0];
      pickReason = 'top-stars';
    } else {
      // 0-star top — prefer recency. Sort the page by pushed_at desc.
      const byRecency = [...list].sort((a, b) => {
        const ta = a.pushed_at ? Date.parse(a.pushed_at) : 0;
        const tb = b.pushed_at ? Date.parse(b.pushed_at) : 0;
        return tb - ta;
      });
      pick = byRecency[0];
      pickReason = 'recent-push';
    }

    return {
      name: pick.name,
      fullName: pick.full_name,
      url: pick.html_url,
      stars: pick.stargazers_count || 0,
      forks: pick.forks_count || 0,
      lastPush: pick.pushed_at || null,
      description: typeof pick.description === 'string' ? pick.description.slice(0, 200) : '',
      namesake: pickReason === 'namesake',
      pickReason,  // 'namesake' | 'top-stars' | 'recent-push' — surfaced in tests/diagnostics
    };
  } catch {
    // Soft-fail — owner presence is the main signal.
    return null;
  }
}
