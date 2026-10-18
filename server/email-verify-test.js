// Email verification: node server/email-verify-test.js
const assert = require('assert');
const { cleanup } = require('./test-env');
process.env.RESEND_API_KEY = 're_test_not_real'; // switches verification on; NODE_ENV=test keeps mail in mailer.outbox
const mailer = require('./mailer');
const { httpServer, ready } = require('./index');

let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const reg = (n) => call('/register', { method: 'POST', body: { username: n, email: n + '@example.com', password: 'password123', publicKey: 'k', encPrivKey: { salt: 'a', iv: 'b', data: 'c' } } });
const lastCode = (to) => { const m = [...mailer.outbox].reverse().find((x) => x.to === to); return m && /\b(\d{6})\b/.exec(m.subject)[1]; };
const step = (m) => console.log('✓', m);

(async () => {
  await ready;
  await new Promise((r) => httpServer.listen(0, r));
  base = 'http://127.0.0.1:' + httpServer.address().port;

  const a = await reg('vera');
  assert.strictEqual(a.status, 200); assert.strictEqual(a.user.emailVerified, false);
  assert.ok(!JSON.stringify(a).includes('"hash"'), 'code hash must not leak');
  const code = lastCode('vera@example.com');
  assert.ok(/^\d{6}$/.test(code)); step('register sends a 6-digit code and returns an unverified user');

  let r = await call('/friends', { token: a.token });
  assert.strictEqual(r.status, 403); assert.strictEqual(r.code, 'email_unverified');
  r = await call('/credits', { token: a.token }); assert.strictEqual(r.status, 403);
  assert.strictEqual((await call('/me', { token: a.token })).status, 200); step('unverified accounts are blocked from the API but can read /me');

  r = await call('/me/verify-email', { method: 'POST', token: a.token, body: { code: code === '000000' ? '111111' : '000000' } });
  assert.strictEqual(r.status, 400); step('wrong code refused');
  r = await call('/me/resend-verification', { method: 'POST', token: a.token });
  assert.strictEqual(r.status, 429); step('resend cooldown enforced');

  for (let i = 0; i < 5; i++) await call('/me/verify-email', { method: 'POST', token: a.token, body: { code: '999999' } });
  r = await call('/me/verify-email', { method: 'POST', token: a.token, body: { code } });
  assert.strictEqual(r.status, 429); step('too many wrong tries locks the code, even the right one');

  // force the cooldown to pass, then resend
  const store = require('./db'); const u = Object.values(store.db.users).find((x) => x.username === 'vera'); u.verify.sentAt -= 61_000;
  r = await call('/me/resend-verification', { method: 'POST', token: a.token }); assert.strictEqual(r.status, 200);
  const code2 = lastCode('vera@example.com');
  r = await call('/me/verify-email', { method: 'POST', token: a.token, body: { code: code2 } });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.user.emailVerified, true); step('new code verifies');
  assert.strictEqual((await call('/friends', { token: a.token })).status, 200); step('verified account has access');

  // expired code
  const b = await reg('walt'); const w = Object.values(store.db.users).find((x) => x.username === 'walt');
  const c = lastCode('walt@example.com'); w.verify.expires = Date.now() - 1;
  assert.strictEqual((await call('/me/verify-email', { method: 'POST', token: b.token, body: { code: c } })).status, 400); step('expired code refused');

  // changing email requires verifying again
  r = await call('/me', { method: 'PATCH', token: a.token, body: { email: 'vera2@example.com' } });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.user.emailVerified, false);
  assert.strictEqual((await call('/friends', { token: a.token })).status, 403);
  assert.ok(lastCode('vera2@example.com')); step('changing email re-locks until verified');

  // legacy accounts (no flag) stay verified
  const old = Object.values(store.db.users).find((x) => x.username === 'walt'); delete old.emailVerified;
  assert.strictEqual((await call('/friends', { token: b.token })).status, 200); step('accounts without the flag keep working');

  console.log('\nemail-verify-test: all passed');
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; }).finally(async () => { httpServer.close(); await cleanup(); process.exit(process.exitCode || 0); });
