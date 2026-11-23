'use strict';
// Free storage budget, no database needed: node server/storage-budget-test.js
const assert = require('assert');
const B = require('./storage-budget');
const cfg = B.defaults({}); // no env: $0.015 per GB, no subsidy
const MB = B.MB, GB = B.GB;

// the plan's own numbers: a payer brings in $4.85, 53.5% is profit, the other 46.5% ($2.25525) is the free people's budget
assert.strictEqual([cfg.ceilingMB, cfg.floorMB, cfg.stepMB, cfg.lowTopMB, cfg.lowStepMB].join(), '350,20,25,50,10');
assert.ok(Math.abs(cfg.netPerSub * (1 - cfg.profitShare) - 2.25525) < 1e-9, 'a payer funds $2.25525 of free storage');
assert.ok(Math.abs(cfg.netPerSub * cfg.profitShare - 2.59475) < 1e-9, 'the profit is 53.5% of $4.85');
assert.strictEqual(B.computeLimitMB({ paid: 1, free: 400 }, cfg), 350, 'a payer carries about 440 free people at the 350 MB ceiling');
assert.ok(400 * 350 * MB / GB * cfg.usdPerGB <= B.budgetUsd(1, cfg) + 1e-9, '400 people x 350 MB fit the budget of one payer');

// more free people per payer: steps of 25 MB
assert.strictEqual(B.computeLimitMB({ paid: 1, free: 500 }, cfg), 325);
assert.strictEqual(B.computeLimitMB({ paid: 1, free: 600 }, cfg), 250);
assert.strictEqual(B.computeLimitMB({ paid: 1, free: 700 }, cfg), 225);
assert.strictEqual(B.computeLimitMB({ paid: 1, free: 1000 }, cfg), 150);
assert.strictEqual(B.computeLimitMB({ paid: 1, free: 100000 }, cfg), 20, 'never below the 20 MB floor');
// below 50 MB the ladder moves 10 MB at a time: 40, 30, 20 (no payers: the raw share is 10240 / free MB)
assert.strictEqual(B.computeLimitMB({ paid: 0, free: 204 }, cfg), 50, 'a raw share of 50.2 MB is still 50');
assert.strictEqual(B.computeLimitMB({ paid: 0, free: 205 }, cfg), 40, 'just under 50 MB drops to 40');
assert.strictEqual(B.computeLimitMB({ paid: 0, free: 230 }, cfg), 40);
assert.strictEqual(B.computeLimitMB({ paid: 0, free: 300 }, cfg), 30);
assert.strictEqual(B.computeLimitMB({ paid: 0, free: 400 }, cfg), 20);
assert.strictEqual(B.computeLimitMB({ paid: 0, free: 370 }, cfg), 20, '370 free people on R2 alone (no VM, no payers): 27.7 MB each rounds down to 20');
assert.strictEqual(B.computeLimitMB({ paid: 0, free: 1000 }, cfg), 20, 'never below 20');
assert.deepStrictEqual([136, 204, 255, 341, 600].map((free) => B.computeLimitMB({ paid: 0, free }, cfg)), [75, 50, 40, 30, 20], 'the whole ladder, in order');
for (const free of [501, 550, 777, 1234, 4321]) assert.strictEqual(B.computeLimitMB({ paid: 3, free }, cfg) % 25, 0, 'always a multiple of 25 MB');
// every limit really fits the budget (so the profit is guaranteed)
for (const [paid, free] of [[1, 500], [1, 1000], [2, 777], [10, 5000], [50, 20000]]) {
  const l = B.computeLimitMB({ paid, free }, cfg);
  assert.ok(l === cfg.floorMB || free * l * MB / GB * cfg.usdPerGB <= B.budgetUsd(paid, cfg) + 1e-9, `${free} free x ${l} MB fit ${paid} payers`);
}

// nobody free: the ceiling. no payers: only R2's free 10 GB (once) is left, so it shrinks fast; a subsidy lifts it
assert.strictEqual(B.computeLimitMB({ paid: 5, free: 0 }, cfg), 350);
assert.strictEqual(B.computeLimitMB({ paid: 0, free: 10 }, cfg), 350);
assert.strictEqual(B.computeLimitMB({ paid: 0, free: 100 }, cfg), 100);
assert.strictEqual(B.computeLimitMB({ paid: 0, free: 1000 }, cfg), 20);
assert.strictEqual(B.computeLimitMB({ paid: 0, free: 1000 }, { ...cfg, subsidyUsd: 3 }), 200, 'a $3 subsidy covers 1000 people at 200 MB');

// the R2 free tier is one lump, so it matters less with every payer
const perPayer = (n) => B.budgetUsd(n, cfg) / n;
assert.ok(perPayer(1) > perPayer(10) && perPayer(10) > perPayer(1000) && perPayer(1000) > 2.25525 - 1e-9, 'the free 10 GB fades per payer, never drops under $2.25525');

