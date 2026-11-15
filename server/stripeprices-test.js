// Attaching your own Stripe products, without a database or the network: node server/stripeprices-test.js
// Stripe is replaced by a fake that holds the same products as the dashboard (500/1000/2500/5000 Credits in CAD, Aduna PLUS monthly).
process.env.STRIPE_SECRET_KEY = 'sk_test_x'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
delete process.env.TAX_COLLECT_IN; delete process.env.SELL_TO; delete process.env.STRIPE_MANAGED_PAYMENTS; delete process.env.SURCHARGE_PCT;
delete process.env.STRIPE_PRODUCTS; delete process.env.STRIPE_PRICES;
const assert = require('assert');
const P = require('./stripeprices');
const credits = require('./credits');
const storage = require('./storage');
const S = require('./surcharge');

const prod = (name) => ({ id: 'prod_' + name.replace(/\W/g, ''), name, active: true });
const price = (id, name, cents, cur = 'cad', recurring = false) => ({
  id, currency: cur, unit_amount: cents, active: true, type: recurring ? 'recurring' : 'one_time',
  ...(recurring ? { recurring: { interval: 'month', interval_count: 1 } } : {}), product: prod(name),
});
const PRICES = [
  price('price_cad500aaa', '500 Credits', 199), price('price_cad1000aa', '1000 Credits', 349),
  price('price_cad2500aa', '2500 Credits', 699), price('price_cad5000aa', '5000 Credits', 999),
  price('price_cadplusaa', 'Aduna PLUS', 499, 'cad', true),
];

