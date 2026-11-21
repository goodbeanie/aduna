// Terms of Service agreement: sign-up ticks, the agree screen for accounts that have not accepted, and a change of version. node server/terms-test.js
const assert = require('assert');
const { cleanup } = require('./test-env');
const { httpServer, ready } = require('./index');
const terms = require('./terms');
let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const blob = { salt: 'a', iv: 'b', data: 'c' };
const reg = (username, extra = {}) => call('/register', { method: 'POST', body: { username, email: username + '@example.com', password: 'password123', publicKey: 'pk' + username, encPrivKey: blob, ...extra } });
ready.then(() => httpServer.listen(0, async () => {
  base = 'http://127.0.0.1:' + httpServer.address().port;
  try {
    const store = require('./db');

    // the sign-up page sends both ticks: the account starts out agreed
    const ticked = await reg('terms_ticked', { acceptTerms: true, over13: true });
    assert.strictEqual(ticked.status, 200); assert.strictEqual(ticked.user.terms.needed, false); assert.strictEqual(ticked.user.terms.version, terms.VERSION);
    assert.strictEqual(store.db.users[ticked.user.id].termsAccepted.version, terms.VERSION);
    console.log('✓ sign-up with both ticks starts out agreed');

    // one tick is not enough, and a caller that sends neither gets the agree screen
    const half = await reg('terms_half', { acceptTerms: true });
    assert.strictEqual(half.user.terms.needed, true); console.log('✓ the terms tick alone does not count');
    const bare = await reg('terms_bare');
    assert.strictEqual(bare.user.terms.needed, true); assert.ok(!store.db.users[bare.user.id].termsAccepted); console.log('✓ an account made without the ticks has to agree on first open');

    // /me tells the app
    let me = await call('/me', { token: bare.token });
    assert.strictEqual(me.user.terms.needed, true); console.log('✓ /me says the terms are needed');

    // agreeing
    let r = await call('/me/terms/accept', { method: 'POST', body: { version: terms.VERSION } });
    assert.strictEqual(r.status, 401, 'needs a signed-in person');
    r = await call('/me/terms/accept', { method: 'POST', token: bare.token, body: { version: 'old' } });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.code, 'terms_changed'); assert.strictEqual(r.user.terms.needed, true);
    console.log('✓ a wrong version is refused and nothing is saved');
    r = await call('/me/terms/accept', { method: 'POST', token: bare.token, body: {} });
    assert.strictEqual(r.status, 409); console.log('✓ no version is refused too');
    r = await call('/me/terms/accept', { method: 'POST', token: bare.token, body: { version: terms.VERSION } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.user.terms.needed, false);
    const at = store.db.users[bare.user.id].termsAccepted.at;
    r = await call('/me/terms/accept', { method: 'POST', token: bare.token, body: { version: terms.VERSION } });
    assert.strictEqual(r.status, 200); assert.strictEqual(store.db.users[bare.user.id].termsAccepted.at, at, 'pressing it twice keeps the first time');
    me = await call('/me', { token: bare.token }); assert.strictEqual(me.user.terms.needed, false);
    console.log('✓ agreeing saves the version once and the app opens');

    // a new version asks everyone again
    const u = store.db.users[ticked.user.id];
    const was = u.termsAccepted.version;
    u.termsAccepted = { version: '2000-01-01', at: 1 };
    me = await call('/me', { token: ticked.token }); assert.strictEqual(me.user.terms.needed, true);
    u.termsAccepted = { version: was, at: 1 };
    assert.strictEqual((await call('/me', { token: ticked.token })).user.terms.needed, false);
    console.log('✓ an account that agreed to an older version is asked again');

    // bots are never asked
    assert.strictEqual(terms.needed({ bot: true }), false); console.log('✓ bot accounts are skipped');
    console.log('ALL PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  await cleanup();
  process.exit();
}));
