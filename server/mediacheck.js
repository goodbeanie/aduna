// Server-side nudity check for pictures, GIFs and videos. The browser runs the same model (nsfwjs, MobileNetV2, see client/src/nsfw.js) before
// it sends or shows a file, but a modified app, a bot or an old app version skips that. This runs on the server, where nobody can skip it.
//
// What it covers: every picture the server stores for everybody to see (profile pictures, banners, server icons, emoji, stickers, badges, bot
// pictures, artist pieces: see putImage in db.js) and every attachment in a server channel (those are not encrypted). It cannot look inside a
// DM or group attachment: those are encrypted in the browser, so the server only holds ciphertext. The two apps check those on the device.
//
// How: ffmpeg decodes the file (any picture or video format, so a renamed file is judged by what it really is) into 224x224 frames, the model
// scores each one, and the worst frame counts. Frames are taken about once a second (at most MEDIA_CHECK_FRAMES, default 40, spread over the
// whole length). If the model or ffmpeg cannot run, the answer is "unavailable" and the caller REFUSES the file (set MEDIA_CHECK_FAIL=open to
// let files through instead, e.g. on a small test server).
//
// Switches: MEDIA_CHECK=on|off (default on; off when NODE_ENV=test unless a test says on), MEDIA_CHECK_FAIL=closed|open, MEDIA_CHECK_FRAMES,
// MEDIA_CHECK_TIMEOUT_S, FFMPEG_PATH.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SIDE = 224;
const FRAME_BYTES = SIDE * SIDE * 3;
// same numbers as client/src/nsfw.js, so the app and the server agree
const BLOCK_AT = 0.6;
const BLUR_EXPLICIT_AT = 0.3;
const BLUR_SEXY_AT = 0.6;
const RANK = { ok: 0, blur: 1, block: 2 };

const EXPLICIT_MSG = "That image looks like nudity or explicit content, so it can't be used here";
const SUGGESTIVE_MSG = 'That image looks too suggestive for a picture everyone can see. Try a different one';
const UNAVAILABLE_MSG = "The picture check isn't available right now, so the file wasn't saved. Try again in a minute";
const BUSY_MSG = 'Lots of pictures are being checked right now. Try again in a moment';
const ANIMATED_WEBP_MSG = "Animated WebP files can't be checked yet. Send it as a GIF or a video instead";

function settings(env = process.env) {
  const test = env.NODE_ENV === 'test';
  const mode = String(env.MEDIA_CHECK || '').trim().toLowerCase();
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
  return {
    on: mode ? !['off', '0', 'false', 'no'].includes(mode) : !test,
    failOpen: String(env.MEDIA_CHECK_FAIL || '').trim().toLowerCase() === 'open',
    frames: Math.round(num(env.MEDIA_CHECK_FRAMES, 40, 3, 120)),
    timeoutMs: num(env.MEDIA_CHECK_TIMEOUT_S, 45, 5, 300) * 1000,
    maxQueue: 12, // checks waiting for their turn (the model runs one at a time); more than this and the upload is told to try again
    idleMs: 15 * 60_000, // the model is let go after this long without a check, so an idle server does not keep it in memory
    ffmpeg: String(env.FFMPEG_PATH || '').trim(),
  };
}

