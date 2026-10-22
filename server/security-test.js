// Security helpers without a database: node server/security-test.js
const assert = require('assert');
const S = require('./security');
const step = (m) => console.log('✓', m);

// ---- headers ----
{
  const run = (env, req = {}) => { const h = {}; S.securityHeaders(env)({ secure: false, ...req }, { setHeader: (k, v) => { h[k] = v; }, removeHeader: () => {} }, () => {}); return h; };
  const h = run({});
  assert.ok(/style-src 'self'(;|$)/.test(h['Content-Security-Policy']) && !h['Content-Security-Policy'].includes('unsafe-inline'), 'styles only from this site: no unsafe-inline anywhere');
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
  const pp = run({ PAYPAL_CLIENT_ID: 'x' });
  assert.ok(pp['Content-Security-Policy'].includes("script-src 'self' https://*.paypal.com") && pp['Content-Security-Policy'].includes('frame-src https://*.paypal.com'), 'PayPal is allowed only when it is set up');
  assert.ok(!h['Content-Security-Policy'].includes('paypal') && h['Content-Security-Policy'].includes("frame-src 'none'"), 'and not otherwise');
  assert.strictEqual(pp['Cross-Origin-Opener-Policy'], 'same-origin-allow-popups');
  assert.ok(h['Permissions-Policy'].includes('geolocation=()'), 'location stays blocked by default');
  const tx = run({ PAYPAL_CLIENT_ID: 'x', TAX_COLLECT_IN: 'CA' });
  assert.ok(tx['Permissions-Policy'].includes('geolocation=(self)') && tx['Content-Security-Policy'].includes('https://api.bigdatacloud.net'), 'location is allowed only when tax is on');
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

// ---- sessions (log out everywhere) ----
{
  // a small stand-in for jsonwebtoken (HS256 only) so this test needs no packages
  const crypto = require('crypto');
  const b = (x) => Buffer.from(x).toString('base64url');
  const mac = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');
  const fakeJwt = {
    sign(payload, secret, { expiresIn, algorithm } = {}) {
      assert.strictEqual(algorithm, 'HS256', 'signing algorithm is pinned');
      const secs = expiresIn === '30d' ? 30 * 86400 : 0;
      const head = b(JSON.stringify({ alg: algorithm, typ: 'JWT' })), body = b(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + (secs || -10) }));
      return head + '.' + body + '.' + mac(head + '.' + body, secret);
    },
    verify(token, secret, { algorithms } = {}) {
      const [h, p, sig] = String(token).split('.');
      if (!h || !p || !sig) throw new Error('malformed');
      if (!algorithms || !algorithms.includes(JSON.parse(Buffer.from(h, 'base64url')).alg)) throw new Error('algorithm not allowed');
      if (sig !== mac(h + '.' + p, secret)) throw new Error('bad signature');
      const body = JSON.parse(Buffer.from(p, 'base64url'));
      if (body.exp < Date.now() / 1000) throw new Error('expired');
      return body;
    },
  };
  let secret = 'test-secret';
  const sessions = S.createSessions({ jwt: fakeJwt, getSecret: () => secret });
  const users = { a1: { id: 'a1' }, b2: { id: 'b2' } };
  const lookup = (id) => users[id] || null;

  const t1 = sessions.sign(users.a1);
  assert.strictEqual(sessions.user(t1, lookup), users.a1, 'a fresh token works');
  assert.strictEqual(sessions.user(sessions.sign(users.b2), lookup), users.b2, 'and belongs to its own account');

  // tokens made before this feature existed carry no version and still work (version 0)
  const legacy = fakeJwt.sign({ uid: 'a1' }, secret, { expiresIn: '30d', algorithm: 'HS256' });
  assert.strictEqual(sessions.user(legacy, lookup), users.a1, 'an old token without a version still works until revoked');

  // revoking: every token issued so far stops working, a new one works, other accounts are untouched
  const other = sessions.sign(users.b2);
  assert.strictEqual(sessions.bump(users.a1), 1, 'version goes up');
  assert.strictEqual(sessions.user(t1, lookup), null, 'the token from before is revoked');
  assert.strictEqual(sessions.user(legacy, lookup), null, 'an old token without a version is revoked too');
  const t2 = sessions.sign(users.a1);
  assert.strictEqual(sessions.user(t2, lookup), users.a1, 'the new token works');
  assert.strictEqual(sessions.user(other, lookup), users.b2, 'other accounts keep their sessions');
  sessions.bump(users.a1);
  assert.strictEqual(sessions.user(t2, lookup), null, 'a second revocation revokes the first replacement');

  // junk, tampering, expiry, unknown or deleted accounts, other algorithms
  for (const bad of [undefined, null, '', 'abc', 'a.b.c', 42, {}]) assert.strictEqual(sessions.user(bad, lookup), null, 'junk: ' + String(bad));
  const good = sessions.sign(users.b2);
  const [h, p, sig] = good.split('.');
  const forgedBody = b(JSON.stringify({ uid: 'a1', tv: 2, exp: Math.floor(Date.now() / 1000) + 1000 }));
  assert.strictEqual(sessions.user(h + '.' + forgedBody + '.' + sig, lookup), null, 'a changed payload fails the signature');
  assert.strictEqual(sessions.user(good, () => null), null, 'deleted account');
  const none = b(JSON.stringify({ alg: 'none', typ: 'JWT' })) + '.' + p + '.';
  assert.strictEqual(sessions.user(none, lookup), null, 'alg:none is refused');
  const hs512 = b(JSON.stringify({ alg: 'HS512', typ: 'JWT' })) + '.' + p + '.' + sig;
  assert.strictEqual(sessions.user(hs512, lookup), null, 'other algorithms are refused');
  assert.strictEqual(sessions.user(fakeJwt.sign({ uid: 'b2', tv: 0 }, secret, { expiresIn: 'x', algorithm: 'HS256' }), lookup), null, 'expired token');
  secret = 'rotated';
  assert.strictEqual(sessions.user(good, lookup), null, 'a different server secret invalidates everything');
  step('sessions: version in the token, old tokens survive the upgrade, bump revokes only that account, junk/forged/expired/alg:none refused');
}

