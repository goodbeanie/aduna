// Web Push for the installed mobile app (PWA) and for browsers: notifications that arrive while Aduna is closed.
// Like credits.js and security.js this has no Express / Postgres imports, so server/push-test.js can test it alone.
//
// Privacy: DMs are end-to-end encrypted, so a DM push only says who wrote ("New message"), never what.
// Channel pings carry a short preview because the server already stores channel messages.

const KINDS = { dm: 'dm', mention: 'mentions', announcement: 'announcements', call: 'calls', friend: 'friends' };
const DEFAULT_PREFS = { dm: true, mentions: true, announcements: true, calls: true, friends: true };
const MAX_SUBS = 10;

// Per-account switches. Unknown keys are dropped, missing ones keep their current value.
function cleanPrefs(input, current = DEFAULT_PREFS) {
  const out = { ...DEFAULT_PREFS, ...(current || {}) };
  if (input && typeof input === 'object') for (const k of Object.keys(DEFAULT_PREFS)) if (typeof input[k] === 'boolean') out[k] = input[k];
  return out;
}

// A browser PushSubscription.toJSON(): an https endpoint plus two keys. Anything else is rejected.
function cleanSub(s) {
  if (!s || typeof s !== 'object') return null;
  const { endpoint, keys } = s;
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return null;
  let url; try { url = new URL(endpoint); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null;
  if (keys.p256dh.length > 200 || keys.auth.length > 100 || !/^[A-Za-z0-9_-]+=*$/.test(keys.p256dh) || !/^[A-Za-z0-9_-]+=*$/.test(keys.auth)) return null;
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

// An Android app registration token (FCM). Stored as a device with the endpoint "fcm:<token>" so it sits next to the Web Push ones.
const cleanFcm = (t) => (typeof t === 'string' && t.length >= 20 && t.length <= 4096 && /^[A-Za-z0-9:_-]+$/.test(t) ? t : null);

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// d: { users() -> db().users, save(), sender(sub, body, opts) -> Promise, enabled, publicKey, now() }
function createPush(d) {
  const nowFn = d.now || Date.now;
  const users = () => d.users();
  const prefsOf = (u) => cleanPrefs(u.notifPrefs);

  // A phone or computer belongs to one account at a time: if it signs in as someone else, it leaves the old account.
  function add(u, sub, ua) {
    const clean = cleanSub(sub);
    if (!clean) return false;
    for (const other of Object.values(users())) {
      if (other.pushSubs?.some((x) => x.endpoint === clean.endpoint)) other.pushSubs = other.pushSubs.filter((x) => x.endpoint !== clean.endpoint);
    }
    u.pushSubs = [...(u.pushSubs || []), { ...clean, ua: clip(ua, 120), createdAt: nowFn() }].slice(-MAX_SUBS);
    d.save();
    return true;
  }
  function addFcm(u, token, ua) {
    const t = cleanFcm(token);
    if (!t) return false;
    const endpoint = 'fcm:' + t;
    for (const other of Object.values(users())) {
      if (other.pushSubs?.some((x) => x.endpoint === endpoint)) other.pushSubs = other.pushSubs.filter((x) => x.endpoint !== endpoint);
    }
    u.pushSubs = [...(u.pushSubs || []), { endpoint, fcm: t, ua: clip(ua, 120), createdAt: nowFn() }].slice(-MAX_SUBS);
    d.save();
    return true;
  }
  function remove(u, endpoint) {
    if (!u.pushSubs?.length) return;
    u.pushSubs = u.pushSubs.filter((x) => x.endpoint !== endpoint);
    d.save();
  }

  // kind: dm | mention | announcement | call | friend. payload: { title, body, url, tag }
  // Resolves to the number of devices it was handed to. Never throws: a failed push must not break sending a message.
  async function send(uid, kind, payload) {
    if (!d.enabled) return 0;
    const u = users()[uid];
    if (!u?.pushSubs?.length) return 0;
    const prefs = prefsOf(u);
    if (!prefs[KINDS[kind]]) return 0;
    if (u.status === 'dnd' && kind !== 'call') return 0; // Do Not Disturb: only a ringing call breaks through
    const body = JSON.stringify({
      kind,
      title: clip(payload.title, 80),
      body: clip(payload.body, 160),
      url: payload.url || '/app',
      tag: clip(payload.tag, 80) || undefined,
      ts: nowFn(),
    });
    const opts = { TTL: kind === 'call' ? 45 : 3600, urgency: kind === 'call' || kind === 'dm' || kind === 'mention' ? 'high' : 'normal' };
    let sent = 0, dead = [];
    await Promise.all(u.pushSubs.map(async (sub) => {
      try { await d.sender(sub, body, opts); sent++; }
      catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.push(sub.endpoint); else if (d.onError) d.onError(e); /* anything else: try again next time */ }
    }));
    if (dead.length) { u.pushSubs = u.pushSubs.filter((x) => !dead.includes(x.endpoint)); d.save(); }
    return sent;
  }

  // Settings > Notifications > "Send a test push": goes to every device of the account, ignoring the per-kind switches, and says what happened
  // to each one so a broken device can be told apart from a broken server. `force` makes the service worker show it even if Aduna is open.
  async function test(uid) {
    const u = users()[uid];
    const subs = u?.pushSubs || [];
    const res = { enabled: !!d.enabled, devices: subs.length, sent: 0, failed: [] };
    if (!d.enabled || !subs.length) return res;
    const body = JSON.stringify({ kind: 'test', title: 'Test notification', body: 'Aduna can reach this device.', url: '/app', tag: 'aduna-test-push', force: true, ts: nowFn() });
    const dead = [];
    await Promise.all(subs.map(async (sub) => {
      try { await d.sender(sub, body, { TTL: 60, urgency: 'high' }); res.sent++; }
      catch (e) {
        const status = e && e.statusCode || 0;
        if (status === 404 || status === 410) dead.push(sub.endpoint);
        res.failed.push({ status, message: clip(e && (e.body || e.message), 140) });
        if (d.onError) d.onError(e);
      }
    }));
    if (dead.length) { u.pushSubs = u.pushSubs.filter((x) => !dead.includes(x.endpoint)); d.save(); }
    return res;
  }

  return { add, addFcm, remove, send, test, prefsOf, get enabled() { return !!d.enabled; }, get publicKey() { return d.publicKey || null; } };
}

module.exports = { createPush, cleanPrefs, cleanSub, cleanFcm, DEFAULT_PREFS };
