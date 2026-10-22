// PayPal checkout, without a database or the network: node server/paypal-test.js
// PayPal is replaced by a fake that answers like the real REST API, so this checks OUR side: the price is set by the server,
// credits are granted only from a COMPLETED capture of the right amount, once, and webhooks only count when PayPal says they are real.
const assert = require('assert');
process.env.PAYPAL_CLIENT_ID = 'cid'; process.env.PAYPAL_CLIENT_SECRET = 'sec'; process.env.PAYPAL_WEBHOOK_ID = 'WH-1';
delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET; delete process.env.PAYPAL_ENV;
const C = require('./credits');
const step = (m) => console.log('✓', m);
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
const user = (id = 'u1') => ({ id, createdAt: T0 - 86_400_000, bio: '' });
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// a fake PayPal
function fakePaypal(opts = {}) {
  const calls = [];
  const orders = {};
  const impl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body });
    if (url.endsWith('/v1/oauth2/token')) return opts.badLogin ? res(401, {}) : res(200, { access_token: 'tok' });
    if (url.endsWith('/v2/checkout/orders')) {
      const b = JSON.parse(init.body), pu = b.purchase_units[0];
      const id = 'ORD' + (Object.keys(orders).length + 1) + 'ABCDEFGH';
      orders[id] = { pu, captured: false };
      return res(201, { id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'self', href: 'x' }, { rel: 'payer-action', href: opts.approve || `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
    }
    const cap = url.match(/\/v2\/checkout\/orders\/([^/]+)\/capture$/);
    if (cap) {
      const o = orders[cap[1]] || opts.unknownOrder;
      if (!o) return res(404, { name: 'RESOURCE_NOT_FOUND' });
      if (o.captured) return res(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
      o.captured = true;
      return res(201, orderBody(cap[1], o));
    }
    const get = url.match(/\/v2\/checkout\/orders\/([^/]+)$/);
    if (get) return res(200, orderBody(get[1], orders[get[1]]));
    if (url.endsWith('/v1/notifications/verify-webhook-signature')) return res(200, { verification_status: opts.verify || 'SUCCESS' });
    return res(404, {});
  };
  const orderBody = (id, o) => ({ id, status: 'COMPLETED', purchase_units: [{ reference_id: o.pu.reference_id, payments: { captures: [{ id: 'CAP-' + id, status: opts.capStatus || 'COMPLETED', custom_id: o.pu.custom_id, amount: opts.amount || o.pu.amount }] } }] });
  return { impl, calls, orders };
}

(async () => {
  // ---- switches ----
  assert.strictEqual(C.paypalEnabled(), true);
  assert.strictEqual(C.purchasesEnabled(), true);
  delete process.env.PAYPAL_WEBHOOK_ID; assert.strictEqual(C.paypalEnabled(), false, 'all three settings are needed'); assert.strictEqual(C.purchasesEnabled(), false);
  process.env.PAYPAL_WEBHOOK_ID = 'WH-1';
  step('PayPal is on only when client id, secret and webhook id are all set');

  // ---- creating the order ----
  {
    const f = fakePaypal(), u = user();
    const pack = C.PACKS.find((p) => p.id === 'p1200');
    const out = await C.createPaypalOrder({ user: u, pack: { ...pack, cents: 1 }, origin: 'https://aduna.test', fetchImpl: f.impl });
    assert.ok(out.url.startsWith('https://www.sandbox.paypal.com/'), 'buyer is sent to PayPal');
    const order = JSON.parse(f.calls.find((c) => c.url.endsWith('/v2/checkout/orders')).body);
    assert.strictEqual(order.intent, 'CAPTURE');
    assert.strictEqual(order.purchase_units[0].amount.value, '0.01', 'the amount is whatever pack it is handed (index.js hands it the SERVER pack)');
    const o2 = JSON.parse((await (async () => { await C.createPaypalOrder({ user: u, pack, origin: 'https://aduna.test', fetchImpl: f.impl }); return f.calls.filter((c) => c.url.endsWith('/v2/checkout/orders')).at(-1); })()).body);
    assert.strictEqual(o2.purchase_units[0].amount.value, '9.99'); assert.strictEqual(o2.purchase_units[0].amount.currency_code, 'USD');
    assert.strictEqual(o2.purchase_units[0].custom_id, 'u1|p1200');
    assert.strictEqual(o2.payment_source.paypal.experience_context.return_url, 'https://aduna.test/app?credits=paypal');
    assert.strictEqual(o2.payment_source.paypal.experience_context.cancel_url, 'https://aduna.test/app?credits=cancelled');
    assert.strictEqual(o2.payment_source.paypal.experience_context.shipping_preference, 'NO_SHIPPING');
    assert.ok(f.calls[0].url.startsWith('https://api-m.sandbox.paypal.com/'), 'sandbox unless PAYPAL_ENV=live');
    assert.ok(f.calls[0].init.headers.Authorization.startsWith('Basic '));
    await assert.rejects(C.createPaypalOrder({ user: u, pack, origin: 'x', fetchImpl: fakePaypal({ approve: 'https://evil.example/pay' }).impl }), /unexpected approval/, 'never redirect the buyer anywhere but PayPal');
    await assert.rejects(C.createPaypalOrder({ user: u, pack, origin: 'x', fetchImpl: fakePaypal({ badLogin: true }).impl }), /sign-in failed/);
    process.env.PAYPAL_ENV = 'live'; const fl = fakePaypal(); await C.createPaypalOrder({ user: u, pack, origin: 'x', fetchImpl: fl.impl });
    assert.ok(fl.calls[0].url.startsWith('https://api-m.paypal.com/'), 'live when PAYPAL_ENV=live'); delete process.env.PAYPAL_ENV;
  }
  step('order: server price in USD, user and pack in custom_id, return/cancel links, PayPal-only redirect, sandbox vs live');

  // ---- capture and crediting ----
  {
    const u = user(), db = { users: { u1: u }, payments: {} };
    const f = fakePaypal();
    const { orderId } = await C.createPaypalOrder({ user: u, pack: C.PACKS.find((p) => p.id === 'p1200'), origin: 'x', fetchImpl: f.impl });
    await assert.rejects(C.capturePaypalOrder({ orderId: '../../x', db, fetchImpl: f.impl }), /Bad order/);
    const a = await C.capturePaypalOrder({ orderId, db, fetchImpl: f.impl, now: T0 });
    assert.strictEqual(a.status, 'completed'); assert.deepStrictEqual(a.change, { uid: 'u1', delta: 1200, reason: 'purchase' });
    assert.strictEqual(u.credits.balance, 1200); assert.strictEqual(u.credits.bought, 1200);
    assert.ok(db.payments['pp_CAP-' + orderId], 'payment recorded');
    const b = await C.capturePaypalOrder({ orderId, db, fetchImpl: f.impl, now: T0 + 1000 });
    assert.strictEqual(b.status, 'completed'); assert.strictEqual(b.change, null, 'second capture (tab reload, webhook race) pays nothing more');
    assert.strictEqual(u.credits.balance, 1200);

    // wrong amount, pending, unknown user/pack
    const db2 = { users: { u1: user() }, payments: {} };
    const f2 = fakePaypal({ amount: { currency_code: 'USD', value: '0.01' } });
    const o2 = (await C.createPaypalOrder({ user: db2.users.u1, pack: C.PACKS[0], origin: 'x', fetchImpl: f2.impl })).orderId;
    assert.strictEqual((await C.capturePaypalOrder({ orderId: o2, db: db2, fetchImpl: f2.impl })).change, null, 'paid less than the pack costs: nothing credited');
    const f3 = fakePaypal({ amount: { currency_code: 'EUR', value: '4.99' } });
    const o3 = (await C.createPaypalOrder({ user: db2.users.u1, pack: C.PACKS[0], origin: 'x', fetchImpl: f3.impl })).orderId;
    assert.strictEqual((await C.capturePaypalOrder({ orderId: o3, db: db2, fetchImpl: f3.impl })).change, null, 'wrong currency: nothing credited');
    const f4 = fakePaypal({ capStatus: 'PENDING' });
    const o4 = (await C.createPaypalOrder({ user: db2.users.u1, pack: C.PACKS[0], origin: 'x', fetchImpl: f4.impl })).orderId;
    const p4 = await C.capturePaypalOrder({ orderId: o4, db: db2, fetchImpl: f4.impl });
    assert.strictEqual(p4.status, 'pending'); assert.strictEqual(p4.change, null, 'a pending payment credits nothing yet');
    assert.strictEqual(db2.users.u1.credits, undefined, 'none of those touched the balance');
    const ghost = C.applyPaypalCapture({ id: 'C9', status: 'COMPLETED', custom_id: 'ghost|p500', amount: { currency_code: 'USD', value: '4.99' } }, db2, T0);
    assert.strictEqual(ghost, null, 'unknown user'); assert.strictEqual(C.applyPaypalCapture({ id: 'C9', status: 'COMPLETED', custom_id: 'u1|nope', amount: { currency_code: 'USD', value: '4.99' } }, db2, T0), null, 'unknown pack');
    assert.strictEqual(C.applyPaypalCapture({ id: 'C9', status: 'COMPLETED', custom_id: 'u1|p500' }, db2, T0), null, 'no amount');
  }
  step('capture: credits once, only when COMPLETED, amount, currency, pack and user all check out');

  // ---- webhook verification ----
  {
    const raw = Buffer.from('{"id":"WH-EVT","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"X","amount":{"value":"4.99"}}}');
    const headers = { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1', 'paypal-transmission-id': 'tid', 'paypal-transmission-sig': 'sig', 'paypal-transmission-time': '2026-10-21T10:00:00Z' };
    const f = fakePaypal();
    assert.strictEqual(await C.verifyPaypalWebhook(raw, headers, f.impl), true);
    const sent = f.calls.find((c) => c.url.endsWith('verify-webhook-signature')).body;
    assert.ok(sent.includes('"webhook_event":' + raw.toString()), 'the event goes to PayPal byte for byte');
    assert.strictEqual(JSON.parse(sent).webhook_id, 'WH-1');
    assert.strictEqual(await C.verifyPaypalWebhook(raw, headers, fakePaypal({ verify: 'FAILURE' }).impl), false, 'PayPal says no');
    assert.strictEqual(await C.verifyPaypalWebhook(raw, { ...headers, 'paypal-transmission-sig': '' }, f.impl), false, 'missing header');
    assert.strictEqual(await C.verifyPaypalWebhook(raw, { ...headers, 'paypal-cert-url': 'https://evil.example/cert' }, f.impl), false, 'certificate must come from paypal.com');
    assert.strictEqual(await C.verifyPaypalWebhook(raw.toString(), headers, f.impl), false, 'must be the raw bytes');
  }
  step('webhook signature: PayPal confirms it, event sent untouched; missing headers, foreign certificate and non-raw body refused');

  // ---- events: completion, refunds, reversals, disputes ----
  {
    const u = user(), db = { users: { u1: u }, payments: {} };
    const done = (id = 'CAP1') => ({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id, status: 'COMPLETED', custom_id: 'u1|p1200', amount: { currency_code: 'USD', value: '9.99' } } });
    assert.deepStrictEqual(C.handlePaypalEvent(done(), db, T0), { uid: 'u1', delta: 1200, reason: 'purchase' });
    assert.strictEqual(C.handlePaypalEvent(done(), db, T0), null, 'PayPal retries: credited once');
    assert.strictEqual(u.credits.balance, 1200);
    const refund = (value, cap = 'CAP1') => ({ event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'REF1', amount: { currency_code: 'USD', value }, links: [{ rel: 'self', href: 'https://api.paypal.com/v2/payments/refunds/REF1' }, { rel: 'up', href: `https://api.paypal.com/v2/payments/captures/${cap}` }] } });
    assert.strictEqual(C.handlePaypalEvent(refund('2.00'), db, T0), null, 'partial refunds are ignored');
    C.spend(u, 1000, 'x', { now: T0 });
    assert.deepStrictEqual(C.handlePaypalEvent(refund('9.99'), db, T0), { uid: 'u1', delta: -1200, reason: 'refund' });
    assert.strictEqual(u.credits.balance, 200 - 1200, 'a full refund takes the credits back even if spent');
    assert.strictEqual(C.handlePaypalEvent(refund('9.99'), db, T0), null, 'refund applied once');
    assert.strictEqual(C.handlePaypalEvent(refund('9.99', 'NOPE'), db, T0), null, 'unknown capture');

    C.handlePaypalEvent(done('CAP2'), db, T0);
    const before = u.credits.balance;
    assert.strictEqual(C.handlePaypalEvent({ event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { disputed_transactions: [{ seller_transaction_id: 'CAP2' }] } }, db, T0).delta, -1200);
    assert.strictEqual(u.credits.balance, before - 1200, 'the dispute takes back the 1200 that payment gave');
    C.handlePaypalEvent(done('CAP3'), db, T0);
    assert.strictEqual(C.handlePaypalEvent({ event_type: 'PAYMENT.CAPTURE.REVERSED', resource: { id: 'CAP3' } }, db, T0).delta, -1200);
    assert.strictEqual(u.credits.ledger.find((l) => l.reason === 'chargeback') ? true : false, true, 'reversals are labelled as such');
    assert.strictEqual(C.handlePaypalEvent({ event_type: 'BILLING.PLAN.CREATED', resource: {} }, db, T0), null);
    assert.strictEqual(C.handlePaypalEvent(null, db, T0), null);
  }
  step('events: payment completed once; full refunds, reversals and disputes take credits back once; partial refunds ignored');

  // ---- routes, with a tiny fake app ----
  {
    const routes = {};
    const app = { get: (p, ...h) => (routes['GET ' + p] = h), post: (p, ...h) => (routes['POST ' + p] = h) };
    const u = user(), db = { users: { u1: u }, servers: {}, emojis: {}, friendships: {}, payments: {} };
    const pushed = []; let saved = 0;
    const f = fakePaypal();
    C.register(app, { auth: (req, _r, next) => { req.user = u; next(); }, ah: (fn) => fn, db: () => db, save: () => saved++, notify: (id, p) => pushed.push([id, p]), fetchImpl: f.impl });
    const run = async (key, req) => { const out = { status: 200 }; const r = { status: (s) => { out.status = s; return r; }, json: (b) => { out.body = b; return r; } }; const h = routes[key]; await h[h.length - 1]({ headers: {}, params: {}, body: {}, get: () => 'aduna.test', protocol: 'https', ...req, user: u }, r); return out; };

    const v = (await run('GET /api/credits', {})).body;
    assert.strictEqual(v.purchases, true); assert.strictEqual(v.provider, 'paypal');
    const co = await run('POST /api/credits/checkout', { body: { packId: 'p500', cents: 1, amount: '0.01' } });
    assert.ok(co.body.url.includes('paypal.com'), 'checkout goes to PayPal');
    assert.strictEqual(JSON.parse(f.calls.filter((c) => c.url.endsWith('/v2/checkout/orders')).at(-1).body).purchase_units[0].amount.value, '4.99', 'the browser cannot set the price');
    assert.strictEqual((await run('POST /api/credits/checkout', { body: { packId: 'bogus' } })).status, 400);
    // Aduna's own checkout: order for the card fields / PayPal button
    assert.strictEqual(v.paypalClientId, 'cid', 'the app is told the (public) client id');
    const eo = await run('POST /api/credits/paypal/order', { body: { packId: 'p500', method: 'card', cents: 1 } });
    assert.ok(/^ORD/.test(eo.body.orderId));
    const eb = JSON.parse(f.calls.filter((c) => c.url.endsWith('/v2/checkout/orders')).at(-1).body);
    assert.strictEqual(eb.purchase_units[0].amount.value, '4.99', 'embedded orders are priced by the server too');
    assert.strictEqual(eb.payment_source.card.attributes.verification.method, 'SCA_WHEN_REQUIRED', 'card orders ask for 3-D Secure when needed');
    assert.strictEqual(eb.payment_source.paypal, undefined);
    await run('POST /api/credits/paypal/order', { body: { packId: 'p500', method: 'paypal' } });
    assert.strictEqual(JSON.parse(f.calls.filter((c) => c.url.endsWith('/v2/checkout/orders')).at(-1).body).payment_source, undefined, 'PayPal button orders carry no payment source');
    assert.strictEqual((await run('POST /api/credits/paypal/order', { body: { packId: 'bogus' } })).status, 400);
    const orderId = Object.keys(f.orders)[0];

    assert.strictEqual((await run('POST /api/credits/paypal/capture', { body: { orderId: '../x' } })).status, 400);
    const cap = await run('POST /api/credits/paypal/capture', { body: { orderId } });
    assert.strictEqual(cap.body.status, 'completed'); assert.strictEqual(cap.body.balance, 500); assert.ok(saved >= 1);
    assert.deepStrictEqual(pushed.at(-1), ['u1', { balance: 500, delta: 500, reason: 'purchase' }]);
    const again = await run('POST /api/credits/paypal/capture', { body: { orderId } });
    assert.strictEqual(again.body.balance, 500, 'capturing again pays nothing more');

    // webhook: forged is refused; approved-but-never-returned order is captured; replays pay nothing
    const hdr = { 'paypal-auth-algo': 'a', 'paypal-cert-url': 'https://api.paypal.com/c', 'paypal-transmission-id': 't', 'paypal-transmission-sig': 's', 'paypal-transmission-time': 'now' };
    const o2 = (await C.createPaypalOrder({ user: u, pack: C.PACKS.find((p) => p.id === 'p2600'), origin: 'x', fetchImpl: f.impl })).orderId;
    const evt = { event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: o2 } }, raw = Buffer.from(JSON.stringify(evt));
    const bad = fakePaypal({ verify: 'FAILURE' });
    const app2 = { get() {}, post: (p, ...h) => (routes2['POST ' + p] = h) }, routes2 = {};
    C.register(app2, { auth: (req, _r, next) => next(), ah: (fn) => fn, db: () => db, save: () => saved++, notify: (id, p) => pushed.push([id, p]), fetchImpl: bad.impl });
    const runBad = async (req) => { const out = {}; const r = { status: (s) => { out.status = s; return r; }, json: (b) => { out.body = b; return r; } }; await routes2['POST /api/credits/webhook/paypal'].at(-1)(req, r); if (!out.status) out.status = 200; return out; };
    assert.strictEqual((await runBad({ rawBody: raw, body: evt, headers: hdr })).status, 400);
    assert.strictEqual(u.credits.balance, 500, 'a forged webhook credits nothing');

    assert.strictEqual((await run('POST /api/credits/webhook/paypal', { rawBody: raw, body: evt, headers: hdr })).status, 200);
    assert.strictEqual(u.credits.balance, 500 + 2600, 'an approved order is captured and credited even if the buyer never came back');
    assert.deepStrictEqual(pushed.at(-1), ['u1', { balance: 3100, delta: 2600, reason: 'purchase' }]);
    const done = { event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-' + o2, status: 'COMPLETED', custom_id: 'u1|p2600', amount: { currency_code: 'USD', value: '19.99' } } };
    await run('POST /api/credits/webhook/paypal', { rawBody: Buffer.from(JSON.stringify(done)), body: done, headers: hdr });
    assert.strictEqual(u.credits.balance, 3100, 'the completion webhook that follows pays nothing more');
    assert.strictEqual((await run('POST /api/credits/webhook/paypal', { rawBody: undefined, body: done, headers: hdr })).status, 400, 'no raw body: refused');

    // PayPal off: its routes say so
    delete process.env.PAYPAL_CLIENT_ID;
    assert.strictEqual((await run('POST /api/credits/paypal/capture', { body: { orderId } })).status, 503);
    assert.strictEqual((await run('POST /api/credits/webhook/paypal', { rawBody: raw, body: evt, headers: hdr })).status, 503);
    assert.strictEqual((await run('GET /api/credits', {})).body.purchases, false);
  }
  step('routes: checkout uses the server price, capture route credits once and notifies, webhook verifies and also finishes orders the buyer never returned from');

  console.log('\nAll PayPal checks passed.');
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
