// The credits shop, without a database: node server/shop-test.js
const assert = require('assert');
const C = require('./credits');
const S = require('./shop');

const T0 = Date.UTC(2026, 9, 23, 12, 0, 0);
const user = (id = 'u1') => ({ id, createdAt: T0 - 86_400_000 });
const step = (m) => console.log('✓', m);

// badges as creators make them (db().badges); only the ones with a price are for sale
const badges = () => ({
  b1: { id: 'b1', name: 'Star', desc: 'A shiny star.', emoji: '', color: '#d9a400', image: 'img-star', price: 100 },
  b2: { id: 'b2', name: 'Gem', desc: '', emoji: '\u{1F48E}', color: '#0c8599', image: null, price: 600 },
  b3: { id: 'b3', name: 'Crown', desc: 'Costs the most.', emoji: '', color: '#c2255c', image: 'img-crown', price: 1000 },
  b4: { id: 'b4', name: 'Not for sale', emoji: '', color: '#8c6b4f', image: 'img-x' },        // no price
  b5: { id: 'b5', name: 'Free?', emoji: '', color: '#8c6b4f', image: 'img-y', price: 0 },        // a zero price is not a sale
  b6: { id: 'b6', name: 'Odd price', emoji: '', color: '#8c6b4f', image: 'img-z', price: 12.5 }, // neither is a fraction
});

// ---- the catalogue ----
{
  const u = user(), list = S.view(u, badges());
  assert.deepStrictEqual(list.map((i) => i.id), ['b1', 'b2', 'b3'], 'only priced badges, cheapest first');
  assert.ok(list.every((i) => i.owned === false && i.kind === 'badge'));
  assert.deepStrictEqual(list[0], { id: 'b1', kind: 'badge', name: 'Star', desc: 'A shiny star.', emoji: '', color: '#d9a400', image: 'img-star', price: 100, owned: false, pinned: false, daily: false, ends: null });
  assert.deepStrictEqual(S.view(u, {}), []); assert.deepStrictEqual(S.view(u), []); assert.deepStrictEqual(S.view(u, null), []);
  step('catalogue: creator badges with a whole positive price, cheapest first; no presets any more');
}

