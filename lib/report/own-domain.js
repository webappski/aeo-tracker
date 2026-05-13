/**
 * Own-domain filtering helpers — used across recommendation surfaces so the
 * tool never suggests the user pitch themselves.
 *
 * Real bug surfaced in dogfooding (May 2026): a run on `typelessform.com` had
 * `topCanonicalSources[]` led by the user's own domain (because the AI engines
 * already cite their pages). Without filtering, four downstream surfaces
 * targeted that own domain for outreach:
 *
 *   1. «Actionable Gaps» «What to do» column → "Get listed on typelessform.com"
 *   2. «Where to get mentioned» table → first row was typelessform.com
 *   3. «Outreach Email Templates» → drafted "Hi Typeless Form team" email
 *   4. «Actions this week» → "Pitch a guest post on typelessform.com"
 *
 * All four read the «top cited domain» from `_summary.json::topCanonicalSources[]`
 * without filtering the brand's own canonical domain.
 *
 * Pure helpers (no I/O) so they can be unit-tested without fixtures.
 */

/**
 * Normalise a domain string for comparison: lowercase, strip protocol, strip
 * leading `www.`, strip trailing slash. Returns '' for null/empty.
 *
 * @param {string|null|undefined} domain
 * @returns {string} canonical form (e.g. "typelessform.com"), or '' if blank.
 */
export function normaliseOwnDomain(domain) {
  if (!domain || typeof domain !== 'string') return '';
  let d = domain.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '');
  d = d.replace(/^www\./, '');
  d = d.replace(/\/+$/, '');
  // Drop any path / query / fragment that might have leaked into the config
  // value or a host string. Order matters: split off path BEFORE port stripping
  // so a value like "typelessform.com:443/blog" reduces correctly.
  d = d.split('/')[0];
  d = d.split('?')[0];
  d = d.split('#')[0];
  // Strip an explicit port suffix (`:443`, `:8080`). Hostnames carrying ports
  // appeared in topCanonicalSources when a citation included `https://host:443/…`
  // — without this, the host comparison missed the own-domain match.
  d = d.replace(/:\d+$/, '');
  return d;
}

/**
 * True when `host` is the user's own domain or a subdomain thereof.
 *
 * Subdomain match guards against suggestions like "Pitch blog.typelessform.com"
 * — a subdomain of the user's own brand should never be treated as an external
 * outreach target.
 *
 * @param {string|null|undefined} host       hostname under inspection
 * @param {string|null|undefined} ownDomain  canonical brand domain from config
 * @returns {boolean}
 */
export function isOwnDomain(host, ownDomain) {
  const own = normaliseOwnDomain(ownDomain);
  if (!own) return false;
  const h = normaliseOwnDomain(host);
  if (!h) return false;
  return h === own || h.endsWith('.' + own);
}