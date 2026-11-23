'use strict';
// Free storage budget: how much each free person may keep, worked out from what the paying people bring in.
// Like storage.js this has no Express or database imports, so server/storage-budget-test.js can test it with fakes.
//
// The idea: every payer brings in $4.85 a month (after fees and after the money set aside for their own 10 GB). 53.5% of that is profit
// and the other 46.5% goes into one shared budget for the free people. The budget is split by the WORST case (every free person fills
// their limit), so the profit is guaranteed:
//
//   budget      = payers x NET_PER_SUB x (1 - PROFIT_SHARE)  +  STORAGE_SUBSIDY_USD  +  R2's own free 10 GB (once, not per payer)  +  the VM's GB
//   free cost   = free people x limit x R2_USD_PER_GB
//   limit       = the biggest 25 MB step whose free cost fits in (budget - what the paying people really store)
//
// Where the files go (server/db.js chooseWhere), in this order:
//   1. people with Plus: always R2 (their own 10 GB is paid for);
//   2. free people: R2 while the R2 POOL has room. The pool is what the money allows for R2 (poolBytesFor): R2's free 10 GB minus the clips and a
//      GB of slack = 4 GB with no payers, and every payer (or subsidy) buys more R2 on top;
//   3. free people when the pool is full: the VM's disk (VM_STORAGE_GB, e.g. 50), so nothing is deleted and nothing extra is paid;
//   4. only when the VM is full too is a new upload refused.
// The VM's GB are NOT part of the R2 pool, but they ARE part of the free budget above, so what you give the VM raises every free person's limit.
//
// The limit is at most 350 MB per free person. More free people per payer pull it down in steps of 25 MB to 50 MB, then in steps of 10 MB (40, 30)
// to a 20 MB floor; more payers let it climb back, one step per run, and only when there is 5% to spare (so it does not flip up and down).
//
// Nothing is ever deleted here. A person over the limit can still see, download and delete their files; only NEW uploads are refused until
// they are back under it (index.js POST /api/files). Free people are warned (in the app) about their limit and that older files could be
// removed to make room. The cap is ON by default; set FREE_STORAGE_CAP=0 on the server to go back to a dry run, where the worker only works
// out and logs what the limit WOULD be and uploads behave as before.

const MB = 1024 * 1024, GB = 1024 ** 3;

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== undefined && v !== null ? Number(v) : d);
const defaults = (env = process.env) => ({
  ceilingMB: 350, floorMB: 20, stepMB: 25, lowTopMB: 50, lowStepMB: 10, // 350 down to 50 in 25 MB steps, then 40, 30, 20 in 10 MB steps
  netPerSub: 4.85,                                  // what a payer brings in per month, after fees and after their own 10 GB is set aside
  profitShare: 0.535,                               // the part of that which is kept as profit; the rest (46.5%) is the free people's budget
  usdPerGB: num(env.R2_USD_PER_GB, 0.015),          // R2 bills per GB-month; GB here is 1024^3 like the rest of the app (raise it a little if R2 bills decimal GB)
  r2FreeGB: 10,                                     // R2's free tier, once for the whole app
  subsidyUsd: num(env.STORAGE_SUBSIDY_USD, 0),      // optional: money you add to the budget yourself (launch period, no payers yet)
  vmGB: num(env.VM_STORAGE_GB, 0),                  // the disk space you give from the VM (server/db.js VM_STORAGE_*): room that costs nothing more, so it counts like R2 room at R2's price
  stepUpMargin: 0.95,                               // raise the limit only when it still fits with 5% less budget
  clipsGB: num(env.CLIPS_LIMIT_GB, 5),              // the clips bucket (server/clips.js) also sits inside R2's free 10 GB, so it is taken off the R2 pool
  headroomGB: 1,                                    // a GB of slack, so R2 never creeps past its free tier by accident
  minPoolGB: 4,                                     // the R2 pool is never smaller than this (the old fixed STORAGE_LIMIT_GB default)
});
const CFG = defaults();

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// The free people's budget in dollars. The VM's GB count as room at R2's price (it costs nothing more), so what you give the VM
// raises every free person's limit exactly like the same amount of R2 would.
function budgetUsd(paid, cfg = CFG, scale = 1) {
  return (paid * cfg.netPerSub * (1 - cfg.profitShare) + cfg.subsidyUsd + cfg.r2FreeGB * cfg.usdPerGB + cfg.vmGB * cfg.usdPerGB) * scale;
}

