// The optional credit card surcharge, without a database or the network: node server/surcharge-test.js
const assert = require('assert');
const S = require('./surcharge');

const buyer = (country, region) => ({ country, region });

// off by default: no line, nothing shown to the client
assert.strictEqual(S.quote(buyer('CA', 'BC'), 1000, {}).cents, 0);
assert.strictEqual(S.publicInfo({}), null);
assert.strictEqual(S.quote(buyer('CA', 'BC'), 1000, { SURCHARGE_PCT: 'abc' }).cents, 0, 'nonsense turns it off');
assert.strictEqual(S.quote(buyer('CA', 'BC'), 1000, { SURCHARGE_PCT: '0' }).cents, 0);

// on: a percentage of the price, rounded to the cent, with a label that says what it is
const on = { SURCHARGE_PCT: '2.4' };
const q = S.quote(buyer('CA', 'BC'), 499, on);
assert.strictEqual(q.cents, Math.round((499 * 2.4) / 100));
assert.strictEqual(q.rate, 2.4);
assert.ok(/surcharge/i.test(q.label) && q.label.includes('2.4%'));

// the card-network caps are applied per country, whatever is asked for
assert.strictEqual(S.quote(buyer('CA', 'ON'), 1000, { SURCHARGE_PCT: '5' }).rate, 2.4, 'Canada is capped at 2.4%');
assert.strictEqual(S.quote(buyer('US', 'WA'), 1000, { SURCHARGE_PCT: '5' }).rate, 3, 'the US is capped at 3%');
assert.strictEqual(S.quote(buyer('US', 'WA'), 1000, { SURCHARGE_PCT: '2' }).rate, 2, 'a lower rate is kept');

// Quebec is never charged; listed places are left out too
assert.strictEqual(S.quote(buyer('CA', 'QC'), 1000, on).cents, 0, 'Quebec does not allow it');
assert.strictEqual(S.quote(buyer('CA', 'qc'), 1000, on).cents, 0, 'case does not matter');
assert.strictEqual(S.quote(buyer('US', 'CT'), 1000, { ...on, SURCHARGE_EXCLUDE: 'US-CT, us-ma' }).cents, 0);
assert.strictEqual(S.quote(buyer('US', 'MA'), 1000, { ...on, SURCHARGE_EXCLUDE: 'US-CT, us-ma' }).cents, 0);
assert.ok(S.quote(buyer('US', 'WA'), 1000, { ...on, SURCHARGE_EXCLUDE: 'US-CT' }).cents > 0, 'other states still pay it');
assert.strictEqual(S.quote(buyer('US', 'WA'), 1000, { ...on, SURCHARGE_EXCLUDE: 'US' }).cents, 0, 'a whole country can be left out');

// places Aduna does not sell to, or a buyer who has not said where they are: nothing
assert.strictEqual(S.quote(buyer('GB', ''), 1000, on).cents, 0);
assert.strictEqual(S.quote({}, 1000, on).cents, 0);
assert.strictEqual(S.quote(undefined, 1000, on).cents, 0);

// what the client gets: the capped rates and the places left out (Quebec always)
const info = S.publicInfo({ SURCHARGE_PCT: '5', SURCHARGE_EXCLUDE: 'US-CT' });
assert.deepStrictEqual(info.rates, { CA: 2.4, US: 3 });
assert.ok(info.exclude.includes('CA-QC') && info.exclude.includes('US-CT'));

// the client draws the line with the same rounding as the server
for (const base of [199, 349, 499, 699, 999, 359, 149, 249]) {
  assert.strictEqual(S.quote(buyer('CA', 'BC'), base, on).cents, Math.round((base * info.rates.CA) / 100));
}

console.log('surcharge-test: ok');
