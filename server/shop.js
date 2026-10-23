// The credits shop: things you can spend credits on. Right now that is profile badges (an emoji on a colour, shown next to your name).
//
// Like credits.js and events.js this file has no Express / database imports: the rules are plain functions over a user record and the
// credits `spend` function, so server/shop-test.js can run them without a server. credits.js wires them to the routes.
//
// What is stored, per user:
//   u.shopBadges = [item id]     badges bought in the shop (see ITEMS); shown next to the name together with the other badges
//
// Where the safety lives (same ideas as credits.js):
//   * The price always comes from ITEMS on the server. The browser only says WHICH item; it never sends an amount.
//   * buy() checks, takes the credits and hands over the item in one synchronous step, so two quick requests cannot buy the same item
//     twice or spend the same credits twice. spend() refuses when the balance does not cover the price (a negative balance after a
//     refund blocks spending until it is earned back).
//   * Items are one-off: you own a badge once. Nothing here can be refunded or sold on.

// Not `builtin` on purpose: the client draws `builtin` badges with the Creator picture.
// kind is 'badge' for now; a new kind would also need handing over in buy() below and its own place in the client's Shop section.
const ITEMS = [
  { id: 'shop-star',    kind: 'badge', name: 'Star',         emoji: '\u2B50',       color: '#d9a400', price: 100,  desc: 'A shiny gold star next to your name.' },
  { id: 'shop-spark',   kind: 'badge', name: 'Spark',        emoji: '\u26A1',       color: '#7c5cff', price: 150,  desc: 'Quick and bright.' },
  { id: 'shop-flame',   kind: 'badge', name: 'Flame',        emoji: '\u{1F525}',    color: '#e8590c', price: 200,  desc: 'For people who are on fire.' },
  { id: 'shop-clover',  kind: 'badge', name: 'Lucky Clover', emoji: '\u{1F340}',    color: '#2f9e44', price: 250,  desc: 'A little luck, always with you.' },
  { id: 'shop-rocket',  kind: 'badge', name: 'Rocket',       emoji: '\u{1F680}',    color: '#1c7ed6', price: 400,  desc: 'Going places.' },
  { id: 'shop-gem',     kind: 'badge', name: 'Gem',          emoji: '\u{1F48E}',    color: '#0c8599', price: 600,  desc: 'Rare, cut and polished.' },
  { id: 'shop-crown',   kind: 'badge', name: 'Crown',        emoji: '\u{1F451}',    color: '#c2255c', price: 1000, desc: 'The most expensive thing in the shop.' },
];
const BY_ID = new Map(ITEMS.map((i) => [i.id, i]));

const owned = (u) => (Array.isArray(u?.shopBadges) ? u.shopBadges.filter((id) => BY_ID.has(id)) : []);

// what the client sees: the whole catalogue, with what this person already owns marked
function view(u) {
  const have = new Set(owned(u));
  return ITEMS.map((i) => ({ id: i.id, kind: i.kind, name: i.name, emoji: i.emoji, color: i.color, price: i.price, desc: i.desc, owned: have.has(i.id) }));
}

// `spend` is credits.spend. Returns { ok: true, item } or { status, error }.
function buy(u, id, spend, { now = Date.now() } = {}) {
  const item = typeof id === 'string' ? BY_ID.get(id) : null;
  if (!item) return { status: 404, error: 'That item is not in the shop' };
  if (owned(u).includes(item.id)) return { status: 409, error: 'You already own this' };
  if (!spend(u, item.price, 'shop', { note: item.name, now })) return { status: 402, error: 'Not enough credits' };
  u.shopBadges = [...owned(u), item.id]; // paid in the same synchronous step
  return { ok: true, item: { id: item.id, name: item.name, price: item.price } };
}

// the shop badges a person owns, in the same shape as other badges (see badgeViews in index.js)
function badgeViews(u) {
  return owned(u).map((id) => { const i = BY_ID.get(id); return { id: i.id, name: i.name, image: null, emoji: i.emoji, color: i.color }; });
}

module.exports = { ITEMS, owned, view, buy, badgeViews };
