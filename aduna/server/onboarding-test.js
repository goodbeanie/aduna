// Onboarding: node server/onboarding-test.js (needs TEST_DATABASE_URL)
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
  const owner = await makeUser('onbowner'), early = await makeUser('onbearly'), late = await makeUser('onblate'), late2 = await makeUser('onblate2'), mod = await makeUser('onbmod');
  const T = (u) => u.token;

  let sv = (await call('/servers', { method: 'POST', body: { name: 'Onb' }, token: T(owner) })).server;
  const id = sv.id, code = sv.inviteCode;
  assert.ok(sv.onboarding === null, 'no onboarding by default');
  await call('/servers/join', { method: 'POST', body: { code }, token: T(early) });
  await call('/servers/join', { method: 'POST', body: { code }, token: T(mod) });

  // roles: two plain ones, one with power
  const mk = async (name, perms = []) => { const r = await call(`/servers/${id}/roles`, { method: 'POST', body: { name, perms }, token: T(owner) }); assert.strictEqual(r.status, 200, JSON.stringify(r)); return r.server.roles.find((x) => x.name === name).id; };
  const art = await mk('artist'), gamer = await mk('gamer'), staff = await mk('staff', ['kickMembers']);
  step('roles created');

  const cfg = (extra = {}) => ({ enabled: true, required: true, welcome: 'Hi!', questions: [
    { title: 'What do you like?', multi: true, required: false, options: [{ label: 'Art', roles: [art] }, { label: 'Games', roles: [gamer] }] },
    { title: 'Where are you?', multi: false, required: true, options: [{ label: 'EU', roles: [] }, { label: 'US', roles: [] }] },
  ], ...extra });

  // permissions on config
  assert.strictEqual((await call(`/servers/${id}/onboarding`, { method: 'PUT', body: cfg(), token: T(early) })).status, 403, 'plain member cannot configure');
  let r = await call(`/servers/${id}/onboarding`, { method: 'PUT', body: { ...cfg(), questions: [{ title: 'x', options: [{ label: 'Boss', roles: [staff] }] }] }, token: T(owner) });
  assert.strictEqual(r.status, 400); assert.match(r.error, /permissions/);
  assert.strictEqual((await call(`/servers/${id}/onboarding`, { method: 'PUT', body: cfg({ questions: [] }), token: T(owner) })).status, 400, 'enabled needs a question');
  assert.strictEqual((await call(`/servers/${id}/onboarding`, { method: 'PUT', body: cfg({ questions: Array(6).fill({ title: 'q', options: [{ label: 'a' }] }) }), token: T(owner) })).status, 400, 'max 5 questions');
  assert.strictEqual((await call(`/servers/${id}/onboarding`, { method: 'PUT', body: { ...cfg(), questions: [{ title: 'x', options: [{ label: 'a', roles: ['nope'] }] }] }, token: T(owner) })).status, 400, 'unknown role');
  step('config validation (no power roles, limits, permission)');

  r = await call(`/servers/${id}/onboarding`, { method: 'PUT', body: cfg(), token: T(owner) });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  const o = r.server.onboarding, [q1, q2] = o.questions;
  assert.ok(o.enabled && o.startedAt && q1.id && q1.options[0].id);
  step('owner saves onboarding');

  // existing member is asked but not blocked
  let st = await call(`/servers/${id}/onboarding`, { token: T(early) });
  assert.deepStrictEqual([st.done, st.blocking], [false, false], 'existing member is not blocked');
  // new member is blocked
  await new Promise((r2) => setTimeout(r2, 5));
  await call('/servers/join', { method: 'POST', body: { code }, token: T(late) });
  st = await call(`/servers/${id}/onboarding`, { token: T(late) });
  assert.strictEqual(st.blocking, true, 'new member is blocked until they answer');
  assert.strictEqual((await call(`/servers/${id}/onboarding/answers`, { method: 'POST', body: { skip: true }, token: T(late) })).status, 400, 'cannot skip a required onboarding');
  step('required only blocks people who joined after it was switched on');

  const A = (u, answers) => call(`/servers/${id}/onboarding/answers`, { method: 'POST', body: { answers }, token: T(u) });
  assert.strictEqual((await A(late, { [q1.id]: [q1.options[0].id] })).status, 400, 'required question left empty');
  assert.strictEqual((await A(late, { [q2.id]: [q2.options[0].id, q2.options[1].id] })).status, 400, 'two answers to a single-choice question');
  assert.strictEqual((await A(late, { [q2.id]: ['bogus'] })).status, 400, 'unknown answer');
  assert.strictEqual((await A(late, { [q1.id]: [q1.options[0].id, q1.options[0].id], [q2.id]: [q2.options[0].id] })).status, 400, 'duplicate answer');
  r = await A(late, { [q1.id]: [q1.options[0].id, q1.options[1].id], [q2.id]: [q2.options[0].id] });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.deepStrictEqual([...r.server.memberRoles[late.user.id]].sort(), [art, gamer].sort());
  assert.strictEqual(r.blocking, false); assert.strictEqual(r.done, true);
  step('answers grant roles and unblock');

  // retake swaps only the roles answers gave; a role given by hand stays
  await call(`/servers/${id}/members/${late.user.id}/roles`, { method: 'PUT', body: { roles: [art, gamer] }, token: T(owner) });
  r = await A(late, { [q1.id]: [q1.options[1].id], [q2.id]: [q2.options[1].id] });
  assert.deepStrictEqual(r.server.memberRoles[late.user.id], [gamer], 'artist taken back, gamer kept');
  // role the member already had by hand is not taken away on retake
  await call(`/servers/${id}/members/${early.user.id}/roles`, { method: 'PUT', body: { roles: [art] }, token: T(owner) });
  await A(early, { [q1.id]: [q1.options[0].id], [q2.id]: [q2.options[0].id] });
  r = await A(early, { [q1.id]: [], [q2.id]: [q2.options[0].id] });
  assert.deepStrictEqual(r.server.memberRoles[early.user.id], [art], 'a role given by hand survives a retake');
  step('retake swaps granted roles, keeps hand-given ones');

  // a role that later gains power is never handed out
  await call(`/servers/${id}/roles/${gamer}`, { method: 'PATCH', body: { perms: ['kickMembers'] }, token: T(owner) });
  r = await A(mod, { [q1.id]: [q1.options[1].id], [q2.id]: [q2.options[0].id] });
  assert.strictEqual(r.status, 200);
  assert.ok(!(r.server.memberRoles[mod.user.id] || []).includes(gamer), 'a role that gained permissions is not granted');
  await call(`/servers/${id}/roles/${gamer}`, { method: 'PATCH', body: { perms: [] }, token: T(owner) });
  step('roles that gain power stop being handed out');

  // role editor below the role cannot attach it
  await call(`/servers/${id}/members/${mod.user.id}/roles`, { method: 'PUT', body: { roles: [staff] }, token: T(owner) });
  await call(`/servers/${id}/roles/${staff}`, { method: 'PATCH', body: { perms: ['manageServer'] }, token: T(owner) });
  const top = await mk('toprole');
  // (new roles go to the bottom; mod holds 'staff' which sits above 'toprole' so mod may attach it, but not 'artist' above... check ordering)
  const order = (await call(`/servers/${id}/roles-order`, { method: 'PUT', body: { ids: [top, staff, art, gamer] }, token: T(owner) }));
  assert.strictEqual(order.status, 200, JSON.stringify(order));
  r = await call(`/servers/${id}/onboarding`, { method: 'PUT', body: { questions: [{ id: q1.id, title: 'Q', options: [{ id: q1.options[0].id, label: 'Art', roles: [art] }, { label: 'Top', roles: [top] }] }] }, token: T(mod) });
  assert.strictEqual(r.status, 400, 'cannot attach a role above your own');
  r = await call(`/servers/${id}/onboarding`, { method: 'PUT', body: { questions: [{ id: q1.id, title: 'Q', options: [{ id: q1.options[0].id, label: 'Art', roles: [art] }] }] }, token: T(mod) });
  assert.strictEqual(r.status, 200, JSON.stringify(r)); // art sits below staff: allowed
  step('editor cannot attach roles above their own');

  // deleting a role drops it from answers
  await call(`/servers/${id}/roles/${art}`, { method: 'DELETE', token: T(owner) });
  const after = (await call('/servers', { token: T(owner) })).servers.find((x) => x.id === id);
  assert.ok(after.onboarding.questions.every((q) => q.options.every((op) => !op.roles.includes(art))), 'deleted role removed from answers');
  step('deleting a role removes it from answers');

  // optional onboarding can be skipped; leaving and rejoining resets it
  await call(`/servers/${id}/onboarding`, { method: 'PUT', body: { required: false }, token: T(owner) });
  const skipper = await makeUser('onbskip');
  await call('/servers/join', { method: 'POST', body: { code }, token: T(skipper) });
  assert.strictEqual((await call(`/servers/${id}/onboarding`, { token: T(skipper) })).blocking, false);
  r = await call(`/servers/${id}/onboarding/answers`, { method: 'POST', body: { skip: true }, token: T(skipper) });
  assert.deepStrictEqual([r.status, r.done, r.skipped], [200, true, true]);
  await call(`/servers/${id}/leave`, { method: 'POST', token: T(skipper) });
  await call('/servers/join', { method: 'POST', body: { code }, token: T(skipper) });
  assert.strictEqual((await call(`/servers/${id}/onboarding`, { token: T(skipper) })).done, false, 'rejoining asks again');
  step('skip works when optional; rejoin asks again');

  // outsiders and the answers stay private
  const out = await makeUser('onbout');
  assert.strictEqual((await call(`/servers/${id}/onboarding`, { token: T(out) })).status, 404);
  assert.strictEqual((await call(`/servers/${id}/onboarding/answers`, { method: 'POST', body: { answers: {} }, token: T(out) })).status, 404);
  assert.ok(!JSON.stringify((await call('/servers', { token: T(early) })).servers).includes('"onboarded"'), 'answers are never in the server view');
  step('outsiders refused; answers not in the server view');

  console.log('\nAll onboarding checks passed.');
  await cleanup();
  process.exit(0);
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