// ---------- what a file really is (magic bytes, never the name or the claimed type) ----------
// -> { kind: 'image' | 'video' | 'audio' | 'other' | 'unknown', mime }. 'unknown' means the first bytes say nothing: the caller may ask ffmpeg.
function sniff(b) {
  if (!Buffer.isBuffer(b) || b.length < 4) return { kind: 'unknown', mime: '' };
  const s = (from, to) => b.toString('latin1', from, to);
  if (b[0] === 0x89 && s(1, 4) === 'PNG') return { kind: 'image', mime: 'image/png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', mime: 'image/jpeg' };
  if (s(0, 6) === 'GIF87a' || s(0, 6) === 'GIF89a') return { kind: 'image', mime: 'image/gif' };
  if (s(0, 4) === 'RIFF' && b.length > 12) {
    if (s(8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp', animated: s(12, 16) === 'VP8X' && b.length > 20 && (b[20] & 2) === 2 };
    if (s(8, 11) === 'AVI') return { kind: 'video', mime: 'video/x-msvideo' };
    if (s(8, 12) === 'WAVE') return { kind: 'audio', mime: 'audio/wav' };
  }
  if (s(0, 2) === 'BM' && b.length > 30 && b.readUInt32LE(6) === 0) return { kind: 'image', mime: 'image/bmp' }; // the reserved header bytes are zero: text that starts with BM is not
  if ((s(0, 4) === 'II*\0' || s(0, 4) === 'MM\0*')) return { kind: 'image', mime: 'image/tiff' };
  if (b.length > 12 && s(4, 8) === 'ftyp') {
    const brand = s(8, 12);
    if (/^(avif|avis)$/.test(brand)) return { kind: 'image', mime: 'image/avif' };
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return { kind: 'image', mime: 'image/heic' };
    if (brand === 'M4A ' || brand === 'M4B ' || brand === 'F4A ') return { kind: 'audio', mime: 'audio/mp4' };
    return { kind: 'video', mime: brand === 'qt  ' ? 'video/quicktime' : 'video/mp4' }; // mp4, mov, m4v, 3gp...
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: 'video', mime: 'video/webm' }; // webm / mkv
  if (s(0, 4) === 'OggS') return { kind: 'video', mime: 'video/ogg' }; // ogg may be audio or video: ffmpeg decides
  if (s(0, 3) === 'FLV' && b[3] === 1) return { kind: 'video', mime: 'video/x-flv' };
  if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return { kind: 'video', mime: 'video/x-ms-wmv' };
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && (b[3] === 0xba || b[3] === 0xb3)) return { kind: 'video', mime: 'video/mpeg' };
  if (b[0] === 0x47 && b.length > 376 && b[188] === 0x47 && b[376] === 0x47) return { kind: 'video', mime: 'video/mp2t' };
  if (s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { kind: 'audio', mime: 'audio/mpeg' };
  if (s(0, 4) === 'fLaC') return { kind: 'audio', mime: 'audio/flac' };
  if (s(0, 2) === 'PK' || s(0, 4) === '%PDF' || s(0, 2) === 'MZ' || s(0, 4) === '\x7fELF' || (b[0] === 0x1f && b[1] === 0x8b) || s(0, 6) === '7z\xbc\xaf\x27\x1c' || s(0, 4) === 'Rar!') return { kind: 'other', mime: '' };
  if (!b.subarray(0, Math.min(b.length, 512)).includes(0)) return { kind: 'other', mime: '' }; // plain text and the like: no NUL byte near the start
  return { kind: 'unknown', mime: '' };
}

// ---------- running ffmpeg ----------
function binary(cfg) {
  if (cfg && cfg.ffmpeg) return cfg.ffmpeg;
  try { const p = require('ffmpeg-static'); if (p) return p; } catch { /* the package is optional */ }
  return 'ffmpeg';
}
function run(bin, args, { timeoutMs, binaryOut = false }) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: binaryOut ? 'buffer' : 'utf8' }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return reject(Object.assign(new Error('ffmpeg is not installed'), { code: 'UNAVAILABLE' }));
      if (err && err.killed) return reject(Object.assign(new Error('ffmpeg took too long'), { code: 'UNAVAILABLE' }));
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr: String(stderr || '') });
    });
  });
}
const seconds = (txt) => { const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(txt || ''); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0; };

// -> { streams: bool, video: bool, duration }. streams is false when ffmpeg could not open the file at all; video is true when there is a
// picture stream ("Stream ... Video:"). A cover-art picture inside an mp3 does not count.
async function probe(file, cfg) {
  const r = await run(binary(cfg), ['-hide_banner', '-i', file], { timeoutMs: cfg.timeoutMs }); // no output file: prints the streams, then exits with an error (expected)
  const streams = /Stream #\d+:\d+/.test(r.stderr);
  const video = /Stream #\d+:\d+[^\n]*Video:(?![^\n]*attached pic)/.test(r.stderr);
  return { streams, video, duration: seconds(r.stderr) };
}

// How many frames to take and how often. A still picture gets one. Up to MEDIA_CHECK_FRAMES, about one a second; a longer file gets that many
// spread evenly over its length.
function plan(duration, maxFrames) {
  if (!(duration > 0)) return { count: Math.min(maxFrames, 8), fps: 2 }; // length unknown (some GIFs): the first few seconds at two a second
  const count = Math.max(2, Math.min(maxFrames, Math.ceil(duration)));
  return { count, fps: count / duration };
}

