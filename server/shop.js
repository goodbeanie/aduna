// The credits shop: things you can spend credits on. That is profile badges that creator accounts make (a name, a picture, a price).
//
// Like credits.js and events.js this file has no Express / database imports: the rules are plain functions over a user record, the badge
// table and the credits `spend` function, so server/shop-test.js can run them without a server. credits.js wires them to the routes.
//
// What is for sale: every badge in db().badges that has a `price` (a whole number of credits, set by a creator; no price = not for sale),
// has not reached its end date (`shopEnds`), and is on show today: pinned, or not daily, or one of today's DAILY_MAX daily picks.
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
const held = (u) => (Array.isArray(u?.badges) ? u.badges : []);

// A badge has a price (that is what puts it in the shop) and three optional shop settings a creator controls:
//   shopEnds  a time (ms): from then on the badge is off the shop for good, until the creator clears or moves the date. Owners keep it.
//   pinned    always shown, and listed first
//   daily     takes part in the daily shop: every day (UTC) at most DAILY_MAX of the daily badges are picked at random and shown; the rest
//             rest until a later day. Any number of badges can be daily. A pinned badge is always shown, so it never uses up a daily slot.
const priced = (b) => !!b && Number.isInteger(b.price) && b.price > 0 && b.price <= MAX_PRICE;
const ended = (b, now) => !!b && Number.isFinite(b.shopEnds) && b.shopEnds > 0 && b.shopEnds <= now;
// A badge an artist made (it has an `artistId`, see artists.js) is only listed once a moderator has approved it. Badges creators make have no artistId.
const listed = (b) => !!b && (typeof b.artistId !== 'string' || !b.artistId || b.status === 'approved');
const forSale = (b, now = Date.now()) => priced(b) && listed(b) && !ended(b, now);

const DAILY_MAX = 5;
const DAY_MS = 86_400_000;
const dayOf = (now) => Math.floor(now / DAY_MS);
// A number that looks random but is the same for one badge on one day, so everybody sees the same daily shop and it
// needs no stored state. It is mixed so that the order changes completely from one day to the next.
function rank(id, day) {
  let h = (2166136261 ^ Math.imul(day + 1, 2654435761)) >>> 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13;
  return h >>> 0;
}
// the ids of today's daily badges
function dailyPicks(badges, now = Date.now()) {
  const day = dayOf(now);
  return new Set(Object.values(badges || {})
    .filter((b) => forSale(b, now) && b.daily === true && b.pinned !== true)
    .sort((a, b) => rank(a.id, day) - rank(b.id, day) || (String(a.id) < String(b.id) ? -1 : 1))
    .slice(0, DAILY_MAX).map((b) => b.id));
}
// is this badge on show in the shop right now?
const shown = (b, picks, now) => forSale(b, now) && (b.pinned === true || b.daily !== true || picks.has(b.id));
const info = (now = Date.now()) => ({ dailyMax: DAILY_MAX, resetsAt: (dayOf(now) + 1) * DAY_MS });

// what the client sees: the badges on show (pinned first, then cheapest first), with what this person already owns marked.
// `all` is for the creator: every badge that has a price, with a `state` of live, resting (daily, not picked today), ended, or review
// (an artist's item a moderator has not approved yet).
// `users` (optional, db().users) lets an artist's item carry `by`, the artist's display name.
function view(u, badges = {}, { now = Date.now(), all = false, users = null } = {}) {
  const have = new Set(held(u));
  const picks = dailyPicks(badges, now);
  return Object.values(badges || {}).filter((b) => priced(b) && (all || shown(b, picks, now)))
    .map((b) => {
      const item = {
        id: b.id, kind: 'badge', name: b.name, desc: b.desc || '', emoji: b.emoji || '', color: b.color || '#8c6b4f', image: b.image || null, price: b.price, owned: have.has(b.id),
        pinned: b.pinned === true, daily: b.daily === true, ends: Number.isFinite(b.shopEnds) && b.shopEnds > 0 ? b.shopEnds : null,
      };
      if (typeof b.artistId === 'string' && b.artistId) item.by = (users && users[b.artistId] && users[b.artistId].displayName) || null;
      if (all) item.state = !listed(b) ? 'review' : ended(b, now) ? 'ended' : shown(b, picks, now) ? 'live' : 'resting';
      return item;
    })
    .sort((a, b) => (b.pinned - a.pinned) || a.price - b.price || a.name.localeCompare(b.name));
}

// `spend` is credits.spend. Returns { ok: true, item } or { status, error }.
function buy(u, id, spend, { badges = {}, maxHeld = MAX_HELD, now = Date.now() } = {}) {
  const b = typeof id === 'string' && has(badges, id) ? badges[id] : null;
  if (!b || !shown(b, dailyPicks(badges, now), now)) return { status: 404, error: 'That item is not in the shop' }; // off sale, ended, or a daily badge that is resting today
  if (held(u).includes(b.id)) return { status: 409, error: 'You already own this' };
  if (held(u).length >= maxHeld) return { status: 400, error: `Nobody can hold more than ${maxHeld} badges` };
  if (!spend(u, b.price, 'shop', { note: b.name, now })) return { status: 402, error: 'Not enough credits' };
  u.badges = [...held(u), b.id]; // paid in the same synchronous step
  // an artist's item says who made it, so the caller can pay them their cut (credits.js) in the same synchronous step
  return { ok: true, item: { id: b.id, name: b.name, price: b.price, ...(typeof b.artistId === 'string' && b.artistId ? { artistId: b.artistId } : {}) } };
}

// Old preset badges a person bought before creators took over the shop, in the same shape as other badges (see badgeViews in index.js)
const owned = (u) => (Array.isArray(u?.shopBadges) ? u.shopBadges.filter((id) => LEGACY_BY_ID.has(id)) : []);
function badgeViews(u) {
  return owned(u).map((id) => { const i = LEGACY_BY_ID.get(id); return { id: i.id, name: i.name, image: null, emoji: i.emoji, color: i.color }; });
}

module.exports = { MAX_PRICE, MAX_HELD, DAILY_MAX, LEGACY, owned, forSale, listed, ended, dailyPicks, info, view, buy, badgeViews };
