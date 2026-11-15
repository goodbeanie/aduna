// Invite lookups are limited per address, signed in or not: node server/invite-limit-test.js
// (GET /api/invites/:code and POST /api/servers/join share one count, so invite codes cannot be guessed one lookup at a time.)
const assert = require('assert');
const { cleanup } = require('./test-env');
const { httpServer, ready, inviteLookups } = require('./index');
const store = require('./db');

let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, headers: r.headers, ...(await r.json().catch(() => ({}))) };
}
const step = (m) => console.log('✓', m);
const blob = () => ({ salt: 'a', iv: 'b', data: 'c' });
async function reg(name) {
  const r = await call('/register', { method: 'POST', body: { username: name, email: name + '@example.com', password: 'password123', publicKey: 'k', encPrivKey: blob() } });
  assert.strictEqual(r.status, 200, 'register ' + name + ': ' + r.error);
  return r;
}

(async () => {
  await ready;
  await new Promise((r) => httpServer.listen(0, r));
  base = 'http://127.0.0.1:' + httpServer.address().port;

  const owner = await reg('inv_owner'), guest = await reg('inv_guest');
  const { server } = await call('/servers', { method: 'POST', token: owner.token, body: { name: 'InviteHub' } });
  assert.ok(server && server.inviteCode, 'a server with an invite code');

  // the tests raise the limit so they can make many calls; here it is lowered to see it work
  const LIMIT = 5;
  inviteLookups.limit = LIMIT; inviteLookups.hits.clear();

  // signed-in callers used to have no limit at all: guessing from a signed-in account must stop too
  for (let i = 0; i < LIMIT; i++) assert.strictEqual((await call('/invites/guess-' + i, { token: guest.token })).status, 404, 'a wrong code is a plain 404 while under the limit');
  let r = await call('/invites/guess-final', { token: guest.token });
  assert.strictEqual(r.status, 429, 'signed in: the next lookup is refused'); assert.ok(Number(r.headers.get('retry-after')) > 0, 'with a Retry-After');
  assert.strictEqual((await call('/invites/guess-final')).status, 429, 'signed out: the same address is refused too');
  assert.strictEqual((await call('/invites/' + server.inviteCode, { token: guest.token })).status, 429, 'and a correct code is refused as well, so a hit cannot be told from a miss');
  step('invite lookups: signed-in and signed-out callers share a per-address limit, with Retry-After');

  // joining counts against the same limit
  r = await call('/servers/join', { method: 'POST', token: guest.token, body: { code: 'nope' } });
  assert.strictEqual(r.status, 429, 'joining by code is limited with the lookups');
  assert.ok(!store.db.servers[server.id].members.includes(guest.user.id), 'and nothing was joined');
  step('joining by code shares the count');

  // once the window passes (cleared here), normal use works again, and a real join is one lookup
  inviteLookups.hits.clear();
  assert.strictEqual((await call('/invites/' + server.inviteCode, { token: guest.token })).status, 200, 'a real invite card');
  assert.strictEqual((await call('/servers/join', { method: 'POST', token: guest.token, body: { code: server.inviteCode } })).status, 200, 'a real join');
  assert.strictEqual(inviteLookups.hits.size, 1, 'one address is counted');
  step('normal use is not affected');

  // the count is saved with the other limits and comes back after a restart
  const saved = JSON.parse(JSON.stringify(inviteLookups.dump()));
  const { RateWindow } = require('./security');
  inviteLookups.hits.clear();
  for (let i = 0; i < LIMIT; i++) inviteLookups.allow('1.2.3.4');
  const copy = new RateWindow(LIMIT, 15 * 60_000); copy.restore(JSON.parse(JSON.stringify(inviteLookups.dump())));
  assert.strictEqual(copy.allow('1.2.3.4'), false, 'a restarted server still remembers the lookups'); assert.ok(saved.length >= 1);
  step('the count survives a restart (dump/restore)');

  console.log('\ninvite-limit-test: all passed');
})().then(() => cleanup().then(() => process.exit(0)), async (e) => { console.error(e); await cleanup(); process.exit(1); });
