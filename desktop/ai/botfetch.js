// GENERATED from server/botfetch.js by desktop/ai/sync-server.js. Edit that file, not this one.
// The ONLY way a bot reaches the internet, and it never does so itself: the sandbox has no network. A bot calls bot.fetch(url, name), the
// sandbox just records the request, and THIS file (on the host) decides whether and how to make it. The answer comes back to the bot later
// as a 'fetch' event. No Express and no database in here: tested by botfetch-test.js with a fake fetch.
//
// Rules, all enforced here and none of them left to the bot:
//  - https only, GET only, the host must be on the allowlist (default: api.github.com; the operator can change it with BOT_FETCH_HOSTS),
//    no user:password, no custom port, at most 300 characters. Redirects are followed only to another allowlisted host (2 at most).
//  - the bot cannot send headers or a body. The host adds a User-Agent and, for GitHub, an optional token (GITHUB_TOKEN, see README).
//  - the hostname must resolve to public addresses only (belt and braces: the allowlist is the real protection).
//  - 5 s, 200 KB; only JSON and text answers; results are cached for 60 s and shared (GitHub allows only 60 anonymous calls an hour per address);
//    at most 40 real calls a minute for the whole server.
const dns = require('dns');
const net = require('net');

const LIMITS = {
  perRun: 3,            // fetches one event may ask for
  perMin: 10,           // per bot per server (enforced in botrun.Guard)
  timeoutMs: 5000,
  maxBytes: 200 * 1024, // read at most this much of an answer
  textChars: 16_000,    // what the bot gets as `text`
  jsonBytes: 30_000,    // `json` is given only if it re-serialises to at most this many bytes
  cacheMs: 60_000,
  cacheMax: 200,
  globalPerMin: 40,
  redirects: 2,
  urlLen: 300,
};

const DEFAULT_HOSTS = ['api.github.com'];
const parseHosts = (v) => {
  const list = String(v || '').split(',').map((h) => h.trim().toLowerCase()).filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h));
  return list.length ? [...new Set(list)] : DEFAULT_HOSTS;
};

// { url } (normalised) or { error }
function checkUrl(raw, hosts = DEFAULT_HOSTS) {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'fetch needs a URL' };
  if (raw.length > LIMITS.urlLen) return { error: `the URL is longer than ${LIMITS.urlLen} characters` };
  let u;
  try { u = new URL(raw.trim()); } catch { return { error: 'that is not a valid URL' }; }
  if (u.protocol !== 'https:') return { error: 'only https:// URLs can be fetched' };
  if (u.username || u.password) return { error: 'URLs with a user name or password are not allowed' };
  if (u.port) return { error: 'custom ports are not allowed' };
  const host = u.hostname.toLowerCase();
  if (!hosts.includes(host)) return { error: `${host} is not on the allowed list (${hosts.join(', ')})` };
  u.hash = '';
  return { url: u.toString() };
}

// 10.x, 127.x, 169.254.x, 172.16-31.x, 192.168.x, 100.64-127.x (carrier NAT), 0.x, multicast and reserved; ::1, fc00::/7, fe80::/10, ::ffff:private
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff');
  }
  return true;
}

// Reads the body as text, stopping at maxBytes. Returns { text, truncated }.
async function readBody(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') { const t = await res.text(); return { text: t.slice(0, maxBytes), truncated: t.length > maxBytes }; }
  const reader = res.body.getReader();
  const chunks = []; let total = 0, truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) { chunks.push(value.subarray(0, value.length - (total - maxBytes))); truncated = true; try { await reader.cancel(); } catch { /* already closed */ } break; }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'), truncated };
}

