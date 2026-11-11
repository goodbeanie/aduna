// Storage plan paid with a card saved at PayPal (Vault), without a database or the network: node server/storage-vault-test.js
// PayPal is replaced by a fake that answers like the real REST API, so this checks OUR side: the price is set by the server, the plan
// starts only from a COMPLETED capture of the right amount for the right person, only PayPal's vault id is kept (never a card number),
// the monthly charge is made once per month with the saved card, declines are retried and then end the plan, and cancel stops it all.
const assert = require('assert');
process.env.PAYPAL_CLIENT_ID = 'cid'; process.env.PAYPAL_CLIENT_SECRET = 'sec'; process.env.PAYPAL_WEBHOOK_ID = 'WH-1';
delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET; delete process.env.PAYPAL_ENV;
const S = require('./storage');
const C = require('./credits');
const step = (m) => console.log('✓', m);
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);
const user = (id = 'u1') => ({ id, createdAt: T0 - DAY, bio: '' });
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const REF = { id: 'NETREF123', date: '1110', network: 'VISA', acquirer_reference_number: 'ARN1' };

// a fake PayPal
function fakePaypal(opts = {}) {
  const calls = [], orders = {};
  let n = 0;
  const impl = async (url, init = {}) => {
    let parsed = null; try { parsed = init.body ? JSON.parse(init.body) : null; } catch { /* the token request is a form, not JSON */ }
    calls.push({ url, init, method: init.method || 'GET', body: parsed });
    if (url.endsWith('/v1/oauth2/token')) return res(200, { access_token: 'tok' });
    if (url.endsWith('/v2/checkout/orders') && init.method === 'POST') {
      const b = JSON.parse(init.body), pu = b.purchase_units[0], card = b.payment_source?.card || {};
      const id = 'ORD' + (++n) + 'ABCDEFGH';
      orders[id] = { pu, captured: false };
      if (card.vault_id) { // a charge of a saved card: created and captured in one go
        if (opts.server500) return res(503, { name: 'SERVICE_UNAVAILABLE' });
        if (opts.decline) return res(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] });
        orders[id].captured = true;
        return res(201, { id, status: 'COMPLETED', purchase_units: [{ custom_id: pu.custom_id, payments: { captures: [{ id: 'CAP-' + id, status: 'COMPLETED', amount: pu.amount }] } }] });
      }
      return res(201, { id, status: 'CREATED' });
    }
    const cap = url.match(/\/v2\/checkout\/orders\/([^/]+)\/capture$/);
    if (cap) {
      const o = orders[cap[1]];
      if (!o) return res(404, { name: 'RESOURCE_NOT_FOUND' });
      if (o.captured) return res(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
      o.captured = true;
      return res(201, body(cap[1], o));
    }
    const get = url.match(/\/v2\/checkout\/orders\/([^/]+)$/);
    if (get) return res(200, body(get[1], orders[get[1]]));
    if (init.method === 'DELETE' && url.includes('/v3/vault/payment-tokens/')) return res(opts.deleteFails ? 500 : 204, {});
    return res(404, {});
  };
  const body = (id, o) => ({
    id, status: 'COMPLETED',
    purchase_units: [{ custom_id: o.pu.custom_id, payments: { captures: [{ id: 'CAP-' + id, status: opts.capStatus || 'COMPLETED', amount: opts.amount || o.pu.amount }] } }],
    payment_source: { card: {
      ...(opts.noVault ? {} : { attributes: { vault: { id: 'VLT123abc', status: 'VAULTED', customer: { id: 'CUST1' } } } }),
      stored_credential: { payment_initiator: 'CUSTOMER', payment_type: 'RECURRING', usage: 'FIRST', previous_network_transaction_reference: REF },
      last_digits: '1111', brand: 'VISA', // what PayPal shows about the card: must never be kept
    } },
  });
  return { impl, calls, orders };
}
const posts = (f, urlEnd) => f.calls.filter((c) => c.method === 'POST' && c.url.endsWith(urlEnd));

// sets a person up with a card on file, the way the first payment does
async function subscribed(f, u = user(), now = T0) {
  const { orderId } = await S.createVaultOrder({ user: u, buyer: {}, fetchImpl: f.impl });
  const r = await S.captureVaultOrder({ user: u, orderId, fetchImpl: f.impl, now });
  return { u, orderId, r };
}

