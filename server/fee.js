// PayPal's processing fee as its own checkout line ("Processing fee"). Off by default: the listed prices already include the fee, and PayPal's
// user agreement does not let a seller add a surcharge for accepting PayPal. Turn it on only if that changes.
// No Express or database imports, so server/paypal-test.js can test it alone.
//
// PayPal keeps PERCENT% of what the buyer pays, plus a fixed amount per payment. To end up with exactly `net` after that, the buyer is charged
//     total = (net + fixed) / (1 - percent / 100)        (rounded UP to the cent, so the fee itself is covered too)
// `net` is the price plus any tax Aduna collects (tax.js). The fee is the difference: total - net. The same maths was used to set the prices
// in server/credits.js and server/storage.js.
//
// Settings (all optional, set them where the server's other settings are):
//   PAYMENT_FEE=on             add the fee line at checkout (anything else: no fee line)
//   PAYMENT_FEE_PERCENT=4.9    PayPal's percentage at checkout (4.9% + 0.30 for Canadian and US payers); use your own account's rate.
//   PAYMENT_FEE_FIXED_CENTS=30 PayPal's fixed fee per payment, in cents of the charged currency
//   PAYMENT_FEE_SKIP=GB,DE     countries where it is NOT added. Default: the UK and the EU, where charging extra for a card payment is
//                              banned. It only applies once the buyer has said where they are (the country picker shows when TAX_COLLECT_IN is set).
// Not covered: PayPal's extra ~1.5% on international buyers and its currency-conversion markup.

const SKIP_DEFAULT = 'GB,AT,BE,BG,HR,CY,CZ,DK,EE,FI,FR,DE,GR,HU,IE,IT,LV,LT,LU,MT,NL,PL,PT,RO,SK,SI,ES,SE';

const cc = (v) => (typeof v === 'string' && /^[A-Za-z]{2}$/.test(v.trim()) ? v.trim().toUpperCase() : null);

// The settings in force, or null when the fee line is off.
function settings(env = process.env) {
  if (String(env.PAYMENT_FEE || '').trim().toLowerCase() !== 'on') return null;
  const pct = env.PAYMENT_FEE_PERCENT === undefined || env.PAYMENT_FEE_PERCENT === '' ? 4.9 : Number(env.PAYMENT_FEE_PERCENT);
  const fixed = env.PAYMENT_FEE_FIXED_CENTS === undefined || env.PAYMENT_FEE_FIXED_CENTS === '' ? 30 : Number(env.PAYMENT_FEE_FIXED_CENTS);
  if (!Number.isFinite(pct) || pct < 0 || pct > 15 || !Number.isInteger(fixed) || fixed < 0 || fixed > 200) return null; // a typo must never overcharge: no fee
  const skip = String(env.PAYMENT_FEE_SKIP === undefined ? SKIP_DEFAULT : env.PAYMENT_FEE_SKIP).split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s));
  return { percent: pct, fixedCents: fixed, skip };
}

// The total to charge so that `netCents` is left after PayPal's cut. Whole-number maths (basis points), no floating-point drift.
function grossUp(netCents, percent, fixedCents) {
  const bp = Math.round(percent * 100), num = (netCents + fixedCents) * 10000, den = 10000 - bp;
  return Math.floor((num + den - 1) / den);
}

// What the buyer pays on top of `netCents`. `body` is the checkout request (country, if the buyer gave one).
// Returns { fee, skipped } (fee in cents; 0 when off, skipped for the buyer's country, or nothing is due).
function quote(body, netCents, env = process.env) {
  const s = settings(env);
  if (!s || !Number.isInteger(netCents) || netCents <= 0) return { fee: 0, skipped: false };
  const country = cc(body?.country);
  if (country && s.skip.includes(country)) return { fee: 0, skipped: true };
  return { fee: grossUp(netCents, s.percent, s.fixedCents) - netCents, skipped: false };
}

// What the client needs to draw the fee line (it uses the same maths; the server still works out the real amount).
function publicInfo(env = process.env) {
  const s = settings(env);
  return s ? { percent: s.percent, fixedCents: s.fixedCents, skip: s.skip } : null;
}

module.exports = { settings, grossUp, quote, publicInfo };
