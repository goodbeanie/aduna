// Stripe checkout for credits, without a database or the network: node server/stripe-test.js
// Stripe is replaced by a fake that answers like the real REST API, so this checks OUR side: the price is set by the server,
// credits are granted only from a paid session of the right amount, once, and webhooks only count when Stripe's signature is real.
const assert = require('assert');
const crypto = require('crypto');
process.env.STRIPE_SECRET_KEY = 'sk_test_x'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
delete process.env.TAX_COLLECT_IN; delete process.env.SELL_TO; delete process.env.STRIPE_MANAGED_PAYMENTS;
const C = require('./credits');
const step = (m) => console.log('✓', m);
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
const user = (id = 'u1') => ({ id, createdAt: T0 - 86_400_000, bio: '' });
const US = { country: 'US', region: 'WA' }, CA = { country: 'CA', region: 'BC' }; // every order names where the buyer is
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function fakeStripe(opts = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init, params: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null });
    if (url.endsWith('/v1/checkout/sessions') && init.method === 'POST') return opts.fail ? res(400, { error: { message: 'nope' } }) : res(200, { id: 'cs_test_1', url: opts.url || 'https://checkout.stripe.com/c/pay/cs_test_1' });
    return res(404, {});
  };
  return { impl, calls };
}

const session = (over = {}) => ({
  id: 'cs_1', mode: 'payment', payment_status: 'paid', currency: 'usd', amount_total: 249, payment_intent: 'pi_1',
  metadata: { userId: 'u1', packId: 'p1000', country: 'US' }, total_details: { amount_tax: 0 },
  customer_details: { address: { country: 'US', state: 'WA' } }, ...over,
});
const done = (over, type = 'checkout.session.completed') => ({ type, data: { object: session(over) } });
const newDb = () => ({ users: { u1: user() }, payments: {} });

