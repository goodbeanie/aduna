// Clip screening rules, with no Express, no database and no outside services: node server/screen-test.js
const assert = require('assert');
const screen = require('./screen');

const step = (m) => console.log('✓', m);
const KEYS = { OPENAI_API_KEY: 'sk-test-secret', AUDD_API_TOKEN: 'audd-test-secret' };
const cfg = screen.settings(KEYS);

(async () => {
  // ---- settings ----
  assert.strictEqual(screen.settings({}).on, false, 'nothing is screened until a service has a key');
  assert.deepStrictEqual([screen.settings({ OPENAI_API_KEY: 'k' }).on, screen.settings({ OPENAI_API_KEY: 'k' }).moderation, screen.settings({ OPENAI_API_KEY: 'k' }).music], [true, true, false], 'one key switches on only its own check');
  assert.deepStrictEqual([screen.settings({ AUDD_API_TOKEN: 't' }).moderation, screen.settings({ AUDD_API_TOKEN: 't' }).music], [false, true]);
  assert.strictEqual(screen.settings({ ...KEYS, CLIP_SCREEN: 'off' }).on, false, 'CLIP_SCREEN=off wins over the keys');
  assert.strictEqual(screen.settings({ ...KEYS, CLIP_COPYRIGHT_ACTION: 'off' }).music, false);
  assert.strictEqual(cfg.musicAction, 'block', 'recognised music is rejected by default');
  assert.strictEqual(cfg.dupeAction, 'review', 'a possible re-post goes to a moderator by default');
  assert.strictEqual(cfg.onError, 'review', 'a check that cannot finish holds the clip by default');
  assert.strictEqual(screen.settings({ ...KEYS, CLIP_SCREEN_FAIL: 'open' }).onError, 'open');
  assert.strictEqual(screen.settings({ ...KEYS, CLIP_SCREEN_FAIL: 'nonsense' }).onError, 'review', 'nonsense falls back to the safe default');
  assert.deepStrictEqual([cfg.review, cfg.block, cfg.frames], [0.5, 0.85, 6]);
  const odd = screen.settings({ ...KEYS, CLIP_SCREEN_REVIEW: '0.9', CLIP_SCREEN_BLOCK: '0.2', CLIP_SCREEN_FRAMES: '99', CLIP_SCREEN_TIMEOUT_S: 'abc' });
  assert.ok(odd.block >= odd.review, 'the reject level is never below the hold level');
  assert.strictEqual(odd.frames, 6, 'a silly number of frames falls back');
  assert.strictEqual(odd.timeoutMs, 60_000);
  step('settings: off without keys, each check follows its own key, safe defaults, nonsense ignored');

  // ---- picture fingerprints ----
  const grad = (f) => Buffer.from(Array.from({ length: 72 }, (_, i) => f(i % 9, Math.floor(i / 9))));
  const flatPic = Buffer.alloc(72, 100);
  assert.strictEqual(screen.dhash(Buffer.alloc(10)), null);
  assert.strictEqual(screen.dhash(flatPic), '0000000000000000', 'a flat picture has no edges');
  assert.ok(screen.flat(screen.dhash(flatPic)), 'and counts as flat');
  const a = grad((x, y) => (x * 20 + y * 7) % 251), b = grad((x, y) => (x * 37 + y * 53) % 241), c = grad((x, y) => ((x * y * 13) + 9 * x) % 233);
  const ha = screen.dhash(a), hb = screen.dhash(b), hc = screen.dhash(c);
  for (const h of [ha, hb, hc]) assert.match(h, /^[0-9a-f]{16}$/);
  assert.strictEqual(screen.distance(ha, ha), 0);
  assert.ok(screen.distance(ha, hb) > 8, 'different pictures are far apart');
  const noisy = Buffer.from(a); for (let i = 0; i < 72; i += 11) noisy[i] = Math.min(255, noisy[i] + 2); // a re-encode: tiny changes
  assert.ok(screen.distance(ha, screen.dhash(noisy)) <= 8, 'the same picture re-encoded stays close');
  step('dHash: flat pictures are ignored, the same picture stays close, different ones are far apart');

  // a "video" is a list of frame hashes; make some that really differ
  const rnd = (seed) => { let s = seed * 2654435761 % 4294967296; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; };
  const pics = Array.from({ length: 12 }, (_, k) => { const r = rnd(k + 1); return screen.dhash(Buffer.from(Array.from({ length: 72 }, () => Math.floor(r() * 256)))); });
  for (let i = 0; i < pics.length; i++) for (let j = i + 1; j < pics.length; j++) assert.ok(screen.distance(pics[i], pics[j]) > 8, `test pictures ${i} and ${j} must be far apart`);
  const video1 = pics.slice(0, 6), video2 = pics.slice(6, 12);
  assert.ok(screen.sameVideo(video1, video1), 'identical');
  assert.ok(screen.sameVideo(video1, [...video1.slice(1), video2[0]]), 'shifted by a frame (a trimmed re-upload) is still the same video');
  assert.ok(screen.sameVideo(video1, [...video2.slice(0, 2), ...video1.slice(0, 4)]) === true, 'four of six frames in common is enough');
  assert.ok(!screen.sameVideo(video1, video2), 'different videos');
  assert.ok(!screen.sameVideo(video1, [...video2.slice(0, 4), ...video1.slice(0, 2)]), 'two frames in common is not enough');
  const blank = Array(6).fill('0000000000000000');
  assert.ok(!screen.sameVideo(blank, blank), 'two black videos are not "the same video"');
  assert.ok(!screen.sameVideo(video1.slice(0, 2), video1.slice(0, 2)), 'two frames are too little to go on');
  assert.ok(!screen.sameVideo(['zz', null, 5, 'ABCDEF'], video1), 'garbage hashes are ignored');
  step('sameVideo: re-encodes and trims match; different, blank and tiny inputs do not');

  const rec = (id, owner, state, hashes, extra = {}) => ({ id, owner, state, screen: { hashes }, ...extra });
  const known = [
    rec('mine', 'ann', 'live', video1),
    rec('theirs', 'bob', 'live', video2),
    rec('gone', 'cat', 'removed', pics.slice(3, 9), { takedown: { at: 1, by: 'moderator' }, purgedAt: 5 }),
    rec('own-removed', 'dan', 'removed', pics.slice(0, 6)),                 // removed by its owner: not a takedown
    rec('expired', 'eve', 'expired', pics.slice(6, 12), { purgedAt: 5 }),
    { id: 'old', owner: 'fay', state: 'live' },                              // posted before screening existed: no fingerprints
  ];
  assert.deepStrictEqual(screen.findDuplicate(video2, known, { ownerId: 'ann', selfId: 'x' }), { kind: 'repost', clipId: 'theirs' }, "someone else's live clip");
  assert.strictEqual(screen.findDuplicate(video2, known, { ownerId: 'bob', selfId: 'x' }), null, 'your own earlier clip does not count');
  assert.deepStrictEqual(screen.findDuplicate(pics.slice(3, 9), known, { ownerId: 'zed', selfId: 'x' }), { kind: 'removed', clipId: 'gone' }, 'a clip a moderator removed matches whoever posts it');
  assert.deepStrictEqual(screen.findDuplicate(pics.slice(3, 9), known, { ownerId: 'cat', selfId: 'x' }), { kind: 'removed', clipId: 'gone' }, 'including the person it came from');
  assert.strictEqual(screen.findDuplicate(pics.slice(0, 6), known, { ownerId: 'zed', selfId: 'ann-new' }).clipId, 'mine', "ann's clip is still live, so it is someone else's for zed");
  assert.strictEqual(screen.findDuplicate(pics.slice(0, 6), known.filter((k) => k.id !== 'mine'), { ownerId: 'zed', selfId: 'x' }), null, 'removed by its owner or expired: nothing to compare against');
  assert.strictEqual(screen.findDuplicate(video2, known, { ownerId: 'zed', selfId: 'theirs' })?.clipId === 'theirs', false, 'a clip is never compared with itself');
  step('findDuplicate: re-posts of other people\u2019s live clips and of moderator takedowns, nothing else');

  // ---- the moderation verdict ----
  const f = (sexual = 0, violence = 0, graphic = 0, cover = false) => ({ cover, scores: { sexual, violence, 'violence/graphic': graphic } });
  const clean = [f(), f(), f(), f(), f(), f()];
  assert.strictEqual(screen.judgeImages(clean, cfg).verdict, 'pass');
  assert.strictEqual(screen.judgeImages([], cfg).verdict, 'pass', 'no pictures, nothing to judge');
  assert.deepStrictEqual(screen.judgeImages([f(0.3, 0.6, 0.2), f(0.49, 0.74, 0.49), f()], cfg).verdict, 'pass', 'below the hold levels, and plain violence needs 0.75');
  const one = screen.judgeImages([...clean.slice(0, 5), f(0.9)], cfg);
  assert.strictEqual(one.verdict, 'review', 'one very high frame is held for a person, not rejected');
  assert.deepStrictEqual(one.labels, ['nudity or sexual content']);
  assert.strictEqual(screen.judgeImages([f(0.9), f(0.88), ...clean.slice(0, 4)], cfg).verdict, 'block', 'two high frames reject it');
  assert.strictEqual(screen.judgeImages([f(0.9), f(0.6), ...clean.slice(0, 4)], cfg).verdict, 'review', 'one high and one middling is held');
  assert.strictEqual(screen.judgeImages([f(0.6), ...clean.slice(0, 5)], cfg).verdict, 'review', 'a middling frame is held');
  assert.strictEqual(screen.judgeImages([f(0.9, 0, 0, true), ...clean], cfg).verdict, 'block', 'the cover picture is rejected on its own: somebody chose it');
  assert.strictEqual(screen.judgeImages([f(0.6, 0, 0, true), ...clean], cfg).verdict, 'review', 'a middling cover is held');
  assert.strictEqual(screen.judgeImages([f(0, 0, 0.9), f(0, 0, 0.9), ...clean.slice(0, 4)], cfg).verdict, 'block', 'graphic violence is judged like nudity');
  assert.strictEqual(screen.judgeImages([f(0, 0.8), ...clean.slice(0, 5)], cfg).verdict, 'review', 'plain violence above 0.75 is only ever held');
  assert.strictEqual(screen.judgeImages([f(0, 0.96), f(0, 0.96), ...clean.slice(0, 4)], cfg).verdict, 'review', 'plain violence is not rejected below 0.97');
  assert.strictEqual(screen.judgeImages([f(0, 0.98), f(0, 0.99), ...clean.slice(0, 4)], cfg).verdict, 'block');
  assert.strictEqual(screen.judgeImages([f(0.9), f(0.9)], cfg).verdict, 'block', 'a clip that gave fewer than 3 frames is rejected on one');
  const both = screen.judgeImages([f(0.6, 0, 0.6), ...clean.slice(0, 5)], cfg);
  assert.deepStrictEqual(both.labels, ['nudity or sexual content', 'graphic violence'], 'both are named');
  assert.strictEqual(both.max.sexual, 0.6);
  const strict = screen.settings({ ...KEYS, CLIP_SCREEN_REVIEW: '0.2', CLIP_SCREEN_BLOCK: '0.4' });
  assert.strictEqual(screen.judgeImages([f(0.3), ...clean.slice(0, 5)], strict).verdict, 'review', 'the levels can be tightened');
  assert.strictEqual(screen.judgeImages([f(0.45), f(0.45), ...clean.slice(0, 4)], strict).verdict, 'block');
  step('moderation: one frame holds, two reject, the cover rejects alone, plain violence is held to a higher bar, levels are adjustable');

  // ---- the decision ----
  const none = { mod: { verdict: 'pass', labels: [], max: { sexual: 0.01, violence: 0, 'violence/graphic': 0 }, frames: 7 }, music: { match: null }, dupe: null, errors: [], hashes: [] };
  const clear = screen.decide(none, cfg);
  assert.deepStrictEqual([clear.verdict, clear.reasons, clear.message, clear.incomplete], ['pass', [], '', false]);
  const naked = screen.decide({ ...none, mod: { verdict: 'block', labels: ['nudity or sexual content'], max: { sexual: 0.97, violence: 0, 'violence/graphic': 0 }, frames: 7 } }, cfg);
  assert.strictEqual(naked.verdict, 'block');
  assert.match(naked.message, /^This clip cannot be posted: it looks like it contains nudity or sexual content\.$/);
  const song = screen.decide({ ...none, music: { match: { artist: 'The Band', title: 'Big Hit' } } }, cfg);
  assert.strictEqual(song.verdict, 'block');
  assert.match(song.message, /“Big Hit” by The Band/);
  assert.match(song.message, /without that music/);
  assert.strictEqual(screen.decide({ ...none, music: { match: { artist: 'The Band', title: 'Big Hit' } } }, screen.settings({ ...KEYS, CLIP_COPYRIGHT_ACTION: 'review' })).verdict, 'review', 'music can be held instead');
  assert.strictEqual(screen.decide({ ...none, music: { match: { artist: 'X', title: 'Y' } } }, screen.settings({ ...KEYS, CLIP_COPYRIGHT_ACTION: 'off' })).verdict, 'pass', 'or ignored');
  const twice = screen.decide({ ...none, mod: { verdict: 'block', labels: ['graphic violence'], max: { sexual: 0, violence: 0, 'violence/graphic': 0.9 }, frames: 7 }, music: { match: { artist: 'A', title: 'B' } } }, cfg);
  assert.deepStrictEqual(twice.reasons, ['content', 'music']);
  assert.match(twice.message, /graphic violence; and it has music/);
  const held = screen.decide({ ...none, mod: { verdict: 'review', labels: ['violence'], max: { sexual: 0, violence: 0.8, 'violence/graphic': 0 }, frames: 7 } }, cfg);
  assert.strictEqual(held.verdict, 'review');
  assert.match(held.message, /waiting for a moderator/);
  assert.match(held.summary, /Content \(unsure\): violence/);
  assert.strictEqual(held.message.includes('violence'), false, 'a clip held for review is not told why: only moderators see the reason');
  const repost = screen.decide({ ...none, dupe: { kind: 'repost', clipId: 'c1' } }, cfg);
  assert.strictEqual(repost.verdict, 'review');
  assert.match(repost.summary, /another person posted \(c1\)/);
  assert.strictEqual(screen.decide({ ...none, dupe: { kind: 'removed', clipId: 'c2' } }, screen.settings({ ...KEYS, CLIP_DUPES_ACTION: 'block' })).verdict, 'block');
  assert.match(screen.decide({ ...none, dupe: { kind: 'removed', clipId: 'c2' } }, screen.settings({ ...KEYS, CLIP_DUPES_ACTION: 'block' })).message, /removed from Clips/);
  assert.strictEqual(screen.decide({ ...none, dupe: { kind: 'removed', clipId: 'c2' } }, screen.settings({ ...KEYS, CLIP_DUPES_ACTION: 'off' })).verdict, 'pass');
  // a check that could not finish
  const broke = { ...none, errors: ['music: HTTP 500'] };
  const brokeHeld = screen.decide(broke, cfg);
  assert.deepStrictEqual([brokeHeld.verdict, brokeHeld.reasons, brokeHeld.incomplete], ['review', ['incomplete'], true], 'an unfinished check holds the clip by default');
  assert.match(brokeHeld.summary, /Not fully checked: music: HTTP 500/);
  assert.strictEqual(screen.decide(broke, screen.settings({ ...KEYS, CLIP_SCREEN_FAIL: 'open' })).verdict, 'pass', 'or lets it through when the owner prefers');
  assert.strictEqual(screen.decide({ ...broke, mod: { verdict: 'block', labels: ['nudity or sexual content'], max: { sexual: 1, violence: 0, 'violence/graphic': 0 }, frames: 5 } }, screen.settings({ ...KEYS, CLIP_SCREEN_FAIL: 'open' })).verdict, 'block', 'what WAS found still counts');
  step('decision: messages, per-check actions, the safe default when a check fails');

  // ---- the record kept on the clip ----
  const stored = screen.record({ ...none, hashes: pics.slice(0, 6), music: { match: { artist: 'A\nB', title: 'T' } }, dupe: { kind: 'repost', clipId: 'c1' } }, repost, 1234);
  assert.deepStrictEqual([stored.at, stored.verdict, stored.hashes.length, stored.music, stored.dupe.clipId, stored.mod.sexual], [1234, 'review', 6, { artist: 'A B', title: 'T' }, 'c1', 0.01]);
  assert.ok(JSON.stringify(stored).length < 1500, 'the record stays small');
  step('the record kept on the clip is small and carries the fingerprints');

  // ---- analyze() with stand-in services ----
  const media = (o = {}) => ({ frames: Array.from({ length: 6 }, (_, i) => Buffer.from('frame' + i)), hashes: pics.slice(0, 6), hasAudio: true, wav: Buffer.from('wav'), silent: false, audioSeconds: 10, ...o });
  const base = { video: Buffer.from('v'), seconds: 10, poster: { buf: Buffer.from('cover'), type: 'image/png' }, known: { clips: known, ownerId: 'zed', selfId: 'new' } };
  const calls = { images: [], music: 0 };
  const deps = (o = {}) => ({
    extract: async () => media(o.media),
    moderateImage: async (buf, type) => { calls.images.push([buf.toString(), type]); return (o.scores && o.scores(buf.toString())) || { sexual: 0, violence: 0, 'violence/graphic': 0 }; },
    recognizeMusic: async () => { calls.music++; if (o.musicError) throw new Error(o.musicError); return o.song || null; },
  });
  let got = await screen.analyze(base, cfg, deps());
  assert.deepStrictEqual([got.errors, got.mod.verdict, got.music, got.hashes.length], [[], 'pass', { match: null }, 6]);
  assert.strictEqual(calls.images.length, 7, 'six frames and the cover picture');
  assert.deepStrictEqual(calls.images[0], ['cover', 'image/png'], 'the cover goes with its own type');
  assert.strictEqual(calls.images[1][1], 'image/jpeg');
  assert.ok(got.dupe && got.dupe.kind === 'repost', 'the clip is a copy of a live one in the list');
  got = await screen.analyze(base, cfg, deps({ scores: (s) => (s === 'cover' ? { sexual: 0.95, violence: 0, 'violence/graphic': 0 } : undefined) }));
  assert.strictEqual(screen.decide(got, cfg).verdict, 'block', 'a bad cover picture rejects the clip');
  got = await screen.analyze(base, cfg, deps({ song: { artist: 'A', title: 'B' } }));
  assert.deepStrictEqual(got.music.match, { artist: 'A', title: 'B' });
  calls.music = 0;
  await screen.analyze(base, cfg, deps({ media: { hasAudio: false, wav: null } }));
  await screen.analyze(base, cfg, deps({ media: { silent: true } }));
  await screen.analyze(base, cfg, deps({ media: { audioSeconds: 1 } }));
  assert.strictEqual(calls.music, 0, 'no sound, silence and a blip are not sent to the music service (it charges per request)');
  got = await screen.analyze(base, cfg, deps({ musicError: 'HTTP 500' }));
  assert.deepStrictEqual(got.errors, ['music: HTTP 500'], 'a service that fails is reported, not thrown');
  got = await screen.analyze(base, cfg, { ...deps(), moderateImage: async (buf) => { if (buf.toString() === 'frame2') throw new Error('HTTP 429'); return { sexual: 0, violence: 0, 'violence/graphic': 0 }; } });
  assert.match(got.errors[0], /moderation: 1 of 7 pictures could not be checked \(HTTP 429\)/);
  assert.strictEqual(got.mod.frames, 6, 'the other pictures were still judged');
  got = await screen.analyze(base, cfg, { ...deps(), extract: async () => { throw new Error('ffmpeg is not installed'); } });
  assert.deepStrictEqual([got.errors, got.hashes, got.mod.frames], [['video: ffmpeg is not installed'], [], 1], 'if the video cannot be cut up, the cover is still checked');
  const only = screen.settings({ OPENAI_API_KEY: 'k' });
  calls.music = 0;
  await screen.analyze(base, only, deps());
  assert.strictEqual(calls.music, 0, 'no music key: no music check');
  const noDupes = await screen.analyze(base, screen.settings({ ...KEYS, CLIP_DUPES_ACTION: 'off' }), deps());
  assert.strictEqual(noDupes.dupe, null, 're-post checking can be switched off');
  step('analyze: frames and cover go to moderation, sound only when there is some, failures are reported not thrown');

  // ---- a place in line, and a time limit ----
  let running = 0, peak = 0;
  const slow = { ...deps(), extract: async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 40)); running--; return media(); } };
  await Promise.all([1, 2, 3, 4].map(() => screen.screenClip(base, screen.settings({ ...KEYS, CLIP_SCREEN_CONCURRENCY: '2' }), slow)));
  assert.strictEqual(peak, 2, 'only two clips are cut up at once');
  running = 0; peak = 0;
  await Promise.all([1, 2, 3].map(() => screen.screenClip(base, cfg, slow)));
  assert.strictEqual(peak, 1, 'one at a time by default');
  const tiny = { ...cfg, timeoutMs: 50 };
  const late = await screen.screenClip(base, tiny, { ...deps(), extract: async () => { await new Promise((r) => setTimeout(r, 400)); return media(); } });
  assert.deepStrictEqual(late.errors, ['screening: took too long'], 'a screening that takes too long gives up');
  assert.strictEqual(screen.decide(late, cfg).verdict, 'review', 'and the clip is held');
  await new Promise((r) => setTimeout(r, 450)); // let the abandoned one finish so it cannot hold the line up
  const boom = await screen.screenClip(base, cfg, { ...deps(), extract: async () => { throw new Error('x'); }, moderateImage: () => { throw new Error('sync boom'); } });
  assert.ok(boom.errors.length >= 1, 'even a service that throws at once is caught');
  step('screenClip: concurrency limit, time limit, nothing escapes');

  // ---- WAV loudness ----
  const wav = (samples, extra = false) => {
    const data = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
    const head = Buffer.alloc(44);
    head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8, 'latin1'); head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(16000, 24); head.writeUInt32LE(32000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
    head.write('data', 36, 'latin1'); head.writeUInt32LE(data.length, 40);
    if (!extra) return Buffer.concat([head, data]);
    const list = Buffer.alloc(8 + 5); list.write('LIST', 0, 'latin1'); list.writeUInt32LE(5, 4); // odd size: padded to even
    return Buffer.concat([head.subarray(0, 36), list, Buffer.alloc(1), head.subarray(36), data]);
  };
  const loud = Array.from({ length: 32000 }, (_, i) => Math.round(Math.sin(i / 5) * 12000));
  assert.ok(screen.pcmStats(wav(loud)).rms > 0.2);
  assert.strictEqual(Math.round(screen.pcmStats(wav(loud)).seconds), 2);
  assert.ok(screen.pcmStats(wav(loud, true)).rms > 0.2, 'extra header chunks are skipped');
  assert.ok(screen.pcmStats(wav(Array(16000).fill(0))).rms < 0.002, 'silence');
  assert.ok(screen.pcmStats(wav(Array.from({ length: 16000 }, (_, i) => (i % 2 ? 20 : -20)))).rms < 0.002, 'a faint hiss counts as silence');
  assert.deepStrictEqual(screen.pcmStats(Buffer.from('nope')), { rms: 0, seconds: 0 });
  step('pcmStats: loudness and length, extra header chunks, silence');

  // ---- the outside services (stand-in fetch) ----
  let sent = null;
  const okFetch = (body) => async (url, init) => { sent = { url, init }; return { ok: true, status: 200, json: async () => body }; };
  const scores = await screen.moderateImage(Buffer.from('jpeg'), 'image/jpeg', cfg, okFetch({ results: [{ category_scores: { sexual: 0.2, violence: 0.1, 'violence/graphic': 0.05, hate: 0.9 } }] }));
  assert.deepStrictEqual(scores, { sexual: 0.2, violence: 0.1, 'violence/graphic': 0.05 });
  assert.strictEqual(sent.url, 'https://api.openai.com/v1/moderations');
  const req = JSON.parse(sent.init.body);
  assert.strictEqual(req.model, 'omni-moderation-latest');
  assert.strictEqual(req.input[0].type, 'image_url');
  assert.strictEqual(req.input[0].image_url.url, 'data:image/jpeg;base64,' + Buffer.from('jpeg').toString('base64'));
  assert.strictEqual(sent.init.headers.Authorization, 'Bearer sk-test-secret');
  await assert.rejects(screen.moderateImage(Buffer.from('x'), 'image/png', cfg, okFetch({ results: [] })), /unexpected answer/);
  let tries = 0;
  const flaky = async () => (++tries === 1 ? { ok: false, status: 429 } : { ok: true, status: 200, json: async () => ({ results: [{ category_scores: { sexual: 0.1 } }] }) });
  assert.strictEqual((await screen.moderateImage(Buffer.from('x'), 'image/png', cfg, flaky)).sexual, 0.1);
  assert.strictEqual(tries, 2, 'a busy service (429) is asked once more');
  tries = 0;
  await assert.rejects(screen.moderateImage(Buffer.from('x'), 'image/png', cfg, async () => { tries++; return { ok: false, status: 401 }; }), (e) => e.message === 'HTTP 401' && !/sk-test/.test(e.message));
  assert.strictEqual(tries, 1, 'a refused key is not retried, and never appears in the error');

  assert.deepStrictEqual(await screen.recognizeMusic(Buffer.from('wav'), cfg, okFetch({ status: 'success', result: { artist: ' The Band\n', title: 'Big Hit', album: 'x' } })), { artist: 'The Band', title: 'Big Hit' });
  assert.ok(sent.init.body instanceof FormData);
  assert.strictEqual(sent.init.body.get('api_token'), 'audd-test-secret');
  assert.strictEqual(sent.init.body.get('file').name, 'clip.wav');
  assert.strictEqual(await screen.recognizeMusic(Buffer.from('wav'), cfg, okFetch({ status: 'success', result: null })), null, 'no match');
  await assert.rejects(screen.recognizeMusic(Buffer.from('wav'), cfg, okFetch({ status: 'error', error: { error_code: 901, error_message: 'Recognition failed: no tokens left' } })), /no tokens left/);
  await assert.rejects(screen.recognizeMusic(Buffer.from('wav'), cfg, async () => ({ ok: false, status: 503 })), /HTTP 503/);
  step('outside services: request shapes, retry on 429 only, errors never carry the keys');

  console.log('\nscreen: all good');
})().catch((e) => { console.error(e); process.exit(1); });
