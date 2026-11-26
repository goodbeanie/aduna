'use strict';
// Supporter ranks: three monthly levels that show a badge next to a name and pay a few more credits.
//
//   Spark    badge, 1.1x credits
//   Plus     the 10 GB plan, 1.5x credits
//   Premium  everything in Plus with 20 GB, 1.75x credits
//
// All three are bought as a Stripe subscription and live in u.storageSub (server/storage.js); storage.activePlan() says which one a person has
// right now and index.js passes it in here as `plan`. A creator account can also give Spark or Premium for a number of days
// (POST /api/supporter/grant), kept in u.supporter = { rank, until }. The highest rank a person qualifies for is the one they show.
// No Express or database imports, so server/supporter-test.js can run these without a server.

const DAY = 86_400_000;

// order is rank order, lowest first
const RANKS = [
  { id: 'spark', name: 'Aduna Spark', rate: 1.1 },
  { id: 'plus', name: 'Aduna Plus', rate: 1.5 },
  { id: 'premium', name: 'Aduna Premium', rate: 1.75 },
];
const byId = Object.fromEntries(RANKS.map((r) => [r.id, r]));
const GRANTABLE = ['spark', 'premium'];
const order = (id) => RANKS.findIndex((r) => r.id === id);

const rec = (u) => (u && u.supporter && typeof u.supporter === 'object' ? u.supporter : null);
const storedRank = (u, now) => {
  const s = rec(u);
  return s && GRANTABLE.includes(s.rank) && Number(s.until) > now ? s.rank : null;
};

// The rank someone shows right now, or null. `plan` is the plan they pay for ('spark' | 'plus' | 'premium' | null, from storage.activePlan).
function rankOf(u, { plan = null, now = Date.now() } = {}) {
  if (!u || u.bot) return null;
  const found = [storedRank(u, now), byId[plan] ? plan : null].filter(Boolean);
  if (!found.length) return null;
  return found.reduce((a, b) => (order(b) > order(a) ? b : a));
}

// Plus and Premium share the Plus perks (longer messages, Plus-only quests, the free monthly boost, no daily credit cap). Spark does not.
const hasPlusPerks = (u, opts = {}) => ['plus', 'premium'].includes(rankOf(u, opts));

const rateOfRank = (id) => (byId[id] ? byId[id].rate : undefined);

// The credit multiplier for the rank, or undefined when there is none (credits.js then pays the normal rate)
const rateOf = (u, opts = {}) => rateOfRank(rankOf(u, opts));

// The badge in the same shape as the other badges (see allBadgeViews in index.js). `glyph: 'supporter'` makes the client draw the rank's mark.
function badgeViews(u, opts = {}) {
  const r = rankOf(u, opts);
  return r ? [{ id: 'supporter', name: byId[r].name, glyph: 'supporter', rank: r, image: null, emoji: '', color: '' }] : [];
}

// Gives or extends a rank. Time adds to what is left of the same rank, and switching rank starts from now.
function grant(u, rank, days, now = Date.now()) {
  if (!GRANTABLE.includes(rank)) return { ok: false, error: 'Rank must be spark or premium' };
  if (!Number.isInteger(days) || days < 1 || days > 366) return { ok: false, error: 'Days must be a whole number from 1 to 366' };
  const cur = storedRank(u, now) === rank ? Number(rec(u).until) : now;
  u.supporter = { rank, until: cur + days * DAY };
  return { ok: true, until: u.supporter.until };
}

function revoke(u) {
  const had = !!rec(u);
  delete u.supporter;
  return had;
}

module.exports = { RANKS, GRANTABLE, rankOf, hasPlusPerks, rateOfRank, rateOf, badgeViews, grant, revoke };
