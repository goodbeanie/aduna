// Tests for server/push.js (no database needed): node server/push-test.js
const assert = require('assert');
const { createPush, cleanLook, cleanPrefs, cleanSub, DEFAULT_PREFS } = require('./push');

const goodSub = (n = 1) => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/' + n, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } });

// ---- validation ----
assert.ok(cleanSub(goodSub()), 'a real subscription is accepted');
assert.strictEqual(cleanSub({ ...goodSub(), endpoint: 'http://push.example.com/x' }), null, 'http endpoints are refused');
assert.strictEqual(cleanSub({ ...goodSub(), endpoint: 'javascript:alert(1)' }), null);
assert.strictEqual(cleanSub({ endpoint: 'https://x.example/a' }), null, 'keys are required');
for (const bad of ['https://internal.example/hook', 'https://127.0.0.1/x', 'https://localhost/x', 'https://fcm.googleapis.com.evil.example/x', 'https://evilfcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://user:pw@fcm.googleapis.com/x', 'http://fcm.googleapis.com/x'])
  assert.strictEqual(cleanSub({ ...goodSub(), endpoint: bad }), null, 'endpoint must be a real push service: ' + bad);
for (const ok of ['https://fcm.googleapis.com/fcm/send/a', 'https://updates.push.services.mozilla.com/wpush/v2/a', 'https://web.push.apple.com/a', 'https://wns2-par02p.notify.windows.com/w/?token=a'])
  assert.ok(cleanSub({ ...goodSub(), endpoint: ok }), 'real push service accepted: ' + ok);
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
  assert.ok(calls[0].body.title.length <= 80 && calls[0].body.body.length <= 240, 'payload text is clipped');
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

  // test push: ignores switches + Do Not Disturb, forces display, reports per-device failures, drops dead devices
  users.a.pushSubs = []; users.a.notifPrefs = { dm: false, mentions: false, calls: false }; users.a.status = 'dnd';
  push.add(users.a, goodSub(41), 'UA'); push.add(users.a, goodSub(42), 'UA'); push.add(users.a, goodSub(43), 'UA');
  calls = [];
  failWith = null;
  const sender2 = push; // same instance; make 42 fail with 403 and 43 with 410
  const origSub = users.a.pushSubs.slice();
  let errs = 0;
  const tp = createPush({
    users: () => users, save() {}, enabled: true, onError: () => { errs++; },
    sender: async (sub, body) => { calls.push(JSON.parse(body)); if (sub.endpoint.endsWith('/42')) throw Object.assign(new Error('forbidden'), { statusCode: 403, body: 'bad vapid' }); if (sub.endpoint.endsWith('/43')) throw Object.assign(new Error('gone'), { statusCode: 410 }); },
  });
  const r = await tp.test('a');
  assert.deepStrictEqual([r.enabled, r.devices, r.sent, r.failed.length], [true, 3, 1, 2]);
  assert.ok(r.failed.some((f) => f.status === 403 && f.message === 'bad vapid'), 'the failure status is reported');
  assert.ok(calls.every((c) => c.force === true && c.kind === 'test'), 'a test is forced past the "app is open" check');
  assert.ok(users.a.pushSubs.some((x) => x.endpoint.endsWith('/42')) && !users.a.pushSubs.some((x) => x.endpoint.endsWith('/43')), '410 is dropped, 403 is kept');
  assert.strictEqual(errs, 2);
  assert.deepStrictEqual(await tp.test('nobody'), { enabled: true, devices: 0, sent: 0, failed: [] });
  assert.strictEqual((await createPush({ users: () => users, save() {}, enabled: false, sender: async () => {} }).test('a')).sent, 0);
  users.a.status = 'online';

  // off switch
  const off = createPush({ users: () => users, save() {}, enabled: false, sender: async () => { throw new Error('should not send'); } });
  assert.strictEqual(await off.send('a', 'mention', { title: 'x', body: 'y' }), 0);


  // look + buttons: only well-formed values reach the service worker
  {
    const good = cleanLook({ icon: '/api/images/abc123_-X', sender: 'Alice', theme: { dark: true, bg: '#101010', accent: '#ffcc00' }, serverId: 's1', channelId: 'c1', peerId: 'u2', msgId: 'm9', reply: 'inline', read: true });
    assert.deepStrictEqual(good, { icon: '/api/images/abc123_-X', sender: 'Alice', theme: { dark: true, bg: '#101010', accent: '#ffcc00' }, serverId: 's1', channelId: 'c1', peerId: 'u2', msgId: 'm9', reply: 'inline', read: true });
    const bad = cleanLook({ icon: 'https://evil.example/x.png', theme: { dark: 'yes', bg: 'red', accent: '#fff' }, serverId: '../x', channelId: 'a b', msgId: 5, reply: 'send-everything', read: 'yes' });
    assert.deepStrictEqual(bad, {}, 'foreign icon, bad theme, bad ids, unknown reply mode and non-true read are all dropped');
    assert.strictEqual(cleanLook({ icon: '/api/images/../../etc/passwd' }).icon, undefined);
    assert.strictEqual(cleanLook({ sender: 'x'.repeat(100) }).sender.length, 40);
    const seen = [];
    const lp = createPush({ users: () => users, save() {}, enabled: true, sender: async (sub, body) => { seen.push(JSON.parse(body)); } });
    users.a.status = 'online';
    assert.ok(lp.add(users.a, goodSub(77), 'UA'));
    users.a.notifPrefs = undefined;
    await lp.send('a', 'mention', { title: 'Alice', body: 'Server \u00b7 #general\nhello', url: '/app?n=c:s1:c1', tag: 'm:1', icon: '/api/images/abc123', serverId: 's1', channelId: 'c1', reply: 'inline', read: true });
    assert.ok(seen.length && seen[0].icon === '/api/images/abc123' && seen[0].reply === 'inline' && seen[0].read === true && seen[0].channelId === 'c1');
    assert.ok(seen[0].body.includes('hello'), 'a two-line body is kept');
  }

  // remove
  push.remove(users.a, goodSub(1).endpoint);
  assert.ok(!users.a.pushSubs.some((x) => x.endpoint === goodSub(1).endpoint));
  console.log('push-test: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
