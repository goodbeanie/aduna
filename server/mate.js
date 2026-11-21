'use strict';
const C = require('./chess');
// Mate-in-n search for the side to move. A solver move is "winning in n" if, after it, the opponent is mated, or (n > 1) every reply
// leaves the solver able to win in n-1. Stalemate never counts as a win.
function winsIn(p, n) { // does the side to move have a forced mate within n of its own moves?
  return firstMoves(p, n, true).length > 0;
}
function firstMoves(p, n, stopAtOne = false) {
  const out = [];
  for (const m of C.legal(p)) {
    const q = C.make(p, m);
    if (n <= 1 && !C.inCheck(q)) continue; // a mating move must give check: skips almost every move without generating replies
    if (movePasses(q, n)) { out.push(m); if (stopAtOne) break; }
  }
  return out;
}
function movePasses(q, n) { // q: position after the solver's move, opponent to move
  const replies = C.legal(q);
  if (!replies.length) return C.inCheck(q);
  if (n <= 1) return false;
  // try replies likely to refute first (captures, king moves) so a failing line is dropped fast
  replies.sort((a, b) => (q.b[b.to] ? 1 : 0) - (q.b[a.to] ? 1 : 0));
  for (const r of replies) if (!winsIn(C.make(q, r), n - 1)) return false;
  return true;
}
module.exports = { winsIn, firstMoves, movePasses };
