'use strict';
// Daily chess puzzle: a forced checkmate in 1, 2 or 3 moves. Pure: no Express, no database (tested by puzzle-test.js).
//
// Every board has a `scope`, like Wordle: 'global' (Aduna's own puzzle, played alone or shared into a chat) or a server id (that
// server's own puzzle, with standings for its members). Everybody who plays a scope on the same day gets the same puzzle, and it
// differs between scopes and days. It is picked with an HMAC of the server's secret, so nobody can work out tomorrow's puzzle.
// The difficulty follows the day of the week: Monday and Tuesday are mate in 1, Wednesday to Friday mate in 2, the weekend mate in 3.
//
// The browser never decides anything: it sends a move, and this checks it with the chess rules in chess.js. A move is right when it is legal
// and the mate can still be forced after it (mate.js), so any correct way to mate is accepted, not only the one in the book. The opponent's
// replies are chosen here too. The solution is only sent once the player has finished (solved it, or used up three wrong moves).
//
// A player's record (store.db.puzzle[userId]):
//   { boards: { [scope]: { day, moves: [uci], wrong, status: 'playing' | 'solved' | 'failed', finishedAt? } },
//     stats:  { [scope]: { played, solved, streak, best, lastWonDay, lastDay, dist: [solved with 0, 1, 2 wrong moves] } } }
// `moves` holds the moves played so far, the player's and the opponent's replies, in order. Only today's board is kept for each scope.

const crypto = require('crypto');
const C = require('./chess');
const M = require('./mate');
const BANK = require('./puzzle-bank');

const DAY_MS = 86400_000;
const EPOCH = Date.UTC(2026, 9, 1); // No. 1 was 1 October 2026 (days change at midnight UTC), the same numbering as Wordle
const MAX_WRONG = 3;
const MAX_SCOPES = 60;

const dayOf = (ms) => Math.floor((ms - EPOCH) / DAY_MS) + 1;
const resetsAt = (day) => EPOCH + day * DAY_MS;
const isScope = (s) => typeof s === 'string' && (s === 'global' || /^[A-Za-z0-9_-]{1,64}$/.test(s));
const LABEL = { 1: 'Mate in 1', 2: 'Mate in 2', 3: 'Mate in 3' };

// the mate depth for a day: Monday and Tuesday 1, Wednesday to Friday 2, Saturday and Sunday 3
function depthFor(day) {
  const wd = new Date(EPOCH + (day - 1) * DAY_MS).getUTCDay(); // 0 = Sunday
  return wd === 1 || wd === 2 ? 1 : wd >= 3 && wd <= 5 ? 2 : 3;
}
function puzzleFor(scope, day, secret) {
  const n = depthFor(day), list = BANK[n];
  const h = crypto.createHmac('sha256', String(secret)).update('puzzle:' + scope + ':' + day).digest();
  return { n, fen: list[h.readUInt32BE(0) % list.length] };
}

const blank = () => ({ boards: Object.create(null), stats: Object.create(null) });
const blankStats = () => ({ played: 0, solved: 0, streak: 0, best: 0, lastWonDay: 0, lastDay: 0, dist: Array(MAX_WRONG).fill(0) });

function boardOf(rec, scope, day) {
  let b = rec.boards[scope];
  if (!b || b.day !== day) { b = { day, moves: [], wrong: 0, status: 'playing' }; rec.boards[scope] = b; prune(rec); }
  return b;
}
function prune(rec) {
  const keys = Object.keys(rec.boards);
  if (keys.length <= MAX_SCOPES) return;
  keys.sort((a, b) => (rec.boards[a].day || 0) - (rec.boards[b].day || 0));
  for (const k of keys.slice(0, keys.length - MAX_SCOPES)) { delete rec.boards[k]; delete rec.stats[k]; }
}

// the position after the moves played so far
function positionOf(puzzle, moves) {
  let p = C.parseFen(puzzle.fen);
  for (const u of moves) { const m = C.findUci(p, u); if (!m) throw new Error('bad move in record: ' + u); p = C.make(p, m); }
  return p;
}
const solverMoves = (moves) => Math.ceil(moves.length / 2); // the opponent's reply follows each of the player's moves at once, so this is the count made so far

// The opponent's reply: of the moves that still lose, the one that leaves the fewest ways to finish the job (ties: lowest move name).
function chooseReply(q, remaining) {
  const replies = C.legal(q);
  if (!replies.length) return null;
  let best = null;
  for (const r of replies) {
    const after = C.make(q, r);
    const ways = M.firstMoves(after, remaining).length;
    if (ways === 0) continue; // a reply that escapes cannot happen once the player's move was correct
    const key = [ways, C.uci(r)];
    if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && key[1] < best.key[1])) best = { key, move: r };
  }
  return best ? best.move : replies[0];
}

