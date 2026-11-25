// The recap scenes without a browser: node client/scripts/recap-test.mjs
import assert from 'node:assert';
import { buildScenes, countText, shareText, TOTAL_MS } from '../src/recap.js';

const step = (m) => console.log('✓', m);
const keys = (s) => s.map((x) => x.key).join(',');
const mine = (extra = {}) => ({ messages: 1200, vcHours: 40, credits: 300, quests: 9, friends: 4, badges: 2, title: 'Night Owl', favoriteHour: 2, topEmoji: '🔥', ...extra });
const data = (m, g = {}) => ({ year: 2026, global: { users: 50, messages: 9000, vcHours: 700, busiestDay: '2026-03-14', topEmoji: '😂', ...g }, mine: m });

{
  const s = buildScenes(data(mine()), 'mine');
  assert.strictEqual(keys(s), 'intro,messages,voice,credits,title,outro');
  assert.deepStrictEqual(s.map((x) => x.anchor), ['c', 'tl', 'br', 'c', 'tr', 'bl']);
  assert.strictEqual(s[0].main.text, 'Your 2026 on Aduna');
  step('own recap: six scenes, each stat in its corner');
}
{
  const s = buildScenes(data(mine({ messages: null, vcHours: 0 })), 'mine');
  assert.strictEqual(keys(s), 'intro,credits,quests,friends,title,outro');
  assert.deepStrictEqual(s.slice(1, 4).map((x) => x.anchor), ['c', 'tl', 'br']);
  assert.ok(!JSON.stringify(s).includes('null'), 'a missing number never shows up');
  step('missing or zero stats are skipped, the next one takes the place');
}
{
  const s = buildScenes(data(mine({ title: null, topPercent: { vc: 12, messages: 30 } })), 'mine');
  const fun = s.find((x) => x.anchor === 'tr');
  assert.strictEqual(countText(fun.main, 0, true), 'Top 12%');
  step('no title: the top percent line');
}
{
  const s = buildScenes(data(null), 'global');
  assert.strictEqual(s[0].main.text, 'Aduna in 2026');
  assert.strictEqual(s.find((x) => x.anchor === 'tr').main.text, 'March 14');
  assert.strictEqual(buildScenes(data(null), 'mine'), null);
  assert.strictEqual(buildScenes({ year: null, global: null, mine: null }, 'global'), null);
  step('global recap, and nothing when there is nothing to show');
}
{
  const s = buildScenes(data(mine()), 'mine');
  const num = s[1].main;
  assert.strictEqual(countText(num, 0), '0');
  assert.strictEqual(countText(num, 450 + 1500), '1,200');
  assert.ok(TOTAL_MS === 30000);
  step('the number climbs from 0 to its value');
}
{
  const text = shareText(buildScenes(data(mine({ title: 'Night Owl' })), 'mine'), 'mine', 2026);
  assert.ok(text.startsWith('My 2026 on Aduna'));
  assert.ok(text.includes('1,200 messages sent'));
  step('share text holds counts only');
}

console.log('recap scenes: all good');
