// Seasonal events: the Halloween and Christmas quests, the Christmas Advent calendar, and the developer test mode.
//
// Like credits.js this file has no Express / database imports: the rules are plain functions over a user record and the
// credits `grant` function, so server/events-test.js can run them without a server. index.js / credits.js wire them to routes.
//
// What is stored, per user:
//   u.seasons[<event>-<year>] = { trick: [userId], gif: [userId], react: [messageId], claimed: { questId: ts }, daily: { questId: 'YYYY-MM-DD' }, doors: { 1..24: ts } }
//   u.seasonBadges = [badge id]                    badges earned from events (see BADGES); shown next to the name
//   u.seasonTest = { mode: 'halloween'|'christmas', state }   developer test mode (developers only), see "test mode" below
//
// Where the safety lives (same ideas as credits.js):
//   * Rewards are only ever paid by claim() / openDoor() here, on the server, once per quest per event year (a daily quest once per UTC day,
//     a door once). The browser never sends an amount.
//   * Progress that the server can see for itself (reactions) is counted from the real reaction. Direct messages are end-to-end encrypted, so
//     the server cannot read them: for "say Trick or Treat to a friend" and "send a GIF to a friend" the BROWSER adds a hint to the encrypted
//     send (`quest: 'trick' | 'gif'`). A hint can be forged by a script, so it only ever counts when the server can check everything else:
//     the person is really friends with the receiver (dm:send already refuses anyone else), it is a different account each time (5 DIFFERENT
//     friends), both accounts are at least 30 minutes old, the receiver is not a bot, and the event window is open. The reward is a one-off.
//   * Test mode never pays: a developer can switch an event on for themselves to see the themes, quests and calendar, and everything they
//     claim there is a dry run (the amount is shown, no credits move, no badge is given). It is kept apart from real progress.

const DAY = 86_400_000;
const MAX_LIST = 50; // most friends / messages remembered per list

// month/day are 1-12 / 1-31 in UTC. `to` may be in the next calendar year (Christmas runs into January).
// Halloween matches the themes and the ringtone (17 Oct - 7 Nov). Christmas opens on 1 Dec so the Advent calendar can start on door 1;
// the themes and the ringtone still start on 11 Dec (client/src/ringtones.js).
const EVENTS = {
  halloween: { id: 'halloween', label: 'Halloween', icon: '\u{1F383}', from: { m: 10, d: 17 }, to: { m: 11, d: 7 } },
  christmas: { id: 'christmas', label: 'Christmas', icon: '\u{1F384}', from: { m: 12, d: 1 }, to: { m: 1, d: 1 } },
};

const strip = (e) => String(e || '').replace(/\uFE0F/g, ''); // emoji may or may not carry the "show as picture" selector
const emojiSet = (list) => new Set(list.map(strip));
const SPOOKY = emojiSet(['\u{1F383}', '\u{1F47B}', '\u{1F987}', '\u{1F577}\uFE0F', '\u{1F578}\uFE0F', '\u{1F480}', '\u{1F36C}', '\u{1F36D}', '\u{1F9DB}', '\u{1F9DF}']); // 🎃 👻 🦇 🕷️ 🕸️ 💀 🍬 🍭 🧛 🧟
const FESTIVE = emojiSet(['\u{1F384}', '\u{1F385}', '\u{1F381}', '\u26C4', '\u2603\uFE0F', '\u2744\uFE0F', '\u{1F98C}', '\u2B50', '\u{1F514}', '\u{1F936}']); // 🎄 🎅 🎁 ⛄ ☃️ ❄️ 🦌 ⭐ 🔔 🤶
const REACT_SETS = { halloween: SPOOKY, christmas: FESTIVE };

// Badges earned from events. Not `builtin` on purpose: the client draws `builtin` badges with the Creator picture.
const BADGES = {
  'trick-or-treater': { id: 'trick-or-treater', name: 'Trick or Treater', emoji: '\u{1F383}', color: '#e8731a', image: null },
  'santas-helper': { id: 'santas-helper', name: 'Santa\u2019s Helper', emoji: '\u{1F385}', color: '#c8312c', image: null },
};

