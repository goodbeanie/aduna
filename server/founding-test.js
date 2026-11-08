// The Founding Member badge and the sign-up bar, without a server: node server/founding-test.js
const assert = require('assert');
const F = require('./founding');

const step = (m) => console.log('✓', m);
const person = (id, createdAt, extra = {}) => ({ id, createdAt, ...extra });
const make = (n, extra = {}) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`u${i}`, person(`u${i}`, 1000 + i, extra)]));

// ---- the first people get numbers in order ----
{
  const users = {};
  for (let i = 1; i <= 3; i++) {
    const claim = F.claimFor(users);
    assert.deepStrictEqual(claim, { founding: i }, 'person ' + i + ' gets number ' + i);
    users['u' + i] = person('u' + i, i, claim);
  }
  assert.strictEqual(F.nextFree(users), 4);
  step('new accounts get 1, 2, 3 in order of joining');
}

// ---- the 1,001st person gets nothing ----
{
  const users = make(5);
  F.backfill(users, 5);
  assert.deepStrictEqual(F.claimFor(users, 5), {}, 'all 5 are taken');
  assert.strictEqual(F.nextFree(users, 5), null);
  const late = person('late', 9999, F.claimFor(users, 5));
  assert.deepStrictEqual(F.badgeViews(late, 5), [], 'and no badge');
  step('once the goal is reached, later accounts get no number and no badge');
}

// ---- a deleted account frees its number ----
{
  const users = make(5);
  F.backfill(users, 5);
  const gone = users.u2.founding; delete users.u2;
  assert.strictEqual(F.nextFree(users, 5), gone, 'the freed number is next');
  const again = F.claimFor(users, 5);
  assert.deepStrictEqual(again, { founding: gone });
  users.n = person('n', 5000, again);
  assert.strictEqual(new Set(Object.values(users).map((u) => u.founding)).size, 5, 'never two people with one number');
  step('a deleted account frees its number, and numbers never repeat');
}

// ---- bots are not people ----
{
  const users = { a: person('a', 1), b: person('b', 2, { bot: true }), c: person('c', 3) };
  assert.strictEqual(F.backfill(users), 2);
  assert.strictEqual(users.b.founding, undefined, 'a bot gets no number');
  assert.deepStrictEqual([users.a.founding, users.c.founding], [1, 2], 'and takes none from people');
  assert.deepStrictEqual(F.badgeViews(users.b), []);
  assert.strictEqual(F.progress(users).count, 2, 'and is not counted');
  step('bots take no number, wear no badge and do not count');
}

// ---- backfill: earliest first, up to the goal, and safe to repeat ----
{
  const users = { z: person('z', 300), y: person('y', 100), x: person('x', 200), w: person('w', 400) };
  assert.strictEqual(F.backfill(users, 3), 3);
  assert.deepStrictEqual([users.y.founding, users.x.founding, users.z.founding, users.w.founding], [1, 2, 3, undefined], 'the earliest three');
  assert.strictEqual(F.backfill(users, 3), 0, 'running it again changes nothing');
  users.v = person('v', 50); // an old account found later still cannot take a number that is already held
  assert.strictEqual(F.backfill(users, 3), 0);
  assert.strictEqual(users.v.founding, undefined);
  step('backfill numbers the earliest accounts, stops at the goal, and is safe to repeat');
}

// ---- backfill keeps numbers people already have ----
{
  const users = { a: person('a', 1, { founding: 2 }), b: person('b', 2), c: person('c', 3, { founding: 1 }) };
  F.backfill(users, 3);
  assert.deepStrictEqual([users.a.founding, users.b.founding, users.c.founding], [2, 3, 1]);
  step('numbers already given are never changed');
}

// ---- junk in the record is ignored ----
{
  const users = { a: person('a', 1, { founding: 0 }), b: person('b', 2, { founding: '3' }), c: person('c', 3, { founding: 99999 }), d: person('d', 4, { founding: 1.5 }) };
  F.backfill(users);
  assert.deepStrictEqual(Object.values(users).map((u) => u.founding).sort((p, q) => p - q), [1, 2, 3, 4], 'bad values are replaced with real numbers');
  step('a bad stored number (0, a string, too big, a fraction) is treated as no number');
}

// ---- the badge ----
{
  const [b] = F.badgeViews({ id: 'a', founding: 42 });
  assert.strictEqual(b.id, 'founding');
  assert.strictEqual(b.name, 'Founding Member #42');
  assert.strictEqual(b.src, '/badges/founding-member.png');
  assert.ok(!b.builtin, 'not drawn with the Creator picture');
  assert.deepStrictEqual(F.badgeViews({ id: 'a' }), []);
  assert.deepStrictEqual(F.badgeViews(null), []);
  step('the badge has its number in the name and its own picture');
}

// ---- the bar ----
{
  assert.deepStrictEqual(F.progress({}), { count: 0, goal: 1000, left: 1000, full: false });
  assert.deepStrictEqual(F.progress(make(412)), { count: 412, goal: 1000, left: 588, full: false });
  assert.deepStrictEqual(F.progress(make(1000)), { count: 1000, goal: 1000, left: 0, full: true });
  const over = F.progress(make(1200));
  assert.strictEqual(over.left, 0); assert.strictEqual(over.full, true);
  step('progress: head count, goal, how many are left, and whether it is full');
}

console.log('founding-test: all passed');
