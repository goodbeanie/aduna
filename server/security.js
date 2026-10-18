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

module.exports = { CSP, securityHeaders, cleanEmail, emailKey, weakPassword, RateWindow, LoginGuard };
