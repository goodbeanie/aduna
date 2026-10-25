// Run: node server/profilethemes-test.js
const assert = require('assert');
const P = require('./profilethemes');

const step = (m) => console.log('ok -', m);
const user = () => ({ id: 'u1' });

{
  const u = user();
  const v = P.view(u);
  const released = P.THEMES.filter(P.isReleased);
  assert.strictEqual(v.length, released.length, 'everybody sees the released themes');
  assert.ok(v.every((t) => t.owned), 'every theme you can see is yours');
  assert.ok(P.THEMES.every((t) => t.price === 0), 'nothing is for sale');
  assert.ok(v.every((t) => !('price' in t)), 'the picker is not sent prices');
  assert.ok(P.THEMES.every((t) => t.colors.length >= 2 && Number.isFinite(t.angle)), 'every theme has a gradient');
  assert.strictEqual(new Set(P.THEMES.map((t) => t.id)).size, P.THEMES.length, 'ids are unique');
  step('profile themes: catalog, all free, released ones owned by everybody');
}

{
  const u = user();
  assert.deepStrictEqual(P.wear(u, 'sunrise'), { ok: true });
  assert.strictEqual(P.wornId(u), 'sunrise');
  assert.deepStrictEqual(P.wear(u, 'glacier'), { ok: true }, 'Glacier, which used to cost credits, is free now');
  assert.strictEqual(P.wear(u, 'neon').status, 403, 'an animated theme that is not released yet cannot be worn');
  assert.strictEqual(P.wear(u, 'nope').status, 400);
  assert.strictEqual(P.wear(u, { x: 1 }).status, 400, 'junk is refused');
  assert.strictEqual(P.wornId(u), 'glacier', 'a refused change changes nothing');
  assert.deepStrictEqual(P.wear(u, null), { ok: true });
  assert.strictEqual(P.wornId(u), null, 'null takes it off');
  step('profile themes: wearing works, junk is refused, null clears');
}

{
  const animated = P.THEMES.filter((t) => t.animated && !P.isReleased(t));
  assert.ok(animated.length > 0, 'the animated themes are waiting to be launched');
  const u = user();
  assert.ok(P.view(u).every((t) => !animated.some((a) => a.id === t.id)), 'unreleased themes are hidden from the picker');
  const early = { id: 'u2', profileThemes: ['aurora'] }; // bought back when themes cost credits
  assert.ok(P.view(early).some((t) => t.id === 'aurora'), 'a person who already had it still sees it');
  assert.deepStrictEqual(P.wear(early, 'aurora'), { ok: true });
  assert.strictEqual(P.wornId(early), 'aurora');
  early.profileThemes = [];
  assert.strictEqual(P.wornId(early), null, 'without it, an unreleased theme stops showing');
  step('profile themes: animated ones stay hidden until released, early owners keep theirs');
}

{
  const u = user();
  const g = { colors: ['#FF9A8B', '#6a88ff', '#00ff99'], angle: 405 };
  assert.deepStrictEqual(P.wear(u, 'custom', g), { ok: true });
  assert.strictEqual(P.wornId(u), 'custom');
  assert.deepStrictEqual(P.customOf(u), { colors: ['#ff9a8b', '#6a88ff', '#00ff99'], angle: 45 }, 'colours are lower-cased and the angle wraps');
  const bad = [undefined, null, {}, { colors: ['#ffffff'], angle: 0 }, { colors: ['#ffffff', 'red'], angle: 0 }, { colors: ['#ffffff', '#000000'], angle: 'x' },
    { colors: Array(5).fill('#ffffff'), angle: 0 }, { colors: ['#ffffff', { a: 1 }], angle: 0 }];
  for (const b of bad) {
    const v = user();
    assert.strictEqual(P.wear(v, 'custom', b).status, 400, 'a custom gradient needs 2 to 4 real colours and an angle: ' + JSON.stringify(b));
    assert.strictEqual(P.wornId(v), null);
  }
  assert.deepStrictEqual(P.wear(u, 'sunrise'), { ok: true });
  assert.strictEqual(P.customOf(u), null, 'a preset hides the custom gradient');
  assert.deepStrictEqual(P.wear(u, 'custom'), { ok: true }, 'the saved custom gradient comes back without sending it again');
  assert.strictEqual(P.customOf(u).angle, 45);
  u.profileGradient = { colors: ['nope'], angle: 0 }; // junk in the record shows nothing
  assert.strictEqual(P.wornId(u), null);
  step('profile themes: custom gradient is free, validated, cleaned and only shown while worn');
}

console.log('profile themes tests passed');
