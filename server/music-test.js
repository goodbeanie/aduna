// Song search rules (music.js) and the game list (gamecatalog.js): node server/music-test.js
// No network and no server: music.js takes the fetch function as an argument.
const assert = require('assert');
const music = require('./music');
const { LIST, appFor } = require('./gamecatalog');
const profile = require('./profile');

const item = (o = {}) => ({
  wrapperType: 'track', kind: 'song', trackId: 111, trackName: 'Midnight City', artistName: 'M83',
  artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music/abc/100x100bb.jpg',
  previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview/v4/x/y/mzaf_1.plus.aac.p.m4a',
  trackViewUrl: 'https://music.apple.com/us/album/midnight-city/1?i=111', ...o,
});
const fakeFetch = (results, calls = []) => async (url) => { calls.push(url); return { ok: true, json: async () => ({ resultCount: results.length, results }) }; };

(async () => {
  // ---- mapItem: only Apple's own addresses are kept ----
  let t = music.mapItem(item());
  assert.deepStrictEqual([t.tid, t.title, t.artist], [111, 'Midnight City', 'M83']);
  assert.ok(t.art.endsWith('/200x200bb.jpg'), 'cover asked for at 200px'); assert.ok(t.link.startsWith('https://music.apple.com/'));
  console.log('✓ a result is read into title, artist, cover, preview and link');
  assert.strictEqual(music.mapItem(item({ previewUrl: 'https://evil.example/a.m4a' })), null); console.log('✓ a preview from another host is refused');
  assert.strictEqual(music.mapItem(item({ previewUrl: 'http://audio-ssl.itunes.apple.com/a.m4a' })), null); console.log('✓ a preview over plain http is refused');
  assert.strictEqual(music.mapItem(item({ previewUrl: undefined })), null); console.log('✓ a song without a preview is skipped');
  assert.strictEqual(music.mapItem(item({ artworkUrl100: 'https://evil.example/a.jpg' })).art, ''); console.log('✓ a cover from another host is dropped (the song stays)');
  assert.strictEqual(music.mapItem(item({ trackViewUrl: 'https://evil.example/x' })).link, undefined); console.log('✓ a link to another host is dropped');
  t = music.mapItem(item({ trackName: '<b>Hi</b>\u0000  there' }));
  assert.ok(!/[<>\u0000]/.test(t.title)); console.log('✓ angle brackets and control characters leave the title');
  assert.strictEqual(music.mapItem(item({ trackId: 'x' })), null);

  // ---- search ----
  const calls = [];
  let list = await music.search('midnight city', fakeFetch([item(), item({ trackId: 222 }), item({ trackId: 333, trackName: 'Other' }), item({ trackId: 444, previewUrl: null })], calls));
  assert.deepStrictEqual(list.map((x) => x.tid), [111, 333]); console.log('✓ search drops repeats of the same song and songs with no preview');
  await music.search('midnight city', fakeFetch([], calls));
  assert.strictEqual(calls.length, 1); console.log('✓ the same search twice asks Apple once');
  assert.deepStrictEqual(await music.search('a', fakeFetch([item()])), []); console.log('✓ a one letter search is not sent');
  await assert.rejects(() => music.search('broken', async () => ({ ok: false })), /bad status/); console.log('✓ a failing service is reported to the caller');

  // ---- lookup ----
  assert.strictEqual((await music.lookup(111, fakeFetch([item()]))).title, 'Midnight City');
  assert.strictEqual(await music.lookup(999, fakeFetch([item()])), null);
  assert.strictEqual(await music.lookup('abc', fakeFetch([item()])), null); console.log('✓ lookup finds the exact id, or nothing');

  // ---- stored tracks are checked again on the way out ----
  const stored = { kind: 'track', tid: 111, title: 'Midnight City', artist: 'M83', art: t.art, preview: item().previewUrl, link: '' };
  const v = profile.songView({ song: stored });
  assert.deepStrictEqual([v.kind, v.tid, v.title, v.url], ['track', 111, 'Midnight City', stored.preview]); console.log('✓ a saved track reaches the card with its preview address');
  assert.strictEqual(profile.songView({ song: { ...stored, preview: 'https://evil.example/a.m4a' } }), null); console.log('✓ a stored track with a bad address is not shown');
  assert.strictEqual(profile.songView({ song: { id: 'a'.repeat(32), title: 'Clip', mime: 'audio/wav' } }).id, 'a'.repeat(32)); console.log('✓ an uploaded clip still comes out as before');

  // ---- the part of the preview that plays ----
  assert.strictEqual(v.start, undefined); assert.strictEqual(v.end, undefined); console.log('✓ a track with no chosen part plays the whole preview');
  const part = profile.songView({ song: { ...stored, start: 8.5, end: 20 } });
  assert.deepStrictEqual([part.start, part.end], [8.5, 20]); console.log('✓ a chosen part reaches the card');
  for (const bad of [{ start: 5, end: 6 }, { start: -3, end: 12 }, { start: 10, end: 99 }, { start: 'a', end: 20 }, { start: 20 }]) {
    const w = profile.songView({ song: { ...stored, ...bad } });
    assert.ok(w && w.start === undefined && w.end === undefined, JSON.stringify(bad));
  }
  console.log('✓ a stored part that is too short or outside the preview is ignored (the song still plays)');
  assert.deepStrictEqual(music.cleanSection(undefined, undefined), { section: null });
  assert.deepStrictEqual(music.cleanSection(0, 30), { section: null });
  assert.deepStrictEqual(music.cleanSection(4.04, 19.96), { section: { start: 4, end: 20 } });
  assert.deepStrictEqual(music.cleanSection(-5, 12), { section: { start: 0, end: 12 } });
  assert.deepStrictEqual(music.cleanSection(10, 500), { section: { start: 10, end: 30 } });
  for (const bad of [[5, 6], [29, 40], [20, 10], ['1', 20], [null, 20], [5, undefined], [NaN, 20]]) assert.ok(music.cleanSection(...bad).error, JSON.stringify(bad));
  console.log('✓ a picked part is rounded to tenths and kept inside the preview; under 3 seconds or nonsense is refused');

  // ---- the game list ----
  assert.ok(LIST.length >= 250, 'a big list: ' + LIST.length);
  assert.ok(LIST.every((g) => g.name && Array.from(g.name).length <= profile.LIMITS.gameName && Number.isInteger(g.app) && g.app >= 0), 'names fit, ids are numbers');
  assert.strictEqual(new Set(LIST.map((g) => g.name.toLowerCase())).size, LIST.length, 'no name twice');
  assert.deepStrictEqual(LIST.map((g) => g.name), [...LIST].map((g) => g.name).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })), 'sorted');
  assert.strictEqual(appFor('  hades '), 1145360); assert.strictEqual(appFor('Minecraft'), 0); assert.strictEqual(appFor('nothing like this'), 0);
  console.log(`✓ the game list: ${LIST.length} games, sorted, every name fits, lookups ignore case`);

  // ---- games on the way in and out ----
  assert.deepStrictEqual(profile.cleanGames(['Hades', { name: 'Mine', app: 7 }, { name: 'Bad', app: -1 }]).list, [{ name: 'Hades', app: 1145360 }, { name: 'Mine', app: 7 }, { name: 'Bad', app: 0 }]);
  assert.deepStrictEqual(profile.gamesView({ games: ['Celeste', { name: 'Mine', app: 7 }, 5, null, { name: '' }] }), [{ name: 'Celeste', app: 504230 }, { name: 'Mine', app: 7 }]);
  console.log('✓ older profiles (plain names) are upgraded on the way out; bad entries are skipped');
  console.log('ALL PASSED');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
