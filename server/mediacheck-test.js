// Picture check on the server: node server/mediacheck-test.js
// Part 1 and 2 run anywhere (2 uses the real ffmpeg and model, and is skipped without ffmpeg). Part 3 runs the routes and needs TEST_DATABASE_URL (see test-env.js).
process.env.SAFETY_HEADER = 'on';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const mc = require('./mediacheck');

const step = (m) => console.log('✓', m);
const FB = mc.FRAME_BYTES;
const cfg = { ...mc.settings({ MEDIA_CHECK: 'on' }) };

function crc32(buf) { let crc = 0xffffffff; for (const byte of buf) { crc ^= byte; for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const t = Buffer.from(type, 'latin1'), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); }
let marker = 0;
function makePng(w, h) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('Comment\0m' + ++marker, 'latin1')), chunk('IDAT', zlib.deflateSync(Buffer.alloc((w * 3 + 1) * h, 0x7f))), chunk('IEND', Buffer.alloc(0))]);
}

async function logic() {
  const ascii = (s, n = 64) => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.alloc(n)]);
  const kinds = [
    [makePng(4, 4), 'image', 'image/png'],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]), 'image', 'image/jpeg'],
    [ascii('GIF89a'), 'image', 'image/gif'],
    [Buffer.concat([ascii('RIFF', 0), Buffer.from([0, 0, 0, 0]), ascii('WEBPVP8 ')]), 'image', 'image/webp'],
    [Buffer.concat([Buffer.from([0, 0, 0, 24]), ascii('ftypisom')]), 'video', 'video/mp4'],
    [Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]), 'video', 'video/webm'],
    [ascii('ID3'), 'audio', 'audio/mpeg'],
    [Buffer.from('just some text in a file\n'), 'other', ''],
    [Buffer.concat([Buffer.from([1, 2, 3, 0, 5, 6, 7, 8]), Buffer.alloc(40)]), 'unknown', ''],
  ];
  for (const [buf, kind, mime] of kinds) { const s = mc.sniff(buf); assert.deepStrictEqual([s.kind, s.mime], [kind, mime], 'sniff ' + (mime || kind)); }
  const vp8x = (flags) => { const b = Buffer.alloc(40); b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1'); b[20] = flags; return b; };
  assert.strictEqual(mc.sniff(vp8x(0x02)).animated, true, 'animated WebP');
  assert.strictEqual(mc.sniff(vp8x(0x10)).animated, false, 'still WebP with alpha');
  step('files are told apart by their bytes');

  assert.strictEqual(mc.settleType('video/mp4', { kind: 'image', mime: 'image/png' }), 'image/png', 'a picture called a video is a picture');
  assert.strictEqual(mc.settleType('image/png', { kind: 'other', mime: '' }), 'application/octet-stream', 'text called a picture is a download');
  assert.strictEqual(mc.settleType('image/png', { kind: 'video', mime: 'video/mp4' }), 'application/octet-stream');
  assert.strictEqual(mc.settleType('audio/webm', { kind: 'video', mime: 'video/webm' }), 'audio/webm', 'webm holds audio or video: the sender is believed');
  assert.strictEqual(mc.settleType('video/mp4', { kind: 'audio', mime: 'audio/mpeg' }), 'audio/mpeg');
  assert.strictEqual(mc.settleType('application/octet-stream', { kind: 'image', mime: 'image/gif' }), 'image/gif', 'a picture sent as a plain file is still a picture');
  step('an attachment gets the type it really has');

  assert.strictEqual(mc.verdictOf([{ className: 'Porn', probability: 0.65 }]), 'block');
  assert.strictEqual(mc.verdictOf([{ className: 'Porn', probability: 0.2 }, { className: 'Hentai', probability: 0.15 }]), 'blur');
  assert.strictEqual(mc.verdictOf([{ className: 'Sexy', probability: 0.7 }]), 'blur');
  assert.strictEqual(mc.verdictOf([{ className: 'Neutral', probability: 0.9 }]), 'ok');
  assert.deepStrictEqual(mc.plan(3.2, 40), { count: 4, fps: 4 / 3.2 });
  assert.strictEqual(mc.plan(600, 40).count, 40);
  assert.strictEqual(mc.plan(0, 40).count, 8);
  assert.strictEqual(mc.settings({ NODE_ENV: 'test' }).on, false);
  assert.strictEqual(mc.settings({ NODE_ENV: 'test', MEDIA_CHECK: 'on' }).on, true);
  assert.strictEqual(mc.settings({}).on, true);
  assert.strictEqual(mc.settings({ MEDIA_CHECK_FAIL: 'open' }).failOpen, true);
  step('thresholds, frame plan and switches');

  const seq = (...v) => { let i = 0; return async () => v[Math.min(i++, v.length - 1)]; };
  const png = makePng(4, 4), mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), ascii('ftypisom')]), text = Buffer.from('hello there');
  const deps = (classify, frames = async () => Buffer.alloc(FB * 3)) => ({ frames, classify });
  let r = await mc.check(png, { cfg, deps: deps(seq('ok', 'ok', 'ok')) });
  assert.deepStrictEqual([r.verdict, r.frames, r.kind], ['ok', 3, 'image']);
  r = await mc.check(mp4, { cfg, deps: deps(seq('ok', 'block', 'ok')) });
  assert.deepStrictEqual([r.verdict, r.frames], ['block', 3], 'the worst frame counts');
  r = await mc.check(mp4, { cfg, deps: deps(seq('ok', 'blur', 'ok')) });
  assert.strictEqual(r.verdict, 'blur');
  assert.strictEqual((await mc.check(text, { cfg, deps: deps(seq('block')) })).verdict, 'skipped', 'text is not looked at');
  assert.strictEqual((await mc.check(mp4, { cfg: { ...cfg, on: false }, deps: deps(seq('block')) })).verdict, 'skipped', 'switched off');
  const audioOnly = async () => { throw Object.assign(new Error('no picture'), { code: 'NOT_MEDIA' }); };
  assert.strictEqual((await mc.check(mp4, { cfg, deps: deps(seq('block'), audioOnly) })).verdict, 'skipped', 'audio in a video container is let through');
  const unreadable = async () => { throw Object.assign(new Error('could not read'), { code: 'UNREADABLE' }); };
  await assert.rejects(() => mc.check(png, { cfg, deps: deps(seq('ok'), unreadable) }), (e) => e.code === 'UNAVAILABLE', 'a picture that cannot be read is not let through');
  assert.strictEqual((await mc.check(Buffer.concat([Buffer.from([1, 2, 3, 0]), Buffer.alloc(40)]), { cfg, deps: deps(seq('block'), unreadable) })).verdict, 'skipped', 'unknown bytes ffmpeg cannot open are not media');
  step('check: worst frame wins, text and audio pass, unreadable media is refused');

  await assert.rejects(() => mc.guardPublic(png, { cfg, deps: deps(seq('block')) }), (e) => e.code === 'MEDIA_REFUSED' && e.status === 422 && e.message === mc.EXPLICIT_MSG);
  await assert.rejects(() => mc.guardPublic(png, { cfg, deps: deps(seq('blur')) }), (e) => e.code === 'MEDIA_REFUSED' && e.message === mc.SUGGESTIVE_MSG, 'a public picture cannot be blurred, so suggestive is refused');
  assert.strictEqual((await mc.guardChat(png, { cfg, deps: deps(seq('blur')) })).verdict, 'blur', 'chat shows suggestive pictures blurred');
  await assert.rejects(() => mc.guardChat(png, { cfg, deps: deps(seq('block')) }), (e) => e.code === 'MEDIA_REFUSED');
  const broken = { frames: async () => { throw Object.assign(new Error('ffmpeg is not installed'), { code: 'UNAVAILABLE' }); }, classify: seq('ok') };
  await assert.rejects(() => mc.guardPublic(png, { cfg, deps: broken }), (e) => e.code === 'MEDIA_REFUSED' && e.message === mc.UNAVAILABLE_MSG, 'no check, no file');
  assert.strictEqual((await mc.guardPublic(png, { cfg: { ...cfg, failOpen: true }, deps: broken })).verdict, 'skipped', 'MEDIA_CHECK_FAIL=open lets it through');
  assert.strictEqual((await mc.guardChat(png, { cfg, deps: broken })).verdict, 'skipped', 'a channel attachment is saved when the check cannot run');
  await assert.rejects(() => mc.guardChat(png, { cfg: { ...cfg, chatFailOpen: false }, deps: broken }), (e) => e.code === 'MEDIA_REFUSED' && e.message === mc.UNAVAILABLE_MSG, 'MEDIA_CHECK_FAIL=closed refuses it');
  assert.strictEqual(mc.settings({}).chatFailOpen, true);
  assert.strictEqual(mc.settings({ MEDIA_CHECK_FAIL: 'closed' }).chatFailOpen, false);
  const busy = { frames: async () => { throw Object.assign(new Error('busy'), { code: 'BUSY' }); }, classify: seq('ok') };
  await assert.rejects(() => mc.guardChat(png, { cfg, deps: busy }), (e) => e.code === 'MEDIA_REFUSED' && e.message === mc.BUSY_MSG, 'a busy server never lets files through unchecked');
  await assert.rejects(() => mc.guardChat(png, { cfg, deps: deps(seq('ok'), unreadable) }), (e) => e.code === 'MEDIA_REFUSED' && e.message === mc.UNAVAILABLE_MSG, 'a picture ffmpeg cannot read is refused even in a chat, so a crafted file cannot get around the check');
  step('guards: explicit refused, suggestive refused for public pictures only, public pictures fail closed, chat attachments fail open');
}