// -> Buffer holding n raw RGB frames (n * 224 * 224 * 3 bytes). Throws UNAVAILABLE when the file cannot be decoded.
async function frames(buf, cfg, forceStill = false) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aduna-media-'));
  try {
    const input = path.join(dir, 'in.bin'); // no extension: ffmpeg works the format out from the bytes
    await fs.promises.writeFile(input, buf);
    let pl = { count: 1, fps: 1 };
    if (!forceStill) {
      const p = await probe(input, cfg);
      if (!p.streams) throw Object.assign(new Error('could not open that file'), { code: 'UNREADABLE' });
      if (!p.video) throw Object.assign(new Error('no picture in that file'), { code: 'NOT_MEDIA' }); // audio only (webm, ogg, mp4 with sound)
      pl = plan(p.duration, cfg.frames);
    }
    const grab = (vf, count) => run(binary(cfg), ['-hide_banner', '-v', 'error', '-nostdin', '-i', input, '-an', '-sn', '-vf', vf, '-frames:v', String(count), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { timeoutMs: cfg.timeoutMs, binaryOut: true });
    const scale = `scale=${SIDE}:${SIDE}:flags=bilinear,format=rgb24`;
    // the first picture always (a one-frame WebP or a GIF of unknown length gives nothing through the fps filter), then the sampled ones
    const first = await grab(scale, 1);
    let out = first.stdout;
    if (!Buffer.isBuffer(out) || out.length < FRAME_BYTES) throw Object.assign(new Error('could not read that file: ' + String(first.stderr).trim().split(/\r?\n/).slice(-1)[0]), { code: 'UNREADABLE' });
    if (pl.count > 1) {
      const more = await grab(`fps=${pl.fps.toFixed(5)},${scale}`, pl.count).catch(() => null);
      if (more && Buffer.isBuffer(more.stdout) && more.stdout.length >= FRAME_BYTES) out = Buffer.concat([out.subarray(0, FRAME_BYTES), more.stdout]);
    }
    return out.subarray(0, Math.floor(out.length / FRAME_BYTES) * FRAME_BYTES);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- the model ----------
let tf = null, model = null, loading = null, idleTimer = null;
function getModel() {
  if (model) return Promise.resolve(model);
  if (!loading) {
    loading = (async () => {
      try {
        tf = require('@tensorflow/tfjs'); // pure JavaScript (slow but needs nothing native). @tensorflow/tfjs-node is used instead if it is installed.
        try { tf = require('@tensorflow/tfjs-node'); } catch { /* not installed: the plain one is fine */ }
        await tf.setBackend(tf.getBackend() === 'tensorflow' ? 'tensorflow' : 'cpu');
        await tf.ready();
        const { load } = require('nsfwjs/core');
        const { MobileNetV2Model } = require('nsfwjs/models/mobilenet_v2');
        model = await load('MobileNetV2', { modelDefinitions: [MobileNetV2Model], size: SIDE });
        return model;
      } catch (e) {
        throw Object.assign(new Error('the picture model could not load: ' + (e && e.message)), { code: 'UNAVAILABLE' });
      }
    })().catch((e) => { loading = null; throw e; });
  }
  return loading;
}
function touchIdle(cfg) {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { try { model && model.model && model.model.dispose && model.model.dispose(); } catch { /* ignore */ } model = null; loading = null; }, cfg.idleMs);
  idleTimer.unref();
}

function verdictOf(predictions) {
  const p = {};
  for (const x of predictions) p[x.className] = x.probability;
  const explicit = (p.Porn || 0) + (p.Hentai || 0);
  if (explicit >= BLOCK_AT) return 'block';
  if (explicit >= BLUR_EXPLICIT_AT || (p.Sexy || 0) >= BLUR_SEXY_AT) return 'blur';
  return 'ok';
}

async function classifyFrames(raw, classifyFn) {
  let worst = 'ok';
  const n = raw.length / FRAME_BYTES;
  for (let i = 0; i < n; i++) {
    const v = await classifyFn(raw.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES));
    if (RANK[v] > RANK[worst]) worst = v;
    if (worst === 'block') break;
    await new Promise((resolve) => setImmediate(resolve)); // the plain JS backend holds the process for about a second a frame: let requests in between
  }
  return { verdict: worst, frames: n };
}
async function modelClassify(frame) {
  const net = await getModel();
  const x = tf.tensor3d(new Uint8Array(frame.buffer, frame.byteOffset, FRAME_BYTES), [SIDE, SIDE, 3], 'int32');
  try { return verdictOf(await net.classify(x, 5)); } finally { x.dispose(); }
}

