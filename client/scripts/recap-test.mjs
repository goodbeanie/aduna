// The recap scenes without a browser: node client/scripts/recap-test.mjs
import assert from 'node:assert';
import { buildScenes, countText, shareText, inThird, recapToken, parseRecapShare, SHARE_MAX, TOTAL_MS } from '../src/recap.js';

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

{
  const look = { colors: ['#112233', '#445566', '#c9953a'], angle: 120 };
  const s = inThird(buildScenes(data(mine()), 'mine'), 'Sam');
  assert.strictEqual(s[0].main.text, "Sam's 2026 on Aduna");
  assert.strictEqual(s.find((x) => x.key === 'title').unit, "Sam's title");
  const t = recapToken(s, { kind: 'mine', year: 2026, look, song: { id: 'abc123', title: 'Night Drive' } });
  assert.ok(t.startsWith('recap:1:') && t.length <= SHARE_MAX);
  const got = parseRecapShare(t);
  assert.strictEqual(got.kind, 'mine');
  assert.strictEqual(got.year, 2026);
  assert.deepStrictEqual(got.look, look);
  assert.deepStrictEqual(got.song, { id: 'abc123', title: 'Night Drive' });
  assert.deepStrictEqual(got.scenes.map((x) => x.anchor), s.map((x) => x.anchor));
  assert.strictEqual(countText(got.scenes[1].main, 0, true), '1,200');
  assert.strictEqual(got.scenes.find((x) => x.key === 'title').sub.includes('🔥'), true, 'emoji survive the packing');
  step('a recap packs into a token and comes back the same');
}
{
  assert.strictEqual(parseRecapShare('recap:1:not-a-real-token-at-all'), null);
  assert.strictEqual(parseRecapShare('hello'), null);
  const bad = (o) => parseRecapShare('recap:1:' + Buffer.from(JSON.stringify(o)).toString('base64url'));
  const scene = ['intro', 'Hi', '', '', 'c'];
  const ok = { k: 'g', y: 2026, c: ['#112233', '#445566'], a: 90, s: [scene, scene] };
  assert.ok(bad(ok));
  assert.strictEqual(bad({ ...ok, s: [scene] }), null, 'too few scenes');
  assert.strictEqual(bad({ ...ok, s: [scene, ['x', 'y', '', '', 'zz']] }), null, 'unknown anchor');
  assert.strictEqual(bad({ ...ok, y: 1 }), null);
  assert.strictEqual(bad({ ...ok, c: ['red', 'javascript:1'] }).look, null, 'bad colours fall back to the default look');
  assert.strictEqual(bad({ ...ok, o: { u: 'http://x.example/a.mp3' } }).song, null, 'only https song links');
  assert.strictEqual(bad({ ...ok, o: { u: 'javascript:alert(1)' } }).song, null);
  step('a made-up token is refused or cleaned');
}

console.log('recap scenes: all good');
