// The yearly recap, turned into scenes. Pure: no React, no fetching (Recap.jsx plays what this returns).
// The server sends counts only (server/recap.js) and any number can be null, which means "was not counted", not zero.
// So a stat with no number, or a zero, is skipped and the next one in line takes its place.

export const TOTAL_MS = 30000; // the video and the song are both exactly this long
export const ENTER_MS = 450;   // a scene settles for a moment before its number starts to climb
export const COUNT_MS = 1500;  // 0 up to the value

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
    if (out.length === 3) break; // the main six come first, so a spare only shows up when there is room
  }
  return out;
}

function funMine(r, lang) {
  if (r.title) {
    const bits = [];
    if (Number.isInteger(r.favoriteHour)) bits.push(`Most active around ${fmtHour(r.favoriteHour)}.`);
    if (r.topEmoji) bits.push(`${r.topEmoji} was your most-used emoji.`);
    return { key: 'title', main: { text: r.title }, unit: 'Your title', sub: bits.join(' ') };
  }
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

// Messages, voice and credits keep their own corner. Any other stat that is filling in takes a corner that is still free,
// so the three stat scenes never sit in the same place.
function anchorStats(stats) {
  const free = ['tl', 'br', 'c'].filter((a) => !stats.some((s) => HOME[s.key] === a));
  return stats.map((s) => ({ ...s, anchor: HOME[s.key] || free.shift() }));
}

// kind is 'mine' or 'global'. Returns null when there is nothing to show.
// Where each scene sits: the intro in the middle, then the three stats top left, bottom right and middle, the fun one top right, the outro bottom left.
// A missing fun stat or a short list of stats just means fewer scenes; the 30 seconds are shared out evenly.
export function buildScenes(data, kind, lang = 'en') {
  if (!data || !data.year) return null;
  const rec = kind === 'mine' ? data.mine : data.global;
  if (!rec) return null;
  const year = data.year;
  const mine = kind === 'mine';

  const stats = mine ? pickStats(rec, MINE, MINE_SPARE, lang) : pickStats(rec, GLOBAL, GLOBAL_SPARE, lang);
  const fun = mine ? funMine(rec, lang) : funGlobal(rec, lang);
  if (!stats.length && !fun) return null;

  const intro = {
    key: 'intro',
    main: { text: mine ? `Your ${year} on Aduna` : `Aduna in ${year}` },
    sub: mine ? 'Here is how it went.' : ok(rec.users) ? `${fmtCount(rec.users, lang)} ${plural(rec.users, 'person', 'people')}, one year together.` : 'A year, together.',
  };
  const outro = { key: 'outro', main: { logo: true, year }, sub: `See you in ${year + 1}.` };

  const scenes = [
    { ...intro, anchor: 'c' },
    ...anchorStats(stats),
    ...(fun ? [{ ...fun, anchor: 'tr' }] : []),
    { ...outro, anchor: 'bl' },
  ];
  return scenes;
}

// What Share sends: the numbers and nothing else. It is only ever built when the person presses Share.
export function shareText(scenes, kind, year) {
  const lines = scenes.filter((s) => s.key !== 'intro' && s.key !== 'outro').map((s) => (s.main.count ? `${countText(s.main, 0, true)} ${s.unit}` : `${s.unit}: ${s.main.text}`));
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

const packMain = (m) => (m.logo ? 1 : typeof m.count === 'number' ? [m.count, m.prefix || '', m.suffix || ''] : String(m.text ?? ''));

export function recapToken(scenes, { kind, year, look, song }) {
  const l = look || DEFAULT_LOOK;
  const so = song && (song.id || song.url)
    ? { ...(song.id ? { i: String(song.id) } : {}), ...(song.url && String(song.url).length <= 300 ? { u: String(song.url) } : {}), t: String(song.title || '').slice(0, 60) }
    : null;
  const pack = (withSong, withSub) => 'recap:1:' + toB64(JSON.stringify({
    k: kind === 'mine' ? 'm' : 'g', y: year, c: l.colors.slice(0, 4), a: Math.round(l.angle) || 0,
    s: scenes.map((s) => [s.key, packMain(s.main), s.unit || '', withSub ? s.sub || '' : '', s.anchor]),
    ...(withSong && so ? { o: so } : {}),
  }));
  for (const [withSong, withSub] of [[true, true], [false, true], [false, false]]) {
    const t = pack(withSong, withSub);
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
  else if (Array.isArray(m) && Number.isFinite(m[0]) && m[0] >= 0 && m[0] < 1e13 && str(m[1], 8) !== null && str(m[2], 8) !== null) main = { count: m[0], prefix: m[1], suffix: m[2] };
  else return null;
  const u = str(unit, 60), s = str(sub, 160);
  if (u === null || s === null) return null;
  return { key, main, unit: u, sub: s, anchor };
}

// Anyone can post one of these, so everything is checked: colours, text lengths, the song link. Gives { kind, year, scenes, look, song } or null.
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
  let song = null;
  if (d.o && typeof d.o === 'object') {
    const id = typeof d.o.i === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(d.o.i) ? d.o.i : null;
    const url = typeof d.o.u === 'string' && /^https:\/\/\S{1,290}$/.test(d.o.u) ? d.o.u : null;
    if (id || url) song = { ...(id ? { id } : {}), ...(url ? { url } : {}), title: str(d.o.t, 60) || 'Song' };
  }
  return { kind: d.k === 'm' ? 'mine' : 'global', year: d.y, scenes, look, song };
}
