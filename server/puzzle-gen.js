'use strict';
// Makes chess puzzles at random: a position with White to move that is a forced mate in 1, 2 or 3 moves, with exactly one first move and no
// shorter mate. Pure and seedable: the same rng gives the same puzzles (tested by puzzle-test.js).
//
// It is used in two places:
//  - make-puzzle-bank.js builds puzzle-bank.js (the daily puzzles) with a fixed seed. Nobody runs it while the server is up.
//  - practice mode asks createSupply() for a new puzzle each time. Fresh ones are made a little at a time in the background (fill) so a
//    request never waits for the search; when none is ready yet, a puzzle from the bank is turned around instead (see variant).
//
// A mate in 3 takes about 1.5 seconds of searching on average, so fill() makes them a little at a time and the pool is small: when it runs
// dry (lots of people practising at once) a bank puzzle in one of its four orientations is used until it fills again.

const C = require('./chess');
const M = require('./mate');

function rngFrom(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, list) => list[Math.floor(rng() * list.length)];

// The pieces besides the kings. White always moves first and has the better army; Black defends with whatever is listed.
const WHITE_SETS = [['Q'], ['R'], ['R', 'R'], ['Q', 'B'], ['Q', 'N'], ['R', 'B'], ['R', 'N'], ['B', 'B'], ['B', 'N'], ['Q', 'P'], ['R', 'P'], ['N', 'P'], ['R', 'R', 'B'], ['Q', 'N', 'P']];
const BLACK_SETS = [[], [], ['p'], ['p', 'p'], ['n'], ['b'], ['r'], ['p', 'p', 'p'], ['n', 'p'], ['b', 'p'], ['r', 'p'], ['p', 'p', 'n'], ['q']];

const row = (s) => s >> 3, col = (s) => s & 7;
const onEdge = (s) => row(s) === 0 || row(s) === 7 || col(s) === 0 || col(s) === 7;

function randomPosition(rng) {
  const b = Array(64).fill('');
  const free = () => { for (;;) { const s = Math.floor(rng() * 64); if (!b[s]) return s; } };
  let bk = free();
  for (let i = 0; i < 12 && !onEdge(bk) && rng() > 0.2; i++) bk = free(); // mostly the king that gets mated is near an edge
  b[bk] = 'k';
  let wk = free();
  while (Math.max(Math.abs(row(wk) - row(bk)), Math.abs(col(wk) - col(bk))) <= 1) wk = free();
  b[wk] = 'K';
  for (const ch of [...pick(rng, WHITE_SETS), ...pick(rng, BLACK_SETS)]) {
    for (let t = 0; t < 40; t++) {
      const s = free();
      if ((ch === 'P' || ch === 'p') && (row(s) === 0 || row(s) === 7)) continue; // no pawns on the first or last rank
      b[s] = ch; break;
    }
  }
  return { b, turn: 'w', castle: '', ep: -1, half: 0, full: 1 };
}

// Black is not in check (White is to move) and White has a move.
const playable = (p) => !C.inCheck(p, 'b') && C.legal(p).length > 0;

// A forced mate in n, a single first move, and no mate that is shorter. The first test is the one almost every position fails.
function qualifies(p, n) {
  if (!M.winsIn(p, n)) return false;
  if (n > 1 && M.winsIn(p, n - 1)) return false;
  return M.firstMoves(p, n).length === 1;
}

// One random position, kept only if it is a puzzle: a FEN, or null.
function tryOne(n, rng) {
  const p = randomPosition(rng);
  return playable(p) && qualifies(p, n) ? C.toFen(p) : null;
}

// Keep trying until a puzzle turns up or `ms` run out (checked between positions, so a position that is slow to search can run over).
function makeOne(n, rng, ms) {
  const end = Date.now() + ms;
  do { const f = tryOne(n, rng); if (f) return f; } while (Date.now() < end);
  return null;
}

// Turn a puzzle around: mirror it left to right and/or swap the colours (flip it top to bottom and swap the pieces, so Black is to move).
// Both are exact symmetries of chess when nobody can castle and there is no en passant, so it stays a puzzle with the same single
// first move. Returns the FEN unchanged if castling or en passant is possible.
function transform(fen, mirror, swap) {
  const [place, turn, castle, ep] = fen.split(' ');
  if (castle !== '-' || ep !== '-') return fen;
  let rows = place.split('/');
  if (mirror) rows = rows.map((r) => [...r].reverse().join(''));
  if (swap) rows = rows.reverse().map((r) => [...r].map((c) => (/[a-z]/.test(c) ? c.toUpperCase() : /[A-Z]/.test(c) ? c.toLowerCase() : c)).join(''));
  return `${rows.join('/')} ${swap ? (turn === 'w' ? 'b' : 'w') : turn} - - 0 1`;
}
const variant = (fen, rng) => transform(fen, rng() < 0.5, rng() < 0.5);

// What practice mode draws from. supply(n) is a fresh puzzle of the depth n (1, 2 or 3): a ready one from the pool if there is one,
// otherwise a bank puzzle in a random orientation. fill(ms) tops the pool up for about `ms` and says whether it still needs more.
function createSupply(bank, rng = Math.random, targets = { 1: 10, 2: 8, 3: 4 }) {
  const pool = { 1: [], 2: [], 3: [] };
  return {
    pool,
    supply(n) {
      const ready = pool[n] && pool[n].pop();
      return ready ? variant(ready, rng) : variant(pick(rng, bank[n]), rng);
    },
    needsMore: () => Object.keys(targets).some((n) => pool[n].length < targets[n]),
    fill(ms) {
      const end = Date.now() + ms;
      for (const n of Object.keys(targets)) {
        while (pool[n].length < targets[n] && Date.now() < end) {
          const f = makeOne(Number(n), rng, Math.max(1, end - Date.now()));
          if (f) pool[n].push(f); else break;
        }
      }
      return this.needsMore();
    },
  };
}

module.exports = { rngFrom, randomPosition, qualifies, tryOne, makeOne, transform, variant, createSupply };
