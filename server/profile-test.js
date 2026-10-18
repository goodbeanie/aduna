// Profile tests (username cooldown, links, logo avatar): node server/profile-test.js
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { webcrypto: crypto } = require('crypto');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aduna-'));
const { cleanup } = require('./test-env');
const { httpServer, ready } = require('./index');
let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const blob = { salt: 'a', iv: 'b', data: 'c' };
const reg = (username) => call('/register', { method: 'POST', body: { username, email: username + '@example.com', password: 'password123', publicKey: 'pk' + username, encPrivKey: blob } });
ready.then(() => httpServer.listen(0, async () => {
  base = 'http://127.0.0.1:' + httpServer.address().port;
  try {
    const a = await reg('alice_x'), b = await reg('bob_x');
    const t = a.token;
    // links
    let r = await call('/me', { method: 'PATCH', token: t, body: { links: [{ label: 'Twitter', url: 'twitter.com/alice' }, { label: '', url: 'https://www.github.com/alice' }] } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.user.links[0].url, 'https://twitter.com/alice'); assert.strictEqual(r.user.links[1].label, 'github.com'); console.log('✓ links saved + normalised');
    r = await call('/me', { method: 'PATCH', token: t, body: { links: [{ url: 'javascript:alert(1)' }] } });
    assert.strictEqual(r.status, 400); console.log('✓ javascript: link rejected');
    r = await call('/me', { method: 'PATCH', token: t, body: { links: Array(6).fill({ url: 'a.com' }) } });
    assert.strictEqual(r.status, 400); console.log('✓ >5 links rejected');
    // logo avatar
    r = await call('/me', { method: 'PATCH', token: t, body: { avatarLogo: true } });
    assert.strictEqual(r.user.avatarLogo, true); console.log('✓ logo avatar flag');
    // username: bad, taken, ok, cooldown
    r = await call('/me', { method: 'PATCH', token: t, body: { username: 'a!' } }); assert.strictEqual(r.status, 400); console.log('✓ bad username rejected');
    r = await call('/me', { method: 'PATCH', token: t, body: { username: 'BOB_X' } }); assert.strictEqual(r.status, 409); console.log('✓ taken username rejected (case-insensitive)');
    r = await call('/me', { method: 'PATCH', token: t, body: { username: 'alice_new', displayName: 'alice_x' } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.user.username, 'alice_new'); assert.strictEqual(r.user.displayName, 'alice_new'); assert.ok(r.user.usernameChangedAt); console.log('✓ username changed, default display name followed it');
    r = await call('/me', { method: 'PATCH', token: t, body: { username: 'alice_again' } });
    assert.strictEqual(r.status, 429); assert.ok(r.availableAt); console.log('✓ 2nd change blocked by cooldown, availableAt =', r.availableAt);
    r = await call('/me', { method: 'PATCH', token: t, body: { username: 'alice_new', displayName: 'Alice' } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.user.displayName, 'Alice'); console.log('✓ unchanged username during cooldown does not error');
    // login works with new name, not old
    r = await call('/login', { method: 'POST', body: { username: 'alice_new', password: 'password123' } }); assert.strictEqual(r.status, 200); console.log('✓ can log in with new username');
    r = await call('/login', { method: 'POST', body: { username: 'alice_x', password: 'password123' } }); assert.strictEqual(r.status, 401); console.log('✓ old username no longer logs in');
    // old name is free for others right away
    r = await reg('alice_x'); assert.strictEqual(r.status, 200); console.log('✓ old username is free for others');
    // cooldown expiry (rewind the stored timestamp by 8 days)
    const store = require('./db');
    store.db.users[a.user.id].usernameChangedAt -= 8 * 24 * 3600 * 1000;
    r = await call('/me', { method: 'PATCH', token: t, body: { username: 'alice_two' } }); assert.strictEqual(r.status, 200); console.log('✓ allowed again after 7 days');
    console.log('ALL PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  await cleanup();
  process.exit();
}));
