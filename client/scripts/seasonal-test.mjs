// Limited-time themes: node client/scripts/seasonal-test.mjs   (also try TZ=Pacific/Auckland)
import assert from 'assert';
import { SEASONAL_THEMES, seasonalNow, seasonalTheme } from '../src/seasonal.js';
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
console.log('\nAll seasonal theme checks passed.');
