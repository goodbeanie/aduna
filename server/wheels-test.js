// Wheel rules without a database: node server/wheels-test.js
const assert = require('assert');
const W = require('./wheels');
const step = (m) => console.log('ok -', m);
const NOW = 1_000_000;
const make = (o = {}) => W.cleanWheel({ title: 'Who goes first?', options: ['Ann', 'Ben'], spinAt: NOW + 60_000, ...o }, NOW);

{
  const { wheel } = make({ title: '  Who   goes first? ', options: ['  Ann ', 'Ben', '', '   ', 'Ann'] });
  assert.strictEqual(wheel.title, 'Who goes first?');
  assert.deepStrictEqual(wheel.options, ['Ann', 'Ben', 'Ann'], 'blank rows dropped, repeats kept');
  assert.deepStrictEqual([wheel.spinAt, wheel.spunAt, wheel.winner], [NOW + 60_000, null, null], 'no winner until the time comes');
  step('a wheel is cleaned and starts without a winner');
}
{
  const many = Array.from({ length: 500 }, (_, i) => 'option ' + i);
  assert.strictEqual(make({ options: many }).wheel.options.length, 500, 'hundreds of options are fine');
  assert.match(make({ options: [...many, 'one more'] }).error, /at most 500/);
  step('a wheel takes a very long list of options');
}
{
  const bad = (o, re) => { const r = W.cleanWheel(o, NOW); assert.ok(r.error && !r.wheel, JSON.stringify(o) + ''); if (re) assert.match(r.error, re); };
  for (const x of [null, undefined, 'wheel', 5, [], true]) bad(x);
  bad({ options: ['a', 'b'], spinAt: NOW + 60_000 }, /title/);
  bad({ title: 'x'.repeat(201), options: ['a', 'b'], spinAt: NOW + 60_000 }, /200/);
  bad({ title: 't', options: ['only'], spinAt: NOW + 60_000 }, /at least 2/);
  bad({ title: 't', options: ['a', ' '], spinAt: NOW + 60_000 }, /at least 2/);
  bad({ title: 't', options: [1, 2], spinAt: NOW + 60_000 }, /options/);
  bad({ title: 't', options: ['a', 'b'.repeat(101)], spinAt: NOW + 60_000 }, /100/);
  bad({ title: 't', options: ['a', 'b'] }, /time/);
  bad({ title: 't', options: ['a', 'b'], spinAt: '5' }, /time/);
  bad({ title: 't', options: ['a', 'b'], spinAt: NaN }, /time/);
  bad({ title: 't', options: ['a', 'b'], spinAt: NOW - 1 }, /future/);
  bad({ title: 't', options: ['a', 'b'], spinAt: NOW + 1000 }, /future/);
  bad({ title: 't', options: ['a', 'b'], spinAt: NOW + 31 * 86400_000 }, /30 days/);
  step('malformed wheels are refused: title, options, and a time that is missing, past or too far away');
}
{
  const { wheel } = make();
  let picked = 0;
  const pick = (n) => { picked++; return n - 1; };
  assert.strictEqual(W.isDue(wheel, NOW + 59_999), false);
  assert.strictEqual(W.spinDue(wheel, pick, NOW + 59_999), false, 'not before the time');
  assert.strictEqual(picked, 0, 'nothing is picked early');
  assert.strictEqual(W.spinDue(wheel, pick, NOW + 60_000), true, 'at the time it spins');
  assert.deepStrictEqual([wheel.winner, wheel.spunAt], [1, NOW + 60_000]);
  assert.strictEqual(W.spinDue(wheel, pick, NOW + 120_000), false, 'it spins once');
  assert.strictEqual(picked, 1);
  assert.strictEqual(wheel.winner, 1, 'the result never changes');
  step('the winner is picked once, at the spin time, and never before');
}
{
  const { wheel } = make();
  for (const bad of [-1, 2, 1.5, NaN, '1', null]) {
    assert.strictEqual(W.spinDue(wheel, () => bad, NOW + 60_000), false, 'a bad pick is refused: ' + bad);
    assert.deepStrictEqual([wheel.winner, wheel.spunAt], [null, null], 'and changes nothing');
  }
  assert.strictEqual(W.spinDue(null, () => 0), false);
  assert.strictEqual(W.spinDue({ options: 'ab', spinAt: 0 }, () => 0), false);
  step('a bad pick or a message without a wheel changes nothing');
}
{
  const seen = new Set();
  const { wheel } = make({ options: ['a', 'b', 'c', 'd'] });
  for (let i = 0; i < 400; i++) { const w = { ...wheel }; W.spinDue(w, require('crypto').randomInt, NOW + 60_000); seen.add(w.winner); }
  assert.deepStrictEqual([...seen].sort(), [0, 1, 2, 3], 'every slice can win');
  assert.strictEqual(W.wheelPreview(wheel), 'Wheel: Who goes first?');
  assert.strictEqual(W.wheelPreview(null), '');
  step('every slice can win, and the preview line reads right');
}
console.log('wheels: all good');
