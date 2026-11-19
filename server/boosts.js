'use strict';
// Server boosts: a member spends credits to boost a server for 14 days. Three levels, each with the perks of the one below it:
//   1  server explorer boost, a booster tag for the person who paid
//   2  1080p / 60 fps screen sharing for everyone in the server's voice channels
//   3  1.5x credits on messages sent in the server
//
// What is stored: server.boosts = [{ id, userId, level, credits, startedAt, endsAt }]. Only boosts that are still running are kept.
// Like shop.js and credits.js this file has no Express / database imports: the rules are plain functions, so they can be unit tested
// (server/boosts-test.js). index.js wires them to the routes, and credits.js calls multiplierOf() when a message pays.
//
// Rules:
//   * The server runs at the highest level any running boost has. A level below that cannot be bought while it runs.
//   * Boosts never add up: three level 1 boosts are still level 1.
//   * A person has one boost per server. A higher level replaces their own lower one (the full price is paid, nothing is given back).
//     To renew, wait until it has ended.
//   * A boost hidden behind a higher one keeps running. When the higher one ends the server drops back to the highest that is left.
//   * Aduna Plus members get one free level 3 boost a month (buyFree). It follows the same rules, and the month's free boost is used up once started.
//   * Nobody can ask for a refund. When the server is deleted every running boost gives back its unused time (see refunds).

const DAY = 24 * 3600 * 1000;
const DURATION_MS = 14 * DAY;

const TIERS = [
  { level: 1, credits: 1000, perks: ['Server explorer boost', 'Booster tag'] },
  { level: 2, credits: 2000, perks: ['Server explorer boost', 'Booster tag', '1080p 60 fps screen sharing for everyone in voice channels'] },
  { level: 3, credits: 3000, perks: ['Server explorer boost', 'Booster tag', '1080p 60 fps screen sharing for everyone in voice channels', '1.5x credits on messages in this server'] },
];
const MESSAGE_MULTIPLIER = 1.5;

const tierOf = (level) => TIERS.find((t) => t.level === level) || null;

// the boosts that have not ended yet
const running = (server, now) => (Array.isArray(server?.boosts) ? server.boosts : []).filter((b) => b && b.endsAt > now);

const levelOf = (server, now = Date.now()) => running(server, now).reduce((top, b) => Math.max(top, b.level), 0);

// what the server gets at its current level
function perksOf(level) {
  return { explorer: level >= 1, tag: level >= 1, hdShare: level >= 2, messageMultiplier: level >= 3 ? MESSAGE_MULTIPLIER : 1 };
}
const multiplierOf = (server, now = Date.now()) => perksOf(levelOf(server, now)).messageMultiplier;

// Aduna Plus members get one free level 3 boost each calendar month (UTC), on any server they are in. It is stored like a paid boost
// with credits 0, so it also refunds nothing. The month that was used is kept on the person as user.freeBoostMonth ("2026-11").
const monthOf = (now) => new Date(now).toISOString().slice(0, 7);
const freeUsed = (user, now) => !!user && user.freeBoostMonth === monthOf(now);
const nextMonthAt = (now) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };

function freeState(user, plus, now = Date.now()) {
  return { plus: !!plus, used: freeUsed(user, now), resetsAt: nextMonthAt(now) };
}

function buyFree(server, user, plus, { now = Date.now(), id } = {}) {
  if (!plus) return { status: 403, error: 'The free monthly boost is part of Aduna Plus', code: 'plus_only' };
  if (freeUsed(user, now)) return { status: 409, error: 'You already used your free boost this month', code: 'free_used' };
  server.boosts = running(server, now);
  const own = server.boosts.find((b) => b.userId === user.id);
  if (own && own.level >= 3) return { status: 409, error: 'You already have a level 3 boost running on this server.' };
  if (own) server.boosts = server.boosts.filter((b) => b !== own);
  const boost = { id: id || `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`, userId: user.id, level: 3, credits: 0, free: true, startedAt: now, endsAt: now + DURATION_MS };
  server.boosts.push(boost);
  user.freeBoostMonth = monthOf(now);
  return { ok: true, boost, replaced: own || null };
}

// Takes the credits and starts the boost. `spend` is credits.spend. Everything is checked before any credits move,
// and the payment and the new boost happen in one synchronous step.
function buy(server, user, level, spend, { now = Date.now(), id } = {}) {
  const tier = tierOf(level);
  if (!tier) return { status: 400, error: 'Pick boost level 1, 2 or 3' };
  server.boosts = running(server, now); // drops the ones that have ended
  const top = levelOf(server, now);
  if (level < top) return { status: 409, error: `This server is already at level ${top}, so a lower boost cannot be started` };
  const own = server.boosts.find((b) => b.userId === user.id);
  if (own && level <= own.level) return { status: 409, error: 'You already have a boost running on this server. You can renew it when it ends, or buy a higher level.' };
  if (!spend(user, tier.credits, 'boost', { note: `Level ${level} boost`, now })) return { status: 402, error: 'Not enough credits', code: 'not_enough_credits' };
  if (own) server.boosts = server.boosts.filter((b) => b !== own);
  const boost = { id: id || `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`, userId: user.id, level, credits: tier.credits, startedAt: now, endsAt: now + DURATION_MS };
  server.boosts.push(boost);
  return { ok: true, boost, replaced: own || null };
}

// What a boost gives back when the server is deleted: the price times the unused share of its 14 days, rounded down at the end.
function refundOf(boost, now = Date.now()) {
  const left = Math.min(Math.max(boost.endsAt - now, 0), DURATION_MS);
  return Math.floor((boost.credits * left) / DURATION_MS);
}

// Per person, for a server that is being deleted: [{ userId, amount }]. Nothing is changed here, and people owed nothing are left out.
function refunds(server, now = Date.now()) {
  const by = new Map();
  for (const b of running(server, now)) by.set(b.userId, (by.get(b.userId) || 0) + refundOf(b, now));
  return [...by].filter(([, amount]) => amount > 0).map(([userId, amount]) => ({ userId, amount }));
}

// What members see (inside the server's view). The tag belongs to each person and lasts as long as their own boost does.
function view(server, now = Date.now()) {
  const list = running(server, now);
  return { level: levelOf(server, now), boosters: list.map((b) => ({ userId: b.userId, level: b.level, endsAt: b.endsAt })) };
}

// What the boost screen shows one person: the tiers, the server's level, who has a boost running and this person's own.
function info(server, userId, now = Date.now()) {
  const v = view(server, now);
  return { tiers: TIERS, days: DURATION_MS / DAY, level: v.level, boosters: v.boosters, mine: v.boosters.find((b) => b.userId === userId) || null };
}

module.exports = { DURATION_MS, TIERS, MESSAGE_MULTIPLIER, tierOf, running, levelOf, perksOf, multiplierOf, buy, buyFree, freeState, refundOf, refunds, view, info };