// what payers really store is paid out of the same budget
assert.ok(B.computeLimitMB({ paid: 1, free: 500, paidBytes: 10 * GB }, cfg) <= B.computeLimitMB({ paid: 1, free: 500, paidBytes: 0 }, cfg));
assert.strictEqual(B.computeLimitMB({ paid: 1, free: 500, paidBytes: 10 * GB }, cfg), 300, 'a full 10 GB vault ($0.15) takes a step off at 1:500');
assert.strictEqual(B.computeLimitMB({ paid: 1, free: 500, paidBytes: 100 * GB }, cfg), 100, 'a lot of vault storage eats into what the free people get');

// stepping: down at once, up one step per run and only with 5% to spare, never flapping
assert.strictEqual(B.nextLimitMB(350, { paid: 1, free: 1000 }, cfg), 150, 'drops several steps in one run');
assert.strictEqual(B.nextLimitMB(150, { paid: 1, free: 500 }, cfg), 175, 'climbs one step at a time');
assert.strictEqual(B.nextLimitMB(275, { paid: 1, free: 500 }, cfg), 300);
assert.strictEqual(B.nextLimitMB(300, { paid: 1, free: 500 }, cfg), 300, 'a bare fit at 325 is not enough to go up: it needs 5% to spare');
assert.strictEqual(B.nextLimitMB(350, { paid: 1, free: 500 }, cfg), 325, 'comes down to what fits');
assert.strictEqual(B.nextLimitMB(250, { paid: 1, free: 600 }, cfg), 250);
assert.strictEqual(B.nextLimitMB(NaN, { paid: 1, free: 400 }, cfg), 350, 'a bad saved value starts from the ceiling');
// the small steps below 50 MB: down at once, up one 10 MB rung per run, and 40 -> 50 -> 75 returns to the 25 MB steps
assert.strictEqual(B.nextLimitMB(350, { paid: 0, free: 400 }, cfg), 20, 'drops straight to the 20 MB floor');
assert.strictEqual(B.nextLimitMB(50, { paid: 0, free: 300 }, cfg), 30, 'drops from 50 past 40 to 30 in one run');
assert.strictEqual(B.nextLimitMB(20, { paid: 0, free: 230 }, cfg), 30, 'climbs 20 -> 30 (one 10 MB rung)');
assert.strictEqual(B.nextLimitMB(30, { paid: 0, free: 230 }, cfg), 40, 'then 30 -> 40');
assert.strictEqual(B.nextLimitMB(40, { paid: 0, free: 230 }, cfg), 40, 'and stays at 40 while 50 does not fit');
assert.strictEqual(B.nextLimitMB(40, { paid: 0, free: 190 }, cfg), 50, '40 -> 50 once it fits with 5% to spare');
assert.strictEqual(B.nextLimitMB(50, { paid: 0, free: 100 }, cfg), 75, '50 -> 75 uses the 25 MB step again');
assert.strictEqual(B.nextLimitMB(25, { paid: 0, free: 190 }, cfg), 35, 'a saved value off the ladder still climbs by 10 and never past 50 in one run');
assert.strictEqual(B.levelOf(350, cfg), 'healthy');
assert.strictEqual(B.levelOf(300, cfg), 'reduced');
assert.strictEqual(B.levelOf(50, cfg), 'reduced');
assert.strictEqual(B.levelOf(30, cfg), 'reduced');
assert.strictEqual(B.levelOf(20, cfg), 'floor');

// the VM's GB count as room for the free people (at R2's price), 50 GB = $0.75 on top of R2's free 10 GB ($0.15)
const withVm = { ...cfg, vmGB: 50 };
assert.ok(Math.abs(B.budgetUsd(0, withVm) - B.budgetUsd(0, cfg) - 0.75) < 1e-9, '50 GB on the VM add $0.75 to the free budget');
assert.strictEqual(B.computeLimitMB({ paid: 0, free: 300 }, cfg), 30, 'no payers, no VM: 300 free people get 30 MB each');
assert.strictEqual(B.computeLimitMB({ paid: 0, free: 300 }, withVm), 200, 'the same 300 people get 200 MB each once the VM is given');
assert.strictEqual(B.computeLimitMB({ paid: 0, free: 100 }, withVm), 350, '100 free people reach the ceiling on the VM room alone');
assert.strictEqual(B.defaults({ VM_STORAGE_GB: '50' }).vmGB, 50, 'VM_STORAGE_GB feeds the budget');

