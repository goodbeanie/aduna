// Signing in and signing up with Google. Like devicelogin.js this has no Express / Postgres imports, so server/googlelogin-test.js can test it alone.
//
// It is the "authorization code" flow, done by the server, so no Google script ever runs in the page and the page's security policy stays as it is:
//   1. The page asks to start (POST /api/auth/google/start). It gets a SECRET request id (only that page knows it) and the address at Google.
//      That address carries a different, throw-away `state`, so nothing that shows up in a browser address bar can be used to read the result.
//   2. The person picks their Google account. Google sends the browser back to /api/auth/google/callback with a one-time code and the state.
//   3. The server swaps the code for the person's identity (straight with Google over HTTPS, using the client secret), checks it is for this app,
//      not expired, made for this request, and carries a VERIFIED email, then files it under the request.
//   4. The page, polling with its secret id, finds out what happened. server/index.js decides what that means: signed in, pick one of several
//      accounts, or a new account (which then goes through the normal sign-up, minus the email check Google already did).
// Requests live only in memory for a short while and are used once. In the desktop and Android apps Google cannot be shown inside the app
// (it refuses embedded browsers), so the address opens in the system browser and the app polls; on the web the same tab goes to Google and back.
const crypto = require('crypto');
const { cleanEmail } = require('./security');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ID_RE = /^[A-Za-z0-9_-]{32}$/;
const rnd = () => crypto.randomBytes(24).toString('base64url'); // 32 characters

// { clientId, clientSecret } when both are set (Google Cloud Console > APIs & Services > Credentials > OAuth client ID, type "Web application"), else null: the feature stays off
function settings(env = process.env) {
  const clientId = String(env.GOOGLE_CLIENT_ID || '').trim(), clientSecret = String(env.GOOGLE_CLIENT_SECRET || '').trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

// The claims inside a JWT, or null. There is no signature check on purpose: this token came straight from Google's token endpoint over HTTPS,
// which Google documents as enough. (A token handed over by a browser would need its signature checked.)
function jwtClaims(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) return null;
  try { const c = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); return c && typeof c === 'object' ? c : null; } catch { return null; }
}

class GoogleLogins {
  constructor({ waitMs = 10 * 60_000, keepMs = 30 * 60_000, maxPending = 5000, now = () => Date.now(), fetchImpl = (...a) => fetch(...a) } = {}) {
    // waitMs: how long a request waits for the person to come back from Google. keepMs: how long a finished one is kept (a sign-up takes a while).
    Object.assign(this, { waitMs, keepMs, maxPending, now, fetchImpl });
    this.byId = new Map();    // secret id -> request
    this.byState = new Map(); // state -> secret id
  }
  _drop(r) { this.byId.delete(r.id); if (this.byState.get(r.state) === r.id) this.byState.delete(r.state); }
  _sweep() { const t = this.now(); for (const r of [...this.byId.values()]) if (t > r.expiresAt) this._drop(r); }
  get size() { return this.byId.size; }

  // the live request for a secret id, or null (unknown, malformed or expired)
  get(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    const r = this.byId.get(id);
    if (!r) return null;
    if (this.now() > r.expiresAt) { this._drop(r); return null; }
    return r;
  }
  consume(id) { const r = this.get(id); if (r) this._drop(r); }

  // { id, state, nonce }, or { error: 'busy' }. `native`: the sign-in happens in the system browser and the app polls (so the callback shows a page instead of going back to the app).
  start({ native = false } = {}) {
    this._sweep();
    if (this.byId.size >= this.maxPending) return { error: 'busy' };
    const t = this.now();
    const r = { id: rnd(), state: rnd(), nonce: rnd(), native: !!native, status: 'pending', createdAt: t, expiresAt: t + this.waitMs, profile: null, error: '' };
    this.byId.set(r.id, r);
    this.byState.set(r.state, r.id);
    return r;
  }

  // The address at Google. prompt=select_account so a person with several Google accounts is asked which one, every time.
  authUrl(cfg, redirectUri, r) {
    const q = new URLSearchParams({
      client_id: cfg.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile',
      state: r.state, nonce: r.nonce, prompt: 'select_account', access_type: 'online',
    });
    return `${AUTH_URL}?${q.toString()}`;
  }

  _fail(r, error) { Object.assign(r, { status: 'failed', error, expiresAt: this.now() + 5 * 60_000 }); return r; }

  // Google sent the browser back. Trades the code for the identity and files it under the request. Returns the request (status 'ready' or 'failed'),
  // or null when the state is not one we issued (or was already used): then nothing is filed and nobody is told anything.
  async finish({ state, code, error } = {}, cfg, redirectUri) {
    const id = typeof state === 'string' && ID_RE.test(state) ? this.byState.get(state) : null;
    const r = id && this.get(id);
    if (!r || r.status !== 'pending') return null;
    this.byState.delete(r.state); // a state works once
    if (error || typeof code !== 'string' || !code || code.length > 2000) {
      return this._fail(r, error === 'access_denied' ? 'You cancelled the Google sign-in.' : 'Google did not finish the sign-in. Try again.');
    }
    let tok;
    try {
      const res = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
      tok = await res.json();
      if (!res.ok || !tok || typeof tok !== 'object') throw new Error('token endpoint said ' + res.status);
    } catch (e) {
      console.error('Google sign-in: token exchange failed:', e.message);
      return this._fail(r, 'Could not reach Google. Try again.');
    }
    const c = jwtClaims(tok.id_token);
    const t = this.now();
    const aud = Array.isArray(c && c.aud) ? c.aud : [c && c.aud];
    const good = c
      && (c.iss === 'https://accounts.google.com' || c.iss === 'accounts.google.com')
      && aud.includes(cfg.clientId)
      && Number(c.exp) * 1000 > t
      && c.nonce === r.nonce
      && typeof c.sub === 'string' && c.sub && c.sub.length <= 255;
    if (!good) return this._fail(r, 'Google sent something Aduna could not trust. Try again.');
    const email = cleanEmail(c.email);
    if (!email || !(c.email_verified === true || c.email_verified === 'true')) return this._fail(r, 'That Google account has no verified email address, so Aduna cannot use it.');
    Object.assign(r, { status: 'ready', expiresAt: t + this.keepMs, profile: { sub: c.sub, email, name: String(c.name || c.given_name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80) } });
    return r;
  }
}

module.exports = { GoogleLogins, settings, jwtClaims, AUTH_URL, TOKEN_URL };
