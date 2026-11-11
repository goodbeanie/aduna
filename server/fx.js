// The US dollar in Canadian dollars. Prices are set in CAD (cadCents on each item); what a US buyer sees and pays is that price
// converted at this rate. No Express or database imports, so server/fx-test.js can test it alone.
//
// Where the rate comes from, in order:
//   1. FX_USD_TO_CAD=1.37          a rate you pin yourself (nothing is fetched while it is set)
//   2. the last rate fetched       Frankfurter (European Central Bank rates, free, no key), then open.er-api.com if that is down.
//                                   Fetched when the server starts and again every 6 hours; a rate that is a few days old is still used.
//   3. SALES_USD_TO_CAD (or 1.40)  only until the first fetch works, or if neither service ever answers
// A fetched rate that is nonsense (outside 0.5 to 3) or jumps more than 15% from the one before is thrown away.
//
// USD prices are worked out as the CAD price / rate, rounded to end in 9 cents ($4.99, $5.09, $5.19...). Because they move in steps of
// 10 cents, a small change in the rate does not change the price you see.

const HOUR = 3_600_000;
const REFRESH_MS = 6 * HOUR;
const STALE_MS = 72 * HOUR;       // older than this the rate is still used, but view() says so
const MAX_JUMP = 0.15;

const state = { rate: null, at: 0, source: '' };

const positive = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

// what to use when nothing has been fetched
const fallback = (env = process.env) => positive(env.SALES_USD_TO_CAD) || 1.4;

// { rate, at, source: 'pinned' | 'live' | 'fallback', stale }
function current(env = process.env, now = Date.now()) {
  const pinned = positive(env.FX_USD_TO_CAD);
  if (pinned) return { rate: pinned, at: 0, source: 'pinned', stale: false };
  if (state.rate) return { rate: state.rate, at: state.at, source: 'live', stale: now - state.at > STALE_MS };
  return { rate: fallback(env), at: 0, source: 'fallback', stale: false };
}

const rate = (env, now) => current(env, now).rate;

// A CAD price in cents as a USD price in cents.
function toUsdCents(cadCents, env = process.env, now = Date.now()) {
  if (!Number.isInteger(cadCents) || cadCents <= 0) return null;
  return Math.max(99, Math.round(cadCents / rate(env, now) / 10) * 10 - 1);
}

// What the pages need to say "about $X USD at today's rate".
function view(env = process.env, now = Date.now()) {
  const c = current(env, now);
  return { rate: Math.round(c.rate * 10000) / 10000, at: c.at || null, source: c.source, stale: c.stale };
}

function accept(r, previous) {
  const n = positive(r);
  if (!n || n < 0.5 || n > 3) return null;
  if (previous && Math.abs(n - previous) / previous > MAX_JUMP) return null;
  return n;
}

const SOURCES = [
  { name: 'frankfurter', url: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=CAD', pick: (j) => j && j.rates && j.rates.CAD },
  { name: 'open.er-api.com', url: 'https://open.er-api.com/v6/latest/USD', pick: (j) => j && j.rates && j.rates.CAD },
];

// Asks the services for the rate and keeps it. Never throws: a failure just leaves the last rate in place.
async function refresh({ fetchImpl = fetch, now = Date.now(), env = process.env } = {}) {
  if (positive(env.FX_USD_TO_CAD)) return current(env, now);
  for (const s of SOURCES) {
    try {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
      let r;
      try { r = await fetchImpl(s.url, { signal: ctl.signal, headers: { Accept: 'application/json' } }); } finally { clearTimeout(t); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const n = accept(s.pick(await r.json()), state.rate);
      if (!n) throw new Error('rate rejected');
      state.rate = n; state.at = now; state.source = s.name;
      return current(env, now);
    } catch (e) {
      console.warn('FX: ' + s.name + ' did not give a usable USD to CAD rate (' + (e && e.message ? e.message : e) + ')');
    }
  }
  return current(env, now);
}

let timer = null;
function start(opts = {}) {
  refresh(opts).then((c) => console.log('FX: USD to CAD ' + c.rate + ' (' + c.source + (state.source ? ', ' + state.source : '') + ')'));
  if (!timer) { timer = setInterval(() => refresh(opts), REFRESH_MS); if (timer.unref) timer.unref(); }
}

const _reset = () => { state.rate = null; state.at = 0; state.source = ''; }; // for tests

module.exports = { current, rate, toUsdCents, view, refresh, start, _reset, REFRESH_MS, STALE_MS };
