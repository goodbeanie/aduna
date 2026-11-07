// Contexto rules, no database: node server/contexto-test.js
'use strict';
const assert = require('assert');
const C = require('./contexto');

if (!C.ready()) { console.log('contexto: skipped (the word data is not built yet: node server/contexto-build.js)'); process.exit(0); }

const SECRET = 'test-secret';
const T0 = Date.UTC(2026, 10, 6, 12); // No. 1
assert.strictEqual(C.dayOf(T0), 1);
assert.strictEqual(C.dayOf(Date.UTC(2026, 10, 6, 23, 59)), 1);
assert.strictEqual(C.dayOf(Date.UTC(2026, 10, 7)), 2);
assert.strictEqual(C.resetsAt(1), Date.UTC(2026, 10, 7));

// the word of the day: stable, and different between days and scopes
const a1 = C.answerFor('global', 1, SECRET);
assert.strictEqual(a1, C.answerFor('global', 1, SECRET));
assert.ok(C.isWord(a1), 'the answer is a legal guess');
const seq = (secret) => Array.from({ length: 10 }, (_, d) => C.answerFor('global', d + 1, secret)).join();
assert.notStrictEqual(seq(SECRET), seq('other-secret'));
const days = new Set(); for (let d = 1; d <= 40; d++) days.add(C.answerFor('global', d, SECRET));
assert.ok(days.size > 30, 'words rarely repeat');
const scopes = new Set(); for (let s = 0; s < 20; s++) scopes.add(C.answerFor('srv' + s, 1, SECRET));
assert.ok(scopes.size > 14, 'every scope has its own word');

// the ranking: the answer is No. 1 and every rank is used once
assert.strictEqual(C.rankOf(a1, a1), 1);
assert.strictEqual(C.rankOf(a1, 'zzzzzz'), 0);
const seen = new Set();
for (let r = 1; r <= 30000; r++) { const w = C.wordAt(a1, r); assert.ok(w && !seen.has(w), 'no word twice (rank ' + r + ')'); seen.add(w); assert.strictEqual(C.rankOf(a1, w), r); }
assert.strictEqual(C.wordAt(a1, 1), a1);
assert.strictEqual(seen.size, 30000);
assert.strictEqual(C.band(1), 'g'); assert.strictEqual(C.band(300), 'g'); assert.strictEqual(C.band(301), 'o'); assert.strictEqual(C.band(1500), 'o'); assert.strictEqual(C.band(1501), 'r');
// meaning really is used: for "storm" the weather words beat unrelated ones
assert.ok(C.rankOf('storm', 'hurricane') < 10 && C.rankOf('storm', 'rain') < C.rankOf('storm', 'money'));

// a game
const rec = C.blank();
assert.deepStrictEqual(C.normalize(' Storm '), 'storm'); assert.strictEqual(C.normalize('two words'), null); assert.strictEqual(C.normalize('a'), null); assert.strictEqual(C.normalize(42), null);
assert.ok(C.play(rec, 'global', 1, 'storm', '', T0).error);
assert.ok(C.play(rec, 'global', 1, 'storm', 'two words', T0).error);
assert.ok(C.play(rec, 'global', 1, 'storm', 'qzxqzx', T0).error, 'unknown word');
let v = C.view(rec, 'global', 1, 'storm');
assert.strictEqual(v.status, 'playing'); assert.strictEqual(v.tries, 0); assert.ok(!('answer' in v) && !('closest' in v));
const r1 = C.play(rec, 'global', 1, 'storm', 'RAIN', T0);
assert.deepStrictEqual(r1, { ok: true, word: 'rain' });
const again = C.play(rec, 'global', 1, 'storm', 'rain', T0);
assert.strictEqual(again.repeat, true);
v = C.view(rec, 'global', 1, 'storm');
assert.strictEqual(v.tries, 1); assert.strictEqual(v.rows[0].word, 'rain'); assert.strictEqual(v.rows[0].rank, C.rankOf('storm', 'rain'));
assert.ok(!JSON.stringify(v).includes('"storm"'), 'the answer is not in the view while playing');

