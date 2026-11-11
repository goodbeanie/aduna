// Where Aduna sells, and what each place pays in. No Express or database imports, so server/regions-test.js can test it alone.
//
// SELL_TO=CA,US is the default: Canada pays in CAD, the US in USD. The price is set once, in CAD, on each item (cadCents in
// server/credits.js and server/storage.js); the US price is that converted at the live USD to CAD rate (server/fx.js).
// Every order has to name a country and a province or state;
// the sales report (server/sales-report.js) counts by those.

const TAX = require('./tax');
const FX = require('./fx');           // the USD to CAD rate, fetched automatically (server/fx.js)

const CURRENCY_OF = { CA: 'cad', US: 'usd' };
const NAME_OF = { CA: 'Canada', US: 'the US' };

const cc = (v) => (typeof v === 'string' && /^[A-Za-z]{2}$/.test(v.trim()) ? v.trim().toUpperCase() : null);
const rg = (v) => (typeof v === 'string' && /^[A-Za-z]{2,3}$/.test(v.trim()) ? v.trim().toUpperCase() : null);

function sellTo(env = process.env) {
  const raw = env.SELL_TO === undefined ? 'CA,US' : String(env.SELL_TO);
  return [...new Set(raw.split(',').map((s) => s.trim().toUpperCase()).filter((c) => CURRENCY_OF[c]))];
}

const currencyOf = (country) => CURRENCY_OF[country] || null;

// { ok:true, country, region, currency } for a buyer Aduna sells to, or { ok:false, error } with something the buyer can read.
function resolve(body, env = process.env) {
  const allowed = sellTo(env);
  const country = cc(body?.country);
  if (!country) return { ok: false, error: 'Choose your country first' };
  if (!allowed.includes(country)) return { ok: false, error: 'Aduna only sells to ' + (allowed.map((c) => NAME_OF[c]).join(' and ') || 'nobody') + ' for now' };
  const region = rg(body?.region);
  if (!region || !TAX.RATES[country + '-' + region]) return { ok: false, error: country === 'US' ? 'Choose your state first' : 'Choose your province first' };
  return { ok: true, country, region, currency: CURRENCY_OF[country] };
}

// An item's price in cents in a currency, or null when it has none there.
function priceIn(item, currency, env = process.env) {
  if (currency === 'cad') return Number.isInteger(item?.cadCents) && item.cadCents > 0 ? item.cadCents : null;
  if (currency !== 'usd') return null;
  if (Number.isInteger(item?.cadCents) && item.cadCents > 0) return FX.toUsdCents(item.cadCents, env); // set in CAD, converted at today's rate (server/fx.js)
  return Number.isInteger(item?.cents) && item.cents > 0 ? item.cents : null;                         // an old item with only a fixed US price
}

// The lowest price a payment may carry and still be accepted. The US price moves with the exchange rate, so an order made a little while
// ago (at a slightly different rate) must still go through when it is captured; CAD prices never move.
const FX_DRIFT = 0.85;
function floorIn(item, currency, env = process.env) {
  const base = priceIn(item, currency, env);
  if (!base) return null;
  return currency === 'usd' && Number.isInteger(item?.cadCents) ? Math.round(base * FX_DRIFT) : base;
}

// The country PayPal has for the payer, from a captured order. '' when PayPal did not say.
function payerCountryOf(order) {
  return cc(order?.payer?.address?.country_code || order?.payment_source?.paypal?.address?.country_code || order?.payment_source?.card?.billing_address?.country_code) || '';
}

// Why a payment needs a look, or ''. The buyer picks their own country at checkout, so PayPal's answer is the check on it.
function review(country, payerCountry, env = process.env) {
  if (!payerCountry) return '';
  if (!sellTo(env).includes(payerCountry)) return 'payer-outside';
  if (country && payerCountry !== country) return 'payer-differs';
  return '';
}

// What the checkout needs to draw the pickers and pick a currency (the server still decides the real one).
function publicInfo(env = process.env) {
  const countries = sellTo(env);
  return { countries, currency: Object.fromEntries(countries.map((c) => [c, CURRENCY_OF[c]])) };
}

module.exports = { sellTo, currencyOf, resolve, priceIn, floorIn, payerCountryOf, review, publicInfo };
