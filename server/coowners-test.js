// Co-owners: node server/coowners-test.js (needs TEST_DATABASE_URL)
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
  const owner = await makeUser('coowna'), co1 = await makeUser('cooone'), co2 = await makeUser('cootwo'), mem = await makeUser('coomem'), out = await makeUser('coout');
  const T = (u) => u.token;
  const list = async (u) => (await call('/servers', { token: T(u) })).servers;

  const sv = (await call('/servers', { method: 'POST', body: { name: 'Shared' }, token: T(owner) })).server;
  const id = sv.id, code = sv.inviteCode;
  for (const u of [co1, co2, mem]) await call('/servers/join', { method: 'POST', body: { code }, token: T(u) });
  const add = (u, who) => call(`/servers/${id}/co-owners`, { method: 'POST', body: { userId: who.user.id }, token: T(u) });
  const del = (u, who) => call(`/servers/${id}/co-owners/${who.user.id}`, { method: 'DELETE', token: T(u) });

  // only the owner can name co-owners, and only current human members
  let r = await add(mem, co1);
  assert.strictEqual(r.status, 403, 'a member cannot add co-owners');
  r = await add(out, co1);
  assert.strictEqual(r.status, 404, 'outsiders learn nothing');
  r = await add(owner, out);
  assert.strictEqual(r.status, 400, 'must be a member');
  r = await add(owner, owner);
  assert.strictEqual(r.status, 400, 'the owner is not their own co-owner');
  assert.deepStrictEqual((await list(owner)).find((s) => s.id === id).coOwners || [], [], 'nothing changed');
  step('adding co-owners is for the owner only, and only members');

  // several co-owners at once
  r = await add(owner, co1);
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  r = await add(owner, co2);
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.deepStrictEqual([...r.server.coOwners].sort(), [co1.user.id, co2.user.id].sort());
  r = await add(owner, co1);
  assert.strictEqual(r.status, 400, 'twice is refused');
  step('a server can have several co-owners');

  // a co-owner has the owner powers: settings, roles, any permission
  r = await call(`/servers/${id}`, { method: 'PATCH', body: { name: 'Shared 2' }, token: T(co1) });
  assert.strictEqual(r.status, 200, 'a co-owner can change server settings');
  r = await call(`/servers/${id}/roles`, { method: 'POST', body: { name: 'helper', perms: ['administrator'] }, token: T(co1) });
  assert.strictEqual(r.status, 200, 'a co-owner can hand out any permission: ' + JSON.stringify(r));
  const roleId = r.server.roles[0].id;
  r = await call(`/servers/${id}/members/${mem.user.id}/roles`, { method: 'PUT', body: { roles: [roleId] }, token: T(co1) });
  assert.strictEqual(r.status, 200, 'a co-owner can give roles');
  r = await call(`/servers/${id}/members/${mem.user.id}/roles`, { method: 'PUT', body: { roles: [] }, token: T(co2) });
  assert.strictEqual(r.status, 200, 'and another co-owner can take them back');
  r = await call(`/servers/${id}/members/${co2.user.id}/roles`, { method: 'PUT', body: { roles: [roleId] }, token: T(co1) });
  assert.strictEqual(r.status, 400, 'co-owners hold no roles');
  step('co-owners have every permission');

  // nobody can kick the owner or a co-owner, not even another co-owner
  const kick = (u, who) => call(`/servers/${id}/members/${who.user.id}/kick`, { method: 'POST', token: T(u) });
  assert.strictEqual((await kick(co1, owner)).status, 400, 'owner cannot be kicked');
  assert.strictEqual((await kick(co1, co2)).status, 400, 'co-owner cannot be kicked by a co-owner');
  assert.strictEqual((await kick(owner, co2)).status, 400, 'nor by the owner while they are a co-owner');
  step('owner and co-owners cannot be kicked');

  // but they stay below the owner: no transfer, no delete, no co-owner changes
  r = await call(`/servers/${id}/transfer`, { method: 'POST', body: { userId: co2.user.id, password: 'password123' }, token: T(co1) });
  assert.strictEqual(r.status, 403, 'a co-owner cannot transfer');
  r = await call(`/servers/${id}`, { method: 'DELETE', body: { name: 'Shared 2', password: 'password123' }, token: T(co1) });
  assert.strictEqual(r.status, 403, 'a co-owner cannot delete');
  assert.strictEqual((await add(co1, mem)).status, 403, 'a co-owner cannot add co-owners');
  assert.strictEqual((await del(co1, co2)).status, 403, 'a co-owner cannot remove co-owners');
  assert.ok((await list(mem)).some((s) => s.id === id), 'still there');
  step('only the owner can transfer, delete or change co-owners');

  // a co-owner may leave, and stops being one
  r = await call(`/servers/${id}/leave`, { method: 'POST', token: T(co2) });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.deepStrictEqual((await list(owner)).find((s) => s.id === id).coOwners, [co1.user.id], 'the leaver is no longer a co-owner');
  step('a co-owner can leave');

  // removing a co-owner takes the powers away
  r = await del(owner, co1);
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.deepStrictEqual(r.server.coOwners, []);
  r = await call(`/servers/${id}`, { method: 'PATCH', body: { name: 'Shared 3' }, token: T(co1) });
  assert.strictEqual(r.status, 403, 'no longer a co-owner');
  assert.strictEqual((await del(owner, co1)).status, 404, 'removing twice finds nothing');
  step('removing a co-owner removes their powers');

  // transferring to a co-owner makes them the owner (and no longer listed as a co-owner)
  await add(owner, co1);
  r = await call(`/servers/${id}/transfer`, { method: 'POST', body: { userId: co1.user.id, password: 'password123' }, token: T(owner) });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.strictEqual(r.server.ownerId, co1.user.id);
  assert.deepStrictEqual(r.server.coOwners, [], 'the new owner is not also a co-owner');
  step('transfer to a co-owner works');

  console.log('\nAll co-owner checks passed.');
  await cleanup();
  process.exit(0);
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
