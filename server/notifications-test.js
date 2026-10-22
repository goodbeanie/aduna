// Server notification settings through the real server: node server/notifications-test.js (needs TEST_DATABASE_URL)
// The rules themselves are in notifprefs-test.js; this checks the routes, what is saved, the counts that survive a reload,
// and that push notifications obey each person's mute / level / @everyone / announcement settings.
const assert = require('assert');
const { webcrypto: crypto } = require('crypto');
const { cleanup } = require('./test-env');

const webpush = require('web-push');
const outbox = [];
webpush.sendNotification = async (sub, body) => { outbox.push({ endpoint: sub.endpoint, ...JSON.parse(body) }); };
const take = () => outbox.splice(0);

const { httpServer, ready } = require('./index');
const { io: connect } = require('socket.io-client');

let base;
async function call(p, { method = 'GET', body, token, raw } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const step = (m) => console.log('✓', m);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function makeUser(name) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const r = await call('/register', { method: 'POST', body: { username: name, email: name + '@example.com', password: 'password123', publicKey: JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }), encPrivKey: { salt: 'a', iv: 'b', data: 'c' } } });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  return r;
}
const sub = (n) => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/notif-test-' + n, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } });

// one fresh socket per message keeps clear of the 8-events-per-5-seconds flood limit
async function say(token, channelId, content) {
  const s = connect(base, { auth: { token } });
  await new Promise((r) => s.on('connect', r));
  const r = await new Promise((res) => s.emit('message:send', { channelId, content }, res));
  s.disconnect();
  assert.ok(r.ok, 'send: ' + JSON.stringify(r));
  await wait(30); // push is sent right after the ack
}

