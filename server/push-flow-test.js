// Push notifications through the real server: node server/push-flow-test.js (needs TEST_DATABASE_URL, like the other server tests)
const assert = require('assert');
const { webcrypto: crypto } = require('crypto');
const { rawDb, cleanup } = require('./test-env');

// Capture what would be sent to the browsers' push services instead of sending it.
const webpush = require('web-push');
const outbox = [];
webpush.sendNotification = async (sub, body, opts) => { outbox.push({ endpoint: sub.endpoint, ...JSON.parse(body), opts }); };
const take = () => outbox.splice(0);

const { httpServer, ready } = require('./index');
const { io: connect } = require('socket.io-client');
const store = require('./db');

let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const ack = (s, ev, p) => new Promise((res) => s.emit(ev, p, res));
const step = (m) => console.log('✓', m);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
async function makeUser(name) {
  const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveKey']);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicKey = JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y });
  const r = await call('/register', { method: 'POST', body: { username: name, email: name + '@example.com', password: 'password123', publicKey, encPrivKey: { salt: 'a', iv: 'b', data: 'c' } } });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  return r;
}
const sub = (n) => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/secret-endpoint-' + n, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } });

(async () => {
  await ready;
  await new Promise((r) => httpServer.listen(0, r));
  base = 'http://localhost:' + httpServer.address().port;
  const alice = await makeUser('alice'), bob = await makeUser('bob'), carol = await makeUser('carol');

  // ---- keys and subscribing ----
  const key = await call('/push/key', { token: bob.token });
  assert.ok(key.enabled && /^[A-Za-z0-9_-]{80,}$/.test(key.publicKey), 'server hands out its public VAPID key');
  assert.strictEqual((await call('/push/key')).status, 401, 'key needs a login');
  assert.strictEqual((await call('/push/subscribe', { method: 'POST', body: { subscription: sub(1) } })).status, 401);
  assert.strictEqual((await call('/push/subscribe', { method: 'POST', token: bob.token, body: { subscription: { endpoint: 'http://insecure', keys: {} } } })).status, 400);
  assert.strictEqual((await call('/push/subscribe', { method: 'POST', token: bob.token, body: { subscription: sub(1) } })).status, 200);
  assert.strictEqual((await call('/push/subscribe', { method: 'POST', token: alice.token, body: { subscription: sub(2) } })).status, 200);
  assert.ok(!(await rawDb()).includes('secret-endpoint'), 'subscriptions are encrypted in the database like everything else');
  assert.ok(!('pushSubs' in (await call('/me', { token: bob.token })).user), 'subscriptions never come back to the browser');
  assert.deepStrictEqual((await call('/me', { token: bob.token })).user.notifPrefs, { dm: true, mentions: true, announcements: true, calls: true, friends: true });
  step('subscribe: validated, per user, encrypted at rest, private');

  // ---- friend request ----
  take();
  await call('/friends/request', { method: 'POST', token: alice.token, body: { username: 'bob' } });
  await wait(50);
  let got = take();
  assert.strictEqual(got.length, 1); assert.strictEqual(got[0].endpoint, sub(1).endpoint); assert.strictEqual(got[0].kind, 'friend');
  assert.strictEqual(got[0].title, 'alice'); assert.strictEqual(got[0].url, '/app?n=f');
  await call(`/friends/${alice.user.id}/accept`, { method: 'POST', token: bob.token });
  step('friend request pushes to the person asked');

  // ---- sockets ----
  const sa = connect(base, { auth: { token: alice.token } }), sc = connect(base, { auth: { token: carol.token } });
  await Promise.all([new Promise((r) => sa.on('connect', r)), new Promise((r) => sc.on('connect', r))]);

  // ---- DM: the server must not leak the ciphertext or any text ----
  take();
  assert.ok((await ack(sa, 'dm:send', { to: bob.user.id, ciphertext: 'SECRETCIPHERTEXT', iv: 'iv' })).ok);
  await wait(50);
  got = take();
  assert.strictEqual(got.length, 1); assert.strictEqual(got[0].kind, 'dm'); assert.strictEqual(got[0].title, 'alice');
  assert.strictEqual(got[0].body, 'Sent you a message'); assert.ok(!JSON.stringify(got[0]).includes('SECRETCIPHERTEXT'));
  assert.strictEqual(got[0].url, '/app?n=d:' + alice.user.id); assert.ok(got[0].tag.startsWith('m:'));
  assert.strictEqual(got[0].opts.urgency, 'high');
  step('DM pushes who wrote, never what');

  // ---- channel messages: only pings notify ----
  const server = (await call('/servers', { method: 'POST', token: alice.token, body: { name: 'Hangout' } })).server;
  for (const u of [bob, carol]) assert.strictEqual((await call('/servers/join', { method: 'POST', token: u.token, body: { code: server.inviteCode } })).status, 200);
  await call('/push/subscribe', { method: 'POST', token: carol.token, body: { subscription: sub(3) } });
  const chan = server.channels[0];
  await new Promise((r) => { sa.emit('typing', {}); setTimeout(r, 10); });
  take();
  await ack(sa, 'message:send', { channelId: chan.id, content: 'just chatting' });
  await wait(50);
  assert.strictEqual(take().length, 0, 'an ordinary message sends no push');
  await ack(sa, 'message:send', { channelId: chan.id, content: `hey <@${bob.user.id}> look at this` });
  await wait(50);
  got = take();
  assert.strictEqual(got.length, 1); assert.strictEqual(got[0].endpoint, sub(1).endpoint); assert.strictEqual(got[0].kind, 'mention');
  assert.ok(got[0].title.includes('mentioned you') && got[0].title.includes('Hangout'));
  assert.ok(got[0].body.includes('hey @someone look at this') && !got[0].body.includes(bob.user.id), 'mention markup is not shown raw');
  assert.strictEqual(got[0].url, `/app?n=c:${server.id}:${chan.id}`);
  await ack(sa, 'message:send', { channelId: chan.id, content: '@everyone meeting' }); // the owner may ping everyone
  await wait(50);
  got = take();
  assert.deepStrictEqual(got.map((x) => x.endpoint).sort(), [sub(1).endpoint, sub(3).endpoint].sort(), '@everyone reaches every member except the author');
  await ack(sc, 'message:send', { channelId: chan.id, content: `<@${alice.user.id}> hi` });
  await wait(50);
  got = take();
  assert.strictEqual(got.length, 1, 'alice (subscribed) is pinged by carol'); assert.strictEqual(got[0].endpoint, sub(2).endpoint);
  step('mentions and @everyone push; chatter and the sender themselves do not');

  // ---- preferences ----
  assert.deepStrictEqual((await call('/me/notifications', { method: 'PUT', token: bob.token, body: { mentions: false, nope: true, dm: 'x' } })).notifPrefs, { dm: true, mentions: false, announcements: true, calls: true, friends: true });
  await ack(sa, 'message:send', { channelId: chan.id, content: `<@${bob.user.id}> again` });
  await wait(50);
  assert.strictEqual(take().length, 0, 'a switched-off kind is not pushed');
  await call('/me/notifications', { method: 'PUT', token: bob.token, body: { mentions: true } });
  step('per-account notification switches are honoured');

  // ---- calls ring people whose app is closed ----
  take();
  const r1 = await ack(sa, 'call:invite', { to: bob.user.id, video: true });
  assert.ok(r1.ok, 'bob has the app closed but a push subscription: the call rings'); await wait(50);
  got = take();
  assert.strictEqual(got.length, 1); assert.strictEqual(got[0].kind, 'call'); assert.strictEqual(got[0].body, 'Incoming video call'); assert.strictEqual(got[0].opts.TTL, 45);
  await ack(sa, 'call:hangup', { callId: r1.callId });
  const nosub = await ack(sa, 'call:invite', { to: (await makeUser('dave')).user.id }); // not friends
  assert.ok(nosub.error);
  await call('/friends/request', { method: 'POST', token: carol.token, body: { username: 'alice' } });
  await call(`/friends/${carol.user.id}/accept`, { method: 'POST', token: alice.token });
  await call('/push/unsubscribe', { method: 'POST', token: carol.token, body: { endpoint: sub(3).endpoint } });
  sc.disconnect(); await wait(100);
  assert.match((await ack(sa, 'call:invite', { to: carol.user.id })).error, /offline/, 'offline with no push subscription is still "offline"');
  step('calls ring closed apps through push; offline without push is unchanged');

  // ---- logout / unsubscribe ---- (a fresh connection: the server limits each one to 8 events per 5 seconds)
  sa.disconnect();
  const sa2 = connect(base, { auth: { token: alice.token } });
  await new Promise((r) => sa2.on('connect', r));
  await call('/push/unsubscribe', { method: 'POST', token: bob.token, body: { endpoint: sub(1).endpoint } });
  take();
  assert.ok((await ack(sa2, 'dm:send', { to: bob.user.id, ciphertext: 'x', iv: 'y' })).ok); await wait(50);
  assert.strictEqual(take().length, 0, 'after unsubscribing nothing is sent');
  // the same phone signing in as someone else leaves the first account
  await call('/push/subscribe', { method: 'POST', token: bob.token, body: { subscription: sub(9) } });
  await call('/push/subscribe', { method: 'POST', token: carol.token, body: { subscription: sub(9) } });
  assert.strictEqual(store.db.users[bob.user.id].pushSubs.length, 0);
  step('unsubscribing stops pushes; a shared device belongs to one account');

  // ---- a dead subscription is cleaned up ----
  webpush.sendNotification = async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }); };
  await call('/push/subscribe', { method: 'POST', token: bob.token, body: { subscription: sub(5) } });
  assert.ok((await ack(sa2, 'dm:send', { to: bob.user.id, ciphertext: 'x', iv: 'y' })).ok); await wait(80);
  assert.strictEqual(store.db.users[bob.user.id].pushSubs.length, 0, 'expired subscriptions are dropped');
  step('expired subscriptions are removed');

  sa2.disconnect();
  console.log('\npush-flow-test: all passed');
  await cleanup();
  process.exit(0);
})().catch(async (e) => { console.error(e); try { await cleanup(); } catch {} process.exit(1); });
