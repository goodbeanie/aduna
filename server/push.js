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

// The push services browsers use (Chrome/Edge/Opera/Brave: FCM, Firefox: Mozilla, Safari: Apple, Windows: WNS). Our server POSTs to the stored endpoint,
// so it must never be an address the user chose freely (blind SSRF + a status-code oracle through /api/push/test).
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];

// A browser PushSubscription.toJSON(): an https endpoint plus two keys. Anything else is rejected.
function cleanSub(s) {
  if (!s || typeof s !== 'object') return null;
  const { endpoint, keys } = s;
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return null;
  let url; try { url = new URL(endpoint); } catch { return null; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  if (!PUSH_HOSTS.some((re) => re.test(url.hostname))) return null; // only real push services: otherwise the server could be aimed at any host (SSRF)
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null;
  if (keys.p256dh.length > 200 || keys.auth.length > 100 || !/^[A-Za-z0-9_-]+=*$/.test(keys.p256dh) || !/^[A-Za-z0-9_-]+=*$/.test(keys.auth)) return null;
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

// An Android app registration token (FCM). Stored as a device with the endpoint "fcm:<token>" so it sits next to the Web Push ones.
const cleanFcm = (t) => (typeof t === 'string' && t.length >= 20 && t.length <= 4096 && /^[A-Za-z0-9:_-]+$/.test(t) ? t : null);

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };


// What a notification looks like and what its buttons do. Everything is checked here because it ends up in the service worker:
//   icon     '/api/images/<id>' only (a profile picture or a server icon; images are public by id)
//   sender   the name of the person, for the picture's letter when there is no image
//   theme    { dark, bg, accent } of the server (the service worker uses the person's own theme for DMs)
//   serverId / channelId / peerId / msgId   what the Mark as read and Reply buttons act on
//   reply    'inline' (type the answer in the notification, sent through POST /api/channels/:id/quick-reply) | 'open' (opens the chat with the box focused)
//   read     true: show a Mark as read button
//   callId / declineToken / video / cancel   a ringing call (see index.js call:invite): the Android app's Answer and Decline buttons use them;
//            declineToken is a signature over this call and this person, so the Decline button works without being signed in
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
function cleanLook(p) {
  const out = {};
  if (typeof p.icon === 'string' && /^\/api\/images\/[A-Za-z0-9_-]{4,80}$/.test(p.icon)) out.icon = p.icon;
  if (typeof p.sender === 'string' && p.sender) out.sender = clip(p.sender, 40);
  if (p.theme && typeof p.theme.dark === 'boolean' && HEX.test(p.theme.bg) && HEX.test(p.theme.accent)) out.theme = { dark: p.theme.dark, bg: p.theme.bg, accent: p.theme.accent };
  for (const k of ['serverId', 'channelId', 'peerId', 'msgId', 'callId']) if (typeof p[k] === 'string' && ID.test(p[k])) out[k] = p[k];
  if (typeof p.declineToken === 'string' && /^[0-9a-f]{16,64}$/.test(p.declineToken)) out.declineToken = p.declineToken;
  if (p.reply === 'inline' || p.reply === 'open') out.reply = p.reply;
  if (p.read === true) out.read = true;
  if (p.video === true) out.video = true;
  if (p.cancel === true) out.cancel = true;
  return out;
}

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
  // caps.callUi: the app says it can show the native call screen (Answer / Decline, ringtone). Only then does it get data-only call pushes.
  function addFcm(u, token, ua, caps) {
    const t = cleanFcm(token);
    if (!t) return false;
    const endpoint = 'fcm:' + t;
    for (const other of Object.values(users())) {
      if (other.pushSubs?.some((x) => x.endpoint === endpoint)) other.pushSubs = other.pushSubs.filter((x) => x.endpoint !== endpoint);
    }
    u.pushSubs = [...(u.pushSubs || []), { endpoint, fcm: t, ...(caps && caps.callUi === true ? { callUi: true } : {}), ua: clip(ua, 120), createdAt: nowFn() }].slice(-MAX_SUBS);
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
      body: clip(payload.body, 240),
      url: payload.url || '/app',
      tag: clip(payload.tag, 80) || undefined,
      ...cleanLook(payload),
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

  // The call stopped ringing (answered, declined, cancelled, missed, or picked up on another device): tell the phones that are showing
  // the ringing screen to take it down. Only apps with the native call screen get this; browsers close theirs on their own.
  async function cancelCall(uid, callId) {
    if (!d.enabled || !ID.test(String(callId))) return 0;
    const u = users()[uid];
    const subs = (u?.pushSubs || []).filter((s) => s.fcm && s.callUi);
    if (!subs.length) return 0;
    const body = JSON.stringify({ kind: 'call', cancel: true, callId: String(callId), tag: 'call', title: 'Call ended', body: '', url: '/app', ts: nowFn() });
    let sent = 0; const dead = [];
    await Promise.all(subs.map(async (sub) => {
      try { await d.sender(sub, body, { TTL: 30, urgency: 'high' }); sent++; }
      catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.push(sub.endpoint); else if (d.onError) d.onError(e); }
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

  return { add, addFcm, remove, send, cancelCall, test, prefsOf, get enabled() { return !!d.enabled; }, get publicKey() { return d.publicKey || null; } };
}

module.exports = { createPush, cleanLook, cleanPrefs, cleanSub, cleanFcm, DEFAULT_PREFS };