// hints: closer than your best guess, they count as guesses, never repeat a word
const before = v.rows.reduce((m, r) => Math.min(m, r.rank), 1e9);
const h = C.hint(rec, 'global', 1, 'storm', T0);
assert.ok(h.ok && h.hint && C.rankOf('storm', h.word) < before && C.rankOf('storm', h.word) >= 2, 'hint is closer but not the answer');
v = C.view(rec, 'global', 1, 'storm');
assert.strictEqual(v.tries, 2); assert.strictEqual(v.hints, 1); assert.ok(v.rows[1].hint);
let last = C.rankOf('storm', h.word);
for (let i = 0; i < 60; i++) { const x = C.hint(rec, 'global', 1, 'storm', T0); if (x.error) break; const rk = C.rankOf('storm', x.word); assert.ok(rk >= 2 && rk < last, 'each hint is closer than the last'); last = rk; }
assert.ok(last <= 3, 'hints get you right next to the word');
const all = C.view(rec, 'global', 1, 'storm').rows.map((r) => r.word);
assert.strictEqual(new Set(all).size, all.length, 'no word twice');
assert.ok(C.hint(rec, 'global', 1, 'storm', T0).error, 'nothing is closer once you hold the best word');

// finding it ends the game
const win = C.play(rec, 'global', 1, 'storm', 'storm', T0 + 1000);
assert.ok(win.ok);
v = C.view(rec, 'global', 1, 'storm');
assert.strictEqual(v.status, 'won'); assert.strictEqual(v.answer, 'storm'); assert.strictEqual(v.closest[0], 'storm'); assert.strictEqual(v.closest.length, 30);
assert.strictEqual(v.stats.played, 1); assert.strictEqual(v.stats.won, 1); assert.strictEqual(v.stats.streak, 1); assert.strictEqual(v.stats.fewest, v.tries);
assert.ok(C.play(rec, 'global', 1, 'storm', 'rain', T0).error, 'finished');
assert.ok(C.hint(rec, 'global', 1, 'storm', T0).error); assert.ok(C.giveUp(rec, 'global', 1, 'storm', T0).error);

// streaks: a second day in a row, then a missed day
C.play(rec, 'global', 2, 'lion', 'lion', T0 + 86400_000);
assert.strictEqual(C.view(rec, 'global', 2, 'lion').stats.streak, 2);
assert.strictEqual(C.view(rec, 'global', 3, 'lion').stats.streak, 2, 'a streak survives until a day is missed');
assert.strictEqual(C.view(rec, 'global', 4, 'lion').stats.streak, 0);
assert.strictEqual(C.view(rec, 'global', 2, 'lion').stats.best, 2);

// giving up reveals the word and ends the streak
const g = C.blank();
C.play(g, 'global', 1, 'storm', 'lion', T0);
assert.ok(C.giveUp(g, 'global', 1, 'storm', T0 + 5).ok);
v = C.view(g, 'global', 1, 'storm');
assert.strictEqual(v.status, 'gaveup'); assert.strictEqual(v.answer, 'storm'); assert.strictEqual(v.stats.won, 0); assert.strictEqual(v.stats.streak, 0); assert.strictEqual(v.stats.fewest, 0);

// a new day starts a new board, and each scope has its own
assert.strictEqual(C.view(rec, 'global', 5, 'lion').tries, 0);
assert.strictEqual(C.view(rec, 'srv1', 1, 'lion').tries, 0);
assert.strictEqual(C.view(rec, 'srv1', 1, 'lion').stats.played, 0);

// a hint with no guess yet still works
const hv = C.blank(); const first = C.hint(hv, 'global', 1, 'storm', T0);
assert.ok(first.ok && C.rankOf('storm', first.word) > 1);

// standings
const recs = {};
const mk = (id, status, n, at) => { const r = C.blank(); r.boards.s = { day: 1, guesses: Array(n).fill('x'), hinted: [], status, finishedAt: at }; r.stats.s = { played: 1, won: status === 'won' ? 1 : 0, streak: status === 'won' ? 1 : 0, best: 1, lastWonDay: 1, lastDay: 1, fewest: n }; recs[id] = r; };
mk('a', 'won', 40, 5); mk('b', 'won', 12, 9); mk('c', 'gaveup', 3, 1); mk('d', 'won', 12, 7);
const st = C.standings(recs, 's', 1, ['a', 'b', 'c', 'd', 'e']);
assert.deepStrictEqual(st.rows.map((r) => r.userId), ['d', 'b', 'a', 'c']);
assert.strictEqual(st.finished, 4); assert.strictEqual(st.members, 5);
assert.ok(C.standings(recs, 's', 2, ['a', 'b']).finished === 0, 'only today counts');

console.log('contexto: ok');