function createFetcher({ fetchImpl = globalThis.fetch, lookup = dns.promises.lookup, hosts = parseHosts(process.env.BOT_FETCH_HOSTS), token = process.env.GITHUB_TOKEN || '', now = Date.now, limits = {} } = {}) {
  const L = { ...LIMITS, ...limits };
  const cache = new Map();   // url -> { at, result }
  let calls = [];            // timestamps of real network calls (global limit)
  const inflight = new Map(); // url -> Promise (two bots asking for the same URL at once make one call)

  async function publicHost(host) {
    if (net.isIP(host)) return !isPrivateAddress(host);
    try {
      const addrs = await lookup(host, { all: true });
      return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
    } catch { return false; }
  }

  async function once(url) {
    const t = now();
    calls = calls.filter((x) => t - x < 60_000);
    if (calls.length >= L.globalPerMin) return { ok: false, status: 0, error: 'Too many outside requests right now. Try again in a minute.' };
    calls.push(t);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), L.timeoutMs);
    try {
      let cur = url;
      for (let hop = 0; hop <= L.redirects; hop++) {
        const chk = checkUrl(cur, hosts);
        if (chk.error) return { ok: false, status: 0, error: chk.error };
        if (!(await publicHost(new URL(chk.url).hostname))) return { ok: false, status: 0, error: 'That address is not public' };
        const headers = { 'User-Agent': 'AdunaBot/1.0', Accept: 'application/vnd.github+json, application/json;q=0.9, text/plain;q=0.8' };
        if (token && new URL(chk.url).hostname === 'api.github.com') { headers.Authorization = 'Bearer ' + token; headers['X-GitHub-Api-Version'] = '2022-11-28'; }
        const res = await fetchImpl(chk.url, { method: 'GET', headers, redirect: 'manual', signal: ctl.signal });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          try { await res.body?.cancel?.(); } catch { /* ignore */ }
          if (hop === L.redirects) return { ok: false, status: res.status, error: 'Too many redirects' };
          cur = new URL(res.headers.get('location'), chk.url).toString();
          continue;
        }
        const type = String(res.headers.get('content-type') || '').toLowerCase();
        if (!/^(application\/(.+\+)?json|text\/)/.test(type)) { try { await res.body?.cancel?.(); } catch { /* ignore */ } return { ok: false, status: res.status, error: 'Only JSON and text answers are supported' }; }
        const { text, truncated } = await readBody(res, L.maxBytes);
        let json = null;
        if (!truncated) { try { const j = JSON.parse(text); if (Buffer.byteLength(JSON.stringify(j)) <= L.jsonBytes) json = j; } catch { /* not JSON */ } }
        const out = { ok: res.status >= 200 && res.status < 300, status: res.status, text: text.slice(0, L.textChars), json, truncated: truncated || text.length > L.textChars, error: null };
        if (!out.ok) out.error = (res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0' ? 'GitHub says this server has used up its request allowance for now' : `The server answered ${res.status}`;
        return out;
      }
      return { ok: false, status: 0, error: 'Too many redirects' };
    } catch (e) {
      return { ok: false, status: 0, error: e && e.name === 'AbortError' ? `No answer within ${L.timeoutMs / 1000} seconds` : 'Could not reach the server' };
    } finally { clearTimeout(timer); }
  }

  // get(url) -> { ok, status, text, json, truncated, error, cached }. Never throws.
  async function get(raw) {
    const chk = checkUrl(raw, hosts);
    if (chk.error) return { ok: false, status: 0, error: chk.error };
    const hit = cache.get(chk.url);
    if (hit && now() - hit.at < L.cacheMs) return { ...hit.result, cached: true };
    if (inflight.has(chk.url)) return inflight.get(chk.url);
    const p = once(chk.url).then((result) => {
      if (result.status > 0) { // an answer (even an error answer) is cached, so a failing page is not hammered; network failures are not
        if (cache.size >= L.cacheMax) cache.delete(cache.keys().next().value);
        cache.set(chk.url, { at: now(), result });
      }
      return result;
    }).finally(() => inflight.delete(chk.url));
    inflight.set(chk.url, p);
    return p;
  }

  return { get, hosts, check: (u) => checkUrl(u, hosts), clear: () => cache.clear() };
}

module.exports = { LIMITS, DEFAULT_HOSTS, parseHosts, checkUrl, isPrivateAddress, createFetcher };
