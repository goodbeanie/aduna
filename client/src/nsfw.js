// Nudity check that runs on the person's own device. The model (nsfwjs, MobileNetV2) ships with the app and loads the first time it is
// needed, so a picture is never sent anywhere to be looked at. That is the only way to look inside a DM attachment: it is encrypted
// before it leaves the browser. The server runs the same model on everything it can read (server/mediacheck.js).
//
// scanImage gives one of four answers: 'ok', 'blur' (suggestive: shown blurred, the reader can tap to show it), 'block' (nudity or
// explicit: not shown, not sent) or 'unknown' (it is a picture or a video but the check could not run). Sending refuses 'unknown';
// showing treats it like 'blur'. What a file is comes from its first bytes, never from its name or its type, so a renamed video is still looked at.
// A video or an animated picture is checked about once a second (at most MAX_SPOTS places spread over it) and the worst answer counts.

const BLOCK_AT = 0.6;        // porn + hentai
const BLUR_EXPLICIT_AT = 0.3; // porn + hentai, not sure enough to block
const BLUR_SEXY_AT = 0.6;
const LOOK_SIDE = 448;       // the model works at 224px, a bit more keeps small details
const MIN_SPOTS = 5;
const MAX_SPOTS = 24;

export const EXPLICIT_MSG = "That image looks like nudity or explicit content, so it can't be used here";
export const SUGGESTIVE_MSG = "That image looks too suggestive for a picture everyone can see. Try a different one";
export const UNCHECKED_MSG = "The picture check couldn't run on this device, so the file wasn't sent. Try again in a moment";