// ---- buying ----
{
  const u = user(), B = badges(), item = B.b1;
  let r = S.buy(u, item.id, C.spend, { badges: B, now: T0 });
  assert.deepStrictEqual([r.status, r.error], [402, 'Not enough credits'], 'nothing to spend with');
  assert.strictEqual(u.badges, undefined, 'a refused purchase gives nothing');
  assert.strictEqual(C.acct(u).balance, 0);

  C.grant(u, item.price + 25, 'quest', { now: T0 });
  r = S.buy(u, item.id, C.spend, { badges: B, now: T0 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(C.acct(u).balance, 25, 'the price is taken');
  assert.strictEqual(u.credits.spent, item.price);
  assert.deepStrictEqual(u.badges, [item.id], 'the badge is held like one a creator gave');
  assert.strictEqual(u.credits.ledger[0].reason, 'shop');
  assert.strictEqual(u.credits.ledger[0].amount, -item.price);
  assert.strictEqual(u.credits.ledger[0].note, item.name);
  assert.strictEqual(S.view(u, B).find((i) => i.id === item.id).owned, true);
  step('buying takes the price, gives the badge and writes a ledger line');

  const before = C.acct(u).balance;
  r = S.buy(u, item.id, C.spend, { badges: B, now: T0 });
  assert.deepStrictEqual([r.status, r.error], [409, 'You already own this']);
  assert.strictEqual(C.acct(u).balance, before, 'a second purchase takes nothing');
  assert.deepStrictEqual(u.badges, [item.id], 'and does not add a duplicate');
  step('a badge can only be bought once, and the second try costs nothing');

  // one a creator already gave counts as owned too
  const g = user('g'); g.badges = ['b2']; C.grant(g, 5000, 'quest', { now: T0 });
  assert.strictEqual(S.buy(g, 'b2', C.spend, { badges: B, now: T0 }).status, 409);
  assert.strictEqual(S.view(g, B).find((i) => i.id === 'b2').owned, true);
  step('a badge a creator gave you shows as owned and cannot be bought again');
}

// ---- bad requests, refunds, a price the browser cannot choose ----
{
  const u = user(), B = badges();
  C.grant(u, 5000, 'quest', { now: T0 });
  for (const bad of [undefined, null, '', 'nope', '__proto__', 'constructor', 'toString', 42, {}, ['b1'], 'b4', 'b5', 'b6']) {
    const r = S.buy(u, bad, C.spend, { badges: B, now: T0 });
    assert.strictEqual(r.status, 404, JSON.stringify(bad) + ' is not for sale');
  }
  assert.strictEqual(C.acct(u).balance, 5000, 'unknown and unpriced badges cost nothing');
  assert.strictEqual(u.badges, undefined);
  step('unknown ids, prototype names and badges without a proper price are refused and cost nothing');

  // a negative balance (after a refund) blocks the shop until it is earned back
  const v = user('u2');
  C.grant(v, 100, 'purchase', { kind: 'buy', now: T0 });
  C.claw(v, 100, 'refund', { now: T0 }); C.claw(v, 50, 'refund', { now: T0 });
  assert.strictEqual(C.acct(v).balance, -50);
  assert.strictEqual(S.buy(v, 'b1', C.spend, { badges: B, now: T0 }).status, 402);
  step('a balance below zero cannot shop');

  // the amount charged is always the server's price, even if a creator changes it later
  const w = user('u3'); C.grant(w, 1000, 'quest', { now: T0 });
  assert.strictEqual(S.buy(w, 'b3', C.spend, { badges: B, now: T0 }).item.price, 1000);
  assert.strictEqual(C.acct(w).balance, 0);
  const x = user('u4'); C.grant(x, 1000, 'quest', { now: T0 }); B.b3.price = 400;
  S.buy(x, 'b3', C.spend, { badges: B, now: T0 });
  assert.strictEqual(C.acct(x).balance, 600, 'the price at the moment of buying is charged');
  B.b3.price = null;
  assert.strictEqual(S.buy(user('u5'), 'b3', C.spend, { badges: B, now: T0 }).status, 404, 'a badge taken off sale cannot be bought');
  step('the price taken is the badge price; taking a badge off sale closes the sale');

  // nobody can hold more than the limit
  const h = user('u6'); h.badges = Array.from({ length: S.MAX_HELD }, (_, i) => 'x' + i); C.grant(h, 5000, 'quest', { now: T0 });
  const r = S.buy(h, 'b1', C.spend, { badges: B, now: T0 });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(C.acct(h).balance, 5000, 'a refused purchase takes nothing');
  step('the badge limit is checked before any credits are taken');
}

// ---- how the old preset badges still show for the people who bought them ----
{
  assert.deepStrictEqual(S.badgeViews({}), []);
  const views = S.badgeViews({ shopBadges: ['shop-star', 'gone', 7, null, 'shop-gem'] });
  assert.deepStrictEqual(views.map((b) => b.id), ['shop-star', 'shop-gem'], 'junk in the stored list is ignored');
  assert.ok(views.every((b) => b.name && b.emoji && b.color && b.image === null && !b.builtin));
  assert.deepStrictEqual(S.badgeViews({ shopBadges: 'shop-star' }), []);
  step('the old preset badges are not sold, but people who bought one keep it');
}

// ---- the credits page and the route ----
{
  const u = user(); C.grant(u, 300, 'quest', { now: T0 });
  const B = badges();
  const v = C.view(u, { users: {}, servers: {}, friendships: {}, emojis: {}, badges: B }, { purchases: false, now: T0 });
  assert.deepStrictEqual(v.shop.map((i) => i.id), ['b1', 'b2', 'b3'], 'the credits view carries the shop');

  const routes = {};
  const app = { get: (p, ...h) => { routes['GET ' + p] = h[h.length - 1]; }, post: (p, ...h) => { routes['POST ' + p] = h[h.length - 1]; } };
  const db = { users: { u1: u }, servers: {}, friendships: {}, emojis: {}, payments: {}, badges: B };
  const calls = { save: 0, notify: [], changed: 0 };
  C.register(app, { auth: (_q, _r, n) => n(), ah: (f) => f, db: () => db, save: () => { calls.save++; }, notify: (id, p) => calls.notify.push([id, p]), userChanged: () => { calls.changed++; } });
  const buy = routes['POST /api/credits/shop/:id/buy'];
  assert.ok(buy, 'the buy route exists');
  const res = () => { const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };

  let r = res(); buy({ user: u, params: { id: 'b1' } }, r);
  assert.strictEqual(r.code, 200); assert.strictEqual(r.body.bought, 'Star'); assert.strictEqual(r.body.balance, 200);
  assert.strictEqual(r.body.shop.find((i) => i.id === 'b1').owned, true);
  assert.deepStrictEqual(u.badges, ['b1']);
  assert.deepStrictEqual([calls.save, calls.changed], [1, 1], 'saved, and the badge pushed to everyone who sees the person');
  assert.deepStrictEqual(calls.notify[0], ['u1', { balance: 200, delta: -100, reason: 'shop' }]);

  r = res(); buy({ user: u, params: { id: 'b1' } }, r);
  assert.strictEqual(r.code, 409); assert.strictEqual(calls.save, 1, 'a refused purchase saves nothing');
  r = res(); buy({ user: u, params: { id: 'b3' } }, r);
  assert.strictEqual(r.code, 402);
  r = res(); buy({ user: u, params: { id: 'zzz' } }, r);
  assert.strictEqual(r.code, 404);
  assert.strictEqual(calls.notify.length, 1, 'only the real purchase notified');
  step('route: buys once, saves, notifies, refuses repeats, too-expensive badges and unknown ones');
}

// ---- end dates ----
{
  const u = user(), B = badges();
  B.b1.shopEnds = T0 + 1000;
  const at = (now, o) => S.view(u, B, { now, ...o });
  assert.strictEqual(at(T0).find((i) => i.id === 'b1').ends, T0 + 1000, 'the end time is shown');
  assert.ok(!at(T0 + 1000).some((i) => i.id === 'b1'), 'the badge leaves the shop at its end time');
  assert.strictEqual(at(T0 + 1000, { all: true }).find((i) => i.id === 'b1').state, 'ended', 'the creator still sees it, marked ended');
  C.grant(u, 5000, 'quest', { now: T0 });
  assert.strictEqual(S.buy(u, 'b1', C.spend, { badges: B, now: T0 + 1000 }).status, 404, 'an ended badge cannot be bought');
  assert.strictEqual(C.acct(u).balance, 5000, 'and costs nothing');
  assert.strictEqual(S.buy(u, 'b1', C.spend, { badges: B, now: T0 }).ok, true, 'before the end time it can');
  B.b1.shopEnds = null; assert.ok(at(T0 + 5000).some((i) => i.id === 'b1'), 'clearing the date puts it back');
  B.b1.shopEnds = 'soon'; assert.ok(at(T0 + 5000).some((i) => i.id === 'b1'), 'a junk end date is ignored');
  step('end dates: the badge leaves the shop on time, cannot be bought after, and the creator can bring it back');
}

// ---- pins and the daily shop ----
{
  const u = user(), B = {};
  for (let i = 0; i < 8; i++) B['d' + i] = { id: 'd' + i, name: 'Daily ' + i, price: 10 + i, daily: true };
  const ids = (now, o) => S.view(u, B, { now, ...o }).map((i) => i.id);

  assert.strictEqual(ids(T0).length, S.DAILY_MAX, 'eight daily badges, but only five show');
  assert.deepStrictEqual(ids(T0), ids(T0 + 3_600_000), 'the same five all day');
  const sets = new Set(); for (let k = 0; k < 10; k++) sets.add(ids(T0 + k * 86_400_000).join());
  assert.ok(sets.size > 1, 'the picks change from day to day');
  const all = S.view(u, B, { now: T0, all: true });
  assert.deepStrictEqual([all.length, all.filter((i) => i.state === 'live').length, all.filter((i) => i.state === 'resting').length], [8, 5, 3], 'the creator sees all eight');
  assert.deepStrictEqual(S.info(T0), { dailyMax: 5, resetsAt: Date.UTC(2026, 9, 24) }, 'picks change at midnight UTC');

  C.grant(u, 10_000, 'quest', { now: T0 });
  const resting = all.find((i) => i.state === 'resting').id, live = all.find((i) => i.state === 'live').id;
  assert.strictEqual(S.buy(u, resting, C.spend, { badges: B, now: T0 }).status, 404, 'a resting daily badge cannot be bought');
  assert.strictEqual(C.acct(u).balance, 10_000);
  assert.strictEqual(S.buy(u, live, C.spend, { badges: B, now: T0 }).ok, true, 'one of today\u2019s picks can');

  B[resting].pinned = true;
  assert.strictEqual(ids(T0).length, S.DAILY_MAX + 1, 'a pinned badge is always shown and does not use up a daily slot');
  assert.strictEqual(ids(T0)[0], resting, 'pinned badges come first');
  assert.strictEqual(S.buy(user('p'), resting, C.spend, { badges: B, now: T0 }).status, 402, 'a pinned daily badge is on sale (this person just has no credits)');

  const regular = { id: 'r1', name: 'Regular', price: 5 };
  B.r1 = regular;
  assert.ok(ids(T0).includes('r1'), 'badges that are not daily are always shown');
  for (const k of Object.keys(B)) B[k].shopEnds = T0 + 1;
  assert.deepStrictEqual(ids(T0 + 2), [], 'ended badges are never picked');
  step('pin and daily: five shown a day out of any number, the same for everyone, pinned first, resting ones cannot be bought');
}

// ---- the credits view for players and for the creator ----
{
  const u = user(); const B = badges(); B.b2.daily = true; B.b3.pinned = true;
  const db = { users: {}, servers: {}, friendships: {}, emojis: {}, badges: B };
  const player = C.view(u, db, { purchases: false, now: T0 });
  assert.strictEqual(player.shop[0].id, 'b3', 'pinned first');
  assert.ok(player.shop.every((i) => i.state === undefined), 'players do not get the creator state');
  assert.deepStrictEqual(player.shopInfo, { dailyMax: 5, resetsAt: Date.UTC(2026, 9, 24) });
  const creator = C.view(u, db, { purchases: false, now: T0, creator: true });
  assert.ok(creator.shop.every((i) => ['live', 'resting', 'ended'].includes(i.state)));
  step('credits view: players see what is on show; the creator also sees each badge\u2019s state');
}

console.log('shop tests passed');
