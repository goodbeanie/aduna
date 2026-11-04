'use strict';
// Free storage budget: how much each free person may keep, worked out from what the paying people bring in.
// Like storage.js this has no Express or database imports, so server/storage-budget-test.js can test it with fakes.
//
// The idea: every payer ($4.99 a month, $4.84 after fees) pays for a slice of storage cost, and the rest is profit. The free people
// share that slice. The slice is split by the WORST case (every free person fills their limit), so the profit is guaranteed:
//
//   budget      = payers x (NET_PER_SUB - PROFIT_FLOOR)  +  STORAGE_SUBSIDY_USD  +  R2's own free 10 GB (once, not per payer)
//   free cost   = free people x limit x R2_USD_PER_GB
//   limit       = the biggest 50 MB step whose free cost fits in (budget - what the paying people really store)
//
// 500 free : 1 payer gives $3.75, which is exactly 500 people x 500 MB, so the limit stays at the 500 MB ceiling. More free people per payer
// pull it down in steps of 50 MB (down to a 50 MB floor); more payers let it climb back, one step per run, and only when there is 5% to spare
// (so it does not flip up and down).
//
// Nothing is ever deleted here. A person over the limit can still see, download and delete their files; only NEW uploads are refused until
// they are back under it (index.js POST /api/files). Everything is OFF until FREE_STORAGE_CAP=1 is set on the server: until then the worker
// only works out and logs what the limit WOULD be, and uploads behave as before.

const MB = 1024 * 1024, GB = 1024 ** 3;

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== undefined && v !== null ? Number(v) : d);
const defaults = (env = process.env) => ({
  ceilingMB: 500, floorMB: 50, stepMB: 50,
  netPerSub: 4.84,                                  // $4.99 after PayPal's fees
  profitFloor: 1.09,                                // what is kept per payer before any free storage is paid for
  usdPerGB: num(env.R2_USD_PER_GB, 0.015),          // R2 bills per GB-month; GB here is 1024^3 like the rest of the app (raise it a little if R2 bills decimal GB)
  r2FreeGB: 10,                                     // R2's free tier, once for the whole app
  subsidyUsd: num(env.STORAGE_SUBSIDY_USD, 0),      // optional: money you add to the budget yourself (launch period, no payers yet)
  stepUpMargin: 0.95,                               // raise the limit only when it still fits with 5% less budget
});
const CFG = defaults();

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function budgetUsd(paid, cfg = CFG, scale = 1) {
  return (paid * (cfg.netPerSub - cfg.profitFloor) + cfg.subsidyUsd + cfg.r2FreeGB * cfg.usdPerGB) * scale;
}

// The free limit (in MB, a multiple of stepMB) that fits the budget. counts = { paid, free, paidBytes }:
// paid = people who really pay, free = everyone else (who could fill their limit), paidBytes = what people with Plus store (their real cost).
function computeLimitMB({ paid = 0, free = 0, paidBytes = 0 }, cfg = CFG, scale = 1) {
  if (!(free > 0)) return cfg.ceilingMB;
  const left = Math.max(0, budgetUsd(paid, cfg, scale) - (paidBytes / GB) * cfg.usdPerGB);
  const rawMB = (left / (free * cfg.usdPerGB)) * 1024;
  const stepped = Math.floor(rawMB / cfg.stepMB) * cfg.stepMB;
  return clamp(stepped, cfg.floorMB, cfg.ceilingMB);
}

// The limit after this run. It drops at once (possibly several steps) but climbs one step per run, and only with 5% to spare.
function nextLimitMB(current, counts, cfg = CFG) {
  const cur = clamp(Math.round(num(current, cfg.ceilingMB)), cfg.floorMB, cfg.ceilingMB);
  const down = computeLimitMB(counts, cfg);
  if (down < cur) return down;
  const up = computeLimitMB(counts, cfg, cfg.stepUpMargin);
  return up > cur ? Math.min(up, cur + cfg.stepMB) : cur;
}

// healthy = the full ceiling, reduced = in between, floor = the smallest
const levelOf = (limitMB, cfg = CFG) => (limitMB >= cfg.ceilingMB ? 'healthy' : limitMB <= cfg.floorMB ? 'floor' : 'reduced');

// The enforcer. d: { store (ownerBytes), db() -> store.db, isSubscriber(u, now), isLifetime(u), getMeta?, setMeta?, enabled?(), now?, cfg?, log? }
function create(d) {
  const cfg = d.cfg || CFG;
  const nowMs = () => (d.now ? d.now() : Date.now());
  const enabled = d.enabled || (() => process.env.FREE_STORAGE_CAP === '1');
  const META = 'storage-budget';
  let st = { limitMB: cfg.ceilingMB, paid: 0, free: 0, paidBytes: 0, over: 0, level: 'healthy', updatedAt: 0 };
  let overIds = new Set();

  const view = () => ({ ...st, enabled: !!enabled() });
  // limit in bytes while the cap is on, otherwise null (no per-person limit, as before)
  const limitBytes = () => (enabled() ? st.limitMB * MB : null);

  async function load() {
    if (!d.getMeta) return;
    try { const raw = await d.getMeta(META); if (raw) st = { ...st, ...JSON.parse(raw) }; } catch { /* unreadable: start from the ceiling */ }
    st.limitMB = clamp(Math.round(num(st.limitMB, cfg.ceilingMB)), cfg.floorMB, cfg.ceilingMB);
  }

  // One run. onOver(ids, limitMB) is called with the free people who have just gone over the limit (to show them the warning).
  async function run(onOver) {
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
    st = { limitMB, paid, free, paidBytes, over: nowOver.size, level: levelOf(limitMB, cfg), updatedAt: t };
    if (d.setMeta) { try { await d.setMeta(META, JSON.stringify(st)); } catch (e) { (d.log || console).error('Storage budget save failed:', e.message); } }
    if (d.log) d.log.log(`Storage budget: ${paid} paying, ${free} free, free limit ${limitMB} MB${limitMB !== before ? ` (was ${before} MB)` : ''}, ${nowOver.size} over it${enabled() ? '' : ' (dry run: FREE_STORAGE_CAP is off)'}`);
    if (enabled() && fresh.length && onOver) onOver(fresh, limitMB);
    return view();
  }

  return { load, run, view, limitBytes, isOver: (usedBytes) => { const l = limitBytes(); return l !== null && usedBytes > l; } };
}

module.exports = { MB, GB, CFG, defaults, budgetUsd, computeLimitMB, nextLimitMB, levelOf, create };
