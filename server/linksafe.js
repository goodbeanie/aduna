'use strict';
// Unsafe link protection, the server's half. No Express or database imports, so server/linksafe-test.js can test it with fakes.
//
//   * A blocklist of domains. A listed domain blocks itself and every address under it (evil.example blocks login.evil.example too).
//     It comes from two places that index.js merges: server/link-blocklist.json (a plain list, edited with the code) and the domains a creator
//     adds on /admin > Links (stored in db().linkblocks).
//   * An optional live lookup against Google Safe Browsing (env SAFE_BROWSING_API_KEY). The server asks Google, so people's browsers never
//     contact it. Without the key the lookup is simply off. A failed or slow lookup never blocks anything: it answers "no verdict" and the
//     lookup then rests for a minute so a Google outage cannot slow chat down.
//
// What the server may look at: direct messages and group chats are end-to-end encrypted, so the browser never sends the links in them here.
// Only links from server channels (which the server can read anyway) are looked up. The other checks run in the browser (client/src/linksafe.js).

const MAX_DOMAINS = 5000;
const MAX_URLS = 20;       // per request
const MAX_URL_LEN = 2000;

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN_RE = new RegExp('^(?:' + LABEL + '\\.)+' + '[a-z0-9-]{2,63}$');
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

// "https://Evil.Example/path", "*.evil.example", "evil.example:8080" -> "evil.example". null when it is not a real domain.
// A bare ending ("com") is refused on purpose: it would block a quarter of the internet.
function cleanDomain(input) {
  let s = String(input == null ? '' : input).trim().toLowerCase();
  if (!s || s.length > 253) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // scheme
  s = s.replace(/^[^/?#@]*@/, '');                  // user:pass@
  s = s.split(/[/?#]/)[0];                          // path, query, fragment
  s = s.replace(/:\d{1,5}$/, '');                   // port
  s = s.replace(/^\*\./, '').replace(/^\.+|\.+$/g, '');
  if (!s) return null;
  if (IPV4_RE.test(s)) return s.split('.').every((n) => Number(n) <= 255) ? s : null;
  return DOMAIN_RE.test(s) ? s : null;
}

// A Set of clean domains from any number of lists (arrays of strings, or the keys of an object). Anything that is not a real domain is dropped, and the
// set is capped at MAX_DOMAINS so a runaway list cannot grow without end.
function domainSet(...lists) {
  const out = new Set();
  for (const list of lists) {
    const items = Array.isArray(list) ? list : list && typeof list === 'object' ? Object.keys(list) : [];
    for (const x of items) {
      if (out.size >= MAX_DOMAINS) return out;
      const d = cleanDomain(x);
      if (d) out.add(d);
    }
  }
  return out;
}

// the host of an http(s) address, lower case, without a trailing dot; '' when it is not one
function hostOf(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.hostname.toLowerCase().replace(/\.$/, '');
  } catch { return ''; }
}

// The listed domain that covers `host` (the host itself or any parent of it), or null.
function blockedBy(host, domains) {
  if (!host || !domains || !domains.size) return null;
  const parts = host.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const d = parts.slice(i).join('.');
    if (domains.has(d)) return d;
  }
  return domains.has(host) ? host : null;
}

// Up to MAX_URLS distinct http(s) addresses from whatever the request sent. Anything else is dropped.
function cleanUrls(list) {
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    if (out.length >= MAX_URLS) break;
    const s = typeof x === 'string' ? x.trim() : '';
    if (!s || s.length > MAX_URL_LEN || !hostOf(s) || out.includes(s)) continue;
    out.push(s);
  }
  return out;
}

// ---------- Google Safe Browsing (Lookup API, v4 threatMatches:find) ----------
const THREATS = ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'];
const THREAT_NAME = { MALWARE: 'malware', SOCIAL_ENGINEERING: 'phishing', UNWANTED_SOFTWARE: 'unwanted software', POTENTIALLY_HARMFUL_APPLICATION: 'harmful app' };
const ENDPOINT = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';

// check(urls) -> { ok, threats: Map(url -> 'phishing' | 'malware' | ...) }. `ok` is false when the lookup is off, resting or failed.
// Results are remembered for a while (a clean answer too), so a link posted in a busy channel is looked up once, not once per viewer.
function createSafeBrowsing({ key, fetchImpl, now = Date.now, ttlMs = 30 * 60_000, maxCached = 5000, timeoutMs = 4000, restMs = 60_000 } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const cache = new Map(); // url -> { at, threat: string | null }
  let restUntil = 0;
  const enabled = !!key && !!doFetch;

  const fresh = (e) => e && now() - e.at < ttlMs;
  function remember(url, threat) {
    if (cache.size >= maxCached) cache.delete(cache.keys().next().value); // the oldest goes first
    cache.set(url, { at: now(), threat });
  }

  async function check(urls) {
    const threats = new Map();
    if (!enabled) return { ok: false, threats };
    const todo = [];
    for (const u of urls) {
      const e = cache.get(u);
      if (fresh(e)) { if (e.threat) threats.set(u, e.threat); } else todo.push(u);
    }
    if (!todo.length) return { ok: true, threats };
    if (now() < restUntil) return { ok: urls.length > todo.length, threats }; // resting: only what was already known
    try {
      const body = {
        client: { clientId: 'aduna', clientVersion: '1.0' },
        threatInfo: { threatTypes: THREATS, platformTypes: ['ANY_PLATFORM'], threatEntryTypes: ['URL'], threatEntries: todo.map((url) => ({ url })) },
      };
      const r = await doFetch(ENDPOINT + '?key=' + encodeURIComponent(key), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      if (!r.ok) throw new Error('Safe Browsing answered ' + r.status);
      const j = await r.json();
      const hit = new Map();
      for (const m of Array.isArray(j.matches) ? j.matches : []) {
        const url = m && m.threat && m.threat.url;
        if (typeof url === 'string' && !hit.has(url)) hit.set(url, THREAT_NAME[m.threatType] || 'unsafe');
      }
      for (const u of todo) { const t = hit.get(u) || null; remember(u, t); if (t) threats.set(u, t); }
      return { ok: true, threats };
    } catch (e) {
      restUntil = now() + restMs;
      return { ok: false, threats, error: e.message };
    }
  }
  return { enabled, check, _cache: cache };
}

// What the check route answers for these addresses: the blocklist first (no network), then the live lookup for the rest.
async function checkUrls({ urls, domains, safeBrowsing }) {
  const results = [], rest = [];
  for (const url of urls) {
    const hit = blockedBy(hostOf(url), domains);
    if (hit) results.push({ url, level: 'block', reason: 'listed', domain: hit });
    else rest.push(url);
  }
  let lookup = false;
  let threats = new Map();
  if (rest.length && safeBrowsing && safeBrowsing.enabled) { const r = await safeBrowsing.check(rest); lookup = r.ok; threats = r.threats; }
  for (const url of rest) results.push(threats.has(url) ? { url, level: 'block', reason: threats.get(url) } : { url, level: 'ok' });
  return { results, lookup };
}

module.exports = { MAX_DOMAINS, MAX_URLS, cleanDomain, domainSet, hostOf, blockedBy, cleanUrls, createSafeBrowsing, checkUrls, THREATS };
