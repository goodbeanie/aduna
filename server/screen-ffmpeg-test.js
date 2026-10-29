// The ffmpeg part of clip screening, against a real ffmpeg: node server/screen-ffmpeg-test.js
// Finds ffmpeg through FFMPEG_PATH, the ffmpeg-static package or the PATH, and skips itself (exit 0) when there is none.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { execFile, execFileSync } = require('child_process');
const screen = require('./screen');

const step = (m) => console.log('✓', m);
function findFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try { const p = require('ffmpeg-static'); if (p && fs.existsSync(p)) return p; } catch { /* not installed */ }
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return 'ffmpeg'; } catch { return null; }
}
const bin = findFfmpeg();
if (!bin) { console.log('- no ffmpeg found (set FFMPEG_PATH): skipped'); process.exit(0); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aduna-ffmpeg-test-'));
const ff = (args) => new Promise((resolve, reject) => execFile(bin, ['-hide_banner', '-v', 'error', '-y', ...args], { maxBuffer: 8 << 20 }, (e, _o, err) => (e ? reject(new Error(err || e.message)) : resolve())));
const make = async (name, video, audio, extra = []) => {
  const out = path.join(dir, name);
  const args = ['-f', 'lavfi', '-i', video];
  if (audio) args.push('-f', 'lavfi', '-i', audio);
  await ff([...args, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac'] : ['-an']), '-movflags', '+faststart', '-shortest', ...extra, out]);
  return fs.readFileSync(out);
};

(async () => {
  const cfg = { ...screen.settings({ OPENAI_API_KEY: 'k', AUDD_API_TOKEN: 't' }), ffmpeg: bin };
  const A = 'testsrc2=size=360x640:rate=15:duration=6', B = 'mandelbrot=size=360x640:rate=15';

  // ---- a clip with a soundtrack ----
  const withSound = await make('a.mp4', A, 'sine=frequency=440:duration=6');
  const m = await screen.extract(withSound, 6, cfg);
  assert.strictEqual(m.frames.length, cfg.frames, 'one picture per slice of the clip');
  for (const fr of m.frames) { assert.strictEqual(fr[0], 0xff); assert.strictEqual(fr[1], 0xd8); assert.ok(fr.length > 2000 && fr.length < 400_000, 'a real JPEG of sensible size, got ' + fr.length); }
  assert.strictEqual(m.hashes.length, m.frames.length, 'one fingerprint per picture');
  for (const h of m.hashes) assert.match(h, /^[0-9a-f]{16}$/);
  assert.deepStrictEqual([m.hasAudio, m.silent], [true, false], 'the sine tone is heard');
  assert.ok(Math.abs(m.audioSeconds - 6) < 0.5, 'the sound is as long as the clip: ' + m.audioSeconds);
  assert.ok(m.wav.length > 150_000 && m.wav.length < 300_000, 'about 6 s of 16 kHz mono 16-bit sound, got ' + m.wav.length);
  assert.ok(screen.pcmStats(m.wav).rms > 0.05, 'and it is loud enough to be music-checked');
  assert.deepStrictEqual(fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith('aduna-clip-')), [], 'the temporary files are cleaned up');
  step('ffmpeg: ' + m.frames.length + ' JPEG frames, fingerprints, 16 kHz mono sound cut out of a real clip');

  // ---- no sound, and silence ----
  const mute = await screen.extract(await make('mute.mp4', A, null), 6, cfg);
  assert.deepStrictEqual([mute.hasAudio, mute.wav, mute.frames.length], [false, null, cfg.frames], 'no soundtrack at all');
  const quiet = await screen.extract(await make('quiet.mp4', A, 'anullsrc=r=44100:cl=mono'), 6, cfg);
  assert.deepStrictEqual([quiet.hasAudio, quiet.silent], [true, true], 'a silent soundtrack is noticed, so the music service is not charged for it');
  step('ffmpeg: a clip without sound and a clip with a silent track are told apart from one with music');

  // ---- a short clip, and another frame count ----
  const short = await screen.extract(await make('short.mp4', 'testsrc2=size=360x640:rate=15:duration=1.5', 'sine=frequency=300:duration=1.5'), 1.5, cfg);
  assert.ok(short.frames.length >= cfg.frames - 1 && short.frames.length <= cfg.frames, 'a 1.5 second clip still gives its pictures: ' + short.frames.length);
  assert.ok(short.audioSeconds < 2, 'and its sound is too short to send to the music service');
  const twelve = await screen.extract(withSound, 6, { ...cfg, frames: 12 });
  assert.ok(twelve.frames.length >= 11 && twelve.frames.length <= 12, 'the number of pictures follows the setting: ' + twelve.frames.length);
  step('ffmpeg: short clips and the frame-count setting');

  // ---- the same clip squeezed and resized is recognised; another clip is not ----
  const squeezed = await make('squeezed.mp4', A, 'sine=frequency=440:duration=6', ['-vf', 'scale=252:448', '-b:v', '60k']);
  const other = await screen.extract(await make('b.mp4', B, 'sine=frequency=440:duration=6', ['-t', '6']), 6, cfg);
  const small = await screen.extract(squeezed, 6, cfg);
  assert.ok(screen.sameVideo(m.hashes, small.hashes), 'the same clip at a smaller size and a far lower bitrate is still the same clip: ' + m.hashes.map((h, i) => screen.distance(h, small.hashes[i])).join(','));
  assert.ok(!screen.sameVideo(m.hashes, other.hashes), 'a different clip is not: ' + m.hashes.concat(other.hashes).join(' '));
  const known = [{ id: 'orig', owner: 'ann', state: 'live', screen: { hashes: m.hashes } }];
  assert.strictEqual(screen.findDuplicate(small.hashes, known, { ownerId: 'bob', selfId: 'new' }).clipId, 'orig', 'a squeezed re-upload by someone else is caught');
  step('ffmpeg: a re-encoded copy matches the original; a different clip does not');

  // ---- what goes wrong ----
  await assert.rejects(screen.extract(Buffer.from('this is not a video at all'.repeat(100)), 6, cfg), /could not be read/);
  await assert.rejects(screen.extract(withSound, 6, { ...cfg, ffmpeg: path.join(dir, 'no-such-ffmpeg') }), /ffmpeg is not installed/);
  assert.deepStrictEqual(fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith('aduna-clip-')), [], 'failures clean up too');
  const found = await screen.analyze({ video: Buffer.from('garbage'.repeat(50)), seconds: 5, poster: null, known: null }, cfg, { moderateImage: async () => ({ sexual: 0, violence: 0, 'violence/graphic': 0 }) });
  assert.match(found.errors[0], /^video: the video could not be read/, 'analyze() reports it instead of throwing');
  step('ffmpeg: garbage and a missing ffmpeg are reported, and nothing is left in the temp folder');

  console.log('\nscreen-ffmpeg: all good');
})().catch((e) => { console.error(e); process.exit(1); }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
