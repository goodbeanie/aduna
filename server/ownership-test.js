// Delete server + transfer ownership: node server/ownership-test.js (needs TEST_DATABASE_URL)
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

(async () => {
  await ready;
  await new Promise((r) => httpServer.listen(0, r));
  base = 'http://localhost:' + httpServer.address().port;
  const owner = await makeUser('ownera'), mem = await makeUser('ownermem'), other = await makeUser('ownerother'), out = await makeUser('ownerout');
  const T = (u) => u.token;
  const list = async (u) => (await call('/servers', { token: T(u) })).servers;

  let sv = (await call('/servers', { method: 'POST', body: { name: 'Ownable' }, token: T(owner) })).server;
  const id = sv.id, code = sv.inviteCode;
  await call('/servers/join', { method: 'POST', body: { code }, token: T(mem) });
  await call('/servers/join', { method: 'POST', body: { code }, token: T(other) });

  // the owner cannot leave while others are in: nobody inherits the server by list order
  let r = await call(`/servers/${id}/leave`, { method: 'POST', token: T(owner) });
  assert.deepStrictEqual([r.status, r.code], [400, 'owner_must_transfer']);
  assert.strictEqual((await list(owner)).find((s) => s.id === id).ownerId, owner.user.id, 'still the owner');
  step('owner cannot leave a server that has other members');

  // transfer: only the owner, only to a current member, only with the password
  const body = (userId, password = 'password123') => ({ userId, password });
  r = await call(`/servers/${id}/transfer`, { method: 'POST', body: body(mem.user.id), token: T(other) });
  assert.strictEqual(r.status, 403, 'a member cannot transfer');
  r = await call(`/servers/${id}/transfer`, { method: 'POST', body: body(out.user.id), token: T(owner) });
  assert.strictEqual(r.status, 400, 'target must be a member');
  r = await call(`/servers/${id}/transfer`, { method: 'POST', body: body(owner.user.id), token: T(owner) });
  assert.strictEqual(r.status, 400, 'cannot transfer to yourself');
  r = await call(`/servers/${id}/transfer`, { method: 'POST', body: body(mem.user.id, 'wrong-password'), token: T(owner) });
  assert.strictEqual(r.status, 400, 'wrong password refused');
  assert.strictEqual((await list(owner)).find((s) => s.id === id).ownerId, owner.user.id, 'nothing changed');
  r = await call(`/servers/${id}/transfer`, { method: 'POST', body: body(mem.user.id), token: T(out) });
  assert.strictEqual(r.status, 404, 'outsiders learn nothing');
  step('transfer refuses non-owners, non-members, yourself and a wrong password');

  // the new owner may hold a role first: it is dropped (owners hold none), and the old owner ends up an ordinary member
  const role = (await call(`/servers/${id}/roles`, { method: 'POST', body: { name: 'helper', perms: [] }, token: T(owner) })).server.roles[0].id;
  await call(`/servers/${id}/members/${mem.user.id}/roles`, { method: 'PUT', body: { roles: [role] }, token: T(owner) });
  r = await call(`/servers/${id}/transfer`, { method: 'POST', body: body(mem.user.id), token: T(owner) });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.strictEqual(r.server.ownerId, mem.user.id);
  assert.ok(!(r.server.memberRoles[mem.user.id] || []).length, 'new owner holds no roles');
  assert.ok(r.server.members.some((u) => u.id === owner.user.id), 'old owner is still a member');
  step('transfer works; old owner stays as a member');

  r = await call(`/servers/${id}`, { method: 'PATCH', body: { name: 'Mine now' }, token: T(owner) });
  assert.strictEqual(r.status, 403, 'old owner lost the owner powers');
  r = await call(`/servers/${id}`, { method: 'PATCH', body: { name: 'Mine now' }, token: T(mem) });
  assert.strictEqual(r.status, 200, 'new owner has them');
  r = await call(`/servers/${id}`, { method: 'DELETE', body: { name: 'Mine now', password: 'password123' }, token: T(owner) });
  assert.strictEqual(r.status, 403, 'old owner cannot delete');
  step('owner powers moved with the server');

  // old owner can now leave like anyone else
  r = await call(`/servers/${id}/leave`, { method: 'POST', token: T(owner) });
  assert.strictEqual(r.status, 200);
  assert.ok(!(await list(owner)).some((s) => s.id === id));
  step('former owner can leave normally');

  // delete: needs the exact name and the password; nobody but the owner may
  r = await call(`/servers/${id}`, { method: 'DELETE', body: { name: 'Nope', password: 'password123' }, token: T(mem) });
  assert.strictEqual(r.status, 400, 'name must match');
  r = await call(`/servers/${id}`, { method: 'DELETE', body: { name: 'Mine now', password: 'wrong-password' }, token: T(mem) });
  assert.strictEqual(r.status, 400, 'password must match');
  r = await call(`/servers/${id}`, { method: 'DELETE', body: { name: 'Mine now', password: 'password123' }, token: T(other) });
  assert.strictEqual(r.status, 403, 'members cannot delete');
  assert.ok((await list(other)).some((s) => s.id === id), 'still there after the refusals');
  r = await call(`/servers/${id}`, { method: 'DELETE', body: { name: 'Mine now', password: 'password123' }, token: T(mem) });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.ok(!(await list(other)).some((s) => s.id === id) && !(await list(mem)).some((s) => s.id === id), 'gone for everyone');
  r = await call(`/invites/${code}`, { token: T(out) });
  assert.strictEqual(r.status, 404, 'the invite link died with the server');
  r = await call('/servers/join', { method: 'POST', body: { code }, token: T(out) });
  assert.strictEqual(r.status, 404, 'cannot join a deleted server');
  r = await call(`/servers/${id}`, { method: 'DELETE', body: { name: 'Mine now', password: 'password123' }, token: T(mem) });
  assert.strictEqual(r.status, 404, 'second delete finds nothing');
  step('delete needs name + password + ownership and removes everything');

  // a published server disappears from the explorer too
  const pub = (await call('/servers', { method: 'POST', body: { name: 'Listed' }, token: T(owner) })).server;
  const mk = (kind, n) => call(`/servers/${pub.id}/channels`, { method: 'POST', body: { name: n, type: kind }, token: T(owner) });
  for (const [k, n] of [['text', 't2'], ['text', 't3'], ['voice', 'v1'], ['voice', 'v2'], ['rules', 'rules'], ['announcements', 'news']]) await mk(k, n);
  r = await call(`/servers/${pub.id}/publish`, { method: 'PUT', body: { visibility: 'public', description: 'A listed server' }, token: T(owner) });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.ok(((await call('/explore?q=Listed', { token: T(out) })).servers || []).some((s) => s.serverId === pub.id || s.id === pub.id), 'listed before');
  await call(`/servers/${pub.id}`, { method: 'DELETE', body: { name: 'Listed', password: 'password123' }, token: T(owner) });
  assert.ok(!((await call('/explore?q=Listed', { token: T(out) })).servers || []).some((s) => s.serverId === pub.id || s.id === pub.id), 'not listed after');
  step('deleted public servers leave the explorer');

  // an owner who is alone: leaving deletes the server
  const solo = (await call('/servers', { method: 'POST', body: { name: 'Solo' }, token: T(owner) })).server;
  r = await call(`/servers/${solo.id}/leave`, { method: 'POST', token: T(owner) });
  assert.deepStrictEqual([r.status, r.deleted], [200, true]);
  assert.ok(!(await list(owner)).some((s) => s.id === solo.id));
  step('a lone owner leaving deletes the server');

  console.log('\nAll ownership checks passed.');
  await cleanup();
  process.exit(0);
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
