// Sales tax / VAT for credit purchases. No Express or database imports, so server/paypal-test.js can test it alone.
//
// IMPORTANT: Aduna only adds tax in the places YOU say you are registered to collect it (TAX_COLLECT_IN). By default it adds none.
// Charging tax where you are not registered is not allowed in many countries (in Canada you need a GST/HST number first), and the
// rates below are standard rates for digital goods that change from time to time, so check them with an accountant. You can
// override any rate in TAX_COLLECT_IN, e.g.  TAX_COLLECT_IN="CA-BC=12,CA-ON,GB"  (an entry is a country like GB, a Canadian
// province like CA-ON, a whole group: CA = every province, EU = every EU country; "=rate" sets the percentage yourself).
//
// The buyer says which country (and for Canada, which province) they are in at checkout. That is the self-declared billing place;
// the server does the maths and PayPal is sent the price and the tax as separate lines.

const EU = { AT: 20, BE: 21, BG: 20, HR: 25, CY: 19, CZ: 21, DK: 25, EE: 24, FI: 25.5, FR: 20, DE: 19, GR: 24, HU: 27, IE: 23, IT: 22, LV: 21, LT: 21, LU: 17, MT: 18, NL: 21, PL: 23, PT: 23, RO: 21, SK: 23, SI: 22, ES: 21, SE: 25 };
// Canada: each province lists its taxes separately (the receipt shows them as separate lines).
const G = ['GST', 5];
const CA = {
  AB: [G], BC: [G, ['PST', 7]], MB: [G, ['RST', 7]], NB: [['HST', 15]], NL: [['HST', 15]], NS: [['HST', 14]], NT: [G],
  NU: [G], ON: [['HST', 13]], PE: [['HST', 15]], QC: [G, ['QST', 9.975]], SK: [G, ['PST', 6]], YT: [G],
};

// US: STATE-level base rates only. Cities and counties add their own tax on top (it depends on the buyer's exact address), and some
// states do not tax digital goods or virtual currency at all, so list only the states where you have checked and are registered.
const US = { AL: 4, AZ: 5.6, AR: 6.5, CA: 7.25, CO: 2.9, CT: 6.35, DC: 6, FL: 6, GA: 4, HI: 4, ID: 6, IL: 6.25, IN: 7, IA: 6, KS: 6.5, KY: 6, LA: 5, ME: 5.5, MD: 6, MA: 6.25, MI: 6, MN: 6.875, MS: 7, MO: 4.225, NE: 5.5, NV: 6.85, NJ: 6.625, NM: 4.875, NY: 4, NC: 4.75, ND: 5, OH: 5.75, OK: 4.5, PA: 6, RI: 7, SC: 6, SD: 4.2, TN: 7, TX: 6.25, UT: 4.85, VT: 6, VA: 4.3, WA: 6.5, WV: 6, WI: 5, WY: 4 };
const NO_US_TAX = ['AK', 'DE', 'MT', 'NH', 'OR']; // states with no statewide sales tax; they can still be picked and are charged nothing

const RATES = {};
for (const [st, rate] of Object.entries(US)) RATES['US-' + st] = { rate, label: 'Sales tax' };
for (const [p, parts] of Object.entries(CA)) RATES['CA-' + p] = { rate: Math.round(parts.reduce((t, x) => t + x[1], 0) * 1000) / 1000, label: parts.map((x) => x[0]).join(' + '), parts: parts.map(([label, rate]) => ({ label, rate })) };
for (const [c, rate] of Object.entries(EU)) RATES[c] = { rate, label: 'VAT', eu: true };
Object.assign(RATES, { GB: { rate: 20, label: 'VAT' }, AU: { rate: 10, label: 'GST' }, NZ: { rate: 15, label: 'GST' } });

// TAX_COLLECT_IN -> Map(code -> { rate, label }) of the places Aduna charges tax.
function collecting(env = process.env) {
  const out = new Map();
  for (const raw of String(env.TAX_COLLECT_IN || '').split(',')) {
    const [name, over] = raw.trim().toUpperCase().split('=');
    if (!name) continue;
    const codes = name === 'US' ? Object.keys(RATES).filter((k) => k.startsWith('US-')) : name === 'EU' ? Object.keys(RATES).filter((k) => RATES[k].eu) : name === 'CA' ? Object.keys(RATES).filter((k) => k.startsWith('CA-')) : RATES[name] ? [name] : [];
    const rate = over === undefined || over === '' ? null : Number(over);
    for (const c of codes) {
      const r = rate !== null && Number.isFinite(rate) && rate >= 0 && rate <= 40 ? rate : RATES[c].rate;
      out.set(c, { rate: r, label: RATES[c].label, parts: RATES[c].parts && r === RATES[c].rate ? RATES[c].parts : null }); // an override replaces the split with one line
    }
  }
  return out;
}

const cc = (v) => (typeof v === 'string' && /^[A-Za-z]{2}$/.test(v.trim()) ? v.trim().toUpperCase() : null);
const rg = (v) => (typeof v === 'string' && /^[A-Za-z]{2,3}$/.test(v.trim()) ? v.trim().toUpperCase() : null);

// What the buyer owes on `cents`. Returns { ok:true, tax, rate, label, code } (tax 0 where Aduna does not collect),
// or { ok:false, error } when the buyer still has to say where they are.
function quote(body, cents, env = process.env) {
  const map = collecting(env);
  if (!map.size) return { ok: true, tax: 0, rate: 0, label: '', code: '' };
  const country = cc(body?.country);
  if (!country) return { ok: false, error: 'Choose your country first' };
  let code = country;
  if ((country === 'CA' || country === 'US') && [...map.keys()].some((k) => k.startsWith(country + '-'))) {
    const region = rg(body?.region);
    if (!region) return { ok: false, error: country === 'US' ? 'Choose your state first' : 'Choose your province first' };
    code = country + '-' + region;
  }
  const hit = map.get(code);
  if (!hit || !hit.rate) return { ok: true, tax: 0, rate: 0, label: '', code };
  const parts = (hit.parts || [{ label: hit.label, rate: hit.rate }]).map((x) => ({ ...x, amount: Math.round((cents * x.rate) / 100) }));
  return { ok: true, tax: parts.reduce((t, x) => t + x.amount, 0), rate: hit.rate, label: hit.label, parts, code };
}

// What the client needs to draw the country / province pickers and a live tax line (the server still does the real maths).
function publicInfo(env = process.env) {
  const map = collecting(env);
  if (!map.size) return null;
  const countries = [...new Set([...map.keys()].map((k) => k.split('-')[0]))].sort();
  return { countries, rates: Object.fromEntries(map) };
}

module.exports = { NO_US_TAX, RATES, collecting, quote, publicInfo };
