// Chess puzzle rules, no database: node server/puzzle-test.js
// Checks the chess engine (perft counts and special moves), that every puzzle in the bank really is a forced mate with exactly one
// first move and no shorter mate, and the daily game (picking, moves, wrong moves, stats, standings).
'use strict';
const assert = require('assert');
const C = require('./chess');
const M = require('./mate');
const P = require('./puzzle');

const step = (s) => console.log('  ok  ' + s);

// ---- the chess rules ----
const perft = (p, d) => (d === 0 ? 1 : C.legal(p).reduce((n, m) => n + perft(C.make(p, m), d - 1), 0));
assert.strictEqual(perft(C.parseFen(C.START), 3), 8902);
assert.strictEqual(perft(C.parseFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'), 2), 2039, 'castling, pins and checks');
assert.strictEqual(perft(C.parseFen('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1'), 4), 43238, 'en passant and discovered checks');
assert.strictEqual(perft(C.parseFen('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1'), 3), 9467, 'promotions');
step('move generation matches the standard counts');

let g = C.parseFen(C.START);
for (const u of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) g = C.make(g, C.findUci(g, u));
assert.ok(C.isMate(g), 'fool’s mate');
assert.strictEqual(C.san(C.parseFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3'), C.findUci(C.parseFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3'), 'e2e3')), 'e3');
const castle = C.parseFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
assert.ok(C.findUci(castle, 'e1g1') && C.findUci(castle, 'e1c1'), 'both ways of castling');
assert.strictEqual(C.san(castle, C.findUci(castle, 'e1g1')), 'O-O');
const ep = C.parseFen('8/8/8/3pP3/8/8/8/k6K w - d6 0 1');
assert.ok(C.findUci(ep, 'e5d6'), 'en passant');
assert.strictEqual(C.toFen(C.make(ep, C.findUci(ep, 'e5d6'))).split(' ')[0], '8/8/3P4/8/8/8/8/k6K', 'the captured pawn is removed');
const promo = C.parseFen('8/P7/8/8/8/8/7k/K7 w - - 0 1');
assert.ok(C.findUci(promo, 'a7a8n') && C.findUci(promo, 'a7a8q'), 'a pawn can promote to any piece');
assert.strictEqual(C.findUci(promo, 'a7a8').promo, 'q', 'no piece letter means a queen');
assert.strictEqual(C.findUci(C.parseFen(C.START), 'e2e5'), null, 'an illegal move is refused');
step('castling, en passant, promotion, mate and notation');

// ---- the bank ----
for (const n of [1, 2, 3]) {
  const list = P.BANK[n];
  assert.ok(list.length >= 20, `mate in ${n}: at least 20 puzzles (has ${list.length})`);
  assert.strictEqual(new Set(list).size, list.length, `mate in ${n}: no puzzle twice`);
  for (const fen of list) {
    const p = C.parseFen(fen);
    assert.strictEqual(C.toFen(p).split(' ').slice(0, 4).join(' '), fen.split(' ').slice(0, 4).join(' '), 'FEN round trip: ' + fen);
    assert.ok(!C.inCheck(p, p.turn === 'w' ? 'b' : 'w'), 'the side that just moved is not in check: ' + fen);
    assert.strictEqual(M.firstMoves(p, n).length, 1, `mate in ${n} has exactly one first move: ${fen}`);
    if (n > 1) assert.strictEqual(M.firstMoves(p, n - 1, true).length, 0, `no shorter mate: ${fen}`);
  }
  step(`mate in ${n}: ${list.length} puzzles, each a forced mate with one first move and no shorter mate`);
}

