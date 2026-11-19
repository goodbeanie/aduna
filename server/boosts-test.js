// Server boosts, without a database: node server/boosts-test.js
const assert = require('assert');
const B = require('./boosts');
const C = require('./credits');

const MIN = 60_000, DAY = 24 * 60 * MIN, T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const person = (id, credits = 5000) => { const u = { id, createdAt: T0 - 30 * DAY }; if (credits) C.grant(u, credits, 'quest', { now: T0 }); return u; };
const newServer = () => ({ id: 's1', members: ['a', 'b', 'c'] });
const buy = (s, u, level, at = T0) => B.buy(s, u, level, C.spend, { now: at });
const step = (m) => console.log('ok -', m);

// ---- tiers ----
{
  assert.deepStrictEqual(B.TIERS.map((t) => [t.level, t.credits]), [[1, 1000], [2, 2000], [3, 3000]]);
  assert.strictEqual(B.DURATION_MS, 14 * DAY);
  assert.deepStrictEqual([0, 1, 2, 3].map((l) => B.perksOf(l).hdShare), [false, false, true, true]);
  assert.deepStrictEqual([0, 1, 2, 3].map((l) => B.perksOf(l).messageMultiplier), [1, 1, 1, 1.5]);
  assert.deepStrictEqual([0, 1, 2, 3].map((l) => B.perksOf(l).tag), [false, true, true, true]);
  step('three tiers, 14 days; screenshare from level 2, 1.5x messages only at level 3');
}

// ---- buying ----
{
  const s = newServer(), a = person('a');
  const r = buy(s, a, 1);
  assert.ok(r.ok);
  assert.strictEqual(C.acct(a).balance, 4000);
  assert.strictEqual(r.boost.endsAt - r.boost.startedAt, 14 * DAY);
  assert.strictEqual(B.levelOf(s, T0 + DAY), 1);
  assert.strictEqual(B.levelOf(s, T0 + 14 * DAY), 0, 'it ends after 14 days');
  assert.strictEqual(buy(s, a, 7).status, 400, 'there is no level 7');
  assert.strictEqual(buy(s, a, 0).status, 400);
  assert.strictEqual(C.acct(a).balance, 4000, 'refused buys cost nothing');
  step('a boost costs its credits, lasts 14 days, unknown levels are refused');
}

// ---- not enough credits ----
{
  const s = newServer(), a = person('a', 2999);
  const r = buy(s, a, 3);
  assert.deepStrictEqual([r.status, r.code], [402, 'not_enough_credits']);
  assert.strictEqual(C.acct(a).balance, 2999, 'nothing was taken');
  assert.strictEqual(B.levelOf(s, T0), 0, 'and nothing started');
  step('one credit short buys nothing');
}

// ---- highest level wins ----
{
  const s = newServer(), a = person('a'), b = person('b'), c = person('c');
  assert.ok(buy(s, a, 1).ok);
  assert.ok(buy(s, b, 3, T0 + DAY).ok);
  assert.strictEqual(B.levelOf(s, T0 + 2 * DAY), 3);
  const low = buy(s, c, 2, T0 + 2 * DAY);
  assert.strictEqual(low.status, 409, 'level 2 cannot start while level 3 runs');
  assert.strictEqual(buy(s, c, 1, T0 + 2 * DAY).status, 409, 'neither can level 1');
  assert.strictEqual(C.acct(c).balance, 5000);
  assert.ok(buy(s, c, 3, T0 + 2 * DAY).ok, 'another level 3 is allowed');
  step('while level 3 runs, levels 1 and 2 cannot be bought');
}

// ---- boosts do not add up ----
{
  const s = newServer();
  for (const id of ['a', 'b', 'c']) assert.ok(buy(s, person(id), 1).ok);
  assert.strictEqual(B.levelOf(s, T0 + DAY), 1, 'three level 1 boosts are still level 1');
  step('boosts never add up');
}

