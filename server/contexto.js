'use strict';
// Contexto: a word of the day that is guessed by meaning. Pure: no Express, no database (tested by contexto-test.js).
//
// Every guess is ranked by how close its meaning is to the secret word: the secret word is No. 1, the closest word is No. 2, and so on
// through the whole vocabulary (30,000 common English words). A small number is a close guess. There is no limit on guesses.
// The word data (contexto-data/, built by contexto-build.js) is word vectors: closeness is the cosine similarity of two words' vectors.
//
// Like Wordle, every board has a `scope`: 'global' (Aduna's own word, played alone or shared into a DM) or a server id (that server's
// own word, with standings for its members). Everybody who plays a scope on the same day gets the same word, which differs between
// scopes and days. It comes from an HMAC with the server's secret, so nobody can work out tomorrow's word. The answer is only ever
// sent to a player once they have finished (found it, or given up).
//
// A player's record (store.db.contexto[userId]):
//   { boards: { [scope]: { day, guesses: [word], hinted: [word], status: 'playing' | 'won' | 'gaveup', finishedAt? } },
//     stats:  { [scope]: { played, won, streak, best, lastWonDay, lastDay, fewest } } }
// Only today's board is kept for each scope; the stats carry on. Ranks are not stored: they are worked out from the word.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'contexto-data');
const DAY_MS = 86400_000;
const EPOCH = Date.UTC(2026, 10, 6); // No. 1 was 6 November 2026 (days change at midnight UTC)
const MAX_GUESSES = 1000; // per board
const MAX_SCOPES = 60; // boards and stats kept per person (old servers are dropped first)
const GREEN = 300, ORANGE = 1500; // a rank up to 300 is close (green), up to 1500 is near (orange), anything else is far (red)
const CACHE = 24; // rankings kept in memory (one per answer in play: a ranking costs about 15 ms and 60 KB to make)

const dayOf = (ms) => Math.floor((ms - EPOCH) / DAY_MS) + 1;
const resetsAt = (day) => EPOCH + day * DAY_MS;
const isScope = (s) => typeof s === 'string' && (s === 'global' || /^[A-Za-z0-9_-]{1,64}$/.test(s));
const band = (rank) => (rank <= GREEN ? 'g' : rank <= ORANGE ? 'o' : 'r');

// ---- the word data, read once, the first time it is needed ----
let data = null; // { words, index, vecs, dim, answers } once loaded; false if the files are missing or damaged
function load() {
  if (data !== null) return data;
  try {
    const words = fs.readFileSync(path.join(DIR, 'words.txt'), 'utf8').split('\n').filter(Boolean);
    const buf = fs.readFileSync(path.join(DIR, 'vectors.bin'));
    const n = buf.readUInt32LE(0), dim = buf.readUInt32LE(4);
    if (n !== words.length || n > 65535 || buf.length !== 8 + n * dim) throw new Error('contexto-data does not match');
    const index = new Map(words.map((w, i) => [w, i]));
    const answers = fs.readFileSync(path.join(DIR, 'answers.txt'), 'utf8').split(/\s+/).filter((w) => index.has(w)); // one per line or separated by spaces
    if (!answers.length) throw new Error('no answers');
    data = { words, index, vecs: new Int8Array(buf.buffer, buf.byteOffset + 8, n * dim), dim, answers };
  } catch (e) { console.warn('Contexto data is not available (' + e.message + '): run "node server/contexto-build.js"'); data = false; }
  return data;
}
const ready = () => !!load();

// The rank of every word for one answer: rank[i] is the 1-based rank of words[i]; order[r - 1] is the index of the word at rank r.
const rankings = new Map();
function ranking(answer) {
  const hit = rankings.get(answer);
  if (hit) { rankings.delete(answer); rankings.set(answer, hit); return hit; }
  const d = load(), n = d.words.length, dim = d.dim, a = d.index.get(answer) * dim;
  const sims = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; const o = i * dim; for (let k = 0; k < dim; k++) s += d.vecs[o + k] * d.vecs[a + k]; sims[i] = s; }
  sims[d.index.get(answer)] = Infinity; // the answer is always No. 1
  const order = Uint16Array.from({ length: n }, (_, i) => i).sort((x, y) => sims[y] - sims[x] || x - y);
  const rank = new Uint16Array(n);
  for (let r = 0; r < n; r++) rank[order[r]] = r + 1;
  const out = { rank, order };
  rankings.set(answer, out);
  if (rankings.size > CACHE) rankings.delete(rankings.keys().next().value);
  return out;
}
const rankOf = (answer, word) => { const i = load().index.get(word); return i === undefined ? 0 : ranking(answer).rank[i]; };
const wordAt = (answer, rank) => load().words[ranking(answer).order[rank - 1]];

function answerFor(scope, day, secret) {
  const d = load(); if (!d) return null;
  const h = crypto.createHmac('sha256', String(secret)).update('contexto:' + scope + ':' + day).digest();
  return d.answers[h.readUInt32BE(0) % d.answers.length];
}

const normalize = (raw) => (typeof raw === 'string' && /^[A-Za-z]{2,14}$/.test(raw.trim()) ? raw.trim().toLowerCase() : null);
const isWord = (w) => !!w && load().index.has(w);

const blank = () => ({ boards: Object.create(null), stats: Object.create(null) });
const blankStats = () => ({ played: 0, won: 0, streak: 0, best: 0, lastWonDay: 0, lastDay: 0, fewest: 0 });

