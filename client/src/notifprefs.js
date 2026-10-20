// GENERATED from server/notifprefs.js by client/scripts/sync-notifprefs.mjs. Edit that file, not this one.
// Per-server notification settings: the rules, with no database and no sockets, so they can be tested alone
// (node server/notifprefs-test.js) and the browser can run the very same code.
//
// What a person can set for each server they are in (stored on their own user record as `serverPrefs[serverId]`):
//   level             'all' (default) | 'mentions' | 'nothing'     which messages are counted / may alert
//   mute              { until: ms | null }                           until null = until switched off
//   noEveryone        true  = @everyone / @here do not count or alert
//   noAnnouncements   true  = announcements stop alerting (they are still counted)
//   channels[id]      { level: 'default'|'all'|'mentions'|'nothing', mute }   a channel's own setting beats the server's
//
// Message kinds: 'message' (ordinary), 'mention' (names you), 'everyone', 'announcement' (a post in an announcements channel).
// A decision is { count, alert }: count = adds to the unread / @ numbers, alert = may pop a notification or push.
//
// No Node-only APIs here: the browser imports this file too.

const LEVELS = ['all', 'mentions', 'nothing'];
const CHANNEL_LEVELS = ['default', ...LEVELS];
const MAX_COUNT = 99; // a badge never needs to know more than "99+"
const MAX_MUTE_MS = 5 * 366 * 24 * 3600 * 1000; // a mute further away than this is simply "until I turn it off"

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
// An own, ordinary key. "__proto__" is refused even when JSON.parse made it an own property.
const own = (o, k) => k !== '__proto__' && Object.prototype.hasOwnProperty.call(o, k);
const num = (x) => typeof x === 'number' && Number.isFinite(x);

// ---------- mutes ----------
function muteActive(mute, now) {
  if (!isObj(mute) || !own(mute, 'until')) return false;
  if (mute.until === null) return true;
  return num(mute.until) && mute.until > now;
}

// A clean mute for storing, or undefined when it means nothing (already over, or not a mute at all).
function cleanMute(mute, now) {
  if (!isObj(mute) || !own(mute, 'until')) return undefined;
  const u = mute.until;
  if (u === null) return { until: null };
  if (!num(u) || u <= now) return undefined;
  return { until: u - now > MAX_MUTE_MS ? null : u };
}

// ---------- validation ----------
// Turns what a client sent into what gets stored, or null if the request is malformed.
// Defaults are not stored, so an untouched server has no entry at all.
function cleanServerPrefs(input, channelIds, now) {
  if (!isObj(input)) return null;
  const out = {};

  if (own(input, 'level')) {
    if (!LEVELS.includes(input.level)) return null;
    if (input.level !== 'all') out.level = input.level;
  }
  for (const k of ['noEveryone', 'noAnnouncements']) {
    if (!own(input, k)) continue;
    if (typeof input[k] !== 'boolean') return null;
    if (input[k]) out[k] = true;
  }
  if (own(input, 'mute')) {
    if (input.mute !== null) {
      if (!isObj(input.mute) || !(input.mute.until === null || num(input.mute.until))) return null;
      const m = cleanMute(input.mute, now);
      if (m) out.mute = m;
    }
  }
  if (own(input, 'channels')) {
    if (!isObj(input.channels)) return null;
    const known = new Set(channelIds);
    const chans = {};
    for (const id of Object.keys(input.channels)) {
      if (!known.has(id)) return null; // includes a key named "__proto__"
      const c = input.channels[id];
      if (!isObj(c)) return null;
      const entry = {};
      if (own(c, 'level')) {
        if (!CHANNEL_LEVELS.includes(c.level)) return null;
        if (c.level !== 'default') entry.level = c.level;
      }
      if (own(c, 'mute') && c.mute !== null) {
        if (!isObj(c.mute) || !(c.mute.until === null || num(c.mute.until))) return null;
        const m = cleanMute(c.mute, now);
        if (m) entry.mute = m;
      }
      if (Object.keys(entry).length) chans[id] = entry;
    }
    if (Object.keys(chans).length) out.channels = chans;
  }
  return out;
}

