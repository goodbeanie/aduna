// Wordle rules, no database: node server/wordle-test.js
const assert = require('assert');
const W = require('./wordle');

// scoring, including repeated letters
assert.strictEqual(W.score('crane', 'crane'), 'ggggg');
assert.strictEqual(W.score('plain', 'train'), 'xxggg');
assert.strictEqual(W.score('speed', 'abide'), 'xxyxy', 'a repeated letter only turns yellow as often as the word holds it');
assert.strictEqual(W.score('geese', 'those'), 'xxxgg');
assert.strictEqual(W.score('lolly', 'hello'), 'xyggx');

// the answer list is clean and every answer is a legal guess
assert.ok(W.ANSWERS.length > 500);
assert.strictEqual(new Set(W.ANSWERS).size, W.ANSWERS.length, 'no repeated words');
for (const w of W.ANSWERS) { assert.ok(/^[a-z]{5}$/.test(w), w); assert.ok(W.isWord(w), w + ' must be a legal guess'); }

// days, scopes and secrets pick words
assert.strictEqual(W.dayOf(W.EPOCH), 1);
assert.strictEqual(W.dayOf(W.EPOCH + 86400_000 - 1), 1);
assert.strictEqual(W.dayOf(W.EPOCH + 86400_000), 2);
assert.strictEqual(W.answerFor('global', 5, 's'), W.answerFor('global', 5, 's'), 'the same day gives the same word');
assert.notStrictEqual(W.answerFor('global', 5, 's') + W.answerFor('global', 6, 's') + W.answerFor('global', 7, 's'), W.answerFor('global', 5, 'other') + W.answerFor('global', 6, 'other') + W.answerFor('global', 7, 'other'), 'the secret decides');
const seen = new Set(); for (let d = 1; d <= 60; d++) seen.add(W.answerFor('abc', d, 's'));
assert.ok(seen.size > 40, 'words vary from day to day');
assert.ok(W.isScope('global') && W.isScope('a1B2_c-3') && !W.isScope('') && !W.isScope('../x') && !W.isScope(5) && !W.isScope('a'.repeat(65)));

// playing: win
let rec = W.blank();
const ans = 'train';
assert.ok(W.play(rec, 'global', 10, ans, 'crane').ok);
assert.ok(W.play(rec, 'global', 10, ans, ' PLAIN ').ok, 'case and spaces are ignored');
for (const bad of ['', 'abcd', 'abcdef', 'ab1de', null, 5, {}, []]) assert.ok(W.play(rec, 'global', 10, ans, bad).error, 'refused: ' + JSON.stringify(bad));
assert.strictEqual(rec.boards.global.guesses.length, 2, 'refused guesses do not count');
let v = W.view(rec, 'global', 10, ans);
assert.strictEqual(v.status, 'playing'); assert.strictEqual(v.answer, undefined, 'the answer stays hidden while playing');
assert.deepStrictEqual(v.rows.map((r) => r.marks), ['xggyx', 'xxggg']); // crane vs train: r and a in place, n is in the word but at the end
assert.ok(W.play(rec, 'global', 10, ans, 'train').ok);
v = W.view(rec, 'global', 10, ans);
assert.strictEqual(v.status, 'won'); assert.strictEqual(v.answer, 'train'); assert.strictEqual(v.tries, 3);
assert.deepStrictEqual([v.stats.played, v.stats.won, v.stats.streak, v.stats.best], [1, 1, 1, 1]);
assert.strictEqual(v.stats.dist[2], 1);
assert.ok(W.play(rec, 'global', 10, ans, 'crane').error, 'no more guesses after finishing');

// a streak runs over consecutive days, resets on a loss or a missed day
const once = (day, guesses) => { for (const g of guesses) W.play(rec, 'global', day, ans, g); };
once(11, ['train']); assert.strictEqual(W.view(rec, 'global', 11, ans).stats.streak, 2);
once(12, ['train']); assert.strictEqual(W.view(rec, 'global', 12, ans).stats.streak, 3);
assert.strictEqual(W.view(rec, 'global', 13, ans).stats.streak, 3, 'the streak is alive until a day is missed');
assert.strictEqual(W.view(rec, 'global', 14, ans).stats.streak, 0, 'a missed day ends it');
once(14, ['train']); assert.strictEqual(W.view(rec, 'global', 14, ans).stats.streak, 1);
assert.strictEqual(W.view(rec, 'global', 14, ans).stats.best, 3, 'the best streak is kept');

// losing
once(15, ['crane', 'plain', 'about', 'above', 'abuse', 'actor']);
v = W.view(rec, 'global', 15, ans);
assert.strictEqual(v.status, 'lost'); assert.strictEqual(v.answer, 'train'); assert.strictEqual(v.stats.streak, 0);
assert.strictEqual(v.stats.played, 5); assert.strictEqual(v.stats.won, 4);

// a new day starts a fresh board; scopes are separate
assert.strictEqual(W.view(rec, 'global', 16, ans).status, 'playing');
assert.strictEqual(W.view(rec, 'srv1', 15, ans).status, 'playing');
assert.ok(W.play(rec, 'srv1', 15, ans, 'crane').ok);
assert.strictEqual(rec.boards.global.guesses.length, 6, 'a game in another scope leaves this one alone');

// standings
const recs = { a: W.blank(), b: W.blank(), c: W.blank(), d: W.blank() };
const go = (id, gs, t) => { for (const g of gs) W.play(recs[id], 's', 3, ans, g, t); };
go('a', ['crane', 'train'], 300); go('b', ['train'], 200); go('c', ['crane', 'plain', 'about', 'above', 'abuse', 'actor'], 100); go('d', ['crane'], 100);
const st = W.standings(recs, 's', 3, ['a', 'b', 'c', 'd', 'nobody']);
assert.deepStrictEqual(st.rows.map((r) => r.userId), ['b', 'a', 'c'], 'fewest tries first, then those who missed; unfinished players are left out');
assert.deepStrictEqual(st.rows.map((r) => r.streak), [1, 1, 0], 'each winner’s current streak is shown; a miss shows none');
assert.deepStrictEqual([st.finished, st.members], [3, 5]);
assert.strictEqual(JSON.stringify(st).includes('crane'), false, 'standings never carry guesses');
assert.strictEqual(W.standings(recs, 's', 4, ['a', 'b']).finished, 0, 'yesterday does not count');

// boards are pruned
const big = W.blank(); for (let i = 0; i < 80; i++) W.boardOf(big, 's' + i, i + 1);
assert.ok(Object.keys(big.boards).length <= 60);

console.log('wordle: ok');
