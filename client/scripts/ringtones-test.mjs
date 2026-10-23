// Seasonal ringtone choice: node client/scripts/ringtones-test.mjs   (try it in other time zones too: TZ=Pacific/Auckland node ...)
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ringtoneFor, windowOf, DEFAULT_RINGTONE, SEASONAL, DAYS_BEFORE, DAYS_AFTER } from '../src/ringtones.js';
const ok = (m) => console.log('✓', m);
const id = (y, m, d, h = 12, mi = 0) => ringtoneFor(new Date(y, m - 1, d, h, mi)).id; // local calendar date, any time of day

assert.strictEqual(DAYS_BEFORE, 14); assert.strictEqual(DAYS_AFTER, 7);
ok('windows are 2 weeks before and 1 week after');

// Halloween: 17 Oct - 7 Nov, both ends included
assert.strictEqual(id(2026, 10, 16), 'default');
assert.strictEqual(id(2026, 10, 17), 'halloween');
assert.strictEqual(id(2026, 10, 22), 'halloween');
assert.strictEqual(id(2026, 10, 31), 'halloween');
assert.strictEqual(id(2026, 11, 1), 'halloween');
assert.strictEqual(id(2026, 11, 7), 'halloween');
assert.strictEqual(id(2026, 11, 8), 'default');
ok('Halloween: 17 Oct through 7 Nov, nothing outside');

// Christmas: 11 Dec - 1 Jan (crosses New Year)
assert.strictEqual(id(2026, 12, 10), 'default');
assert.strictEqual(id(2026, 12, 11), 'christmas');
assert.strictEqual(id(2026, 12, 25), 'christmas');
assert.strictEqual(id(2026, 12, 31), 'christmas');
assert.strictEqual(id(2027, 1, 1), 'christmas');
assert.strictEqual(id(2027, 1, 2), 'default');
assert.strictEqual(id(2026, 1, 1), 'christmas', 'the window of the previous Christmas is found in early January');
assert.strictEqual(id(2026, 1, 2), 'default');
ok('Christmas: 11 Dec through 1 Jan, including across New Year');

// the rest of the year is the normal ringtone, and the two windows never touch
for (const [y, m, d] of [[2026, 2, 14], [2026, 3, 29], [2026, 6, 21], [2026, 9, 30], [2026, 11, 20], [2026, 12, 1]]) assert.strictEqual(id(y, m, d), 'default', `${y}-${m}-${d}`);
ok('ordinary days use the default ringtone');

// a whole-year sweep: every day maps to exactly the window it should, in leap and non-leap years
for (const y of [2024, 2025, 2026, 2028]) {
  let halloween = 0, christmas = 0, def = 0;
  for (let t = new Date(y, 0, 1); t.getFullYear() === y; t = new Date(y, t.getMonth(), t.getDate() + 1)) {
    const r = ringtoneFor(t).id;
    if (r === 'halloween') halloween++; else if (r === 'christmas') christmas++; else def++;
  }
  assert.strictEqual(halloween, 14 + 1 + 7, `${y} halloween days`); // 14 before + the day + 7 after = 22
  assert.strictEqual(christmas, 21 + 1, `${y} christmas days in this calendar year`); // 11 Dec..31 Dec = 21 days, plus 1 Jan = 1 day
  assert.strictEqual(halloween + christmas + def, (y % 4 === 0) ? 366 : 365);
}
ok('a full-year sweep (leap years too) gives the expected number of days for each ringtone');

// time of day does not matter: the first and last minute of a window day
assert.strictEqual(ringtoneFor(new Date(2026, 9, 17, 0, 0, 0)).id, 'halloween', '17 Oct 00:00');
assert.strictEqual(ringtoneFor(new Date(2026, 9, 16, 23, 59, 59)).id, 'default', '16 Oct 23:59:59');
assert.strictEqual(ringtoneFor(new Date(2026, 10, 7, 23, 59, 59)).id, 'halloween', '7 Nov 23:59:59');
assert.strictEqual(ringtoneFor(new Date(2026, 10, 8, 0, 0, 0)).id, 'default', '8 Nov 00:00');
ok('it flips at local midnight');

// daylight saving: the changeover days must not shift the window by a day (US/EU clocks change around these dates)
assert.strictEqual(id(2026, 11, 1, 0, 30), 'halloween');
assert.strictEqual(id(2026, 11, 1, 23, 30), 'halloween');
assert.strictEqual(id(2026, 10, 25, 1, 30), 'halloween');
ok('daylight-saving changeover days are not off by one');

// bad input never throws and falls back to the normal ringtone
for (const bad of [new Date('nope'), undefined, null, 5, 'x']) assert.doesNotThrow(() => ringtoneFor(bad));
assert.strictEqual(ringtoneFor(new Date('nope')), DEFAULT_RINGTONE);
assert.strictEqual(ringtoneFor(null), DEFAULT_RINGTONE);
ok('an invalid date falls back to the default');

// windowOf reports the same edges the picker uses
{
  const h = SEASONAL.find((s) => s.id === 'halloween'), c = SEASONAL.find((s) => s.id === 'christmas');
  const hw = windowOf(h, 2026), cw = windowOf(c, 2026);
  assert.deepStrictEqual([hw.from.getMonth() + 1, hw.from.getDate(), hw.to.getMonth() + 1, hw.to.getDate()], [10, 17, 11, 7]);
  assert.deepStrictEqual([cw.from.getMonth() + 1, cw.from.getDate(), cw.to.getFullYear(), cw.to.getMonth() + 1, cw.to.getDate()], [12, 11, 2027, 1, 1]);
  for (const w of [hw, cw]) { assert.strictEqual(ringtoneFor(w.from).id === 'default', false); assert.strictEqual(ringtoneFor(w.to).id === 'default', false); }
}
ok('windowOf matches the picker');

// every ringtone points at a real file that is shipped with the app
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
for (const r of [DEFAULT_RINGTONE, ...SEASONAL]) {
  assert.ok(r.url.startsWith('/sounds/'), r.url);
  const f = path.join(pub, r.url);
  assert.ok(fs.existsSync(f) && fs.statSync(f).size > 10000, 'missing or empty: ' + f);
  assert.strictEqual(fs.readFileSync(f).subarray(0, 3).toString('latin1') === 'ID3' || fs.readFileSync(f)[0] === 0xff, true, 'not an mp3: ' + f);
}
ok('every ringtone file exists and is an mp3');

console.log('\nAll ringtone checks passed.');