// the R2 pool: only what the money allows for R2, never the VM
assert.strictEqual(B.poolBytesFor({ paid: 0 }, cfg), 4 * GB, 'no payers: R2 free 10 GB - 5 GB clips - 1 GB slack = 4 GB');
assert.strictEqual(B.poolBytesFor({ paid: 0 }, withVm), 4 * GB, 'the VM never makes the R2 pool bigger');
assert.ok(B.poolBytesFor({ paid: 1 }, cfg) > 150 * GB && B.poolBytesFor({ paid: 1 }, cfg) < 155 * GB, 'one payer buys about 150 GB of R2 for the free people');
assert.ok(B.poolBytesFor({ paid: 2 }, cfg) > B.poolBytesFor({ paid: 1 }, cfg), 'more payers, bigger pool');
assert.ok(B.poolBytesFor({ paid: 1, paidBytes: 100 * GB }, cfg) < B.poolBytesFor({ paid: 1 }, cfg) - 99 * GB, 'what the payers store takes room out of the pool');
assert.strictEqual(B.poolBytesFor({ paid: 0, paidBytes: 50 * GB }, cfg), 4 * GB, 'never below the 4 GB minimum');
assert.strictEqual(B.poolBytesFor({ paid: 0 }, { ...cfg, subsidyUsd: 0.3 }), 24 * GB, 'a $0.30 subsidy buys 20 GB more R2');

(async () => {
  // the worker, with fakes: 1 payer (+1 creator with Plus for free), 3 free people, a bot that is not counted
  const users = {
    pay: { id: 'pay' }, creator: { id: 'creator' }, a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' }, bot: { id: 'bot', bot: true },
  };
  const bytes = new Map([['pay', 2 * GB], ['creator', 1 * GB], ['a', 10 * MB], ['b', 300 * MB], ['c', 0]]);
  let meta = null, enabled = false;
  const logs = [];
  const make = (extra = {}) => B.create({
    cfg, store: { ownerBytes: async () => bytes }, db: () => ({ users }),
    isSubscriber: (u) => u.id === 'pay' || u.id === 'creator', isLifetime: (u) => u.id === 'creator',
    getMeta: async () => meta, setMeta: async (_k, v) => { meta = v; }, enabled: () => enabled, log: { log: (m) => logs.push(m), error: () => {} }, ...extra,
  });
  const w = make();
  const told = [], warned = [];
  assert.strictEqual(w.poolBytes(), null, 'before the first run there is no pool figure, so db.js keeps its fixed default');
  let v = await w.run((ids) => told.push(...ids), (ids) => warned.push(...ids));
  assert.strictEqual(w.poolBytes(), B.poolBytesFor({ paid: 1, paidBytes: 3 * GB }, cfg), 'the run works out the R2 pool and keeps it');
  assert.ok(JSON.parse(meta).poolBytes === w.poolBytes(), 'the pool is saved with the rest');
  assert.deepStrictEqual([v.paid, v.free, v.paidBytes, v.limitMB], [1, 3, 3 * GB, 350], 'creator and bot do not count as payers; their files are real cost');
  assert.strictEqual(w.limitBytes(), null, 'dry run: no per-person limit while the cap is off');
  assert.strictEqual(w.isOver(10 * GB), false);
  assert.ok(logs.some((l) => /dry run/.test(l)));
  assert.deepStrictEqual(told, [], 'nobody is told during a dry run');
  assert.deepStrictEqual(warned, [], 'nobody is warned during a dry run');
  assert.ok(JSON.parse(meta).limitMB === 350, 'the limit is saved');

  // cap switched on: every free person gets the warning once, even though the limit did not change
  enabled = true;
  v = await w.run((ids) => told.push(...ids), (ids) => warned.push(...ids));
  assert.deepStrictEqual(warned.sort(), ['a', 'b', 'c'], 'all free people (not payers, creators or bots) are warned when the cap goes on');
  warned.length = 0;
  await w.run((ids) => told.push(...ids), (ids) => warned.push(...ids));
  assert.deepStrictEqual(warned, [], 'not warned again while the limit stays the same');

  // a heavy week: many free people join -> limit drops, everybody free is warned, only people over it are told, once
  for (let i = 0; i < 997; i++) users['f' + i] = { id: 'f' + i };
  v = await w.run((ids) => told.push(...ids), (ids) => warned.push(...ids));
  assert.strictEqual(v.free, 1000);
  assert.ok(v.limitMB < 350 && v.limitMB % 25 === 0);
  assert.strictEqual(warned.length, 1000, 'a changed limit warns every free person');
  const cap = v.limitMB * MB;
  assert.strictEqual(w.limitBytes(), cap);
  assert.deepStrictEqual(told.sort(), bytes.get('b') > cap ? ['b'] : [], 'only the person over the new limit is told');
  assert.strictEqual(w.isOver(bytes.get('b')), bytes.get('b') > cap);
  const n = told.length;
  warned.length = 0;
  await w.run((ids) => told.push(...ids), (ids) => warned.push(...ids));
  assert.strictEqual(told.length, n, 'told once, not at every run');
  assert.deepStrictEqual(warned, [], 'warned once per change, not at every run');

  // a restart picks the saved limit up
  const w2 = make(); await w2.load();
  assert.strictEqual(w2.view().limitMB, v.limitMB);
  assert.strictEqual(w2.view().announced, true, 'a restart does not warn everybody again');
  meta = 'not json'; const w3 = make(); await w3.load();
  assert.strictEqual(w3.view().limitMB, 350, 'unreadable saved state: ceiling');

  console.log('storage-budget: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
