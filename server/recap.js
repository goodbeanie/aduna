'use strict';
// The yearly recap. Counts only: no message text is kept and nobody's name is attached to who they talked to. The one thing it names is the
// public servers that grew the most. Emoji are counted while a
// server message is read and the text is dropped right after (DMs and group chats are encrypted, so they only count as messages).
// Pure, no Express and no database (recap-test.js). index.js runs it in the first weeks of the year and keeps one small file per person.
//
// What the server already knew: messages, dms, gmsgs, calllog, friendships, clips, servers, wordle, contexto, puzzle, user.badges.
// What it did not, so it is counted on the user from now on (u.recap[year]): credits earned, quests completed, badges earned, and time in server
// voice channels and group calls (each person's own stay, from when someone else was there). Calls in a DM come from the call log, which keeps the
// newest 200 per conversation. Day and hour are UTC. Friendships use the day they were accepted (older ones only have the day of the request).
// A badge count of null means nothing was counted yet; badgesHeld is how many the person holds today.
const fs = require('fs');
const path = require('path');
const music = require('./music');

const EMOJI = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CLIP_STATES = new Set(['live', 'expired']);
const VOICE_TICK_MS = 30_000;

const yearOf = (ms) => new Date(ms).getUTCFullYear();
const inYear = (ms, y) => Number.isFinite(ms) && yearOf(ms) === y;

// ---------- counters kept on the user ----------
function slot(u, at) {
  const all = u.recap || (u.recap = {}), y = yearOf(at);
  return all[y] || (all[y] = {});
}
function bump(u, key, n, at = Date.now()) {
  if (!u || !(n > 0)) return;
  const c = slot(u, at);
  c[key] = (c[key] || 0) + n;
}
function atLeast(u, key, n, at = Date.now()) {
  if (!u || !(n > 0)) return;
  const c = slot(u, at);
  if (!(c[key] >= n)) c[key] = n;
}
// null when nothing was ever counted, so "0" is never shown for something the server was not watching
const counter = (u, y, key) => { const c = u.recap && u.recap[y]; return c && Number.isFinite(c[key]) ? c[key] : null; };

// Who is in a server voice channel, sampled on a timer. Joins, leaves, kicks and dropped connections all look the same from here.
function createVoiceMeter({ now = Date.now, tickMs = VOICE_TICK_MS } = {}) {
  const sessions = new Map(); // uid -> { since, last }
  return {
    // returns [{ uid, add (seconds since the last tick), session (seconds in this stay so far) }]
    tick(present) {
      const t = now(), here = new Set(present), out = [];
      for (const uid of here) {
        const s = sessions.get(uid);
        if (!s) { sessions.set(uid, { since: t, last: t }); continue; }
        out.push({ uid, add: Math.min(Math.round((t - s.last) / 1000), Math.round(tickMs / 500)), session: Math.round((t - s.since) / 1000) });
        s.last = t;
      }
      for (const uid of [...sessions.keys()]) if (!here.has(uid)) sessions.delete(uid);
      return out;
    },
  };
}

// ---------- the numbers ----------
// The key with the highest count; a tie is settled at random.
function pickTop(counts, rng = Math.random) {
  let best = 0, tied = [];
  for (const [k, n] of counts) {
    if (n > best) { best = n; tied = [k]; } else if (n === best && n > 0) tied.push(k);
  }
  return tied.length ? tied[Math.floor(rng() * tied.length)] : null;
}
function pickTopN(counts, n, rng = Math.random) {
  const left = new Map(counts), out = [];
  while (out.length < n) {
    const k = pickTop(left, rng);
    if (k === null) break;
    out.push(k);
    left.delete(k);
  }
  return out;
}

// The servers that took in the most people this year. Only people still in the server count (joinedAt is dropped when someone leaves),
// and only servers that are listed publicly, since their names end up in a video anyone can share. skip is the official server.
const MAX_SERVERS = 3;
const publicServer = (s) => s.visibility === 'public' && !s.listingHold;
function topServers(servers, users, year, { skip = null, listed = publicServer } = {}) {
  const gained = (s) => Object.entries(s.joinedAt || {}).filter(([uid, at]) => inYear(at, year) && (s.members || []).includes(uid) && users[uid] && !users[uid].bot && !users[uid].deleted).length;
  return Object.values(servers)
    .filter((s) => s && s.id !== skip && listed(s))
    .map((s) => ({ name: String(s.name || '').trim().slice(0, 40), gained: gained(s) }))
    .filter((s) => s.name && s.gained > 0)
    .sort((a, b) => b.gained - a.gained || a.name.localeCompare(b.name))
    .slice(0, MAX_SERVERS);
}

// top N% = 1 + the people strictly ahead of you, out of everyone who has a number for it
function percentiler(values) {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  return (v) => {
    if (!(v > 0) || !sorted.length) return null;
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= v) lo = mid + 1; else hi = mid; }
    return Math.max(1, Math.round((100 * (sorted.length - lo + 1)) / sorted.length));
  };
}

