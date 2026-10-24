// Run: node server/profilethemes-test.js
const assert = require('assert');
const P = require('./profilethemes');
const credits = require('./credits');

const step = (m) => console.log('ok -', m);
const user = () => ({ id: 'u1', credits: { balance: 0 } });
const spendFor = () => credits.spend; // profilethemes.buy calls spend(u, price, reason, opts) itself

{
  const u = user();
  const v = P.view(u);
  assert.strictEqual(v.length, P.THEMES.length);
  assert.ok(v.filter((t) => t.price === 0).every((t) => t.owned), 'free themes are owned by everybody');
  assert.ok(v.filter((t) => t.price > 0).every((t) => !t.owned), 'paid themes are not owned at first');
  assert.ok(P.THEMES.every((t) => t.colors.length >= 2 && Number.isFinite(t.angle)), 'every theme has a gradient');
  assert.strictEqual(new Set(P.THEMES.map((t) => t.id)).size, P.THEMES.length, 'ids are unique');
  step('profile themes: catalog, free ones owned by everybody');
}

{
  const u = user();
  assert.deepStrictEqual(P.wear(u, 'sunrise'), { ok: true });
  assert.strictEqual(P.wornId(u), 'sunrise');
  assert.strictEqual(P.wear(u, 'neon').status, 403, 'cannot wear a theme you have not bought');
  assert.strictEqual(P.wear(u, 'nope').status, 400);
  assert.strictEqual(P.wear(u, { x: 1 }).status, 400, 'junk is refused');
  assert.strictEqual(P.wornId(u), 'sunrise', 'a refused change changes nothing');
  assert.deepStrictEqual(P.wear(u, null), { ok: true });
  assert.strictEqual(P.wornId(u), null, 'null takes it off');
  step('profile themes: wearing needs ownership, junk is refused, null clears');
}

{
  const u = user();
  const price = P.byId('aurora').price;
  assert.strictEqual(P.buy(u, 'aurora', spendFor(u)).status, 402, 'no credits, no theme');
  assert.deepStrictEqual(u.profileThemes || [], []);
  credits.grant(u, price + 50, 'purchase', { kind: 'buy' });
  const r = P.buy(u, 'aurora', spendFor(u));
  assert.ok(r.ok);
  assert.strictEqual(u.credits.balance, 50, 'the price was taken');
  assert.strictEqual(P.buy(u, 'aurora', spendFor(u)).status, 409, 'cannot buy twice');
  assert.strictEqual(u.credits.balance, 50, 'and nothing more is taken');
  assert.strictEqual(P.buy(u, 'sunrise', spendFor(u)).status, 400, 'free themes are not sold');
  assert.strictEqual(P.buy(u, 'nope', spendFor(u)).status, 404);
  assert.deepStrictEqual(P.wear(u, 'aurora'), { ok: true });
  assert.strictEqual(P.wornId(u), 'aurora');
  u.profileThemes = []; // e.g. a theme taken away: it stops showing on the profile
  assert.strictEqual(P.wornId(u), null, 'a theme you no longer own is not shown');
  step('profile themes: buying takes the price once, ownership is required to show it');
}

console.log('profile themes tests passed');
