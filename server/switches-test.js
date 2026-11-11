// Switches, without a database: node server/switches-test.js
// Everything starts on; only a creator-made "off" closes a part of Aduna, and only for people who are not admins.
const assert = require('assert');
const S = require('./switches');

const step = (m) => console.log('✓', m);
const records = () => Object.create(null); // like a db collection
const [A] = S.REGISTRY.map((s) => s.id);

// ---- the registry ----
{
  assert.ok(S.REGISTRY.length >= 1 && new Set(S.REGISTRY.map((s) => s.id)).size === S.REGISTRY.length, 'ids are unique');
  assert.ok(S.REGISTRY.every((s) => /^[a-z0-9-]+$/.test(s.id) && s.name && s.desc && s.paused), 'every switch has a plain id, a name, a description and a message');
  assert.ok(S.known('payments'));
  step('the registry is well formed and has payments');
}

// ---- everything starts on ----
{
  const r = records();
  assert.strictEqual(S.isOff(r, A), false);
  assert.strictEqual(S.closed(r, A, false), false, 'on: closed for nobody');
  assert.deepStrictEqual(S.offIds(r), []);
  assert.ok(S.list(r).every((s) => s.on === true && s.at === null && s.by === null));
  assert.strictEqual(S.isOff(undefined, A), false, 'no records at all: on');
  assert.strictEqual(S.isOff(null, A), false);
  step('every switch starts on, for everyone');
}

// ---- off closes it for the public, never for admins ----
{
  const r = records();
  const x = S.set(r, A, false, 'nathan', 100);
  assert.deepStrictEqual(x, { ok: true, changed: true, on: false });
  assert.deepStrictEqual(r[A], { id: A, on: false, at: 100, by: 'nathan' });
  assert.strictEqual(S.closed(r, A, false), true, 'closed for a normal account');
  assert.strictEqual(S.closed(r, A, undefined), true, 'only an explicit true is let through');
  assert.strictEqual(S.closed(r, A, 'yes'), true, 'a truthy string is not an admin');
  assert.strictEqual(S.closed(r, A, true), false, 'an admin or creator is never closed out');
  assert.deepStrictEqual(S.offIds(r), [A]);
  const row = S.list(r).find((s) => s.id === A);
  assert.strictEqual(row.on, false); assert.strictEqual(row.at, 100); assert.strictEqual(row.by, 'nathan');
  step('off closes a part for the public and never for admins');
}

// ---- turning it back on, and repeating a move ----
{
  const r = records();
  S.set(r, A, false, 'a', 1);
  const again = S.set(r, A, false, 'b', 2);
  assert.deepStrictEqual(again, { ok: true, changed: false, on: false });
  assert.deepStrictEqual(r[A], { id: A, on: false, at: 1, by: 'a' }, 'repeating keeps who turned it off, and when');
  const back = S.set(r, A, true, 'b', 3);
  assert.deepStrictEqual(back, { ok: true, changed: true, on: true });
  assert.strictEqual(S.closed(r, A, false), false, 'on again: open for everyone at once');
  assert.deepStrictEqual(r[A], { id: A, on: true, at: 3, by: 'b' }, 'the last real change is kept');
  const on2 = S.set(r, A, true, 'c', 4);
  assert.ok(on2.ok && on2.changed === false && r[A].at === 3, 'turning on what is on changes nothing');
  assert.strictEqual(S.set(records(), A, true, 'x', 1).changed, false, 'a switch nobody touched is already on');
  step('turning it back on opens it again, and repeating a move changes nothing');
}

// ---- refusals, damaged records and hostile input ----
{
  const r = records();
  for (const [id, on, status] of [['nope', false, 404], ['__proto__', false, 404], ['constructor', false, 404], [undefined, false, 404], [{}, false, 404], [A, 'off', 400], [A, undefined, 400], [A, 0, 400], [A, null, 400]]) {
    const x = S.set(r, id, on, 'u', 1);
    assert.ok(!x.ok && x.status === status, JSON.stringify([id, on]) + ' -> ' + JSON.stringify(x));
  }
  assert.deepStrictEqual(Object.keys(r), [], 'a refusal writes nothing');
  assert.strictEqual(S.isOff({ [A]: { on: 'false' } }, A), false, 'a damaged record is on');
  assert.strictEqual(S.isOff({ [A]: null }, A), false);
  assert.strictEqual(S.isOff({ [A]: {} }, A), false);
  assert.strictEqual(S.isOff({ [A]: { on: false } }, A), true);
  assert.strictEqual(S.isOff({ toString: { on: false } }, 'toString'), false, 'a prototype name is not a switch');
  assert.strictEqual(S.isOff({ ghost: { on: false } }, 'ghost'), false, 'an unknown id is never off');
  assert.deepStrictEqual(S.offIds({ ghost: { on: false } }), [], 'and is not listed');
  assert.ok(typeof S.pausedMessage(A) === 'string' && S.pausedMessage(A).length > 0);
  assert.ok(S.pausedMessage('nope').length > 0, 'an unknown id still gets a plain message');
  const long = S.set(records(), A, false, 'x'.repeat(500), NaN);
  assert.ok(long.ok); // the name is clipped and a missing time falls back to now
  step('unknown switches, bad values and damaged records are refused or read as on');
}

console.log('switches: all passed');