// ---- upgrading your own ----
{
  const s = newServer(), a = person('a');
  assert.ok(buy(s, a, 1).ok);
  assert.strictEqual(buy(s, a, 1, T0 + DAY).status, 409, 'cannot buy the same level again while it runs');
  const up = buy(s, a, 3, T0 + DAY);
  assert.ok(up.ok);
  assert.strictEqual(up.replaced.level, 1);
  assert.strictEqual(C.acct(a).balance, 5000 - 1000 - 3000, 'the full price is paid, nothing comes back for the level 1');
  assert.strictEqual(s.boosts.filter((x) => x.userId === 'a').length, 1, 'one boost per person');
  assert.strictEqual(B.levelOf(s, T0 + 2 * DAY), 3);
  assert.strictEqual(buy(s, a, 2, T0 + 2 * DAY).status, 409, 'and a lower level cannot replace a higher one');
  step('upgrading replaces your own boost at the full price');
}

// ---- tags follow each person's own boost ----
{
  const s = newServer(), a = person('a'), b = person('b');
  assert.ok(buy(s, a, 1).ok);
  assert.ok(buy(s, b, 3, T0 + 5 * DAY).ok);
  let v = B.view(s, T0 + 10 * DAY);
  assert.strictEqual(v.level, 3);
  assert.deepStrictEqual(v.boosters.map((x) => x.userId).sort(), ['a', 'b'], 'the level 1 booster keeps their tag while the level 3 runs');
  v = B.view(s, T0 + 15 * DAY);
  assert.deepStrictEqual(v.boosters.map((x) => x.userId), ['b'], 'it goes when their own boost ends');
  assert.strictEqual(v.level, 3);
  step('a hidden boost keeps running and its tag stays until its own end');
}

// ---- an ended boost can be renewed ----
{
  const s = newServer(), a = person('a');
  assert.ok(buy(s, a, 1).ok);
  assert.ok(buy(s, a, 1, T0 + 14 * DAY).ok);
  assert.strictEqual(s.boosts.length, 1, 'the old one is dropped');
  assert.strictEqual(B.levelOf(s, T0 + 20 * DAY), 1);
  step('after it ends you can renew');
}

// ---- refunds when the server is deleted ----
{
  const s = newServer(), a = person('a'), b = person('b');
  assert.ok(buy(s, a, 1).ok);
  assert.strictEqual(B.refundOf(s.boosts[0], T0), 1000, 'deleted right away: everything back');
  assert.strictEqual(B.refundOf(s.boosts[0], T0 + 3 * DAY), 785, '1000 x 11/14 = 785.7, rounded down');
  assert.strictEqual(B.refundOf(s.boosts[0], T0 + 14 * DAY), 0);
  assert.strictEqual(B.refundOf(s.boosts[0], T0 + 20 * DAY), 0, 'never negative');
  assert.strictEqual(B.refundOf(s.boosts[0], T0 + 3 * 60 * MIN), 991, 'hours count, not whole days: 3 hours used gives 1000 x 333/336 = 991');
  assert.ok(buy(s, b, 3, T0 + DAY).ok);
  const list = B.refunds(s, T0 + 3 * DAY);
  assert.deepStrictEqual(list.find((x) => x.userId === 'a'), { userId: 'a', amount: 785 }, 'a hidden level 1 is refunded by its own timer');
  assert.deepStrictEqual(list.find((x) => x.userId === 'b'), { userId: 'b', amount: Math.floor(3000 * 12 / 14) });
  assert.deepStrictEqual(B.refunds(s, T0 + 30 * DAY), [], 'ended boosts give nothing');
  step('refund = price x time left / 14 days, rounded down, from exact time, for every running boost');
}

// ---- the refund is not earned credit ----
{
  const a = person('a');
  assert.ok(buy(newServer(), a, 1).ok);
  const before = { ...C.acct(a) };
  C.grant(a, 700, 'boost_refund', { kind: 'refund', now: T0 });
  assert.strictEqual(C.acct(a).balance, before.balance + 700);
  assert.strictEqual(C.acct(a).earned, before.earned, 'not counted as earned');
  assert.strictEqual(C.acct(a).spent, before.spent - 700, 'it takes away from what was spent');
  step('refunds go back as credits without counting as earned');
}