const QUESTS = {
  halloween: [
    { id: 'trick', reward: 50, need: 5, title: 'Trick or Treat', desc: 'Say \u201CTrick or Treat\u201D to 5 different friends in a direct message.', have: (s) => s.trick.length, badge: 'trick-or-treater' },
    { id: 'pumpkin', reward: 20, need: 3, title: 'Pumpkin patch', desc: 'React with a \u{1F383}, \u{1F47B}, \u{1F987}, \u{1F577}\uFE0F or another spooky emoji to 3 different messages from other people.', have: (s) => s.react.length },
    { id: 'treat', daily: true, reward: 5, need: 1, title: 'Daily treat', desc: 'Open your treat bag once a day while Halloween lasts.', have: () => 1 },
  ],
  christmas: [
    { id: 'gifs', reward: 50, need: 5, title: 'Gift of GIFs', desc: 'Send a GIF to 5 different friends in direct messages.', have: (s) => s.gif.length },
    { id: 'cheer', reward: 20, need: 3, title: 'Holiday cheer', desc: 'React with a \u{1F384}, \u{1F385}, \u{1F381}, \u2744\uFE0F or another festive emoji to 3 different messages from other people.', have: (s) => s.react.length },
  ],
};

// The Advent calendar: door N opens on 1 December + N - 1 (UTC) and stays open until the event ends, so a missed day can still be opened.
// Most doors hold a few credits; every third door and the halfway door hold more, door 24 holds the most, and opening all 24 gives a badge.
const ADVENT_CREDITS = [5, 5, 10, 5, 5, 15, 5, 5, 10, 5, 5, 25, 5, 5, 10, 5, 5, 15, 5, 5, 10, 5, 10, 60];
const ADVENT_BADGE = 'santas-helper';
const DOORS = ADVENT_CREDITS.length; // 24

// ---------- dates ----------
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

// the first moment and the end (exclusive) of an event's window for the event that starts in `year`
function windowOf(ev, year) {
  const start = Date.UTC(year, ev.from.m - 1, ev.from.d);
  const endYear = ev.to.m < ev.from.m ? year + 1 : year;
  return { start, end: Date.UTC(endYear, ev.to.m - 1, ev.to.d) + DAY };
}

// the real event whose window contains `now`: { ev, year, start, end } or null
function eventAt(now = Date.now()) {
  const year = new Date(now).getUTCFullYear();
  for (const ev of Object.values(EVENTS)) {
    for (let y = year - 1; y <= year; y++) {
      const w = windowOf(ev, y);
      if (now >= w.start && now < w.end) return { ev, year: y, ...w };
    }
  }
  return null;
}

// ---------- per-user records ----------
const list = (x) => (Array.isArray(x) ? x : []);
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
function normal(s) {
  s.trick = list(s.trick); s.gif = list(s.gif); s.react = list(s.react);
  s.claimed = obj(s.claimed); s.daily = obj(s.daily); s.doors = obj(s.doors);
  return s;
}

// What applies to this person right now: { ev, year, key, test, state, start, end } or null.
// A developer with test mode on sees that event (in a separate record that never pays); everyone else sees the real event, if one is open.
function current(u, { now = Date.now(), dev = false } = {}) {
  const t = dev && u.seasonTest && EVENTS[u.seasonTest.mode] ? u.seasonTest : null;
  if (t) {
    const ev = EVENTS[t.mode];
    return { ev, year: new Date(now).getUTCFullYear(), key: 'test-' + ev.id, test: true, state: normal(t.state || (t.state = {})), start: null, end: null };
  }
  const e = eventAt(now);
  if (!e) return null;
  const key = `${e.ev.id}-${e.year}`;
  const seasons = u.seasons && typeof u.seasons === 'object' ? u.seasons : (u.seasons = {});
  return { ev: e.ev, year: e.year, key, test: false, state: normal(seasons[key] || (seasons[key] = {})), start: e.start, end: e.end };
}

