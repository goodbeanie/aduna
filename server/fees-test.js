// The card fee (server/fees.js) and how the webhook checks a payment that carries it, without a database or the network: node server/fees-test.js
const assert = require('assert');
const F = require('./fees');
const C = require('./credits');

const step = (m) => console.log('✓', m);
const ON = { CARD_FEE_PERCENT: '2.9', CARD_FEE_FIXED_CENTS: '30' };

// ---- off by default ----
{
  assert.strictEqual(F.config({}), null, 'no fee unless it is set');
  assert.strictEqual(F.quote(199, { country: 'CA', region: 'BC' }, null), null);
  assert.strictEqual(F.config({ CARD_FEE_PERCENT: '0', CARD_FEE_FIXED_CENTS: '0' }), null);
  step('off unless CARD_FEE_PERCENT / CARD_FEE_FIXED_CENTS is set');
}

// ---- where a surcharge line is allowed ----
{
  const cfg = F.config(ON);
  assert.strictEqual(F.surchargeAllowed('CA', 'BC', cfg), true, 'a Canadian province outside Quebec');
  assert.strictEqual(F.surchargeAllowed('CA', 'ON', cfg), true);
  assert.strictEqual(F.surchargeAllowed('CA', 'QC', cfg), false, 'never in Quebec');
  assert.strictEqual(F.surchargeAllowed('CA', '', cfg), false, 'province not given: cannot tell it from Quebec');
  assert.strictEqual(F.surchargeAllowed('US', 'FL', cfg), false, 'US states are off until they are listed');
  assert.strictEqual(F.surchargeAllowed('US', 'FL', F.config({ ...ON, CARD_SURCHARGE_IN: 'CA,US-FL' })), true);
  assert.strictEqual(F.surchargeAllowed('US', 'TX', F.config({ ...ON, CARD_SURCHARGE_IN: 'CA,US-FL' })), false);
  assert.strictEqual(F.surchargeAllowed('CA', 'QC', F.config({ ...ON, CARD_SURCHARGE_IN: 'CA-QC,CA' })), false, 'listing Quebec does not unlock it');
  assert.strictEqual(F.surchargeAllowed('CA', 'BC', F.config({ ...ON, CARD_SURCHARGE_IN: 'CA-ON' })), false, 'only the listed provinces');
  assert.strictEqual(F.surchargeAllowed('CA', 'BC', F.config({ ...ON, CARD_SURCHARGE_IN: 'none' })), false);
  step('surcharge allowed in listed Canadian provinces and US states, never Quebec, never without a province or state');
}

// ---- the sums ----
{
  const cfg = F.config(ON);
  // CAD 1.99 in BC: Stripe's cut of the fee-inclusive total must leave 199. The surcharge line is capped at 2.4% of the price (4 cents).
  const ca = F.quote(199, { country: 'CA', region: 'BC' }, cfg);
  assert.deepStrictEqual(ca, { fee: 37, surcharge: 4, inPrice: 33, unit: 232, total: 236 });
  // the same pack for Quebec: no surcharge line, everything in the price
  assert.deepStrictEqual(F.quote(199, { country: 'CA', region: 'QC' }, cfg), { fee: 37, surcharge: 0, inPrice: 37, unit: 236, total: 236 });
  assert.deepStrictEqual(F.quote(199, { country: 'CA' }, cfg), { fee: 37, surcharge: 0, inPrice: 37, unit: 236, total: 236 }, 'no province: in the price');
  assert.deepStrictEqual(F.quote(149, { country: 'US', region: 'FL' }, cfg), { fee: 36, surcharge: 0, inPrice: 36, unit: 185, total: 185 }, 'US: in the price');
  for (const [base, place] of [[149, { country: 'US' }], [199, { country: 'CA', region: 'ON' }], [999, { country: 'CA', region: 'QC' }], [719, { country: 'US', region: 'CA' }]]) {
    const q = F.quote(base, place, cfg);
    assert.strictEqual(q.unit + q.surcharge, q.total); assert.strictEqual(q.fee, q.surcharge + q.inPrice);
    assert.ok(q.total - Math.round(q.total * 0.029) - 30 >= base - 1, 'after Stripe takes its cut, about the price is left: ' + base);
    assert.ok(q.surcharge <= Math.floor(base * 0.024), 'never above the cap');
  }
  assert.strictEqual(F.config({ ...ON, CARD_SURCHARGE_MAX_PERCENT: '9' }).cap, 3, 'the cap setting cannot go above 3%');
  assert.strictEqual(F.config({ CARD_FEE_PERCENT: '50' }).pct, 10, 'a typo cannot make the fee huge');
  step('fee worked out so Stripe\'s cut leaves the price; surcharge line capped at 2.4%, the rest in the price');
}

