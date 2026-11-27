// The yearly recap, turned into scenes. Pure: no React, no fetching (Recap.jsx plays what this returns).
// The server sends counts only (server/recap.js) and any number can be null, which means "was not counted", not zero.
// So a stat with no number, or a zero, is skipped and the next one in line takes its place.

export const TOTAL_MS = 30000; // the video and the song are both exactly this long
export const ENTER_MS = 450;   // a scene settles for a moment before its number starts to climb
export const COUNT_MS = 1500;  // 0 up to the value
const MAX_STATS = 4;           // number scenes between the intro and the rest

const ok = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const plural = (n, one, many) => (n === 1 ? one : many);

export function fmtCount(n, lang = 'en') {
  try {
    // past ten million the digits stop fitting on a phone, so they get a K/M/B
    return new Intl.NumberFormat(lang, n >= 1e7 ? { notation: 'compact', maximumFractionDigits: 1 } : {}).format(n);
  } catch { return String(n); }
}
export function fmtMinutes(m) {
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
// The server counts days and hours in UTC, and the title (Night Owl and so on) comes from the same UTC hour, so the hour is shown as UTC too.
// Turning it into local time would sometimes make "Night Owl" sit next to 3 PM.
const fmtHour = (h) => String(h).padStart(2, '0') + ':00 UTC';
export function fmtDay(iso, lang = 'en') {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  try { return d.toLocaleDateString(lang, { month: 'long', day: 'numeric', timeZone: 'UTC' }); } catch { return null; }
}

// What a count looks like at a given moment of its scene. Shared by the player and the tests of it.
export function countText(main, localMs, still = false) {
  const k = still ? 1 : Math.max(0, Math.min(1, (localMs - ENTER_MS) / COUNT_MS));
  const eased = 1 - (1 - k) ** 3; // fast at first, settles at the end
  return (main.prefix || '') + fmtCount(Math.round(main.count * eased), main.lang) + (main.suffix || '');
}

// [one, many] units and a line for the opposite edge of the frame.
const MINE = [
  { key: 'messages', get: (r) => r.messages, unit: ['message sent', 'messages sent'], sub: (r, l) => (ok(r.files) ? `plus ${fmtCount(r.files, l)} ${plural(r.files, 'file', 'files')} shared.` : 'Every conversation counts.') },
  { key: 'voice', get: (r) => r.vcHours, unit: ['hour in voice', 'hours in voice'], sub: (r) => (ok(r.longestCallMin) ? `Your longest call ran ${fmtMinutes(r.longestCallMin)}.` : 'Talking beats typing.') },
  { key: 'credits', get: (r) => r.credits, unit: ['credit earned', 'credits earned'], sub: () => 'Only the ones you earned.' },
  { key: 'quests', get: (r) => r.quests, unit: ['quest finished', 'quests finished'], sub: () => 'One quest at a time.' },
  { key: 'friends', get: (r) => r.friends, unit: ['friend made', 'friends made'], sub: () => 'New people to talk to.' },
  { key: 'badges', get: (r) => r.badges, unit: ['badge earned', 'badges earned'], sub: (r, l) => (ok(r.badgesHeld) ? `${fmtCount(r.badgesHeld, l)} in your collection now.` : 'Added to your collection.') },
];
// Only used when fewer than three of the stats above exist, so the video still fills its 30 seconds.
const MINE_SPARE = [
  { key: 'held', get: (r) => r.badgesHeld, unit: ['badge in your collection', 'badges in your collection'], sub: () => 'Every one is yours.' },
  { key: 'files', get: (r) => r.files, unit: ['file shared', 'files shared'], sub: () => 'Sent along the way.' },
  { key: 'games', get: (r) => (r.wordle || 0) + (r.contexto || 0) + (r.puzzle || 0), unit: ['game won', 'games won'], sub: () => 'Wordle, Contexto and puzzles.' },
];

const GLOBAL = [
  { key: 'messages', get: (g) => g.messages, unit: ['message sent', 'messages sent'], sub: () => 'By everyone on Aduna.' },
  { key: 'voice', get: (g) => g.vcHours, unit: ['hour in voice', 'hours in voice'], sub: (g) => (ok(g.longestCallMin) ? `The longest call ran ${fmtMinutes(g.longestCallMin)}.` : 'All of it spent talking.') },
  { key: 'credits', get: (g) => g.credits, unit: ['credit earned', 'credits earned'], sub: () => 'Earned across Aduna.' },
  { key: 'quests', get: (g) => g.quests, unit: ['quest finished', 'quests finished'], sub: () => 'Finished across Aduna.' },
  { key: 'friends', get: (g) => g.friendships, unit: ['friendship made', 'friendships made'], sub: () => 'New friends, all year.' },
  { key: 'badges', get: (g) => g.badges, unit: ['badge earned', 'badges earned'], sub: () => 'Collected across Aduna.' },
];
const GLOBAL_SPARE = [
  { key: 'joined', get: (g) => g.joinedThisYear, unit: ['person joined', 'people joined'], sub: () => 'Welcome, all of you.' },
  { key: 'servers', get: (g) => g.serversCreated, unit: ['server created', 'servers created'], sub: () => 'Each one a new room.' },
  { key: 'files', get: (g) => g.files, unit: ['file shared', 'files shared'], sub: () => 'Sent along the way.' },
  { key: 'games', get: (g) => (g.wordle || 0) + (g.contexto || 0) + (g.puzzle || 0), unit: ['game won', 'games won'], sub: () => 'Wordle, Contexto and puzzles.' },
];

function pickStats(rec, list, spare, lang) {
  const out = [];
  for (const s of [...list, ...spare]) {
    const v = s.get(rec);
    if (!ok(v)) continue;
    out.push({ key: s.key, main: { count: v, lang }, unit: plural(v, ...s.unit), sub: s.sub(rec, lang) });
    if (out.length === MAX_STATS) break; // the main six come first, so a spare only shows up when there is room
  }
  return out;
}

function funMine(r, lang) {
  const tp = r.topPercent || {};
  const vc = ok(tp.vc) ? tp.vc : null, msg = ok(tp.messages) ? tp.messages : null;
  if (vc !== null || msg !== null) {
    const byVoice = msg === null || (vc !== null && vc <= msg); // show whichever is the better rank
    return { key: 'top', main: { prefix: 'Top ', count: byVoice ? vc : msg, suffix: '%', lang }, unit: byVoice ? 'for time in voice' : 'for messages sent', sub: 'Counted against everyone on Aduna.' };
  }
  const day = fmtDay(r.busiestDay, lang);
  if (day) return { key: 'day', main: { text: day }, unit: 'Your busiest day', sub: r.topEmoji ? `${r.topEmoji} was your most-used emoji.` : '' };
  if (r.topEmoji) return { key: 'emoji', main: { text: r.topEmoji }, unit: 'Your most-used emoji', sub: '' };
  if (ok(r.longestCallMin)) return { key: 'call', main: { text: fmtMinutes(r.longestCallMin) }, unit: 'Your longest call', sub: '' };
  return null;
}

function funGlobal(g, lang) {
  const day = fmtDay(g.busiestDay, lang);
  if (day) {
    const sub = g.topEmoji ? `${g.topEmoji} was the most-used emoji.` : Number.isInteger(g.busiestHour) ? `The busiest hour was ${fmtHour(g.busiestHour)}.` : '';
    return { key: 'day', main: { text: day }, unit: 'Busiest day', sub };
  }
  if (g.topEmoji) return { key: 'emoji', main: { text: g.topEmoji }, unit: 'Most-used emoji', sub: '' };
  return null;
}

const HOME = { messages: 'tl', voice: 'br', credits: 'c' };
const SPOTS = ['tl', 'br', 'c', 'bl'];

// Messages, voice and credits keep their own corner. Any other stat that is filling in takes a spot that is still free,
// so the stat scenes never sit in the same place.
function anchorStats(stats) {
  const free = SPOTS.filter((a) => !stats.some((s) => HOME[s.key] === a));
  return stats.map((s) => ({ ...s, anchor: HOME[s.key] || free.shift() }));
}

// The three public servers that took in the most people, as one list scene. Nothing when the server sent none.
function serversScene(g) {
  const list = (Array.isArray(g.topServers) ? g.topServers : [])
    .filter((s) => s && typeof s.name === 'string' && s.name && ok(s.gained))
    .slice(0, 3)
    .map((s) => ({ name: s.name.slice(0, 32), count: s.gained }));
  if (!list.length) return null;
  return { key: 'servers', main: { list }, unit: 'Fastest growing servers', sub: 'New people on public servers, not counting the Aduna server.' };
}

// kind is 'mine' or 'global'. Returns null when there is nothing to show.
// Where each scene sits: the intro in the middle, then up to four stats (messages top left, voice bottom right, credits in the middle, a fourth bottom left),
// the servers list (global only) in the middle, the fun one top right, the outro bottom left.
// A missing fun stat or a short list of stats just means fewer scenes; the 30 seconds are shared out by timeline().
export function buildScenes(data, kind, lang = 'en') {
  if (!data || !data.year) return null;
  const rec = kind === 'mine' ? data.mine : data.global;
  if (!rec) return null;
  const year = data.year;
  const mine = kind === 'mine';

  const stats = mine ? pickStats(rec, MINE, MINE_SPARE, lang) : pickStats(rec, GLOBAL, GLOBAL_SPARE, lang);
  const servers = mine ? null : serversScene(rec);
  if (servers) servers.main.lang = lang;
  const fun = mine ? funMine(rec, lang) : funGlobal(rec, lang);
  if (!stats.length && !fun && !servers) return null;

  const intro = {
    key: 'intro',
    main: { text: mine ? `Your ${year} on Aduna` : `Aduna in ${year}` },
    sub: mine ? 'Here is how it went.' : ok(rec.users) ? `${fmtCount(rec.users, lang)} ${plural(rec.users, 'person', 'people')}, one year together.` : 'A year, together.',
  };
  const outro = { key: 'outro', main: { logo: true, year }, sub: `See you in ${year + 1}.` };

  const anchored = anchorStats(stats);
  const lastSpot = anchored.length ? anchored[anchored.length - 1].anchor : null;
  const scenes = [
    { ...intro, anchor: 'c' },
    ...anchored,
    ...(servers ? [{ ...servers, anchor: lastSpot === 'c' ? 'tl' : 'c' }] : []),
    ...(fun ? [{ ...fun, anchor: 'tr' }] : []),
    { ...outro, anchor: !fun && !servers && lastSpot === 'bl' ? 'tr' : 'bl' },
  ];
  return scenes;
}

// Scenes are not all the same length: the intro and the outro are short, the servers list gets the longest.
// A scene is looked up by its key, so a recap shared in a chat plays the same way.
const WEIGHT = { intro: 0.8, outro: 0.8, servers: 1.6 };
export function timeline(scenes) {
  const w = scenes.map((s) => WEIGHT[s.key] || 1), all = w.reduce((a, b) => a + b, 0);
  let at = 0;
  return w.map((x, i) => {
    const from = at;
    at = i === w.length - 1 ? TOTAL_MS : at + (x / all) * TOTAL_MS;
    return { from, to: at };
  });
}
export function sceneAt(tl, t) {
  const i = tl.findIndex((x) => t < x.to);
  return i < 0 ? tl.length - 1 : i;
}

// When each song is heard. One song runs the whole video (and loops if it is shorter). Two share it and cross over in the middle.
export const XFADE_MS = 3000;
export function songWindows(count) {
  if (count < 2) return [{ from: 0, to: TOTAL_MS }];
  const mid = TOTAL_MS / 2;
  return [{ from: 0, to: mid + XFADE_MS / 2 }, { from: mid - XFADE_MS / 2, to: TOTAL_MS }];
}
// 0 to 1. The ends that meet the start or the end of the video are left to the fade in and out of the whole video.
export function songGain(win, t) {
  if (t < win.from || t > win.to) return 0;
  const up = win.from > 0 ? (t - win.from) / XFADE_MS : 1;
  const down = win.to < TOTAL_MS ? (win.to - t) / XFADE_MS : 1;
  return Math.max(0, Math.min(1, up, down));
}

// What Share sends: the numbers and nothing else. It is only ever built when the person presses Share.
export function shareText(scenes, kind, year) {
  const line = (s) => {
    if (s.main.list) return `${s.unit}: ${s.main.list.map((i) => `${i.name} (+${fmtCount(i.count, s.main.lang)})`).join(', ')}`;
    return s.main.count ? `${countText(s.main, 0, true)} ${s.unit}` : `${s.unit}: ${s.main.text}`;
  };
  const lines = scenes.filter((s) => s.key !== 'intro' && s.key !== 'outro').map(line);
  const head = kind === 'mine' ? `My ${year} on Aduna` : `Aduna in ${year}`;
  return [head, ...lines.map((l) => '• ' + l)].join('\n');
}

export const DEFAULT_LOOK = { colors: ['#1c1812', '#3b342a', '#c9953a'], angle: 135 };

// The same scenes for someone else to watch: "Your 2026 on Aduna" becomes "Sam's 2026 on Aduna".
export function inThird(scenes, name) {
  const who = String(name || '').trim().slice(0, 24) || 'Someone';
  const fix = (s) => (typeof s === 'string'
    ? s.replace(/\bYour\b/g, who + "'s").replace(/\byours\b/g, 'theirs').replace(/\byour\b/g, 'their').replace(/\byou earned\b/g, 'they earned')
    : s);
  return scenes.map((s) => ({ ...s, main: typeof s.main.text === 'string' ? { ...s.main, text: fix(s.main.text) } : s.main, unit: fix(s.unit), sub: fix(s.sub) }));
}

// Share in a chat sends the video as one message, recap:1:<scenes as base64url JSON>. The chat draws it as a card with a play button and plays it
// there, so nothing is rendered or stored on the server and DMs stay end-to-end encrypted. A server channel keeps 2000 characters of a message,
// so the token drops the song and then the small print until it fits under SHARE_MAX.
const SHARE_RE = /^recap:1:([A-Za-z0-9_-]{20,3600})$/;
const ANCHORS = ['c', 'tl', 'tr', 'bl', 'br'];
export const SHARE_MAX = 1800;
export const isRecapToken = (content) => typeof content === 'string' && content.startsWith('recap:1:');

const toB64 = (s) => {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64 = (t) => new TextDecoder().decode(Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

const packMain = (m) => (m.logo ? 1 : m.list ? m.list.map((i) => [i.name, i.count]) : typeof m.count === 'number' ? [m.count, m.prefix || '', m.suffix || ''] : String(m.text ?? ''));

export function recapToken(scenes, { kind, year, look, songs }) {
  const l = look || DEFAULT_LOOK;
  const so = (songs || []).filter((s) => s && (s.id || s.url)).slice(0, 2)
    .map((s) => ({ ...(s.id ? { i: String(s.id) } : {}), ...(s.url && String(s.url).length <= 300 ? { u: String(s.url) } : {}), t: String(s.title || '').slice(0, 60) }));
  const pack = (withSongs, withSub) => 'recap:1:' + toB64(JSON.stringify({
    k: kind === 'mine' ? 'm' : 'g', y: year, c: l.colors.slice(0, 4), a: Math.round(l.angle) || 0,
    s: scenes.map((s) => [s.key, packMain(s.main), s.unit || '', withSub ? s.sub || '' : '', s.anchor]),
    ...(withSongs > 0 ? { o: withSongs === 1 ? so[0] : so.slice(0, withSongs) } : {}),
  }));
  const tries = [];
  for (let n = so.length; n >= 0; n--) tries.push([n, true]);
  tries.push([0, false]);
  for (const [withSongs, withSub] of tries) {
    const t = pack(withSongs, withSub);
    if (t.length <= SHARE_MAX) return t;
  }
  return null;
}

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
function unpackScene(r) {
  if (!Array.isArray(r) || r.length !== 5) return null;
  const [key, m, unit, sub, anchor] = r;
  if (typeof key !== 'string' || !/^[a-z]{1,16}$/.test(key) || !ANCHORS.includes(anchor)) return null;
  let main;
  if (m === 1) main = { logo: true };
  else if (typeof m === 'string' && m.length <= 60) main = { text: m };
  else if (Array.isArray(m) && m.length >= 1 && m.length <= 3 && m.every((p) => Array.isArray(p) && !!str(p[0], 40) && Number.isFinite(p[1]) && p[1] >= 0 && p[1] < 1e9)) main = { list: m.map((p) => ({ name: p[0], count: p[1] })) };
  else if (Array.isArray(m) && Number.isFinite(m[0]) && m[0] >= 0 && m[0] < 1e13 && str(m[1], 8) !== null && str(m[2], 8) !== null) main = { count: m[0], prefix: m[1], suffix: m[2] };
  else return null;
  const u = str(unit, 60), s = str(sub, 160);
  if (u === null || s === null) return null;
  return { key, main, unit: u, sub: s, anchor };
}

// Anyone can post one of these, so everything is checked: colours, text lengths, the song links. Gives { kind, year, scenes, look, songs } or null.
export function parseRecapShare(content) {
  const m = SHARE_RE.exec(String(content || '').trim());
  if (!m) return null;
  let d;
  try { d = JSON.parse(fromB64(m[1])); } catch { return null; }
  if (!d || (d.k !== 'm' && d.k !== 'g') || !Number.isInteger(d.y) || d.y < 2000 || d.y > 2200 || !Array.isArray(d.s) || d.s.length < 2 || d.s.length > 10) return null;
  const scenes = d.s.map(unpackScene);
  if (scenes.some((s) => !s)) return null;
  const colors = Array.isArray(d.c) ? d.c.filter((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)).slice(0, 4) : [];
  const look = colors.length >= 2 ? { colors, angle: Number.isFinite(d.a) && d.a >= 0 && d.a <= 360 ? d.a : 135 } : null;
  const songs = (Array.isArray(d.o) ? d.o : d.o ? [d.o] : []).slice(0, 2).map(unpackSong).filter(Boolean); // one song is an object, two are a list
  return { kind: d.k === 'm' ? 'mine' : 'global', year: d.y, scenes, look, songs };
}
function unpackSong(o) {
  if (!o || typeof o !== 'object') return null;
  const id = typeof o.i === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(o.i) ? o.i : null;
  const url = typeof o.u === 'string' && /^https:\/\/\S{1,290}$/.test(o.u) ? o.u : null;
  return id || url ? { ...(id ? { id } : {}), ...(url ? { url } : {}), title: str(o.t, 60) || 'Song' } : null;
}
