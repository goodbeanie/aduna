// Supporter ranks (Spark, Plus, Premium) and what they pay, without a server: node server/supporter-test.js
const assert = require('assert');
const S = require('./supporter');
const C = require('./credits');

const MIN = 60_000, DAY = 86_400_000, T0 = Date.UTC(2026, 10, 25, 12, 0, 0);
const step = (m) => console.log('✓', m);
const user = (id = 'u1', extra = {}) => ({ id, createdAt: T0 - 24 * 60 * MIN, bio: '', ...extra });
const server = { id: 's1', members: ['u1', 'u2', 'u3'] };
const chan = { id: 'c1', type: 'text' };
const good = (n) => ({ t: n + 5, p: 0, ms: n * 150, ev: n, j: 60 });

// ---- which rank someone shows ----
{
  const u = user();
  assert.strictEqual(S.rankOf(u, { now: T0 }), null, 'nobody has a rank by default');
  assert.strictEqual(S.rankOf(u, { plan: 'plus', now: T0 }), 'plus', 'the storage plan is Plus');
  assert.strictEqual(S.rankOf(u, { plan: 'spark', now: T0 }), 'spark', 'a Spark subscription is Spark');
  assert.deepStrictEqual(S.grant(u, 'spark', 30, T0), { ok: true, until: T0 + 30 * DAY });
  assert.strictEqual(S.rankOf(u, { now: T0 + DAY }), 'spark');
  assert.strictEqual(S.rankOf(u, { plan: 'plus', now: T0 + DAY }), 'plus', 'Plus is above Spark');
  S.grant(u, 'premium', 30, T0);
  assert.strictEqual(S.rankOf(u, { plan: 'plus', now: T0 + DAY }), 'premium', 'Premium is above Plus');
  assert.strictEqual(S.rankOf(user(), { plan: 'premium', now: T0 }), 'premium', 'a paid Premium subscription');
  assert.strictEqual(S.rankOf(u, { now: T0 + 31 * DAY }), null, 'it ends with the paid time');
  assert.strictEqual(S.rankOf({ ...u, bot: true }, { now: T0 }), null, 'bots have none');
  step('the highest rank wins, and a rank ends when its time does');
}

// ---- granting ----
{
  const u = user();
  S.grant(u, 'spark', 10, T0);
  assert.strictEqual(S.grant(u, 'spark', 5, T0 + DAY).until, T0 + 15 * DAY, 'more time adds to what is left');
  assert.strictEqual(S.grant(u, 'premium', 5, T0 + DAY).until, T0 + 6 * DAY, 'a different rank starts from now');
  for (const bad of [['plus', 5], ['gold', 5], ['spark', 0], ['spark', 1.5], ['spark', 400], ['spark', NaN]]) assert.strictEqual(S.grant(u, ...bad, T0).ok, false, bad.join(' '));
  assert.strictEqual(S.revoke(u), true);
  assert.strictEqual(S.revoke(u), false);
  assert.strictEqual(u.supporter, undefined);
  step('grant adds time, rejects bad input, and revoke clears it');
}

// ---- perks and badges ----
{
  const u = user();
  S.grant(u, 'premium', 30, T0);
  const o = { now: T0 + DAY };
  assert.strictEqual(S.hasPlusPerks(u, o), true, 'Premium has the Plus perks');
  S.grant(u, 'spark', 30, T0);
  assert.strictEqual(S.hasPlusPerks(u, o), false, 'Spark does not');
  assert.strictEqual(S.hasPlusPerks(user(), { plan: 'plus', now: T0 }), true);
  assert.strictEqual(S.hasPlusPerks(user(), { plan: 'spark', now: T0 }), false, 'a paid Spark has no Plus perks either');
  assert.deepStrictEqual([S.rateOf(u, o), S.rateOf(user(), { plan: 'plus', now: T0 }), S.rateOf(user(), { plan: 'premium', now: T0 }), S.rateOf(user(), { now: T0 })], [1.1, 1.5, 1.75, undefined]);
  const b = S.badgeViews(u, o);
  assert.deepStrictEqual(b.map((x) => [x.id, x.glyph, x.rank, x.name]), [['supporter', 'supporter', 'spark', 'Aduna Spark']]);
  assert.deepStrictEqual(S.badgeViews(user(), { now: T0 }), []);
  step('Premium has the Plus perks, Spark does not, and the badge names the rank');
}

