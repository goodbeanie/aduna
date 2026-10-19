// Security helpers. Like credits.js this has no Express / Postgres imports, so server/security-test.js can test it alone.

// ---------- browser security headers ----------
// The app serves its own scripts, styles, fonts and images, plus GIFs from GIPHY. Anything else is blocked, which is what
// stops an injected <script> from running or sending data elsewhere. Inline styles are allowed (React uses style="...").
// CSP_MODE=report-only makes the browser log violations instead of blocking (handy if a page ever looks broken);
// CSP_MODE=off sends no policy at all.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.giphy.com",
  "media-src 'self' blob: https://*.giphy.com",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(env = process.env) {
  const mode = String(env.CSP_MODE || 'enforce').toLowerCase();
  return (req, res, next) => {
    res.removeHeader?.('X-Powered-By');
    if (mode !== 'off') res.setHeader(mode === 'report-only' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // calls need the camera, microphone and screen share on this site only
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains'); // only over HTTPS
    next();
  };
}

// ---------- email ----------
const BAD = '\\s@<>()\\[\\]\\\\,;:"';
const EMAIL = new RegExp(`^[^${BAD}]+@[^${BAD}]+\\.[^${BAD}]{2,}$`);
// A tidy lowercase address, or null if it is not a plausible one
function cleanEmail(v) {
  const e = String(v ?? '').trim().toLowerCase();
  if (!e || e.length > 254 || !EMAIL.test(e)) return null;
  const [local, domain] = e.split('@');
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  if (domain.includes('..') || domain.startsWith('.') || domain.startsWith('-') || domain.endsWith('-') || domain.endsWith('.')) return null;
  return e;
}
// Two addresses with the same key are the same mailbox: name+tag@x.com is name@x.com, and Gmail ignores dots.
function emailKey(e) {
  let [local, domain] = String(e).toLowerCase().split('@');
  local = local.split('+')[0];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

// ---------- passwords ----------
const COMMON = new Set(['password', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssword', 'p@ssw0rd', '12345678', '123456789', '1234567890', '11111111', '00000000', '87654321', 'qwertyui', 'qwerty123', 'qwertyuiop', '1q2w3e4r', '1qaz2wsx', 'abc12345', 'abcd1234', 'abcdefgh', 'iloveyou', 'letmein1', 'welcome1', 'welcome123', 'admin123', 'administrator', 'monkey123', 'dragon123', 'football', 'baseball', 'superman', 'trustno1', 'sunshine', 'princess', 'whatever', 'changeme', 'aduna123', 'aduna1234', 'aduna2026']);
// null if fine, otherwise a message for the person
function weakPassword(pw, { username = '', email = '' } = {}) {
  const p = String(pw ?? ''), l = p.toLowerCase();
  if (COMMON.has(l)) return 'That password is too common. Pick something harder to guess.';
  if (new Set(p).size < 4) return 'That password is too repetitive. Mix in more different characters.';
  if (username && l.includes(String(username).toLowerCase()) && String(username).length >= 3) return 'Your password should not contain your username.';
  const local = String(email).split('@')[0].toLowerCase();
  if (local.length >= 4 && l.includes(local)) return 'Your password should not contain your email name.';
  return null;
}

// ---------- rate limits ----------
// at most `limit` hits per `windowMs` for each key; true = allowed
class RateWindow {
  constructor(limit, windowMs) { this.limit = limit; this.windowMs = windowMs; this.hits = new Map(); }
  allow(key, now = Date.now()) {
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.limit) { this.hits.set(key, arr); return false; }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 20000) for (const k of this.hits.keys()) { this.hits.delete(k); if (this.hits.size <= 15000) break; }
    return true;
  }
}

// Failed-login lockout. Five wrong passwords for one username from one address lock that pair for 15 minutes
// (so a stranger cannot lock you out of your own account from their own connection); 25 from anywhere lock the
// username itself, which stops a spread-out guessing attack. A correct password clears the pair.
class LoginGuard {
  constructor({ perPair = 5, perName = 25, windowMs = 15 * 60_000 } = {}) {
    Object.assign(this, { perPair, perName, windowMs });
    this.pair = new Map(); this.name = new Map();
  }
  _recent(map, key, now) { const arr = (map.get(key) || []).filter((t) => now - t < this.windowMs); arr.length ? map.set(key, arr) : map.delete(key); return arr; }
  // { blocked: false } or { blocked: true, retryAfterSec }
  check(name, ip, now = Date.now()) {
    const n = String(name || '').toLowerCase();
    let until = 0;
    for (const [arr, max] of [[this._recent(this.pair, n + '|' + ip, now), this.perPair], [this._recent(this.name, n, now), this.perName]])
      if (arr.length >= max) until = Math.max(until, arr[arr.length - max] + this.windowMs);
    return until > now ? { blocked: true, retryAfterSec: Math.ceil((until - now) / 1000) } : { blocked: false };
  }
  fail(name, ip, now = Date.now()) {
    const n = String(name || '').toLowerCase();
    for (const [map, key] of [[this.pair, n + '|' + ip], [this.name, n]]) { const arr = this._recent(map, key, now); arr.push(now); map.set(key, arr); }
    for (const map of [this.pair, this.name]) if (map.size > 20000) for (const k of map.keys()) { map.delete(k); if (map.size <= 15000) break; }
  }
  success(name, ip) { this.pair.delete(String(name || '').toLowerCase() + '|' + ip); }
}

// ---------- sessions ----------
// A login token carries the account's `tokenVersion` (tv). Bumping that number on the account makes every token issued
// before it stop working on the next request and the next socket connection: "log out everywhere". Tokens issued before
// this existed have no tv and count as version 0, so the upgrade logs nobody out. `jwt` is passed in (the jsonwebtoken
// module) and `getSecret` is a function because the secret is only known once the server has started.
function createSessions({ jwt, getSecret, ttl = '30d' }) {
  const version = (u) => Number(u && u.tokenVersion) || 0;
  return {
    sign: (u) => jwt.sign({ uid: u.id, tv: version(u) }, getSecret(), { expiresIn: ttl, algorithm: 'HS256' }),
    // the account a token belongs to, or null: bad signature, expired, revoked, or the account no longer exists
    user(token, lookup) {
      try {
        const p = jwt.verify(String(token || ''), getSecret(), { algorithms: ['HS256'] });
        const u = lookup(p.uid);
        return u && (Number(p.tv) || 0) === version(u) ? u : null;
      } catch { return null; }
    },
    // revoke every token this account has handed out so far
    bump(u) { u.tokenVersion = version(u) + 1; return u.tokenVersion; },
  };
}

// ---------- session cookie ----------
// The browser app keeps its login in an httpOnly cookie, so no script on the page (an injected one included) can read or steal it.
//   * Over https the cookie is named __Host-aduna_session: the browser then insists on Secure + Path=/ + no Domain, and a sibling
//     subdomain cannot plant a cookie of that name. Over plain http (local development) it is aduna_session.
//   * SameSite=Strict: other sites cannot make the browser send it. As a second wall csrfGuard() refuses unsafe requests whose
//     Origin is another site.
const COOKIE = 'aduna_session', COOKIE_HOST = '__Host-aduna_session';
const cookieName = (secure) => (secure ? COOKIE_HOST : COOKIE);

function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = part.slice(i + 1).trim(); // the first one wins
  }
  return out;
}
// true if the request came in over https (directly, or through a proxy that says so)
const isSecure = (headers, encrypted = false, trustProxy = true) =>
  !!encrypted || (trustProxy && String((headers || {})['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https');
// the login token in the cookie for this kind of connection, or ''. Only the matching name counts: over https a plain
// aduna_session cookie (which another site on the domain could have planted) is ignored.
const readSessionCookie = (headers, secure) => parseCookies((headers || {}).cookie)[cookieName(secure)] || '';
const hasSessionCookie = (headers) => { const c = parseCookies((headers || {}).cookie); return !!(c[COOKIE] || c[COOKIE_HOST]); };
const sessionCookie = (token, { secure = false, maxAgeSec = 30 * 86400 } = {}) =>
  `${cookieName(secure)}=${token}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
// both names are cleared so logging out works whichever way the cookie was set
const clearedSessionCookies = ({ secure = false } = {}) => [
  `${COOKIE_HOST}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure`,
  `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`,
];

// A browser sends Origin on cross-site requests and on every WebSocket handshake. No Origin: not a browser, or a plain same-origin GET.
function originAllowed(origin, host) {
  if (!origin) return true;
  try { return !!host && new URL(origin).host === String(host).toLowerCase(); } catch { return false; } // "null" and junk are refused
}
// Refuses a request that changes something, carries the login cookie, and comes from another site.
function csrfGuard() {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (!hasSessionCookie(req.headers)) return next(); // not logged in by cookie: there is nothing to forge
    const site = String(req.headers['sec-fetch-site'] || '');
    if (site !== 'cross-site' && originAllowed(req.headers.origin, String(req.headers.host || '').toLowerCase())) return next();
    res.status(403).json({ error: 'Request blocked: it came from another site.' });
  };
}

module.exports = { CSP, securityHeaders, cleanEmail, emailKey, weakPassword, RateWindow, LoginGuard, createSessions,
  parseCookies, isSecure, readSessionCookie, hasSessionCookie, sessionCookie, clearedSessionCookies, originAllowed, csrfGuard };
