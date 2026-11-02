// Events (gatherings) through the real server: node server/gatherings-flow-test.js (needs TEST_DATABASE_URL, like the other server tests)
const assert = require('assert');
const { webcrypto: crypto } = require('crypto');
const { cleanup } = require('./test-env');

// Capture what would be sent to the browsers' push services instead of sending it.
const webpush = require('web-push');
const outbox = [];
webpush.sendNotification = async (sub, body) => { outbox.push({ endpoint: sub.endpoint, ...JSON.parse(body) }); };
const take = () => outbox.splice(0);

const { httpServer, ready, gatheringSweep } = require('./index');
const { io: connect } = require('socket.io-client');
const store = require('./db');

let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
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
const sub = (n) => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/ev-endpoint-' + n, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } });
const MIN = 60_000, HOUR = 3_600_000;

(async () => {
  await ready;
  await new Promise((r) => httpServer.listen(0, r));
  base = 'http://localhost:' + httpServer.address().port;
  const alice = await makeUser('evalice'), bob = await makeUser('evbob'), carol = await makeUser('evcarol'), dave = await makeUser('evdave');

  const created = await call('/servers', { method: 'POST', token: alice.token, body: { name: 'Game night crew' } });
  const sid = created.server.id;
  for (const u of [bob, carol]) assert.strictEqual((await call('/servers/join', { method: 'POST', token: u.token, body: { code: created.server.inviteCode } })).status, 200);
  const vc = await call(`/servers/${sid}/channels`, { method: 'POST', token: alice.token, body: { name: 'lounge', type: 'voice' } });
  const voiceId = vc.server.channels.find((c) => c.type === 'voice').id;
  const textId = vc.server.channels.find((c) => c.type !== 'voice').id;
  const url = (p = '') => `/servers/${sid}/gatherings${p}`;
  const friday = Date.now() + 2 * 24 * HOUR;

  // ---- making one ----
  assert.strictEqual((await call(url(), { method: 'POST', body: { title: 'x', startsAt: friday } })).status, 401, 'needs a login');
  assert.strictEqual((await call(url(), { method: 'POST', token: dave.token, body: { title: 'Game night', startsAt: friday } })).status, 404, 'an outsider cannot');
  assert.strictEqual((await call(url(), { method: 'POST', token: alice.token, body: { title: '   ', startsAt: friday } })).status, 400, 'a name is required');
  assert.strictEqual((await call(url(), { method: 'POST', token: alice.token, body: { title: 'Game night', startsAt: Date.now() - HOUR } })).status, 400, 'not in the past');
  assert.strictEqual((await call(url(), { method: 'POST', token: alice.token, body: { title: 'Game night', startsAt: friday, channelId: textId } })).status, 400, 'only a voice channel');
  let r = await call(url(), { method: 'POST', token: alice.token, body: { title: 'Game night', desc: 'Bring snacks', startsAt: friday, channelId: voiceId } });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  let g = r.server.gatherings[0];
  assert.deepStrictEqual([g.title, g.desc, g.channelId, g.by], ['Game night', 'Bring snacks', voiceId, alice.user.id]);
  assert.deepStrictEqual(g.yes, [alice.user.id], 'the person who made it is going');
  assert.strictEqual(g.endsAt - g.startsAt, 2 * HOUR, 'two hours when no end is given');
  assert.ok(!('rsvps' in g) && !('reminded' in g), 'the browser gets the lists, not the internals');
  const asBob = await call('/servers', { token: bob.token });
  assert.strictEqual(asBob.servers.find((s) => s.id === sid).gatherings.length, 1, 'every member sees it');
  step('create: members only, checked, the host is going, everyone sees it');

  // ---- answering ----
  assert.strictEqual((await call(url(`/${g.id}/rsvp`), { method: 'PUT', token: dave.token, body: { status: 'yes' } })).status, 404);
  assert.strictEqual((await call(url(`/${g.id}/rsvp`), { method: 'PUT', token: bob.token, body: { status: 'sure' } })).status, 400);
  assert.strictEqual((await call(url(`/${g.id}/rsvp`), { method: 'PUT', token: bob.token, body: {} })).status, 400);
  r = await call(url(`/${g.id}/rsvp`), { method: 'PUT', token: bob.token, body: { status: 'yes' } });
  await call(url(`/${g.id}/rsvp`), { method: 'PUT', token: carol.token, body: { status: 'maybe' } });
  r = await call(url(`/${g.id}/rsvp`), { method: 'PUT', token: bob.token, body: { status: 'maybe' } });
  g = r.server.gatherings[0];
  assert.deepStrictEqual([g.yes, g.maybe.sort()], [[alice.user.id], [bob.user.id, carol.user.id].sort()], 'changing an answer moves the person');
  r = await call(url(`/${g.id}/rsvp`), { method: 'PUT', token: carol.token, body: { status: null } });
  assert.deepStrictEqual(r.server.gatherings[0].maybe, [bob.user.id], 'an answer can be taken back');
  await call(url(`/${g.id}/rsvp`), { method: 'PUT', token: carol.token, body: { status: 'yes' } });
  step('Going / Maybe: validated, changed, taken back');

  // ---- changing and cancelling ----
  assert.strictEqual((await call(url(`/${g.id}`), { method: 'PATCH', token: bob.token, body: { title: 'Mine now' } })).status, 403, 'only the host or a manager');
  r = await call(url(`/${g.id}`), { method: 'PATCH', token: alice.token, body: { title: 'Game night!' } });
  assert.strictEqual(r.server.gatherings[0].title, 'Game night!');
  assert.strictEqual(r.server.gatherings[0].startsAt, g.startsAt, 'what is not sent stays');
  assert.strictEqual((await call(url(`/${g.id}`), { method: 'DELETE', token: bob.token })).status, 403);
  step('edit and cancel: the host (or a manager) only');

  // ---- reminders ----
  const live = connect(base, { auth: { token: alice.token } });
  await new Promise((res) => live.on('connect', res));
  const seen = []; live.on('gathering:reminder', (p) => seen.push(p));
  await call('/push/subscribe', { method: 'POST', token: bob.token, body: { subscription: sub(1) } });
  await call('/push/subscribe', { method: 'POST', token: carol.token, body: { subscription: sub(2) } });
  const sv = store.db.servers[sid];
  const rec = sv.gatherings[0];
  rec.startsAt = Date.now() + 10 * MIN; rec.endsAt = rec.startsAt + 2 * HOUR; rec.reminded = {};
  take();
  gatheringSweep(); await wait(80);
  assert.strictEqual(seen.length, 1, 'the person who is in the app gets it live');
  assert.deepStrictEqual([seen[0].kind, seen[0].channelId, seen[0].title], ['soon', voiceId, 'Game night!']);
  let pushes = take();
  assert.deepStrictEqual(pushes.map((p) => p.endpoint).sort(), [sub(1).endpoint, sub(2).endpoint].sort(), 'people who are away get a push (yes and maybe alike)');
  assert.ok(pushes.every((p) => p.url === `/app?n=v:${sid}:${voiceId}` && /Starts in 15 minutes/.test(p.body)), 'the push opens the voice channel');
  gatheringSweep(); await wait(50);
  assert.strictEqual(seen.length, 1); assert.strictEqual(take().length, 0, 'a reminder goes out once');
  rec.startsAt = Date.now() - 20_000; rec.endsAt = rec.startsAt + 2 * HOUR;
  gatheringSweep(); await wait(80);
  assert.deepStrictEqual(seen.map((x) => x.kind), ['soon', 'start'], 'and again when it starts');
  rec.endsAt = Date.now() - 2 * HOUR; gatheringSweep();
  assert.strictEqual(store.db.servers[sid].gatherings.length, 0, 'an hour after it ended it is gone');
  step('reminders: live and push, once each, "starting now" at the start, clean-up after');

  // ---- host cancels ----
  r = await call(url(), { method: 'POST', token: bob.token, body: { title: 'Movie', startsAt: friday } });
  const mid = r.server.gatherings[0].id;
  assert.strictEqual((await call(url(`/${mid}`), { method: 'DELETE', token: alice.token })).status, 200, 'the owner can cancel anyone\'s event');
  assert.strictEqual((await call(url(`/${mid}`), { method: 'DELETE', token: alice.token })).status, 404);
  step('the owner can cancel someone else\'s event');

  live.disconnect();
  console.log('\ngatherings-flow-test: all passed');
  await cleanup();
  process.exit(0);
})().catch(async (e) => { console.error(e); try { await cleanup(); } catch {} process.exit(1); });
