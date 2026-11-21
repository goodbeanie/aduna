'use strict';
// Chess rules, pure: no Express, no database. Used to check every bundled puzzle (puzzle-test.js) and to apply moves on the server.
// A position is { b: 64-array (index 0 = a8 ... 63 = h1; '' empty, uppercase = white, lowercase = black), turn: 'w'|'b', castle: 'KQkq' subset, ep: square index or -1, half, full }.

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const sq = (name) => (8 - Number(name[1])) * 8 + (name.charCodeAt(0) - 97);
const nameOf = (i) => String.fromCharCode(97 + (i % 8)) + (8 - Math.floor(i / 8));
const isWhite = (p) => p !== '' && p === p.toUpperCase();

function parseFen(fen) {
  const parts = String(fen).trim().split(/\s+/);
  if (parts.length < 4) throw new Error('bad FEN');
  const b = [];
  for (const ch of parts[0]) {
    if (ch === '/') continue;
    if (/\d/.test(ch)) { for (let i = 0; i < Number(ch); i++) b.push(''); } else b.push(ch);
  }
  if (b.length !== 64) throw new Error('bad FEN board');
  return { b, turn: parts[1] === 'b' ? 'b' : 'w', castle: parts[2] === '-' ? '' : parts[2], ep: parts[3] === '-' ? -1 : sq(parts[3]), half: Number(parts[4] || 0), full: Number(parts[5] || 1) };
}
function toFen(p) {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let s = '', e = 0;
    for (let f = 0; f < 8; f++) { const c = p.b[r * 8 + f]; if (!c) e++; else { if (e) { s += e; e = 0; } s += c; } }
    if (e) s += e;
    rows.push(s);
  }
  return `${rows.join('/')} ${p.turn} ${p.castle || '-'} ${p.ep < 0 ? '-' : nameOf(p.ep)} ${p.half} ${p.full}`;
}

const KN = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const KG = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];

// is square `s` attacked by side `by` ('w' or 'b')?
function attacked(p, s, by) {
  const r = Math.floor(s / 8), f = s % 8, w = by === 'w';
  const at = (rr, ff) => (rr >= 0 && rr < 8 && ff >= 0 && ff < 8 ? p.b[rr * 8 + ff] : '');
  const pawn = w ? 'P' : 'p';
  const pr = w ? r + 1 : r - 1; // a white pawn attacks upward (toward row 0), so it sits one row below the target
  if (at(pr, f - 1) === pawn || at(pr, f + 1) === pawn) return true;
  const kn = w ? 'N' : 'n', kg = w ? 'K' : 'k';
  for (const [dr, df] of KN) if (at(r + dr, f + df) === kn) return true;
  for (const [dr, df] of KG) if (at(r + dr, f + df) === kg) return true;
  const rq = w ? ['R', 'Q'] : ['r', 'q'], bq = w ? ['B', 'Q'] : ['b', 'q'];
  for (const [dr, df] of ORTH) { let rr = r + dr, ff = f + df; while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) { const c = p.b[rr * 8 + ff]; if (c) { if (rq.includes(c)) return true; break; } rr += dr; ff += df; } }
  for (const [dr, df] of DIAG) { let rr = r + dr, ff = f + df; while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) { const c = p.b[rr * 8 + ff]; if (c) { if (bq.includes(c)) return true; break; } rr += dr; ff += df; } }
  return false;
}
const kingSq = (p, side) => p.b.indexOf(side === 'w' ? 'K' : 'k');
const inCheck = (p, side = p.turn) => { const k = kingSq(p, side); return k >= 0 && attacked(p, k, side === 'w' ? 'b' : 'w'); };

// apply a move { from, to, promo? } (square indexes, promo 'q'|'r'|'b'|'n') without checking legality; returns a new position
function make(p, m) {
  const b = p.b.slice(), piece = b[m.from], white = isWhite(piece), lower = piece.toLowerCase();
  const captured = b[m.to];
  let ep = -1, castle = p.castle;
  if (lower === 'p' && m.to === p.ep && !captured && m.from % 8 !== m.to % 8) b[m.to + (white ? 8 : -8)] = ''; // en passant removes the pawn behind
  b[m.to] = piece; b[m.from] = '';
  if (lower === 'p' && Math.abs(m.to - m.from) === 16) ep = (m.from + m.to) / 2;
  if (lower === 'p' && (m.to < 8 || m.to >= 56)) b[m.to] = white ? (m.promo || 'q').toUpperCase() : (m.promo || 'q').toLowerCase();
  if (lower === 'k' && Math.abs(m.to - m.from) === 2) { // castling moves the rook too
    if (m.to > m.from) { b[m.to - 1] = b[m.to + 1]; b[m.to + 1] = ''; } else { b[m.to + 1] = b[m.to - 2]; b[m.to - 2] = ''; }
  }
  const strip = (c) => { castle = castle.split(c).join(''); };
  if (piece === 'K') { strip('K'); strip('Q'); } if (piece === 'k') { strip('k'); strip('q'); }
  for (const s of [m.from, m.to]) { if (s === 63) strip('K'); if (s === 56) strip('Q'); if (s === 7) strip('k'); if (s === 0) strip('q'); }
  return { b, turn: p.turn === 'w' ? 'b' : 'w', castle, ep, half: lower === 'p' || captured ? 0 : p.half + 1, full: p.turn === 'b' ? p.full + 1 : p.full };
}

