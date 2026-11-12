// At most two accounts per person (per browser): node server/device-limit-test.js
const assert = require('assert');
const { cleanup } = require('./test-env');
const S = require('./security');
const { httpServer, ready } = require('./index');
const { db } = require('./db');

let base;
// a tiny cookie jar: one per "browser"
const jar = () => ({ cookie: '' });
async function signup(j, username, extra = {}) {
  const r = await fetch(base + '/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(j.cookie ? { Cookie: j.cookie } : {}) },
    body: JSON.stringify({ username, password: 'password123', publicKey: 'k', encPrivKey: { salt: 'a', iv: 'b', data: 'c' }, ...extra }),
  });
  for (const c of r.headers.getSetCookie()) if (c.startsWith('aduna_device=')) j.cookie = c.split(';')[0];
  return { status: r.status, headers: r.headers, ...(await r.json()) };
}
const step = (m) => console.log('✓', m);

(async () => {
  // helpers
  const t = S.newDeviceToken();
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(t));
  assert.strictEqual(S.readDeviceCookie({ cookie: 'aduna_device=' + t }, false), t);
  assert.strictEqual(S.readDeviceCookie({ cookie: 'aduna_device=short' }, false), '', 'a malformed value is ignored');
  assert.strictEqual(S.readDeviceCookie({ cookie: '__Host-aduna_device=' + t }, false), '', 'over http only the plain name counts');
  assert.ok(/HttpOnly/.test(S.deviceCookie(t)) && /Secure/.test(S.deviceCookie(t, { secure: true })));
  assert.ok(/^[0-9a-f]{64}$/.test(S.deviceKey(t)) && S.deviceKey(t) !== t);
  step('the device cookie is validated, httpOnly, and only its hash is kept');

  await ready;
  await new Promise((r) => httpServer.listen(0, r));
  base = 'http://127.0.0.1:' + httpServer.address().port;

  const a = jar();
  let r = await signup(a, 'devone');
  assert.strictEqual(r.status, 200); assert.ok(a.cookie.startsWith('aduna_device='), 'the first sign-up sets the device cookie');
  step('the first account works and sets the cookie');

  r = await signup(a, 'devtwo');
  assert.strictEqual(r.status, 200); step('the second account on the same browser works');

  r = await signup(a, 'devthree');
  assert.strictEqual(r.status, 403); assert.strictEqual(r.code, 'account_limit');
  assert.ok(!Object.values(db.users).some((u) => u.username === 'devthree')); step('the third account on the same browser is refused and makes nothing');

  const stored = Object.values(db.users).find((u) => u.username === 'devone');
  assert.ok(/^[0-9a-f]{64}$/.test(stored.deviceKey) && !a.cookie.includes(stored.deviceKey)); step('the account keeps a hash, not the cookie');

  const b = jar();
  r = await signup(b, 'devfour');
  assert.strictEqual(r.status, 200); step('a different browser starts its own count');

  Object.values(db.users).find((u) => u.username === 'devtwo').deleted = true;
  r = await signup(a, 'devfive');
  assert.strictEqual(r.status, 200); step('deleting an account frees a place');

  console.log('\ndevice-limit-test: all passed');
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; }).finally(async () => { httpServer.close(); await cleanup(); process.exit(process.exitCode || 0); });