// ---- days and picking ----
assert.strictEqual(P.dayOf(Date.UTC(2026, 9, 1, 0, 0, 1)), 1);
assert.strictEqual(P.dayOf(Date.UTC(2026, 9, 1, 23, 59, 59)), 1);
assert.strictEqual(P.dayOf(Date.UTC(2026, 9, 2)), 2);
assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 7].map(P.depthFor), [2, 2, 3, 3, 1, 1, 2], '1 Oct 2026 is a Thursday: Mon/Tue mate in 1, Wed-Fri mate in 2, weekend mate in 3');
const a = P.puzzleFor('global', 40, 's3cret');
assert.deepStrictEqual(a, P.puzzleFor('global', 40, 's3cret'), 'the same day and scope always give the same puzzle');
assert.strictEqual(a.n, P.depthFor(40));
assert.ok(P.BANK[a.n].includes(a.fen));
const spread = new Set(); for (let d = 1; d <= 120; d++) { spread.add(P.puzzleFor('global', d, 's3cret').fen); }
assert.ok(spread.size > 40, 'the puzzles vary from day to day');
assert.notStrictEqual(P.puzzleFor('global', 40, 'other-secret').fen + P.puzzleFor('global', 41, 'other-secret').fen, a.fen + P.puzzleFor('global', 41, 's3cret').fen, 'a different secret gives different puzzles');
step('the day changes at midnight UTC, the difficulty follows the weekday, the puzzle is repeatable and secret');

// ---- playing a mate in 1 ----
const DAY1 = 5; // a Monday: mate in 1
const pz1 = P.puzzleFor('global', DAY1, 'k');
assert.strictEqual(pz1.n, 1);
const p1 = C.parseFen(pz1.fen), win1 = C.uci(M.firstMoves(p1, 1)[0]);
const wrong1 = C.legal(p1).map(C.uci).find((u) => u !== win1);
let rec = P.blank();
let v = P.view(rec, 'global', DAY1, pz1);
assert.strictEqual(v.status, 'playing'); assert.strictEqual(v.label, 'Mate in 1'); assert.strictEqual(v.legal.length, C.legal(p1).length);
assert.ok(!('solution' in v), 'the solution is not sent while playing');
assert.deepStrictEqual(P.play(rec, 'global', DAY1, pz1, 'e2e9'), { error: 'That is not a legal move' }, 'nonsense is refused and not counted');
assert.strictEqual(P.view(rec, 'global', DAY1, pz1).wrong, 0);
assert.deepStrictEqual(P.play(rec, 'global', DAY1, pz1, wrong1), { ok: true, wrong: true }, 'a legal move that does not mate is a wrong move');
v = P.view(rec, 'global', DAY1, pz1);
assert.strictEqual(v.wrong, 1); assert.strictEqual(v.status, 'playing'); assert.strictEqual(v.fen, pz1.fen.split(' ')[0], 'a wrong move is not played on the board');
assert.deepStrictEqual(P.play(rec, 'global', DAY1, pz1, win1), { ok: true });
v = P.view(rec, 'global', DAY1, pz1);
assert.strictEqual(v.status, 'solved'); assert.strictEqual(v.wrong, 1); assert.strictEqual(v.legal.length, 0);
assert.deepStrictEqual(v.stats, { played: 1, solved: 1, streak: 1, best: 1, dist: [0, 1, 0] });
assert.ok(P.play(rec, 'global', DAY1, pz1, win1).error, 'no more moves once it is finished');
step('mate in 1: wrong moves are counted and not played, the right one solves it, the stats are kept');

// ---- three wrong moves ends it and shows the answer ----
rec = P.blank();
const wrongs = C.legal(p1).map(C.uci).filter((u) => u !== win1);
P.play(rec, 'global', DAY1, pz1, wrongs[0]); P.play(rec, 'global', DAY1, pz1, wrongs[1]);
assert.strictEqual(P.view(rec, 'global', DAY1, pz1).status, 'playing');
P.play(rec, 'global', DAY1, pz1, wrongs[2]);
v = P.view(rec, 'global', DAY1, pz1);
assert.strictEqual(v.status, 'failed'); assert.strictEqual(v.wrong, 3);
assert.deepStrictEqual(v.solution, [{ san: C.san(p1, C.findUci(p1, win1)), by: 'you' }], 'the answer appears once it is over');
assert.strictEqual(v.stats.played, 1); assert.strictEqual(v.stats.solved, 0); assert.strictEqual(v.stats.streak, 0);
step('three wrong moves end the puzzle and reveal the solution');

