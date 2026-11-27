// Storage plan billed by Stripe Billing, without a database or the network: node server/storage-stripe-test.js
// Stripe is replaced by a fake. This checks OUR side: the price is set by the server, the plan starts only from a PAID subscription
// session of the right amount for the right person, renewals and cancellations follow Stripe's signed events, and only Stripe's ids are kept.
const assert = require('assert');
process.env.STRIPE_SECRET_KEY = 'sk_test_x'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
delete process.env.TAX_COLLECT_IN; delete process.env.SELL_TO; delete process.env.STRIPE_MANAGED_PAYMENTS;
const S = require('./storage');
const step = (m) => console.log('✓', m);
const T0 = Date.UTC(2026, 10, 14, 12, 0, 0), DAY = 86_400_000;
const user = (id = 'u1') => ({ id, createdAt: T0 - 30 * DAY });
const US = { country: 'US', region: 'WA' }, CA = { country: 'CA', region: 'BC' };
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function fakeStripe(opts = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, params: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null });
    if (url.endsWith('/checkout/sessions') && method === 'POST') return res(200, { id: 'cs_sub_1', url: 'https://checkout.stripe.com/c/pay/cs_sub_1' });
    if (/\/checkout\/sessions\/cs_/.test(url) && method === 'GET') return res(200, opts.session || session());
    if (/\/subscriptions\/sub_/.test(url) && method === 'GET') return res(200, opts.sub || { id: 'sub_1', status: 'active', current_period_end: (T0 + 30 * DAY) / 1000 });
    if (/\/subscriptions\/sub_/.test(url) && method === 'POST') return opts.cancelFails ? res(500, { error: { message: 'boom' } }) : res(200, { id: 'sub_1', cancel_at_period_end: true });
    if (url.endsWith('/billing_portal/sessions')) return res(200, { url: 'https://billing.stripe.com/p/session/x' });
    if (/\/charges\/ch_/.test(url)) return res(200, { id: 'ch_1', customer: 'cus_1' });
    return res(404, {});
  };
  return { impl, calls };
}

const session = (over = {}) => ({
  id: 'cs_sub_1', mode: 'subscription', payment_status: 'paid', currency: 'usd', amount_total: S.PLAN.cents, customer: 'cus_1', subscription: 'sub_1',
  metadata: { kind: 'storage', userId: 'u1', country: 'US' }, total_details: { amount_tax: 0 },
  customer_details: { address: { country: 'US', state: 'WA' } }, ...over,
});
const started = () => { const u = user(); assert.strictEqual(S.applySession(u, session(), T0), 'changed'); return u; };

