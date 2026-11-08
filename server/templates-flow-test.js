// Server templates, the to-do channel and goals, through the real routes: node server/templates-flow-test.js (needs TEST_DATABASE_URL)
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
  const owner = await makeUser('tplowner'), boss = await makeUser('tplboss'), worker = await makeUser('tplworker'), rando = await makeUser('tplrando'), outsider = await makeUser('tploutsider');
  const T = (u) => u.token;
  const view = async (id, u = owner) => (await call('/servers', { token: T(u) })).servers.find((x) => x.id === id);

  // ---- creating a server ----
  let r = await call('/servers', { method: 'POST', body: { name: 'Plain' }, token: T(owner) });
  assert.deepStrictEqual(r.server.channels.map((c) => c.name), ['general'], 'no template = just #general, as before');
  assert.ok(!r.server.roles.length && !r.server.categories.length);
  r = await call('/servers', { method: 'POST', body: { name: 'Bad', template: 'nope' }, token: T(owner) });
  assert.strictEqual(r.status, 400, 'an unknown template is refused');
  r = await call('/servers', { method: 'POST', body: { name: 'Bad', template: 7 }, token: T(owner) });
  assert.strictEqual(r.status, 400, 'a template that is not a name is refused');
  for (const [id, text, voice] of [['standard', 2, 1], ['chill', 3, 2]]) {
    r = await call('/servers', { method: 'POST', body: { name: id, template: id }, token: T(owner) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.server.channels.filter((c) => c.type === 'text').length, text, id + ' text channels');
    assert.strictEqual(r.server.channels.filter((c) => c.type === 'voice').length, voice, id + ' voice channels');
    assert.strictEqual(r.server.channels[0].type, 'text');
  }
  step('creating with and without a template');

  // ---- business ----
  r = await call('/servers', { method: 'POST', body: { name: 'Acme', template: 'business' }, token: T(owner) });
  let sv = r.server;
  const id = sv.id;
  const manager = sv.roles.find((x) => x.name === 'Manager'), team = sv.roles.find((x) => x.name === 'Team');
  let todo = sv.channels.find((c) => c.type === 'todo');
  assert.ok(manager && team && todo, 'business: Manager, Team and a to-do channel');
  assert.deepStrictEqual(todo.addRoles, [manager.id]);
  assert.ok(sv.categories.length === 3 && sv.channels.every((c) => sv.categories.some((g) => g.id === c.categoryId)));
  for (const u of [boss, worker, rando]) await call('/servers/join', { method: 'POST', body: { code: sv.inviteCode }, token: T(u) });
  assert.strictEqual((await call(`/servers/${id}/members/${boss.user.id}/roles`, { method: 'PUT', body: { roles: [manager.id] }, token: T(owner) })).status, 200);
  assert.strictEqual((await call(`/servers/${id}/members/${worker.user.id}/roles`, { method: 'PUT', body: { roles: [team.id] }, token: T(owner) })).status, 200);
  step('business server set up, roles handed out');

  const base_ = `/servers/${id}/channels/${todo.id}`;
  const tasks = async (u = owner) => (await view(id, u)).channels.find((c) => c.id === todo.id).todos;

  // who can add
  assert.strictEqual((await call(base_ + '/todos', { method: 'POST', body: { text: 'nope' }, token: T(rando) })).status, 403, 'a member with no role cannot add');
  assert.strictEqual((await call(base_ + '/todos', { method: 'POST', body: { text: 'nope' }, token: T(worker) })).status, 403, 'Team cannot add yet');
  assert.strictEqual((await call(base_ + '/todos', { method: 'POST', body: { text: 'nope' }, token: T(outsider) })).status, 404, 'outsiders do not even see the channel');
  assert.strictEqual((await call(base_ + '/todos', { method: 'POST', body: { text: '   ' }, token: T(boss) })).status, 400, 'empty task');
  assert.strictEqual((await call(base_ + '/todos', { method: 'POST', body: { text: 'x', roleId: 'nope' }, token: T(boss) })).status, 400, 'unknown role');
  r = await call(base_ + '/todos', { method: 'POST', body: { text: 'Order the new signs', roleId: team.id }, token: T(boss) });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  let t = (await tasks())[0];
  assert.deepStrictEqual([t.text, t.roleId, t.done, t.by], ['Order the new signs', team.id, false, boss.user.id]);
  assert.strictEqual((await call(base_ + '/todos', { method: 'POST', body: { text: 'Owner task' }, token: T(owner) })).status, 200, 'the owner can always add');
  step('adding tasks: the Manager role, the owner; nobody else');

  // members can read; outsiders cannot
  assert.strictEqual((await tasks(rando)).length, 2, 'every member sees the list');

  // who can tick
  assert.strictEqual((await call(`${base_}/todos/${t.id}`, { method: 'PATCH', body: { done: true }, token: T(rando) })).status, 403, 'a member with no role cannot tick');
  assert.strictEqual((await call(`${base_}/todos/${t.id}`, { method: 'PATCH', body: { text: 'hacked' }, token: T(worker) })).status, 403, 'the assigned role cannot rewrite it');
  assert.strictEqual((await call(`${base_}/todos/${t.id}`, { method: 'PATCH', body: { roleId: null }, token: T(worker) })).status, 403, 'or hand it to someone else');
  r = await call(`${base_}/todos/${t.id}`, { method: 'PATCH', body: { done: true }, token: T(worker) });
  assert.strictEqual(r.status, 200, 'the assigned role can tick');
  t = (await tasks())[0];
  assert.deepStrictEqual([t.done, t.doneBy], [true, worker.user.id]);
  assert.ok(t.doneAt > 0);
  const unassigned = (await tasks())[1];
  assert.strictEqual((await call(`${base_}/todos/${unassigned.id}`, { method: 'PATCH', body: { done: true }, token: T(worker) })).status, 403, 'a task that is not theirs cannot be ticked');
  assert.strictEqual((await call(`${base_}/todos/${unassigned.id}`, { method: 'PATCH', body: { done: true }, token: T(boss) })).status, 200, 'an adder can tick any task');
  r = await call(`${base_}/todos/${t.id}`, { method: 'PATCH', body: { done: false }, token: T(boss) });
  t = (await tasks())[0];
  assert.deepStrictEqual([t.done, t.doneBy, t.doneAt], [false, null, null], 'unticking clears who and when');
  r = await call(`${base_}/todos/${t.id}`, { method: 'PATCH', body: { text: 'Order 3 new signs', roleId: manager.id }, token: T(boss) });
  assert.strictEqual(r.status, 200);
  t = (await tasks())[0];
  assert.deepStrictEqual([t.text, t.roleId], ['Order 3 new signs', manager.id], 'an adder can reword and reassign');
  assert.strictEqual((await call(`${base_}/todos/nope`, { method: 'PATCH', body: { done: true }, token: T(boss) })).status, 404);
  assert.strictEqual((await call(`${base_}/todos/${t.id}`, { method: 'PATCH', body: {}, token: T(boss) })).status, 400, 'nothing to change');
  step('ticking tasks: the assigned role and adders; nobody else');

  // changing who can add
  assert.strictEqual((await call(base_ + '/todo-settings', { method: 'PUT', body: { addRoles: [team.id] }, token: T(rando) })).status, 403, 'only people who manage channels choose the adders');
  assert.strictEqual((await call(base_ + '/todo-settings', { method: 'PUT', body: { addRoles: ['nope'] }, token: T(owner) })).status, 400, 'unknown role');
  assert.strictEqual((await call(base_ + '/todo-settings', { method: 'PUT', body: { addRoles: 'x' }, token: T(owner) })).status, 400, 'not a list');
  assert.strictEqual((await call(base_ + '/todo-settings', { method: 'PUT', body: { addRoles: [manager.id, team.id] }, token: T(boss) })).status, 200, 'the Manager role holds Manage channels');
  assert.deepStrictEqual((await view(id)).channels.find((c) => c.id === todo.id).addRoles, [manager.id, team.id]);
  assert.strictEqual((await call(base_ + '/todos', { method: 'POST', body: { text: 'Team can add now' }, token: T(worker) })).status, 200);
  step('choosing which roles can add');

  // deleting
  const mine = (await tasks()).find((x) => x.text === 'Team can add now');
  assert.strictEqual((await call(`${base_}/todos/${mine.id}`, { method: 'DELETE', token: T(rando) })).status, 403);
  assert.strictEqual((await call(`${base_}/todos/${mine.id}`, { method: 'DELETE', token: T(worker) })).status, 200, 'an adder can delete');
  assert.strictEqual((await call(`${base_}/todos/${mine.id}`, { method: 'DELETE', token: T(worker) })).status, 404, 'already gone');
  step('deleting tasks');

  // deleting a role cleans the channel
  await call(`/servers/${id}/roles/${team.id}`, { method: 'DELETE', token: T(owner) });
  todo = (await view(id)).channels.find((c) => c.id === todo.id);
  assert.deepStrictEqual(todo.addRoles, [manager.id], 'a deleted role stops being an adder');
  assert.ok(todo.todos.every((x) => x.roleId !== team.id), 'and its tasks become unassigned');
  step('deleting a role cleans the to-do channel');

  // the limits
  const lim = require('./todo').LIMITS.items;
  for (let i = (await tasks()).length; i < lim; i++) assert.strictEqual((await call(base_ + '/todos', { method: 'POST', body: { text: 't' + i }, token: T(owner) })).status, 200);
  assert.strictEqual((await call(base_ + '/todos', { method: 'POST', body: { text: 'one too many' }, token: T(owner) })).status, 400, 'task limit');
  step('task limit');

  // to-do and goals are not chat channels
  r = await call(`/servers/${id}/channels`, { method: 'POST', body: { name: 'sprint', type: 'todo' }, token: T(owner) });
  assert.strictEqual(r.status, 200);
  const sprint = r.server.channels.find((c) => c.name === 'sprint');
  assert.deepStrictEqual([sprint.type, sprint.addRoles, sprint.todos], ['todo', [], []], 'a to-do channel made by hand starts empty and owner-only');
  assert.strictEqual((await call(`${base_}x/todos`, { method: 'POST', body: { text: 'x' }, token: T(owner) })).status, 404, 'unknown channel');
  const general = sv.channels.find((c) => c.type === 'text');
  assert.strictEqual((await call(`/servers/${id}/channels/${general.id}/todos`, { method: 'POST', body: { text: 'x' }, token: T(owner) })).status, 404, 'a text channel has no tasks');
  assert.strictEqual((await call(`/servers/${id}/channels/${general.id}/goals`, { method: 'POST', body: { title: 'x' }, token: T(owner) })).status, 404, 'or goals');
  step('channel type checks');

  // ---- community and goals ----
  r = await call('/servers', { method: 'POST', body: { name: 'Town', template: 'community' }, token: T(owner) });
  sv = r.server;
  const gid = sv.id, goals = sv.channels.find((c) => c.type === 'goals');
  assert.ok(goals && goals.goals.length === 0, 'community has an empty goals channel');
  assert.ok(sv.channels.some((c) => c.type === 'rules' && c.rules.length >= 3), 'and starter rules');
  const mod = sv.roles.find((x) => x.name === 'Moderator');
  for (const u of [boss, worker]) await call('/servers/join', { method: 'POST', body: { code: sv.inviteCode }, token: T(u) });
  await call(`/servers/${gid}/members/${boss.user.id}/roles`, { method: 'PUT', body: { roles: [mod.id] }, token: T(owner) });
  const gb = `/servers/${gid}/channels/${goals.id}`;
  const list = async (u = owner) => (await view(gid, u)).channels.find((c) => c.id === goals.id).goals;

  assert.strictEqual((await call(gb + '/goals', { method: 'POST', body: { title: 'Reach 100 members', target: 100 }, token: T(worker) })).status, 403, 'a plain member cannot add goals');
  assert.strictEqual((await call(gb + '/goals', { method: 'POST', body: { title: 'Reach 100 members', target: 100 }, token: T(boss) })).status, 403, 'a moderator without Manage server cannot');
  assert.strictEqual((await call(gb + '/goals', { method: 'POST', body: { title: '', target: 100 }, token: T(owner) })).status, 400, 'empty title');
  assert.strictEqual((await call(gb + '/goals', { method: 'POST', body: { title: 'x', target: -4 }, token: T(owner) })).status, 400, 'bad target');
  assert.strictEqual((await call(gb + '/goals', { method: 'POST', body: { title: 'Reach 100 members', target: 100 }, token: T(owner) })).status, 200);
  assert.strictEqual((await call(gb + '/goals', { method: 'POST', body: { title: 'Host a movie night' }, token: T(owner) })).status, 200);
  let [bar, box] = await list();
  assert.deepStrictEqual([bar.target, bar.progress, bar.done], [100, 0, false]);
  assert.deepStrictEqual([box.target, box.done], [0, false]);
  assert.strictEqual((await list(worker)).length, 2, 'every member sees the goals');
  step('goals: only people who manage the server write them; everyone reads');

  assert.strictEqual((await call(`${gb}/goals/${bar.id}`, { method: 'PATCH', body: { progress: 60 }, token: T(owner) })).status, 200);
  assert.strictEqual((await list())[0].progress, 60);
  assert.strictEqual((await call(`${gb}/goals/${bar.id}`, { method: 'PATCH', body: { progress: 100 }, token: T(owner) })).status, 200);
  assert.strictEqual((await list())[0].done, true, 'reaching the target finishes it');
  assert.strictEqual((await call(`${gb}/goals/${box.id}`, { method: 'PATCH', body: { done: true }, token: T(owner) })).status, 200);
  assert.strictEqual((await list())[1].done, true, 'a checkbox goal is ticked');
  assert.strictEqual((await call(`${gb}/goals/${box.id}`, { method: 'PATCH', body: { progress: 3 }, token: T(owner) })).status, 400, 'a checkbox goal has no progress');
  assert.strictEqual((await call(`${gb}/goals/${bar.id}`, { method: 'PATCH', body: { progress: 5 }, token: T(worker) })).status, 403, 'members cannot move progress');
  assert.strictEqual((await call(`${gb}/goals/nope`, { method: 'PATCH', body: { progress: 5 }, token: T(owner) })).status, 404);
  assert.strictEqual((await call(`${gb}/goals/${bar.id}`, { method: 'PATCH', body: { title: 'Reach 250 members', target: 250 }, token: T(owner) })).status, 200);
  [bar] = await list();
  assert.deepStrictEqual([bar.title, bar.target, bar.progress, bar.done], ['Reach 250 members', 250, 100, false], 'editing the target reopens it');
  step('goals: progress, ticking, editing');

  assert.strictEqual((await call(`${gb}/goals/${box.id}`, { method: 'DELETE', token: T(worker) })).status, 403);
  assert.strictEqual((await call(`${gb}/goals/${box.id}`, { method: 'DELETE', token: T(owner) })).status, 200);
  assert.strictEqual((await call(`${gb}/goals/${box.id}`, { method: 'DELETE', token: T(owner) })).status, 404);
  assert.strictEqual((await list()).length, 1);
  assert.strictEqual((await call(`/servers/${gid}/channels`, { method: 'POST', body: { name: 'more-goals', type: 'goals' }, token: T(owner) })).status, 400, 'one goals channel per server');
  step('goals: delete, and one goals channel per server');

  for (let i = (await list()).length; i < require('./goals').LIMITS.goals; i++) assert.strictEqual((await call(gb + '/goals', { method: 'POST', body: { title: 'g' + i }, token: T(owner) })).status, 200);
  assert.strictEqual((await call(gb + '/goals', { method: 'POST', body: { title: 'one too many' }, token: T(owner) })).status, 400, 'goal limit');
  step('goal limit');

  console.log('\nAll template, to-do and goals checks passed.');
  await cleanup();
  process.exit(0);
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
