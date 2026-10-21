// Recovery key / password reset over HTTP: node server/recovery-test.js
const assert = require('assert');
const crypto = require('crypto');
const { cleanup, rawDb } = require('./test-env');
process.env.RESEND_API_KEY = 're_test_not_real'; // mail on (NODE_ENV=test keeps it in mailer.outbox), so the security notices can be checked
const mailer = require('./mailer');
const T = require('./totp');
const store = require('./db');
const { httpServer, ready, loginGuard } = require('./index');

let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, headers: r.headers, ...(await r.json().catch(() => ({}))) };
}
const step = (m) => console.log('✓', m);
const b64 = (n) => crypto.randomBytes(n).toString('base64');
const blob = () => ({ salt: b64(16), iv: b64(12), data: crypto.randomBytes(192).toString('base64') }); // 256 chars, like the browser's
const rec = () => ({ blob: blob(), auth: crypto.randomBytes(32).toString('base64') });
const verified = (name) => { Object.values(store.db.users).find((x) => x.username === name).emailVerified = true; };

const rawRecovery = async (n) => Object.values(store.db.users).find((x) => x.username === n).recovery.verifier;
const loginGuardReset = () => { loginGuard.pair.clear(); loginGuard.name.clear(); }; // wrong guesses lock a name out (tested above); clear it between steps
async function reg(name, recovery, pw = 'password123') {
  const r = await call('/register', { method: 'POST', body: { username: name, email: name + '@example.com', password: pw, publicKey: 'k', encPrivKey: blob(), ...(recovery ? { recovery } : {}) } });
  assert.strictEqual(r.status, 200, 'register ' + name + ': ' + r.error);
  verified(name);
  return r;
}

