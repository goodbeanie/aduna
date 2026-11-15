// The credit pack price change (Stripe's fee built into the prices): a checkout opened at the old price is still credited,
// anything else that does not match a price is not. No database or network: node server/pricechange-test.js
const assert = require('assert');
const C = require('./credits');

const step = (m) => console.log('✓', m);
const run = (over = {}, meta = {}, db = { users: { u1: { id: 'u1', createdAt: 0 } }, payments: {} }) => ({
  db,
  r: C.handleStripeEvent({ type: 'checkout.session.completed', data: { object: { id: 'cs_' + Math.random(), payment_status: 'paid', mode: 'payment', amount_total: 199, currency: 'usd', payment_intent: 'pi_' + Math.random(), metadata: { userId: 'u1', packId: 'p500', country: 'US', ...meta }, ...over } } }, db, 1),
});

{
  for (const p of C.PACKS) {
    for (const [now, was, cut] of [[p.cents, p.prevCents, 'usd'], [p.cadCents, p.prevCadCents, 'cad']]) {
      assert.ok(now > was, p.id + ' ' + cut + ': the new price is higher');
      assert.ok(now - Math.round(now * 0.029) - 30 >= was - 1, p.id + ' ' + cut + ': after Stripe\'s cut about the old price is left');
    }
  }
  step('every pack costs more in both currencies, and Stripe\'s 2.9% + 30 cents still leaves the old price');
}

{
  assert.strictEqual(run().r.delta, 500, 'US: the new price is credited');
  assert.strictEqual(run({ amount_total: 149 }).r.delta, 500, 'US: a checkout opened at the old price is still credited');
  assert.strictEqual(run({ amount_total: 170 }).r, null, 'US: a price that is neither is refused');
  assert.strictEqual(run({ amount_total: 100 }).r, null);
  assert.strictEqual(run({ currency: 'cad', amount_total: 239 }, { country: 'CA' }).r.delta, 500, 'CA: new price');
  assert.strictEqual(run({ currency: 'cad', amount_total: 199 }, { country: 'CA' }).r.delta, 500, 'CA: old price');
  assert.strictEqual(run({ currency: 'cad', amount_total: 189 }, { country: 'CA' }).r, null, 'a CAD session for the US number is refused');
  assert.strictEqual(run({ amount_total: 149 + 11, total_details: { amount_tax: 11 } }).r.delta, 500, 'old price plus Stripe Tax');
  assert.strictEqual(run({ amount_total: 199 + 11, total_details: { amount_tax: 11 } }).r.delta, 500, 'new price plus Stripe Tax');
  assert.strictEqual(run({ amount_total: 175, total_details: { amount_tax: 11 } }).r, null, 'tax on a wrong price is refused');
  const { db } = run({ amount_total: 149 });
  assert.strictEqual(Object.values(db.payments)[0].cents, 149, 'the record keeps what was really paid');
  step('webhook: new and old prices credited (also with tax), anything else refused');
}
