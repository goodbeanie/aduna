'use strict';
// Sponsored servers: the owner of a public server pays for a slot at the top of the server explorer. The slot is always labelled
// "Sponsored" (gold in the app) and sits in its own section, so it never passes as an ordinary result.
//
// Stored on the server: server.sponsored = { since, until, views, joins }. The payment itself goes in db.payments with kind 'sponsored',
// next to the credit packs, so the sales report counts it and a refund can find it again by the Stripe payment intent.
// No Express or database imports, so server/sponsored-test.js can test it alone. index.js wires up the routes.
//
// Rules:
//   * Only a public server that passes the listing checks can buy. It keeps what it paid for if it is unpublished later.
//   * There are SLOTS slots. A server that is already sponsored can always extend; a new one needs a free slot.
//   * Buying again while sponsored adds the days to the end. Nobody can book more than MAX_AHEAD_DAYS ahead.
//   * Money in is only recorded from Stripe's signed webhook (credits.js), never from the page the buyer comes back to.
//   * A full refund or a dispute takes those days off again.

const REG = require('./regions');
const PRICES = require('./stripeprices');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const SLOTS = 3;
const MAX_AHEAD_DAYS = 60;

const PLANS = [
  { id: 'week', days: 7, cents: 499, cadCents: 649 },
  { id: 'month', days: 30, cents: 1499, cadCents: 1999 },
];
const planOf = (id) => PLANS.find((p) => p.id === id) || null;

const untilOf = (s) => (s && s.sponsored && Number.isFinite(s.sponsored.until) ? s.sponsored.until : 0);
const isActive = (s, now = Date.now()) => untilOf(s) > now;

function slots(servers, now = Date.now(), max = SLOTS) {
  const used = servers.filter((s) => isActive(s, now)).length;
  return { used, max, open: Math.max(0, max - used) };
}

// The servers that show as sponsored: at most `max`, the one that has been sponsored longest first.
function holders(servers, now = Date.now(), max = SLOTS) {
  return servers.filter((s) => isActive(s, now))
    .sort((a, b) => (a.sponsored.since || 0) - (b.sponsored.since || 0) || String(a.id).localeCompare(String(b.id)))
    .slice(0, max);
}

// The order they are shown in. It turns once an hour so none of them is always first.
function rotate(list, now = Date.now()) {
  if (list.length < 2) return list;
  const k = Math.floor(now / HOUR) % list.length;
  return [...list.slice(k), ...list.slice(0, k)];
}

// `problem` is the listing check's text for this server (listing.listingProblem), or ''.
function eligibility(s, problem = '') {
  if (s.visibility !== 'public') return { ok: false, code: 'not_public', error: 'Make the server Public first. Only public servers show in the explorer.' };
  if (s.listingHold) return { ok: false, code: 'on_hold', error: 'This server\'s public listing is under review or was removed, so it cannot be sponsored.' };
  if (problem) return { ok: false, code: 'listing_problem', error: problem };
  return { ok: true };
}

function canBuy(s, servers, plan, now = Date.now(), problem = '') {
  const fit = eligibility(s, problem);
  if (!fit.ok) return { ...fit, status: 400 };
  const active = isActive(s, now);
  if (!active && slots(servers, now).open === 0) return { ok: false, status: 409, code: 'slots_full', error: `All ${SLOTS} sponsored slots are taken right now. Try again when one ends.` };
  const ahead = (active ? untilOf(s) - now : 0) + plan.days * DAY;
  if (ahead > MAX_AHEAD_DAYS * DAY) return { ok: false, status: 409, code: 'too_far_ahead', error: `You can book up to ${MAX_AHEAD_DAYS} days ahead.` };
  return { ok: true };
}

// Adds `days` to the end of the current run, or starts a new one. A new run starts its view and join counts again.
function grant(s, days, now = Date.now()) {
  const cur = isActive(s, now) ? s.sponsored : null;
  s.sponsored = { since: cur ? cur.since : now, until: (cur ? cur.until : now) + days * DAY, views: cur ? cur.views || 0 : 0, joins: cur ? cur.joins || 0 : 0 };
  return s.sponsored;
}

function revoke(s, now = Date.now()) {
  if (s.sponsored && s.sponsored.until > now) s.sponsored.until = now;
}

function reverse(s, days) {
  if (s.sponsored) s.sponsored.until -= days * DAY;
}

function noteViews(list, now = Date.now()) {
  for (const s of list) if (isActive(s, now)) s.sponsored.views = (s.sponsored.views || 0) + 1;
}
function noteJoin(s, now = Date.now()) {
  if (isActive(s, now)) s.sponsored.joins = (s.sponsored.joins || 0) + 1;
}