function finish(rec, scope, b, day, now) {
  const s = rec.stats[scope] || (rec.stats[scope] = blankStats());
  s.played++; s.lastDay = day;
  if (b.status === 'solved') {
    s.solved++;
    s.streak = s.lastWonDay === day - 1 ? s.streak + 1 : 1;
    s.lastWonDay = day;
    s.best = Math.max(s.best, s.streak);
    s.dist[Math.min(b.wrong, MAX_WRONG - 1)]++;
  } else s.streak = 0;
  b.finishedAt = now;
}

// One move. Returns { error } or { ok: true, wrong? } (the board changed in place).
function play(rec, scope, day, puzzle, raw, now = Date.now()) {
  const b = boardOf(rec, scope, day);
  if (b.status !== 'playing') return { error: 'You have already finished today’s puzzle' };
  const p = positionOf(puzzle, b.moves);
  const m = C.findUci(p, String(raw || '').trim().toLowerCase());
  if (!m) return { error: 'That is not a legal move' };
  const remaining = puzzle.n - solverMoves(b.moves);
  const q = C.make(p, m);
  if (!M.movePasses(q, remaining)) {
    b.wrong++;
    if (b.wrong >= MAX_WRONG) { b.status = 'failed'; finish(rec, scope, b, day, now); }
    return { ok: true, wrong: true };
  }
  b.moves.push(C.uci(m));
  if (C.isMate(q)) { b.status = 'solved'; finish(rec, scope, b, day, now); return { ok: true }; }
  const reply = chooseReply(q, remaining - 1);
  b.moves.push(C.uci(reply));
  return { ok: true };
}

// The way through from the current position: [{ san, by: 'you' | 'them' }]
function solutionLine(puzzle, moves) {
  let p = positionOf(puzzle, moves), remaining = puzzle.n - solverMoves(moves);
  const out = [];
  while (remaining > 0) {
    const first = M.firstMoves(p, remaining).sort((a, b) => (C.uci(a) < C.uci(b) ? -1 : 1))[0];
    if (!first) break;
    out.push({ san: C.san(p, first), by: 'you' });
    const q = C.make(p, first);
    if (C.isMate(q)) break;
    remaining--;
    const reply = chooseReply(q, remaining);
    out.push({ san: C.san(q, reply), by: 'them' });
    p = C.make(q, reply);
  }
  return out;
}

const sans = (puzzle, moves) => {
  let p = C.parseFen(puzzle.fen);
  return moves.map((u, i) => { const m = C.findUci(p, u), s = C.san(p, m); p = C.make(p, m); return { san: s, by: i % 2 === 0 ? 'you' : 'them' }; });
};

// What the player may see. The solution is included only once they are done.
function view(rec, scope, day, puzzle) {
  const b = rec.boards[scope] && rec.boards[scope].day === day ? rec.boards[scope] : { day, moves: [], wrong: 0, status: 'playing' };
  const s = rec.stats[scope] || blankStats();
  const live = s.lastWonDay >= day - 1 && b.status !== 'failed';
  const p = positionOf(puzzle, b.moves);
  const lastU = b.moves.length ? b.moves[b.moves.length - 1] : null;
  return {
    scope, day, resetsAt: resetsAt(day), n: puzzle.n, label: LABEL[puzzle.n], status: b.status, wrong: b.wrong, maxWrong: MAX_WRONG,
    side: C.parseFen(puzzle.fen).turn, fen: C.toFen(p).split(' ')[0],
    last: lastU ? { from: lastU.slice(0, 2), to: lastU.slice(2, 4) } : null,
    legal: b.status === 'playing' ? C.legal(p).map(C.uci) : [],
    moves: sans(puzzle, b.moves),
    ...(b.status === 'failed' ? { solution: solutionLine(puzzle, b.moves) } : {}),
    stats: { played: s.played, solved: s.solved, streak: live ? s.streak : 0, best: s.best, dist: s.dist.slice() },
  };
}

// Who finished today in a server: solved first (fewest wrong moves, then earliest), then those who gave up.
function standings(records, scope, day, memberIds, limit = 10) {
  const rows = [];
  for (const id of memberIds) {
    const b = records[id] && records[id].boards && records[id].boards[scope];
    if (b && b.day === day && b.status !== 'playing') {
      const s = records[id].stats && records[id].stats[scope];
      rows.push({ userId: id, status: b.status, wrong: b.wrong, at: b.finishedAt || 0, streak: b.status === 'solved' && s ? s.streak : 0 });
    }
  }
  rows.sort((a, b) => (a.status === b.status ? a.wrong - b.wrong || a.at - b.at : a.status === 'solved' ? -1 : 1));
  return { finished: rows.length, members: memberIds.length, rows: rows.slice(0, limit).map(({ userId, status, wrong, streak }) => ({ userId, status, wrong, streak })) };
}

module.exports = { BANK, MAX_WRONG, EPOCH, LABEL, dayOf, resetsAt, depthFor, isScope, puzzleFor, blank, boardOf, positionOf, play, view, solutionLine, standings };
