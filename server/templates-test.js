// Server templates, without a server: node server/templates-test.js
const assert = require('assert');
const T = require('./templates');

const step = (m) => console.log('✓', m);
let n = 0;
const newId = () => 'id' + String(++n).padStart(14, '0');

assert.deepStrictEqual(T.IDS, ['standard', 'business', 'community', 'chill']);
assert.strictEqual(T.DEFAULT, 'standard');
step('four templates, standard first');

for (const id of T.IDS) {
  const b = T.build(id, newId);
  assert.ok(b.channels.length >= 3 && b.channels.length <= 30, id + ': a sensible number of channels');
  assert.strictEqual(b.channels[0].type, 'text', id + ': the first channel is text');
  const ids = [...b.channels.map((c) => c.id), ...b.categories.map((c) => c.id), ...b.roles.map((r) => r.id)];
  assert.strictEqual(new Set(ids).size, ids.length, id + ': every id is unique');
  for (const c of b.channels) {
    assert.ok(/^[a-z0-9-_]{1,30}$/.test(c.name), id + ': channel name ' + c.name + ' is valid');
    assert.ok(b.categories.some((g) => g.id === c.categoryId), id + ': ' + c.name + ' sits in a real category');
  }
  for (const r of b.roles) assert.ok(/^#[0-9a-f]{6}$/.test(r.color), id + ': role colour is hex');
}
step('every template is well formed');

// builds are independent copies
{
  const a = T.build('business', newId), b = T.build('business', newId);
  a.roles[0].perms.push('administrator');
  assert.ok(!b.roles[0].perms.includes('administrator'), 'templates are not shared between servers');
  assert.ok(!T.TEMPLATES.business.roles[0].perms.includes('administrator'), 'the definition is never changed');
}
step('builds are copies');

// business: a to-do channel the Manager role can add to
{
  const b = T.build('business', newId);
  const todo = b.channels.find((c) => c.type === 'todo');
  const manager = b.roles.find((r) => r.name === 'Manager');
  assert.ok(todo && manager, 'business has a to-do channel and a Manager role');
  assert.deepStrictEqual(todo.addRoles, [manager.id], 'Manager can add tasks');
  assert.deepStrictEqual(todo.todos, []);
  assert.ok(b.roles.some((r) => r.name === 'Team'), 'and a Team role');
  assert.strictEqual(b.roles[0].name, 'Manager', 'Manager is the top role');
  assert.ok(b.channels.some((c) => c.type === 'announcements') && b.channels.some((c) => c.type === 'voice'));
}
step('business: to-do channel, Manager and Team');

// community: ready to publish (3 text + 2 voice + rules + announcements) and has goals
{
  const b = T.build('community', newId);
  const count = (t) => b.channels.filter((c) => c.type === t).length;
  assert.ok(count('text') >= 3 && count('voice') >= 2 && count('rules') === 1 && count('announcements') === 1, 'meets the public server requirements');
  assert.strictEqual(count('goals'), 1, 'one goals channel');
  const rules = b.channels.find((c) => c.type === 'rules').rules;
  assert.ok(rules.length >= 3 && rules.every((r) => r.id && r.text), 'starter rules');
  assert.ok(b.roles.some((r) => r.name === 'Moderator'));
}
step('community: publishable, goals, starter rules');

// standard and chill have no roles and no special channels
for (const id of ['standard', 'chill']) {
  const b = T.build(id, newId);
  assert.deepStrictEqual(b.roles, [], id + ' has no roles');
  assert.ok(b.channels.every((c) => c.type === 'text' || c.type === 'voice'), id + ' has only text and voice');
  assert.ok(b.channels.some((c) => c.type === 'voice'));
}
step('standard and chill are plain');

// an unknown id falls back to standard
assert.deepStrictEqual(T.build('nope', newId).channels.map((c) => c.name), T.build('standard', newId).channels.map((c) => c.name));
step('unknown id falls back to standard');

console.log('templates-test: all passed');