// ---- messages pay 1.5x in a level 3 server ----
{
  const good = (n) => ({ t: n + 5, p: 0, ms: n * 150, ev: n, j: 60 });
  const chan = { id: 'c1', type: 'text' };
  const texts = ['I finally got around to fixing the garden fence yesterday', 'Honestly the tomato plants are doing better than I expected this year'];
  const send = (srv, u, text, at) => C.rewardMessage({ user: u, content: text, proof: good(C.normalize(text).length), server: { ...srv, members: ['a', 'b', 'c'] }, channel: chan, now: at });

  C._reset();
  C.noteChannelMessage(chan.id, 'b', T0 - MIN);
  const plain = person('a', 0), booster = person('c');
  const s3 = newServer(); assert.ok(buy(s3, booster, 3).ok);
  const r1 = send(newServer(), plain, texts[0], T0);
  assert.strictEqual(r1.amount, 2, 'a normal server pays 2');
  const u = person('d', 0);
  const r2 = send(s3, u, texts[1], T0);
  assert.strictEqual(r2.amount, 3, 'a level 3 server pays 3');
  assert.strictEqual(u.credits.today.msg, 2, 'only the base 2 counts against the daily cap');

  const s2 = newServer(); assert.ok(buy(s2, person('e'), 2).ok);
  assert.strictEqual(B.multiplierOf(s2, T0), 1, 'level 2 pays the normal rate');
  assert.strictEqual(B.multiplierOf(s3, T0 + 15 * DAY), 1, 'and so does a server whose boost ended');
  step('level 3 pays 1.5x on messages, the extra is not counted against the daily cap');
}

// ---- what members see ----
{
  const s = newServer(), a = person('a');
  assert.deepStrictEqual(B.view(s, T0), { level: 0, boosters: [] });
  assert.ok(buy(s, a, 2).ok);
  const info = B.info(s, 'a', T0 + DAY);
  assert.strictEqual(info.level, 2);
  assert.strictEqual(info.mine.level, 2);
  assert.strictEqual(B.info(s, 'b', T0 + DAY).mine, null);
  assert.strictEqual(info.days, 14);
  step('the server view and the boost screen show the level, the boosters and your own boost');
}

// ---- the free monthly boost for Aduna Plus ----
{
  const free = (s, u, plus, at = T0) => B.buyFree(s, u, plus, { now: at });
  const s = newServer(), a = person('a', 0);
  const none = free(s, a, false);
  assert.deepStrictEqual([none.status, none.code], [403, 'plus_only']);
  assert.strictEqual(B.levelOf(s, T0), 0, 'no Plus, no boost');

  const r = free(s, a, true);
  assert.ok(r.ok);
  assert.strictEqual(r.boost.level, 3);
  assert.strictEqual(r.boost.endsAt - r.boost.startedAt, 14 * DAY);
  assert.strictEqual(C.acct(a).balance, 0, 'no credits are taken');
  assert.strictEqual(B.levelOf(s, T0 + DAY), 3);
  assert.strictEqual(B.levelOf(s, T0 + 14 * DAY), 0, 'and it ends after 14 days');
  assert.deepStrictEqual(B.refunds(s, T0 + DAY), [], 'a free boost refunds nothing');

  const again = free(newServer(), a, true, T0 + DAY);
  assert.deepStrictEqual([again.status, again.code], [409, 'free_used']);
  assert.deepStrictEqual(B.freeState(a, true, T0 + DAY), { plus: true, used: true, resetsAt: Date.UTC(2026, 11, 1) });

  const next = free(newServer(), a, true, Date.UTC(2026, 11, 1));
  assert.ok(next.ok, 'a new month brings a new free boost');
  assert.strictEqual(B.freeState(a, true, Date.UTC(2026, 11, 2)).used, true);
  assert.strictEqual(B.freeState(person('z'), true, T0).used, false);
  step('Plus members get one free level 3 boost a month, for 14 days, at no cost');
}

// ---- the free boost and a boost you already have ----
{
  const s = newServer(), a = person('a');
  assert.ok(buy(s, a, 1).ok);
  const up = B.buyFree(s, a, true, { now: T0 + DAY });
  assert.ok(up.ok);
  assert.strictEqual(up.replaced.level, 1);
  assert.strictEqual(s.boosts.filter((x) => x.userId === 'a').length, 1, 'still one boost per person');
  assert.strictEqual(B.levelOf(s, T0 + 2 * DAY), 3);

  const t = newServer(), b = person('b');
  assert.ok(buy(t, b, 3).ok);
  const dup = B.buyFree(t, b, true, { now: T0 + DAY });
  assert.strictEqual(dup.status, 409, 'cannot use it on a server where you already have level 3');
  assert.ok(!b.freeBoostMonth, 'and the free boost is not used up by the refusal');
  step('a free boost upgrades your own lower boost and is not spent when refused');
}

console.log('boosts: all good');