(async () => {
  await ready;
  await new Promise((r) => httpServer.listen(0, r));
  base = 'http://localhost:' + httpServer.address().port;
  const alice = await makeUser('nalice'), bob = await makeUser('nbob'), carol = await makeUser('ncarol');
  const A = alice.token, B = bob.token, C = carol.token;
  const bobId = bob.user.id;
  assert.strictEqual((await call('/push/subscribe', { method: 'POST', token: B, body: { subscription: sub('bob') } })).status, 200);
  const bobPushes = () => take().filter((p) => p.endpoint === sub('bob').endpoint);

  let sv = (await call('/servers', { method: 'POST', token: A, body: { name: 'Notes' } })).server;
  const sid = sv.id, gen = sv.channels[0].id;
  const mkChan = async (name, type) => (await call(`/servers/${sid}/channels`, { method: 'POST', token: A, body: { name, type } })).server.channels.find((c) => c.name === name).id;
  const rnd = await mkChan('random', 'text');
  const news = await mkChan('news', 'announcements');
  await call('/servers/join', { method: 'POST', token: B, body: { code: sv.inviteCode } });
  await call('/servers/join', { method: 'POST', token: C, body: { code: sv.inviteCode } });
  sv = (await call('/servers', { token: A })).servers.find((x) => x.id === sid);
  assert.ok(!JSON.stringify(sv).includes('serverPrefs'), 'settings are private to their owner');

  // ---- nothing to start with; auth ----
  assert.strictEqual((await call('/notif-state')).status, 401);
  let st = await call('/notif-state', { token: B });
  assert.deepStrictEqual([st.prefs, st.counts], [{}, {}], 'a new account starts with defaults and nothing unread');
  await wait(5);

  // ---- counts survive a reload ----
  await say(A, gen, 'hello everyone');
  await say(A, gen, `hey <@${bobId}> look`);
  await say(A, rnd, 'chatter');
  st = await call('/notif-state', { token: B });
  assert.deepStrictEqual(st.counts, { ['c:' + gen]: { unread: 1, mentions: 1 }, ['c:' + rnd]: { unread: 1, mentions: 0 } }, 'unread and @ counts come from the server, not memory');
  assert.deepStrictEqual((await call('/notif-state', { token: B })).counts, st.counts, 'asking again changes nothing');
  assert.deepStrictEqual((await call('/notif-state', { token: A })).counts, {}, 'your own messages never count');
  take();
  step('unread and @ counts are kept by the server');

  // ---- reading ----
  assert.strictEqual((await call(`/channels/${gen}/read`, { method: 'POST', token: B, body: {} })).status, 200);
  st = await call('/notif-state', { token: B });
  assert.deepStrictEqual(st.counts, { ['c:' + rnd]: { unread: 1, mentions: 0 } }, 'reading a channel clears just that channel');
  assert.strictEqual((await call(`/channels/${gen}/read`, { method: 'POST', token: B, body: { at: 1 } })).status, 200);
  assert.deepStrictEqual((await call('/notif-state', { token: B })).counts, st.counts, 'a read position never moves backwards');
  assert.strictEqual((await call(`/channels/${gen}/read`, { method: 'POST', token: B, body: { at: 9e15 } })).status, 200);
  await wait(5); await say(A, gen, 'after a far-future read');
  assert.strictEqual((await call('/notif-state', { token: B })).counts['c:' + gen].unread, 1, 'a read position cannot be set into the future');
  assert.strictEqual((await call(`/channels/${gen}/read`, { method: 'POST', token: C, body: {} })).status, 200, 'carol is a member');
  const outsider = await makeUser('noutsider');
  assert.strictEqual((await call(`/channels/${gen}/read`, { method: 'POST', token: outsider.token, body: {} })).status, 404, 'not a member');
  assert.strictEqual((await call(`/channels/nope/read`, { method: 'POST', token: B, body: {} })).status, 404);
  assert.strictEqual((await call(`/servers/${sid}/read`, { method: 'POST', token: outsider.token, body: {} })).status, 404);
  assert.strictEqual((await call(`/servers/${sid}/read`, { method: 'POST', token: B, body: {} })).status, 200);
  assert.deepStrictEqual((await call('/notif-state', { token: B })).counts, {}, 'mark all as read');
  step('read positions: per channel, forward only, whole server');

  // ---- other devices hear about it ----
  const sb = connect(base, { auth: { token: B } });
  await new Promise((r) => sb.on('connect', r));
  const events = [];
  sb.on('notif:read', (e) => events.push(['read', e.channelIds])); sb.on('notif:prefs', (e) => events.push(['prefs', e.serverId]));
  await call(`/channels/${rnd}/read`, { method: 'POST', token: B, body: {} });
  const put = (token, body, id = sid) => call(`/servers/${id}/notifprefs`, { method: 'PUT', token, body });
  await put(B, { level: 'mentions' });
  await wait(100);
  assert.deepStrictEqual(events, [['read', [rnd]], ['prefs', sid]], 'your other devices follow reads and settings');
  sb.disconnect();
  assert.deepStrictEqual((await put(B, {})).prefs, {}, 'back to defaults');

  // ---- saving and rejecting ----
  let r = await put(B, { level: 'mentions', noEveryone: true, noAnnouncements: false, channels: { [rnd]: { level: 'default', mute: null } } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.prefs, { level: 'mentions', noEveryone: true }, 'defaults are not stored');
  assert.deepStrictEqual((await call('/notif-state', { token: B })).prefs, { [sid]: { level: 'mentions', noEveryone: true } });
  for (const bad of [{ level: 'loud' }, { noEveryone: 'yes' }, { mute: 'x' }, { channels: { nope: { level: 'all' } } }, { channels: [] }, [], null]) {
    assert.strictEqual((await put(B, bad)).status, 400, 'rejects ' + JSON.stringify(bad));
  }
  assert.strictEqual((await call(`/servers/${sid}/notifprefs`, { method: 'PUT', token: B, raw: '{"__proto__":{"level":"nothing"},"channels":{"__proto__":{"level":"all"}}}' })).status, 400, 'hostile keys');
  assert.strictEqual(({}).level, undefined, 'prototype untouched');
  assert.strictEqual((await put(outsider.token, { level: 'nothing' })).status, 404, 'not your server');
  assert.strictEqual((await put(B, { level: 'nothing' }, 'nope')).status, 404);
  assert.strictEqual((await put(B, { level: 'nothing' }, '__proto__')).status, 404);
  assert.strictEqual((await call(`/servers/${sid}/notifprefs`, { method: 'PUT', body: {} })).status, 401);
  assert.deepStrictEqual((await call('/notif-state', { token: B })).prefs, { [sid]: { level: 'mentions', noEveryone: true } }, 'nothing bad was saved');
  assert.deepStrictEqual((await call('/notif-state', { token: C })).prefs, {}, 'carol is untouched');
  assert.ok(!JSON.stringify((await call('/me', { token: B })).user).includes('noEveryone'), 'settings are not part of the profile');
  step('settings: validated, defaults dropped, private, hostile keys refused');

  // ---- mentions only ----
  await put(B, { level: 'mentions' });
  await call(`/servers/${sid}/read`, { method: 'POST', token: B, body: {} }); await wait(5); take();
  await say(A, gen, 'plain');
  await say(A, gen, `ping <@${bobId}>`);
  await say(A, gen, '@everyone gather');
  st = await call('/notif-state', { token: B });
  assert.deepStrictEqual(st.counts, { ['c:' + gen]: { unread: 0, mentions: 2 } }, 'only messages that name you (or everyone) count');
  let got = bobPushes();
  assert.deepStrictEqual(got.map((p) => p.kind), ['mention', 'mention'], 'a mention and @everyone both alert');
  step('mentions only');

  // ---- @everyone off ----
  await put(B, { level: 'mentions', noEveryone: true });
  assert.deepStrictEqual((await call('/notif-state', { token: B })).counts, { ['c:' + gen]: { unread: 0, mentions: 1 } }, 'saving recounts at once: @everyone no longer counts');
  await put(B, { noEveryone: true });
  assert.deepStrictEqual((await call('/notif-state', { token: B })).counts, { ['c:' + gen]: { unread: 2, mentions: 1 } }, 'with every message counted again, @everyone is an ordinary unread one');
  take(); await say(A, gen, '@everyone again');
  assert.deepStrictEqual(bobPushes(), [], '@everyone off: no push');
  step('@everyone off');

  // ---- mute the server ----
  await put(B, { mute: { until: null } });
  await call(`/servers/${sid}/read`, { method: 'POST', token: B, body: {} }); await wait(5); take();
  await say(A, gen, 'quiet one');
  await say(A, gen, `hello <@${bobId}>`);
  assert.deepStrictEqual((await call('/notif-state', { token: B })).counts, { ['c:' + gen]: { unread: 0, mentions: 1 } }, 'muted: no unread number, a direct @ is still counted');
  assert.deepStrictEqual(bobPushes(), [], 'muted: nothing is pushed, not even a mention');
  await say(A, news, 'muted announcement');
  assert.deepStrictEqual(bobPushes(), [], 'muted: no announcement push');
  step('mute server');

  // ---- timed mute ends on its own ----
  r = await put(B, { mute: { until: Date.now() + 250 } });
  assert.ok(r.prefs.mute.until > Date.now());
  await wait(300);
  take(); await say(A, gen, `back on <@${bobId}>`);
  assert.deepStrictEqual(bobPushes().map((p) => p.kind), ['mention'], 'the mute ended by itself');
  assert.deepStrictEqual((await call('/notif-state', { token: B })).prefs, {}, 'and its entry was tidied away');
  assert.strictEqual((await put(B, { mute: { until: Date.now() - 1000 } })).status, 200);
  assert.deepStrictEqual((await call('/notif-state', { token: B })).prefs, {}, 'a mute in the past is no mute');
  step('timed mute');

  // ---- channel settings beat the server ----
  await put(B, { level: 'nothing', channels: { [rnd]: { level: 'all' }, [gen]: { mute: { until: null } } } });
  await call(`/servers/${sid}/read`, { method: 'POST', token: B, body: {} }); await wait(5); take();
  await say(A, rnd, 'in the opted-in channel');
  await say(A, rnd, `mention in rnd <@${bobId}>`);
  await say(A, gen, `mention in muted general <@${bobId}>`);
  await say(A, news, 'announcement under nothing');
  assert.deepStrictEqual((await call('/notif-state', { token: B })).counts, { ['c:' + rnd]: { unread: 1, mentions: 1 } }, 'server says nothing, #random says all; #general is muted and under "nothing" counts nothing');
  assert.deepStrictEqual(bobPushes().map((p) => p.kind), ['mention'], 'only the opted-in channel alerts');
  step('channel overrides');

  // ---- announcements ----
  await put(B, {});
  await call(`/servers/${sid}/read`, { method: 'POST', token: B, body: {} }); await wait(5); take();
  await say(A, news, 'big news');
  got = bobPushes(); assert.deepStrictEqual(got.map((p) => p.kind), ['announcement'], 'announcements alert by default');
  await put(B, { noAnnouncements: true });
  take(); await say(A, news, 'more news');
  assert.deepStrictEqual(bobPushes(), [], 'announcement alerts off');
  assert.deepStrictEqual((await call('/notif-state', { token: B })).counts, { ['c:' + news]: { unread: 2, mentions: 0 } }, 'still counted as unread');
  step('announcements');

  // ---- stale channel entries, leaving ----
  await call(`/servers/${sid}/channels/${rnd}`, { method: 'DELETE', token: A });
  await put(B, { level: 'mentions', channels: { [gen]: { level: 'all' } } });
  const sc = await call('/notif-state', { token: B });
  assert.deepStrictEqual(Object.keys(sc.prefs[sid].channels), [gen]);
  await call(`/servers/${sid}/leave`, { method: 'POST', token: B });
  assert.deepStrictEqual((await call('/notif-state', { token: B })).prefs, {}, 'leaving forgets the settings');
  await call('/servers/join', { method: 'POST', token: B, body: { code: sv.inviteCode } });
  assert.deepStrictEqual((await call('/notif-state', { token: B })).prefs, {}, 'coming back starts from defaults');
  await wait(5);
  assert.deepStrictEqual((await call('/notif-state', { token: B })).counts, {}, 'and old messages are not suddenly unread');
  // kicked members lose them too
  await put(C, { level: 'nothing' });
  assert.strictEqual((await call(`/servers/${sid}/members/${carol.user.id}/kick`, { method: 'POST', token: A })).status, 200);
  assert.deepStrictEqual((await call('/notif-state', { token: C })).prefs, {}, 'kicked: settings forgotten');
  step('deleted channels, leaving, being kicked');

  console.log('\nnotifications: all passed');
})().then(() => cleanup().then(() => process.exit(0)), (e) => { console.error(e); cleanup().then(() => process.exit(1)); });