// ---- credits ----
const syl = [...'bdgklmnp'].flatMap((c) => [...'aeiou'].map((v) => c + v));
const word = (n) => syl[n % 40] + syl[Math.floor(n / 40) % 40] + syl[(n * 13 + 5) % 40];
const sentence = (i) => [0, 1, 2, 3, 4].map((j) => word(i * 5 + j + 1)).join(' ');
function messages(count, opts) {
  C._reset();
  const u = user();
  const pays = [];
  let at = T0;
  for (let i = 0; i < count; i++) {
    at += 50_000;
    C.noteChannelMessage(chan.id, 'u2', at);
    const text = sentence(i);
    const r = C.rewardMessage({ user: u, content: text, proof: good(C.normalize(text).length), server, channel: chan, now: at, ...opts });
    assert.strictEqual(r.ok, true, 'message ' + i + ': ' + r.reason);
    pays.push(r.amount);
  }
  return { u, pays, total: pays.reduce((a, b) => a + b, 0) };
}
{
  assert.deepStrictEqual(messages(4, {}).pays, [2, 2, 2, 2], 'no rank: 2 credits');
  assert.deepStrictEqual(messages(4, { plus: true }).pays, [3, 3, 3, 3], 'Plus without a rate still pays 1.5x');
  const spark = messages(10, { rate: 1.1 });
  assert.strictEqual(spark.total, 22, 'Spark: 2.2 a message adds up to 22 over 10 messages, not 20');
  assert.ok(spark.pays.every((n) => n === 2 || n === 3));
  assert.ok(Math.abs(spark.u.credits.frac || 0) < 0.5, 'the leftover is under half a credit');
  const premium = messages(10, { plus: true, rate: 1.75 });
  assert.strictEqual(premium.total, 35, 'Premium: 3.5 a message');
  assert.strictEqual(messages(10, { plus: true, rate: 1.5 }).u.credits.frac, undefined, 'whole credits leave nothing behind');
  step('messages pay the rank rate; the part of a credit that does not fit is carried to the next message');
}
{
  const sparkMsgs = messages(20, { rate: 1.1 });
  const plain = messages(20, {});
  assert.strictEqual(plain.total, 40);
  assert.strictEqual(sparkMsgs.total, 44, 'the extra does not count against the 40 credit daily cap');
  const next = sentence(50);
  C.noteChannelMessage(chan.id, 'u2', T0 + 20 * 50_000 + 50_000);
  assert.strictEqual(C.rewardMessage({ user: plain.u, content: next, proof: good(C.normalize(next).length), server, channel: chan, now: T0 + 20 * 50_000 + 50_000 }).reason, 'daily cap', 'the cap itself is the same');
  step('Spark keeps the free daily cap');
}
{
  C._reset();
  const u = user(), db = { users: { u1: u }, servers: { s1: { ...server, ownerId: 'u2' } }, emojis: {}, friendships: {}, payments: {} };
  const reward = (plus, rate, id = 'react') => C.questList(u, db, T0, plus, rate).find((x) => x.id === id).reward;
  assert.deepStrictEqual([reward(false), reward(false, 1.1), reward(true), reward(true, 1.75)], [6, 7, 9, 11]);
  assert.strictEqual(reward(true, 1.75, 'plusreact'), 21);
  assert.deepStrictEqual(C.questList(u, db, T0, false, 1.1).filter((x) => x.plusOnly).map((x) => x.locked), [true, true, true], 'Spark does not open the Plus-only quests');
  assert.strictEqual(C.claimQuest(u, 'checkin', db, T0, false, 1.1).amount, 11, 'check-in: 10 x 1.1');
  assert.strictEqual(C.claimQuest(u, 'pluschat', db, T0, false, 1.1).status, 403);
  step('quests pay the rank rate and Spark leaves the Plus-only quests closed');
}