function titleFor(hour, messagesTop) {
  if (messagesTop !== null && messagesTop <= 5) return 'Chatterbox';
  if (hour === null) return null;
  if (hour >= 22 || hour <= 4) return 'Night Owl';
  if (hour >= 5 && hour <= 8) return 'Early Bird';
  return 'Daytimer';
}

const blank = () => ({ messages: 0, files: 0, hours: new Map(), days: new Map(), emoji: new Map(), callSeconds: 0, longestCall: 0, friends: 0, clips: 0 });
const add = (map, key, n = 1) => map.set(key, (map.get(key) || 0) + n);
const gameTotals = (rec, key) => Object.values((rec && rec.stats) || {}).reduce((s, x) => s + (x[key] || 0), 0);
const gameBest = (...recs) => Math.max(0, ...recs.flatMap((rec) => Object.values((rec && rec.stats) || {}).map((x) => x.best || 0)));

// The profile song as the recap plays it: an uploaded clip ({ id, title }) or a song picked from the search (its 30 second preview).
function songOf(u) {
  const s = u && u.song;
  if (!s) return null;
  if (s.kind === 'track') return music.trackView(s);
  return s.id ? { id: s.id, title: String(s.title || '') } : null;
}

// db: the collections of the main database. Returns { global, users: { [id]: recap } }; people with nothing to show are left out.
// opts.skipServer is the id of the official server, which is left out of the fastest growing ones; opts.listed says which servers may be named.
function buildAll(db, year, rng = Math.random, opts = {}) {
  const { users = {}, messages = {}, dms = {}, gmsgs = {}, calllog = {}, friendships = {}, clips = {}, servers = {}, wordle = {}, contexto = {}, puzzle = {} } = db;
  const per = new Map();
  const of = (uid) => { let p = per.get(uid); if (!p) per.set(uid, (p = blank())); return p; };

  const tally = (uid, at, files, text) => {
    const u = users[uid];
    if (!u || u.bot || !inYear(at, year)) return;
    const p = of(uid), d = new Date(at);
    p.messages++; p.files += files;
    add(p.hours, d.getUTCHours());
    add(p.days, d.toISOString().slice(0, 10));
    if (text) for (const e of text.match(EMOJI) || []) add(p.emoji, e);
  };
  for (const m of Object.values(messages)) tally(m.authorId, m.createdAt, (m.attachments || []).length, typeof m.content === 'string' ? m.content : '');
  for (const m of Object.values(dms)) tally(m.from, m.createdAt, (m.files || []).length);
  for (const m of Object.values(gmsgs)) tally(m.from, m.createdAt, (m.files || []).length);

  for (const c of Object.values(calllog)) {
    if (c.outcome !== 'completed' || c.group || !inYear(c.startedAt, year)) continue;
    for (const uid of [c.a, c.b]) if (users[uid] && !users[uid].bot) { const p = of(uid); p.callSeconds += c.seconds || 0; p.longestCall = Math.max(p.longestCall, c.seconds || 0); }
  }
  let friendshipsMade = 0;
  for (const f of Object.values(friendships)) {
    if (f.status !== 'friends' || !inYear(f.acceptedAt || f.createdAt, year)) continue; // older friendships only have the date of the request
    friendshipsMade++;
    for (const uid of [f.from, f.to]) if (users[uid]) of(uid).friends++;
  }
  for (const c of Object.values(clips)) if (CLIP_STATES.has(c.state) && inYear(c.createdAt, year) && users[c.owner]) of(c.owner).clips++;

  const people = Object.values(users).filter((u) => !u.bot && !u.deleted);
  const rows = people.map((u) => {
    const p = per.get(u.id) || blank();
    const vcSeconds = (counter(u, year, 'vcSeconds') || 0) + p.callSeconds;
    const longest = Math.max(counter(u, year, 'vcLongest') || 0, p.longestCall);
    return { u, p, vcSeconds, longest, credits: counter(u, year, 'credits'), quests: counter(u, year, 'quests'), badges: counter(u, year, 'badges') };
  });
  const topVc = percentiler(rows.map((r) => r.vcSeconds)), topMsgs = percentiler(rows.map((r) => r.p.messages));

  const out = {};
  for (const { u, p, vcSeconds, longest, credits, quests, badges } of rows) {
    const wordleWins = gameTotals(wordle[u.id], 'won'), contextoWins = gameTotals(contexto[u.id], 'won'), puzzleWins = gameTotals(puzzle[u.id], 'solved');
    const msgTop = topMsgs(p.messages), hour = pickTop(p.hours, rng);
    const recap = {
      userId: u.id, year, messages: p.messages, files: p.files, clips: p.clips, vcHours: Math.round(vcSeconds / 3600), credits, quests,
      busiestDay: pickTop(p.days, rng), favoriteHour: hour, title: titleFor(hour, msgTop), topEmoji: pickTop(p.emoji, rng),
      longestCallMin: Math.round(longest / 60), friends: p.friends, badges, badgesHeld: Array.isArray(u.badges) ? u.badges.length : 0,
      wordle: wordleWins, contexto: contextoWins, puzzle: puzzleWins, bestStreak: gameBest(wordle[u.id], contexto[u.id], puzzle[u.id]),
      topPercent: { vc: topVc(vcSeconds), messages: msgTop },
      song: songOf(u),
    };
    if (recap.messages || vcSeconds || recap.friends || recap.clips || credits || quests || wordleWins || contextoWins || puzzleWins) out[u.id] = recap;
  }

  const hours = new Map(), days = new Map(), emoji = new Map(), songs = new Map(), themes = new Map(), sample = new Map();
  for (const { u, p } of rows) {
    for (const [k, n] of p.hours) add(hours, k, n);
    for (const [k, n] of p.days) add(days, k, n);
    for (const [k, n] of p.emoji) add(emoji, k, n);
    const song = songOf(u);
    if (song && song.title) { const key = song.title.trim().toLowerCase(); add(songs, key); if (!sample.has(key)) sample.set(key, { ...song, title: song.title.trim() }); }
    if (u.profileTheme && u.profileTheme !== 'custom') add(themes, u.profileTheme);
  }
  const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
  const tracked = (k) => (rows.some((r) => r[k] !== null) ? sum((r) => r[k] || 0) : null);
  const topSongs = pickTopN(songs, 2, rng).map((k) => sample.get(k)).filter(Boolean);
  const global = {
    year, users: people.length, joinedThisYear: people.filter((u) => inYear(u.createdAt, year)).length,
    messages: sum((r) => r.p.messages), files: sum((r) => r.p.files), clips: sum((r) => r.p.clips),
    vcHours: Math.round(sum((r) => r.vcSeconds) / 3600), credits: tracked('credits'), quests: tracked('quests'),
    busiestDay: pickTop(days, rng), busiestHour: pickTop(hours, rng), topEmoji: pickTop(emoji, rng),
    topSong: topSongs[0] || null, topSongs, topTheme: pickTop(themes, rng),
    topServers: topServers(servers, users, year, { skip: opts.skipServer, listed: opts.listed }),
    friendships: friendshipsMade, serversCreated: Object.values(servers).filter((s) => inYear(s.createdAt, year)).length,
    wordle: sum((r) => gameTotals(wordle[r.u.id], 'won')), contexto: sum((r) => gameTotals(contexto[r.u.id], 'won')), puzzle: sum((r) => gameTotals(puzzle[r.u.id], 'solved')),
    badges: tracked('badges'), longestCallMin: Math.round(rows.reduce((m, r) => Math.max(m, r.longest), 0) / 60),
  };
  return { global, users: out };
}

