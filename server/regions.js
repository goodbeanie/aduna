// Where Aduna sells, and what each place pays in. No Express or database imports, so server/regions-test.js can test it alone.
//
// SELL_TO=CA,US is the default: Canada pays in CAD, the US in USD. Each item has a fixed price in each currency (cadCents and cents in
// server/credits.js and server/storage.js). Every order names a country; Stripe collects the billing address and the tax.
// The sales report (server/sales-report.js) counts by the country and province or state Stripe reports.

const TAX = require('./tax');

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
// The country picks the currency. The region (province or state) is only kept when the client knows it; Stripe asks for the address.
function resolve(body, env = process.env) {
  const allowed = sellTo(env);
  const country = cc(body?.country);
  if (!country) return { ok: false, error: 'Choose your country first' };
  if (!allowed.includes(country)) return { ok: false, error: 'Aduna only sells to ' + (allowed.map((c) => NAME_OF[c]).join(' and ') || 'nobody') + ' for now' };
  const region = rg(body?.region);
  return { ok: true, country, region: region && TAX.RATES[country + '-' + region] ? region : '', currency: CURRENCY_OF[country] };
}

// An item's price in cents in a currency, or null when it has none there.
function priceIn(item, currency) {
  const cents = currency === 'cad' ? item?.cadCents : currency === 'usd' ? item?.cents : null;
  return Number.isInteger(cents) && cents > 0 ? cents : null;
}

// Why a payment needs a look, or ''. The buyer picks their own country at checkout, so the country Stripe has for the card is the check on it.
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

module.exports = { sellTo, currencyOf, resolve, priceIn, review, publicInfo };
