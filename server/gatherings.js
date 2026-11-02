// Gatherings (called "Events" in the app): a game night on Friday at eight. Aduna means "to gather", and this is the part that does it:
// someone makes the event, members mark Going or Maybe, everyone who did gets a reminder shortly before it starts and again when it starts,
// and the reminder has a one-tap button into the voice channel.
//
// (Not to be confused with server/events.js, which is the Halloween / Christmas quests.)
//
// Like soundboard.js and stickers.js this file has no Express / database imports: the rules are plain functions over a server record,
// so server/gatherings-test.js can run them without a server. index.js wires them to the routes, the reminder sweep and the server view.
//
//   server.gatherings  [{ id, title, desc, startsAt, endsAt, channelId, by, at, rsvps, reminded }]
//     startsAt / endsAt  milliseconds since 1970 (the browser shows them in the viewer's own time zone); an event lasts 15 minutes to 24 hours, 2 hours if not said
//     channelId          one of the server's voice channels, or null: the "Join voice" button goes there
//     by                 who made it (they, or anyone with Manage server, may change or cancel it)
//     rsvps              { userId: 'yes' | 'maybe' }   the person who made it starts as 'yes'. Not answering is just not being in the list
//     reminded           { soon, start }   when each reminder went out (-1 = it was not needed or came too late); keeps it from going out twice
//
// Reminders: "soon" 15 minutes before and "start" at the start time, to the people who said yes or maybe, except anyone already in the voice channel.
// A reminder that is more than a few minutes late (the server was off) is dropped rather than sent stale.
// An event stays on the list for an hour after it ends, then it is deleted.

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const LIMITS = {
  title: 60,
  desc: 500,
  perServer: 25,                 // events that have not ended
  perMember: 5,                  // ...started by one person
  aheadMs: 366 * DAY,
  pastSlackMs: 5 * MIN,          // a start up to 5 minutes ago still counts as "now" (the clock on the form may be a little behind)
  minLenMs: 15 * MIN,
  maxLenMs: 24 * HOUR,
  defaultLenMs: 2 * HOUR,
  soonMs: 15 * MIN,              // the "starting soon" reminder goes out this long before the start
  lateMs: 10 * MIN,              // the "starting now" reminder is dropped when it is this late
  keepMs: HOUR,                  // an event that ended stays listed this long
};
const RSVP = ['yes', 'maybe'];

const gatheringsOf = (s) => (s && Array.isArray(s.gatherings) ? s.gatherings : []);
const find = (s, id) => (typeof id === 'string' ? gatheringsOf(s).find((g) => g.id === id) || null : null);
const memberSet = (s) => new Set(Array.isArray(s && s.members) ? s.members : []);

