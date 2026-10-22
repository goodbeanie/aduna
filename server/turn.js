// ICE servers (STUN + TURN) for DM calls and voice channels. No Express or database imports, so it is unit-testable.
//
// Why TURN: STUN only helps two browsers find each other's public address. When either side is behind a strict NAT,
// a school/work firewall or a mobile carrier, the direct path fails and audio/video has to be relayed by a TURN server.
// Without one, calls only work for some pairs of people.
//
// Pick ONE way to provide TURN (checked in this order):
//   1. Cloudflare Realtime TURN   CF_TURN_KEY_ID + CF_TURN_API_TOKEN   (short-lived credentials minted per request, cached)
//   2. Your own coturn            TURN_URLS + TURN_SECRET              (coturn `use-auth-secret`; time-limited credentials per user)
//   3. A fixed username/password  TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL  (Metered, Twilio static, etc.)
//   4. Raw JSON                   ICE_SERVERS='[{"urls":"turn:...","username":"..","credential":".."}]'   (the old setting)
// With none of these set, only public STUN servers are returned and the server logs a warning in production.
const crypto = require('crypto');

const STUN = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const CF_API = 'https://rtc.live.cloudflare.com/v1/turn/keys';

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const list = (s) => String(s || '').split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
const isTurnUrl = (u) => /^turns?:/i.test(String(u));

// Does this list contain at least one relay (TURN) entry with credentials?
function hasRelay(servers) {
  return Array.isArray(servers) && servers.some((s) => {
    const urls = [].concat(s && s.urls || []);
    return urls.some(isTurnUrl) && s.username && s.credential;
  });
}

// coturn "REST API" credentials: username = expiry:userId, password = base64(HMAC-SHA1(secret, username))
function coturnCredentials(secret, userId, ttlSeconds, now = Date.now()) {
  const username = Math.floor(now / 1000) + ttlSeconds + ':' + String(userId || 'anon');
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

// A TURN URL list must not leak into the browser as an empty/garbage entry.
function cleanServers(servers) {
  const out = [];
  for (const s of Array.isArray(servers) ? servers : []) {
    if (!s || typeof s !== 'object') continue;
    const urls = [].concat(s.urls || []).filter((u) => typeof u === 'string' && /^(stun|turn|turns):/i.test(u));
    if (!urls.length) continue;
    const e = { urls };
    if (s.username) e.username = String(s.username);
    if (s.credential) e.credential = String(s.credential);
    if (urls.some(isTurnUrl) && !(e.username && e.credential)) continue; // a relay with no login is useless
    out.push(e);
  }
  return out;
}

function createIce({ env = process.env, fetchFn = (typeof fetch === 'function' ? fetch : null), now = () => Date.now(), warn = () => {} } = {}) {
  const ttl = num(env.TURN_TTL_SECONDS, 24 * 3600); // must outlast the longest call: TURN rechecks the login when it refreshes
  let cf = null; // { servers, until }
  let cfInflight = null;
  let warned = false;

  async function fromCloudflare() {
    const id = env.CF_TURN_KEY_ID, token = env.CF_TURN_API_TOKEN;
    if (cf && cf.until > now()) return cf.servers;
    if (cfInflight) return cfInflight;
    cfInflight = (async () => {
      try {
        if (!fetchFn) throw new Error('no fetch');
        const r = await fetchFn(`${CF_API}/${encodeURIComponent(id)}/credentials/generate-ice-servers`, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl }),
        });
        if (!r.ok) throw new Error('Cloudflare TURN answered ' + r.status);
        const j = await r.json();
        const servers = cleanServers([].concat(j && j.iceServers || []));
        if (!hasRelay(servers)) throw new Error('Cloudflare TURN returned no relay credentials');
        // reuse them for half their life so a call that starts late in the window still has plenty left
        cf = { servers, until: now() + Math.floor(ttl * 1000 / 2) };
        return servers;
      } catch (e) {
        warn('TURN: could not get Cloudflare credentials: ' + e.message);
        // a stale set is better than none; credentials stay valid until their own TTL
        return cf ? cf.servers : null;
      } finally { cfInflight = null; }
    })();
    return cfInflight;
  }

  function mode() {
    if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) return 'cloudflare';
    const urls = list(env.TURN_URLS);
    if (urls.length && env.TURN_SECRET) return 'coturn';
    if (urls.length && env.TURN_USERNAME && env.TURN_CREDENTIAL) return 'static';
    try { if (cleanServers(JSON.parse(env.ICE_SERVERS || '')).length) return 'json'; } catch { /* not set */ }
    return 'none';
  }

  // Returns { iceServers, relay } for one signed-in user.
  async function forUser(userId) {
    const m = mode();
    let relay = [];
    if (m === 'cloudflare') relay = (await fromCloudflare()) || [];
    else if (m === 'coturn') {
      const c = coturnCredentials(env.TURN_SECRET, userId, ttl, now());
      relay = [{ urls: list(env.TURN_URLS), ...c }];
    } else if (m === 'static') relay = [{ urls: list(env.TURN_URLS), username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }];
    else if (m === 'json') { try { relay = cleanServers(JSON.parse(env.ICE_SERVERS)); } catch { relay = []; } }
    relay = cleanServers(relay);
    const withRelay = hasRelay(relay);
    if (!withRelay && !warned && env.NODE_ENV === 'production') {
      warned = true;
      warn('TURN is not configured: calls and voice will fail for people behind strict NATs or firewalls. See README > Calls.');
    }
    // keep any STUN entries the provider returned, and always add the public ones as a fallback
    const have = new Set(relay.flatMap((s) => [].concat(s.urls)));
    const stun = STUN.map((s) => ({ urls: s.urls.filter((u) => !have.has(u)) })).filter((s) => s.urls.length);
    return { iceServers: [...relay, ...stun], relay: withRelay, mode: m };
  }

  return { forUser, mode, ttl };
}

module.exports = { createIce, coturnCredentials, hasRelay, cleanServers, STUN };