// ---------- what a file really is ----------
// -> { kind: 'image' | 'video' | 'audio' | 'other' | 'unknown', mime, animated }. Same rules as sniff in server/mediacheck.js.
export async function sniffType(blob) {
  const b = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  const s = (from, to) => String.fromCharCode(...b.subarray(from, to));
  const hit = (kind, mime, animated = false) => ({ kind, mime, animated });
  if (b.length < 4) return hit('unknown', '');
  if (b[0] === 0x89 && s(1, 4) === 'PNG') return hit('image', 'image/png');
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return hit('image', 'image/jpeg');
  if (s(0, 6) === 'GIF87a' || s(0, 6) === 'GIF89a') return hit('image', 'image/gif', true);
  if (s(0, 4) === 'RIFF' && b.length >= 16) {
    if (s(8, 12) === 'WEBP') return hit('image', 'image/webp', s(12, 16) === 'VP8X' && b.length > 20 && (b[20] & 2) === 2);
    if (s(8, 11) === 'AVI') return hit('video', 'video/x-msvideo');
    if (s(8, 12) === 'WAVE') return hit('audio', 'audio/wav');
  }
  if (s(0, 2) === 'BM' && b.length >= 10 && !b[6] && !b[7] && !b[8] && !b[9]) return hit('image', 'image/bmp'); // reserved header bytes are zero: text that starts with BM is not
  if (s(0, 4) === 'II*\0' || s(0, 4) === 'MM\0*') return hit('image', 'image/tiff');
  if (b.length >= 12 && s(4, 8) === 'ftyp') {
    const brand = s(8, 12);
    if (/^(avif|avis)$/.test(brand)) return hit('image', 'image/avif');
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return hit('image', 'image/heic');
    if (brand === 'M4A ' || brand === 'M4B ' || brand === 'F4A ') return hit('audio', 'audio/mp4');
    return hit('video', brand === 'qt  ' ? 'video/quicktime' : 'video/mp4');
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return hit('video', 'video/webm'); // webm or mkv: may hold only sound
  if (s(0, 4) === 'OggS') return hit('video', 'video/ogg'); // ogg: may hold only sound
  if (s(0, 3) === 'FLV' && b[3] === 1) return hit('video', 'video/x-flv');
  if (s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return hit('audio', 'audio/mpeg');
  if (s(0, 4) === 'fLaC') return hit('audio', 'audio/flac');
  if (s(0, 2) === 'PK' || s(0, 4) === '%PDF' || s(0, 2) === 'MZ' || (b[0] === 0x1f && b[1] === 0x8b)) return hit('other', '');
  if (!b.includes(0)) return hit('other', ''); // plain text and the like
  return hit('unknown', '');
}

// The type an attachment is shown with, from what the bytes are and what the sender said (the same rule as settleType in server/mediacheck.js).
export function settleType(claimed, real) {
  const c = String(claimed || '') || 'application/octet-stream';
  if (real.kind === 'image') return real.mime;
  if (/^image\//.test(c)) return 'application/octet-stream';
  if (/^video\//.test(c)) return real.kind === 'video' ? c : real.kind === 'audio' ? real.mime : 'application/octet-stream';
  if (/^audio\//.test(c)) return real.kind === 'audio' || real.kind === 'video' ? c : 'application/octet-stream';
  return c;
}

// ---------- the model ----------
let model = null, loading = null;
function getModel() {
  if (model) return Promise.resolve(model);
  if (!loading) {
    loading = (async () => {
      const [{ load }, { MobileNetV2Model }] = await Promise.all([import('nsfwjs/core'), import('nsfwjs/models/mobilenet_v2')]);
      model = await load('MobileNetV2', { modelDefinitions: [MobileNetV2Model], size: 224 });
      return model;
    })().catch((e) => { loading = null; throw e; });
  }
  return loading;
}

// one file at a time: a chat full of pictures would otherwise run dozens of passes at once
let queue = Promise.resolve();
const inLine = (job) => { const run = queue.then(job, job); queue = run.catch(() => {}); return run; };

const results = new WeakMap(); // Blob -> verdict, so a file that is shown twice is checked once
const RANK = { ok: 0, blur: 1, block: 2 };

function verdictOf(predictions) {
  const p = {};
  for (const x of predictions) p[x.className] = x.probability;
  const explicit = (p.Porn || 0) + (p.Hentai || 0);
  if (explicit >= BLOCK_AT) return 'block';
  if (explicit >= BLUR_EXPLICIT_AT || (p.Sexy || 0) >= BLUR_SEXY_AT) return 'blur';
  return 'ok';
}

function toCanvas(src, w, h) {
  const s = Math.min(1, LOOK_SIDE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * s));
  canvas.height = Math.max(1, Math.round(h * s));
  canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function classify(canvas) {
  const net = await getModel();
  return verdictOf(await net.classify(canvas, 5));
}

// a Blob, an ImageBitmap or a canvas: one picture
async function look(src) {
  let bmp = null;
  try {
    if (src instanceof Blob) {
      bmp = await createImageBitmap(src);
      src = bmp;
    }
    if (!src.width || !src.height) return 'ok';
    return await classify(toCanvas(src, src.width, src.height));
  } catch (e) {
    console.warn('image check could not run:', e?.message || e);
    return 'unknown';
  } finally {
    bmp?.close?.();
  }
}

// Looks at each spot in turn and stops at the first 'block'. grab(i) returns a canvas for spot i.
async function lookSpots(count, grab) {
  let worst = 'ok';
  for (let i = 0; i < count; i++) {
    const v = await classify(await grab(i));
    if (RANK[v] > RANK[worst]) worst = v;
    if (worst === 'block') break;
  }
  return worst;
}

function once(el, event, ms = 8000) {
  return new Promise((resolve, reject) => {
    const off = () => { clearTimeout(timer); el.removeEventListener(event, ok); el.removeEventListener('error', bad); };
    const ok = () => { off(); resolve(); };
    const bad = () => { off(); reject(new Error('could not read the file')); };
    const timer = setTimeout(bad, ms);
    el.addEventListener(event, ok);
    el.addEventListener('error', bad);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lookVideo(blob) {
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  try {
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    const ready = once(v, 'loadeddata');
    v.src = url;
    await ready;
    if (!v.videoWidth || !v.videoHeight) return 'ok'; // sound only
    const len = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0; // a recorded webm can report no length
    const spots = len ? Math.max(MIN_SPOTS, Math.min(MAX_SPOTS, Math.ceil(len))) : 1;
    return await lookSpots(spots, async (i) => {
      if (len) {
        const seeked = once(v, 'seeked');
        v.currentTime = (len * (i + 0.5)) / spots;
        await seeked;
      }
      return toCanvas(v, v.videoWidth, v.videoHeight);
    });
  } catch (e) {
    console.warn('video check could not run:', e?.message || e);
    return 'unknown';
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}

// A browser without ImageDecoder cannot take an animation apart. The picture is put on the page, out of sight, where it keeps playing,
// and whatever frame is showing is taken a few times. That sees about three seconds of the loop, not all of it.
async function lookPlaying(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  try {
    const loaded = once(img, 'load');
    img.src = url;
    document.body.appendChild(img);
    await loaded;
    if (!img.naturalWidth || !img.naturalHeight) return 'ok';
    return await lookSpots(8, async () => { await sleep(350); return toCanvas(img, img.naturalWidth, img.naturalHeight); });
  } catch (e) {
    console.warn('animated picture check could not run:', e?.message || e);
    return 'unknown';
  } finally {
    img.remove();
    URL.revokeObjectURL(url);
  }
}

// an animated GIF or WebP
async function lookAnimated(blob, mime) {
  if (typeof ImageDecoder === 'undefined') return lookPlaying(blob);
  let dec = null;
  try {
    dec = new ImageDecoder({ data: blob.stream(), type: mime });
    await dec.tracks.ready;
    const frames = dec.tracks.selectedTrack.frameCount;
    if (!(frames > 1)) return await look(blob);
    const spots = Math.min(frames, MAX_SPOTS);
    return await lookSpots(spots, async (i) => {
      const { image } = await dec.decode({ frameIndex: Math.min(frames - 1, Math.floor((frames * (i + 0.5)) / spots)) });
      try { return toCanvas(image, image.displayWidth, image.displayHeight); } finally { image.close(); }
    });
  } catch (e) {
    console.warn('animated picture check fell back:', e?.message || e);
    return lookPlaying(blob);
  } finally {
    dec?.close();
  }
}

async function lookBlob(blob) {
  const real = await sniffType(blob);
  if (real.kind === 'image') return real.animated ? lookAnimated(blob, real.mime) : look(blob);
  if (real.kind === 'video') return lookVideo(blob);
  if (real.kind === 'audio' || real.kind === 'other') return 'ok';
  // the bytes say nothing: go by what the file was said to be
  if (blob.type.startsWith('video/')) return lookVideo(blob);
  if (blob.type.startsWith('image/')) return look(blob);
  return 'ok';
}

// src: a Blob or File (anything: pictures, GIFs and videos are looked at, the rest is 'ok'), an ImageBitmap or a canvas
export async function scanImage(src) {
  if (src instanceof Blob) {
    if (results.has(src)) return results.get(src);
    const v = await inLine(() => lookBlob(src).catch(() => 'unknown'));
    if (v !== 'unknown') results.set(src, v); // a check that could not run is tried again next time
    return v;
  }
  return inLine(() => look(src));
}

// Chat: nudity and explicit files are not sent, and neither is one that could not be checked. A suggestive one is sent and shown blurred to whoever opens the chat.
export async function refuseExplicit(src) {
  const v = await scanImage(src);
  if (v === 'block') throw new Error(EXPLICIT_MSG);
  if (v === 'unknown') throw new Error(UNCHECKED_MSG);
}

// Pictures that show up all over (profile, banner, server icon, emoji, badges): a picture there cannot be blurred, so both answers are refused.
export async function requireClean(src) {
  const v = await scanImage(src);
  if (v === 'block') throw new Error(EXPLICIT_MSG);
  if (v === 'blur') throw new Error(SUGGESTIVE_MSG);
  if (v === 'unknown') throw new Error(UNCHECKED_MSG);
}