// ---------- one check at a time ----------
let active = false;
const waiting = [];
async function inLine(job, cfg) {
  if (active) {
    if (waiting.length >= cfg.maxQueue) throw Object.assign(new Error(BUSY_MSG), { code: 'BUSY' });
    await new Promise((resolve) => waiting.push(resolve));
  }
  active = true;
  try { return await job(); }
  finally { active = false; const next = waiting.shift(); if (next) next(); }
}

// ---------- the check ----------
// check(buf) -> { verdict: 'ok' | 'blur' | 'block', frames, kind, mime } or { verdict: 'skipped' } (not a picture or video, or the check is switched off).
// Throws an Error with code UNAVAILABLE / BUSY when it could not be done: the caller decides (see guard()).
// deps lets the tests replace the pieces that need ffmpeg and the model.
async function check(buf, { cfg = settings(), deps = {} } = {}) {
  if (!cfg.on) return { verdict: 'skipped' };
  const d = { frames, classify: modelClassify, probe, ...deps };
  const s = sniff(buf);
  if (s.kind === 'audio' || s.kind === 'other') return { verdict: 'skipped', kind: s.kind };
  const still = s.kind === 'image' && s.mime !== 'image/gif' && !s.animated; // a GIF or an animated WebP is decoded as video
  return inLine(async () => {
    let raw;
    try { raw = await d.frames(buf, cfg, still); }
    catch (e) {
      if (e.code === 'NOT_MEDIA') return { verdict: 'skipped', kind: 'other' }; // ffmpeg opened it and there is no picture in it
      if (e.code === 'UNREADABLE') {
        if (s.animated) throw Object.assign(new Error(ANIMATED_WEBP_MSG), { code: 'UNSUPPORTED', detail: e.message }); // ffmpeg's WebP decoder does not do animation
        if (s.kind === 'video' || s.kind === 'image') throw Object.assign(new Error(UNAVAILABLE_MSG), { code: 'UNAVAILABLE', detail: e.message }); // looks like media but cannot be read: not let through
        return { verdict: 'skipped', kind: 'other' };
      }
      throw e;
    }
    const got = await classifyFrames(raw, d.classify);
    touchIdle(cfg);
    return { ...got, kind: s.kind === 'unknown' ? 'video' : s.kind, mime: s.mime };
  }, cfg);
}

// Raised for the routes: err.code === 'MEDIA_REFUSED' becomes a 422 in index.js.
const refuse = (message, detail) => Object.assign(new Error(message), { code: 'MEDIA_REFUSED', status: 422, detail });

async function guard(buf, { strict, cfg = settings(), deps } = {}) {
  let r;
  try { r = await check(buf, { cfg, deps }); }
  catch (e) {
    if (cfg.failOpen) { console.warn('media check skipped (MEDIA_CHECK_FAIL=open):', e.message); return { verdict: 'skipped' }; }
    console.error('media check failed:', e.detail || e.message);
    throw refuse(e.code === 'BUSY' ? BUSY_MSG : e.code === 'UNSUPPORTED' ? e.message : UNAVAILABLE_MSG, e.message);
  }
  if (r.verdict === 'block') throw refuse(EXPLICIT_MSG);
  if (r.verdict === 'blur' && strict) throw refuse(SUGGESTIVE_MSG);
  return r;
}
// Public pictures (anything everybody can see: it cannot be blurred, so 'blur' is refused too). Resolves with the check's answer, or throws MEDIA_REFUSED.
const guardPublic = (buf, opts = {}) => guard(buf, { ...opts, strict: true });
// Chat attachments: nudity is refused, a suggestive file is let through (the reader's app blurs it).
const guardChat = (buf, opts = {}) => guard(buf, { ...opts, strict: false });

// The type an attachment is stored and shown with, from what the bytes are and what the sender said. A picture is always called a picture,
// and nothing that is not a picture is called one. Audio and video may swap (webm and ogg hold either), so the sender's word stands there.
function settleType(claimed, real) {
  const c = String(claimed || '');
  if (real.kind === 'image') return real.mime;
  if (/^image\//.test(c)) return 'application/octet-stream';
  if (/^video\//.test(c)) return real.kind === 'video' ? c : real.kind === 'audio' ? real.mime : 'application/octet-stream';
  if (/^audio\//.test(c)) return real.kind === 'audio' || real.kind === 'video' ? c : 'application/octet-stream';
  return c;
}

module.exports = { settings, sniff, plan, settleType, verdictOf, classifyFrames, check, guard, guardPublic, guardChat, refuse, EXPLICIT_MSG, SUGGESTIVE_MSG, UNAVAILABLE_MSG, BUSY_MSG, FRAME_BYTES };
