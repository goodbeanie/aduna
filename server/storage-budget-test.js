'use strict';
// Free storage budget, no database needed: node server/storage-budget-test.js
const assert = require('assert');
const B = require('./storage-budget');
const cfg = B.defaults({}); // no env: $0.015 per GB, no subsidy
const MB = B.MB, GB = B.GB;

// the plan's own numbers: 500 free : 1 payer keeps the 500 MB ceiling, and the cost fits the $3.75 slice
assert.strictEqual(B.computeLimitMB({ paid: 1, free: 500 }, cfg), 500);
assert.ok(500 * 500 * MB / GB * cfg.usdPerGB <= B.budgetUsd(1, cfg) + 1e-9, '500 people x 500 MB fit the budget of one payer');
assert.ok(Math.abs((cfg.netPerSub - cfg.profitFloor) - 3.75) < 1e-9, 'a payer funds $3.75 of free storage');

// more free people per payer: steps of 50 MB
assert.strictEqual(B.computeLimitMB({ paid: 1, free: 600 }, cfg), 400);
assert.strictEqual(B.computeLimitMB({ paid: 1, free: 700 }, cfg), 350);
assert.strictEqual(B.computeLimitMB({ paid: 1, free: 1000 }, cfg), 250);
assert.strictEqual(B.computeLimitMB({ paid: 1, free: 100000 }, cfg), 50, 'never below the 50 MB floor');
for (const free of [501, 550, 777, 1234, 4321]) assert.strictEqual(B.computeLimitMB({ paid: 3, free }, cfg) % 50, 0, 'always a multiple of 50 MB');

// nobody free: the ceiling. no payers: only R2's free 10 GB (once) is left, so it shrinks fast; a subsidy lifts it
assert.strictEqual(B.computeLimitMB({ paid: 5, free: 0 }, cfg), 500);
assert.strictEqual(B.computeLimitMB({ paid: 0, free: 10 }, cfg), 500);
assert.strictEqual(B.computeLimitMB({ paid: 0, free: 100 }, cfg), 100);
assert.strictEqual(B.computeLimitMB({ paid: 0, free: 1000 }, cfg), 50);
assert.strictEqual(B.computeLimitMB({ paid: 0, free: 1000 }, { ...cfg, subsidyUsd: 6 }), 400, 'a $6 subsidy covers 1000 people at 400 MB');

// the R2 free tier is one lump, so it matters less with every payer
const perPayer = (n) => B.budgetUsd(n, cfg) / n;
assert.ok(perPayer(1) > perPayer(10) && perPayer(10) > perPayer(1000) && perPayer(1000) > 3.75 - 1e-9, 'the free 10 GB fades per payer, never drops under $3.75');

// what payers really store is paid out of the same budget
assert.ok(B.computeLimitMB({ paid: 1, free: 500, paidBytes: 10 * GB }, cfg) <= B.computeLimitMB({ paid: 1, free: 500, paidBytes: 0 }, cfg));
assert.strictEqual(B.computeLimitMB({ paid: 1, free: 500, paidBytes: 10 * GB }, cfg), 500, 'a full 10 GB vault ($0.15) still fits at 1:500 thanks to the free tier');
assert.strictEqual(B.computeLimitMB({ paid: 1, free: 500, paidBytes: 100 * GB }, cfg), 300, 'a lot of vault storage eats into what the free people get');

// stepping: down at once, up one step per run and only with 5% to spare, never flapping
assert.strictEqual(B.nextLimitMB(500, { paid: 1, free: 1000 }, cfg), 250, 'drops several steps in one run');
assert.strictEqual(B.nextLimitMB(250, { paid: 1, free: 500 }, cfg), 300, 'climbs one step at a time');
assert.strictEqual(B.nextLimitMB(300, { paid: 1, free: 500 }, cfg), 350);
assert.strictEqual(B.nextLimitMB(500, { paid: 1, free: 500 }, cfg), 500);
// exactly on the edge (free = 600 -> 443 MB raw, limit 400): current 400 stays; a bare fit is not enough to go up to 450
assert.strictEqual(B.nextLimitMB(400, { paid: 1, free: 600 }, cfg), 400);
assert.strictEqual(B.nextLimitMB(NaN, { paid: 1, free: 500 }, cfg), 500, 'a bad saved value starts from the ceiling');
assert.strictEqual(B.levelOf(500, cfg), 'healthy');
assert.strictEqual(B.levelOf(300, cfg), 'reduced');
assert.strictEqual(B.levelOf(50, cfg), 'floor');

(async () => {
  // the worker, with fakes: 1 payer (+1 creator with Plus for free), 3 free people, a bot that is not counted
  const users = {
    pay: { id: 'pay' }, creator: { id: 'creator' }, a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' }, bot: { id: 'bot', bot: true },
  };
  const bytes = new Map([['pay', 2 * GB], ['creator', 1 * GB], ['a', 10 * MB], ['b', 400 * MB], ['c', 0]]);
  let meta = null, enabled = false;
  const logs = [];
  const make = (extra = {}) => B.create({
    cfg, store: { ownerBytes: async () => bytes }, db: () => ({ users }),
    isSubscriber: (u) => u.id === 'pay' || u.id === 'creator', isLifetime: (u) => u.id === 'creator',
    getMeta: async () => meta, setMeta: async (_k, v) => { meta = v; }, enabled: () => enabled, log: { log: (m) => logs.push(m), error: () => {} }, ...extra,
  });
  const w = make();
  const told = [];
  let v = await w.run((ids) => told.push(...ids));
  assert.deepStrictEqual([v.paid, v.free, v.paidBytes, v.limitMB], [1, 3, 3 * GB, 500], 'creator and bot do not count as payers; their files are real cost');
  assert.strictEqual(w.limitBytes(), null, 'dry run: no per-person limit while FREE_STORAGE_CAP is off');
  assert.strictEqual(w.isOver(10 * GB), false);
  assert.ok(logs.some((l) => /dry run/.test(l)));
  assert.deepStrictEqual(told, [], 'nobody is told during a dry run');
  assert.ok(JSON.parse(meta).limitMB === 500, 'the limit is saved');

  // cap on, and a heavy week: many free people join -> limit drops, only people over it are told, once
  enabled = true;
  for (let i = 0; i < 997; i++) users['f' + i] = { id: 'f' + i };
  v = await w.run((ids) => told.push(...ids));
  assert.strictEqual(v.free, 1000);
  assert.ok(v.limitMB < 500 && v.limitMB % 50 === 0);
  const cap = v.limitMB * MB;
  assert.strictEqual(w.limitBytes(), cap);
  assert.deepStrictEqual(told.sort(), bytes.get('b') > cap ? ['b'] : [], 'only the person over the new limit is told');
  assert.strictEqual(w.isOver(bytes.get('b')), bytes.get('b') > cap);
  const n = told.length;
  await w.run((ids) => told.push(...ids));
  assert.strictEqual(told.length, n, 'told once, not at every run');

  // a restart picks the saved limit up
  const w2 = make(); await w2.load();
  assert.strictEqual(w2.view().limitMB, v.limitMB);
  meta = 'not json'; const w3 = make(); await w3.load();
  assert.strictEqual(w3.view().limitMB, 500, 'unreadable saved state: ceiling');

  console.log('storage-budget: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
