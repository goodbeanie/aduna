// The to-do channel rules, without a server: node server/todo-test.js
const assert = require('assert');
const T = require('./todo');

const step = (m) => console.log('✓', m);
const ROLES = ['mgr', 'team', 'other'];
const chan = (addRoles = ['mgr']) => ({ id: 'c', type: 'todo', addRoles, todos: [] });
const who = (extra = {}) => ({ owner: false, manage: false, roleIds: [], ...extra });
const item = (extra = {}) => ({ id: 't1', text: 'Do it', roleId: null, done: false, ...extra });

// ---- who may add ----
{
  const c = chan();
  assert.strictEqual(T.canAdd(who({ roleIds: ['mgr'] }), c), true, 'an adder role can add');
  assert.strictEqual(T.canAdd(who({ roleIds: ['team'] }), c), false, 'another role cannot');
  assert.strictEqual(T.canAdd(who(), c), false, 'nobody with no role cannot');
  assert.strictEqual(T.canAdd(who({ owner: true }), c), true, 'the owner can');
  assert.strictEqual(T.canAdd(who({ manage: true }), c), true, 'Manage channels can');
  assert.strictEqual(T.canAdd(who({ roleIds: ['mgr'] }), chan([])), false, 'with no adder roles only the owner and managers can');
  assert.strictEqual(T.canAdd(null, c), false);
}
step('who can add');

// ---- who may tick ----
{
  const c = chan(), assigned = item({ roleId: 'team' });
  assert.strictEqual(T.canTick(who({ roleIds: ['team'] }), c, assigned), true, 'the assigned role can tick');
  assert.strictEqual(T.canTick(who({ roleIds: ['team'] }), c, item({ roleId: 'other' })), false, 'a different role cannot tick it');
  assert.strictEqual(T.canTick(who({ roleIds: ['team'] }), c, item()), false, 'an unassigned task is not theirs');
  assert.strictEqual(T.canTick(who({ roleIds: ['mgr'] }), c, assigned), true, 'adders can tick anything');
  assert.strictEqual(T.canTick(who({ owner: true }), c, assigned), true);
  assert.strictEqual(T.canTick(who(), c, assigned), false, 'a member with no role cannot');
}
step('who can tick');

// ---- adder roles ----
{
  assert.deepStrictEqual(T.cleanAddRoles(['mgr', 'team'], ROLES), { value: ['mgr', 'team'] });
  assert.deepStrictEqual(T.cleanAddRoles([], ROLES), { value: [] }, 'an empty list is allowed');
  for (const bad of ['mgr', null, undefined, {}, ['nope'], ['mgr', 'mgr'], [1], Array.from({ length: 11 }, (_, i) => 'r' + i)]) assert.ok(T.cleanAddRoles(bad, ROLES).error, 'rejects ' + JSON.stringify(bad));
}
step('adder roles are checked');

// ---- a new task ----
{
  assert.deepStrictEqual(T.cleanNew({ text: '  Fix the sign  ' }, ROLES), { value: { text: 'Fix the sign', roleId: null } });
  assert.deepStrictEqual(T.cleanNew({ text: 'x', roleId: 'team' }, ROLES), { value: { text: 'x', roleId: 'team' } });
  assert.deepStrictEqual(T.cleanNew({ text: 'x', roleId: '' }, ROLES).value.roleId, null, 'an empty role means nobody');
  assert.ok(T.cleanNew({ text: '   ' }, ROLES).error, 'empty text');
  assert.ok(T.cleanNew({}, ROLES).error, 'no text');
  assert.ok(T.cleanNew({ text: 'x', roleId: 'nope' }, ROLES).error, 'unknown role');
  assert.ok(T.cleanNew({ text: 'x', roleId: 5 }, ROLES).error, 'role must be a string');
  assert.strictEqual(T.cleanNew({ text: 'a'.repeat(500) }, ROLES).value.text.length, T.LIMITS.text, 'long text is cut');
  assert.strictEqual(T.cleanNew({ text: 'a\u0000b\n c' }, ROLES).value.text, 'a b c', 'control characters become spaces');
}
step('new tasks are cleaned');

// ---- changing a task ----
{
  const c = chan(), t = item({ roleId: 'team' });
  const adder = who({ roleIds: ['mgr'] }), member = who({ roleIds: ['team'] }), outsider = who({ roleIds: ['other'] });
  assert.deepStrictEqual(T.cleanChange({ done: true }, ROLES, member, c, t), { value: { done: true } }, 'the assigned role ticks');
  assert.ok(T.cleanChange({ done: true }, ROLES, outsider, c, t).error, 'an outsider cannot tick');
  assert.ok(T.cleanChange({ text: 'new' }, ROLES, member, c, t).error, 'the assigned role cannot rewrite the task');
  assert.ok(T.cleanChange({ roleId: null }, ROLES, member, c, t).error, 'or hand it to someone else');
  assert.deepStrictEqual(T.cleanChange({ text: ' new ', roleId: 'other', done: true }, ROLES, adder, c, t), { value: { text: 'new', roleId: 'other', done: true } }, 'an adder can change all of it');
  assert.deepStrictEqual(T.cleanChange({ roleId: null }, ROLES, adder, c, t), { value: { roleId: null } }, 'and unassign');
  assert.ok(T.cleanChange({ roleId: 'nope' }, ROLES, adder, c, t).error, 'unknown role');
  assert.ok(T.cleanChange({ text: '  ' }, ROLES, adder, c, t).error, 'empty text');
  assert.ok(T.cleanChange({ done: 'yes' }, ROLES, adder, c, t).error, 'done is a boolean');
  assert.ok(T.cleanChange({}, ROLES, adder, c, t).error, 'nothing to change');
}
step('changes are checked per person');

// ---- a deleted role ----
{
  const c = { addRoles: ['mgr', 'team'], todos: [item({ id: 'a', roleId: 'team' }), item({ id: 'b', roleId: 'mgr' }), item({ id: 'c' })] };
  T.dropRole(c, 'team');
  assert.deepStrictEqual(c.addRoles, ['mgr']);
  assert.deepStrictEqual(c.todos.map((t) => t.roleId), [null, 'mgr', null]);
  T.dropRole({ todos: [] }, 'x'); // a channel with no addRoles does not throw
}
step('deleting a role cleans the channel');

console.log('todo-test: all passed');