function fakeStripe(prices = PRICES) {
  const calls = [];
  const res = (status, j) => ({ ok: status < 300, status, json: async () => j });
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET', u = new URL(url);
    calls.push({ method, path: u.pathname + u.search, body: init.body ? new URLSearchParams(init.body) : null });
    if (method === 'GET' && u.pathname === '/v1/prices') return res(200, { data: prices, has_more: false });
    if (method === 'GET' && u.pathname.startsWith('/v1/prices/')) { const p = prices.find((x) => x.id === u.pathname.split('/').pop()); return p ? res(200, p) : res(404, { error: { message: 'no such price' } }); }
    if (method === 'POST' && u.pathname === '/v1/checkout/sessions') return res(200, { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
    return res(404, {});
  };
  return { fetchImpl, calls, sessions: () => calls.filter((c) => c.method === 'POST').map((c) => c.body) };
}

const user = { id: 'u1', email: 'a@example.com' };
const ca = { country: 'CA', region: 'BC' };
const us = { country: 'US', region: 'WA' };
const pack = (id) => credits.PACKS.find((p) => p.id === id);

(async () => {
  // ---- off by default: checkout is exactly what it was ----
  P._reset();
  let f = fakeStripe();
  await credits.createCheckout({ user, pack: pack('p500'), origin: 'https://x.test', buyer: ca, fetchImpl: f.fetchImpl });
  assert.strictEqual(f.calls.filter((c) => c.method === 'GET').length, 0, 'no Stripe lookups unless you attach products');
  assert.strictEqual(f.sessions()[0].get('line_items[0][price_data][unit_amount]'), '199');
  assert.strictEqual(f.sessions()[0].has('line_items[0][price]'), false);
  console.log('ok: off by default, inline price as before');

  // ---- STRIPE_PRODUCTS=auto: your products are found by name, currency and amount ----
  process.env.STRIPE_PRODUCTS = 'auto';
  for (const [id, cents, want] of [['p500', 199, 'price_cad500aaa'], ['p1000', 349, 'price_cad1000aa'], ['p2500', 699, 'price_cad2500aa'], ['p5000', 999, 'price_cad5000aa']]) {
    P._reset(); f = fakeStripe();
    await credits.createCheckout({ user, pack: pack(id), origin: 'https://x.test', buyer: ca, fetchImpl: f.fetchImpl });
    const s = f.sessions()[0];
    assert.strictEqual(s.get('line_items[0][price]'), want, id + ' uses your Stripe price');
    assert.strictEqual(s.has('line_items[0][price_data][unit_amount]'), false);
    assert.strictEqual(s.get('metadata[packId]'), id);
    assert.strictEqual(Number(s.get('metadata[total]')), cents, 'the amount the webhook checks is still Aduna\'s own');
  }
  console.log('ok: the four credit packs use your CAD products');

  // a cached lookup is not repeated for the next buyer
  f = fakeStripe();
  await credits.createCheckout({ user, pack: pack('p500'), origin: 'https://x.test', buyer: ca, fetchImpl: f.fetchImpl });
  assert.strictEqual(f.calls.filter((c) => c.method === 'GET').length, 0, 'prices are cached');

  // ---- Aduna PLUS: the monthly price ----
  P._reset(); f = fakeStripe();
  await storage.createCheckout({ user, buyer: ca, origin: 'https://x.test', fetchImpl: f.fetchImpl });
  let s = f.sessions()[0];
  assert.strictEqual(s.get('mode'), 'subscription');
  assert.strictEqual(s.get('line_items[0][price]'), 'price_cadplusaa');
  assert.strictEqual(s.get('metadata[kind]'), 'storage');
  console.log('ok: Aduna PLUS uses your monthly product');

  // ---- no Stripe price in that currency (you only made CAD): the US buyer still pays the right amount ----
  P._reset(); f = fakeStripe();
  await credits.createCheckout({ user, pack: pack('p500'), origin: 'https://x.test', buyer: us, fetchImpl: f.fetchImpl });
  s = f.sessions()[0];
  assert.strictEqual(s.has('line_items[0][price]'), false);
  assert.strictEqual(s.get('line_items[0][price_data][currency]'), 'usd');
  assert.strictEqual(s.get('line_items[0][price_data][unit_amount]'), '149');
  console.log('ok: USD buyers fall back to an inline price');

  // ---- a Stripe price with the WRONG amount is never used ----
  P._reset(); f = fakeStripe([price('price_cad500aaa', '500 Credits', 299), ...PRICES.slice(1)]);
  await credits.createCheckout({ user, pack: pack('p500'), origin: 'https://x.test', buyer: ca, fetchImpl: f.fetchImpl });
  s = f.sessions()[0];
  assert.strictEqual(s.has('line_items[0][price]'), false, 'wrong amount: not used');
  assert.strictEqual(s.get('line_items[0][price_data][unit_amount]'), '199', 'the buyer pays Aduna\'s price');
  // a one-time price is not taken for the monthly plan
  P._reset(); f = fakeStripe([price('price_cadplusaa', 'Aduna PLUS', 499, 'cad', false)]);
  await storage.createCheckout({ user, buyer: ca, origin: 'https://x.test', fetchImpl: f.fetchImpl });
  assert.strictEqual(f.sessions()[0].has('line_items[0][price]'), false, 'the plan needs a monthly price');
  console.log('ok: wrong amount or wrong billing period is refused, Aduna\'s own price is charged');

  // ---- Stripe unreachable: checkout still works ----
  P._reset();
  const calls = [];
  const down = async (url, init = {}) => { calls.push(init.method || 'GET'); if ((init.method || 'GET') === 'GET') return { ok: false, status: 500, json: async () => ({}) }; return { ok: true, status: 200, json: async () => ({ url: 'https://checkout.stripe.com/c/pay/x' }) }; };
  const url = await credits.createCheckout({ user, pack: pack('p500'), origin: 'https://x.test', buyer: ca, fetchImpl: down });
  assert.ok(url.startsWith('https://checkout.stripe.com/'));
  console.log('ok: a failed price lookup does not block checkout');

  // ---- STRIPE_PRICES: ids you name yourself, checked against Stripe ----
  delete process.env.STRIPE_PRODUCTS;
  process.env.STRIPE_PRICES = JSON.stringify({ p500: { cad: 'price_cad500aaa' }, p1000: { cad: 'price_cad1000aa', usd: 'not-an-id' }, storage10: { cad: 'price_cadplusaa' } });
  assert.deepStrictEqual(P.explicit(), { p500: { cad: 'price_cad500aaa' }, p1000: { cad: 'price_cad1000aa' }, storage10: { cad: 'price_cadplusaa' } }, 'junk ids are dropped');
  P._reset(); f = fakeStripe();
  await credits.createCheckout({ user, pack: pack('p500'), origin: 'https://x.test', buyer: ca, fetchImpl: f.fetchImpl });
  assert.strictEqual(f.sessions()[0].get('line_items[0][price]'), 'price_cad500aaa');
  assert.ok(f.calls.some((c) => c.method === 'GET' && c.path === '/v1/prices/price_cad500aaa'), 'the named id is checked with Stripe');
  P._reset(); f = fakeStripe();
  await credits.createCheckout({ user, pack: pack('p2500'), origin: 'https://x.test', buyer: ca, fetchImpl: f.fetchImpl });
  assert.strictEqual(f.sessions()[0].has('line_items[0][price]'), false, 'a pack you did not name (and auto is off) stays inline');
  process.env.STRIPE_PRICES = '{not json';
  assert.deepStrictEqual(P.explicit(), {}, 'bad JSON is ignored, not a crash');
  delete process.env.STRIPE_PRICES;
  console.log('ok: STRIPE_PRICES ids are validated and checked');

  // ---- the surcharge line: SURCHARGE_PCT=stripe ----
  P._reset();
  const env = { SURCHARGE_PCT: 'stripe' };
  const q = S.quote(ca, 1000, env);
  assert.strictEqual(q.rate, 2.4, 'Canada: as much as the card rules allow');
  assert.strictEqual(q.cents, 24);
  assert.ok(/surcharge/i.test(q.label));
  assert.strictEqual(S.quote(us, 1000, env).rate, 3, 'US cap');
  assert.strictEqual(S.quote({ country: 'CA', region: 'QC' }, 1000, env).cents, 0, 'Quebec never');
  assert.strictEqual(S.quote(ca, 199, env).cents, 5, 'the 500 pack: 5 cents');
  assert.ok(S.publicInfo(env) && S.publicInfo(env).rates.CA === 2.4);
  assert.strictEqual(S.quote(ca, 1000, { SURCHARGE_PCT: 'abc' }).cents, 0, 'nonsense still turns it off');
  console.log('ok: SURCHARGE_PCT=stripe');

  // ---- and it lands on the Stripe checkout as its own line, next to your product ----
  process.env.STRIPE_PRODUCTS = 'auto'; process.env.SURCHARGE_PCT = 'stripe';
  P._reset(); f = fakeStripe();
  await credits.createCheckout({ user, pack: pack('p1000'), origin: 'https://x.test', buyer: ca, fetchImpl: f.fetchImpl });
  s = f.sessions()[0];
  assert.strictEqual(s.get('line_items[0][price]'), 'price_cad1000aa');
  assert.strictEqual(s.get('line_items[1][price_data][unit_amount]'), '8', '2.4% of 349 = 8 cents');
  assert.ok(/^Card processing surcharge \(2\.4%\)$/.test(s.get('line_items[1][price_data][product_data][name]')));
  assert.strictEqual(Number(s.get('metadata[total]')), 349 + 8);
  P._reset(); f = fakeStripe();
  await storage.createCheckout({ user, buyer: ca, origin: 'https://x.test', fetchImpl: f.fetchImpl });
  s = f.sessions()[0];
  assert.strictEqual(s.get('line_items[0][price]'), 'price_cadplusaa');
  assert.strictEqual(s.get('line_items[1][price_data][recurring][interval]'), 'month', 'the surcharge repeats monthly with the plan');
  assert.strictEqual(Number(s.get('metadata[total]')), 499 + 12);
  console.log('ok: the surcharge is its own line beside your Stripe product (packs and Aduna PLUS)');

  console.log('stripeprices-test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
