// The recap scenes without a browser: node client/scripts/recap-test.mjs
import assert from 'node:assert';
import { buildScenes, countText, shareText, inThird, recapToken, parseRecapShare, timeline, sceneAt, songWindows, songGain, SHARE_MAX, TOTAL_MS, GLOBAL_TOTAL_MS, totalMs } from '../src/recap.js';

const step = (m) => console.log('✓', m);
const keys = (s) => s.map((x) => x.key).join(',');
const mine = (extra = {}) => ({ messages: 1200, vcHours: 40, credits: 300, quests: 9, friends: 4, badges: 2, title: 'Night Owl', favoriteHour: 2, topEmoji: '🔥', ...extra });
const data = (m, g = {}) => ({ year: 2026, global: { users: 50, messages: 9000, vcHours: 700, busiestDay: '2026-03-14', topEmoji: '😂', ...g }, mine: m });
const servers = [{ name: 'Chess Club', gained: 1400 }, { name: 'Night Shift', gained: 900 }, { name: 'Art Room', gained: 300 }];
const icon = (c) => c.repeat(32);

{
  const s = buildScenes(data(mine()), 'mine');
  assert.strictEqual(keys(s), 'intro,messages,voice,credits,quests,emoji,outro');
  assert.deepStrictEqual(s.map((x) => x.anchor), ['c', 'tl', 'br', 'c', 'bl', 'tr', 'bl']);
  assert.strictEqual(s[0].main.text, 'Your 2026 on Aduna');
  assert.ok(!s.some((x) => x.key === 'title'), 'no title scene any more');
  step('own recap: four stats, each in its own spot, and no title');
}
{
  const s = buildScenes(data(mine({ messages: null, vcHours: 0 })), 'mine');
  assert.strictEqual(keys(s), 'intro,credits,quests,friends,badges,emoji,outro');
  assert.deepStrictEqual(s.slice(1, 5).map((x) => x.anchor), ['c', 'tl', 'br', 'bl']);
  assert.ok(!JSON.stringify(s).includes('null'), 'a missing number never shows up');
  step('missing or zero stats are skipped, the next one takes the place');
}
{
  const s = buildScenes(data(mine({ topPercent: { vc: 12, messages: 30 } })), 'mine');
  const fun = s.find((x) => x.anchor === 'tr');
  assert.strictEqual(countText(fun.main, 0, true), 'Top 12%');
  step('the top percent line');
}
{
  const s = buildScenes(data(null), 'global');
  assert.strictEqual(s[0].main.text, 'Aduna in 2026');
  assert.strictEqual(s.find((x) => x.anchor === 'tr').main.text, 'March 14');
  assert.ok(!s.some((x) => x.key === 'servers'), 'no servers to name, no servers scene');
  assert.strictEqual(buildScenes(data(null), 'mine'), null);
  assert.strictEqual(buildScenes({ year: null, global: null, mine: null }, 'global'), null);
  step('global recap, and nothing when there is nothing to show');
}
{
  const s = buildScenes(data(null, { credits: 500, quests: 12, topServers: servers }), 'global');
  assert.strictEqual(keys(s), 'intro,messages,voice,credits,quests,servers,day,emoji,outro');
  assert.strictEqual(countText(s.find((x) => x.key === 'credits').main, 450 + 1500), '500');
  const list = s.find((x) => x.key === 'servers');
  assert.deepStrictEqual(list.main.list, servers.map((x) => ({ name: x.name, count: x.gained })));
  assert.notStrictEqual(list.anchor, s[s.indexOf(list) - 1].anchor, 'not in the same place as the scene before it');
  const junk = buildScenes(data(null, { topServers: [{ name: '', gained: 5 }, { name: 'Zero', gained: 0 }, null, { name: 'Big'.repeat(30), gained: 7 }] }), 'global');
  assert.deepStrictEqual(junk.find((x) => x.key === 'servers').main.list.map((x) => x.name.length), [32], 'bad rows are dropped and long names cut');
  assert.ok(!buildScenes(data(mine({ messages: 5 }), { topServers: servers }), 'mine').some((x) => x.key === 'servers'), 'own recap has no servers scene');
  assert.ok(shareText(s, 'global', 2026).includes('Fastest growing servers: Chess Club (+1,400), Night Shift (+900), Art Room (+300)'));
  step('global recap: more stats, and the fastest growing servers as one list');
}
{
  const s = buildScenes(data(null, { credits: 500, quests: 12, topServers: servers }), 'global');
  const tl = timeline(s, totalMs('global'));
  const len = (i) => tl[i].to - tl[i].from;
  assert.strictEqual(tl[0].from, 0);
  assert.strictEqual(tl[tl.length - 1].to, GLOBAL_TOTAL_MS);
  assert.ok(tl.every((x, i) => i === 0 || x.from === tl[i - 1].to), 'no gaps between scenes');
  assert.ok(len(5) > len(1) && len(0) < len(1), 'the servers list is longer than a stat, the intro shorter');
  assert.strictEqual(sceneAt(tl, 0), 0);
  assert.strictEqual(sceneAt(tl, tl[2].from), 2);
  assert.strictEqual(sceneAt(tl, GLOBAL_TOTAL_MS), s.length - 1);
  const own = timeline(buildScenes(data(mine()), 'mine'));
  assert.strictEqual(own[own.length - 1].to, TOTAL_MS, 'someone\'s own recap is still 30 seconds');
  step('the time is shared out by scene: 30 seconds for a person, 60 for everyone');
}
{
  assert.deepStrictEqual([totalMs('mine'), totalMs('global')], [30000, 60000]);
  const [only] = songWindows(1, GLOBAL_TOTAL_MS);
  assert.strictEqual(only.to, GLOBAL_TOTAL_MS, 'one song runs the whole 60 seconds (and loops)');
  const [a, b] = songWindows(2, GLOBAL_TOTAL_MS);
  assert.deepStrictEqual([a.from, a.to, b.from, b.to], [0, 31500, 28500, 60000]);
  assert.deepStrictEqual([songGain(a, 30000, GLOBAL_TOTAL_MS), songGain(b, 30000, GLOBAL_TOTAL_MS)], [0.5, 0.5], 'they meet in the middle of the 60 seconds');
  assert.deepStrictEqual([songGain(b, 59000, GLOBAL_TOTAL_MS), songGain(b, 60000, GLOBAL_TOTAL_MS)], [1, 1], 'the end is left to the fade of the whole video');
  for (let t = 0; t <= GLOBAL_TOTAL_MS; t += 250) {
    const sum = songGain(a, t, GLOBAL_TOTAL_MS) + songGain(b, t, GLOBAL_TOTAL_MS);
    assert.ok(sum >= 0.99 && sum <= 1.01, 'the two always add up to one song');
  }
  step('the cross-over moves to the middle of the 60 seconds');
}
{
  const [only] = songWindows(1);
  assert.deepStrictEqual([songGain(only, 0), songGain(only, 20000), songGain(only, TOTAL_MS)], [1, 1, 1], 'one song is not faded here, the video fades it');
  const [a, b] = songWindows(2);
  assert.deepStrictEqual([songGain(a, 5000), songGain(b, 5000)], [1, 0]);
  assert.deepStrictEqual([songGain(a, 25000), songGain(b, 25000)], [0, 1]);
  assert.deepStrictEqual([songGain(a, 15000), songGain(b, 15000)], [0.5, 0.5]);
  assert.strictEqual(songGain(a, 13500), 1); assert.strictEqual(songGain(b, 13500), 0);
  assert.strictEqual(songGain(a, 16500), 0); assert.strictEqual(songGain(b, 16500), 1);
  for (let t = 0; t <= TOTAL_MS; t += 250) assert.ok(songGain(a, t) + songGain(b, t) >= 0.99 && songGain(a, t) + songGain(b, t) <= 1.01, 'the two always add up to one song');
  step('two songs cross over in the middle');
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
  const text = shareText(buildScenes(data(mine()), 'mine'), 'mine', 2026);
  assert.ok(text.startsWith('My 2026 on Aduna'));
  assert.ok(text.includes('1,200 messages sent'));
  assert.ok(!text.includes('Night Owl'));
  step('share text holds counts only');
}