const oldEnough = (x, now, minAgeMs) => !!x && now - (x.createdAt || 0) >= minAgeMs;
const remember = (arr, v) => { if (arr.includes(v)) return false; if (arr.length >= MAX_LIST) return false; arr.push(v); return true; };

// ---------- progress ----------
// A direct message to a friend. hint: 'trick' (the text said Trick or Treat) or 'gif' (it carried a GIF), sent by the browser, see the top.
// The caller has already checked that `to` is a friend. Returns true when the progress changed.
function noteDm(u, to, hint, { now = Date.now(), dev = false, minAgeMs = 0 } = {}) {
  if (hint !== 'trick' && hint !== 'gif') return false;
  const cur = current(u, { now, dev });
  if (!cur || (hint === 'trick') !== (cur.ev.id === 'halloween')) return false; // 'trick' only in Halloween, 'gif' only at Christmas
  if (!to || to.id === u.id || to.bot) return false;
  if (!cur.test && !(oldEnough(u, now, minAgeMs) && oldEnough(to, now, minAgeMs))) return false;
  return remember(cur.state[hint], to.id);
}

// Someone reacted to a message that another person wrote. Returns true when the progress changed.
function noteReaction(u, emoji, messageId, authorId, { now = Date.now(), dev = false, minAgeMs = 0 } = {}) {
  const cur = current(u, { now, dev });
  if (!cur || !authorId || authorId === u.id || !messageId) return false;
  if (!REACT_SETS[cur.ev.id].has(strip(emoji))) return false;
  if (!cur.test && !oldEnough(u, now, minAgeMs)) return false;
  return remember(cur.state.react, String(messageId));
}

// ---------- what the client sees ----------
function questViews(cur, now) {
  const s = cur.state, today = dayKey(now);
  return QUESTS[cur.ev.id].map((q) => {
    const have = Math.min(q.have(s), q.need);
    const claimed = q.daily ? s.daily[q.id] === today : !!s.claimed[q.id];
    return { id: q.id, title: q.title, desc: q.desc, daily: !!q.daily, reward: q.reward, have, need: q.need, done: have >= q.need, claimed };
  });
}

// door N is open to claim when its date has come (every door in test mode) and the event is on
const doorOpensAt = (cur, day) => Date.UTC(cur.year, 11, day);
function adventView(cur, now) {
  const doors = [];
  for (let day = 1; day <= DOORS; day++) {
    const opened = !!cur.state.doors[day];
    const ready = cur.test || now >= doorOpensAt(cur, day);
    doors.push({ day, reward: ADVENT_CREDITS[day - 1], opened, state: opened ? 'opened' : ready ? 'ready' : 'locked', ...(day === DOORS ? { badge: BADGES[ADVENT_BADGE].name } : {}) });
  }
  return { total: DOORS, opened: doors.filter((d) => d.opened).length, doors, badge: { id: ADVENT_BADGE, name: BADGES[ADVENT_BADGE].name, emoji: BADGES[ADVENT_BADGE].emoji } };
}

// null when there is no event for this person right now
function view(u, { now = Date.now(), dev = false } = {}) {
  const cur = current(u, { now, dev });
  if (!cur) return null;
  return {
    id: cur.ev.id, label: cur.ev.label, icon: cur.ev.icon, test: cur.test,
    until: cur.end ? cur.end - DAY : null, // the last day, as a timestamp (UTC midnight)
    quests: questViews(cur, now),
    advent: cur.ev.id === 'christmas' ? adventView(cur, now) : null,
    ...(cur.ev.id === 'halloween' ? { badge: { id: 'trick-or-treater', name: BADGES['trick-or-treater'].name, emoji: BADGES['trick-or-treater'].emoji } } : {}),
  };
}

// ---------- paying ----------
function award(u, badgeId, cur) {
  if (cur.test || !BADGES[badgeId]) return null;
  const have = list(u.seasonBadges);
  if (!have.includes(badgeId)) u.seasonBadges = [...have, badgeId];
  return BADGES[badgeId].name;
}