// ---- session cookie, origin check, CSRF guard ----
{
  // parsing
  const c = S.parseCookies('a=1; __Host-aduna_session=tok.en.x; b=2=3; a=ignored; junk; =x');
  assert.strictEqual(c.a, '1', 'the first value wins'); assert.strictEqual(c['__Host-aduna_session'], 'tok.en.x'); assert.strictEqual(c.b, '2=3', 'values may contain =');
  assert.strictEqual(c.junk, undefined); assert.strictEqual(S.parseCookies(undefined).anything, undefined); { const t = S.parseCookies('__proto__=x; constructor=y'); assert.strictEqual(Object.getPrototypeOf(t), null, 'plain data, no prototype'); assert.strictEqual(({}).x, undefined, 'nothing leaks into other objects'); }
  // https detection
  assert.strictEqual(S.isSecure({ 'x-forwarded-proto': 'https' }), true); assert.strictEqual(S.isSecure({ 'x-forwarded-proto': 'https,http' }), true);
  assert.strictEqual(S.isSecure({ 'x-forwarded-proto': 'http' }), false); assert.strictEqual(S.isSecure({}), false); assert.strictEqual(S.isSecure({}, true), true, 'direct TLS');
  assert.strictEqual(S.isSecure({ 'x-forwarded-proto': 'https' }, false, false), false, 'proxy header ignored when the proxy is not trusted');
  // the cookie we set
  const sec = S.sessionCookie('T', { secure: true }), plain = S.sessionCookie('T');
  for (const a of ['__Host-aduna_session=T', 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Secure', 'Max-Age=2592000']) assert.ok(sec.includes(a), 'https cookie has ' + a);
  assert.ok(!sec.includes('Domain'), '__Host- cookies must not have a Domain');
  assert.ok(plain.startsWith('aduna_session=T') && plain.includes('HttpOnly') && plain.includes('SameSite=Strict') && !plain.includes('Secure'), 'http (dev) cookie: plain name, no Secure');
  assert.ok(S.clearedSessionCookies({ secure: true }).every((x) => x.includes('Max-Age=0')) && S.clearedSessionCookies().length === 2, 'both names cleared');
  // reading: only the name that matches the connection counts
  assert.strictEqual(S.readSessionCookie({ cookie: '__Host-aduna_session=good' }, true), 'good');
  assert.strictEqual(S.readSessionCookie({ cookie: 'aduna_session=planted' }, true), '', 'over https a plain cookie (plantable from a sibling subdomain) is ignored');
  assert.strictEqual(S.readSessionCookie({ cookie: 'aduna_session=dev' }, false), 'dev');
  assert.strictEqual(S.readSessionCookie({ cookie: '__Host-aduna_session=x' }, false), '');
  assert.strictEqual(S.readSessionCookie({}, true), '');
  // origin
  assert.strictEqual(S.originAllowed(undefined, 'aduna.onrender.com'), true, 'no Origin: not a browser cross-site request');
  assert.strictEqual(S.originAllowed('https://aduna.onrender.com', 'aduna.onrender.com'), true);
  assert.strictEqual(S.originAllowed('http://localhost:3000', 'localhost:3000'), true, 'ports count and match');
  for (const bad of ['https://evil.example', 'https://aduna.onrender.com.evil.example', 'https://evil.example/aduna.onrender.com', 'null', 'garbage', 'https://aduna.onrender.com:8443'])
    assert.strictEqual(S.originAllowed(bad, 'aduna.onrender.com'), false, bad);
  assert.strictEqual(S.originAllowed('https://aduna.onrender.com', ''), false, 'no host to compare with');
  // csrf guard
  const run = (req) => { let out = 'next', code; const res = { status(n) { code = n; return this; }, json() { out = 'blocked'; } }; S.csrfGuard()({ method: 'POST', headers: {}, ...req }, res, () => {}); return out === 'blocked' ? code : 'ok'; };
  const jar = { cookie: '__Host-aduna_session=t', host: 'aduna.onrender.com' };
  assert.strictEqual(run({ headers: { ...jar, origin: 'https://aduna.onrender.com' } }), 'ok', 'same-site browser request');
  assert.strictEqual(run({ headers: { ...jar, origin: 'https://evil.example' } }), 403, 'cross-site POST with the cookie is refused');
  assert.strictEqual(run({ headers: { ...jar, origin: 'null' } }), 403, 'sandboxed-frame Origin: null is refused');
  assert.strictEqual(run({ headers: { ...jar, 'sec-fetch-site': 'cross-site' } }), 403, 'Sec-Fetch-Site says cross-site');
  assert.strictEqual(run({ headers: { ...jar, origin: 'https://aduna.onrender.com', 'sec-fetch-site': 'same-origin' } }), 'ok');
  assert.strictEqual(run({ headers: { ...jar } }), 'ok', 'no Origin (not a browser): allowed');
  assert.strictEqual(run({ method: 'GET', headers: { ...jar, origin: 'https://evil.example' } }), 'ok', 'reads are not guarded (nothing changes)');
  assert.strictEqual(run({ headers: { host: 'aduna.onrender.com', origin: 'https://evil.example', authorization: 'Bearer x' } }), 'ok', 'no cookie (Stripe webhook, scripts, header logins): nothing to forge');
  step('session cookie: httpOnly + SameSite=Strict + __Host- over https, ignores planted plain cookie; Origin/CSRF guard refuses cross-site writes');
}
// ---- rate limits survive a restart (dump / restore) ----
{
  const t0 = 1_700_000_000_000;
  // a lockout that was in force is still in force after the state goes through JSON and into a new instance
  const g = new S.LoginGuard();
  for (let i = 0; i < 5; i++) g.fail('Mia', '1.2.3.4', t0 + i * 1000);
  assert.strictEqual(g.check('mia', '1.2.3.4', t0 + 10_000).blocked, true);
  const saved = JSON.parse(JSON.stringify(g.dump(t0 + 10_000)));
  const g2 = new S.LoginGuard();
  g2.restore(saved, t0 + 60_000); // "the server came back a minute later"
  const c = g2.check('mia', '1.2.3.4', t0 + 60_000);
  assert.ok(c.blocked && c.retryAfterSec > 0 && c.retryAfterSec <= 15 * 60, 'still locked, with the right time left: ' + JSON.stringify(c));
  assert.strictEqual(g2.check('mia', '9.9.9.9', t0 + 60_000).blocked, false, 'other addresses are not affected (unless 25 overall)');
  assert.strictEqual(new S.LoginGuard().check('mia', '1.2.3.4', t0 + 60_000).blocked, false, 'a fresh instance without restore forgets (what used to happen)');
  const g3 = new S.LoginGuard(); g3.restore(saved, t0 + 16 * 60_000);
  assert.strictEqual(g3.check('mia', '1.2.3.4', t0 + 16 * 60_000).blocked, false, 'a lockout that ran out while the server was off is gone');
  assert.deepStrictEqual(g3.dump(t0 + 16 * 60_000), { pair: [], name: [] }, 'and expired entries are not kept');
  // the per-username counter (spread-out guessing) survives too
  const spread = new S.LoginGuard();
  for (let i = 0; i < 25; i++) spread.fail('nia', '10.0.0.' + i, t0);
  const sp2 = new S.LoginGuard(); sp2.restore(JSON.parse(JSON.stringify(spread.dump(t0))), t0 + 1000);
  assert.strictEqual(sp2.check('nia', '10.9.9.9', t0 + 1000).blocked, true, 'the 25-from-anywhere lock survives');

  // RateWindow
  const w = new S.RateWindow(3, 60_000);
  for (let i = 0; i < 3; i++) assert.ok(w.allow('ip', t0 + i));
  assert.ok(!w.allow('ip', t0 + 10));
  const w2 = new S.RateWindow(3, 60_000); w2.restore(JSON.parse(JSON.stringify(w.dump(t0 + 10))), t0 + 20_000);
  assert.ok(!w2.allow('ip', t0 + 20_000), 'still over the limit after a restart');
  assert.ok(w2.allow('ip', t0 + 61_000), 'and free again once the window has passed');
  assert.ok(w2.allow('other', t0 + 20_000), 'other keys unaffected');

  // saved data is untrusted: junk is skipped, the future is clamped, sizes are capped, nothing throws
  const junk = new S.RateWindow(2, 60_000);
  junk.restore([null, 5, ['k'], ['ok', 'nope'], [123, [t0]], ['x'.repeat(301), [t0]], ['future', [t0 + 10 ** 12, t0 + 10 ** 12]], ['nan', [NaN, 'a', null, t0]], ['big', Array(5000).fill(t0)]], t0);
  junk.restore('not a list', t0); junk.restore(undefined, t0); junk.restore({}, t0);
  assert.deepStrictEqual([...junk.hits.keys()].sort(), ['big', 'future', 'nan'], 'only well-formed rows are kept');
  assert.ok(junk.hits.get('big').length <= 1000, 'per-key size capped');
  assert.ok(junk.hits.get('future').every((t) => t <= t0), 'a time in the future is clamped to now, so a bad clock cannot lock anyone out for longer than the window');
  const gj = new S.LoginGuard(); gj.restore('x', t0); gj.restore(null, t0); gj.restore({ pair: 5, name: [[1]] }, t0);
  assert.deepStrictEqual(gj.dump(t0), { pair: [], name: [] });
  const big = new S.RateWindow(1, 60_000); big.restore(Array.from({ length: 30000 }, (_, i) => ['k' + i, [t0]]), t0);
  assert.ok(big.hits.size <= 20000, 'number of keys capped');

  // onChange fires when something changes, and only then
  let n = 0; const oc = new S.LoginGuard(); oc.onChange = () => n++;
  oc.check('a', 'b'); assert.strictEqual(n, 0, 'checking changes nothing');
  oc.fail('a', 'b'); assert.strictEqual(n, 1);
  oc.success('a', 'b'); assert.strictEqual(n, 2);
  oc.success('a', 'b'); assert.strictEqual(n, 2, 'clearing nothing is not a change');
  const ow = new S.RateWindow(1, 1000); ow.onChange = () => n++;
  ow.allow('k'); assert.strictEqual(n, 3); ow.allow('k'); assert.strictEqual(n, 3, 'a refused hit changes nothing');
  step('rate limits: dump/restore keeps lockouts across a restart, drops expired ones, distrusts saved data, change hook');
}

// ---- password-reset links ----
{
  const t = S.newResetToken(), t2 = S.newResetToken();
  assert.ok(S.validResetToken(t) && t.length === 43, '256 random bits, url safe');
  assert.notStrictEqual(t, t2);
  for (const bad of [undefined, null, 42, '', 'short', t + 'x', t.slice(1), t.replace(/.$/, '+'), t.replace(/.$/, '/'), t.replace(/.$/, ' '), { toString: () => t }, [t]]) assert.ok(!S.validResetToken(bad), 'refused: ' + JSON.stringify(bad));
  assert.strictEqual(S.resetTokenHash(t).length, 64); assert.notStrictEqual(S.resetTokenHash(t), S.resetTokenHash(t2));
  assert.strictEqual(S.resetTokenHash(t), S.resetTokenHash(t), 'same token, same hash');
  assert.ok(!S.resetTokenHash(t).includes(t), 'the stored value does not contain the token');
  assert.strictEqual(S.resetLink('https://aduna.example', t), `https://aduna.example/reset#${t}`, 'the secret is after the # so it never reaches a server log or Referer');
  step('reset links: unguessable url-safe token, only a hash is stored, the token sits after the #');

  const so = (env, req) => S.siteOrigin({ env, ...req });
  assert.strictEqual(so({ PUBLIC_URL: 'https://chat.example.com/' }, { host: 'evil.test' }), 'https://chat.example.com', 'PUBLIC_URL wins, trailing slash dropped');
  assert.strictEqual(so({ RENDER_EXTERNAL_URL: 'https://aduna-x.onrender.com' }, { host: 'evil.test' }), 'https://aduna-x.onrender.com');
  assert.strictEqual(so({ NODE_ENV: 'production' }, { protocol: 'https', host: 'evil.test' }), 'https://aduna.onrender.com', 'in production a forged Host header is never used');
  assert.strictEqual(so({ NODE_ENV: 'production', PUBLIC_URL: 'javascript:alert(1)' }, { host: 'evil.test' }), 'https://aduna.onrender.com', 'junk PUBLIC_URL ignored');
  assert.strictEqual(so({ PUBLIC_URL: 'https://a.example/path?x=1' }, { host: 'h' }), 'http://h', 'a PUBLIC_URL with a path is not a bare origin: ignored (outside production the request is used)');
  assert.strictEqual(so({ NODE_ENV: 'test' }, { protocol: 'http', host: '127.0.0.1:3000' }), 'http://127.0.0.1:3000', 'local dev / tests use the request');
  step('reset links point at PUBLIC_URL / RENDER_EXTERNAL_URL, never at a forged Host header in production');
}

console.log('\nAll security checks passed.');
