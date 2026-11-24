// Sponsored servers, without a database or the network: node server/sponsored-test.js
const assert = require('assert');
delete process.env.SELL_TO;
const S = require('./sponsored');
const C = require('./credits');

const HOUR = 3_600_000, DAY = 24 * HOUR, T0 = Date.UTC(2026, 10, 24, 12, 0, 0);
const server = (id, over = {}) => ({ id, ownerId: 'u1', visibility: 'public', ...over });
const week = S.planOf('week'), month = S.planOf('month');
const step = (m) => console.log('ok -', m);

const session = (over = {}) => ({
  id: 'cs_1', mode: 'payment', payment_status: 'paid', currency: 'usd', amount_total: week.cents, payment_intent: 'pi_1',
  metadata: { kind: 'sponsored', userId: 'u1', serverId: 's1', planId: 'week', country: 'US' }, total_details: { amount_tax: 0 },
  customer_details: { address: { country: 'US', state: 'WA' } }, ...over,
});
const done = (over, type = 'checkout.session.completed') => ({ type, data: { object: session(over) } });
const newDb = () => ({ users: { u1: { id: 'u1' } }, servers: { s1: server('s1') }, payments: {} });

(async () => {
  // plans
  {
    assert.deepStrictEqual(S.plansView().map((p) => [p.id, p.days, p.cents, p.cadCents]), [['week', 7, 499, 649], ['month', 30, 1499, 1999]]);
    assert.strictEqual(S.planOf('year'), null);
    assert.strictEqual(S.planOf(undefined), null);
    step('two plans with fixed USD and CAD prices; unknown plans are refused');
  }

  // who can buy
  {
    assert.strictEqual(S.eligibility(server('s1', { visibility: 'private' })).code, 'not_public');
    assert.strictEqual(S.eligibility(server('s1', { listingHold: { by: 'a' } })).code, 'on_hold');
    assert.strictEqual(S.eligibility(server('s1'), 'The description has a link').code, 'listing_problem');
    assert.strictEqual(S.eligibility(server('s1')).ok, true);
    const bad = S.canBuy(server('s1', { visibility: 'private' }), [], week, T0);
    assert.deepStrictEqual([bad.ok, bad.status], [false, 400]);
    step('only a public server with no hold that passes the listing checks can buy');
  }

  // slots
  {
    const list = ['a', 'b', 'c'].map((id) => server(id));
    for (const s of list) S.grant(s, 7, T0);
    const fresh = server('d');
    const full = S.canBuy(fresh, [...list, fresh], week, T0 + HOUR);
    assert.deepStrictEqual([full.ok, full.status, full.code], [false, 409, 'slots_full']);
    assert.strictEqual(S.canBuy(list[0], [...list, fresh], week, T0 + HOUR).ok, true, 'a server that holds a slot can extend');
    assert.strictEqual(S.canBuy(fresh, [...list, fresh], week, T0 + 8 * DAY).ok, true, 'a slot frees up when its run ends');
    assert.deepStrictEqual(S.slots([...list, fresh], T0 + HOUR), { used: 3, max: 3, open: 0 });
    step('three slots: a new server waits for a free one, a holder can always extend');
  }

  // stacking
  {
    const s = server('s1');
    S.grant(s, 7, T0);
    S.grant(s, 30, T0 + 2 * DAY);
    assert.strictEqual(s.sponsored.until, T0 + 37 * DAY, 'days are added to the end of the run');
    assert.strictEqual(s.sponsored.since, T0, 'the run keeps its start');
    assert.strictEqual(S.canBuy(s, [s], month, T0 + 2 * DAY).code, 'too_far_ahead', '35 days left plus 30 is over 60');
    assert.strictEqual(S.canBuy(s, [s], week, T0 + 2 * DAY).ok, true, '35 days left plus 7 fits');
    S.grant(s, 7, T0 + 100 * DAY);
    assert.strictEqual(s.sponsored.until, T0 + 107 * DAY, 'after it ended, a new run starts from now');
    assert.strictEqual(s.sponsored.since, T0 + 100 * DAY);
    step('buying again adds days to the end, up to 60 days ahead');
  }

  // order and rotation
  {
    const a = server('a'), b = server('b'), c = server('c');
    S.grant(b, 7, T0); S.grant(a, 7, T0 + HOUR); S.grant(c, 7, T0 + 2 * HOUR);
    assert.deepStrictEqual(S.holders([a, b, c], T0 + 3 * HOUR).map((s) => s.id), ['b', 'a', 'c'], 'longest-running first');
    assert.deepStrictEqual(S.holders([a, b, c], T0 + 9 * DAY), [], 'ended runs are not shown');
    assert.deepStrictEqual(S.holders([a, b, c, server('d')], T0 + 3 * HOUR, 2).map((s) => s.id), ['b', 'a'], 'never more than the slots');
    const ids = (t) => S.rotate([a, b, c], t).map((s) => s.id).join('');
    const hour = Math.floor(T0 / HOUR);
    const seen = new Set([0, 1, 2].map((i) => ids((hour + i) * HOUR + 5)));
    assert.strictEqual(seen.size, 3, 'each of the three leads in turn');
    assert.strictEqual(ids(hour * HOUR + 5), ids(hour * HOUR + HOUR - 5), 'the order holds for the whole hour');
    assert.deepStrictEqual(S.rotate([a], T0), [a]);
    step('longest-running first, order turns every hour');
  }

  // stats
  {
    const s = server('s1');
    S.noteViews([s], T0); S.noteJoin(s, T0);
    assert.deepStrictEqual(S.ownerView(s, T0), { active: false, until: null, since: null, views: 0, joins: 0 }, 'nothing is counted before a run');
    S.grant(s, 7, T0);
    S.noteViews([s], T0 + HOUR); S.noteViews([s], T0 + 2 * HOUR); S.noteJoin(s, T0 + 2 * HOUR);
    assert.deepStrictEqual([S.ownerView(s, T0 + 3 * HOUR).views, S.ownerView(s, T0 + 3 * HOUR).joins], [2, 1]);
    S.grant(s, 7, T0 + DAY);
    assert.strictEqual(S.ownerView(s, T0 + DAY).views, 2, 'extending keeps the numbers');
    S.noteViews([s], T0 + 20 * DAY); S.noteJoin(s, T0 + 20 * DAY);
    assert.strictEqual(S.ownerView(s, T0 + 20 * DAY).views, 2, 'an ended run stops counting');
    assert.strictEqual(S.ownerView(s, T0 + 20 * DAY).active, false);
    S.grant(s, 7, T0 + 30 * DAY);
    assert.deepStrictEqual([S.ownerView(s, T0 + 30 * DAY).views, S.ownerView(s, T0 + 30 * DAY).joins], [0, 0], 'a new run starts at zero');
    step('views and joins count per run and only while the run is on');
  }

  // grant, revoke
  {
    const s = server('s1');
    S.grant(s, 10, T0);
    S.revoke(s, T0 + DAY);
    assert.strictEqual(S.isActive(s, T0 + DAY + 1), false);
    assert.strictEqual(S.ownerView(s, T0 + 2 * DAY).views, 0);
    S.revoke(server('x'), T0);
    step('an admin can end a run at once');
  }

  // checkout
  {
    const calls = [];
    const createSession = async (params) => { calls.push(params); return { url: 'https://checkout.stripe.com/c/pay/cs_x' }; };
    const s = server('s1'), user = { id: 'u1', email: 'o@example.com' };
    const go = (plan, buyer) => S.createCheckout({ user, server: s, plan, origin: 'https://aduna.test', buyer, createSession, tax: C.STRIPE_TAX });
    assert.strictEqual(await go(month, { country: 'US', region: 'WA', cents: 1 }), 'https://checkout.stripe.com/c/pay/cs_x');
    const p = calls[0];
    assert.strictEqual(p.mode, 'payment');
    assert.strictEqual(p['line_items[0][price_data][unit_amount]'], '1499', 'the price is the plan\'s, never the browser\'s');
    assert.strictEqual(p['line_items[0][price_data][currency]'], 'usd');
    assert.strictEqual(p['automatic_tax[enabled]'], 'true');
    assert.strictEqual(p['metadata[kind]'], 'sponsored');
    assert.strictEqual(p['metadata[serverId]'], 's1');
    assert.strictEqual(p['metadata[planId]'], 'month');
    assert.strictEqual(p.client_reference_id, 'u1');
    assert.strictEqual(p.customer_email, 'o@example.com');
    assert.strictEqual(p.success_url, 'https://aduna.test/app?sponsored=paid&server=s1');
    assert.strictEqual(p.cancel_url, 'https://aduna.test/app?sponsored=cancelled&server=s1');
    await go(week, { country: 'CA', region: 'BC' });
    assert.strictEqual(calls[1]['line_items[0][price_data][unit_amount]'], '649');
    assert.strictEqual(calls[1]['line_items[0][price_data][currency]'], 'cad');
    await assert.rejects(go(week, {}), (e) => e.forBuyer && /country/.test(e.message));
    await assert.rejects(go(week, { country: 'DE' }), (e) => e.forBuyer && /only sells/.test(e.message));
    step('checkout: server price in USD or CAD, Stripe collects the tax, the buyer has to name a country');
  }

  // payment recorded from the webhook
  {
    const db = newDb();
    assert.deepStrictEqual(S.handleEvent(done(), db, T0), { serverId: 's1' });
    assert.strictEqual(db.servers.s1.sponsored.until, T0 + 7 * DAY);
    const rec = db.payments.cs_1;
    assert.deepStrictEqual([rec.kind, rec.userId, rec.serverId, rec.days, rec.cents, rec.currency, rec.country, rec.region], ['sponsored', 'u1', 's1', 7, 499, 'usd', 'US', 'WA']);
    assert.strictEqual(S.handleEvent(done(), db, T0 + HOUR), null, 'Stripe sends duplicates: one payment, one grant');
    assert.strictEqual(db.servers.s1.sponsored.until, T0 + 7 * DAY);
    step('a paid session starts the run and is recorded once');
  }
  {
    const db = newDb();
    assert.strictEqual(S.handleEvent(done({ payment_status: 'unpaid' }), db, T0), null, 'not paid yet');
    assert.strictEqual(S.handleEvent(done({ amount_total: 1 }), db, T0), null, 'paid less than the plan costs');
    assert.strictEqual(S.handleEvent(done({ currency: 'cad' }), db, T0), null, 'the amount is not the CAD price');
    assert.strictEqual(S.handleEvent(done({ currency: 'eur', amount_total: 499 }), db, T0), null, 'a currency Aduna does not sell in');
    assert.strictEqual(S.handleEvent(done({ metadata: { ...session().metadata, planId: 'year' } }), db, T0), null, 'unknown plan');
    assert.strictEqual(S.handleEvent(done({ metadata: { ...session().metadata, serverId: 'gone' } }), db, T0), null, 'unknown server');
    assert.strictEqual(S.handleEvent(done({ metadata: { ...session().metadata, userId: 'nobody' } }), db, T0), null, 'unknown buyer');
    assert.strictEqual(S.handleEvent(done({ metadata: { ...session().metadata, kind: 'credits' } }), db, T0), null, 'not ours');
    assert.strictEqual(S.handleEvent({ type: 'invoice.paid', data: { object: {} } }, db, T0), null);
    assert.deepStrictEqual(db.payments, {});
    assert.strictEqual(db.servers.s1.sponsored, undefined, 'nothing started');
    step('bad sessions start nothing');
  }
  {
    const db = newDb(), tax = 65;
    assert.ok(S.handleEvent(done({ amount_total: week.cents + tax, total_details: { amount_tax: tax } }), db, T0));
    assert.strictEqual(db.payments.cs_1.tax, tax);
    assert.strictEqual(db.payments.cs_1.cents, week.cents + tax);
    const db2 = newDb();
    assert.ok(S.handleEvent(done({ currency: 'cad', amount_total: week.cadCents, metadata: { ...session().metadata, country: 'CA' }, customer_details: { address: { country: 'CA', state: 'BC' } } }), db2, T0));
    step('tax on top of the price is accepted; CAD buyers pay the CAD price');
  }
  {
    const db = newDb();
    S.handleEvent(done(), db, T0);
    S.grant(db.servers.s1, 30, T0 + DAY);
    assert.deepStrictEqual(S.handleEvent({ type: 'charge.refunded', data: { object: { refunded: false, payment_intent: 'pi_1' } } }, db, T0 + 2 * DAY), null, 'a partial refund takes nothing back');
    assert.deepStrictEqual(S.handleEvent({ type: 'charge.refunded', data: { object: { refunded: true, payment_intent: 'pi_1' } } }, db, T0 + 2 * DAY), { serverId: 's1' });
    assert.strictEqual(db.servers.s1.sponsored.until, T0 + 30 * DAY, 'only the refunded week comes off');
    assert.strictEqual(db.payments.cs_1.reversed, true);
    assert.strictEqual(S.handleEvent({ type: 'charge.dispute.created', data: { object: { payment_intent: 'pi_1' } } }, db, T0 + 3 * DAY), null, 'a payment is reversed once');
    assert.strictEqual(db.servers.s1.sponsored.until, T0 + 30 * DAY);
    step('a full refund takes the days off once; a partial refund does not');
  }
  {
    const db = newDb();
    S.handleEvent(done(), db, T0);
    assert.deepStrictEqual(S.handleEvent({ type: 'charge.dispute.created', data: { object: { payment_intent: 'pi_1' } } }, db, T0 + DAY), { serverId: 's1' });
    assert.ok(S.untilOf(db.servers.s1) <= T0, 'a dispute ends the run');
    assert.strictEqual(S.handleEvent({ type: 'charge.refunded', data: { object: { refunded: true, payment_intent: 'pi_unknown' } } }, db, T0), null);
    step('a dispute ends the run; refunds for other payments are ignored');
  }

  // credits.js leaves sponsored payments alone
  {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
    const db = newDb();
    assert.strictEqual(C.handleStripeEvent(done(), db, T0), null, 'the credit-pack code skips a sponsored session');
    assert.deepStrictEqual(db.payments, {});
    S.handleEvent(done(), db, T0);
    assert.strictEqual(C.handleStripeEvent({ type: 'charge.refunded', data: { object: { refunded: true, payment_intent: 'pi_1' } } }, db, T0), null, 'and a sponsored refund');
    assert.strictEqual(db.payments.cs_1.reversed, false, 'it was left for sponsored.js');
    assert.strictEqual(db.users.u1.credits, undefined, 'no credits moved');
    step('credits.js ignores sponsored payments, so one payment is never handled twice');
  }

  console.log('sponsored: all good');
})().catch((e) => { console.error(e); process.exit(1); });
