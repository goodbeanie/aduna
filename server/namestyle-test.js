// Run: node server/namestyle-test.js
const assert = require('assert');
const N = require('./namestyle');

const step = (m) => console.log('ok -', m);

{
  assert.ok(N.FONTS.length >= 2 && new Set(N.FONTS).size === N.FONTS.length, 'font ids are unique');
  for (const id of N.FONTS) assert.strictEqual(N.cleanFont(id), id);
  for (const bad of [undefined, null, '', 'Comic Sans', 'SERIF', 7, {}, ['serif'], 'serif; color:red', "x'}body{display:none"]) {
    assert.strictEqual(N.cleanFont(bad), null, 'only a known font id passes: ' + JSON.stringify(bad));
  }
  step('name styles: only known font ids pass');
}

{
  const g = N.cleanGradient({ colors: ['#FF7A59', '#6a88ff'], angle: 450 });
  assert.deepStrictEqual(g, { colors: ['#ff7a59', '#6a88ff'], angle: 90 }, 'colours are lower-cased and the angle wraps');
  assert.deepStrictEqual(N.cleanGradient({ colors: ['#000000', '#ffffff', '#ff0000'], angle: -90 }), { colors: ['#000000', '#ffffff', '#ff0000'], angle: 270 }, 'three colours, negative angle');
  assert.strictEqual(N.cleanGradient({ colors: ['#000000', '#ffffff'], angle: 12.6 }).angle, 13, 'the angle is rounded');
  const bad = [undefined, null, 'x', {}, { colors: 'ab' }, { colors: ['#ffffff'], angle: 0 }, { colors: Array(4).fill('#ffffff'), angle: 0 },
    { colors: ['#ffffff', 'red'], angle: 0 }, { colors: ['#ffffff', '#fff'], angle: 0 }, { colors: ['#ffffff', { a: 1 }], angle: 0 },
    { colors: ['#ffffff', '#000000'], angle: 'x' }, { colors: ['#ffffff', '#000000'], angle: Infinity }, { colors: ['#ffffff', '#000000;background:url(x)'], angle: 0 }];
  for (const b of bad) assert.strictEqual(N.cleanGradient(b), null, 'a name gradient needs 2 or 3 real colours and an angle: ' + JSON.stringify(b));
  step('name styles: gradients are validated and cleaned (2 or 3 colours, a number angle)');
}

{
  const u = { id: 'u1' };
  assert.deepStrictEqual(N.view(u), { nameFont: null, nameGradient: null }, 'nothing set: the app font and the plain colour');
  N.apply(u, { nameFont: 'serif', nameGradient: { colors: ['#ff0000', '#0000ff'], angle: 90 } });
  assert.deepStrictEqual(N.view(u), { nameFont: 'serif', nameGradient: { colors: ['#ff0000', '#0000ff'], angle: 90 } });

  N.apply(u, {});
  assert.strictEqual(u.nameFont, 'serif', 'a request without the fields leaves them alone');
  N.apply(u, { nameFont: 'nope', nameGradient: { colors: ['#ff0000'], angle: 0 } });
  assert.strictEqual(u.nameFont, 'serif', 'junk is ignored, not stored and not a way to clear');
  assert.deepStrictEqual(u.nameGradient, { colors: ['#ff0000', '#0000ff'], angle: 90 });

  N.apply(u, { nameGradient: null });
  assert.ok(!('nameGradient' in u), 'null takes the gradient off');
  assert.strictEqual(u.nameFont, 'serif', 'and leaves the font');
  N.apply(u, { nameFont: '' });
  assert.ok(!('nameFont' in u), 'an empty font takes the font off');
  N.apply(u, { nameFont: null });
  assert.deepStrictEqual(N.view(u), { nameFont: null, nameGradient: null });

  const junk = { id: 'u2', nameFont: 'Comic Sans', nameGradient: { colors: ['nope', 'nope'], angle: 0 } }; // a bad record shows nothing
  assert.deepStrictEqual(N.view(junk), { nameFont: null, nameGradient: null });
  step('name styles: apply() sets, keeps, clears and ignores junk; view() never shows junk');
}

console.log('name style tests passed');
