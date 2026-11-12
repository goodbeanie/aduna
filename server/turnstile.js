// Cloudflare Turnstile check for sign-up. Off unless both TURNSTILE_SECRET and TURNSTILE_SITE_KEY are set.
// Cloudflare's test pairs: 1x00000000000000000000AA / 1x0000000000000000000000000000000AA always passes,
// 2x00000000000000000000AB / 2x0000000000000000000000000000000AA always fails.
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TOKEN_MAX = 2048;

const secret = (env = process.env) => String(env.TURNSTILE_SECRET || '').trim();
const siteKey = (env = process.env) => String(env.TURNSTILE_SITE_KEY || '').trim();
const enabled = (env = process.env) => !!(secret(env) && siteKey(env));

// Fails closed when Cloudflare cannot be reached; TURNSTILE_FAIL_OPEN=1 lets sign-ups through instead.
async function verify(token, ip, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (!enabled(env)) return { ok: true, reason: 'off' };
  if (typeof token !== 'string' || !token || token.length > TOKEN_MAX) return { ok: false, reason: 'missing' };
  const body = new URLSearchParams({ secret: secret(env), response: token });
  if (ip) body.set('remoteip', String(ip));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(VERIFY_URL, { method: 'POST', body, signal: ctl.signal });
    const j = await r.json();
    if (j && j.success === true) return { ok: true };
    return { ok: false, reason: Array.isArray(j && j['error-codes']) ? j['error-codes'].join(',') : 'rejected' };
  } catch {
    return { ok: env.TURNSTILE_FAIL_OPEN === '1', reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { enabled, siteKey, verify, VERIFY_URL };
