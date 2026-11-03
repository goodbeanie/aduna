// Feature releases, without a database: node server/features-test.js
// The three states, who sees what, testing before releasing, releasing several at once, and pulling one back.
const assert = require('assert');
const F = require('./features');

const step = (m) => console.log('✓', m);
const [A, B, C] = F.REGISTRY.map((f) => f.id);
const records = () => Object.create(null); // like a db collection

// ---- nothing is on until someone switches it ----
{
  assert.ok(F.REGISTRY.length >= 3 && new Set(F.REGISTRY.map((f) => f.id)).size === F.REGISTRY.length, 'ids are unique');
  assert.ok(F.REGISTRY.every((f) => /^[a-z0-9-]+$/.test(f.id) && f.name && f.desc), 'every feature has a plain id, a name and a description');
  const r = records();
  assert.strictEqual(F.stateOf(r, A), 'off');
  assert.strictEqual(F.enabled(r, A, true), false, 'off is off, even for a creator');
  assert.strictEqual(F.enabled(r, A, false), false);
  assert.deepStrictEqual(F.forUser(r, true), {});
  assert.deepStrictEqual(F.list(r).map((f) => f.state), F.REGISTRY.map(() => 'off'));
  step('every feature starts off, for everyone');
}

// ---- testing: creators only ----
{
  const r = records();
  assert.ok(F.apply(r, [A], 'testing', 'u1', 100).ok);
  assert.strictEqual(F.enabled(r, A, true), true, 'a creator sees a feature in testing');
  assert.strictEqual(F.enabled(r, A, false), false, 'nobody else does');
  assert.strictEqual(F.enabled(r, A, undefined), false, 'only an explicit true counts as a creator');
  assert.strictEqual(F.enabled(r, B, true), false, 'the others stay off');
  assert.deepStrictEqual(F.forUser(r, true), { [A]: 'testing' });
  assert.deepStrictEqual(F.forUser(r, false), {}, 'a normal account is told about nothing');
  assert.deepStrictEqual(r[A], { id: A, state: 'testing', at: 100, by: 'u1' });
  step('testing shows a feature to creator accounts only');
}

// ---- release: only from testing, one or several at once ----
{
  const r = records();
  let x = F.apply(r, [A], 'live', 'u1', 1);
  assert.ok(!x.ok && x.status === 400 && /testing first/.test(x.error), 'a feature that was never tested cannot go live');
  assert.deepStrictEqual(Object.keys(r), [], 'a refusal writes nothing');
  F.apply(r, [A, B], 'testing', 'u1', 2);
  x = F.apply(r, [A, B, C], 'live', 'u1', 3);
  assert.ok(!x.ok && /testing first/.test(x.error), 'one untested feature stops the whole release');
  assert.strictEqual(F.stateOf(r, A), 'testing', 'and nothing in it went live');
  x = F.apply(r, [A, B], 'live', 'u1', 4);
  assert.ok(x.ok && x.changed.length === 2 && x.changed.every((m) => m.from === 'testing' && m.to === 'live'));
  assert.strictEqual(F.enabled(r, A, false), true, 'live is for everyone');
  assert.strictEqual(F.enabled(r, B, false), true);
  assert.strictEqual(F.enabled(r, C, false), false, 'a feature that was not in the release stays off');
  assert.deepStrictEqual(F.forUser(r, false), { [A]: 'live', [B]: 'live' });
  assert.deepStrictEqual(F.forUser(r, true), { [A]: 'live', [B]: 'live' }, 'creators see live as live, not testing');
  step('release goes testing to live, one or several, all or nothing');
}

// ---- pulling back, and doing nothing twice ----
{
  const r = records();
  F.apply(r, [A], 'testing', 'u1', 1);
  F.apply(r, [A], 'live', 'u1', 2);
  const back = F.apply(r, [A], 'testing', 'u1', 3);
  assert.ok(back.ok && back.changed[0].from === 'live');
  assert.strictEqual(F.enabled(r, A, false), false, 'pulled back: gone for everyone else at once');
  assert.strictEqual(F.enabled(r, A, true), true, 'still there for creators');
  assert.ok(F.apply(r, [A], 'off', 'u1', 4).ok);
  assert.strictEqual(F.enabled(r, A, true), false);
  const again = F.apply(r, [A], 'off', 'u1', 5);
  assert.ok(again.ok && again.changed.length === 0, 'already there: nothing to change');
  assert.strictEqual(r[A].at, 4, 'and the time of the last real change is kept');
  assert.deepStrictEqual(F.list(r).find((f) => f.id === A), { ...F.list(r).find((f) => f.id === A), state: 'off', at: 4, by: 'u1' });
  step('a feature can be pulled back to testing or off, and repeating a move changes nothing');
}

// ---- refusals and hostile input ----
{
  const r = records();
  for (const [ids, state, status] of [[[], 'testing', 400], [null, 'testing', 400], ['a', 'testing', 400], [[A], 'maybe', 400], [[A], undefined, 400], [['nope'], 'testing', 404], [[A, 'nope'], 'testing', 404], [[{}], 'testing', 404], [['__proto__'], 'testing', 404], [['constructor'], 'testing', 404]]) {
    const x = F.apply(r, ids, state, 'u1', 1);
    assert.ok(!x.ok && x.status === status, JSON.stringify([ids, state]) + ' -> ' + JSON.stringify(x));
  }
  assert.deepStrictEqual(Object.keys(r), [], 'a refusal writes nothing');
  assert.strictEqual(F.enabled(r, '__proto__', true), false);
  assert.strictEqual(F.enabled({ [A]: { state: 'live' } }, 'toString', false), false);
  assert.strictEqual(F.enabled({ [A]: { state: 'banana' } }, A, true), false, 'a damaged record is off');
  assert.strictEqual(F.enabled({ [A]: { state: 'live' } }, A, false), true);
  const dup = F.apply(r, [A, A, A], 'testing', 'u1', 1);
  assert.ok(dup.ok && dup.changed.length === 1, 'the same feature named twice moves once');
  step('unknown features, bad states, and prototype names are refused and write nothing');
}

console.log('features: all passed');