// ---------- one event ----------
const CTRL = /[<>\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;          // everything that must not be in a name
const CTRL_KEEP_NL = /[<>\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g; // ...except a line break, which a description may have

function cleanTitle(raw) {
  const t = Array.from(String(raw ?? '').replace(CTRL, ' ').replace(/\s+/g, ' ').trim());
  if (!t.length || t.length > LIMITS.title) return { error: `An event name is 1-${LIMITS.title} characters` };
  return { title: t.join('') };
}

function cleanDesc(raw) {
  if (raw === undefined || raw === null || raw === '') return { desc: '' };
  if (typeof raw !== 'string') return { error: 'The description must be text' };
  const d = Array.from(raw.replace(/\r\n?/g, '\n').replace(CTRL_KEEP_NL, ' ').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
  if (d.length > LIMITS.desc) return { error: `A description is up to ${LIMITS.desc} characters` };
  return { desc: d.join('') };
}

// The start and end from a request. `current` = the event being changed: a start that is not changed may be in the past (it is under way),
// and a change of start alone keeps the length. A new event with no end lasts two hours.
function cleanTimes(b, now, current) {
  let startsAt = current ? current.startsAt : undefined;
  if (b.startsAt !== undefined || !current) {
    if (typeof b.startsAt !== 'number' || !Number.isFinite(b.startsAt)) return { error: 'Choose when the event starts' };
    startsAt = Math.round(b.startsAt);
    if ((!current || startsAt !== current.startsAt) && startsAt < now - LIMITS.pastSlackMs) return { error: 'That time has already passed' };
    if (startsAt > now + LIMITS.aheadMs) return { error: 'An event can be at most a year away' };
  }
  let endsAt;
  if (b.endsAt === undefined || b.endsAt === null) endsAt = startsAt + (current ? current.endsAt - current.startsAt : LIMITS.defaultLenMs);
  else if (typeof b.endsAt !== 'number' || !Number.isFinite(b.endsAt)) return { error: 'Choose when the event ends' };
  else endsAt = Math.round(b.endsAt);
  const len = endsAt - startsAt;
  if (len < LIMITS.minLenMs || len > LIMITS.maxLenMs) return { error: 'An event lasts from 15 minutes to 24 hours' };
  return { startsAt, endsAt };
}

// null / '' = no voice channel. Otherwise it must be one of this server's voice channels.
function cleanChannel(s, raw) {
  if (raw === undefined || raw === null || raw === '') return { channelId: null };
  const c = typeof raw === 'string' ? (s.channels || []).find((x) => x.id === raw) : null;
  if (!c || c.type !== 'voice') return { error: 'Choose a voice channel from this server' };
  return { channelId: c.id };
}

// Everything checked at once. New event: title and start are required. Change (`current` given): only what is sent changes.
// Returns { value } with the fields to store, or { error }.
function parse(s, body, now, current) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const out = {};
  if (b.title !== undefined || !current) { const r = cleanTitle(b.title); if (r.error) return r; out.title = r.title; }
  if (b.desc !== undefined) { const r = cleanDesc(b.desc); if (r.error) return r; out.desc = r.desc; } else if (!current) out.desc = '';
  const t = cleanTimes(b, now, current);
  if (t.error) return t;
  out.startsAt = t.startsAt; out.endsAt = t.endsAt;
  if (b.channelId !== undefined) { const r = cleanChannel(s, b.channelId); if (r.error) return r; out.channelId = r.channelId; } else if (!current) out.channelId = null;
  return { value: out };
}

// A reminder that would be pointless (the event starts within the reminder time, or already started) is marked as skipped from the start.
function markSkipped(g, now) {
  if (g.startsAt - now < LIMITS.soonMs) g.reminded.soon = -1;
  if (g.startsAt <= now) g.reminded.start = -1;
}

// Can this person start another event? A server holds up to 25 that have not ended, one person up to 5.
function roomFor(s, uid, now) {
  const open = gatheringsOf(s).filter((g) => g.endsAt > now);
  if (open.length >= LIMITS.perServer) return { ok: false, status: 400, error: `A server can have up to ${LIMITS.perServer} upcoming events` };
  if (open.filter((g) => g.by === uid).length >= LIMITS.perMember) return { ok: false, status: 400, error: `You can have up to ${LIMITS.perMember} upcoming events at a time` };
  return { ok: true };
}

// Makes the event (the person who made it is going) and adds it to the server. `value` is what parse() returned.
function create(s, uid, value, now, id) {
  const g = { id, ...value, by: uid, at: now, rsvps: { [uid]: 'yes' }, reminded: {} };
  markSkipped(g, now);
  if (!Array.isArray(s.gatherings)) s.gatherings = [];
  s.gatherings.push(g);
  return g;
}

// Applies a change. A new start time starts the reminders over.
function update(g, value, now) {
  const moved = value.startsAt !== undefined && value.startsAt !== g.startsAt;
  Object.assign(g, value);
  if (moved) { g.reminded = {}; markSkipped(g, now); }
  return g;
}

// ---------- answering ----------
// status: 'yes' | 'maybe' | null (take the answer back). Whether the person is a member is the route's job.
function setRsvp(g, uid, status, now) {
  if (status !== null && !RSVP.includes(status)) return { error: 'Choose going or maybe' };
  if (g.endsAt <= now) return { error: 'That event is over' };
  if (!g.rsvps || typeof g.rsvps !== 'object' || Array.isArray(g.rsvps)) g.rsvps = {};
  if (status === null) delete g.rsvps[uid]; else g.rsvps[uid] = status;
  return { ok: true };
}

// The members who said yes or maybe (people who have left the server are not counted)
function going(s, g) {
  const members = memberSet(s);
  return Object.entries(g.rsvps || {}).filter(([uid, st]) => members.has(uid) && RSVP.includes(st)).map(([uid]) => uid);
}

// ---------- what the browser gets ----------
// All the events that have not been over for more than an hour, soonest first. Answers from people who left are left out, and so is a voice
// channel that was deleted.
function view(s, now) {
  const members = memberSet(s);
  const voice = new Set((s.channels || []).filter((c) => c.type === 'voice').map((c) => c.id));
  const list = gatheringsOf(s).filter((g) => g.endsAt + LIMITS.keepMs > now).slice().sort((a, b) => a.startsAt - b.startsAt || a.at - b.at);
  return {
    gatherings: list.map((g) => {
      const yes = [], maybe = [];
      for (const [uid, st] of Object.entries(g.rsvps || {})) {
        if (!members.has(uid)) continue;
        if (st === 'yes') yes.push(uid); else if (st === 'maybe') maybe.push(uid);
      }
      return { id: g.id, title: g.title, desc: g.desc || '', startsAt: g.startsAt, endsAt: g.endsAt, channelId: voice.has(g.channelId) ? g.channelId : null, by: g.by, yes, maybe };
    }),
  };
}

// ---------- reminders ----------
// What is due now, as { reminders: [{ gatheringId, kind: 'soon' | 'start', to: [userId] }], changed }. Each reminder is marked as sent here, so
// calling this again does not repeat it; `changed` says the server record needs saving. skip(uid, g) leaves someone out (already in the voice channel).
function due(s, now, { skip } = {}) {
  const reminders = [];
  let changed = false;
  for (const g of gatheringsOf(s)) {
    if (!g.reminded || typeof g.reminded !== 'object') g.reminded = {};
    for (const [kind, at, lastOk] of [['soon', g.startsAt - LIMITS.soonMs, g.startsAt], ['start', g.startsAt, g.startsAt + LIMITS.lateMs]]) {
      if (g.reminded[kind] !== undefined || now < at) continue;
      changed = true;
      if (now >= lastOk) { g.reminded[kind] = -1; continue; } // too late to be useful (the server was off)
      g.reminded[kind] = now;
      const to = going(s, g).filter((uid) => !(skip && skip(uid, g)));
      if (to.length) reminders.push({ gatheringId: g.id, kind, to });
    }
  }
  return { reminders, changed };
}

// The sentence under the event's name in a reminder
function reminderText(g, kind, channelName) {
  const when = kind === 'start' ? 'Starting now' : `Starts in ${Math.round(LIMITS.soonMs / MIN)} minutes`;
  return channelName ? `${when} \u00b7 ${channelName}` : when;
}

// Deletes events that ended more than an hour ago. Returns true when something went.
function prune(s, now) {
  const list = gatheringsOf(s);
  const keep = list.filter((g) => g.endsAt + LIMITS.keepMs > now);
  if (keep.length === list.length) return false;
  s.gatherings = keep;
  return true;
}

module.exports = { LIMITS, RSVP, gatheringsOf, find, parse, roomFor, create, update, setRsvp, going, view, due, reminderText, prune };