// How big the R2 pool for free people's files may be (everything that is not a clip), in bytes. Only R2 counts here, not the VM:
// the pool is "how much R2 the money allows". With no payers that is R2's free 10 GB minus the clips and a GB of slack = 4 GB; every payer's
// share (and a subsidy) buys more R2 on top, minus what the payers' own files take. Once the pool is full, free people's new files go to the
// VM (server/db.js chooseWhere), and only when the VM is full too are uploads refused.
function poolBytesFor({ paid = 0, paidBytes = 0 }, cfg = CFG) {
  const moneyGB = (paid * cfg.netPerSub * (1 - cfg.profitShare) + cfg.subsidyUsd) / cfg.usdPerGB + cfg.r2FreeGB;
  const gb = moneyGB - paidBytes / GB - cfg.clipsGB - cfg.headroomGB;
  return Math.floor(Math.max(cfg.minPoolGB, gb) * GB);
}

// The limit follows a ladder: 350, 325, ... 75, 50 (steps of stepMB), then 40, 30, 20 (steps of lowStepMB). It never goes below the 20 MB floor.
// lowTopMB is where the small steps begin: from there down the ladder moves 10 MB at a time.
function stepDown(rawMB, cfg) {
  return rawMB >= cfg.lowTopMB ? Math.floor(rawMB / cfg.stepMB) * cfg.stepMB : Math.floor(rawMB / cfg.lowStepMB) * cfg.lowStepMB;
}
// the next rung up the ladder from `cur`
const stepUp = (cur, cfg) => (cur < cfg.lowTopMB ? Math.min(cur + cfg.lowStepMB, cfg.lowTopMB) : cur + cfg.stepMB);

// The free limit (in MB, a rung of the ladder above) that fits the budget. counts = { paid, free, paidBytes }:
// paid = people who really pay, free = everyone else (who could fill their limit), paidBytes = what people with Plus store (their real cost).
function computeLimitMB({ paid = 0, free = 0, paidBytes = 0 }, cfg = CFG, scale = 1) {
  if (!(free > 0)) return cfg.ceilingMB;
  const left = Math.max(0, budgetUsd(paid, cfg, scale) - (paidBytes / GB) * cfg.usdPerGB);
  const rawMB = (left / (free * cfg.usdPerGB)) * 1024;
  return clamp(stepDown(rawMB, cfg), cfg.floorMB, cfg.ceilingMB);
}

// The limit after this run. It drops at once (possibly several rungs) but climbs one rung per run, and only with 5% to spare.
function nextLimitMB(current, counts, cfg = CFG) {
  const cur = clamp(Math.round(num(current, cfg.ceilingMB)), cfg.floorMB, cfg.ceilingMB);
  const down = computeLimitMB(counts, cfg);
  if (down < cur) return down;
  const up = computeLimitMB(counts, cfg, cfg.stepUpMargin);
  return up > cur ? Math.min(up, stepUp(cur, cfg)) : cur;
}

// healthy = the full ceiling, reduced = in between, floor = the smallest
const levelOf = (limitMB, cfg = CFG) => (limitMB >= cfg.ceilingMB ? 'healthy' : limitMB <= cfg.floorMB ? 'floor' : 'reduced');

