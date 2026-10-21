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

  // older accounts (no flag) are asked to verify at their next sign-in; one with no email must add one
  const old = Object.values(store.db.users).find((x) => x.username === 'walt'); delete old.emailVerified; delete old.verify;
  r = await call('/me', { token: b.token }); assert.strictEqual(r.user.emailVerified, false); assert.strictEqual(r.user.codeSent, false);
  assert.strictEqual((await call('/friends', { token: b.token })).status, 403);
  r = await call('/me/resend-verification', { method: 'POST', token: b.token }); assert.strictEqual(r.status, 200);
  assert.strictEqual((await call('/me/verify-email', { method: 'POST', token: b.token, body: { code: lastCode('walt@example.com') } })).status, 200);
  assert.strictEqual((await call('/friends', { token: b.token })).status, 200); step('older accounts get a code and verify');
  const c2 = await reg('xena'); const xe = Object.values(store.db.users).find((x) => x.username === 'xena'); delete xe.email; delete xe.emailVerified; delete xe.verify;
  assert.strictEqual((await call('/me/resend-verification', { method: 'POST', token: c2.token })).status, 400);
  r = await call('/me', { method: 'PATCH', token: c2.token, body: { email: 'xena2@example.com' } });
  assert.strictEqual(r.status, 200); assert.ok(lastCode('xena2@example.com')); step('older account with no email adds one and is sent a code');

  // sign-up and email change must not reveal which addresses are registered
  {
    const blob = { salt: 'a', iv: 'b', data: 'c' };
    const signup = (username, email) => call('/register', { method: 'POST', body: { username, email, password: 'password123', publicKey: 'k', encPrivKey: blob } });
    const owner = await reg('yara');                                  // yara@example.com, verified below
    assert.strictEqual((await call('/me/verify-email', { method: 'POST', token: owner.token, body: { code: lastCode('yara@example.com') } })).status, 200);

    const mark = mailer.outbox.length;
    const dup = await signup('zed_dup', 'yara@example.com');          // an address that is already registered and verified
    const fresh = await signup('zed_fresh', 'zed_fresh@example.com');  // one that is not
    assert.ok(dup.status === 200 && fresh.status === 200, 'both sign-ups are accepted: ' + dup.status + '/' + fresh.status);
    assert.deepStrictEqual(Object.keys(dup).sort(), Object.keys(fresh).sort(), 'same answer shape');
    assert.deepStrictEqual(Object.keys(dup.user).sort(), Object.keys(fresh.user).sort());
    assert.ok(dup.user.emailVerified === false && fresh.user.emailVerified === false, 'both unverified');
    assert.ok(dup.user.codeSent === true && fresh.user.codeSent === true, 'both look as if a code was sent');
    const notice = mailer.outbox.slice(mark).filter((m) => m.to === 'yara@example.com');
    assert.strictEqual(notice.length, 1, 'the real owner is told');
    assert.ok(/already have/i.test(notice[0].subject) && !/\d{6}/.test(notice[0].subject + notice[0].text + notice[0].html), 'a notice, not a code');
    assert.ok(!/zed_dup/.test(notice[0].text + notice[0].html), 'nothing the visitor typed ends up in the notice');
    assert.ok(lastCode('zed_fresh@example.com'), 'the new address gets a real code');
    assert.strictEqual((await call('/me/verify-email', { method: 'POST', token: dup.token, body: { code: '123456' } })).status, 400, 'no code can be verified for the taken address');
    assert.strictEqual((await call('/friends', { token: dup.token })).status, 403, 'and that account stays locked');
    step('sign-up with an address that is already registered looks the same as any other, and only the owner is told');

    // the notices are limited per address (3 an hour)
    for (const n of ['zed_2', 'zed_3', 'zed_4', 'zed_5']) assert.strictEqual((await signup(n, 'yara@example.com')).status, 200);
    assert.strictEqual(mailer.outbox.slice(mark).filter((m) => m.to === 'yara@example.com').length, 3, 'at most 3 notices to one address, the rest are silent');
    step('"account exists" notices are limited per address');

    // nobody can squat on an address by registering it first
    const squat = await signup('sq_attacker', 'newbie@example.com');
    const squatCode = lastCode('newbie@example.com'); // what the mailbox owner would have received; the attacker never sees it
    const real = await reg('newbie');
    assert.strictEqual(real.status, 200, 'the real owner can still sign up with their own address');
    assert.strictEqual((await call('/me/verify-email', { method: 'POST', token: real.token, body: { code: lastCode('newbie@example.com') } })).status, 200, 'and verify it');
    r = await call('/me/verify-email', { method: 'POST', token: squat.token, body: { code: squatCode } });
    assert.strictEqual(r.status, 409, 'a late claim on a verified address is refused at verification');
    assert.ok(/already uses/.test(r.error));
    step('an unverified claim blocks nobody: uniqueness is decided when the address is verified');

    // changing the email to a registered address behaves the same way
    const zoe = await reg('zoe');
    const mark2 = mailer.outbox.length;
    r = await call('/me', { method: 'PATCH', token: zoe.token, body: { email: 'walt@example.com' } });
    assert.ok(r.status === 200 && r.user.emailVerified === false && r.user.codeSent === true, 'accepted exactly like any other change: ' + JSON.stringify(r).slice(0, 120));
    const n2 = mailer.outbox.slice(mark2).filter((m) => m.to === 'walt@example.com');
    assert.ok(n2.length === 1 && /already have/i.test(n2[0].subject), 'walt is told, no code is sent');
    assert.strictEqual((await call('/friends', { token: zoe.token })).status, 403);
    step('changing the email to a registered address looks the same as any other change');
  }

  console.log('\nemail-verify-test: all passed');
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; }).finally(async () => { httpServer.close(); await cleanup(); process.exit(process.exitCode || 0); });
