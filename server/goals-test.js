// Server goals, without a server: node server/goals-test.js
const assert = require('assert');
const G = require('./goals');

const step = (m) => console.log('✓', m);
const bar = (extra = {}) => ({ id: 'g1', title: 'Reach 100 members', target: 100, progress: 40, done: false, at: 1, ...extra });
const box = (extra = {}) => ({ id: 'g2', title: 'Host a movie night', target: 0, progress: 0, done: false, at: 1, ...extra });

// ---- a new goal ----
{
  assert.deepStrictEqual(G.cleanNew({ title: '  Reach 100  ', target: 100 }, 5), { value: { title: 'Reach 100', target: 100, progress: 0, done: false, at: 5 } });
  assert.strictEqual(G.cleanNew({ title: 'Movie night' }, 5).value.target, 0, 'no target = a checkbox goal');
  assert.strictEqual(G.cleanNew({ title: 'x', target: null }, 5).value.target, 0);
  assert.strictEqual(G.cleanNew({ title: 'x', target: '' }, 5).value.target, 0);
  for (const bad of [-1, 1.5, '10', NaN, Infinity, G.LIMITS.target + 1, {}, true]) assert.ok(G.cleanNew({ title: 'x', target: bad }, 5).error, 'rejects target ' + String(bad));
  assert.ok(G.cleanNew({ title: '   ' }, 5).error, 'empty title');
  assert.ok(G.cleanNew({}, 5).error, 'no title');
  assert.ok(G.cleanNew(null, 5).error, 'null input');
  assert.strictEqual(G.cleanNew({ title: 'a'.repeat(300) }, 5).value.title.length, G.LIMITS.title, 'long titles are cut');
}
step('new goals');

// ---- moving a progress bar ----
{
  let r = G.applyChange(bar(), { progress: 75 });
  assert.strictEqual(r.value.progress, 75); assert.strictEqual(r.value.done, false);
  r = G.applyChange(bar(), { progress: 100 });
  assert.strictEqual(r.value.done, true, 'reaching the target finishes the goal');
  r = G.applyChange(bar({ progress: 100, done: true }), { progress: 99 });
  assert.strictEqual(r.value.done, false, 'dropping back reopens it');
  r = G.applyChange(bar(), { progress: 150 });
  assert.strictEqual(r.value.progress, 100, 'progress stops at the target');
  assert.strictEqual(r.value.done, true);
  for (const bad of [-1, 1.5, '5', null, G.LIMITS.target + 1]) assert.ok(G.applyChange(bar(), { progress: bad }).error, 'rejects progress ' + String(bad));
  assert.ok(G.applyChange(box(), { progress: 3 }).error, 'a checkbox goal has no progress');
}
step('progress bars move and finish');

// ---- ticking ----
{
  let r = G.applyChange(box(), { done: true });
  assert.strictEqual(r.value.done, true);
  r = G.applyChange(box({ done: true }), { done: false });
  assert.strictEqual(r.value.done, false);
  r = G.applyChange(bar(), { done: true });
  assert.deepStrictEqual([r.value.done, r.value.progress], [true, 100], 'ticking a bar fills it');
  r = G.applyChange(bar({ progress: 100, done: true }), { done: false });
  assert.deepStrictEqual([r.value.done, r.value.progress], [false, 99], 'unticking leaves it just short');
  assert.ok(G.applyChange(box(), { done: 'yes' }).error, 'done is a boolean');
}
step('ticking');

// ---- editing the title and target ----
{
  let r = G.applyChange(bar(), { title: '  Reach 200  ', target: 200 });
  assert.deepStrictEqual([r.value.title, r.value.target, r.value.progress], ['Reach 200', 200, 40]);
  r = G.applyChange(bar({ progress: 90 }), { target: 50 });
  assert.deepStrictEqual([r.value.progress, r.value.done], [50, true], 'a lowered target pulls progress down and can finish it');
  r = G.applyChange(bar({ progress: 100, done: true }), { target: 200 });
  assert.strictEqual(r.value.done, false, 'a raised target reopens a finished goal');
  r = G.applyChange(bar({ progress: 40 }), { target: 0 });
  assert.deepStrictEqual([r.value.target, r.value.progress], [0, 0], 'turning a bar into a checkbox');
  r = G.applyChange(box(), { target: 10 });
  assert.deepStrictEqual([r.value.target, r.value.progress, r.value.done], [10, 0, false], 'turning a checkbox into a bar');
  assert.ok(G.applyChange(bar(), { title: '  ' }).error, 'empty title');
  assert.ok(G.applyChange(bar(), { target: -5 }).error, 'bad target');
  assert.ok(G.applyChange(bar(), {}).error, 'nothing to change');
  assert.ok(G.applyChange(bar(), null).error, 'null input');
  const old = bar(); G.applyChange(old, { progress: 99 });
  assert.strictEqual(old.progress, 40, 'the old goal is left untouched');
}
step('title and target edits');

// ---- percent ----
assert.strictEqual(G.percent(bar()), 40);
assert.strictEqual(G.percent(bar({ progress: 1, target: 3 })), 33);
assert.strictEqual(G.percent(bar({ progress: 100 })), 100);
assert.strictEqual(G.percent(box()), 0);
assert.strictEqual(G.percent(box({ done: true })), 100);
step('percent');

console.log('goals-test: all passed');