function ffmpegPath() {
  let bin = 'ffmpeg';
  try { bin = require('ffmpeg-static') || bin; } catch { /* optional */ }
  try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); return bin; } catch { return null; }
}

async function real() {
  const bin = ffmpegPath();
  if (!bin) { console.log('- no ffmpeg here, skipping the real format checks'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aduna-mc-'));
  const make = (name, args) => {
    try { execFileSync(bin, ['-y', '-hide_banner', '-v', 'error', ...args, path.join(dir, name)], { stdio: 'pipe' }); return fs.readFileSync(path.join(dir, name)); }
    catch (e) { console.log('- could not make', name + ':', String(e.stderr || e.message).trim().split(/\r?\n/).pop()); return null; }
  };
  const lavfi = (src) => ['-f', 'lavfi', '-i', src];
  const files = {
    png: makePng(64, 48),
    webp: make('a.webp', [...lavfi('testsrc=s=64x64'), '-frames:v', '1', '-c:v', 'libwebp']),
    animatedWebp: make('b.webp', [...lavfi('testsrc=d=2:s=64x64:r=5'), '-c:v', 'libwebp', '-loop', '0']),
    gif: make('a.gif', [...lavfi('testsrc=d=2:s=64x64:r=5')]),
    mp4: make('a.mp4', [...lavfi('testsrc=d=3:s=64x64:r=10'), '-pix_fmt', 'yuv420p']),
  };
  const audio = {
    wav: make('a.wav', lavfi('sine=d=1')),
    webm: make('a.webm', [...lavfi('sine=d=1'), '-c:a', 'libvorbis']),
  };
  const started = Date.now();
  for (const [name, buf] of Object.entries(files)) {
    if (!buf) continue;
    let r;
    try { r = await mc.check(buf, { cfg }); }
    catch (e) {
      if (name === 'animatedWebp' && e.code === 'UNSUPPORTED') { console.log('  animatedWebp: refused, this ffmpeg cannot decode animation'); continue; }
      throw e;
    }
    assert.ok(['ok', 'blur', 'block'].includes(r.verdict) && r.frames >= 1, name + ' was looked at: ' + JSON.stringify(r));
    console.log('  ' + name + ':', r.verdict, r.frames + ' frame(s),', r.kind);
  }
  if (!files.webp) console.log('! WebP was not tested: this ffmpeg cannot write one');
  assert.ok(files.png && files.mp4, 'ffmpeg should be able to make these');
  step('real files: PNG, WebP, GIF and MP4 go through ffmpeg and the model (' + Math.round((Date.now() - started) / 1000) + 's)');

  const renamed = await mc.check(files.mp4, { cfg });
  assert.strictEqual(renamed.kind, 'video', 'a video is a video whatever its name is');
  for (const [name, buf] of Object.entries(audio)) if (buf) assert.strictEqual((await mc.check(buf, { cfg })).verdict, 'skipped', name + ' is audio only');
  assert.strictEqual((await mc.check(Buffer.from('plain text, not a picture'), { cfg })).verdict, 'skipped');
  await assert.rejects(() => mc.check(Buffer.concat([files.png.subarray(0, 12), Buffer.alloc(200, 7)]), { cfg }), (e) => e.code === 'UNAVAILABLE', 'a broken picture is refused');
  await assert.rejects(() => mc.check(files.mp4.subarray(0, 40), { cfg }), (e) => e.code === 'UNAVAILABLE', 'a cut-off video is refused');
  step('audio and text pass, broken pictures and videos are refused');
  fs.rmSync(dir, { recursive: true, force: true });
}

async function routes() {
  if (!process.env.TEST_DATABASE_URL) { console.log('- no TEST_DATABASE_URL, skipping the route checks'); return; }
  const { cleanup } = require('./test-env');
  const { httpServer, ready, store } = require('./index');
  await ready;
  await new Promise((r) => httpServer.listen(0, r));
  const base = 'http://127.0.0.1:' + httpServer.address().port;
  const call = async (p, { method = 'GET', body, token } = {}) => {
    const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const send = async (p, method, token, bytes, type, extra = {}) => {
    const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': type, Authorization: 'Bearer ' + token, ...extra }, body: bytes });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const saved = { check: process.env.MEDIA_CHECK, ffmpeg: process.env.FFMPEG_PATH, fail: process.env.MEDIA_CHECK_FAIL };
  try {
    process.env.MEDIA_CHECK = 'on';
    const u = await call('/register', { method: 'POST', body: { username: 'mc_user', email: 'mc@example.com', password: 'password123', publicKey: 'k', encPrivKey: { salt: 'a', iv: 'b', data: 'c' } } });
    const { server: hub } = await call('/servers', { method: 'POST', token: u.token, body: { name: 'Hub' } });
    const cid = hub.channels[0].id;
    const H = { 'X-Aduna-Safety': '1' };
    const up = (bytes, headers = H) => send(`/files?kind=channel&target=${cid}`, 'POST', u.token, bytes, 'application/octet-stream', headers);

    let r = await up(Buffer.from('notes'), {});
    assert.deepStrictEqual([r.status, r.code], [426, 'update_required'], 'an old app is told to reload');
    r = await up(Buffer.from('notes'));
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual((await store.fileMeta(r.id)).kind, 'other');
    step('uploads need X-Aduna-Safety; text goes through');

    r = await up(makePng(32, 32));
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const meta = await store.fileMeta(r.id);
    assert.deepStrictEqual([meta.kind, meta.real], ['image', 'image/png'], 'the real type is saved with the file');
    const bare = await fetch(`${base}/api/files/${r.id}`, { headers: { Authorization: 'Bearer ' + u.token } });
    assert.strictEqual(bare.status, 426, 'downloads need the header too');
    const ok = await fetch(`${base}/api/files/${r.id}`, { headers: { Authorization: 'Bearer ' + u.token, ...H } });
    assert.strictEqual(ok.status, 200);
    step('a channel picture is checked, its real type saved, and downloads need the header');

    r = await up(Buffer.concat([makePng(8, 8).subarray(0, 12), Buffer.alloc(300, 9)]));
    assert.deepStrictEqual([r.status, r.code], [422, 'media_refused'], 'a broken picture is refused');

    r = await send('/me/avatar', 'PUT', u.token, makePng(40, 40), 'image/png');
    assert.strictEqual(r.status, 200, 'a clean avatar is saved: ' + JSON.stringify(r));
    process.env.FFMPEG_PATH = path.join(os.tmpdir(), 'no-such-ffmpeg');
    r = await send('/me/avatar', 'PUT', u.token, makePng(41, 41), 'image/png');
    assert.deepStrictEqual([r.status, r.code, r.error], [422, 'media_refused', mc.UNAVAILABLE_MSG], 'without a working check the avatar is not saved');
    r = await up(makePng(33, 33));
    assert.strictEqual(r.status, 200, 'a channel picture is saved when the check cannot run (chat attachments fail open): ' + JSON.stringify(r));
    process.env.MEDIA_CHECK_FAIL = 'closed';
    r = await up(makePng(34, 34));
    assert.strictEqual(r.status, 422, 'MEDIA_CHECK_FAIL=closed refuses it again');
    step('putImage fails closed with a 422; the channel upload fails open unless MEDIA_CHECK_FAIL=closed');
  } finally {
    if (saved.check === undefined) delete process.env.MEDIA_CHECK; else process.env.MEDIA_CHECK = saved.check;
    if (saved.ffmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = saved.ffmpeg;
    if (saved.fail === undefined) delete process.env.MEDIA_CHECK_FAIL; else process.env.MEDIA_CHECK_FAIL = saved.fail;
    await cleanup();
  }
}

(async () => {
  try { await logic(); await real(); await routes(); console.log('ALL PASSED'); }
  catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  process.exit();
})();
