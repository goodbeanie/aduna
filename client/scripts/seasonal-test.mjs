// Limited-time themes: node client/scripts/seasonal-test.mjs   (also try TZ=Pacific/Auckland)
import assert from 'assert';
import { SEASONAL_THEMES, seasonalNow, seasonalTheme } from '../src/seasonal.js';
import { forceSeason, forcedSeason, ringtoneFor } from '../src/ringtones.js';
const ok = (m) => console.log('✓', m);
const at = (y, m, d) => new Date(y, m - 1, d, 12);

assert.strictEqual(seasonalNow(at(2026, 10, 16)), null);
assert.strictEqual(seasonalNow(at(2026, 10, 17)).season, 'halloween');
assert.strictEqual(seasonalNow(at(2026, 11, 7)).season, 'halloween');
assert.strictEqual(seasonalNow(at(2026, 11, 8)), null);
ok('Halloween themes: 17 Oct - 7 Nov (14 days before, 7 after)');

assert.strictEqual(seasonalNow(at(2026, 12, 10)), null);
assert.strictEqual(seasonalNow(at(2026, 12, 11)).season, 'christmas');
assert.strictEqual(seasonalNow(at(2027, 1, 1)).season, 'christmas');
assert.strictEqual(seasonalNow(at(2027, 1, 2)), null);
ok('Christmas themes: 11 Dec - 1 Jan, across New Year');

const h = seasonalNow(at(2026, 10, 22));
assert.deepStrictEqual(h.themes.map((t) => t.id), ['haunted', 'candycorn']);
assert.strictEqual(h.until.getMonth(), 10); assert.strictEqual(h.until.getDate(), 7);
assert.deepStrictEqual(seasonalNow(at(2026, 12, 25)).themes.map((t) => t.id), ['winter', 'candycane']);
ok('each event offers its own two themes, and says when it ends');

assert.strictEqual(seasonalTheme('haunted', at(2026, 10, 31)).id, 'haunted');
assert.strictEqual(seasonalTheme('haunted', at(2026, 12, 25)), null);
assert.strictEqual(seasonalTheme('winter', at(2026, 10, 31)), null);
assert.strictEqual(seasonalTheme('ocean', at(2026, 10, 31)), null);
ok('a limited-time theme is only usable while its own event is open');

const hex = /^#[0-9a-f]{6}$/;
for (const t of SEASONAL_THEMES) { assert(hex.test(t.bg) && hex.test(t.accent) && typeof t.dark === 'boolean' && t.icon && t.name); }
assert.strictEqual(new Set(SEASONAL_THEMES.map((t) => t.id)).size, SEASONAL_THEMES.length);
ok('every theme has valid colours, a name and an icon');
// developer test mode: the event is on whatever the date, with no end date, and the ringtone follows; off again puts the calendar back
{
  const june = at(2026, 6, 15);
  assert.strictEqual(seasonalNow(june), null);
  forceSeason('christmas');
  assert.strictEqual(forcedSeason(), 'christmas');
  const t = seasonalNow(june);
  assert.strictEqual(t.season, 'christmas'); assert.strictEqual(t.until, null);
  assert.deepStrictEqual(t.themes.map((x) => x.id), ['winter', 'candycane']);
  assert.strictEqual(seasonalTheme('winter', june).id, 'winter');
  assert.strictEqual(seasonalTheme('haunted', june), null, 'only the forced event\'s themes');
  assert.strictEqual(ringtoneFor(june).id, 'christmas');
  forceSeason('halloween');
  assert.strictEqual(seasonalNow(at(2026, 12, 25)).season, 'halloween', 'forcing wins over the real calendar');
  forceSeason('easter');
  assert.strictEqual(forcedSeason(), null, 'an unknown event turns it off');
  assert.strictEqual(seasonalNow(june), null);
  forceSeason(null);
  assert.strictEqual(seasonalNow(at(2026, 10, 22)).season, 'halloween', 'and the real calendar is back');
  ok('developer test mode forces an event (themes, no end date, ringtone) and switches off cleanly');
}
console.log('\nAll seasonal theme checks passed.');
