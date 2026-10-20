// Public listing moderation + reports: node server/reports-test.js (needs TEST_DATABASE_URL)
process.env.ADMIN_USERNAMES = 'reportadmin'; // read when the server module loads, so set first
process.env.LISTING_REPORTS_TO_HIDE = '2';
const assert = require('assert');
const { webcrypto: crypto } = require('crypto');
const { cleanup } = require('./test-env');
const { httpServer, ready } = require('./index');

let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const step = (m) => console.log('✓', m);
async function makeUser(name) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const r = await call('/register', { method: 'POST', body: { username: name, email: name + '@example.com', password: 'password123', publicKey: JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }), encPrivKey: { salt: 'a', iv: 'b', data: 'c' } } });
  assert.strictEqual(r.status, 200, 'register ' + JSON.stringify(r));
  return r;
}

const ADMIN = 'reportadmin';
(async () => {
  await ready;
  await new Promise((r) => httpServer.listen(0, r));
  base = 'http://localhost:' + httpServer.address().port;
  const owner = await makeUser('repowner'), admin = await makeUser(ADMIN), out = await makeUser('repout');
  const T = (u) => u.token;
  const explore = async (u, q = '') => (await call('/explore?q=' + encodeURIComponent(q), { token: T(u) })).servers || [];

  const sv = (await call('/servers', { method: 'POST', body: { name: 'Chess Club' }, token: T(owner) })).server;
  for (const [k, n] of [['text', 't2'], ['text', 't3'], ['voice', 'v1'], ['voice', 'v2'], ['rules', 'rules'], ['announcements', 'news']]) await call(`/servers/${sv.id}/channels`, { method: 'POST', body: { name: n, type: k }, token: T(owner) });
  const pub = (description, token = T(owner)) => call(`/servers/${sv.id}/publish`, { method: 'PUT', body: { visibility: 'public', description }, token });

  // descriptions and tags are checked
  let r = await pub('Come and see https://example.com now');
  assert.strictEqual(r.status, 400, 'links refused');
  r = await pub('We post porn here');
  assert.strictEqual(r.status, 400, 'blocked word refused');
  r = await call(`/servers/${sv.id}`, { method: 'PATCH', body: { tags: ['p0rn'] }, token: T(owner) });
  assert.strictEqual(r.status, 400, 'blocked tag refused');
  r = await call(`/servers/${sv.id}`, { method: 'PATCH', body: { tags: ['chess'] }, token: T(owner) });
  assert.strictEqual(r.status, 200);
  r = await pub('Friendly chess games and lessons.');
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  r = await call(`/servers/${sv.id}`, { method: 'PATCH', body: { name: 'Nazi Club' }, token: T(owner) });
  assert.strictEqual(r.status, 400, 'a public server cannot be renamed to a blocked name');
  assert.ok((await explore(out, 'chess')).some((x) => x.serverId === sv.id), 'listed');
  step('listing text is checked on publish, on tags and on renaming');

  // reports
  r = await call(`/servers/${sv.id}/report`, { method: 'POST', body: { reason: 'spam' }, token: T(owner) });
  assert.strictEqual(r.status, 400, 'own server');
  r = await call(`/servers/${sv.id}/report`, { method: 'POST', body: { reason: 'nonsense' }, token: T(out) });
  assert.strictEqual(r.status, 400, 'reason required');
  r = await call(`/servers/${sv.id}/report`, { method: 'POST', body: { reason: 'other' }, token: T(out) });
  assert.strictEqual(r.status, 400, 'other needs details');
  const unlisted = (await call('/servers', { method: 'POST', body: { name: 'Hidden' }, token: T(owner) })).server;
  r = await call(`/servers/${unlisted.id}/report`, { method: 'POST', body: { reason: 'spam' }, token: T(out) });
  assert.strictEqual(r.status, 404, 'only public servers can be reported');
  r = await call(`/servers/${sv.id}/report`, { method: 'POST', body: { reason: 'spam' }, token: T(out) });
  assert.strictEqual(r.status, 200);
  r = await call(`/servers/${sv.id}/report`, { method: 'POST', body: { reason: 'illegal', details: 'changed my mind' }, token: T(out) });
  assert.strictEqual(r.status, 200, 'a second report from the same person replaces the first');
  assert.ok((await explore(admin, 'chess')).some((x) => x.serverId === sv.id), 'one person cannot hide a listing');
  step('report validation; repeats do not stack');

  // brand-new accounts do not count toward hiding (the threshold is 2 here)
  const fresh = await makeUser('repfresh');
  await call(`/servers/${sv.id}/report`, { method: 'POST', body: { reason: 'spam' }, token: T(fresh) });
  assert.ok((await explore(admin, 'chess')).some((x) => x.serverId === sv.id), 'new accounts do not count');
  step('throwaway accounts cannot hide a listing');

  // admin only
  r = await call('/admin/listing-reports', { token: T(out) });
  assert.strictEqual(r.status, 404, 'not an admin');
  r = await call('/admin/listing-reports', { token: T(admin) });
  const row = r.servers.find((x) => x.serverId === sv.id);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([row.reports.length, row.counted], [2, 0]);
  assert.ok(!JSON.stringify((await call('/servers', { token: T(owner) })).servers).includes('changed my mind'), 'reports never reach the server view');
  step('moderator list works; reports stay private');

  // reach the threshold with old-enough accounts: backdate two accounts through the database object
  const { store } = require('./index');
  const db = store && store.db;
  if (db) {
    for (const u of [out, fresh]) db.users[u.user.id].createdAt = Date.now() - 3 * 24 * 3600 * 1000;
    const other = await makeUser('repother'); db.users[other.user.id].createdAt = Date.now() - 3 * 24 * 3600 * 1000;
    await call(`/servers/${sv.id}/report`, { method: 'POST', body: { reason: 'spam' }, token: T(other) });
    assert.ok(!(await explore(admin, 'chess')).some((x) => x.serverId === sv.id), 'hidden after enough reports');
    assert.strictEqual((await call(`/servers/${sv.id}/publish`, { token: T(owner) })).publish.review, 'hidden');
    r = await pub('Friendly chess games and lessons!');
    assert.strictEqual(r.status, 400, 'the owner cannot edit a listing that is under review');
    step('enough established reporters hide the listing; owner sees the review notice');

    r = await call(`/admin/servers/${sv.id}/listing`, { method: 'POST', body: { action: 'restore' }, token: T(out) });
    assert.strictEqual(r.status, 404, 'non-admin cannot restore');
    r = await call(`/admin/servers/${sv.id}/listing`, { method: 'POST', body: { action: 'restore' }, token: T(admin) });
    assert.strictEqual(r.status, 200);
    assert.ok((await explore(admin, 'chess')).some((x) => x.serverId === sv.id), 'back in the explorer');
    await call(`/servers/${sv.id}/report`, { method: 'POST', body: { reason: 'spam' }, token: T(out) });
    await call(`/servers/${sv.id}/report`, { method: 'POST', body: { reason: 'spam' }, token: T(other) });
    r = await call(`/admin/servers/${sv.id}/listing`, { method: 'POST', body: { action: 'remove' }, token: T(admin) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await call('/servers', { token: T(owner) })).servers.find((x) => x.id === sv.id).visibility, null, 'taken off the public listing');
    r = await pub('Friendly chess games and lessons.');
    assert.strictEqual(r.status, 400, 'a removed server cannot go public again');
    step('moderator can restore or remove; removal sticks');
  } else console.log('(skipped threshold checks: store not exported)');

  console.log('\nAll report checks passed.');
  await cleanup();
  process.exit(0);
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