// ---- the webhook expects the fee ----
{
  const u = { id: 'u1', createdAt: 0 }, db = { users: { u1: u }, payments: {} };
  const ev = (over = {}, meta = {}) => ({ type: 'checkout.session.completed', data: { object: { id: 'cs_f' + Math.random(), payment_status: 'paid', mode: 'payment', amount_total: 185, currency: 'usd', payment_intent: 'pi_f' + Math.random(), metadata: { userId: 'u1', packId: 'p500', country: 'US', fee: '36', surcharge: '0', ...meta }, ...over } } });
  assert.strictEqual(C.handleStripeEvent(ev({ amount_total: 149 }), db, 1), null, 'a fee was added but the buyer paid the bare price: not credited');
  assert.strictEqual(C.handleStripeEvent(ev({ amount_total: 190 }), db, 1), null, 'a total that is not price + fee: not credited');
  assert.strictEqual(C.handleStripeEvent(ev({}, { fee: '90' }), db, 1), null, 'a fee over half the price is refused');
  assert.strictEqual(C.handleStripeEvent(ev({}, { fee: '-5' }), db, 1), null);
  assert.strictEqual(C.handleStripeEvent(ev({}, { fee: 'abc' }), db, 1), null);
  assert.strictEqual(u.credits, undefined, 'none of those credited anything');

  const ok = C.handleStripeEvent(ev(), db, 1);
  assert.deepStrictEqual(ok, { uid: 'u1', delta: 500, reason: 'purchase' }, 'price + fee paid: credited');
  assert.strictEqual(Object.values(db.payments)[0].fee, 36, 'the fee is kept on the payment record');

  // with tax on top (Stripe Tax)
  const taxed = C.handleStripeEvent(ev({ amount_total: 185 + 13, total_details: { amount_tax: 13 } }), db, 1);
  assert.strictEqual(taxed.delta, 500, 'price + fee + tax: credited');

  // no fee in the metadata: the old rule, price only
  assert.strictEqual(C.handleStripeEvent(ev({ amount_total: 149, metadata: { userId: 'u1', packId: 'p500', country: 'US' } }), db, 1).delta, 500, 'sessions without a fee still work');

  // a surcharge line that went to a buyer whose billing address is in Quebec is flagged for a look
  const qc = ev({ currency: 'cad', amount_total: 236, customer_details: { address: { country: 'CA', state: 'QC' } } }, { country: 'CA', region: 'BC', fee: '37', surcharge: '4' });
  assert.strictEqual(C.handleStripeEvent(qc, db, 1).delta, 500);
  assert.strictEqual(Object.values(db.payments).at(-1).review, 'surcharge-region', 'flagged: the surcharge line should be refunded');
  const bc = ev({ currency: 'cad', amount_total: 236, customer_details: { address: { country: 'CA', state: 'BC' } } }, { country: 'CA', region: 'BC', fee: '37', surcharge: '4' });
  C.handleStripeEvent(bc, db, 1);
  assert.strictEqual(Object.values(db.payments).at(-1).review, undefined, 'a BC billing address is fine');
  step('webhook: credits only price + fee (+ tax); bad or missing fee refused; a surcharge billed to Quebec is flagged');
}
