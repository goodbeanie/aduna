// What Aduna has sold, counted in Canadian dollars, to show when a sales tax registration is due.
// No Express or database imports, so server/sales-report-test.js can test it alone.
//
// Every payment records the buyer's country and province or state (server/regions.js), so the totals are built from those:
//   * all sales to Canada, against the Canada-wide limit
//   * sales to each province or state, against the per-region limit
// US payments are converted at the live USD to CAD rate (server/fx.js, fetched automatically). Sales are counted without the tax that was
// collected, over the last 12 months, and payments that were refunded or charged back are left out.
//
// Settings (all optional):
//   FX_USD_TO_CAD=1.37           pin the rate instead of fetching it (also used for the prices US buyers see)
//   SALES_USD_TO_CAD=1.40        the rate used until the first fetch works, or if no rate service ever answers
//   SALES_LIMIT_CANADA_CAD=30000 limit for all sales to Canada
//   SALES_LIMIT_REGION_CAD=10000 limit for each province or state

const FX = require('./fx');
const NEAR = 0.8; // "getting close" from this share of a limit

const positive = (v, fallback) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : fallback; };

function settings(env = process.env) {
  return {
    rate: FX.rate(env), // the live USD to CAD rate (server/fx.js); SALES_USD_TO_CAD is only what it falls back to before the first fetch
    canadaLimit: Math.round(positive(env.SALES_LIMIT_CANADA_CAD, 30000) * 100),
    regionLimit: Math.round(positive(env.SALES_LIMIT_REGION_CAD, 10000) * 100),
  };
}

// every payment taken: [{ at, cents, tax, currency, country, region }]. Credit packs live in db.payments, the storage plan on each person.
function payments(db) {
  const out = [];
  for (const p of Object.values((db && db.payments) || {})) {
    if (!p || p.reversed || !Number.isFinite(p.createdAt)) continue;
    out.push({ at: p.createdAt, cents: p.cents, tax: p.tax, currency: p.currency, country: p.country, region: p.region });
  }
  for (const u of Object.values((db && db.users) || {})) {
    for (const p of (u && Array.isArray(u.storagePayments) ? u.storagePayments : [])) {
      if (p && Number.isFinite(p.at)) out.push({ at: p.at, cents: p.cents, tax: p.tax, currency: p.currency, country: p.country, region: p.region });
    }
  }
  return out;
}

const status = (cents, limit) => (cents >= limit ? 'over' : cents >= limit * NEAR ? 'near' : 'ok');

function windowStart(now) {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.getTime();
}

// { rate, since, until, canada, us, regions: [...], unplaced, total }. Every amount is in Canadian cents.
function report(db, { now = Date.now(), env = process.env } = {}) {
  const s = settings(env), since = windowStart(now);
  const totals = { CA: { cents: 0, count: 0 }, US: { cents: 0, count: 0 } }, unplaced = { cents: 0, count: 0 };
  const byRegion = new Map();
  for (const p of payments(db)) {
    if (p.at < since || p.at > now) continue;
    const net = Math.max(0, (Number(p.cents) || 0) - (Number(p.tax) || 0));
    const cad = String(p.currency || 'usd').toLowerCase() === 'cad' ? net : Math.round(net * s.rate);
    const country = String(p.country || '').toUpperCase(), region = String(p.region || '').toUpperCase();
    if (!totals[country] || !region) { unplaced.cents += cad; unplaced.count++; continue; } // bought before regions were asked for
    totals[country].cents += cad; totals[country].count++;
    const key = country + '-' + region, row = byRegion.get(key) || { country, region, cents: 0, count: 0 };
    row.cents += cad; row.count++;
    byRegion.set(key, row);
  }
  const regions = [...byRegion.values()]
    .map((r) => ({ ...r, limit: s.regionLimit, status: status(r.cents, s.regionLimit) }))
    .sort((a, b) => b.cents - a.cents);
  return {
    rate: s.rate, since, until: now,
    canada: { ...totals.CA, limit: s.canadaLimit, status: status(totals.CA.cents, s.canadaLimit) },
    us: totals.US,
    regions,
    unplaced,
    total: totals.CA.cents + totals.US.cents + unplaced.cents,
  };
}

module.exports = { settings, report };