// ---------- files on the VM, outside the main database ----------
// <dir>/<year>/global.json and <dir>/<year>/users/<id>.json. global.json is written last, so its presence means the year is finished.
const yearDir = (dir, year) => path.join(dir, String(year));
function put(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}
function write(dir, year, built) {
  const base = yearDir(dir, year);
  fs.mkdirSync(path.join(base, 'users'), { recursive: true });
  for (const [id, r] of Object.entries(built.users)) if (SAFE_ID.test(id)) put(path.join(base, 'users', id + '.json'), r);
  put(path.join(base, 'global.json'), built.global);
}
function read(dir, year, uid) {
  if (uid !== undefined && !SAFE_ID.test(String(uid))) return null;
  try { return JSON.parse(fs.readFileSync(uid === undefined ? path.join(yearDir(dir, year), 'global.json') : path.join(yearDir(dir, year), 'users', uid + '.json'), 'utf8')); } catch { return null; }
}
// the newest finished year that is still worth showing: this one, or the one before
function latestYear(dir, at = Date.now()) {
  const y = yearOf(at);
  return [y, y - 1].find((x) => read(dir, x) !== null) || null;
}
// the year to build now: the one that just ended, during January to March, if its files are not there yet
function dueYear(dir, at = Date.now()) {
  const d = new Date(at), y = d.getUTCFullYear() - 1;
  return d.getUTCMonth() <= 2 && read(dir, y) === null ? y : null;
}
function forget(dir, uid) {
  if (!SAFE_ID.test(String(uid))) return;
  let years = [];
  try { years = fs.readdirSync(dir); } catch { return; }
  for (const y of years) { try { fs.unlinkSync(path.join(dir, y, 'users', uid + '.json')); } catch { /* not there */ } }
}

module.exports = { VOICE_TICK_MS, bump, atLeast, counter, createVoiceMeter, pickTop, pickTopN, topServers, percentiler, titleFor, buildAll, write, read, latestYear, dueYear, forget };
