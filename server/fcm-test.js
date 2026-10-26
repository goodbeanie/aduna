// Tests for server/fcm.js (no network, no database): node server/fcm-test.js
const assert = require('assert');
const crypto = require('crypto');
const { createFcm, parseAccount, validToken } = require('./fcm');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const account = { type: 'service_account', project_id: 'aduna-test', client_email: 'push@aduna-test.iam.gserviceaccount.com', private_key: pem };
const TOKEN = 'dGVzdC10b2tlbi0xMjM0NTY3ODkwOkFQQTkxYl9hYmMtZGVm';

// ---- parsing ----
assert.strictEqual(parseAccount(''), null);
assert.strictEqual(parseAccount('not json'), null);
assert.strictEqual(parseAccount(JSON.stringify({ type: 'authorized_user' })), null, 'only service accounts');
assert.strictEqual(parseAccount(JSON.stringify(account)).projectId, 'aduna-test');
assert.strictEqual(parseAccount(Buffer.from(JSON.stringify(account)).toString('base64')).email, account.client_email, 'base64 is accepted too');
assert.ok(validToken(TOKEN) && !validToken('short') && !validToken('x'.repeat(30) + '<script>') && !validToken(null));
assert.strictEqual(createFcm({ raw: '' }).enabled, false);

// ---- sending ----
(async () => {
  let t = 1_000_000, calls = [], nextSend = () => ({ ok: true, status: 200, json: async () => ({ name: 'projects/x/messages/1' }) });
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://oauth2.googleapis.com/token') return { ok: true, status: 200, json: async () => ({ access_token: 'AT' + calls.length, expires_in: 3600 }) };
    return nextSend(url, init);
  };
  const fcm = createFcm({ raw: JSON.stringify(account), fetchFn, now: () => t });
  assert.strictEqual(fcm.enabled, true);

  await assert.rejects(createFcm({ raw: '' }).send(TOKEN, '{}'), (e) => e.statusCode === 503, 'unconfigured: refuses cleanly');

  await fcm.send(TOKEN, JSON.stringify({ kind: 'dm', title: 'Sam', body: 'Sent you a message', url: '/app?n=d:1', tag: 'm:9' }), { TTL: 3600 });
  assert.strictEqual(calls.length, 2, 'one sign-in, one send');
  // the JWT is a real RS256 signature over the right claims
  const form = new URLSearchParams(calls[0].init.body);
  assert.strictEqual(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [h, c, s] = form.get('assertion').split('.');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(h + '.' + c), publicKey, Buffer.from(s, 'base64url')), 'JWT signature verifies');
  const claim = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.deepStrictEqual([claim.iss, claim.aud, claim.scope], [account.client_email, 'https://oauth2.googleapis.com/token', 'https://www.googleapis.com/auth/firebase.messaging']);
  assert.strictEqual(claim.exp - claim.iat, 3600);
  // the FCM request
  assert.strictEqual(calls[1].url, 'https://fcm.googleapis.com/v1/projects/aduna-test/messages:send');
  assert.strictEqual(calls[1].init.headers.Authorization, 'Bearer AT1');
  const m = JSON.parse(calls[1].init.body).message;
  assert.strictEqual(m.token, TOKEN);
  assert.deepStrictEqual(m.notification, { title: 'Sam', body: 'Sent you a message' });
  assert.deepStrictEqual(m.data, { url: '/app?n=d:1', kind: 'dm', tag: 'm:9' });
  assert.deepStrictEqual([m.android.priority, m.android.ttl, m.android.notification.channel_id, m.android.notification.tag], ['HIGH', '3600s', 'messages', 'm:9']);
  Object.values(m.data).forEach((v) => assert.strictEqual(typeof v, 'string', 'FCM data values must be strings'));

  // calls ring on their own channel; the access token is reused
  await fcm.send(TOKEN, JSON.stringify({ kind: 'call', title: 'Sam is calling', body: 'Incoming voice call' }), { TTL: 45 });
  assert.strictEqual(calls.length, 3, 'the access token is cached');
  const cm = JSON.parse(calls[2].init.body).message;
  assert.deepStrictEqual([cm.android.notification.channel_id, cm.android.ttl, cm.android.notification.tag], ['calls', '45s', undefined]);

  // an app with the native call screen gets a DATA-ONLY call (no notification block): its own service draws Answer / Decline and rings
  await fcm.send(TOKEN, JSON.stringify({ kind: 'call', title: 'Sam is calling', body: 'Incoming video call', tag: 'call', sender: 'Sam', callId: 'ab12cd34ef56ab78', video: true, declineToken: 'f'.repeat(32) }), { TTL: 45, callUi: true });
  const ring = JSON.parse(calls[calls.length - 1].init.body).message;
  assert.strictEqual(ring.notification, undefined, 'data-only: nothing for the system to draw');
  assert.deepStrictEqual(ring.data, { kind: 'call', url: '/app', tag: 'call', callId: 'ab12cd34ef56ab78', title: 'Sam is calling', body: 'Incoming video call', sender: 'Sam', video: '1', declineToken: 'f'.repeat(32) });
  assert.deepStrictEqual([ring.android.priority, ring.android.ttl], ['HIGH', '45s']);
  Object.values(ring.data).forEach((v) => assert.strictEqual(typeof v, 'string', 'FCM data values must be strings'));
  // taking the ringing screen down
  await fcm.send(TOKEN, JSON.stringify({ kind: 'call', cancel: true, callId: 'ab12cd34ef56ab78', tag: 'call' }), { TTL: 30, callUi: true });
  const stop = JSON.parse(calls[calls.length - 1].init.body).message;
  assert.strictEqual(stop.data.cancel, '1');
  assert.strictEqual(stop.data.callId, 'ab12cd34ef56ab78');
  // no callUi (an older app) or no call id: the plain system notification as before
  await fcm.send(TOKEN, JSON.stringify({ kind: 'call', title: 'Sam is calling', body: 'Incoming voice call', callId: 'ab12cd34ef56ab78' }), { TTL: 45 });
  assert.ok(JSON.parse(calls[calls.length - 1].init.body).message.notification, 'older apps keep the system notification');
  await fcm.send(TOKEN, JSON.stringify({ kind: 'call', title: 'x', body: 'y', callId: '../bad' }), { TTL: 45, callUi: true });
  assert.ok(JSON.parse(calls[calls.length - 1].init.body).message.notification, 'a malformed call id never becomes a ring');
  await fcm.send(TOKEN, JSON.stringify({ kind: 'dm', title: 'x', body: 'y', callId: 'ab12cd34ef56ab78' }), { callUi: true });
  assert.ok(JSON.parse(calls[calls.length - 1].init.body).message.notification, 'only calls are data-only');
  calls.length = 3; // the checks below count requests from here

  // a new token is fetched after it expires
  t += 3_600_000;
  await fcm.send(TOKEN, JSON.stringify({ kind: 'dm', title: 'x', body: 'y' }));
  assert.strictEqual(calls.length, 5, 'expired access token is renewed');

  // error mapping: uninstalled app -> 404 (caller deletes the device); anything else keeps it
  nextSend = () => ({ ok: false, status: 404, json: async () => ({ error: { status: 'NOT_FOUND', message: 'Requested entity was not found.' } }) });
  await assert.rejects(fcm.send(TOKEN, '{"title":"x"}'), (e) => e.statusCode === 404);
  nextSend = () => ({ ok: false, status: 400, json: async () => ({ error: { status: 'UNREGISTERED', message: 'gone' } }) });
  await assert.rejects(fcm.send(TOKEN, '{"title":"x"}'), (e) => e.statusCode === 404, 'UNREGISTERED counts as gone');
  nextSend = () => ({ ok: false, status: 500, json: async () => ({ error: { status: 'INTERNAL', message: 'oops' } }) });
  await assert.rejects(fcm.send(TOKEN, '{"title":"x"}'), (e) => e.statusCode === 500, 'a server error keeps the device');

  // a 401 gets one retry with a fresh access token
  let first = true; calls = [];
  nextSend = () => (first ? ((first = false), { ok: false, status: 401, json: async () => ({}) }) : { ok: true, status: 200, json: async () => ({}) });
  await fcm.send(TOKEN, '{"title":"x"}');
  assert.strictEqual(calls.filter((c) => c.url.includes('messages:send')).length, 2);
  assert.strictEqual(calls.filter((c) => c.url.includes('oauth2')).length, 1, 'cached token dropped, one fresh sign-in');

  // a broken sign-in never looks like a dead device
  const bad = createFcm({ raw: JSON.stringify(account), now: () => t, fetchFn: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }) });
  await assert.rejects(bad.send(TOKEN, '{"title":"x"}'), (e) => e.statusCode === 502);

  console.log('fcm-test: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