// What the owner sees: the current run, or the numbers of the last one once it has ended.
function ownerView(s, now = Date.now()) {
  const x = s.sponsored;
  if (!x) return { active: false, until: null, since: null, views: 0, joins: 0 };
  return { active: isActive(s, now), since: x.since || null, until: x.until || null, views: x.views || 0, joins: x.joins || 0 };
}

const plansView = () => PLANS.map(({ id, days, cents, cadCents }) => ({ id, days, cents, cadCents }));

// The price comes from PLANS, never from the browser. The buyer's country picks the currency and Stripe works out the tax.
async function createCheckout({ user, server, plan, origin, buyer = {}, fetchImpl = fetch, createSession, tax = {} }) {
  const where = REG.resolve(buyer);
  if (!where.ok) throw Object.assign(new Error(where.error), { forBuyer: true });
  const base = REG.priceIn(plan, where.currency);
  if (!base) throw Object.assign(new Error('This plan is not for sale in ' + where.currency.toUpperCase()), { forBuyer: true });
  const params = {
    mode: 'payment',
    ...PRICES.line(0, { priceId: null, currency: where.currency, cents: base, name: `Aduna sponsored server, ${plan.days} days` }),
    ...tax,
    success_url: `${origin}/app?sponsored=paid&server=${server.id}`,
    cancel_url: `${origin}/app?sponsored=cancelled&server=${server.id}`,
    client_reference_id: user.id,
    'metadata[kind]': 'sponsored',
    'metadata[userId]': user.id,
    'metadata[serverId]': server.id,
    'metadata[planId]': plan.id,
    'metadata[country]': where.country,
  };
  if (user.email) params.customer_email = user.email;
  return (await createSession(params, fetchImpl)).url;
}

// Applies one verified Stripe event to `db` (the caller saves). Returns { serverId } when a server's sponsorship changed, else null.
// credits.js skips sessions marked kind 'sponsored', so the two never both act on one payment.
function handleEvent(event, db, now = Date.now()) {
  const obj = event?.data?.object || {};
  if (event?.type === 'checkout.session.completed' || event?.type === 'checkout.session.async_payment_succeeded') {
    if (obj.metadata?.kind !== 'sponsored' || obj.payment_status !== 'paid') return null;
    if (db.payments[obj.id]) return null;
    const plan = planOf(obj.metadata.planId), s = db.servers[obj.metadata.serverId], u = db.users[obj.metadata.userId];
    if (!plan || !s || !u) { console.error('Sponsored: paid session', obj.id, 'has an unknown plan, server or user'); return null; }
    const cur = String(obj.currency).toLowerCase(), base = REG.priceIn(plan, cur), country = obj.metadata.country || '';
    const paidTax = Number(obj.total_details?.amount_tax) || 0;
    if (!base || !Number.isInteger(obj.amount_total) || (obj.amount_total !== base && obj.amount_total !== base + paidTax) || (!!country && REG.currencyOf(country) !== cur)) {
      console.error('Sponsored: paid session', obj.id, 'amount does not match the plan; not starting it');
      return null;
    }
    const payerCountry = String(obj.customer_details?.address?.country || '').toUpperCase();
    const payerRegion = String(obj.customer_details?.address?.state || '').toUpperCase().slice(0, 3);
    const why = REG.review(country, /^[A-Z]{2}$/.test(payerCountry) ? payerCountry : '');
    if (why) console.warn(`Sponsored: payment ${obj.id} needs a look (${why}): the buyer said ${country || 'nothing'}, Stripe says ${payerCountry}`);
    db.payments[obj.id] = {
      id: obj.id, kind: 'sponsored', userId: u.id, serverId: s.id, planId: plan.id, days: plan.days, cents: obj.amount_total, currency: cur,
      country: /^[A-Z]{2}$/.test(payerCountry) ? payerCountry : country, region: payerRegion, tax: paidTax,
      ...(why ? { review: why } : {}), intent: obj.payment_intent || null, createdAt: now, reversed: false,
    };
    grant(s, plan.days, now);
    return { serverId: s.id };
  }
  const intent = event?.type === 'charge.refunded' && obj.refunded ? obj.payment_intent
    : event?.type === 'charge.dispute.created' ? obj.payment_intent : null;
  if (!intent) return null;
  const pay = Object.values(db.payments).find((p) => p.kind === 'sponsored' && p.intent === intent);
  if (!pay || pay.reversed) return null;
  pay.reversed = true;
  if (db.servers[pay.serverId]) reverse(db.servers[pay.serverId], pay.days);
  return { serverId: pay.serverId };
}

module.exports = {
  SLOTS, MAX_AHEAD_DAYS, PLANS, planOf, isActive, untilOf, slots, holders, rotate, eligibility, canBuy, grant, revoke, reverse,
  noteViews, noteJoin, ownerView, plansView, createCheckout, handleEvent,
};
