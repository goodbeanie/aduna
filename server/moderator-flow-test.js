// The moderator role through the real server (needs TEST_DATABASE_URL like the other DB tests): node server/moderator-flow-test.js
// A moderator reads reports and dismisses or restores them, looks people up, and warns or mutes (a day at most). Everything else on /api/admin stays closed to them.
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
  const admin = await makeUser('mt_admin'), mod = await makeUser('mtmod'), mod2 = await makeUser('mtmodtwo'), alice = await makeUser('mtalice'), bob = await makeUser('mtbob');
  const T = (u) => u.token, id = (u) => u.user.id;

  assert.strictEqual((await call('/admin/me', { token: T(mod) })).status, 404, 'nobody has the role yet');
  assert.strictEqual((await call('/admin/moderators', { method: 'POST', token: T(alice), body: { userId: id(mod) } })).status, 404, 'a plain member cannot add one');
  let r = await call('/admin/moderators', { method: 'POST', token: T(admin), body: { userId: id(mod) } });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.strictEqual((await call('/admin/moderators', { method: 'POST', token: T(admin), body: { userId: id(mod) } })).status, 400, 'twice is refused');
  assert.strictEqual((await call('/admin/moderators', { method: 'POST', token: T(admin), body: { userId: id(admin) } })).status, 400, 'an admin cannot be made a moderator');
  r = await call('/admin/moderators', { token: T(admin) });
  assert.deepStrictEqual(r.moderators.map((m) => m.username), ['mtmod']);
  assert.strictEqual((await call('/admin/moderators', { method: 'POST', token: T(admin), body: { userId: id(mod2) } })).status, 200, 'a second moderator, to check they cannot act on each other');
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

  // what stays closed, with the same plain 404 a stranger gets
  const closed = [
    ['GET', '/admin/servers'], ['GET', '/admin/admins'], ['GET', '/admin/moderators'], ['GET', '/admin/log'], ['GET', '/admin/applications'],
    ['POST', `/admin/users/${id(alice)}/suspend`, { reason: 'x' }], ['POST', `/admin/users/${id(alice)}/unsuspend`],
    ['POST', `/admin/users/${id(alice)}/delete`, { confirm: 'mtalice' }], ['POST', `/admin/servers/${sv.id}/delete`], ['POST', '/admin/messages/nope/delete'],
    ['POST', '/admin/moderators', { userId: id(alice) }], ['POST', '/admin/admins', { userId: id(alice) }], ['DELETE', `/admin/moderators/${id(mod)}`],
  ];
  for (const [method, path, body] of closed) assert.strictEqual((await call(path, { method, token: T(mod), body })).status, 404, `${method} ${path} should be closed to a moderator`);
  step('suspend, delete, servers, log and role changes are closed to a moderator');

  // people, warnings and mutes: open to a moderator, with limits
  r = await call('/admin/users?q=mtalice', { token: T(mod) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.users[0].username, 'mtalice');
  r = await call(`/admin/users/${id(alice)}`, { token: T(mod) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.user.limited, true, 'a moderator gets the trimmed person view');
  assert.strictEqual(r.user.canModerate, true);
  assert.ok(!r.user.owned.length && r.user.servers === 0 && r.user.clips === 0 && !('storagePlanStatus' in r.user), 'no servers, clips or storage details for a moderator');
  assert.strictEqual((await call(`/admin/users/${id(admin)}`, { token: T(mod) })).user.canModerate, false, 'an admin cannot be acted on by a moderator');
  assert.strictEqual((await call(`/admin/users/${id(admin)}/warn`, { method: 'POST', token: T(mod), body: { reason: 'x' } })).status, 403);
  assert.strictEqual((await call(`/admin/users/${id(mod)}/warn`, { method: 'POST', token: T(mod), body: { reason: 'x' } })).status, 400, 'not yourself');
  assert.strictEqual((await call(`/admin/users/${id(mod2)}/warn`, { method: 'POST', token: T(mod), body: { reason: 'x' } })).status, 403, 'not another moderator');
  assert.strictEqual((await call(`/admin/users/${id(mod2)}/mute`, { method: 'POST', token: T(mod), body: { reason: 'x', hours: 1 } })).status, 403);
  assert.strictEqual((await call(`/admin/users/${id(mod2)}/warn`, { method: 'POST', token: T(admin), body: { reason: 'an admin can' } })).status, 200, 'an admin can warn a moderator');
  step('a moderator looks people up (trimmed view) but not at admins or other moderators');

  assert.strictEqual((await call(`/admin/users/${id(alice)}/warn`, { method: 'POST', token: T(mod), body: { reason: '' } })).status, 400, 'a warning needs a reason');
  r = await call(`/admin/users/${id(alice)}/warn`, { method: 'POST', token: T(mod), body: { reason: 'Please stop posting links' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.strictEqual(r.moderation.activeWarnings, 1);
  assert.strictEqual(r.moderation.warnings[0].by, 'mtmod');
  const ownWarning = r.moderation.warnings[0].id;
  r = await call(`/admin/users/${id(alice)}/warn`, { method: 'POST', token: T(admin), body: { reason: 'Second, from an admin' } });
  const adminWarning = r.moderation.warnings[0].id;
  assert.strictEqual((await call(`/admin/users/${id(alice)}/warnings/${adminWarning}`, { method: 'DELETE', token: T(mod) })).status, 403, 'a moderator cannot take back an admin warning');
  assert.strictEqual((await call(`/admin/users/${id(alice)}/warnings/${ownWarning}`, { method: 'DELETE', token: T(mod) })).status, 200, 'but can take back their own');
  assert.strictEqual((await call(`/admin/users/${id(alice)}/warn`, { method: 'POST', token: T(mod), body: { reason: 'Third warning' } })).status, 200);
  r = await call(`/admin/users/${id(alice)}/warn`, { method: 'POST', token: T(mod), body: { reason: 'Fourth warning' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.moderation.activeWarnings, 3);
  assert.strictEqual(r.escalation && r.escalation.type, 'mute', 'the 3rd active warning is the automatic 24 hour mute, even from a moderator');
  assert.strictEqual((await call(`/admin/users/${id(alice)}/unmute`, { method: 'POST', token: T(mod) })).status, 403, 'a moderator cannot lift an automatic mute');
  assert.strictEqual((await call(`/admin/users/${id(alice)}/warn`, { method: 'POST', token: T(mod), body: { reason: 'Fifth warning' } })).status, 200);
  r = await call(`/admin/users/${id(alice)}/warn`, { method: 'POST', token: T(mod), body: { reason: 'Sixth warning' } });
  assert.strictEqual(r.status, 403, 'the warning that would suspend is for an admin: ' + JSON.stringify(r));
  assert.strictEqual((await call(`/admin/users/${id(alice)}`, { token: T(admin) })).user.suspended, null, 'and nothing was suspended');
  step('a moderator warns and takes back their own, and the suspending warning is left to an admin');

  assert.strictEqual((await call(`/admin/users/${id(bob)}/mute`, { method: 'POST', token: T(mod), body: { reason: 'Spamming', hours: 72 } })).status, 400, 'a moderator mutes for a day at most');
  r = await call(`/admin/users/${id(bob)}/mute`, { method: 'POST', token: T(mod), body: { reason: 'Spamming', hours: 6 } });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.strictEqual(r.moderation.mute.by, 'mtmod');
  assert.strictEqual((await call(`/admin/users/${id(bob)}/unmute`, { method: 'POST', token: T(mod) })).status, 200, 'a moderator lifts their own mute');
  assert.strictEqual((await call(`/admin/users/${id(bob)}/mute`, { method: 'POST', token: T(admin), body: { reason: 'Admin mute', hours: 168 } })).status, 200);
  assert.strictEqual((await call(`/admin/users/${id(bob)}/mute`, { method: 'POST', token: T(mod), body: { reason: 'Shorter', hours: 1 } })).status, 403, 'a moderator cannot replace an admin mute');
  assert.strictEqual((await call(`/admin/users/${id(bob)}/unmute`, { method: 'POST', token: T(mod) })).status, 403, 'or lift it');
  assert.strictEqual((await call(`/admin/users/${id(bob)}/unmute`, { method: 'POST', token: T(admin) })).status, 200);
  step('a moderator mutes up to a day and only lifts mutes they set');

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
  assert.strictEqual((await call(`/admin/users/${id(bob)}/warn`, { method: 'POST', token: T(mod), body: { reason: 'x' } })).status, 404, 'and so does warning');
  step('removing the role closes the door');

  console.log('\nAll moderator checks passed.');
  await cleanup();
  process.exit(0);
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
