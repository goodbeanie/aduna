// The moderator role through the real server (needs TEST_DATABASE_URL like the other DB tests): node server/moderator-flow-test.js
// A moderator reads reports and dismisses or restores them. Everything else on /api/admin stays closed to them.
const assert = require('assert');
const { webcrypto: crypto } = require('crypto');
const { cleanup } = require('./test-env');
process.env.ADMIN_USERNAMES = 'mt_admin'; // read when the server module loads, so set first
const { httpServer, ready } = require('./index');

let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const step = (m) => console.log('✓', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function makeUser(name) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const r = await call('/register', { method: 'POST', body: { username: name, email: name + '@example.com', password: 'password123', publicKey: JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }), encPrivKey: { salt: 'a', iv: 'b', data: 'c' } } });
  assert.strictEqual(r.status, 200, 'register ' + JSON.stringify(r));
  return r;
}

(async () => {
  await ready;
  await new Promise((r) => httpServer.listen(0, r));
  base = 'http://localhost:' + httpServer.address().port;
  const admin = await makeUser('mt_admin'), mod = await makeUser('mtmod'), alice = await makeUser('mtalice'), bob = await makeUser('mtbob');
  const T = (u) => u.token, id = (u) => u.user.id;

  assert.strictEqual((await call('/admin/me', { token: T(mod) })).status, 404, 'nobody has the role yet');
  assert.strictEqual((await call('/admin/moderators', { method: 'POST', token: T(alice), body: { userId: id(mod) } })).status, 404, 'a plain member cannot add one');
  let r = await call('/admin/moderators', { method: 'POST', token: T(admin), body: { userId: id(mod) } });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.strictEqual((await call('/admin/moderators', { method: 'POST', token: T(admin), body: { userId: id(mod) } })).status, 400, 'twice is refused');
  assert.strictEqual((await call('/admin/moderators', { method: 'POST', token: T(admin), body: { userId: id(admin) } })).status, 400, 'an admin cannot be made a moderator');
  r = await call('/admin/moderators', { token: T(admin) });
  assert.deepStrictEqual(r.moderators.map((m) => m.username), ['mtmod']);
  step('an admin makes a moderator, once, and not an admin');

  // a report to review
  assert.strictEqual((await call(`/users/${id(alice)}/report`, { method: 'POST', token: T(bob), body: { reason: 'spam' } })).status, 200);
  const sv = (await call('/servers', { method: 'POST', token: T(alice), body: { name: 'Quiet Place' } })).server;

  r = await call('/admin/me', { token: T(mod) });
  assert.strictEqual(r.role, 'moderator');
  r = await call('/admin/summary', { token: T(mod) });
  assert.strictEqual(r.reports.users, 1, 'a moderator sees the report counts');
  assert.ok(!('users' in r) && !('applications' in r) && !('suspended' in r), 'and nothing about accounts or applications: ' + JSON.stringify(r));
  r = await call('/admin/user-reports', { token: T(mod) });
  assert.strictEqual(r.users[0].username, 'mtalice');
  assert.strictEqual(r.users[0].reports[0].reason, 'spam');
  for (const p of ['/admin/listing-reports', '/admin/bot-reports', '/admin/clips']) assert.notStrictEqual((await call(p, { token: T(mod) })).status, 404, p + ' is open to a moderator');
  step('a moderator reads the reports and the counts, and only those');

  // everything else is closed, with the same plain 404 a stranger gets
  const closed = [
    ['GET', '/admin/users'], ['GET', `/admin/users/${id(alice)}`], ['GET', '/admin/servers'], ['GET', '/admin/admins'], ['GET', '/admin/moderators'], ['GET', '/admin/log'], ['GET', '/admin/applications'],
    ['POST', `/admin/users/${id(alice)}/warn`, { reason: 'x' }], ['POST', `/admin/users/${id(alice)}/mute`, { reason: 'x', hours: 1 }], ['POST', `/admin/users/${id(alice)}/suspend`, { reason: 'x' }],
    ['POST', `/admin/users/${id(alice)}/delete`, { confirm: 'mtalice' }], ['POST', `/admin/servers/${sv.id}/delete`], ['POST', '/admin/messages/nope/delete'],
    ['POST', '/admin/moderators', { userId: id(alice) }], ['POST', '/admin/admins', { userId: id(alice) }], ['DELETE', `/admin/moderators/${id(mod)}`],
  ];
  for (const [method, path, body] of closed) assert.strictEqual((await call(path, { method, token: T(mod), body })).status, 404, `${method} ${path} should be closed to a moderator`);
  step('warn, mute, suspend, delete, people, servers, log and role changes are closed to a moderator');

  // decisions: dismiss and restore are theirs, removing for good is not
  assert.strictEqual((await call(`/admin/servers/${sv.id}/listing`, { method: 'POST', token: T(mod), body: { action: 'remove' } })).status, 403, 'removing is for admins');
  assert.strictEqual((await call(`/admin/servers/${sv.id}/listing`, { method: 'POST', token: T(mod), body: { action: 'dismiss' } })).status, 200);
  assert.strictEqual((await call(`/admin/servers/${sv.id}/listing`, { method: 'POST', token: T(mod), body: { action: 'restore' } })).status, 200);
  assert.strictEqual((await call('/admin/bots/nope/listing', { method: 'POST', token: T(mod), body: { action: 'remove' } })).status, 404, 'an unknown bot is still just not found');
  assert.strictEqual((await call('/admin/clips/nope', { method: 'POST', token: T(mod), body: { action: 'remove' } })).status, 404);
  assert.strictEqual((await call(`/admin/users/${id(alice)}/reports`, { method: 'POST', token: T(mod), body: { action: 'dismiss' } })).status, 200);
  assert.strictEqual((await call('/admin/summary', { token: T(mod) })).reports.users, 0, 'the report is gone');
  assert.strictEqual((await call(`/admin/servers/${sv.id}/listing`, { method: 'POST', token: T(admin), body: { action: 'remove' } })).status, 200, 'an admin can remove');
  step('a moderator dismisses and restores, and an admin still removes');

  // what they did is in the log
  let log = [];
  for (let i = 0; i < 20 && !log.some((l) => l.by === 'mtmod' && l.action === 'dismiss reports'); i++) { await sleep(50); log = (await call('/admin/log', { token: T(admin) })).log; }
  assert.ok(log.some((l) => l.by === 'mtmod' && l.action === 'dismiss reports' && l.target === 'mtalice'), JSON.stringify(log));
  assert.ok(log.some((l) => l.by === 'mt_admin' && l.action === 'add moderator' && l.target === 'mtmod'));
  step('moderator decisions are written to the log');

  // taking the role away closes the door at once
  assert.strictEqual((await call(`/admin/moderators/${id(mod)}`, { method: 'DELETE', token: T(admin) })).status, 200);
  assert.strictEqual((await call('/admin/me', { token: T(mod) })).status, 404);
  assert.strictEqual((await call('/admin/user-reports', { token: T(mod) })).status, 404);
  step('removing the role closes the door');

  console.log('\nAll moderator checks passed.');
  await cleanup();
  process.exit(0);
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
