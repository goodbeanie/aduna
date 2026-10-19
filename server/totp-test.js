// Two-factor helpers without a database: node server/totp-test.js
const assert = require('assert');
const T = require('./totp');
const step = (m) => console.log('✓', m);

// RFC 6238 appendix B (SHA-1), the 8-digit values cut to 6 digits
{
  const key = Buffer.from('12345678901234567890');
  for (const [t, want] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037']]) {
    assert.strictEqual(T.hotp(key, Math.floor(t / 30), 8), want, 'RFC vector at ' + t);
    assert.strictEqual(T.hotp(key, Math.floor(t / 30)), want.slice(-6));
  }
  step('totp: matches the RFC 6238 test vectors');
}
{
  const raw = Buffer.from('12345678901234567890');
  assert.strictEqual(T.b32encode(raw), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'RFC base32 form');
  assert.deepStrictEqual(T.b32decode('gezd gnbv-GY3TQOJQGEZDGNBVGY3TQOJQ'), raw, 'spaces, dashes and case are ignored');
  for (let n = 0; n < 40; n++) { const b = require('crypto').randomBytes(n); assert.deepStrictEqual(T.b32decode(T.b32encode(b)), b); }
  assert.throws(() => T.b32decode('not*base32'));
  assert.strictEqual(T.newSecret().length, 32);
  step('base32: round-trips, tolerant of formatting');
}
{
  const secret = T.newSecret(), key = T.b32decode(secret), now = 1_700_000_000_000, s = T.stepAt(now);
  const code = T.hotp(key, s);
  assert.strictEqual(T.verify(secret, code, { now }), s, 'current code accepted');
  assert.strictEqual(T.verify(secret, T.hotp(key, s - 1), { now }), s - 1, 'one step late accepted');
  assert.strictEqual(T.verify(secret, T.hotp(key, s + 1), { now }), s + 1, 'one step early accepted');
  assert.strictEqual(T.verify(secret, T.hotp(key, s - 3), { now }), null, 'too old refused');
  assert.strictEqual(T.verify(secret, T.hotp(key, s + 3), { now }), null, 'too new refused');
  assert.strictEqual(T.verify(secret, code, { now, lastStep: s }), null, 'a code that was already used cannot be replayed');
  assert.strictEqual(T.verify(secret, T.hotp(key, s - 1), { now, lastStep: s }), null, 'an older step than the last used is refused');
  assert.strictEqual(T.verify(secret, T.hotp(key, s + 1), { now, lastStep: s }), s + 1, 'a newer one still works');
  assert.strictEqual(T.verify(secret, code.replace(/^./, (d) => String((Number(d) + 1) % 10)), { now }), null, 'wrong code');
  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, 123456.5, {}]) assert.strictEqual(T.verify(secret, bad, { now }), null, String(bad));
  assert.strictEqual(T.verify('***', code, { now }), null, 'a broken secret never matches');
  assert.strictEqual(T.verify(secret, code.slice(0, 3) + ' ' + code.slice(3), { now }), s, 'a space in the middle is fine');
  step('verify: drift window, replay protection, junk refused');
}
{
  const u = T.otpauthUri({ secret: 'ABCDEFGH', account: 'ann smith', issuer: 'Aduna' });
  assert.strictEqual(u, 'otpauth://totp/Aduna:ann%20smith?secret=ABCDEFGH&issuer=Aduna&algorithm=SHA1&digits=6&period=30');
  step('otpauth link');
}
{
  const codes = T.newRecoveryCodes();
  assert.strictEqual(codes.length, 8);
  assert.strictEqual(new Set(codes).size, 8, 'unique');
  for (const c of codes) assert.ok(/^[a-z2-7]{5}-[a-z2-7]{5}$/.test(c), c);
  assert.strictEqual(T.hashRecovery(codes[0]), T.hashRecovery(codes[0].toUpperCase().replace('-', ' ')), 'case, dash and spaces do not matter');
  assert.notStrictEqual(T.hashRecovery(codes[0]), T.hashRecovery(codes[1]));
  assert.ok(!codes.some((c) => /^\d{6}$/.test(T.normRecovery(c))), 'never looks like an app code');
  step('recovery codes: format, uniqueness, hashing');
}
console.log('\nAll two-factor checks passed.');
