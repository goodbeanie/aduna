// Optional credit card surcharge: a separate line at checkout next to the price (and the tax). No Express or database imports,
// so server/surcharge-test.js can test it alone.
//
// OFF by default. Turn it on with SURCHARGE_PCT=2.4 (a percentage of the price, not of the tax).
//
// Read before turning it on (rules change, and this is not legal advice):
//   * Visa and Mastercard cap a surcharge (about 2.4% in Canada, about 3% in the US) and it may not be more than what the card costs you.
//     The percentage is cut to those caps per country, so SURCHARGE_PCT=3 still charges Canadians 2.4%.
//   * Surcharging debit and prepaid cards is not allowed. Stripe Checkout does not say whether a card is credit or debit before the buyer
//     pays, so this line is added for every card. Stripe's own surcharging tools (in the dashboard) detect the card type.
//   * Quebec does not allow it, so CA-QC is always left out. Some US states ban or limit it: list them in SURCHARGE_EXCLUDE,
//     e.g. SURCHARGE_EXCLUDE="US-CT,US-ME,US-MA" (check each state before you rely on this).
//   * Visa and Mastercard want it shown as a surcharge on the first page that mentions cards and as its own line on the receipt.
//   * Mastercard wants you registered in advance in Canada. Stripe can do that for you.

const CAPS = { CA: 2.4, US: 3 }; // the most each country's card rules allow, in percent

const cc = (v) => (typeof v === 'string' && /^[A-Za-z]{2}$/.test(v.trim()) ? v.trim().toUpperCase() : null);
const rg = (v) => (typeof v === 'string' && /^[A-Za-z]{2,3}$/.test(v.trim()) ? v.trim().toUpperCase() : null);

// { CA: 2.4, US: 3 } with the cap applied, or null when the surcharge is off
function rates(env = process.env) {
  // SURCHARGE_PCT=stripe means "pass on Stripe's card fee": Stripe charges 2.9% + 30 cents, which is more than any card network lets a
  // surcharge be, so it is the most each country allows (CAPS below). A number (SURCHARGE_PCT=2) asks for less than that.
  const raw = String(env.SURCHARGE_PCT || '').trim().toLowerCase();
  const want = raw === 'stripe' ? Infinity : Number(raw);
  if (Number.isNaN(want) || want <= 0) return null; // Infinity is the "stripe" setting
  const out = {};
  for (const [country, cap] of Object.entries(CAPS)) out[country] = Math.min(want, cap);
  return out;
}

// places that are never charged: Quebec, and whatever SURCHARGE_EXCLUDE lists (a country like US, or a place like US-CT)
function excluded(env = process.env) {
  return new Set(['CA-QC', ...String(env.SURCHARGE_EXCLUDE || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)]);
}

// What the buyer pays on top of `base` cents. { cents, rate, label }, with cents 0 where there is no surcharge.
function quote(buyer, base, env = process.env) {
  const none = { cents: 0, rate: 0, label: '' };
  const r = rates(env);
  const country = cc(buyer?.country);
  if (!r || !country || !r[country]) return none;
  const skip = excluded(env);
  const region = rg(buyer?.region);
  if (skip.has(country) || (region && skip.has(country + '-' + region))) return none;
  return { cents: Math.round((base * r[country]) / 100), rate: r[country], label: `Card processing surcharge (${r[country]}%)` };
}

// What the client needs to draw the line (the server still does the real maths). null when the surcharge is off.
function publicInfo(env = process.env) {
  const r = rates(env);
  return r ? { rates: r, exclude: [...excluded(env)] } : null;
}

module.exports = { CAPS, rates, excluded, quote, publicInfo };
