'use strict';
// Wordle: one five-letter word a day. Pure: no Express, no database (tested by wordle-test.js).
//
// Every board has a `scope`: 'global' (Aduna's own word, played alone or shared into a DM or group) or a server id (that server's
// own word, with standings for its members). Everybody who plays a scope on the same day gets the same word, and the word differs
// between scopes and between days. It comes from an HMAC with the server's secret, so nobody can work out tomorrow's word.
// The answer is only ever sent to a player once they have finished (won, or used all six tries).
//
// A player's record (store.db.wordle[userId]):
//   { boards: { [scope]: { day, guesses: [word], status: 'playing' | 'won' | 'lost', finishedAt? } },
//     stats:  { [scope]: { played, won, streak, best, lastWonDay, lastDay, dist: [n x 6] } } }
// Only today's board is kept for each scope; the stats carry on.

const crypto = require('crypto');
const ANSWERS = require('./wordle-answers');

const DAY_MS = 86400_000;
const EPOCH = Date.UTC(2026, 9, 1); // No. 1 was 1 October 2026 (days change at midnight UTC)
const TRIES = 6;
const LEN = 5;
const MAX_SCOPES = 60; // boards and stats kept per person (old servers are dropped first)

const dayOf = (ms) => Math.floor((ms - EPOCH) / DAY_MS) + 1;
const resetsAt = (day) => EPOCH + day * DAY_MS;
const isScope = (s) => typeof s === 'string' && (s === 'global' || /^[A-Za-z0-9_-]{1,64}$/.test(s));

// The words a guess may be: every answer, plus the English words of five letters from the dictionary package. If that package is
// not installed the game still works, and any five letters count.
let valid = null, loose = false;
function words() {
  if (valid) return valid;
  valid = new Set(ANSWERS);
  try { for (const w of require('an-array-of-english-words')) if (w.length === LEN && /^[a-z]+$/.test(w)) valid.add(w); } catch { loose = true; }
  return valid;
}
const normalize = (raw) => (typeof raw === 'string' && /^[A-Za-z]{5}$/.test(raw.trim()) ? raw.trim().toLowerCase() : null);
const isWord = (w) => !!w && (words().has(w) || loose);

function answerFor(scope, day, secret) {
  const h = crypto.createHmac('sha256', String(secret)).update('wordle:' + scope + ':' + day).digest();
  return ANSWERS[h.readUInt32BE(0) % ANSWERS.length];
}

// 'g' right letter in the right place, 'y' right letter elsewhere, 'x' not in the word (repeated letters are counted like the real game)
function score(guess, answer) {
  const out = Array(LEN).fill('x'), left = {};
  for (let i = 0; i < LEN; i++) { if (guess[i] === answer[i]) out[i] = 'g'; else left[answer[i]] = (left[answer[i]] || 0) + 1; }
  for (let i = 0; i < LEN; i++) if (out[i] === 'x' && left[guess[i]] > 0) { out[i] = 'y'; left[guess[i]]--; }
  return out.join('');
}

const blank = () => ({ boards: Object.create(null), stats: Object.create(null) });
const blankStats = () => ({ played: 0, won: 0, streak: 0, best: 0, lastWonDay: 0, lastDay: 0, dist: Array(TRIES).fill(0) });

// today's board for a scope: a new one when the day has changed
function boardOf(rec, scope, day) {
  let b = rec.boards[scope];
  if (!b || b.day !== day) { b = { day, guesses: [], status: 'playing' }; rec.boards[scope] = b; prune(rec); }
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
    s.dist[b.guesses.length - 1]++;
  } else s.streak = 0;
  b.finishedAt = now;
}

// One guess. Returns { error } or { ok: true } (the board changed in place).
function play(rec, scope, day, answer, raw, now = Date.now()) {
  const b = boardOf(rec, scope, day);
  if (b.status !== 'playing') return { error: 'You have already finished today’s word' };
  const w = normalize(raw);
  if (!w) return { error: 'Enter a five-letter word' };
  if (!isWord(w)) return { error: 'That isn’t in the word list' };
  b.guesses.push(w);
  if (w === answer) b.status = 'won'; else if (b.guesses.length >= TRIES) b.status = 'lost';
  if (b.status !== 'playing') finish(rec, scope, b, day, now);
  return { ok: true };
}

// What the player may see. The answer is included only once they are done.
function view(rec, scope, day, answer) {
  const b = rec.boards[scope] && rec.boards[scope].day === day ? rec.boards[scope] : { day, guesses: [], status: 'playing' };
  const s = rec.stats[scope] || blankStats();
  const live = s.lastWonDay >= day - 1 && b.status !== 'lost'; // a streak survives until a day is missed
  return {
    scope, day, resetsAt: resetsAt(day), status: b.status, tries: b.guesses.length,
    rows: b.guesses.map((g) => ({ word: g, marks: score(g, answer) })),
    ...(b.status !== 'playing' ? { answer } : {}),
    stats: { played: s.played, won: s.won, streak: live ? s.streak : 0, best: s.best, dist: s.dist.slice() },
  };
}

// Who finished today in a server: winners first (fewest tries, then earliest), then those who missed it.
function standings(records, scope, day, memberIds, limit = 10) {
  const rows = [];
  for (const id of memberIds) {
    const b = records[id] && records[id].boards && records[id].boards[scope];
    if (b && b.day === day && b.status !== 'playing') {
      const s = records[id].stats && records[id].stats[scope];
      rows.push({ userId: id, status: b.status, tries: b.guesses.length, at: b.finishedAt || 0, streak: b.status === 'won' && s ? s.streak : 0 });
    }
  }
  rows.sort((a, b) => (a.status === b.status ? a.tries - b.tries || a.at - b.at : a.status === 'won' ? -1 : 1));
  return { finished: rows.length, members: memberIds.length, rows: rows.slice(0, limit).map(({ userId, status, tries, streak }) => ({ userId, status, tries, streak })) };
}

module.exports = { ANSWERS, TRIES, LEN, EPOCH, dayOf, resetsAt, isScope, normalize, isWord, answerFor, score, blank, boardOf, play, view, standings };
