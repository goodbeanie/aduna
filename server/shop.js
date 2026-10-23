// The credits shop: things you can spend credits on. That is profile badges that creator accounts make (a name, a picture, a price).
//
// Like credits.js and events.js this file has no Express / database imports: the rules are plain functions over a user record, the badge
// table and the credits `spend` function, so server/shop-test.js can run them without a server. credits.js wires them to the routes.
//
// What is for sale: every badge in db().badges that has a `price` (a whole number of credits, set by a creator; no price = not for sale).
// Buying one puts its id in the buyer's `u.badges`, exactly like a badge a creator gives away by username, so it shows next to their name
// through the same code (badgeViews in index.js).
//
// Where the safety lives (same ideas as credits.js):
//   * The price always comes from the badge on the server. The browser only says WHICH badge; it never sends an amount.
//   * buy() checks, takes the credits and hands over the badge in one synchronous step, so two quick requests cannot buy the same badge
//     twice or spend the same credits twice. spend() refuses when the balance does not cover the price (a negative balance after a
//     refund blocks spending until it is earned back).
//   * Badges are one-off: you own one once. Nothing here can be refunded or sold on.

const MAX_PRICE = 1_000_000;
const MAX_HELD = 12; // the most badges one person can hold (the same limit as creators giving them away)

// The seven badges the shop used to sell. They are NOT for sale any more, but people who already bought one keep it (u.shopBadges).
// Not `builtin` on purpose: the client draws `builtin` badges with the Creator picture.
const LEGACY = [
  { id: 'shop-star',    name: 'Star',         emoji: '⭐',    color: '#d9a400' },
  { id: 'shop-spark',   name: 'Spark',        emoji: '⚡',    color: '#7c5cff' },
  { id: 'shop-flame',   name: 'Flame',        emoji: '\u{1F525}', color: '#e8590c' },
  { id: 'shop-clover',  name: 'Lucky Clover', emoji: '\u{1F340}', color: '#2f9e44' },
  { id: 'shop-rocket',  name: 'Rocket',       emoji: '\u{1F680}', color: '#1c7ed6' },
  { id: 'shop-gem',     name: 'Gem',          emoji: '\u{1F48E}', color: '#0c8599' },
  { id: 'shop-crown',   name: 'Crown',        emoji: '\u{1F451}', color: '#c2255c' },
];
const LEGACY_BY_ID = new Map(LEGACY.map((i) => [i.id, i]));

const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const forSale = (b) => !!b && Number.isInteger(b.price) && b.price > 0 && b.price <= MAX_PRICE;
const held = (u) => (Array.isArray(u?.badges) ? u.badges : []);

// what the client sees: every badge that is for sale, cheapest first, with what this person already owns marked
function view(u, badges = {}) {
  const have = new Set(held(u));
  return Object.values(badges || {}).filter(forSale)
    .map((b) => ({ id: b.id, kind: 'badge', name: b.name, desc: b.desc || '', emoji: b.emoji || '', color: b.color || '#8c6b4f', image: b.image || null, price: b.price, owned: have.has(b.id) }))
    .sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
}

// `spend` is credits.spend. Returns { ok: true, item } or { status, error }.
function buy(u, id, spend, { badges = {}, maxHeld = MAX_HELD, now = Date.now() } = {}) {
  const b = typeof id === 'string' && has(badges, id) ? badges[id] : null;
  if (!forSale(b)) return { status: 404, error: 'That item is not in the shop' };
  if (held(u).includes(b.id)) return { status: 409, error: 'You already own this' };
  if (held(u).length >= maxHeld) return { status: 400, error: `Nobody can hold more than ${maxHeld} badges` };
  if (!spend(u, b.price, 'shop', { note: b.name, now })) return { status: 402, error: 'Not enough credits' };
  u.badges = [...held(u), b.id]; // paid in the same synchronous step
  return { ok: true, item: { id: b.id, name: b.name, price: b.price } };
}

// Old preset badges a person bought before creators took over the shop, in the same shape as other badges (see badgeViews in index.js)
const owned = (u) => (Array.isArray(u?.shopBadges) ? u.shopBadges.filter((id) => LEGACY_BY_ID.has(id)) : []);
function badgeViews(u) {
  return owned(u).map((id) => { const i = LEGACY_BY_ID.get(id); return { id: i.id, name: i.name, image: null, emoji: i.emoji, color: i.color }; });
}

module.exports = { MAX_PRICE, MAX_HELD, LEGACY, owned, forSale, view, buy, badgeViews };
