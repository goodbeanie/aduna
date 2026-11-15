// The USD to CAD rate the sales report uses, without a database or the network: node server/fx-test.js
// Prices do not use it: every pack has a fixed price in each currency (server/credits.js).
const assert = require('assert');
const FX = require('./fx');
const REG = require('./regions');
const SR = require('./sales-report');
const step = (m) => console.log('✓', m);
const T0 = Date.UTC(2026, 10, 11);

// nothing fetched yet: 1.40 (or SALES_USD_TO_CAD)
FX._reset();
assert.deepStrictEqual([FX.current({}, T0).rate, FX.current({}, T0).source], [1.4, 'fallback']);
assert.strictEqual(FX.current({ SALES_USD_TO_CAD: '1.5' }, T0).rate, 1.5);
step('no rate fetched yet: 1.40, or SALES_USD_TO_CAD');

// a pinned rate wins and nothing is fetched
let calls = 0;
const never = async () => { calls++; throw new Error('should not be called'); };
assert.strictEqual(FX.current({ FX_USD_TO_CAD: '1.25' }, T0).source, 'pinned');
FX.refresh({ fetchImpl: never, env: { FX_USD_TO_CAD: '1.25' }, now: T0 }).then(() => assert.strictEqual(calls, 0));
step('FX_USD_TO_CAD pins the rate and stops the fetching');

const ok = (rate) => async () => ({ ok: true, json: async () => ({ rates: { CAD: rate } }) });
const down = async () => ({ ok: false, status: 503, json: async () => ({}) });

(async () => {
  // a fetched rate is used
  let c = await FX.refresh({ fetchImpl: ok(1.38), now: T0, env: {} });
  assert.deepStrictEqual([c.rate, c.source, c.stale], [1.38, 'live', false]);
  step('a fetched rate is used');

  // the second service is used when the first is down
  FX._reset();
  const urls = [];
  c = await FX.refresh({ now: T0, env: {}, fetchImpl: async (u) => { urls.push(u); return /frankfurter/.test(u) ? down() : ok(1.36)(); } });
  assert.strictEqual(c.rate, 1.36); assert.strictEqual(urls.length, 2);
  step('Frankfurter down: open.er-api.com answers');

  // bad answers are thrown away and the last good rate stays
  for (const bad of [0, -1, 'abc', 99, 0.01, 1.7]) {
    c = await FX.refresh({ fetchImpl: ok(bad), now: T0 + 1000, env: {} });
    assert.strictEqual(c.rate, 1.36, 'rejected: ' + bad);
  }
  c = await FX.refresh({ fetchImpl: down, now: T0 + 2000, env: {} });
  assert.strictEqual(c.rate, 1.36, 'both services down: the last rate stays');
  step('nonsense, a jump of more than 15%, or both services down: the last good rate stays');

  // an old rate is still used but says so
  assert.strictEqual(FX.current({}, T0 + FX.STALE_MS + 10_000).stale, true);
  assert.strictEqual(FX.current({}, T0 + FX.STALE_MS + 10_000).rate, 1.36);
  step('a rate a few days old is still used, and marked stale');

  // prices are fixed in each currency and never follow the rate
  const pack = { id: 'p500', cents: 179, cadCents: 249 };
  assert.strictEqual(REG.priceIn(pack, 'cad', {}), 249);
  assert.strictEqual(REG.priceIn(pack, 'usd', {}), 179);
  assert.strictEqual(REG.priceIn({ cents: 999 }, 'usd', {}), 999, 'an old pack with no CAD price');
  assert.strictEqual(REG.priceIn({ cents: 999 }, 'cad', {}), null);
  assert.strictEqual(REG.priceIn(pack, 'eur', {}), null);
  step('prices are fixed in CAD and in USD, whatever the rate does');

  // the sales report converts US sales at the live rate
  FX._reset();
  const db = { payments: { a: { createdAt: T0 - 1000, cents: 1000, tax: 0, currency: 'usd', country: 'US', region: 'WA' } } };
  assert.strictEqual(SR.report(db, { now: T0, env: {} }).total, 1400, 'fallback 1.40');
  await FX.refresh({ fetchImpl: ok(1.3), now: T0, env: {} });
  assert.strictEqual(SR.report(db, { now: T0, env: {} }).total, 1300, 'live 1.30');
  assert.strictEqual(SR.report(db, { now: T0, env: { FX_USD_TO_CAD: '1.5' } }).total, 1500, 'pinned 1.50');
  step('the sales report follows the live rate');

  FX._reset();
  console.log('fx tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