(async () => {
  // ---- switches ----
  assert.strictEqual(C.purchasesEnabled(), true);
  delete process.env.STRIPE_WEBHOOK_SECRET; assert.strictEqual(C.purchasesEnabled(), false, 'both settings are needed');
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
  step('Stripe is on only when the secret key and the webhook secret are both set');

  // ---- creating the checkout ----
  {
    const f = fakeStripe(), u = user();
    const pack = C.PACKS.find((p) => p.id === 'p2500');
    const url = await C.createCheckout({ user: u, pack, origin: 'https://aduna.test', buyer: US, fetchImpl: f.impl });
    assert.ok(url.startsWith('https://checkout.stripe.com/'), 'buyer is sent to Stripe Checkout');
    const p = f.calls[0].params;
    assert.strictEqual(f.calls[0].init.headers.Authorization, 'Bearer sk_test_x');
    assert.strictEqual(p.mode, 'payment');
    assert.strictEqual(p['line_items[0][price_data][unit_amount]'], String(pack.cents), 'the price is the pack\'s, never the browser\'s');
    assert.strictEqual(p['line_items[0][price_data][currency]'], 'usd');
    assert.strictEqual(p.client_reference_id, 'u1');
    assert.strictEqual(p['metadata[packId]'], 'p2500');
    assert.strictEqual(p['metadata[country]'], 'US');
    assert.strictEqual(p.success_url, 'https://aduna.test/app?credits=paid');
    assert.strictEqual(p.cancel_url, 'https://aduna.test/app?credits=cancelled');
    assert.strictEqual(p['managed_payments[enabled]'], 'false');
    assert.ok(!('line_items[1][quantity]' in p), 'no tax or surcharge line of our own');
    assert.ok(!('metadata[total]' in p) && !('metadata[tax]' in p), 'Stripe works out the total, not Aduna');
    await assert.rejects(C.createCheckout({ user: u, pack, origin: 'x', buyer: {}, fetchImpl: f.impl }), /country/);
    await assert.rejects(C.createCheckout({ user: u, pack, origin: 'x', buyer: { country: 'DE', region: 'BY' }, fetchImpl: f.impl }), /only sells/);
    await assert.rejects(C.createCheckout({ user: u, pack, origin: 'x', buyer: US, fetchImpl: fakeStripe({ fail: true }).impl }), /Stripe checkout failed/);
    step('checkout: server price, user and pack in metadata, return links, Stripe Checkout redirect, buyer must name a country');
  }
  {
    const f = fakeStripe();
    await C.createCheckout({ user: user(), pack: C.PACKS[0], origin: 'x', buyer: { country: 'US' }, fetchImpl: f.impl });
    const p = f.calls[0].params;
    assert.strictEqual(p['automatic_tax[enabled]'], 'true', 'Stripe Tax adds the tax');
    assert.strictEqual(p.billing_address_collection, 'required', 'Stripe asks for the billing address');
    assert.strictEqual(p['line_items[0][price_data][tax_behavior]'], 'exclusive', 'the tax goes on top of the price');
    step('Stripe collects the billing address and the tax; the buyer only names a country');
  }
  {
    const f = fakeStripe(), pack = C.PACKS.find((p) => p.id === 'p500');
    await C.createCheckout({ user: user(), pack, origin: 'x', buyer: CA, fetchImpl: f.impl });
    const p = f.calls[0].params;
    assert.strictEqual(p['line_items[0][price_data][currency]'], 'cad');
    assert.strictEqual(p['line_items[0][price_data][unit_amount]'], String(pack.cadCents), 'Canadians pay the CAD price');
    step('a Canadian buyer is charged the fixed CAD price');
  }
  {
    process.env.TAX_COLLECT_IN = 'CA-BC';
    const f = fakeStripe(), pack = C.PACKS.find((p) => p.id === 'p500');
    await C.createCheckout({ user: user(), pack, origin: 'x', buyer: CA, fetchImpl: f.impl });
    const p = f.calls[0].params;
    assert.ok(!('line_items[1][quantity]' in p), 'TAX_COLLECT_IN no longer adds a tax line');
    assert.strictEqual(p['automatic_tax[enabled]'], 'true');
    delete process.env.TAX_COLLECT_IN;
    step('the old TAX_COLLECT_IN setting adds nothing to checkout; Stripe Tax does it');
  }
  {
    process.env.STRIPE_MANAGED_PAYMENTS = 'on';
    const f = fakeStripe();
    await C.createCheckout({ user: user(), pack: C.PACKS[0], origin: 'x', buyer: US, fetchImpl: f.impl });
    assert.ok(!('managed_payments[enabled]' in f.calls[0].params));
    delete process.env.STRIPE_MANAGED_PAYMENTS;
    step('STRIPE_MANAGED_PAYMENTS=on leaves Stripe\'s managed payments alone');
  }

  // ---- webhook signature ----
  {
    const raw = Buffer.from('{"id":"evt_1"}'), now = 1_800_000_000;
    const sign = (t, body = raw, secret = 'whsec_x') => `t=${t},v1=${crypto.createHmac('sha256', secret).update(t + '.').update(body).digest('hex')}`;
    assert.strictEqual(C.verifyStripeSignature(raw, sign(now), 'whsec_x', now), true);
    assert.strictEqual(C.verifyStripeSignature(raw, sign(now, raw, 'other'), 'whsec_x', now), false, 'wrong secret');
    assert.strictEqual(C.verifyStripeSignature(Buffer.from('{"id":"evt_2"}'), sign(now), 'whsec_x', now), false, 'body changed');
    assert.strictEqual(C.verifyStripeSignature(raw, sign(now - 1000), 'whsec_x', now), false, 'too old: replay');
    assert.strictEqual(C.verifyStripeSignature(raw.toString(), sign(now), 'whsec_x', now), false, 'must be the raw bytes');
    assert.strictEqual(C.verifyStripeSignature(raw, '', 'whsec_x', now), false, 'missing header');
    assert.strictEqual(C.verifyStripeSignature(raw, sign(now), '', now), false, 'no secret configured');
    step('webhook signature: valid, wrong secret, edited body, replay, non-raw body and missing header');
  }

  // ---- crediting from a paid session ----
  {
    const db = newDb();
    assert.deepStrictEqual(C.handleStripeEvent(done(), db, T0), { uid: 'u1', delta: 1000, reason: 'purchase' });
    assert.strictEqual(db.users.u1.credits.balance, 1000);
    assert.strictEqual(db.users.u1.credits.bought, 1000);
    assert.strictEqual(db.payments.cs_1.cents, 249);
    assert.strictEqual(C.handleStripeEvent(done(), db, T0), null, 'Stripe retries: credited once');
    assert.strictEqual(db.users.u1.credits.balance, 1000);
    step('a paid session credits the pack once');
  }
  {
    const db = newDb();
    assert.strictEqual(C.handleStripeEvent(done({ payment_status: 'unpaid' }), db, T0), null, 'async payment not finished');
    assert.strictEqual(C.handleStripeEvent(done({ payment_status: 'paid' }, 'checkout.session.async_payment_succeeded'), db, T0).delta, 1000, 'the async success pays');
    assert.strictEqual(C.handleStripeEvent(done({ id: 'cs_sub', mode: 'subscription' }), db, T0), null, 'subscriptions are the storage plan\'s');
    step('unpaid sessions wait for async success; subscription sessions are left to the storage plan');
  }
  {
    const db = newDb();
    assert.strictEqual(C.handleStripeEvent(done({ amount_total: 1 }), db, T0), null, 'paid less than the pack costs');
    assert.strictEqual(C.handleStripeEvent(done({ currency: 'eur' }), db, T0), null, 'wrong currency');
    assert.strictEqual(C.handleStripeEvent(done({ currency: 'cad' }), db, T0), null, 'currency does not match the buyer\'s country');
    assert.strictEqual(C.handleStripeEvent(done({ amount_total: 99999 }), db, T0), null, 'far too much');
    assert.strictEqual(C.handleStripeEvent(done({ metadata: { userId: 'ghost', packId: 'p1000', country: 'US', total: '249' } }), db, T0), null, 'unknown user');
    assert.strictEqual(C.handleStripeEvent(done({ metadata: { userId: 'u1', packId: 'nope', country: 'US', total: '249' } }), db, T0), null, 'unknown pack');
    assert.strictEqual(db.users.u1.credits, undefined, 'nothing was credited');
    step('wrong amount, currency, user or pack: nothing credited');
  }
  {
    const db = newDb();
    const pack = C.PACKS.find((p) => p.id === 'p500'), tax = 31;
    const meta = { userId: 'u1', packId: 'p500', country: 'CA' };
    const taxed = { currency: 'cad', amount_total: pack.cadCents + tax, total_details: { amount_tax: tax }, metadata: meta, customer_details: { address: { country: 'CA', state: 'BC' } } };
    assert.strictEqual(C.handleStripeEvent(done(taxed), db, T0).delta, 500, 'credits for the pack, not for the tax');
    assert.strictEqual(db.payments.cs_1.tax, tax);
    assert.strictEqual(db.payments.cs_1.cents, pack.cadCents + tax);
    assert.strictEqual(db.payments.cs_1.region, 'BC', 'the province comes from the address Stripe collected');
    step('a purchase with Stripe Tax credits the pack and records the tax and where it was paid from');
  }
  {
    const db = newDb(), pack = C.PACKS.find((p) => p.id === 'p500');
    const base = { currency: 'cad', metadata: { userId: 'u1', packId: 'p500', country: 'CA' }, customer_details: { address: { country: 'CA', state: 'BC' } } };
    assert.strictEqual(C.handleStripeEvent(done({ ...base, amount_total: pack.cadCents + 40, total_details: { amount_tax: 0 } }), db, T0), null, 'more than the price with no tax to explain it');
    assert.strictEqual(C.handleStripeEvent(done({ ...base, amount_total: pack.cadCents * 3, total_details: { amount_tax: pack.cadCents * 2 } }), db, T0), null, 'tax far above any real rate');
    assert.strictEqual(db.users.u1.credits, undefined, 'nothing was credited');
    step('an amount that the price plus the reported tax does not explain is not credited');
  }
  {
    const db = newDb();
    const old = { metadata: { userId: 'u1', packId: 'p1000', country: 'US', region: 'WA', tax: '0', total: '249' } };
    assert.strictEqual(C.handleStripeEvent(done(old), db, T0).delta, 1000);
    step('a session made before Stripe Tax, with its own total in the metadata, still credits');
  }
  {
    const db = newDb(), warn = console.warn; let warned = '';
    console.warn = (m) => { warned += m; };
    C.handleStripeEvent(done({ customer_details: { address: { country: 'GB' } } }), db, T0);
    console.warn = warn;
    assert.ok(warned.includes('needs a look') && db.payments.cs_1.review === 'payer-outside', 'a card from outside the sales area is flagged');
    step('a payer in another country than the buyer said is credited but flagged for review');
  }

  // ---- refunds and disputes ----
  {
    const db = newDb();
    C.handleStripeEvent(done(), db, T0);
    const refund = (over = {}) => ({ type: 'charge.refunded', data: { object: { refunded: true, payment_intent: 'pi_1', ...over } } });
    assert.strictEqual(C.handleStripeEvent(refund({ refunded: false }), db, T0), null, 'partial refunds are ignored');
    assert.strictEqual(C.handleStripeEvent(refund({ payment_intent: 'pi_nope' }), db, T0), null, 'unknown payment');
    assert.deepStrictEqual(C.handleStripeEvent(refund(), db, T0), { uid: 'u1', delta: -1000, reason: 'refund' });
    assert.strictEqual(db.users.u1.credits.balance, 0);
    assert.strictEqual(C.handleStripeEvent(refund(), db, T0), null, 'refund applied once');
    step('a full refund takes the credits back, once');
  }
  {
    const db = newDb();
    C.handleStripeEvent(done(), db, T0);
    C.spend(db.users.u1, 800, 'shop', { now: T0 });
    const r = C.handleStripeEvent({ type: 'charge.dispute.created', data: { object: { payment_intent: 'pi_1' } } }, db, T0);
    assert.strictEqual(r.delta, -1000);
    assert.strictEqual(db.users.u1.credits.balance, -800, 'a chargeback can take the balance below zero');
    assert.strictEqual(C.spend(db.users.u1, 1, 'shop'), false, 'and then spending is blocked');
    assert.strictEqual(C.handleStripeEvent({ type: 'charge.refunded', data: { object: { refunded: true, payment_intent: 'pi_1' } } }, db, T0), null, 'a disputed payment is not clawed back twice');
    step('a dispute takes the credits back even when spent, and only once');
  }
  assert.strictEqual(C.handleStripeEvent(null, newDb(), T0), null);
  assert.strictEqual(C.handleStripeEvent({ type: 'customer.created', data: { object: {} } }, newDb(), T0), null);
  step('unrelated and empty events are ignored');

  console.log('\nAll Stripe credit checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