// ---------- what applies to one channel ----------
function effective(sp, channelId, now) {
  const s = isObj(sp) ? sp : {};
  const c = isObj(s.channels) && own(s.channels, channelId) && isObj(s.channels[channelId]) ? s.channels[channelId] : {};
  const serverMuted = muteActive(s.mute, now);
  const channelMuted = muteActive(c.mute, now);
  const level = LEVELS.includes(c.level) ? c.level : LEVELS.includes(s.level) ? s.level : 'all';
  return { muted: serverMuted || channelMuted, serverMuted, channelMuted, level };
}

// ---------- the decision ----------
function decide(sp, channelId, kind, now) {
  const s = isObj(sp) ? sp : {};
  const { muted, level } = effective(s, channelId, now);
  const no = { count: false, alert: false };
  if (level === 'nothing') return no;
  switch (kind) {
    case 'message': // ordinary messages never alert; they only add to the unread number
      return { count: !muted && level === 'all', alert: false };
    case 'mention':
      return { count: true, alert: !muted };
    case 'everyone':
      return s.noEveryone === true ? no : { count: true, alert: !muted };
    case 'announcement':
      if (muted) return no;
      return { count: level === 'all', alert: s.noAnnouncements !== true };
    default:
      return no;
  }
}

// What a message is to this person. @everyone with "no @everyone" is just an ordinary message.
function kindOf(sp, msg, meId) {
  if (Array.isArray(msg?.mentions) && msg.mentions.includes(meId)) return 'mention';
  if (msg?.everyone === true) return isObj(sp) && sp.noEveryone === true ? 'message' : 'everyone';
  return 'message';
}

// ---------- counting ----------
// Unread and @ numbers for one channel after the read position. Your own messages never count.
function countChannel(sp, channelId, msgs, readPos, meId, now) {
  let unread = 0, mentions = 0;
  for (const m of msgs) {
    if (!(m.createdAt > readPos) || m.authorId === meId) continue;
    const kind = kindOf(sp, m, meId);
    if (!decide(sp, channelId, kind, now).count) continue;
    if (kind === 'message') unread++; else mentions++;
  }
  return { unread: Math.min(unread, MAX_COUNT), mentions: Math.min(mentions, MAX_COUNT) };
}

// Where this person stopped reading a channel: the saved position, else the later of the account-wide floor and when they joined.
function readPosition(user, channelId, joinedAt) {
  const reads = user && isObj(user.reads) ? user.reads : null;
  if (reads && own(reads, channelId) && num(reads[channelId])) return reads[channelId];
  return Math.max(num(user?.readsFloor) ? user.readsFloor : 0, num(joinedAt) ? joinedAt : 0);
}

// ---------- housekeeping ----------
// Drops mutes that are over and entries that became empty. `store` is { serverId: prefs }. Returns true if anything changed.
function prune(store, now) {
  let changed = false;
  for (const sid of Object.keys(store)) {
    const sp = store[sid];
    if (!isObj(sp)) { delete store[sid]; changed = true; continue; }
    if (own(sp, 'mute') && !muteActive(sp.mute, now)) { delete sp.mute; changed = true; }
    if (isObj(sp.channels)) {
      for (const cid of Object.keys(sp.channels)) {
        const c = sp.channels[cid];
        if (isObj(c) && own(c, 'mute') && !muteActive(c.mute, now)) { delete c.mute; changed = true; }
        if (!isObj(c) || !Object.keys(c).length) { delete sp.channels[cid]; changed = true; }
      }
      if (!Object.keys(sp.channels).length) { delete sp.channels; changed = true; }
    }
    if (!Object.keys(sp).length) { delete store[sid]; changed = true; }
  }
  return changed;
}

export { LEVELS, CHANNEL_LEVELS, MAX_COUNT, muteActive, cleanMute, cleanServerPrefs, effective, decide, kindOf, countChannel, readPosition, prune };