{
  const look = { colors: ['#112233', '#445566', '#c9953a'], angle: 120 };
  const s = inThird(buildScenes(data(mine()), 'mine'), 'Sam');
  assert.strictEqual(s[0].main.text, "Sam's 2026 on Aduna");
  assert.strictEqual(s.find((x) => x.key === 'emoji').unit, "Sam's most-used emoji");
  const t = recapToken(s, { kind: 'mine', year: 2026, look, songs: [{ id: 'abc123', title: 'Night Drive' }] });
  assert.ok(t.startsWith('recap:1:') && t.length <= SHARE_MAX);
  const got = parseRecapShare(t);
  assert.strictEqual(got.kind, 'mine');
  assert.strictEqual(got.year, 2026);
  assert.deepStrictEqual(got.look, look);
  assert.deepStrictEqual(got.songs, [{ id: 'abc123', title: 'Night Drive' }]);
  assert.deepStrictEqual(got.scenes.map((x) => x.anchor), s.map((x) => x.anchor));
  assert.strictEqual(countText(got.scenes[1].main, 0, true), '1,200');
  assert.strictEqual(got.scenes.find((x) => x.key === 'emoji').main.text, '🔥', 'emoji survive the packing');
  step('a recap packs into a token and comes back the same');
}
{
  const look = { colors: ['#112233', '#445566'], angle: 90 };
  const s = buildScenes(data(null, { credits: 500, quests: 12, topServers: servers }), 'global');
  const songs = [{ id: 'one111', title: 'First' }, { id: 'two222', title: 'Second' }];
  const got = parseRecapShare(recapToken(s, { kind: 'global', year: 2026, look, songs }));
  assert.deepStrictEqual(got.songs, songs, 'two songs come back in order');
  assert.deepStrictEqual(got.scenes.find((x) => x.key === 'servers').main.list, servers.map((x) => ({ name: x.name, count: x.gained })));
  const long = [{ url: 'https://audio.example/' + 'a'.repeat(270), title: 'x'.repeat(60) }, { url: 'https://audio.example/' + 'b'.repeat(270), title: 'y'.repeat(60) }];
  const t = recapToken(s, { kind: 'global', year: 2026, look, songs: long });
  assert.ok(t.length <= SHARE_MAX, 'a token that is too long drops songs before it breaks');
  step('a global recap shares its servers list and both songs');
}
{
  const five = ['Chess Club', 'Night Shift', 'Art Room', 'Book Nook', 'Pixel Pals'].map((name, i) => ({ name, gained: 1000 - i * 100, icon: icon('abcde'[i]) }));
  const s = buildScenes(data(null, { credits: 500, quests: 12, friendships: 40, badges: 90, busiestHour: 23, topServers: [...five, { name: 'Sixth', gained: 1 }] }), 'global');
  assert.strictEqual(keys(s), 'intro,messages,voice,credits,quests,friends,badges,servers,day,hour,emoji,outro', 'all six stats, the servers, and three fun ones');
  assert.ok(s.every((x, i) => i === 0 || x.anchor !== s[i - 1].anchor), 'no two scenes in a row in the same place');
  const list = s.find((x) => x.key === 'servers').main.list;
  assert.strictEqual(list.length, 5, 'five servers at most');
  assert.deepStrictEqual(list.map((x) => x.icon), ['a', 'b', 'c', 'd', 'e'].map(icon), 'each server keeps its picture');
  assert.strictEqual(s.find((x) => x.key === 'hour').main.text, '23:00 UTC');
  const bad = buildScenes(data(null, { topServers: [{ name: 'A', gained: 3, icon: 'not-an-id' }, { name: 'B', gained: 2, icon: icon('f') }] }), 'global');
  assert.deepStrictEqual(bad.find((x) => x.key === 'servers').main.list, [{ name: 'A', count: 3 }, { name: 'B', count: 2, icon: icon('f') }], 'a server with no usable picture just has none');
  const noHour = buildScenes(data(null, {}), 'global');
  assert.ok(noHour.every((x, i) => i === 0 || x.anchor !== noHour[i - 1].anchor));
  step('global recap: six stats, five servers with pictures, busiest day, hour and emoji');

  const look = { colors: ['#112233', '#445566'], angle: 90 };
  const t = recapToken(s, { kind: 'global', year: 2026, look, songs: [] });
  assert.ok(t && t.length <= SHARE_MAX, 'the whole thing fits in one message');
  const got = parseRecapShare(t);
  assert.deepStrictEqual(got.scenes.find((x) => x.key === 'servers').main.list.map((x) => x.icon), ['a', 'b', 'c', 'd', 'e'].map(icon), 'the pictures survive the packing');
  assert.strictEqual(got.scenes.length, s.length);
  const songs = [{ url: 'https://audio.example/' + 'a'.repeat(270), title: 'x'.repeat(60) }, { url: 'https://audio.example/' + 'b'.repeat(270), title: 'y'.repeat(60) }];
  const tight = recapToken(s, { kind: 'global', year: 2026, look, songs });
  assert.ok(tight && tight.length <= SHARE_MAX, 'long song links are dropped first');
  step('a full global recap packs into one message, with its server pictures');
}
{
  assert.strictEqual(parseRecapShare('recap:1:not-a-real-token-at-all'), null);
  assert.strictEqual(parseRecapShare('hello'), null);
  const bad = (o) => parseRecapShare('recap:1:' + Buffer.from(JSON.stringify(o)).toString('base64url'));
  const scene = ['intro', 'Hi', '', '', 'c'];
  const ok = { k: 'g', y: 2026, c: ['#112233', '#445566'], a: 90, s: [scene, scene] };
  assert.ok(bad(ok));
  assert.strictEqual(bad({ ...ok, s: [scene] }), null, 'too few scenes');
  assert.strictEqual(bad({ ...ok, s: Array(17).fill(scene) }), null, 'too many scenes');
  assert.strictEqual(bad({ ...ok, s: [scene, ['x', 'y', '', '', 'zz']] }), null, 'unknown anchor');
  assert.strictEqual(bad({ ...ok, s: [scene, ['servers', [['A', 1], ['B', 2], ['C', 3], ['D', 4], ['E', 5], ['F', 6]], '', '', 'c']] }), null, 'more than five servers');
  assert.ok(bad({ ...ok, s: [scene, ['servers', [['A', 1], ['B', 2], ['C', 3], ['D', 4], ['E', 5]], '', '', 'c']] }), 'five is fine');
  assert.strictEqual(bad({ ...ok, s: [scene, ['servers', [['x'.repeat(41), 1]], '', '', 'c']] }), null, 'a server name that is too long');
  assert.strictEqual(bad({ ...ok, s: [scene, ['servers', [['A', -1]], '', '', 'c']] }), null, 'a negative count');
  assert.strictEqual(bad({ ...ok, s: [scene, ['servers', [['A', 1, 'javascript:alert(1)']], '', '', 'c']] }), null, 'a picture that is not an image id');
  assert.strictEqual(bad({ ...ok, s: [scene, ['servers', [['A', 1, icon('a'), 'x']], '', '', 'c']] }), null, 'a row with extra parts');
  assert.deepStrictEqual(bad({ ...ok, s: [scene, ['servers', [['A', 1, icon('a')]], '', '', 'c']] }).scenes[1].main.list, [{ name: 'A', count: 1, icon: icon('a') }]);
  assert.strictEqual(bad({ ...ok, y: 1 }), null);
  assert.strictEqual(bad({ ...ok, c: ['red', 'javascript:1'] }).look, null, 'bad colours fall back to the default look');
  assert.deepStrictEqual(bad({ ...ok, o: { u: 'http://x.example/a.mp3' } }).songs, [], 'only https song links');
  assert.deepStrictEqual(bad({ ...ok, o: { u: 'javascript:alert(1)' } }).songs, []);
  assert.strictEqual(bad({ ...ok, o: [{ i: 'a' }, { i: 'b' }, { i: 'c' }] }).songs.length, 2, 'no more than two songs');
  step('a made-up token is refused or cleaned');
}

console.log('recap scenes: all good');
