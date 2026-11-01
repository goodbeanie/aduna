// Animated pictures: node server/animated-test.js
// The GIF helpers (header check, still copy) and the crop maths run anywhere; the ffmpeg part makes a real GIF with ffmpeg and cuts it to size,
// and skips itself (still exit 0) when there is no ffmpeg (set FFMPEG_PATH, or install the ffmpeg-static package).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { sniffImage, sniffAny, gifInfo, cleanGif, stillGif } = require('./images');
const animated = require('./animated');

let n = 0;
const step = (m) => { n++; console.log('- ' + m); };

// a tiny GIF: w x h, `frames` frames, optional loop extension and comment (the same builder the smoke test uses)
function makeGif(w, h, { frames = 1, comment = '', loop = frames > 1 } = {}) {
  const lsd = Buffer.alloc(7); lsd.writeUInt16LE(w, 0); lsd.writeUInt16LE(h, 2); lsd[4] = 0x80;
  const parts = [Buffer.from('GIF89a'), lsd, Buffer.from([0, 0, 0, 255, 255, 255])];
  if (comment) parts.push(Buffer.from([0x21, 0xfe, comment.length]), Buffer.from(comment, 'latin1'), Buffer.from([0]));
  if (loop) parts.push(Buffer.from([0x21, 0xff, 11]), Buffer.from('NETSCAPE2.0'), Buffer.from([3, 1, 0, 0, 0]));
  for (let i = 0; i < frames; i++) {
    parts.push(Buffer.from([0x21, 0xf9, 4, 0, 10 + i, 0, 0, 0])); // graphic control: the delay differs per frame so the first one can be told apart
    const d = Buffer.alloc(10); d[0] = 0x2c; d.writeUInt16LE(w, 5); d.writeUInt16LE(h, 7);
    parts.push(d, Buffer.from([2, 3, 0x44, 0x01 + i, 0x05, 0]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

(async () => {
  // ---- header check ----
  const g3 = makeGif(32, 24, { frames: 3 });
  assert.deepStrictEqual(gifInfo(g3), { mime: 'image/gif', width: 32, height: 24 });
  assert.strictEqual(gifInfo(Buffer.from('GIF89a')), null, 'too short');
  assert.strictEqual(gifInfo(Buffer.from('not a gif at all, just text here')), null);
  assert.strictEqual(sniffImage(g3), null, 'the still-picture check still refuses GIFs (only the image route serves them)');
  assert.strictEqual(sniffAny(g3).mime, 'image/gif');
  step('GIFs are recognised by their header; the still-picture check still refuses them');

  // ---- still copy ----
  const still = stillGif(g3);
  assert.ok(still && gifInfo(still), 'the still copy is a GIF');
  const clean = cleanGif(still);
  assert.ok(clean, 'and a valid one');
  assert.strictEqual(clean.frames, 1, 'with one frame');
  assert.ok(!still.includes('NETSCAPE2.0'), 'no loop extension, so it never animates');
  assert.ok(still.length < g3.length, 'and it is smaller');
  assert.ok(still.includes(Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0])), 'it is the FIRST frame (its graphic control block is kept)');
  assert.ok(!still.includes(Buffer.from([0x21, 0xf9, 4, 0, 11, 0, 0, 0])), 'the later frames are gone');
  assert.deepStrictEqual([gifInfo(still).width, gifInfo(still).height], [32, 24], 'same size');
  const one = makeGif(8, 8, { frames: 1 });
  assert.strictEqual(cleanGif(stillGif(one)).frames, 1, 'a one-frame GIF stays one frame');
  assert.strictEqual(stillGif(Buffer.from('definitely not a gif')), null);
  assert.strictEqual(stillGif(g3.subarray(0, 50)), null, 'a GIF cut off inside its first frame gives nothing');
  step('stillGif keeps the first frame only, drops the loop extension, and refuses broken files');

  // ---- crop window (same maths as drawCover in client/src/image.js) ----
  const A = { w: 256, h: 256 };
  assert.deepStrictEqual(animated.cropBox(400, 400, A, { x: 0.5, y: 0.5, zoom: 1 }), { x: 0, y: 0, w: 400, h: 400 }, 'a square picture at zoom 1 is all kept');
  assert.deepStrictEqual(animated.cropBox(800, 400, A, { x: 0.5, y: 0.5, zoom: 1 }), { x: 200, y: 0, w: 400, h: 400 }, 'a wide picture: the middle square');
  assert.deepStrictEqual(animated.cropBox(800, 400, A, { x: 0, y: 0.5, zoom: 1 }), { x: 0, y: 0, w: 400, h: 400 }, 'pushed to the left edge, it stays inside the picture');
  assert.deepStrictEqual(animated.cropBox(400, 400, A, { x: 0.5, y: 0.5, zoom: 2 }), { x: 100, y: 100, w: 200, h: 200 }, 'zoom 2 keeps the middle half');
  assert.deepStrictEqual(animated.cropBox(400, 400, A, { x: 9, y: -3, zoom: 99 }), { x: 300, y: 0, w: 100, h: 100 }, 'wild values are held to the picture and to zoom 4');
  const bad = animated.cropBox(400, 400, A, { x: NaN, y: undefined, zoom: NaN });
  assert.deepStrictEqual(bad, { x: 0, y: 0, w: 400, h: 400 }, 'missing numbers fall back to the middle and no zoom');
  const wide = animated.cropBox(1000, 500, { w: 960, h: 240 }, { x: 0.5, y: 0.5, zoom: 1 });
  assert.strictEqual(Math.round(wide.w / wide.h * 100), 400, 'a banner keeps its 4:1 shape');
  step('the crop window matches the browser maths and stays inside the picture');

  // ---- refusals that need no ffmpeg ----
  const refuse = async (buf, re, why, status = 400) => {
    await assert.rejects(animated.makeAnimated(buf, A, { x: 0.5, y: 0.5, zoom: 1 }), (e) => re.test(e.message) && e.status === status, why);
  };
  await refuse(Buffer.alloc(0), /Choose a GIF/, 'empty body');
  await refuse(Buffer.from('GIF89a but then rubbish'), /damaged|too many frames/, 'damaged GIF');
  await refuse(Buffer.alloc(animated.LIMITS.maxInput + 1, 1), /too big/, 'over 8 MB');
  await refuse(makeGif(5000, 5000, { frames: 2 }), /too large/, 'a huge picture size');
  assert.strictEqual(await animated.makeAnimated(makeGif(16, 16, { frames: 1 }), A, {}), null, 'a GIF with one frame has nothing to animate');
  step('empty, damaged, oversized and single-frame GIFs are refused or ignored before ffmpeg runs');

  // ---- the real thing ----
  let bin = process.env.FFMPEG_PATH || null;
  if (!bin) { try { const p = require('ffmpeg-static'); if (p && fs.existsSync(p)) bin = p; } catch { /* not installed */ } }
  if (!bin) { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); bin = 'ffmpeg'; } catch { /* none */ } }
  if (!bin) { console.log('- no ffmpeg found (set FFMPEG_PATH): the ffmpeg part is skipped'); console.log(`\nanimated: ${n} checks passed`); return; }
  process.env.FFMPEG_PATH = bin;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aduna-animated-test-'));
  try {
    const src = path.join(dir, 'src.gif');
    execFileSync(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '1.5', src]);
    const input = fs.readFileSync(src);
    assert.ok(cleanGif(input), 'ffmpeg made a usable test GIF');

    const out = await animated.makeAnimated(input, { w: 64, h: 64 }, { x: 0.5, y: 0.5, zoom: 1 });
    assert.ok(out, 'it comes back');
    assert.deepStrictEqual([out.width, out.height], [64, 64], 'cut to the picture size');
    assert.ok(out.frames > 1, 'and still animated (' + out.frames + ' frames)');
    assert.ok(out.buf.length <= animated.LIMITS.maxOutput, 'light enough to send to everyone');
    assert.ok(out.buf.includes('NETSCAPE2.0'), 'and it loops');
    assert.strictEqual(cleanGif(stillGif(out.buf)).frames, 1, 'its still copy works too');
    step('ffmpeg: a GIF is cropped, scaled and still animated');

    const banner = await animated.makeAnimated(input, { w: 96, h: 24 }, { x: 0.2, y: 0.8, zoom: 2 });
    assert.deepStrictEqual([banner.width, banner.height], [96, 24], 'a banner shape works too, with a moved and zoomed crop');
    step('ffmpeg: a wide crop with zoom');

    // nothing is left behind in the temp folder, and several at once all finish (the extra ones wait for a slot)
    const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('aduna-anim-')).length;
    const many = await Promise.all([1, 2, 3, 4, 5].map(() => animated.makeAnimated(input, { w: 32, h: 32 }, {})));
    assert.ok(many.every((m) => m && m.frames > 1));
    assert.strictEqual(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('aduna-anim-')).length, before, 'the temp folders are cleaned up');
    step('ffmpeg: five at once all finish and leave nothing behind');

    process.env.FFMPEG_PATH = path.join(dir, 'no-such-ffmpeg');
    await assert.rejects(animated.makeAnimated(input, A, {}), /ffmpeg is not installed/);
    step('ffmpeg: a missing ffmpeg is reported in plain words');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nanimated: ${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