(async () => {
  // ---- creating the subscription checkout ----
  {
    const f = fakeStripe(), u = user();
    const { url } = await S.createCheckout({ user: u, buyer: US, origin: 'https://aduna.test', fetchImpl: f.impl });
    assert.ok(url.startsWith('https://checkout.stripe.com/'));
    const p = f.calls[0].params;
    assert.strictEqual(p.mode, 'subscription');
    assert.strictEqual(p['line_items[0][price_data][unit_amount]'], String(S.PLAN.cents), 'the price is the plan\'s, never the browser\'s');
    assert.strictEqual(p['line_items[0][price_data][recurring][interval]'], 'month');
    assert.strictEqual(p['metadata[kind]'], 'storage');
    assert.strictEqual(p['automatic_tax[enabled]'], 'true', 'Stripe Tax adds the tax to every month');
    assert.strictEqual(p.billing_address_collection, 'required');
    assert.strictEqual(p['line_items[0][price_data][tax_behavior]'], 'exclusive');
    assert.ok(!('metadata[total]' in p) && !('line_items[1][quantity]' in p), 'no tax or surcharge line of our own');
    assert.strictEqual(p['subscription_data[metadata][userId]'], 'u1');
    assert.ok(p.success_url.includes('storage=paid&session_id={CHECKOUT_SESSION_ID}'));
    await assert.rejects(S.createCheckout({ user: u, buyer: {}, origin: 'x', fetchImpl: f.impl }), /country/);
    const fc = fakeStripe();
    await S.createCheckout({ user: u, buyer: CA, origin: 'x', fetchImpl: fc.impl });
    assert.strictEqual(fc.calls[0].params['line_items[0][price_data][unit_amount]'], String(S.PLAN.cadCents), 'Canadians pay the CAD price');
    step('checkout: server price, monthly, metadata names the person, buyer must say where they are');
  }
  {
    for (const id of ['spark', 'premium']) {
      const f = fakeStripe(), plan = S.PLANS[id];
      await S.createCheckout({ user: user(), buyer: CA, origin: 'x', fetchImpl: f.impl, planId: id });
      const p = f.calls[0].params;
      assert.strictEqual(p['line_items[0][price_data][unit_amount]'], String(plan.cadCents), id + ': the plan\'s own price');
      assert.strictEqual(p['metadata[plan]'], id);
      const u = user();
      const paid = session({ currency: 'cad', amount_total: plan.cadCents, metadata: { kind: 'storage', userId: 'u1', country: 'CA', plan: id }, customer_details: { address: { country: 'CA', state: 'BC' } } });
      assert.strictEqual(S.applySession(u, paid, T0), 'changed');
      assert.strictEqual(S.activePlan(u, T0 + DAY), id);
      assert.strictEqual(S.isSubscriber(u, T0 + DAY), id === 'premium', 'only Premium has storage of its own besides Plus');
      assert.strictEqual(u.storagePayments[0].plan, id);
      assert.strictEqual(S.planBytes(u), plan.bytes || S.PLAN.bytes, id + ': storage comes from the plan');
      assert.strictEqual(S.applySession(user(), { ...paid, amount_total: plan.cadCents - 1 }, T0), 'bad', id + ': less than the plan costs');
    }
    {
      // the cheaper plan's price can never start the dearer plan, and the other way round
      const paid = (plan, cents) => session({ currency: 'cad', amount_total: cents, metadata: { kind: 'storage', userId: 'u1', country: 'CA', plan }, customer_details: { address: { country: 'CA', state: 'BC' } } });
      assert.strictEqual(S.applySession(user(), paid('premium', S.PLANS.spark.cadCents), T0), 'bad', 'Spark money does not buy Premium');
      assert.strictEqual(S.applySession(user(), paid('spark', S.PLANS.premium.cadCents), T0), 'bad', 'a Spark session is not a Premium payment');
    }
    await assert.rejects(S.createCheckout({ user: user(), buyer: US, origin: 'x', fetchImpl: fakeStripe().impl, planId: 'gold' }), /Pick a plan/);
    step('Spark and Premium: their own price and plan on the session, only paid sessions of the right amount start them');
  }

  // ---- starting the plan ----
  {
    const u = started();
    assert.strictEqual(u.storageSub.status, 'active');
    assert.strictEqual(u.storageSub.customerId, 'cus_1');
    assert.strictEqual(u.storageSub.paidThrough, T0 + S.PAID_FOR_MS);
    assert.strictEqual(S.isSubscriber(u, T0 + DAY), true);
    assert.strictEqual(S.isSubscriber(u, T0 + S.PAID_FOR_MS + 1), false, 'the plan lasts only for the time paid');
    assert.strictEqual(u.storagePayments.length, 1);
    assert.ok(!/4242|card|number/i.test(JSON.stringify(u.storageSub)), 'only Stripe\'s ids are kept');
    assert.strictEqual(S.applySession(u, session(), T0 + 1000), 'same', 'the same session twice adds nothing');
    assert.strictEqual(u.storageSub.paidThrough, T0 + S.PAID_FOR_MS);
    step('a paid session starts the plan for the paid month, once');
  }
  {
    const u = user(), tax = 52;
    const taxed = session({ currency: 'cad', amount_total: S.PLAN.cadCents + tax, total_details: { amount_tax: tax }, metadata: { kind: 'storage', userId: 'u1', country: 'CA' }, customer_details: { address: { country: 'CA', state: 'BC' } } });
    assert.strictEqual(S.applySession(u, taxed, T0), 'changed');
    assert.strictEqual(u.storageSub.tax, tax);
    assert.strictEqual(u.storageSub.region, 'BC', 'the province comes from the address Stripe collected');
    assert.strictEqual(u.storagePayments[0].cents, S.PLAN.cadCents + tax);
    const u2 = user();
    assert.strictEqual(S.applySession(u2, { ...taxed, amount_total: S.PLAN.cadCents + 400, total_details: { amount_tax: 0 } }, T0), 'bad', 'an amount the reported tax does not explain');
    assert.strictEqual(u2.storageSub, undefined);
    step('a subscription with Stripe Tax starts the plan and records the tax; an unexplained amount does not');
  }
  {
    const u = user();
    assert.strictEqual(S.applySession(u, session({ payment_status: 'unpaid' }), T0), 'unpaid');
    assert.strictEqual(S.applySession(u, session({ amount_total: 1, metadata: { kind: 'storage', userId: 'u1', country: 'US', total: '1' } }), T0), 'bad', 'paid less than the plan costs');
    assert.strictEqual(S.applySession(u, session({ currency: 'eur' }), T0), 'bad', 'wrong currency');
    assert.strictEqual(S.applySession(u, session({ metadata: { kind: 'storage', userId: 'u2', country: 'US', total: String(S.PLAN.cents) } }), T0), 'bad', 'somebody else\'s session');
    assert.strictEqual(S.applySession(u, session({ metadata: { kind: 'credits', userId: 'u1', country: 'US', total: String(S.PLAN.cents) } }), T0), 'bad', 'not a storage session');
    assert.strictEqual(S.applySession(u, session({ mode: 'payment' }), T0), 'bad', 'not a subscription');
    assert.strictEqual(S.applySession(u, session({ customer: '../x' }), T0), 'bad', 'bad Stripe id');
    assert.strictEqual(u.storageSub, undefined, 'nothing started');
    step('unpaid, wrong amount, wrong currency, someone else\'s and malformed sessions never start a plan');
  }
  {
    const u = user(), f = fakeStripe();
    assert.deepStrictEqual(await S.confirmSession({ user: u, sessionId: 'cs_sub_1', fetchImpl: f.impl, now: T0 }), { status: 'active', changed: true });
    assert.strictEqual(S.isSubscriber(u, T0), true);
    assert.strictEqual((await S.confirmSession({ user: u, sessionId: 'cs_sub_1', fetchImpl: f.impl, now: T0 + 1 })).status, 'active');
    await assert.rejects(S.confirmSession({ user: u, sessionId: '../../x', fetchImpl: f.impl }), /Bad session/);
    assert.strictEqual((await S.confirmSession({ user: user('u2'), sessionId: 'cs_sub_1', fetchImpl: f.impl })).status, 'mismatch', 'it must be the person\'s own payment');
    step('coming back from checkout: the server asks Stripe, and only for the person\'s own session');
  }

  // ---- Stripe's signed events ----
  {
    const u = started(), db = { users: { u1: u } };
    const ev = (type, object) => ({ type, data: { object } });
    const paid = (over = {}) => ev('invoice.paid', { id: 'in_2', customer: 'cus_1', billing_reason: 'subscription_cycle', amount_paid: 399, lines: { data: [{ period: { end: (T0 + 60 * DAY) / 1000 } }] }, ...over });
    assert.strictEqual(await S.handleEvent(paid({ billing_reason: 'subscription_create' }), db, T0 + DAY), null, 'the first month is the checkout\'s');
    assert.strictEqual(await S.handleEvent(paid({ amount_paid: 0 }), db, T0 + DAY), null, 'a free invoice renews nothing');
    assert.strictEqual(await S.handleEvent(paid({ customer: 'cus_other' }), db, T0 + DAY), null, 'unknown customer');
    assert.strictEqual(await S.handleEvent(paid(), db, T0 + 30 * DAY), 'u1');
    assert.ok(u.storageSub.paidThrough >= T0 + 60 * DAY, 'a renewal extends the plan to the end of the paid period');
    assert.strictEqual(u.storagePayments[0].renewal, true);
    step('invoice.paid: a renewal extends the plan; the first invoice and unknown customers do not');

    await S.handleEvent(ev('invoice.payment_failed', { customer: 'cus_1' }), db, T0 + 31 * DAY);
    assert.strictEqual(u.storageSub.status, 'past_due');
    await S.handleEvent(paid({ id: 'in_3' }), db, T0 + 32 * DAY);
    assert.strictEqual(u.storageSub.status, 'active', 'a late payment puts it right');
    step('a failed payment makes the plan past due, and paying puts it right');

    await S.handleEvent(ev('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1', status: 'active', cancel_at_period_end: true }), db, T0 + 33 * DAY);
    assert.strictEqual(u.storageSub.status, 'cancelled');
    assert.strictEqual(S.isSubscriber(u, T0 + 33 * DAY), true, 'a cancelled plan runs to the end of the paid time');
    await S.handleEvent(ev('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1', status: 'active', cancel_at_period_end: false }), db, T0 + 34 * DAY);
    assert.strictEqual(u.storageSub.status, 'active', 'changing their mind in the portal');
    assert.strictEqual(await S.handleEvent(ev('customer.subscription.deleted', { id: 'sub_old', customer: 'cus_1' }), db, T0), null, 'an older subscription of theirs');
    assert.strictEqual(await S.handleEvent(ev('customer.subscription.deleted', { id: 'sub_1', customer: 'cus_1' }), db, T0 + 35 * DAY), 'u1');
    assert.strictEqual(u.storageSub.status, 'ended');
    assert.strictEqual(S.isSubscriber(u, T0 + 36 * DAY), false);
    assert.strictEqual(S.isProtected(u, T0 + 36 * DAY), true, 'files stay safe through the grace period');
    assert.strictEqual(S.isProtected(u, T0 + 36 * DAY + S.GRACE_MS + DAY), false);
    step('cancel, undo cancel, delete: the plan follows Stripe; files keep a grace period after it ends');
  }
  {
    const u = started(), db = { users: { u1: u } }, f = fakeStripe();
    const ev = { type: 'charge.dispute.created', data: { object: { charge: 'ch_1' } } };
    assert.strictEqual(await S.handleEvent(ev, db, T0 + DAY, f.impl), 'u1');
    assert.strictEqual(u.storageSub.status, 'ended', 'a dispute ends the plan');
    assert.ok(f.calls.some((c) => c.url.endsWith('/charges/ch_1')), 'the dispute names the charge, so Stripe is asked whose it is');
    const u2 = started(), db2 = { users: { u1: u2 } };
    assert.strictEqual(await S.handleEvent({ type: 'charge.refunded', data: { object: { refunded: true, customer: 'cus_1' } } }, db2, T0 + DAY), 'u1');
    assert.strictEqual(u2.storageSub.status, 'ended', 'a full refund ends it');
    const u3 = started();
    assert.strictEqual(await S.handleEvent({ type: 'charge.refunded', data: { object: { refunded: false, customer: 'cus_1' } } }, { users: { u1: u3 } }, T0), null, 'a partial refund does not');
    step('a dispute or a full refund ends the plan');
  }

  // ---- cancel, portal, sync ----
  {
    const u = started(), f = fakeStripe();
    assert.deepStrictEqual(await S.cancelSubscription({ user: u, fetchImpl: f.impl, now: T0 + DAY }), { ok: true });
    assert.strictEqual(u.storageSub.status, 'cancelled');
    assert.strictEqual(f.calls[0].params.cancel_at_period_end, 'true', 'cancel at the end of the paid month');
    assert.strictEqual((await S.cancelSubscription({ user: user('u9'), fetchImpl: f.impl })).ok, false, 'no plan, nothing to cancel');
    await assert.rejects(S.cancelSubscription({ user: started(), fetchImpl: fakeStripe({ cancelFails: true }).impl }), /Stripe cancel failed/);
    assert.strictEqual(await S.portalUrl({ user: user('u9'), origin: 'x', fetchImpl: f.impl }), null);
    assert.ok((await S.portalUrl({ user: u, origin: 'https://aduna.test', fetchImpl: f.impl })).startsWith('https://billing.stripe.com/'));
    step('cancel keeps the plan to the end of the month; the billing portal opens only for people with a plan');
  }
  {
    const u = started(), f = fakeStripe();
    assert.strictEqual(await S.syncSubscription({ user: u, fetchImpl: f.impl, now: T0 + 2 * DAY }), false, 'not near the end: no need to ask');
    const late = T0 + S.PAID_FOR_MS - DAY;
    assert.strictEqual(await S.syncSubscription({ user: u, fetchImpl: f.impl, now: late }), true);
    assert.ok(u.storageSub.paidThrough >= T0 + 30 * DAY, 'a missed webhook is made up by asking Stripe');
    assert.strictEqual(await S.syncSubscription({ user: u, fetchImpl: f.impl, now: late + 1000 }), false, 'asked at most once an hour');
    const u2 = started();
    await S.syncSubscription({ user: u2, fetchImpl: fakeStripe({ sub: { id: 'sub_1', status: 'canceled' } }).impl, now: late });
    assert.strictEqual(u2.storageSub.status, 'ended', 'Stripe says it is cancelled');
    step('sync: a plan nearly out of time is checked with Stripe, at most once an hour');
  }

  console.log('\nAll Stripe storage-plan checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
