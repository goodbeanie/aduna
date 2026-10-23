// The credits shop, without a database: node server/shop-test.js
const assert = require('assert');
const C = require('./credits');
const S = require('./shop');

const T0 = Date.UTC(2026, 9, 23, 12, 0, 0);
const user = (id = 'u1') => ({ id, createdAt: T0 - 86_400_000 });
const step = (m) => console.log('✓', m);

// ---- the catalogue ----
{
  assert.ok(S.ITEMS.length >= 5);
  assert.strictEqual(new Set(S.ITEMS.map((i) => i.id)).size, S.ITEMS.length, 'item ids are unique');
  assert.strictEqual(new Set(S.ITEMS.map((i) => i.name.toLowerCase())).size, S.ITEMS.length, 'item names are unique');
  for (const i of S.ITEMS) {
    assert.ok(Number.isInteger(i.price) && i.price > 0, i.id + ' has a whole, positive price');
    assert.ok(i.emoji && /^#[0-9a-f]{6}$/i.test(i.color), i.id + ' has an emoji and a colour');
    assert.ok(!i.builtin, 'a builtin badge would be drawn with the Creator picture');
    assert.ok(Array.from(i.name).length <= 24, i.id + ' name fits the badge limit');
  }
  step('catalogue: unique ids and names, whole positive prices, an emoji on a colour');
}

// ---- buying ----
{
  const u = user(), item = S.ITEMS[0];
  assert.strictEqual(S.view(u).every((i) => i.owned === false), true);
  let r = S.buy(u, item.id, C.spend, { now: T0 });
  assert.deepStrictEqual([r.status, r.error], [402, 'Not enough credits'], 'nothing to spend with');
  assert.strictEqual(u.shopBadges, undefined, 'a refused purchase gives nothing');
  assert.strictEqual(C.acct(u).balance, 0);

  C.grant(u, item.price + 25, 'quest', { now: T0 });
  r = S.buy(u, item.id, C.spend, { now: T0 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(C.acct(u).balance, 25, 'the price is taken');
  assert.strictEqual(u.credits.spent, item.price);
  assert.deepStrictEqual(u.shopBadges, [item.id]);
  assert.strictEqual(u.credits.ledger[0].reason, 'shop');
  assert.strictEqual(u.credits.ledger[0].amount, -item.price);
  assert.strictEqual(u.credits.ledger[0].note, item.name);
  assert.strictEqual(S.view(u).find((i) => i.id === item.id).owned, true);
  step('buying takes the price, gives the badge and writes a ledger line');

  const before = C.acct(u).balance;
  r = S.buy(u, item.id, C.spend, { now: T0 });
  assert.deepStrictEqual([r.status, r.error], [409, 'You already own this']);
  assert.strictEqual(C.acct(u).balance, before, 'a second purchase takes nothing');
  assert.deepStrictEqual(u.shopBadges, [item.id], 'and does not add a duplicate');
  step('an item can only be bought once, and the second try costs nothing');
}

// ---- bad requests, refunds, a price the browser cannot choose ----
{
  const u = user();
  C.grant(u, 5000, 'quest', { now: T0 });
  for (const bad of [undefined, null, '', 'nope', '__proto__', 'constructor', 'toString', 42, {}, ['shop-star']]) {
    const r = S.buy(u, bad, C.spend, { now: T0 });
    assert.strictEqual(r.status, 404, JSON.stringify(bad) + ' is not an item');
  }
  assert.strictEqual(C.acct(u).balance, 5000, 'unknown items cost nothing');
  step('unknown items, including prototype names, are refused and cost nothing');

  // a negative balance (after a refund) blocks the shop until it is earned back
  const v = user('u2');
  C.grant(v, 100, 'purchase', { kind: 'buy', now: T0 });
  C.claw(v, 100, 'refund', { now: T0 }); C.claw(v, 50, 'refund', { now: T0 });
  assert.strictEqual(C.acct(v).balance, -50);
  assert.strictEqual(S.buy(v, S.ITEMS[0].id, C.spend, { now: T0 }).status, 402);
  step('a balance below zero cannot shop');

  // the amount charged is always the server's price
  const w = user('u3'); C.grant(w, 1000, 'quest', { now: T0 });
  const crown = S.ITEMS.find((i) => i.id === 'shop-crown');
  assert.strictEqual(S.buy(w, crown.id, C.spend, { now: T0 }).item.price, crown.price);
  assert.strictEqual(C.acct(w).balance, 1000 - crown.price);
  step('the price taken is the catalogue price');
}

// ---- how badges show ----
{
  const u = user(); C.grant(u, 1000, 'quest', { now: T0 });
  assert.deepStrictEqual(S.badgeViews(u), []);
  S.buy(u, 'shop-star', C.spend, { now: T0 }); S.buy(u, 'shop-gem', C.spend, { now: T0 });
  const views = S.badgeViews(u);
  assert.deepStrictEqual(views.map((b) => b.id), ['shop-star', 'shop-gem']);
  assert.ok(views.every((b) => b.name && b.emoji && b.color && b.image === null && !b.builtin));
  // junk in the stored list (a removed item, a wrong type) is ignored
  assert.deepStrictEqual(S.badgeViews({ shopBadges: ['shop-star', 'gone', 7, null] }).map((b) => b.id), ['shop-star']);
  assert.deepStrictEqual(S.badgeViews({ shopBadges: 'shop-star' }), []);
  assert.deepStrictEqual(S.badgeViews({}), []);
  step('owned shop badges show as ordinary badges; junk in the stored list is ignored');
}

// ---- the credits page and the route ----
{
  const u = user(); C.grant(u, 300, 'quest', { now: T0 });
  const v = C.view(u, { users: {}, servers: {}, friendships: {}, emojis: {} }, { purchases: false, now: T0 });
  assert.ok(Array.isArray(v.shop) && v.shop.length === S.ITEMS.length, 'the credits view carries the shop');

  const routes = {};
  const app = { get: (p, ...h) => { routes['GET ' + p] = h[h.length - 1]; }, post: (p, ...h) => { routes['POST ' + p] = h[h.length - 1]; } };
  const db = { users: { u1: u }, servers: {}, friendships: {}, emojis: {}, payments: {} };
  const calls = { save: 0, notify: [], changed: 0 };
  C.register(app, { auth: (_q, _r, n) => n(), ah: (f) => f, db: () => db, save: () => { calls.save++; }, notify: (id, p) => calls.notify.push([id, p]), userChanged: () => { calls.changed++; } });
  const buy = routes['POST /api/credits/shop/:id/buy'];
  assert.ok(buy, 'the buy route exists');
  const res = () => { const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };

  let r = res(); buy({ user: u, params: { id: 'shop-star' } }, r);
  assert.strictEqual(r.code, 200); assert.strictEqual(r.body.bought, 'Star'); assert.strictEqual(r.body.balance, 200);
  assert.strictEqual(r.body.shop.find((i) => i.id === 'shop-star').owned, true);
  assert.deepStrictEqual([calls.save, calls.changed], [1, 1], 'saved, and the badge pushed to everyone who sees the person');
  assert.deepStrictEqual(calls.notify[0], ['u1', { balance: 200, delta: -100, reason: 'shop' }]);

  r = res(); buy({ user: u, params: { id: 'shop-star' } }, r);
  assert.strictEqual(r.code, 409); assert.strictEqual(calls.save, 1, 'a refused purchase saves nothing');
  r = res(); buy({ user: u, params: { id: 'shop-crown' } }, r);
  assert.strictEqual(r.code, 402);
  r = res(); buy({ user: u, params: { id: 'zzz' } }, r);
  assert.strictEqual(r.code, 404);
  assert.strictEqual(calls.notify.length, 1, 'only the real purchase notified');
  step('route: buys once, saves, notifies, refuses repeats, too-expensive items and unknown ones');
}

console.log('shop tests passed');