(async () => {
  await ready;
  await new Promise((r) => httpServer.listen(0, r));
  base = 'http://127.0.0.1:' + httpServer.address().port;

  // ---- sign-up with a recovery key ----
  const kim = rec();
  const a = await reg('kim', kim);
  assert.strictEqual(a.user.recoveryKey, true);
  const none = await reg('noel');
  assert.strictEqual(none.user.recoveryKey, false);
  assert.strictEqual((await call('/register', { method: 'POST', body: { username: 'bad1', email: 'bad1@example.com', password: 'password123', publicKey: 'k', encPrivKey: blob(), recovery: { blob: blob(), auth: 'short' } } })).status, 400);
  assert.strictEqual((await call('/register', { method: 'POST', body: { username: 'bad2', email: 'bad2@example.com', password: 'password123', publicKey: 'k', encPrivKey: blob(), recovery: 'nope' } })).status, 400);
  step('register stores a recovery key; malformed ones are refused');

  const raw = await rawDb();
  assert.ok(!raw.includes(kim.auth), 'the proof itself is never stored');
  assert.ok(!JSON.stringify(a).includes('verifier') && !JSON.stringify(await call('/me', { token: a.token })).includes('verifier'), 'nothing recovery-related leaks to the API');
  assert.ok(!JSON.stringify(await call('/me', { token: a.token })).includes(kim.blob.data), 'the blob is not sent back by /me');
  step('only a hash of the proof is stored; the API never returns it');

  // ---- start: real names and decoys look the same ----
  const s1 = await call('/recover/start', { method: 'POST', body: { username: 'kim' } });
  assert.deepStrictEqual(s1.blob, kim.blob);
  const s2 = await call('/recover/start', { method: 'POST', body: { username: 'noel' } });   // exists, no key
  const s3 = await call('/recover/start', { method: 'POST', body: { username: 'nobody_here' } }); // does not exist
  const s3b = await call('/recover/start', { method: 'POST', body: { username: 'NOBODY_here' } });
  for (const s of [s1, s2, s3]) {
    assert.deepStrictEqual(Object.keys(s.blob).sort(), ['data', 'iv', 'salt']);
    assert.strictEqual(s.blob.salt.length, 24); assert.strictEqual(s.blob.iv.length, 16); assert.strictEqual(s.blob.data.length, 256);
  }
  assert.deepStrictEqual(s3.blob, s3b.blob, 'a decoy is stable per name (case-insensitive)');
  assert.notDeepStrictEqual(s2.blob, s3.blob);
  assert.ok(!JSON.stringify(s2).includes('error') && s2.status === 200 && s3.status === 200);
  step('start answers identically in shape for a real key, an account without one, and an unknown name');

  // ---- finish: wrong things ----
  const newBlob = blob();
  const fin = (o) => call('/recover/finish', { method: 'POST', body: { username: 'kim', auth: kim.auth, newPassword: 'a-brand-new-pass', encPrivKey: newBlob, ...o } });
  let r = await fin({ auth: crypto.randomBytes(32).toString('base64') });
  assert.strictEqual(r.status, 401); assert.strictEqual(r.code, 'recovery_invalid');
  assert.strictEqual((await fin({ username: 'noel', auth: kim.auth })).status, 401, "someone else's proof");
  assert.strictEqual((await fin({ username: 'nobody_here' })).status, 401);
  assert.strictEqual((await call('/recover/finish', { method: 'POST', body: { username: 'noel', auth: crypto.randomBytes(32).toString('base64'), newPassword: 'a-brand-new-pass', encPrivKey: newBlob } })).status, 401, 'no key set: refused');
  assert.strictEqual((await fin({ newPassword: 'short' })).status, 400);
  assert.strictEqual((await fin({ encPrivKey: null })).status, 400);
  assert.strictEqual((await call('/login', { method: 'POST', body: { username: 'kim', password: 'password123' } })).status, 200, 'nothing changed so far');
  step('wrong proof, other account, no key, short password, missing blob: all refused, account untouched');

  // ---- lockout ----
  for (let i = 0; i < 6; i++) await fin({ username: 'lockme', auth: crypto.randomBytes(32).toString('base64') });
  r = await fin({ username: 'lockme' }); assert.strictEqual(r.status, 429);
  step('repeated wrong proofs lock that name out');
  // the lockout is shared with logging in: five wrong passwords block recovery too
  await reg('lina', rec());
  for (let i = 0; i < 5; i++) await call('/login', { method: 'POST', body: { username: 'lina', password: 'wrong-password' } });
  assert.strictEqual((await call('/recover/finish', { method: 'POST', body: { username: 'lina', auth: crypto.randomBytes(32).toString('base64'), newPassword: 'a-brand-new-pass', encPrivKey: blob() } })).status, 429);
  step('the lockout is shared with login');

  // ---- success ----
  const old = await call('/login', { method: 'POST', body: { username: 'kim', password: 'password123' } });
  assert.strictEqual((await call('/me', { token: old.token })).status, 200);
  mailer.outbox.length = 0;
  r = await fin({});
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.ok(r.token && r.user.username === 'kim' && r.user.recoveryKey === true);
  assert.deepStrictEqual(r.encPrivKey, newBlob, 'the stored key blob is the one the device wrapped with the new password');
  assert.ok((r.headers.getSetCookie?.() || []).some((c) => /httponly/i.test(c)), 'a session cookie is set');
  assert.strictEqual((await call('/me', { token: r.token })).status, 200, 'this device is signed in');
  assert.strictEqual((await call('/me', { token: old.token })).status, 401, 'every earlier session is revoked');
  assert.strictEqual((await call('/login', { method: 'POST', body: { username: 'kim', password: 'password123' } })).status, 401, 'old password is dead');
  const li = await call('/login', { method: 'POST', body: { username: 'kim', password: 'a-brand-new-pass' } });
  assert.strictEqual(li.status, 200); assert.deepStrictEqual(li.encPrivKey, newBlob);
  assert.ok(mailer.outbox.some((m) => m.to === 'kim@example.com' && /password was reset/.test(m.subject)), 'the owner is emailed');
  step('reset: new password works, old one and old sessions are dead, key blob replaced, owner emailed');
  assert.strictEqual((await fin({ newPassword: 'yet-another-pass' })).status, 200, 'the same recovery key keeps working (it wraps the same identity)');
  step('the recovery key stays valid after a reset');

  // ---- setting / replacing ----
  const put = (token, o) => call('/me/recovery', { method: 'PUT', token, body: o });
  const t = (await call('/login', { method: 'POST', body: { username: 'noel', password: 'password123' } })).token;
  const noel1 = rec();
  assert.strictEqual((await put(t, { password: 'wrong-pass', recovery: noel1 })).status, 400);
  assert.strictEqual((await put(t, { password: 'password123', recovery: { blob: blob(), auth: 'x' } })).status, 400);
  assert.strictEqual((await put(undefined, { password: 'password123', recovery: noel1 })).status, 401);
  r = await put(t, { password: 'password123', recovery: noel1 });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.user.recoveryKey, true);
  assert.deepStrictEqual((await call('/recover/start', { method: 'POST', body: { username: 'noel' } })).blob, noel1.blob);
  const noel2 = rec();
  assert.strictEqual((await put(t, { password: 'password123', recovery: noel2 })).status, 200);
  const nf = (k) => call('/recover/finish', { method: 'POST', body: { username: 'noel', auth: k.auth, newPassword: 'noels-new-pass-1', encPrivKey: blob() } });
  assert.strictEqual((await nf(noel1)).status, 401, 'a replaced key stops working');
  assert.strictEqual((await nf(noel2)).status, 200);
  step('a recovery key can be created later (password needed) and replaced; the old one dies');

  // ---- two-factor is not skipped ----
  const pat = await reg('pat', rec()); const patKey = Object.values(store.db.users).find((x) => x.username === 'pat').recovery;
  const patRec = rec(); await put(pat.token, { password: 'password123', recovery: patRec });
  const su = await call('/me/2fa/setup', { method: 'POST', token: pat.token, body: { password: 'password123' } });
  const en = await call('/me/2fa/enable', { method: 'POST', token: pat.token, body: { code: T.hotp(T.b32decode(su.secret), T.stepAt(Date.now())) } });
  assert.strictEqual(en.status, 200);
  const pf = (o) => call('/recover/finish', { method: 'POST', body: { username: 'pat', auth: patRec.auth, newPassword: 'pats-new-pass-1', encPrivKey: blob(), ...o } });
  r = await pf({}); assert.strictEqual(r.status, 401); assert.strictEqual(r.code, '2fa_required');
  r = await pf({ code: '000000' }); assert.strictEqual(r.status, 401); assert.strictEqual(r.code, '2fa_invalid');
  assert.strictEqual((await call('/login', { method: 'POST', body: { username: 'pat', password: 'password123' } })).code, '2fa_required', 'password untouched');
  r = await pf({ code: en.recoveryCodes[0] }); assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.strictEqual((await pf({ code: en.recoveryCodes[0] })).status, 401, 'a recovery code works once');
  step('with two-factor on, a recovery key alone is not enough: a code (or backup code) is needed too');
  const t2 = (await call('/login', { method: 'POST', body: { username: 'pat', password: 'pats-new-pass-1', code: en.recoveryCodes[1] } })).token;
  assert.strictEqual((await put(t2, { password: 'pats-new-pass-1', recovery: rec() })).code, '2fa_invalid', 'replacing the key needs the code too');
  step('replacing a recovery key needs the two-factor code too');
  assert.ok(patKey && patKey.verifier);

  // ---- email recovery (opt-in; new encryption key) ----
  const user = (n) => Object.values(store.db.users).find((x) => x.username === n);
  const toggle = (token, o) => call('/me/email-recovery', { method: 'PUT', token, body: o });
  const mailTo = (addr) => mailer.outbox.filter((m) => m.to === addr);
  const RESET_SUBJECT = /Reset your Aduna password/;
  const resetMailsTo = (addr) => mailTo(addr).filter((m) => RESET_SUBJECT.test(m.subject));
  const linkIn = (addr) => { const m = [...resetMailsTo(addr)].reverse()[0]; const hit = m && /\/reset#([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/.exec(m.text); return hit && hit[1]; };
  const check = (token) => call('/recover/email/check', { method: 'POST', body: { token } });
  const estart = (username) => call('/recover/email/start', { method: 'POST', body: { username } });
  const wait = () => new Promise((r) => setTimeout(r, 50));

  const eve = await reg('eve', rec());
  assert.strictEqual(eve.user.emailRecovery, false); assert.strictEqual((await call('/me', { token: eve.token })).user.emailRecoveryAvailable, true);
  mailer.outbox.length = 0;
  const startAll = [await estart('eve'), await estart('nobody_at_all'), await estart('noel')]; await wait();
  for (const r2 of startAll) { assert.strictEqual(r2.status, 200); assert.deepStrictEqual({ ok: r2.ok }, { ok: true }); }
  assert.strictEqual(mailer.outbox.length, 0, 'switched off, unknown, or off by default: no mail, same answer');
  step('asking for an email link is answered the same for unknown, switched-off and normal accounts; nothing is sent unless it is on');

  assert.strictEqual((await toggle(eve.token, { enabled: true, password: 'wrong-pass' })).status, 400);
  assert.strictEqual((await toggle(eve.token, { password: 'password123' })).status, 400);
  const unv = await reg('ula', rec()); user('ula').emailVerified = false;
  assert.ok([403, 409].includes((await toggle(unv.token, { enabled: true, password: 'password123' })).status), 'an unverified address cannot be used (the API is locked until it is verified)');
  r = await toggle(eve.token, { enabled: true, password: 'password123' });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.user.emailRecovery, true);
  assert.ok(mailTo('eve@example.com').some((m) => /turned on/.test(m.subject)), 'the owner is told');
  step('turning it on needs the password and a verified address, and emails the owner');

  mailer.outbox.length = 0;
  await estart('Eve'); await wait();
  const e1 = linkIn('eve@example.com'); assert.ok(e1, 'a link with a 43-character token is in the email');
  const mail1 = resetMailsTo('eve@example.com')[0];
  assert.ok(mail1.text.includes(`http://127.0.0.1:${httpServer.address().port}/reset#${e1}`), 'the link points at this site and keeps the token after the #');
  assert.ok(mail1.html.includes(`href="http://127.0.0.1:${httpServer.address().port}/reset#${e1}"`), 'the button carries the same link');
  assert.ok(!/\b\d{8}\b/.test(mail1.subject), 'no code in the subject any more');
  assert.ok(!(await rawDb()).includes(e1), 'only a hash of the token is stored');
  await estart('eve'); await wait();
  assert.strictEqual(resetMailsTo('eve@example.com').length, 1, 'a second request inside a minute sends nothing');
  step('a reset LINK is emailed (256-bit token after the #, only its hash is stored); requests inside the cooldown send nothing');

  r = await check(e1); assert.strictEqual(r.status, 200); assert.deepStrictEqual({ ok: r.ok, username: r.username, twoFactor: r.twoFactor }, { ok: true, username: 'eve', twoFactor: false });
  r = await check(e1); assert.strictEqual(r.status, 200, 'looking at the link (or a mail scanner opening it) does not use it up');
  for (const bad of [undefined, null, '', 'short', 'x'.repeat(43), 'x'.repeat(44), e1.slice(0, 42), e1 + 'a', { a: 1 }, [e1], 12345, '../'.repeat(15)]) {
    r = await check(bad); assert.strictEqual(r.status, 401, JSON.stringify(bad)); assert.strictEqual(r.code, 'reset_link_invalid');
  }
  step('the reset page can ask whether a link is good: yes for the real one (repeatedly), 401 for junk and unknown tokens');

  const ident = () => ({ publicKey: JSON.stringify({ n: crypto.randomBytes(8).toString('hex') }), encPrivKey: blob() });
  const newRec = rec();
  const ef = (o) => call('/recover/email/finish', { method: 'POST', body: { token: e1, newPassword: 'eves-new-password', newKey: true, recovery: newRec, ...ident(), ...o } });
  assert.strictEqual((await ef({ newKey: undefined })).status, 400, 'must confirm the loss of old messages');
  assert.strictEqual((await ef({ recovery: null })).status, 400);
  assert.strictEqual((await ef({ newPassword: 'short' })).status, 400);
  assert.strictEqual((await ef({ publicKey: 5 })).status, 400);
  for (let i = 0; i < 12; i++) { r = await ef({ token: crypto.randomBytes(32).toString('base64url') }); assert.strictEqual(r.status, 401); assert.strictEqual(r.code, 'reset_link_invalid'); }
  assert.strictEqual((await check(e1)).status, 200, 'wrong guesses and refused confirmations never burn the real link');
  step('wrong or missing confirmations are refused; guessing other tokens does nothing to the real link');

  // a newer link replaces the older one
  user('eve').emailReset.sentAt -= 61_000; loginGuardReset();
  mailer.outbox.length = 0; await estart('eve'); await wait();
  const e2 = linkIn('eve@example.com'); assert.ok(e2 && e2 !== e1);
  assert.strictEqual((await check(e1)).status, 401, 'asking again kills the older link'); assert.strictEqual((await ef({})).status, 401);
  const sess = (await call('/login', { method: 'POST', body: { username: 'eve', password: 'password123' } })).token;
  const oldPub = user('eve').publicKey, oldRec = (await rawRecovery('eve'));
  r = await ef({ token: e2 }); assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.ok(r.token && r.user.recoveryKey === true && r.encPrivKey);
  assert.notStrictEqual(user('eve').publicKey, oldPub, 'a new public key replaces the old one');
  assert.strictEqual((await call('/me', { token: sess })).status, 401, 'other sessions are revoked');
  assert.strictEqual((await call('/login', { method: 'POST', body: { username: 'eve', password: 'eves-new-password' } })).status, 200);
  assert.strictEqual((await call('/login', { method: 'POST', body: { username: 'eve', password: 'password123' } })).status, 401);
  assert.strictEqual((await ef({ token: e2 })).status, 401, 'a link works once'); assert.strictEqual((await check(e2)).status, 401);
  assert.deepStrictEqual((await call('/recover/start', { method: 'POST', body: { username: 'eve' } })).blob, newRec.blob, 'the NEW recovery key is the one on file');
  assert.notStrictEqual(oldRec, user('eve').recovery.verifier);
  assert.ok(mailTo('eve@example.com').some((m) => /reset by email/.test(m.subject)), 'the owner is told');
  assert.ok(!user('eve').emailReset, 'the stored link is gone');
  step('email reset: newest link wins, new password, new encryption key + recovery key, old sessions dead, link single-use, owner emailed');

  // two-factor still required, and only the code can still be guessed, so that is what locks out
  const fay = await reg('fay', rec());
  await toggle(fay.token, { enabled: true, password: 'password123' });
  const su2 = await call('/me/2fa/setup', { method: 'POST', token: fay.token, body: { password: 'password123' } });
  const en2 = await call('/me/2fa/enable', { method: 'POST', token: fay.token, body: { code: T.hotp(T.b32decode(su2.secret), T.stepAt(Date.now())) } });
  mailer.outbox.length = 0; await estart('fay'); await wait();
  const ft = linkIn('fay@example.com');
  r = await check(ft); assert.strictEqual(r.twoFactor, true, 'the page learns up front that a code is needed');
  const ff = (o) => call('/recover/email/finish', { method: 'POST', body: { token: ft, newPassword: 'fays-new-password', newKey: true, recovery: rec(), ...ident(), ...o } });
  r = await ff({}); assert.strictEqual(r.code, '2fa_required');
  assert.strictEqual((await check(ft)).status, 200, 'asking for the code did not use the link');
  for (let i = 0; i < 5; i++) { r = await ff({ twoFactorCode: '000000' }); assert.strictEqual(r.code, '2fa_invalid'); }
  r = await ff({ twoFactorCode: en2.recoveryCodes[0] }); assert.strictEqual(r.status, 429, 'five wrong two-factor codes lock the account out, even with a valid link');
  loginGuardReset();
  assert.strictEqual((await ff({ twoFactorCode: en2.recoveryCodes[0] })).status, 200);
  step('with two-factor on, the link alone is not enough; wrong codes lock out like at login');

  // turning it off, and a changed address does not inherit it; either one kills a link already sent
  const gil = await reg('gil', rec());
  await toggle(gil.token, { enabled: true, password: 'password123' });
  r = await toggle(gil.token, { enabled: false, password: 'password123' }); assert.strictEqual(r.user.emailRecovery, false);
  mailer.outbox.length = 0; await estart('gil'); await wait(); assert.strictEqual(resetMailsTo('gil@example.com').length, 0);
  await toggle(gil.token, { enabled: true, password: 'password123' });
  await estart('gil'); await wait(); const gt = linkIn('gil@example.com'); assert.strictEqual((await check(gt)).status, 200);
  await toggle(gil.token, { enabled: false, password: 'password123' });
  assert.strictEqual((await check(gt)).status, 401, 'turning email recovery off kills a link already in the mailbox');
  await toggle(gil.token, { enabled: true, password: 'password123' });
  mailer.outbox.length = 0; await estart('gil'); await wait(); const gt2 = linkIn('gil@example.com'); assert.strictEqual((await check(gt2)).status, 200);
  r = await call('/me', { method: 'PATCH', token: gil.token, body: { email: 'gil2@example.com' } }); assert.strictEqual(r.status, 200);
  assert.strictEqual(r.user.emailRecovery, false, 'changing the address switches it off');
  assert.strictEqual((await check(gt2)).status, 401, 'and a link sent to the old address stops working');
  step('it can be turned off, changing the email address turns it off, and either kills a link already sent');

  // expired link
  const hal = await reg('hal', rec()); await toggle(hal.token, { enabled: true, password: 'password123' });
  mailer.outbox.length = 0; await estart('hal'); await wait();
  const ht = linkIn('hal@example.com'); assert.strictEqual((await check(ht)).status, 200); user('hal').emailReset.expires = Date.now() - 1;
  assert.strictEqual((await check(ht)).status, 401);
  assert.strictEqual((await call('/recover/email/finish', { method: 'POST', body: { token: ht, newPassword: 'hals-new-password', newKey: true, recovery: rec(), ...ident() } })).status, 401);
  step('an expired link is refused');

  // the old code-based API is gone: a username + code can no longer reset anything
  r = await call('/recover/email/finish', { method: 'POST', body: { username: 'hal', code: '12345678', newPassword: 'hals-new-password', newKey: true, recovery: rec(), ...ident() } });
  assert.strictEqual(r.status, 401); assert.strictEqual(r.code, 'reset_link_invalid');
  step('the old username + 8-digit code request no longer works');

  console.log('\nrecovery-test: all passed');
})().then(() => cleanup().then(() => process.exit(0)), async (e) => { console.error(e); await cleanup(); process.exit(1); });