// today's board for a scope: a new one when the day has changed
function boardOf(rec, scope, day) {
  let b = rec.boards[scope];
  if (!b || b.day !== day) { b = { day, guesses: [], hinted: [], status: 'playing' }; rec.boards[scope] = b; prune(rec); }
  return b;
}
function prune(rec) {
  const keys = Object.keys(rec.boards);
  if (keys.length <= MAX_SCOPES) return;
  keys.sort((a, b) => (rec.boards[a].day || 0) - (rec.boards[b].day || 0));
  for (const k of keys.slice(0, keys.length - MAX_SCOPES)) { delete rec.boards[k]; delete rec.stats[k]; }
}

function finish(rec, scope, b, day, now) {
  const s = rec.stats[scope] || (rec.stats[scope] = blankStats());
  s.played++; s.lastDay = day;
  if (b.status === 'won') {
    s.won++;
    s.streak = s.lastWonDay === day - 1 ? s.streak + 1 : 1;
    s.lastWonDay = day;
    s.best = Math.max(s.best, s.streak);
    s.fewest = s.fewest ? Math.min(s.fewest, b.guesses.length) : b.guesses.length;
  } else s.streak = 0;
  b.finishedAt = now;
}

const finished = (b) => b.status !== 'playing';
const THIS_DAY_DONE = { error: 'You have already finished today’s word' };

// One guess. Returns { error } or { ok: true, word, repeat? } (the board changed in place unless it was a repeat).
function play(rec, scope, day, answer, raw, now = Date.now()) {
  const b = boardOf(rec, scope, day);
  if (finished(b)) return THIS_DAY_DONE;
  const w = normalize(raw);
  if (!w) return { error: 'Enter a single word' };
  if (!isWord(w)) return { error: 'That word isn’t in Contexto’s list' };
  if (b.guesses.includes(w)) return { ok: true, word: w, repeat: true };
  if (b.guesses.length >= MAX_GUESSES) return { error: 'That is a lot of guesses. Use a hint or give up' };
  b.guesses.push(w);
  if (w === answer) b.status = 'won';
  if (finished(b)) finish(rec, scope, b, day, now);
  return { ok: true, word: w };
}

// A hint: a word that is closer than your best guess so far (about half way there). It counts as a guess.
function hint(rec, scope, day, answer, now = Date.now()) {
  const b = boardOf(rec, scope, day);
  if (finished(b)) return THIS_DAY_DONE;
  if (b.guesses.length >= MAX_GUESSES) return { error: 'That is a lot of guesses. Give up to see the word' };
  const best = b.guesses.reduce((m, g) => Math.min(m, rankOf(answer, g)), ORANGE + 500); // with no guess yet, a word in the orange
  if (best <= 2) return { error: 'You are right next to it. No hint can be closer' };
  const have = new Set(b.guesses), start = Math.max(2, Math.floor(best / 2));
  let pick = null;
  for (let r = start; r < best && !pick; r++) { const w = wordAt(answer, r); if (!have.has(w)) pick = w; }
  for (let r = start - 1; r >= 2 && !pick; r--) { const w = wordAt(answer, r); if (!have.has(w)) pick = w; }
  if (!pick) return { error: 'No hint is available' };
  b.guesses.push(pick); b.hinted.push(pick);
  return { ok: true, word: pick, hint: true };
}

function giveUp(rec, scope, day, answer, now = Date.now()) {
  const b = boardOf(rec, scope, day);
  if (finished(b)) return THIS_DAY_DONE;
  b.status = 'gaveup';
  finish(rec, scope, b, day, now);
  return { ok: true };
}

// What the player may see. The answer, and the words closest to it, are included only once they are done.
function view(rec, scope, day, answer) {
  const b = rec.boards[scope] && rec.boards[scope].day === day ? rec.boards[scope] : { day, guesses: [], hinted: [], status: 'playing' };
  const s = rec.stats[scope] || blankStats();
  const live = s.lastWonDay >= day - 1 && b.status !== 'gaveup'; // a streak survives until a day is missed
  const rows = b.guesses.map((w) => ({ word: w, rank: rankOf(answer, w), ...(b.hinted.includes(w) ? { hint: true } : {}) }));
  const done = finished(b);
  return {
    scope, day, resetsAt: resetsAt(day), status: b.status, tries: b.guesses.length, hints: b.hinted.length, rows,
    ...(done ? { answer, closest: Array.from({ length: 30 }, (_, i) => wordAt(answer, i + 1)) } : {}),
    stats: { played: s.played, won: s.won, streak: live ? s.streak : 0, best: s.best, fewest: s.fewest },
  };
}

// Who finished today in a server: those who found it first (fewest guesses, then earliest), then those who gave up.
function standings(records, scope, day, memberIds, limit = 10) {
  const rows = [];
  for (const id of memberIds) {
    const b = records[id] && records[id].boards && records[id].boards[scope];
    if (b && b.day === day && finished(b)) {
      const s = records[id].stats && records[id].stats[scope];
      rows.push({ userId: id, status: b.status, tries: b.guesses.length, at: b.finishedAt || 0, streak: b.status === 'won' && s ? s.streak : 0 });
    }
  }
  rows.sort((a, b) => (a.status === b.status ? a.tries - b.tries || a.at - b.at : a.status === 'won' ? -1 : 1));
  return { finished: rows.length, members: memberIds.length, rows: rows.slice(0, limit).map(({ userId, status, tries, streak }) => ({ userId, status, tries, streak })) };
}

module.exports = { EPOCH, GREEN, ORANGE, dayOf, resetsAt, isScope, band, ready, normalize, isWord, answerFor, rankOf, wordAt, blank, boardOf, play, hint, giveUp, view, standings };
