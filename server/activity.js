// "Playing ..." on a profile: the game someone is playing right now (no Express, no database: tested by activity-test.js).
//
// A game is something that is happening NOW, so it lives in memory only and is never saved. It has two sources:
//   'auto'   the Aduna desktop app saw a known game running and says so about once a minute; if the reports stop (the game closed, the app
//            quit) it disappears on its own after STALE_MS;
//   'manual' the person typed it in Settings > Activity; it stays until they clear it, go offline or MANUAL_MAX_MS passes.
// It is shown only while the person is online (not Invisible) and has "Show what I'm playing" on (user.showActivity !== false).
// Names are shown to other people, so every name (typed or reported by the app: the server cannot tell the two apart) passes the same word
// and link checks as public server names.

const listing = require('./listing');

const LIMITS = {
  name: 64,                     // characters in a game name
  minGapMs: 4000,               // a person may change it at most once per this long (the desktop app reports about once a minute)
  staleMs: 4 * 60_000,          // an auto-detected game that has not been refreshed for this long is over
  manualMaxMs: 12 * 3600_000,   // a typed one is dropped after this long even if the person forgot it
};

// A game name as it will be shown. Control and invisible characters go, spaces collapse. Returns { name } or { error }.
function clean(value, words = []) {
  if (typeof value !== 'string') return { error: 'Enter the name of a game' };
  const name = value.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  if (!name) return { error: 'Enter the name of a game' };
  if (Array.from(name).length > LIMITS.name) return { error: `A game name can be at most ${LIMITS.name} characters` };
  if (listing.hasLink(name)) return { error: 'A game name cannot contain a link' };
  if (listing.blockedWord(name, words, { compact: true })) return { error: 'That name is not allowed' };
  return { name };
}

// Sets (or refreshes) someone's game. The same name from the same source only refreshes `seen`: `since` stays, so "for 2 hours" keeps counting.
// Returns { ok, changed, entry } or { error, wait }.
function set(map, uid, input, source, now, words) {
  if (source !== 'auto' && source !== 'manual') return { error: 'Unknown source' };
  const c = clean(input, words); // the same checks for both sources: the server cannot tell that a request really comes from the desktop app
  if (c.error) return { error: c.error };
  const old = current(map, uid, now);
  if (old && old.source === 'manual' && source === 'auto') return { ok: true, changed: false, entry: old, ignored: true }; // what the person typed wins over what the app detected
  if (old && old.name === c.name && old.source === source) { old.seen = now; return { ok: true, changed: false, entry: old }; }
  if (old && now - (old.changedAt || 0) < LIMITS.minGapMs) return { error: 'Too fast. Try again in a moment.', wait: LIMITS.minGapMs - (now - old.changedAt) };
  const entry = { name: c.name, source, since: now, seen: now, changedAt: now };
  map.set(uid, entry);
  return { ok: true, changed: true, entry };
}

// Removes someone's game; true when there was one. `source` limits it: the desktop app may only clear a game it reported itself.
function clear(map, uid, source) {
  const e = map.get(uid);
  if (!e || (source && e.source !== source)) return false;
  map.delete(uid);
  return true;
}

// The entry if it is still going, otherwise nothing (and an expired one is dropped).
function current(map, uid, now) {
  const e = map.get(uid);
  if (!e) return null;
  const limit = e.source === 'auto' ? LIMITS.staleMs : LIMITS.manualMaxMs;
  if (now - (e.source === 'auto' ? e.seen : e.since) > limit) { map.delete(uid); return null; }
  return e;
}

// Drops every expired entry and returns the ids that lost theirs, so the server can tell their audience.
function sweep(map, now) {
  const gone = [];
  for (const uid of [...map.keys()]) if (!current(map, uid, now)) gone.push(uid);
  return gone;
}

// What other people (and the person's own devices) see on the profile: { name, since, source }, or null.
// `visible` = the person is online and not Invisible. Nothing is shown for a bot, for someone who turned it off, or when they are not around.
function view(user, entry, visible) {
  if (!user || user.bot || user.showActivity === false || !visible || !entry) return null;
  return { name: entry.name, since: entry.since, source: entry.source };
}

module.exports = { LIMITS, clean, set, clear, current, sweep, view };