// ---- a mate in 2: the opponent replies, any correct mate is accepted ----
const d2 = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((d) => P.depthFor(d) === 2);
const pz2 = P.puzzleFor('global', d2, 'k');
const p2 = C.parseFen(pz2.fen), key2 = M.firstMoves(p2, 2)[0];
rec = P.blank();
const bad2 = C.legal(p2).map((m) => ({ m, u: C.uci(m) })).find((x) => x.u !== C.uci(key2) && !M.movePasses(C.make(p2, x.m), 2));
assert.deepStrictEqual(P.play(rec, 'global', d2, pz2, bad2.u), { ok: true, wrong: true });
assert.deepStrictEqual(P.play(rec, 'global', d2, pz2, C.uci(key2)), { ok: true });
v = P.view(rec, 'global', d2, pz2);
assert.strictEqual(v.status, 'playing'); assert.strictEqual(v.moves.length, 2, 'the opponent has replied');
assert.deepStrictEqual(v.moves.map((m) => m.by), ['you', 'them']);
assert.ok(v.last && v.last.from && v.last.to);
const pos2 = P.positionOf(pz2, rec.boards.global.moves);
const mates = M.firstMoves(pos2, 1);
assert.ok(mates.length >= 1);
P.play(rec, 'global', d2, pz2, C.uci(mates[mates.length - 1]));
assert.strictEqual(P.view(rec, 'global', d2, pz2).status, 'solved');
step('mate in 2: the reply comes from the server and any mating move finishes it');

// ---- streaks, a new day, missing a day ----
rec = P.blank();
const solveToday = (day) => {
  const pz = P.puzzleFor('global', day, 'k');
  for (let guard = 0; guard < 8 && P.view(rec, 'global', day, pz).status === 'playing'; guard++) {
    const b = P.boardOf(rec, 'global', day), pos = P.positionOf(pz, b.moves);
    P.play(rec, 'global', day, pz, C.uci(M.firstMoves(pos, pz.n - Math.ceil(b.moves.length / 2))[0]));
  }
  return P.view(rec, 'global', day, pz);
};
assert.strictEqual(solveToday(10).stats.streak, 1);
assert.strictEqual(solveToday(11).stats.streak, 2);
v = P.view(rec, 'global', 12, P.puzzleFor('global', 12, 'k'));
assert.strictEqual(v.status, 'playing'); assert.strictEqual(v.stats.streak, 2, 'the streak stays until a day is missed');
assert.strictEqual(P.view(rec, 'global', 14, P.puzzleFor('global', 14, 'k')).stats.streak, 0, 'a missed day ends it');
assert.strictEqual(solveToday(14).stats.streak, 1);
assert.strictEqual(solveToday(14).stats.best, 2);
step('a new puzzle each day, streaks survive until a day is missed');

// ---- standings ----
const mk = (status, wrong, at, streak) => ({ boards: { s1: { day: 20, moves: [], wrong, status, finishedAt: at } }, stats: { s1: { streak } } });
const recs = { a: mk('solved', 1, 100, 3), b: mk('solved', 0, 300, 1), c: mk('failed', 3, 50, 0), d: mk('solved', 0, 200, 2), e: { boards: { s1: { day: 20, moves: [], wrong: 0, status: 'playing' } }, stats: {} } };
const st = P.standings(recs, 's1', 20, ['a', 'b', 'c', 'd', 'e', 'f']);
assert.deepStrictEqual(st.rows.map((r) => r.userId), ['d', 'b', 'a', 'c'], 'fewest wrong moves first, then earliest; those who gave up last');
assert.strictEqual(st.finished, 4); assert.strictEqual(st.members, 6);
step('standings');

console.log('puzzle: ok');
