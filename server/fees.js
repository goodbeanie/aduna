'use strict';
// Card fee: gets Stripe's fee back from the buyer on credit purchases. No Express or database imports, so server/fees-test.js can test it alone.
//
// OFF unless CARD_FEE_PERCENT and/or CARD_FEE_FIXED_CENTS is set (for example 2.9 and 30: Stripe's usual card rate). Then every credit
// purchase carries the fee, in one of two ways, decided by where the buyer says they are:
//   * a place where a card surcharge is allowed: a separate "Card processing fee" line on Stripe's page, never above the legal cap
//     (CARD_SURCHARGE_MAX_PERCENT of the price, default 2.4, the Canadian Visa/Mastercard cap). If the fee is bigger than the cap, the rest is
//     put into the price of the credits so Aduna still gets all of it back.
//   * anywhere else: all of it is put into the price of the credits (no surcharge line at all).
// Where a surcharge is allowed (CARD_SURCHARGE_IN, default "CA"): "CA" = every Canadian province, "CA-BC,CA-ON" = those provinces,
// "US-FL" = a US state. Quebec is never allowed (the Consumer Protection Act forbids it), and neither is a place where the buyer did not
// say which province or state they are in, because that is how it is told apart. Set CARD_SURCHARGE_IN=none to never use a surcharge line.
// Card networks only let a surcharge go on CREDIT cards, and Stripe Checkout cannot tell debit from credit before the payment is made.
// Only turn surcharge lines on after you have told Visa and Mastercard (Visa wants notice before you start) and your acquirer is fine with it.

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };

// Always refused, whatever CARD_SURCHARGE_IN says.
const NEVER = new Set(['CA-QC']);

function config(env = process.env) {
  const pct = Math.min(num(env.CARD_FEE_PERCENT), 10);
  const fixed = Math.min(Math.round(num(env.CARD_FEE_FIXED_CENTS)), 100);
  if (!pct && !fixed) return null;
  const raw = env.CARD_SURCHARGE_IN === undefined ? 'CA' : String(env.CARD_SURCHARGE_IN);
  const places = new Set(raw.split(',').map((s) => s.trim().toUpperCase()).filter((s) => s && s !== 'NONE'));
  const cap = env.CARD_SURCHARGE_MAX_PERCENT === undefined ? 2.4 : Math.min(num(env.CARD_SURCHARGE_MAX_PERCENT), 3);
  return { pct, fixed, cap, places };
}

// Is a surcharge line allowed for a buyer in `country` / `region` (as regions.resolve gives them)?
function surchargeAllowed(country, region, cfg) {
  if (!cfg || !region) return false;
  const key = country + '-' + region;
  if (NEVER.has(key)) return false;
  return cfg.places.has(key) || cfg.places.has(country);
}

// { fee, surcharge, inPrice, unit, total } in cents for an item priced `base`, or null when the fee is off.
//   fee       everything added on top of the price (surcharge + inPrice)
//   surcharge the separate line (0 where it is not allowed)
//   inPrice   what goes into the price itself
//   unit      the credits line: base + inPrice      total: what the buyer pays before tax: unit + surcharge
function quote(base, { country, region } = {}, cfg = config()) {
  if (!cfg || !Number.isInteger(base) || base <= 0) return null;
  // charge so that what is left after Stripe's cut (pct of the whole + fixed) is `base`
  const fee = Math.ceil((base + cfg.fixed) / (1 - cfg.pct / 100)) - base;
  const surcharge = surchargeAllowed(country, region, cfg) ? Math.min(fee, Math.floor(base * cfg.cap / 100)) : 0;
  const inPrice = fee - surcharge;
  return { fee, surcharge, inPrice, unit: base + inPrice, total: base + fee };
}

module.exports = { config, surchargeAllowed, quote, NEVER };
