'use strict';
// Attaches the products you made in the Stripe dashboard to Aduna's checkout, so nothing about them is typed into the code.
//
// Two ways to attach them (use either, or both; both are OFF by default, and then checkout works exactly as before):
//
//   STRIPE_PRODUCTS=auto   Aduna reads your active Stripe prices and picks the right one by product name + currency + amount:
//                            "500 Credits", "1000 Credits", "2500 Credits", "5000 Credits"  ->  the credit packs
//                            "Aduna PLUS" (recurring, monthly)                              ->  the storage plan
//                          Names are not case sensitive ("500 credits" or "500 Aduna credits" also match).
//   STRIPE_PRICES='{"p500":{"cad":"price_..."},"storage10":{"cad":"price_...","usd":"price_..."}}'
//                          Names the Stripe price ids yourself (pack ids are in credits.js PACKS, the plan id is storage10).
//                          These win over STRIPE_PRODUCTS=auto.
//
// Safety: the price still comes from Aduna's own table (credits.js PACKS, storage.js PLAN). A Stripe price is only used when its
// currency and amount equal that table (and a plan's price is monthly), so a mistyped price in the dashboard can never charge the
// wrong amount or leave a payment that the webhook refuses to credit. A pack with no matching Stripe price (for example USD,
// when you only made CAD products) is sold with an inline price as before.
// No Express or database imports, so server/stripeprices-test.js can test it with a fake Stripe.

const TTL_MS = 10 * 60_000;
const PRICE_ID = /^price_[A-Za-z0-9]{6,100}$/;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function explicit(env = process.env) {
  if (!env.STRIPE_PRICES) return {};
  try {
    const j = JSON.parse(env.STRIPE_PRICES), out = {};
    for (const [key, byCur] of Object.entries(j || {})) {
      for (const [cur, id] of Object.entries(byCur || {})) if (PRICE_ID.test(String(id))) (out[key] ||= {})[String(cur).toLowerCase()] = String(id);
    }
    return out;
  } catch { console.warn('Stripe prices: STRIPE_PRICES is not valid JSON; ignored'); return {}; }
}
const autoOn = (env = process.env) => String(env.STRIPE_PRODUCTS || '').trim().toLowerCase() === 'auto';
const enabled = (env = process.env) => !!env.STRIPE_PRICES || autoOn(env);

// the product names an item may carry in the Stripe dashboard (normalised)
function namesOf(item) {
  if (Number.isInteger(item?.credits)) return [`${item.credits} credits`, `${item.credits} aduna credits`];
  return item?.name ? [norm(item.name)] : [];
}

// Active Stripe prices, as { id, cur, cents, recurring, name }. Cached for ten minutes (a failed read is cached for one).
let cache = { at: 0, ok: true, list: [] };
async function activePrices(request) {
  if (Date.now() - cache.at < (cache.ok ? TTL_MS : 60_000)) return cache.list;
  const list = [];
  let ok = true, after = '';
  for (let page = 0; page < 3; page++) { // 300 prices is far more than Aduna sells
    const r = await request('GET', `/prices?active=true&limit=100&expand[]=data.product${after ? '&starting_after=' + after : ''}`);
    if (!r.ok || !Array.isArray(r.j?.data)) { ok = false; console.warn(`Stripe prices: could not read your Stripe prices (${r.status}); using inline prices`); break; }
    for (const p of r.j.data) {
      if (Number.isInteger(p.unit_amount) && p.product && typeof p.product === 'object' && p.product.active !== false) {
        list.push({ id: p.id, cur: String(p.currency).toLowerCase(), cents: p.unit_amount, recurring: p.type === 'recurring' && p.recurring?.interval === 'month' && (p.recurring.interval_count || 1) === 1, name: norm(p.product.name) });
      }
    }
    if (!r.j.has_more || !r.j.data.length) break;
    after = r.j.data[r.j.data.length - 1].id;
  }
  cache = { at: Date.now(), ok, list };
  return list;
}

// An id from STRIPE_PRICES is checked against Stripe once (and again every ten minutes).
const checked = new Map(); // id -> { at, good }
async function idIsGood(id, { cur, cents, recurring }, request) {
  const hit = checked.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.good;
  const r = await request('GET', '/prices/' + id);
  const p = r.j || {};
  const good = r.ok && p.active !== false && p.unit_amount === cents && String(p.currency).toLowerCase() === cur
    && (recurring ? p.type === 'recurring' && p.recurring?.interval === 'month' && (p.recurring.interval_count || 1) === 1 : p.type === 'one_time');
  if (!good) console.warn(`Stripe prices: ${id} does not match Aduna's price (${cents} ${cur}${recurring ? ' monthly' : ''}); using an inline price instead`);
  checked.set(id, { at: Date.now(), good });
  return good;
}

// The Stripe price id to put on the checkout line for `item` (a pack or the plan) in `currency`, or null to use an inline price.
// request(method, path) -> { ok, status, j } talks to Stripe (credits.stripeRequest with the right fetch).
async function priceFor({ item, currency, base, recurring = false, request, env = process.env }) {
  if (!enabled(env) || !item || !base) return null;
  try {
    const want = { cur: currency, cents: base, recurring };
    const id = explicit(env)[item.id]?.[currency];
    if (id) return (await idIsGood(id, want, request)) ? id : null;
    if (!autoOn(env)) return null;
    const names = namesOf(item);
    const hits = (await activePrices(request)).filter((p) => p.cur === currency && p.cents === base && p.recurring === recurring && names.includes(p.name));
    if (hits.length > 1) console.warn(`Stripe prices: ${hits.length} active prices match ${names[0]} in ${currency}; using ${hits[0].id}`);
    return hits[0]?.id || null;
  } catch (e) { console.warn('Stripe prices:', e.message); return null; }
}

// The checkout lines for one item: your Stripe price when there is one, otherwise the inline price.
function line(i, { priceId, currency, cents, name, recurring = false }) {
  const k = `line_items[${i}]`;
  if (priceId) return { [`${k}[quantity]`]: '1', [`${k}[price]`]: priceId };
  return {
    [`${k}[quantity]`]: '1',
    [`${k}[price_data][currency]`]: currency,
    [`${k}[price_data][unit_amount]`]: String(cents),
    ...(recurring ? { [`${k}[price_data][recurring][interval]`]: 'month' } : {}),
    [`${k}[price_data][product_data][name]`]: name,
  };
}

const _reset = () => { cache = { at: 0, ok: true, list: [] }; checked.clear(); };
module.exports = { enabled, explicit, priceFor, line, _reset };