function pseudo(p) {
  const out = [], me = p.turn, white = me === 'w';
  const add = (from, to, promo) => out.push(promo ? { from, to, promo } : { from, to });
  for (let s = 0; s < 64; s++) {
    const c = p.b[s];
    if (!c || isWhite(c) !== white) continue;
    const r = Math.floor(s / 8), f = s % 8, k = c.toLowerCase();
    const enemy = (t) => t !== '' && isWhite(t) !== white;
    if (k === 'p') {
      const dir = white ? -1 : 1, start = white ? 6 : 1, last = white ? 1 : 6;
      const one = s + dir * 8;
      if (one >= 0 && one < 64 && !p.b[one]) {
        if (r === last) for (const q of 'qrbn') add(s, one, q); else add(s, one);
        if (r === start && !p.b[one + dir * 8]) add(s, one + dir * 8);
      }
      for (const df of [-1, 1]) {
        const ff = f + df; if (ff < 0 || ff > 7) continue;
        const t = one + df;
        if (t < 0 || t > 63) continue;
        if (enemy(p.b[t]) || t === p.ep) { if (r === last) for (const q of 'qrbn') add(s, t, q); else add(s, t); }
      }
    } else if (k === 'n' || k === 'k') {
      for (const [dr, df] of k === 'n' ? KN : KG) {
        const rr = r + dr, ff = f + df; if (rr < 0 || rr > 7 || ff < 0 || ff > 7) continue;
        const t = rr * 8 + ff; if (!p.b[t] || enemy(p.b[t])) add(s, t);
      }
      if (k === 'k') { // castling: the king and rook have not moved, the squares between are empty, and the king does not start in, pass through or land in check
        const home = white ? 60 : 4, foe = white ? 'b' : 'w';
        if (s === home && !attacked(p, home, foe)) {
          if (p.castle.includes(white ? 'K' : 'k') && !p.b[home + 1] && !p.b[home + 2] && p.b[home + 3] === (white ? 'R' : 'r') && !attacked(p, home + 1, foe) && !attacked(p, home + 2, foe)) add(s, home + 2);
          if (p.castle.includes(white ? 'Q' : 'q') && !p.b[home - 1] && !p.b[home - 2] && !p.b[home - 3] && p.b[home - 4] === (white ? 'R' : 'r') && !attacked(p, home - 1, foe) && !attacked(p, home - 2, foe)) add(s, home - 2);
        }
      }
    } else {
      const dirs = k === 'b' ? DIAG : k === 'r' ? ORTH : DIAG.concat(ORTH);
      for (const [dr, df] of dirs) {
        let rr = r + dr, ff = f + df;
        while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) { const t = rr * 8 + ff; if (!p.b[t]) add(s, t); else { if (enemy(p.b[t])) add(s, t); break; } rr += dr; ff += df; }
      }
    }
  }
  return out;
}
function legal(p) { return pseudo(p).filter((m) => !inCheck(make(p, m), p.turn)); }
const isMate = (p) => inCheck(p) && legal(p).length === 0;
const isStalemate = (p) => !inCheck(p) && legal(p).length === 0;

const uci = (m) => nameOf(m.from) + nameOf(m.to) + (m.promo || '');
function parseUci(s) { const t = String(s); if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(t)) return null; return { from: sq(t.slice(0, 2)), to: sq(t.slice(2, 4)), promo: t[4] || undefined }; }
// the legal move matching a UCI string in this position, or null (a pawn reaching the last rank without a piece letter means a queen)
function findUci(p, s) {
  const m = parseUci(s); if (!m) return null;
  return legal(p).find((x) => x.from === m.from && x.to === m.to && (x.promo || '') === (m.promo || ((p.b[m.from] || '').toLowerCase() === 'p' && (m.to < 8 || m.to > 55) ? 'q' : ''))) || null;
}

// standard algebraic notation of a legal move, for showing the solution
function san(p, m) {
  const piece = p.b[m.from], k = piece.toUpperCase();
  let s;
  if (k === 'K' && Math.abs(m.to - m.from) === 2) s = m.to > m.from ? 'O-O' : 'O-O-O';
  else {
    const cap = p.b[m.to] || (k === 'P' && m.to === p.ep && m.from % 8 !== m.to % 8);
    if (k === 'P') s = (cap ? nameOf(m.from)[0] + 'x' : '') + nameOf(m.to) + (m.promo ? '=' + m.promo.toUpperCase() : '');
    else {
      const others = legal(p).filter((x) => x.to === m.to && x.from !== m.from && p.b[x.from] === piece);
      let dis = '';
      if (others.length) {
        const sameFile = others.some((x) => x.from % 8 === m.from % 8), sameRank = others.some((x) => Math.floor(x.from / 8) === Math.floor(m.from / 8));
        dis = !sameFile ? nameOf(m.from)[0] : !sameRank ? nameOf(m.from)[1] : nameOf(m.from);
      }
      s = k + dis + (cap ? 'x' : '') + nameOf(m.to);
    }
  }
  const after = make(p, m);
  return s + (isMate(after) ? '#' : inCheck(after) ? '+' : '');
}

module.exports = { START, sq, nameOf, isWhite, parseFen, toFen, attacked, inCheck, make, legal, isMate, isStalemate, uci, parseUci, findUci, san };
