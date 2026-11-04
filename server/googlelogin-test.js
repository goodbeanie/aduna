// Sign in with Google, the part that needs no database: node server/googlelogin-test.js
const assert = require('assert');
const G = require('./googlelogin');

const step = (m) => console.log('✓', m);
const CFG = { clientId: 'client-123.apps.googleusercontent.com', clientSecret: 'shh' };
const REDIRECT = 'https://aduna.example/api/auth/google/callback';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = (claims) => `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;
const okClaims = (r, over = {}) => ({ iss: 'https://accounts.google.com', aud: CFG.clientId, exp: Math.floor(Date.now() / 1000) + 600, nonce: r.nonce, sub: '1122334455', email: 'Nina@Gmail.com', email_verified: true, name: 'Nina <b>N</b>', ...over });
const fakeFetch = (claimsFor, { ok = true } = {}) => { const calls = []; const f = async (url, init) => { calls.push({ url, init }); return { ok, status: ok ? 200 : 400, json: async () => (ok ? { id_token: claimsFor() } : { error: 'invalid_grant' }) }; }; f.calls = calls; return f; };

(async () => {
  // settings: both values or nothing
  assert.strictEqual(G.settings({}), null);
  assert.strictEqual(G.settings({ GOOGLE_CLIENT_ID: 'a' }), null);
  assert.deepStrictEqual(G.settings({ GOOGLE_CLIENT_ID: ' a ', GOOGLE_CLIENT_SECRET: ' b ' }), { clientId: 'a', clientSecret: 'b' });
  step('Google is off until both the client id and the secret are set');

  // starting: a secret id, a different state, an address at Google that carries the state and nonce
  let g = new G.GoogleLogins({ fetchImpl: null });
  const r = g.start({ native: true });
  assert.ok(/^[A-Za-z0-9_-]{32}$/.test(r.id) && /^[A-Za-z0-9_-]{32}$/.test(r.state) && r.id !== r.state && r.nonce);
  const u = new URL(g.authUrl(CFG, REDIRECT, r));
  assert.strictEqual(u.origin + u.pathname, G.AUTH_URL);
  const q = Object.fromEntries(u.searchParams);
  assert.deepStrictEqual([q.client_id, q.redirect_uri, q.response_type, q.scope, q.state, q.nonce, q.prompt], [CFG.clientId, REDIRECT, 'code', 'openid email profile', r.state, r.nonce, 'select_account']);
  assert.ok(!g.authUrl(CFG, REDIRECT, r).includes(r.id), 'the secret id never appears in the address');
  assert.strictEqual(g.get(r.id), r); assert.strictEqual(g.get('nope'), null); assert.strictEqual(g.get(r.state), null, 'the state is not an id');
  step('start gives a secret id; the address at Google carries only the state');

  // a good sign-in
  const f = fakeFetch(() => idToken(okClaims(r)));
  g = new G.GoogleLogins({ fetchImpl: f }); const a = g.start({});
  f.calls.length = 0;
  const f2 = fakeFetch(() => idToken(okClaims(a))); g.fetchImpl = f2;
  const done = await g.finish({ state: a.state, code: 'abc' }, CFG, REDIRECT);
  assert.strictEqual(done.status, 'ready');
  assert.deepStrictEqual(done.profile, { sub: '1122334455', email: 'nina@gmail.com', name: 'Nina bN/b' });
  const sent = new URLSearchParams(f2.calls[0].init.body);
  assert.deepStrictEqual([f2.calls[0].url, sent.get('code'), sent.get('client_id'), sent.get('client_secret'), sent.get('redirect_uri'), sent.get('grant_type')], [G.TOKEN_URL, 'abc', CFG.clientId, 'shh', REDIRECT, 'authorization_code']);
  step('the code is traded for the identity; the email is tidied and the name cleaned');

  // a state works once
  assert.strictEqual(await g.finish({ state: a.state, code: 'abc' }, CFG, REDIRECT), null);
  assert.strictEqual(await g.finish({ state: 'x'.repeat(32), code: 'abc' }, CFG, REDIRECT), null);
  assert.strictEqual(await g.finish({ state: 5, code: 'abc' }, CFG, REDIRECT), null);
  step('a state works once; unknown or junk states file nothing');

  // each way a token can be wrong
  const bad = async (name, tokenFor, opts) => {
    const gg = new G.GoogleLogins({ fetchImpl: null }); const x = gg.start({});
    gg.fetchImpl = fakeFetch(() => tokenFor(x), opts);
    const out = await gg.finish({ state: x.state, code: 'c' }, CFG, REDIRECT);
    assert.strictEqual(out.status, 'failed', name); assert.ok(out.error, name); assert.strictEqual(out.profile, null, name);
    return out;
  };
  await bad('wrong issuer', (x) => idToken(okClaims(x, { iss: 'https://evil.example' })));
  await bad('wrong audience', (x) => idToken(okClaims(x, { aud: 'someone-elses-app' })));
  await bad('audience list without us', (x) => idToken(okClaims(x, { aud: ['a', 'b'] })));
  await bad('expired', (x) => idToken(okClaims(x, { exp: Math.floor(Date.now() / 1000) - 5 })));
  await bad('wrong nonce (a token made for another request)', (x) => idToken(okClaims(x, { nonce: 'other' })));
  await bad('no subject', (x) => idToken(okClaims(x, { sub: '' })));
  await bad('email not verified', (x) => idToken(okClaims(x, { email_verified: false })));
  await bad('no email', (x) => idToken(okClaims(x, { email: undefined })));
  await bad('junk email', (x) => idToken(okClaims(x, { email: 'not an email' })));
  await bad('not a JWT', () => 'garbage');
  await bad('Google refused the code', () => '', { ok: false });
  const okList = new G.GoogleLogins({ fetchImpl: null }); const y = okList.start({});
  okList.fetchImpl = fakeFetch(() => idToken(okClaims(y, { aud: ['x', CFG.clientId], email_verified: 'true' })));
  assert.strictEqual((await okList.finish({ state: y.state, code: 'c' }, CFG, REDIRECT)).status, 'ready', 'a list that includes us, and "true" as a string, are fine');
  step('wrong issuer, audience, expiry, nonce, subject, unverified or missing email, junk and a refused code all fail');

  // the person said no at Google, or Google sent no code
  g = new G.GoogleLogins({ fetchImpl: null }); let z = g.start({});
  let out = await g.finish({ state: z.state, error: 'access_denied' }, CFG, REDIRECT);
  assert.strictEqual(out.status, 'failed'); assert.ok(/cancelled/i.test(out.error));
  z = g.start({}); out = await g.finish({ state: z.state }, CFG, REDIRECT); assert.strictEqual(out.status, 'failed');
  step('cancelling at Google, or no code, is a failure with a message');

  // a network failure is a failure, not a crash
  g = new G.GoogleLogins({ fetchImpl: async () => { throw new Error('offline'); } }); z = g.start({});
  const quiet = console.error; console.error = () => {};
  out = await g.finish({ state: z.state, code: 'c' }, CFG, REDIRECT); console.error = quiet;
  assert.strictEqual(out.status, 'failed');
  step('an unreachable Google is reported, not thrown');

  // expiry and one-time use
  let t = 1_000_000; g = new G.GoogleLogins({ now: () => t, waitMs: 1000, keepMs: 5000, fetchImpl: null }); z = g.start({});
  t += 1001; assert.strictEqual(g.get(z.id), null); assert.strictEqual(await g.finish({ state: z.state, code: 'c' }, CFG, REDIRECT), null); assert.strictEqual(g.size, 0);
  z = g.start({}); g.fetchImpl = fakeFetch(() => idToken(okClaims(z))); await g.finish({ state: z.state, code: 'c' }, CFG, REDIRECT);
  t += 4000; assert.ok(g.get(z.id), 'a finished request is kept for keepMs, so a sign-up has time'); t += 1500; assert.strictEqual(g.get(z.id), null);
  z = g.start({}); g.consume(z.id); assert.strictEqual(g.get(z.id), null);
  step('requests expire, finished ones last long enough to sign up, and consume removes them');

  // not unbounded
  g = new G.GoogleLogins({ maxPending: 3, fetchImpl: null }); g.start({}); g.start({}); g.start({});
  assert.strictEqual(g.start({}).error, 'busy');
  step('the number of waiting requests is capped');

  console.log('\ngooglelogin-test: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
