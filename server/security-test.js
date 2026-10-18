// Security helpers without a database: node server/security-test.js
const assert = require('assert');
const S = require('./security');
const step = (m) => console.log('✓', m);

// ---- headers ----
{
  const run = (env, req = {}) => { const h = {}; S.securityHeaders(env)({ secure: false, ...req }, { setHeader: (k, v) => { h[k] = v; }, removeHeader: () => {} }, () => {}); return h; };
  const h = run({});
  assert.ok(h['Content-Security-Policy'].includes("script-src 'self'") && !h['Content-Security-Policy'].includes("script-src 'self' 'unsafe"), 'scripts only from this site');
  assert.ok(h['Content-Security-Policy'].includes("frame-ancestors 'none'") && h['X-Frame-Options'] === 'DENY');
  assert.ok(h['Content-Security-Policy'].includes("object-src 'none'") && h['Content-Security-Policy'].includes("base-uri 'self'"));
  assert.ok(h['Content-Security-Policy'].includes('https://*.giphy.com'), 'GIFs still load');
  assert.strictEqual(h['X-Content-Type-Options'], 'nosniff');
  assert.ok(h['Permissions-Policy'].includes('camera=(self)') && h['Permissions-Policy'].includes('microphone=(self)'), 'calls keep camera and mic');
  assert.strictEqual(h['Strict-Transport-Security'], undefined, 'no HSTS over plain http');
  assert.ok(run({}, { secure: true })['Strict-Transport-Security'].includes('max-age'), 'HSTS over https');
  assert.ok(run({ CSP_MODE: 'report-only' })['Content-Security-Policy-Report-Only'] && !run({ CSP_MODE: 'report-only' })['Content-Security-Policy']);
  assert.strictEqual(run({ CSP_MODE: 'off' })['Content-Security-Policy'], undefined);
  step('headers: strict CSP, no framing, nosniff, permissions for calls, HSTS only on https, CSP_MODE switch');
}

// ---- email ----
{
  for (const ok of ['a@b.co', 'First.Last@Example.COM', ' me+tag@sub.example.org ', 'x_y-z@ex-ample.io']) assert.ok(S.cleanEmail(ok), ok);
  assert.strictEqual(S.cleanEmail(' First.Last@Example.COM '), 'first.last@example.com', 'trimmed and lowercased');
  for (const bad of ['', 'plain', '@x.com', 'a@', 'a@b', 'a@b.c', 'a b@c.com', 'a@b..com', '.a@b.com', 'a.@b.com', 'a..b@c.com', 'a@-b.com', 'a@b.com.', '<s>@b.com', 'a@b.com,c@d.com', 'a@b.com;c@d.com', 'x'.repeat(65) + '@b.com', 'a@' + 'b'.repeat(250) + '.com', null, undefined, 42, {}])
    assert.strictEqual(S.cleanEmail(bad), null, String(bad).slice(0, 30));
  assert.strictEqual(S.emailKey('John.Doe+spam@Gmail.com'), 'johndoe@gmail.com', 'Gmail dots and +tags are one mailbox');
  assert.strictEqual(S.emailKey('johndoe@googlemail.com'), 'johndoe@gmail.com');
  assert.strictEqual(S.emailKey('a.b+x@example.com'), 'a.b@example.com', 'dots matter elsewhere, +tag does not');
  assert.notStrictEqual(S.emailKey('a@x.com'), S.emailKey('a@y.com'));
  step('email: plausible addresses only, normalised; aliases of one mailbox share a key');
}

// ---- passwords ----
{
  assert.ok(S.weakPassword('password123'));
  assert.ok(S.weakPassword('Password123'), 'case does not rescue a common password');
  assert.ok(S.weakPassword('aaaaaaaaaa'));
  assert.ok(S.weakPassword('abababab'), 'too few different characters');
  assert.ok(S.weakPassword('myalice2026', { username: 'alice' }), 'contains username');
  assert.ok(S.weakPassword('bobsmith-rocks', { email: 'bobsmith@x.com' }), 'contains email name');
  assert.strictEqual(S.weakPassword('correct horse battery'), null);
  assert.strictEqual(S.weakPassword('T7#kq9-lemon', { username: 'alice', email: 'a@b.co' }), null);
  assert.strictEqual(S.weakPassword('xay12345', { username: 'ab' }), null, 'very short usernames are not matched');
  step('passwords: common, repetitive and username/email-based ones refused; passphrases fine');
}

// ---- rate window ----
{
  const r = new S.RateWindow(3, 1000);
  assert.deepStrictEqual([r.allow('ip', 0), r.allow('ip', 1), r.allow('ip', 2), r.allow('ip', 3)], [true, true, true, false]);
  assert.strictEqual(r.allow('other', 3), true, 'per key');
  assert.strictEqual(r.allow('ip', 1001), true, 'frees up after the window');
  step('rate window: limit per key, resets after the window');
}

// ---- login lockout ----
{
  const g = new S.LoginGuard();
  const T = 1_000_000;
  for (let i = 0; i < 4; i++) g.fail('Alice', '1.1.1.1', T + i);
  assert.strictEqual(g.check('alice', '1.1.1.1', T + 10).blocked, false, '4 failures: still open');
  g.fail('ALICE', '1.1.1.1', T + 5);
  const lock = g.check('alice', '1.1.1.1', T + 10);
  assert.ok(lock.blocked && lock.retryAfterSec > 800 && lock.retryAfterSec <= 900, 'locked for about 15 minutes: ' + lock.retryAfterSec);
  assert.strictEqual(g.check('alice', '2.2.2.2', T + 10).blocked, false, 'a stranger on another address cannot lock you out of your own');
  assert.strictEqual(g.check('alice', '1.1.1.1', T + 16 * 60_000).blocked, false, 'unlocks after 15 minutes');
  // a correct password clears the pair
  const h = new S.LoginGuard(); for (let i = 0; i < 4; i++) h.fail('bob', '3.3.3.3', T + i); h.success('bob', '3.3.3.3');
  h.fail('bob', '3.3.3.3', T + 10); assert.strictEqual(h.check('bob', '3.3.3.3', T + 11).blocked, false, 'success resets the count');
  // spread-out guessing: 25 failures from different addresses lock the name itself
  const d = new S.LoginGuard(); for (let i = 0; i < 25; i++) d.fail('carol', '9.9.9.' + i, T + i);
  assert.strictEqual(d.check('carol', '8.8.8.8', T + 30).blocked, true, 'distributed guessing locks the username');
  assert.strictEqual(d.check('dave', '8.8.8.8', T + 30).blocked, false, 'other usernames unaffected');
  step('login lockout: 5 per username+address, 25 per username overall, 15 minutes, cleared by success');
}
console.log('\nAll security checks passed.');