(async () => {
  // ---- first payment: the order ----
  {
    const f = fakePaypal(), u = user();
    const { orderId, totalCents } = await S.createVaultOrder({ user: u, buyer: { amount: 1 }, fetchImpl: f.impl });
    assert.ok(/^ORD/.test(orderId)); assert.strictEqual(totalCents, 499, 'the server sets the price');
    const b = posts(f, '/v2/checkout/orders')[0].body, pu = b.purchase_units[0], card = b.payment_source.card;
    assert.strictEqual(pu.amount.value, '4.99'); assert.strictEqual(pu.amount.currency_code, 'USD');
    assert.strictEqual(pu.custom_id, 'storage|u1|499');
    assert.strictEqual(card.attributes.vault.store_in_vault, 'ON_SUCCESS', 'PayPal keeps the card after a successful payment');
    assert.strictEqual(card.stored_credential, undefined, 'the first order carries no stored_credential block');
    assert.strictEqual(b.intent, 'CAPTURE');
    assert.ok(f.calls[0].url.startsWith('https://api-m.sandbox.paypal.com/'), 'sandbox unless PAYPAL_ENV=live');
    step('first order: price from the server, card kept by PayPal after success, no first-recurring flag');
  }

  // ---- first payment: the capture starts the plan ----
  {
    const f = fakePaypal(), u = user();
    u.storageSub = { status: 'ended', paypalId: 'I-OLD123456789', paidThrough: T0 - 40 * DAY }; // an old PayPal Subscriptions record
    const { r } = await subscribed(f, u);
    assert.deepStrictEqual({ status: r.status, saved: r.saved, changed: r.changed }, { status: 'active', saved: true, changed: true });
    const s = u.storageSub;
    assert.strictEqual(s.kind, 'vault'); assert.strictEqual(s.status, 'active'); assert.strictEqual(s.vaultId, 'VLT123abc');
    assert.deepStrictEqual(s.netRef, REF); assert.strictEqual(s.amountCents, 499);
    assert.strictEqual(s.paypalId, undefined, 'the old subscription id is dropped so it is not synced again');
    assert.strictEqual(s.nextChargeAt, Date.UTC(2026, 11, 10, 12, 0, 0)); assert.strictEqual(s.paidThrough, T0 + S.PAID_FOR_MS);
    assert.strictEqual(S.isSubscriber(u, T0 + DAY), true);
    const stored = JSON.stringify(u.storageSub);
    assert.ok(!/1111|VISA"|last_digits|brand/.test(stored.replace('"network":"VISA"', '')), 'no card details are kept, only the vault id');
    step('capture: plan starts for the paid month, only the vault id and the network reference are kept');
  }
  {
    const f = fakePaypal(), u = user();
    const { orderId } = await subscribed(f, u);
    const again = await S.captureVaultOrder({ user: u, orderId, fetchImpl: f.impl, now: T0 + 1000 }); // second tab / webhook got there first
    assert.strictEqual(again.changed, false); assert.strictEqual(again.status, 'active');
    assert.strictEqual(u.storageSub.paidThrough, T0 + S.PAID_FOR_MS, 'a second capture adds no time');
    step('capture twice: the plan starts once');
  }
  {
    const f = fakePaypal(), u = user('u1'), other = user('u2');
    const { orderId } = await S.createVaultOrder({ user: u, buyer: {}, fetchImpl: f.impl });
    assert.strictEqual((await S.captureVaultOrder({ user: other, orderId, fetchImpl: f.impl, now: T0 })).status, 'mismatch');
    assert.strictEqual(other.storageSub, undefined, 'somebody else\'s payment never starts my plan');
    await assert.rejects(S.captureVaultOrder({ user: u, orderId: '../../x', fetchImpl: f.impl }), /Bad order/);
    step('capture: the payment must belong to the person asking; bad order ids are refused');
  }
  {
    const f = fakePaypal({ amount: { currency_code: 'USD', value: '0.01' } }), u = user();
    const { orderId } = await S.createVaultOrder({ user: u, buyer: {}, fetchImpl: f.impl });
    assert.strictEqual((await S.captureVaultOrder({ user: u, orderId, fetchImpl: f.impl, now: T0 })).status, 'failed');
    assert.strictEqual(u.storageSub, undefined, 'paid less than the plan costs: no plan');
    const f2 = fakePaypal({ amount: { currency_code: 'EUR', value: '4.99' } }), u2 = user();
    const o2 = (await S.createVaultOrder({ user: u2, buyer: {}, fetchImpl: f2.impl })).orderId;
    assert.strictEqual((await S.captureVaultOrder({ user: u2, orderId: o2, fetchImpl: f2.impl, now: T0 })).status, 'failed');
    const f3 = fakePaypal({ capStatus: 'PENDING' }), u3 = user();
    const o3 = (await S.createVaultOrder({ user: u3, buyer: {}, fetchImpl: f3.impl })).orderId;
    assert.strictEqual((await S.captureVaultOrder({ user: u3, orderId: o3, fetchImpl: f3.impl, now: T0 })).status, 'pending');
    assert.strictEqual(u3.storageSub, undefined, 'a PENDING capture starts nothing');
    step('capture: wrong amount, wrong currency or a pending payment start nothing');
  }
  {
    const f = fakePaypal({ noVault: true }), u = user();
    const { r } = await subscribed(f, u);
    assert.strictEqual(r.saved, false); assert.strictEqual(u.storageSub.status, 'cancelled'); assert.strictEqual(u.storageSub.vaultId, null);
    assert.strictEqual(S.isSubscriber(u, T0 + DAY), true, 'they paid, so the month is theirs');
    assert.strictEqual(S.isSubscriber(u, T0 + 40 * DAY), false);
    const g = fakePaypal(); assert.deepStrictEqual(await S.renewDue({ db: { users: { u1: u } }, fetchImpl: g.impl, now: T0 + 60 * DAY }), []);
    assert.strictEqual(posts(g, '/v2/checkout/orders').length, 0, 'nothing to charge when PayPal did not keep the card');
    step('PayPal did not keep the card: the paid month counts, nothing is renewed');
  }

  // ---- the monthly charge ----
  {
    const f = fakePaypal(), { u } = await subscribed(fakePaypal());
    const db = { users: { u1: u } }, due = u.storageSub.nextChargeAt;
    assert.deepStrictEqual(await S.renewDue({ db, fetchImpl: f.impl, now: due - 1000 }), []);
    assert.strictEqual(f.calls.length, 0, 'not due yet: PayPal is not even called');
    assert.deepStrictEqual(await S.renewDue({ db, fetchImpl: f.impl, now: due + 60_000 }), ['u1']);
    const b = posts(f, '/v2/checkout/orders')[0], card = b.body.payment_source.card;
    assert.strictEqual(card.vault_id, 'VLT123abc'); assert.strictEqual(b.body.purchase_units[0].amount.value, '4.99');
    assert.deepStrictEqual(card.stored_credential, { payment_initiator: 'MERCHANT', payment_type: 'RECURRING', usage: 'SUBSEQUENT', previous_network_transaction_reference: REF });
    assert.ok(b.init.headers['PayPal-Request-Id'].includes(String(due)), 'same attempt, same request id: a retry cannot charge twice');
    const s = u.storageSub;
    assert.strictEqual(s.status, 'active'); assert.strictEqual(s.failures, 0);
    assert.strictEqual(s.nextChargeAt, Date.UTC(2027, 0, 10, 12, 0, 0), 'next month, same day');
    assert.strictEqual(s.paidThrough, due + 60_000 + S.PAID_FOR_MS);
    assert.deepStrictEqual(await S.renewDue({ db, fetchImpl: f.impl, now: due + 120_000 }), [], 'charged this month already');
    assert.strictEqual(posts(f, '/v2/checkout/orders').length, 1);
    step('monthly charge: saved card, merchant-initiated, once a month, plan extended');
  }
  {
    assert.strictEqual(new Date(S.addMonth(Date.UTC(2027, 0, 31))).toISOString().slice(0, 10), '2027-02-28');
    assert.strictEqual(new Date(S.addMonth(Date.UTC(2027, 11, 15))).toISOString().slice(0, 10), '2028-01-15');
    step('"monthly" means the same day next month (the 31st becomes the last day of a short month)');
  }
  {
    const { u } = await subscribed(fakePaypal()), db = { users: { u1: u } };
    let now = u.storageSub.nextChargeAt + 1000;
    const f = fakePaypal({ decline: true });
    assert.deepStrictEqual(await S.renewDue({ db, fetchImpl: f.impl, now }), ['u1']);
    assert.strictEqual(u.storageSub.status, 'past_due'); assert.strictEqual(u.storageSub.failures, 1);
    assert.strictEqual(u.storageSub.nextChargeAt, now + 3 * DAY, 'a declined payment is tried again in 3 days');
    assert.deepStrictEqual(await S.renewDue({ db, fetchImpl: f.impl, now: now + DAY }), [], 'not before then');
    now += 3 * DAY; await S.renewDue({ db, fetchImpl: f.impl, now });
    assert.strictEqual(u.storageSub.failures, 2); assert.strictEqual(u.storageSub.status, 'past_due');
    const good = fakePaypal(); // the card works again on the third try: back to normal
    now += 3 * DAY; await S.renewDue({ db, fetchImpl: good.impl, now });
    assert.strictEqual(u.storageSub.status, 'active'); assert.strictEqual(u.storageSub.failures, 0);
    step('declines are retried every 3 days; a payment that goes through puts the plan back to normal');
  }
  {
    const { u } = await subscribed(fakePaypal()), db = { users: { u1: u } }, f = fakePaypal({ decline: true });
    let now = u.storageSub.nextChargeAt + 1000;
    for (let i = 0; i < 3; i++) { await S.renewDue({ db, fetchImpl: f.impl, now }); now += 3 * DAY; }
    assert.strictEqual(u.storageSub.status, 'ended'); assert.strictEqual(u.storageSub.vaultId, null); assert.strictEqual(u.storageSub.nextChargeAt, null);
    assert.ok(f.calls.some((c) => c.method === 'DELETE' && c.url.includes('/v3/vault/payment-tokens/VLT123abc')), 'PayPal is asked to forget the card');
    assert.strictEqual(S.isSubscriber(u, now), false);
    const n = f.calls.length; await S.renewDue({ db, fetchImpl: f.impl, now: now + 30 * DAY });
    assert.strictEqual(f.calls.length, n, 'an ended plan is never charged again');
    step('three declines in a row end the plan and PayPal forgets the card');
  }
  {
    const { u } = await subscribed(fakePaypal()), db = { users: { u1: u } }, f = fakePaypal({ server500: true });
    const now = u.storageSub.nextChargeAt + 1000;
    assert.deepStrictEqual(await S.renewDue({ db, fetchImpl: f.impl, now }), [], 'PayPal being down is not the person\'s fault');
    assert.strictEqual(u.storageSub.failures, 0); assert.strictEqual(u.storageSub.status, 'active');
    step('PayPal errors (5xx) are not counted as declines');
  }
  {
    const { u } = await subscribed(fakePaypal()), db = { users: { u1: u, u2: user('u2') } };
    u.storageSub.amountCents = 1; // a damaged record must never be charged
    const f = fakePaypal();
    assert.deepStrictEqual(await S.renewDue({ db, fetchImpl: f.impl, now: u.storageSub.nextChargeAt + 1000 }), []);
    assert.strictEqual(posts(f, '/v2/checkout/orders').length, 0);
    step('a stored amount outside the plan price is never charged');
  }

  // ---- cancel ----
  {
    const { u } = await subscribed(fakePaypal()), f = fakePaypal(), db = { users: { u1: u } };
    const r = await S.cancelVault({ user: u, fetchImpl: f.impl, now: T0 + 5 * DAY });
    assert.strictEqual(r.ok, true); assert.strictEqual(u.storageSub.status, 'cancelled'); assert.strictEqual(u.storageSub.vaultId, null);
    assert.ok(f.calls.some((c) => c.method === 'DELETE' && c.url.includes('VLT123abc')), 'PayPal forgets the card');
    assert.strictEqual(S.isSubscriber(u, T0 + 10 * DAY), true, 'the plan stays until the month that was paid for ends');
    assert.strictEqual(S.isSubscriber(u, T0 + 40 * DAY), false);
    const g = fakePaypal(); await S.renewDue({ db, fetchImpl: g.impl, now: T0 + 60 * DAY });
    assert.strictEqual(posts(g, '/v2/checkout/orders').length, 0, 'no more charges after cancelling');
    assert.strictEqual((await S.cancelVault({ user: u, fetchImpl: f.impl })).ok, false, 'cancelling twice is refused');
    const h = fakePaypal({ deleteFails: true }), { u: u2 } = await subscribed(fakePaypal(), user('u2'));
    assert.strictEqual((await S.cancelVault({ user: u2, fetchImpl: h.impl })).ok, true, 'PayPal failing to forget the card still stops the plan');
    assert.strictEqual(u2.storageSub.status, 'cancelled');
    step('cancel: no more charges, plan runs to the end of the paid month, PayPal forgets the card');
  }

  // ---- the credits code leaves storage payments alone ----
  {
    const db = { users: { u1: user() }, payments: {} };
    assert.strictEqual(C.applyPaypalCapture({ id: 'CAP1', status: 'COMPLETED', custom_id: 'storage|u1|499', amount: { currency_code: 'USD', value: '4.99' } }, db, T0), null);
    assert.deepStrictEqual(db.payments, {});
    step('a storage payment is never turned into credits');
  }
  console.log('\nstorage vault: all good');
})().catch((e) => { console.error(e); process.exit(1); });