// The enforcer. d: { store (ownerBytes), db() -> store.db, isSubscriber(u, now), isLifetime(u), getMeta?, setMeta?, enabled?(), now?, cfg?, log? }
function create(d) {
  const cfg = d.cfg || CFG;
  const nowMs = () => (d.now ? d.now() : Date.now());
  const enabled = d.enabled || (() => process.env.FREE_STORAGE_CAP !== '0');
  const META = 'storage-budget';
  let st = { limitMB: cfg.ceilingMB, paid: 0, free: 0, paidBytes: 0, over: 0, level: 'healthy', updatedAt: 0, announced: false, poolBytes: null };
  let overIds = new Set();

  const view = () => ({ ...st, enabled: !!enabled() });
  // limit in bytes while the cap is on, otherwise null (no per-person limit, as before)
  const limitBytes = () => (enabled() ? st.limitMB * MB : null);
  // the R2 pool for free people's files, in bytes (null until the first run: db.js then keeps its fixed default)
  const poolBytes = () => (Number.isFinite(st.poolBytes) && st.poolBytes > 0 ? st.poolBytes : null);

  async function load() {
    if (!d.getMeta) return;
    try { const raw = await d.getMeta(META); if (raw) st = { ...st, ...JSON.parse(raw) }; } catch { /* unreadable: start from the ceiling */ }
    st.limitMB = clamp(Math.round(num(st.limitMB, cfg.ceilingMB)), cfg.floorMB, cfg.ceilingMB);
  }

  // One run. onOver(ids, limitMB) is called with the free people who have just gone over the limit (to show them the warning).
  // onLimit(ids, limitMB) is called with ALL free people the first time the cap is on and every time the limit changes (so every free
  // person gets the warning about their limit and about older files that could be removed).
  async function run(onOver, onLimit) {
    const t = nowMs();
    const users = Object.values((d.db() && d.db().users) || {}).filter((u) => u && !u.bot);
    const bytes = await d.store.ownerBytes();                       // one grouped query for everybody
    let paid = 0, free = 0, paidBytes = 0;
    const freeUsers = [];
    for (const u of users) {
      if (d.isSubscriber(u, t)) {
        paidBytes += bytes.get(String(u.id)) || 0;
        if (!(d.isLifetime && d.isLifetime(u))) paid++;             // creator accounts have Plus for free: their files cost, they bring nothing in
      } else { free++; freeUsers.push(u.id); }
    }
    const limitMB = nextLimitMB(st.limitMB, { paid, free, paidBytes }, cfg);
    const cap = limitMB * MB;
    const nowOver = new Set(freeUsers.filter((id) => (bytes.get(String(id)) || 0) > cap).map(String));
    const fresh = [...nowOver].filter((id) => !overIds.has(id));
    overIds = nowOver;
    const before = st.limitMB;
    const on = !!enabled();
    const announce = on && (limitMB !== before || !st.announced);
    st = { limitMB, paid, free, paidBytes, over: nowOver.size, level: levelOf(limitMB, cfg), updatedAt: t, announced: !!st.announced || on, poolBytes: poolBytesFor({ paid, paidBytes }, cfg) };
    if (d.setMeta) { try { await d.setMeta(META, JSON.stringify(st)); } catch (e) { (d.log || console).error('Storage budget save failed:', e.message); } }
    if (d.log) d.log.log(`Storage budget: ${paid} paying, ${free} free, free limit ${limitMB} MB${limitMB !== before ? ` (was ${before} MB)` : ''}, ${nowOver.size} over it, R2 pool ${(st.poolBytes / GB).toFixed(1)} GB${cfg.vmGB > 0 ? ` + ${cfg.vmGB} GB on the VM` : ''}${on ? '' : ' (dry run: FREE_STORAGE_CAP=0)'}`);
    if (on && fresh.length && onOver) onOver(fresh, limitMB);
    if (announce && freeUsers.length && onLimit) onLimit(freeUsers.map(String), limitMB);
    return view();
  }

  return { load, run, view, limitBytes, poolBytes, isOver: (usedBytes) => { const l = limitBytes(); return l !== null && usedBytes > l; } };
}

module.exports = { MB, GB, CFG, defaults, budgetUsd, poolBytesFor, computeLimitMB, nextLimitMB, levelOf, create };
