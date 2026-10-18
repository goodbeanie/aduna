// Tests for server/push.js (no database needed): node server/push-test.js
const assert = require('assert');
const { createPush, cleanPrefs, cleanSub, DEFAULT_PREFS } = require('./push');

const goodSub = (n = 1) => ({ endpoint: 'https://push.example.com/send/' + n, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } });

// ---- validation ----
assert.ok(cleanSub(goodSub()), 'a real subscription is accepted');
assert.strictEqual(cleanSub({ ...goodSub(), endpoint: 'http://push.example.com/x' }), null, 'http endpoints are refused');
assert.strictEqual(cleanSub({ ...goodSub(), endpoint: 'javascript:alert(1)' }), null);
assert.strictEqual(cleanSub({ endpoint: 'https://x.example/a' }), null, 'keys are required');
assert.strictEqual(cleanSub({ ...goodSub(), keys: { p256dh: '<script>', auth: 'x' } }), null, 'keys must look like base64url');
assert.strictEqual(cleanSub({ ...goodSub(), endpoint: 'https://x.example/' + 'a'.repeat(1100) }), null, 'very long endpoints are refused');
assert.deepStrictEqual(cleanSub({ ...goodSub(), extra: 1 }).keys, goodSub().keys);
assert.deepStrictEqual(cleanPrefs({ dm: false, bogus: true, calls: 'yes' }), { ...DEFAULT_PREFS, dm: false }, 'only booleans for known keys');
assert.deepStrictEqual(cleanPrefs({ calls: false }, { ...DEFAULT_PREFS, dm: false }), { ...DEFAULT_PREFS, dm: false, calls: false }, 'unspecified keys keep their value');

// ---- sending ----
(async () => {
  const users = { a: { id: 'a' }, b: { id: 'b' } };
  let saved = 0, calls = [], failWith = null;
  const push = createPush({
    users: () => users, save: () => { saved++; }, enabled: true, publicKey: 'PUB',
    sender: async (sub, body, opts) => { calls.push({ sub, body: JSON.parse(body), opts }); if (failWith && sub.endpoint.endsWith(failWith.n)) throw failWith.err; },
  });

  assert.strictEqual(await push.send('a', 'dm', { title: 'x', body: 'y' }), 0, 'no devices: nothing sent');
  assert.ok(push.add(users.a, goodSub(1), 'UA'));
  assert.ok(push.add(users.a, goodSub(2), 'UA'));
  assert.strictEqual(users.a.pushSubs.length, 2);
  assert.ok(push.add(users.a, goodSub(2), 'UA') && users.a.pushSubs.length === 2, 'the same device is not stored twice');
  assert.ok(push.add(users.b, goodSub(2), 'UA'));
  assert.strictEqual(users.a.pushSubs.length, 1, 'a device that signs in as someone else leaves the old account');
  assert.strictEqual(push.add(users.a, { endpoint: 'http://no' }, 'UA'), false);
  for (let i = 10; i < 30; i++) push.add(users.a, goodSub(i), 'UA');
  assert.ok(users.a.pushSubs.length <= 10, 'at most 10 devices per account');
  users.a.pushSubs = [goodSub(1)];

  calls = [];
  assert.strictEqual(await push.send('a', 'mention', { title: 'T'.repeat(300), body: 'B'.repeat(500), url: '/app?n=d:b', tag: 'm:1' }), 1);
  assert.ok(calls[0].body.title.length <= 80 && calls[0].body.body.length <= 160, 'payload text is clipped');
  assert.strictEqual(calls[0].body.url, '/app?n=d:b');
  assert.strictEqual(calls[0].opts.urgency, 'high');

  // preferences and Do Not Disturb
  users.a.notifPrefs = { dm: false };
  calls = [];
  assert.strictEqual(await push.send('a', 'dm', { title: 'x', body: 'y' }), 0, 'switched-off kinds are not sent');
  assert.strictEqual(await push.send('a', 'mention', { title: 'x', body: 'y' }), 1, 'other kinds still are');
  users.a.status = 'dnd';
  assert.strictEqual(await push.send('a', 'mention', { title: 'x', body: 'y' }), 0, 'Do Not Disturb silences pings');
  assert.strictEqual(await push.send('a', 'call', { title: 'x', body: 'y' }), 1, 'but a ringing call goes through');
  users.a.status = 'online';

  // dead subscriptions are removed, other errors are kept for next time
  push.add(users.a, goodSub(7), 'UA');
  failWith = { n: '7', err: Object.assign(new Error('gone'), { statusCode: 410 }) };
  assert.strictEqual(await push.send('a', 'mention', { title: 'x', body: 'y' }), 1);
  assert.ok(!users.a.pushSubs.some((x) => x.endpoint.endsWith('/7')), 'a 410 removes the subscription');
  push.add(users.a, goodSub(8), 'UA');
  failWith = { n: '8', err: Object.assign(new Error('busy'), { statusCode: 503 }) };
  await push.send('a', 'mention', { title: 'x', body: 'y' });
  assert.ok(users.a.pushSubs.some((x) => x.endpoint.endsWith('/8')), 'a temporary error keeps it');

  // off switch
  const off = createPush({ users: () => users, save() {}, enabled: false, sender: async () => { throw new Error('should not send'); } });
  assert.strictEqual(await off.send('a', 'mention', { title: 'x', body: 'y' }), 0);

  // remove
  push.remove(users.a, goodSub(1).endpoint);
  assert.ok(!users.a.pushSubs.some((x) => x.endpoint === goodSub(1).endpoint));
  console.log('push-test: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