// Claims a finished quest. grant(u, amount, reason, { note, now }) is credits.grant.
function claim(u, id, { now = Date.now(), dev = false, grant, minAgeMs = 0, unlocksAt = 0 } = {}) {
  const cur = current(u, { now, dev });
  if (!cur) return { status: 404, error: 'There is no event on right now' };
  const q = QUESTS[cur.ev.id].find((x) => x.id === id);
  if (!q) return { status: 404, error: 'Unknown quest' };
  if (!cur.test && now < unlocksAt) return { status: 403, error: 'Rewards unlock 30 minutes after you sign up', unlocksAt };
  const s = cur.state, today = dayKey(now);
  if (q.daily ? s.daily[q.id] === today : s.claimed[q.id]) return { status: 409, error: q.daily ? 'Already claimed today' : 'Already claimed' };
  if (q.have(s) < q.need) return { status: 400, error: 'Not finished yet' };
  if (q.daily) s.daily[q.id] = today; else s.claimed[q.id] = now; // marked before paying: check and payment are one synchronous step
  if (cur.test) return { ok: true, amount: q.reward, test: true };
  grant(u, q.reward, 'quest', { note: `${cur.ev.label}: ${q.title}`, now });
  const badge = q.badge ? award(u, q.badge, cur) : null;
  return { ok: true, amount: q.reward, test: false, ...(badge ? { badge } : {}) };
}

// Opens an Advent door (Christmas only).
function openDoor(u, day, { now = Date.now(), dev = false, grant, unlocksAt = 0 } = {}) {
  const cur = current(u, { now, dev });
  if (!cur || cur.ev.id !== 'christmas') return { status: 404, error: 'The Advent calendar is only open at Christmas' };
  day = Number(day);
  if (!Number.isInteger(day) || day < 1 || day > DOORS) return { status: 404, error: 'There is no such door' };
  if (!cur.test && now < unlocksAt) return { status: 403, error: 'Rewards unlock 30 minutes after you sign up', unlocksAt };
  if (!cur.test && now < doorOpensAt(cur, day)) return { status: 403, error: `Door ${day} opens on ${day} December` };
  if (cur.state.doors[day]) return { status: 409, error: 'You already opened that door' };
  cur.state.doors[day] = now;
  const amount = ADVENT_CREDITS[day - 1];
  if (cur.test) return { ok: true, amount, test: true, all: Object.keys(cur.state.doors).length >= DOORS };
  grant(u, amount, 'quest', { note: `Advent calendar: door ${day}`, now });
  const all = Object.keys(cur.state.doors).length >= DOORS;
  const badge = all ? award(u, ADVENT_BADGE, cur) : null;
  return { ok: true, amount, test: false, all, ...(badge ? { badge } : {}) };
}

// ---------- test mode (developers) ----------
// mode: 'halloween' | 'christmas' | null (off). Switching to the other event, or off, starts the test record from nothing.
function setTest(u, mode) {
  if (mode === null || mode === undefined || mode === '') { delete u.seasonTest; return null; }
  if (!EVENTS[mode]) throw new Error('Unknown event');
  if (!u.seasonTest || u.seasonTest.mode !== mode) u.seasonTest = { mode, state: {} };
  return mode;
}
function resetTest(u) { if (u.seasonTest) u.seasonTest.state = {}; }
const testMode = (u, dev) => (dev && u.seasonTest && EVENTS[u.seasonTest.mode] ? u.seasonTest.mode : null);

// the event badges a person has earned, in the same shape as other badges (see badgeViews in index.js)
function badgeViews(u) {
  return list(u.seasonBadges).filter((id) => BADGES[id]).map((id) => ({ ...BADGES[id] }));
}

module.exports = {
  EVENTS, QUESTS, BADGES, ADVENT_CREDITS, DOORS, windowOf, eventAt, current,
  noteDm, noteReaction, view, claim, openDoor, setTest, resetTest, testMode, badgeViews,
};
