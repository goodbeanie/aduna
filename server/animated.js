// Animated profile pictures, banners and server icons.
//
// The browser still uploads the normal still picture (the cropped first frame). When the chosen file is a GIF it also sends the original GIF
// and the crop window, and this module cuts the same part out of every frame with ffmpeg and shrinks it to the size of the picture.
// The result is stored next to the still picture (avatarAnim, bannerAnim, iconAnim): the app shows the still one, and the animated one
// only while someone hovers over it or has the profile open.
//
// ffmpeg is found the same way as for clip screening: FFMPEG_PATH, the ffmpeg-static package, or ffmpeg on the PATH.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanGif } = require('./images');

const LIMITS = {
  maxInput: 8 * 1024 * 1024, // the GIF the person picked
  maxOutput: 1536 * 1024,    // the animated copy that is stored and sent to everyone who looks at the profile
  maxFrames: 200,
  maxSide: 4096,
  fps: 15,                   // more frames than this only make the file bigger
  timeoutMs: 30_000,
  concurrent: 2,             // ffmpeg is heavy on a small server; the rest wait their turn
  maxWaiting: 8,
};

function binary() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try { const p = require('ffmpeg-static'); if (p) return p; } catch { /* the package is optional */ }
  return 'ffmpeg';
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

// The crop window, worked out like the browser does it (see drawCover in client/src/image.js): the picture covers the target size,
// zoomed in by `zoom`, and { x, y } (0 to 1) is the middle of the part that is kept, as a share of the picture. Returns whole pixels.
function cropBox(srcW, srcH, size, crop) {
  const zoom = clamp(Number(crop && crop.zoom) || 1, 1, 4);
  const mx = clamp(Number(crop && crop.x), 0, 1), my = clamp(Number(crop && crop.y), 0, 1);
  const scale = Math.max(size.w / srcW, size.h / srcH) * zoom;
  const cw = Math.min(srcW, Math.max(1, Math.round(size.w / scale))), ch = Math.min(srcH, Math.max(1, Math.round(size.h / scale)));
  const x = Math.round(clamp((Number.isFinite(mx) ? mx : 0.5) * srcW - cw / 2, 0, srcW - cw));
  const y = Math.round(clamp((Number.isFinite(my) ? my : 0.5) * srcH - ch / 2, 0, srcH - ch));
  return { x, y, w: cw, h: ch };
}

let running = 0;
const waiting = [];
function slot() {
  if (running < LIMITS.concurrent) { running++; return Promise.resolve(); }
  if (waiting.length >= LIMITS.maxWaiting) return Promise.reject(Object.assign(new Error('Too many pictures are being processed right now, try again in a moment'), { status: 503 }));
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else running--;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(binary(), args, { timeout: LIMITS.timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (err) => {
      if (err && err.code === 'ENOENT') return reject(new Error('Animated pictures are not available on this server (ffmpeg is not installed)'));
      if (err && err.killed) return reject(new Error('That GIF took too long to process, try a shorter one'));
      if (err) return reject(new Error('That GIF could not be processed'));
      resolve();
    });
  });
}

// buf: the GIF the person picked. size: { w, h } of the finished picture. crop: { x, y, zoom } from the cropper.
// Returns { buf, width, height, frames } with a GIF that is cropped, scaled, at most LIMITS.maxOutput bytes, and clean (see cleanGif).
// Returns null when the file is a GIF with a single frame (nothing to animate). Throws an Error with a message for the person otherwise;
// `status` on the error is the HTTP status to answer with (400 unless noted).
async function makeAnimated(buf, size, crop) {
  const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
  if (!Buffer.isBuffer(buf) || !buf.length) throw fail('Choose a GIF');
  if (buf.length > LIMITS.maxInput) throw fail('That GIF is too big (max 8 MB)');
  const info = cleanGif(buf, LIMITS.maxFrames);
  if (!info) throw fail(`That GIF is damaged or has too many frames (max ${LIMITS.maxFrames})`);
  if (info.width > LIMITS.maxSide || info.height > LIMITS.maxSide) throw fail(`That GIF is too large (max ${LIMITS.maxSide}px per side)`);
  if (info.frames < 2) return null;

  await slot();
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aduna-anim-'));
    const input = path.join(dir, 'in.gif');
    fs.writeFileSync(input, info.buf);
    const box = cropBox(info.width, info.height, size, crop);
    // try the full size first, then smaller ones until the result is light enough to send to everyone
    for (const k of [1, 0.75, 0.5]) {
      const w = Math.max(16, Math.round(size.w * k)), h = Math.max(16, Math.round(size.h * k));
      const output = path.join(dir, `out-${k}.gif`);
      const vf = `crop=${box.w}:${box.h}:${box.x}:${box.y},fps=${LIMITS.fps},scale=${w}:${h}:flags=lanczos,split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=alpha_threshold=128`;
      await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vf', vf, '-loop', '0', output]);
      const out = cleanGif(fs.readFileSync(output), LIMITS.maxFrames + 1);
      if (!out) throw fail('That GIF could not be processed');
      if (out.buf.length <= LIMITS.maxOutput) return out;
    }
    throw fail('That GIF is too heavy to use as a picture, try a shorter or smaller one');
  } finally {
    release();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { LIMITS, cropBox, makeAnimated };
