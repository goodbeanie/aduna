// First-time setup after sign-up: language + choosing whether to join the Aduna server. node server/setup-test.js
const assert = require('assert');
const { cleanup } = require('./test-env');
const { httpServer, ready } = require('./index');
let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const blob = { salt: 'a', iv: 'b', data: 'c' };
const reg = (username, extra = {}) => call('/register', { method: 'POST', body: { username, email: username + '@example.com', password: 'password123', publicKey: 'pk' + username, encPrivKey: blob, ...extra } });
const inAduna = (s, u) => s.members.includes(u.id);
ready.then(() => httpServer.listen(0, async () => {
  base = 'http://127.0.0.1:' + httpServer.address().port;
  try {
    const owner = await reg('setup_owner');
    const made = await call('/servers', { method: 'POST', token: owner.token, body: { name: 'Aduna' } });
    const store = require('./db');
    const aduna = () => store.db.servers[made.server.id];
    assert.strictEqual((await call('/auth-options')).adunaServer, true); console.log('✓ the setup screen can tell an Aduna server exists');

    // the app's sign-up: asks for setup, joins nothing yet
    let a = await reg('setup_a', { setup: true, lang: 'fr' });
    assert.strictEqual(a.status, 200); assert.strictEqual(a.user.needsSetup, true); assert.strictEqual(a.user.lang, 'fr');
    assert.ok(!inAduna(aduna(), a.user), 'not joined before the choice'); console.log('✓ sign-up with setup: language kept, nothing joined yet');

    // other callers (bots, old clients) keep the old behaviour
    const old = await reg('setup_old');
    assert.strictEqual(old.user.needsSetup, false); assert.ok(inAduna(aduna(), old.user)); console.log('✓ sign-up without setup still joins Aduna straight away');

    // unticked: language saved, not joined
    let r = await call('/me/setup', { method: 'POST', token: a.token, body: { lang: 'es', joinAduna: false } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.user.lang, 'es'); assert.strictEqual(r.user.needsSetup, false); assert.ok(!inAduna(aduna(), a.user));
    console.log('✓ setup with the box unticked: language saved, Aduna not joined');
    r = await call('/me/setup', { method: 'POST', token: a.token, body: { lang: 'en', joinAduna: true } });
    assert.strictEqual(r.user.lang, 'es'); assert.ok(!inAduna(aduna(), a.user)); console.log('✓ setup only runs once');

    // ticked: joined
    const b = await reg('setup_b', { setup: true });
    assert.strictEqual(b.user.lang, 'en', 'unknown/missing language falls back to English');
    r = await call('/me/setup', { method: 'POST', token: b.token, body: { lang: 'fr', joinAduna: true } });
    assert.strictEqual(r.user.lang, 'fr'); assert.ok(inAduna(aduna(), b.user)); console.log('✓ setup with the box ticked: joins Aduna');

    // bad language is ignored, and it can be changed later in settings
    const c = await reg('setup_c', { setup: true, lang: 'xx' });
    assert.strictEqual(c.user.lang, 'en'); console.log('✓ a language we do not have becomes English');
    r = await call('/me', { method: 'PATCH', token: b.token, body: { lang: 'es' } });
    assert.strictEqual(r.user.lang, 'es'); console.log('✓ language can be changed in settings');
    r = await call('/me', { method: 'PATCH', token: b.token, body: { lang: 'klingon' } });
    assert.strictEqual(r.user.lang, 'es'); console.log('✓ an unknown language in settings is ignored');
    const me = await call('/me', { token: b.token }); assert.strictEqual(me.user.lang, 'es'); console.log('✓ the language is there on the next visit');
    console.log('ALL PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  await cleanup();
  process.exit();
}));
