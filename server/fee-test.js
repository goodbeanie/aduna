// PayPal's processing fee as an optional checkout line, without a database or the network: node server/fee-test.js
const assert = require('assert');
const F = require('./fee');
const step = (m) => console.log('✓', m);
const ON = { PAYMENT_FEE: 'on' };

// off unless PAYMENT_FEE=on: the listed prices already carry the fee
assert.strictEqual(F.settings({}), null);
assert.strictEqual(F.settings({ PAYMENT_FEE: 'off' }), null);
assert.strictEqual(F.quote({}, 499, {}).fee, 0);
assert.strictEqual(F.publicInfo({}), null);
step('no fee line unless PAYMENT_FEE=on');

// when on: 4.9% + 30 cents, off for the UK and the EU
assert.deepStrictEqual(F.settings(ON), { percent: 4.9, fixedCents: 30, skip: F.settings(ON).skip });
assert.ok(F.settings(ON).skip.includes('GB') && F.settings(ON).skip.includes('DE') && !F.settings(ON).skip.includes('CA'));
step('defaults: 4.9% + 30 cents, skipped in the UK and the EU');

// the fee covers itself: the seller keeps at least the price, and one cent less would not be enough
for (let net = 1; net <= 20000; net++) {
  const t = F.grossUp(net, 4.9, 30);
  const keeps = (x) => x * 10000 - x * 490 - 30 * 10000;     // what is left of x cents after the cut, times 10000 (whole numbers)
  assert.ok(keeps(t) >= net * 10000, 'covers the price at ' + net);
  assert.ok(keeps(t - 1) < net * 10000, 'and is the smallest total that does at ' + net);
}
step('the total is the smallest one that leaves the price after PayPal\'s cut (1 to 20000 cents)');

assert.strictEqual(F.quote({}, 199, ON).fee, 42, '$1.99 pack: $0.42 fee');
assert.strictEqual(F.quote({}, 499, ON).fee, 58, '$4.99 plan: $0.58 fee');
assert.strictEqual(F.quote({}, 1999, ON).fee, 135, '$19.99 pack: $1.35 fee');
step('examples: 1.99 -> 0.42, 4.99 -> 0.58, 19.99 -> 1.35');

// the listed prices (server/credits.js, server/storage.js) were set from this: each leaves at least the old price after the cut
for (const [net, listed] of [[279, 329], [699, 769], [1399, 1509], [2799, 2979], [199, 249], [499, 559], [999, 1089], [1999, 2139]]) {
  assert.ok(listed >= F.grossUp(net, 4.9, 30), net + ' is covered by ' + listed);
  assert.ok(listed - F.grossUp(net, 4.9, 30) < 10, listed + ' is the next price ending in 9, not more');
}
step('the listed prices cover the old prices after the fee and end in 9');

// where it is not added
assert.deepStrictEqual(F.quote({ country: 'de' }, 499, ON), { fee: 0, skipped: true }, 'EU buyer: no fee');
assert.deepStrictEqual(F.quote({ country: 'GB' }, 499, ON), { fee: 0, skipped: true }, 'UK buyer: no fee');
assert.strictEqual(F.quote({ country: 'CA', region: 'BC' }, 499, ON).fee, 58, 'Canada: fee');
assert.strictEqual(F.quote({ country: 'US', region: 'WA' }, 499, ON).fee, 58, 'US: fee');
assert.strictEqual(F.quote({ country: 'de' }, 499, { ...ON, PAYMENT_FEE_SKIP: 'FR' }).fee, 58, 'own skip list replaces the default');
assert.strictEqual(F.quote({ country: 'de' }, 499, { ...ON, PAYMENT_FEE_SKIP: '' }).fee, 58, 'an empty skip list skips nowhere');
step('skipped for the UK and EU by default, and the list can be changed');

// bad settings
assert.strictEqual(F.quote({}, 499, { ...ON, PAYMENT_FEE_PERCENT: '99' }).fee, 0, 'a typo never overcharges');
assert.strictEqual(F.quote({}, 499, { ...ON, PAYMENT_FEE_PERCENT: 'abc' }).fee, 0);
assert.strictEqual(F.quote({}, 499, { ...ON, PAYMENT_FEE_FIXED_CENTS: '-5' }).fee, 0);
assert.strictEqual(F.quote({}, 499, { ...ON, PAYMENT_FEE_PERCENT: '2.7', PAYMENT_FEE_FIXED_CENTS: '30' }).fee, 45, 'a lower rate, 2.7%');
assert.strictEqual(F.quote({}, 0, ON).fee, 0); assert.strictEqual(F.quote({}, 1.5, ON).fee, 0);
step('bad settings and other rates');

const info = F.publicInfo(ON);
assert.strictEqual(info.percent, 4.9); assert.strictEqual(info.fixedCents, 30); assert.ok(Array.isArray(info.skip));
step('the client gets percent, fixed fee and skip list');

console.log('\nfee tests passed');
