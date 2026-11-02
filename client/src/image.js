import { t as tr } from './i18n.js';
import { SOUND } from './soundboard.js';

export const imageUrl = (id) => (id ? `/api/images/${id}` : null);

export const AVATAR_SIZE = { w: 500, h: 500 };
export const BANNER_SIZE = { w: 1200, h: 300 }; // 4:1, matches the profile card
export const SERVER_ICON_SIZE = { w: 256, h: 256 };
export const SERVER_BANNER_SIZE = { w: 960, h: 320 }; // 3:1, matches the banner at the top of the server's channel list

const ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const ACCEPT_ATTR = ACCEPT.join(',');
const MAX_INPUT = 15 * 1024 * 1024; // refuse absurdly large originals before decoding

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

// Crops the picture to the target aspect ratio, scales it down, and re-encodes it.
// `crop` is optional: { x, y, zoom } where x and y (0 to 1) are the middle of the part you want, as a share of the picture's width and height,
// and zoom (1 or more) zooms in. Without it the middle of the picture is used. The result is the same "cover" fit the crop window shows.
// This also strips EXIF data (e.g. GPS location) and keeps uploads small. An animated GIF becomes a still image here (first frame);
// uploadAnimated below sends the animation itself.
export function checkImageFile(file) {
  if (!ACCEPT.includes(file.type)) throw new Error(tr('imgType'));
  if (file.size > MAX_INPUT) throw new Error(tr('imgBig'));
}

async function drawCover(file, w, h, crop) {
  checkImageFile(file);

  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch { throw new Error(tr('imgRead')); }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';

  const zoom = Math.max(1, crop?.zoom || 1);
  const scale = Math.max(w / bmp.width, h / bmp.height) * zoom; // "cover", then zoomed in
  const sw = w / scale, sh = h / scale;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const sx = clamp((crop?.x ?? 0.5) * bmp.width - sw / 2, 0, bmp.width - sw);
  const sy = clamp((crop?.y ?? 0.5) * bmp.height - sh / 2, 0, bmp.height - sh);
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
  bmp.close?.();
  return canvas;
}

export async function processImage(file, { w, h }, crop) {
  const canvas = await drawCover(file, w, h, crop);

  // WebP keeps transparency and is small; some browsers (Safari) can't encode it, so fall back to JPEG.
  let blob = await toBlob(canvas, 'image/webp', 0.88);
  if (!blob || blob.type !== 'image/webp') {
    const flat = document.createElement('canvas');
    flat.width = w; flat.height = h;
    const fctx = flat.getContext('2d');
    fctx.fillStyle = '#fff';
    fctx.fillRect(0, 0, w, h);
    fctx.drawImage(canvas, 0, 0);
    blob = await toBlob(flat, 'image/jpeg', 0.9);
  }
  if (!blob) throw new Error("Couldn't process that image");
  if (blob.size > 1024 * 1024) throw new Error('That image is still too large after resizing, try a different one');
  return blob;
}

// Badges: the same crop, then the plain background is cut out (so a logo on white becomes a logo on nothing) and the result is kept as a
// PNG, which keeps the see-through parts in every browser.
const BG_NEAR = 28;  // a pixel this close to the background colour is background
const BG_FAR = 64;   // between NEAR and FAR, a pixel on the edge is faded out gradually

// Looks at the four corners; if they agree on one solid colour, everything of that colour that touches the picture's edge is made
// transparent. Returns false (and changes nothing) when the picture already has see-through corners, has no plain background, or
// would be wiped out.
export function removeBackground(canvas) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const at = (x, y) => (y * w + x) * 4;

  const corners = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)];
  if (corners.some((i) => d[i + 3] < 250)) return false; // already has transparency
  const bg = [0, 1, 2].map((c) => corners.reduce((s, i) => s + d[i + c], 0) / 4);
  const dist = (i) => Math.max(Math.abs(d[i] - bg[0]), Math.abs(d[i + 1] - bg[1]), Math.abs(d[i + 2] - bg[2]));
  if (corners.some((i) => dist(i) > BG_NEAR)) return false; // corners disagree: a photo, not a plain background

  const gone = new Uint8Array(w * h);
  const stack = [];
  const seed = (x, y) => { const p = y * w + x; if (!gone[p] && dist(p * 4) <= BG_NEAR) { gone[p] = 1; stack.push(p); } };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
  while (stack.length) {
    const p = stack.pop(), x = p % w, y = (p - x) / w;
    if (x > 0) seed(x - 1, y);
    if (x < w - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y < h - 1) seed(x, y + 1);
  }

  let removed = 0;
  for (let p = 0; p < gone.length; p++) removed += gone[p];
  if (removed < gone.length * 0.005 || removed > gone.length * 0.75) return false; // nothing to cut, or too little would be left (the art is probably the same colour as its background)

  // soften the rim: a pixel touching the background fades out the closer its colour is to the background
  for (let p = 0; p < gone.length; p++) {
    if (gone[p]) continue;
    const x = p % w, y = (p - x) / w;
    const touches = (x > 0 && gone[p - 1]) || (x < w - 1 && gone[p + 1]) || (y > 0 && gone[p - w]) || (y < h - 1 && gone[p + w]);
    if (!touches) continue;
    const dd = dist(p * 4);
    if (dd < BG_FAR) d[p * 4 + 3] = Math.round(255 * Math.max(0, Math.min(1, (dd - BG_NEAR) / (BG_FAR - BG_NEAR))));
  }
  for (let p = 0; p < gone.length; p++) if (gone[p]) d[p * 4 + 3] = 0;
  ctx.putImageData(img, 0, 0);
  return true;
}

export async function processBadge(file, { w, h }) {
  const canvas = await drawCover(file, w, h);
  removeBackground(canvas);
  const blob = await toBlob(canvas, 'image/png');
  if (!blob) throw new Error("Couldn't process that image");
  if (blob.size > 1024 * 1024) throw new Error('That image is still too large after resizing, try a different one');
  return blob;
}

// Profile frames (an artist's ring around the avatar). The picture is a 512px square PNG; the avatar fills a 384px circle in the middle of it
// (the same numbers as FRAME in server/artists.js), so the artist draws the ring in the 64px band around that circle. The middle must be see-through.
export const FRAME = { side: 512, hole: 384, corner: 0.26 }; // the avatar is a rounded square (corner = radius as a share of its side, as in .avatar in redesign.css)

// The avatar's shape inside the frame: a rounded square `hole` wide, centred. `shrink` makes it a little smaller (1 = exact).
function holePath(ctx, shrink = 1) {
  const S = FRAME.side, w = FRAME.hole * shrink, x = (S - w) / 2, rad = w * FRAME.corner;
  ctx.moveTo(x + rad, x);
  ctx.arcTo(x + w, x, x + w, x + w, rad); ctx.arcTo(x + w, x + w, x, x + w, rad);
  ctx.arcTo(x, x + w, x, x, rad); ctx.arcTo(x, x, x + w, x, rad);
  ctx.closePath();
}

// The template an artist downloads: a 512px square with guides. Draw the ring in the blue band, keep the rounded square in the middle empty.
// Put it on a layer under your art and hide it before you export a PNG (the Settings page checks the picture before uploading).
export async function makeFrameTemplate() {
  const S = FRAME.side, c = S / 2;
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = 'rgba(70,140,255,0.28)'; // the ring band: from the avatar's edge out to the edge of the square
  ctx.beginPath(); ctx.rect(0, 0, S, S); holePath(ctx); ctx.fill('evenodd');
  ctx.strokeStyle = 'rgba(70,140,255,0.9)'; ctx.lineWidth = 2; ctx.setLineDash([]);
  ctx.strokeRect(1, 1, S - 2, S - 2);
  ctx.strokeStyle = 'rgba(235,60,60,0.95)'; ctx.setLineDash([10, 8]); ctx.lineWidth = 3; // the avatar: keep everything inside it empty
  ctx.beginPath(); holePath(ctx); ctx.stroke();
  ctx.setLineDash([]); ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(235,60,60,0.95)'; ctx.font = '600 20px sans-serif';
  ctx.fillText('Profile picture goes here', c, c - 4);
  ctx.font = '16px sans-serif'; ctx.fillText('keep this square empty', c, c + 20);
  ctx.fillStyle = 'rgba(40,100,220,0.95)'; ctx.font = '600 15px sans-serif';
  ctx.fillText('Draw your ring in the blue band', c, 30);
  ctx.font = '13px sans-serif'; ctx.fillText('512 x 512 PNG. Keep this on its own layer and hide it before you export.', c, 50);
  const blob = await toBlob(canvas, 'image/png');
  if (!blob) throw new Error("Couldn't make the template");
  return blob;
}

// A frame picture from the artist's file: fitted (not cropped) into the 512px square, kept as a PNG so the see-through parts stay see-through.
// Refuses a picture whose middle is filled in, because it would cover the profile picture, and one that has no ring at all.
export async function processFrame(file) {
  if (!ACCEPT.includes(file.type)) throw new Error(tr('imgType'));
  if (file.size > MAX_INPUT) throw new Error(tr('imgBig'));
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch { throw new Error(tr('imgRead')); }
  const S = FRAME.side;
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  const scale = Math.min(S / bmp.width, S / bmp.height);
  const w = bmp.width * scale, h = bmp.height * scale;
  ctx.drawImage(bmp, (S - w) / 2, (S - h) / 2, w, h);
  bmp.close?.();
  const d = ctx.getImageData(0, 0, S, S).data;
  ctx.beginPath(); holePath(ctx, 0.96); // look at the avatar's shape, a hair smaller so a ring that touches its edge is fine
  let inside = 0, filledIn = 0, ring = 0;
  for (let y = 0; y < S; y += 2) for (let x = 0; x < S; x += 2) {
    const a = d[(y * S + x) * 4 + 3];
    if (ctx.isPointInPath(x + 0.5, y + 0.5)) { inside++; if (a > 40) filledIn++; } else if (a > 40) ring++;
  }
  if (filledIn > inside * 0.04) throw new Error('The middle of a frame has to be see-through, so the profile picture shows. Download the template: the dashed square is where the picture goes.');
  if (ring < 200) throw new Error('There is nothing drawn around the middle. Draw your ring in the blue band of the template.');
  const blob = await toBlob(canvas, 'image/png');
  if (!blob) throw new Error("Couldn't process that image");
  if (blob.size > 1024 * 1024) throw new Error('That image is still too large after resizing, try a simpler one');
  return blob;
}

// Stickers (an artist's pack): scaled down to fit 512px, never cropped, kept see-through. The numbers are LIMITS in server/stickers.js, which checks them again.
// A GIF cannot be resized here (the animation would be lost), so it is sent as it is when it already fits.
export const STICKER = { minSide: 64, maxSide: 512, maxRatio: 2, maxBytes: 512 * 1024 };
export async function processSticker(file, L = STICKER) {
  if (!ACCEPT.includes(file.type)) throw new Error(tr('imgType'));
  if (file.size > MAX_INPUT) throw new Error(tr('imgBig'));
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch { throw new Error(tr('imgRead')); }
  const { width: bw, height: bh } = bmp;
  const small = Math.min(bw, bh), big = Math.max(bw, bh);
  if (small < L.minSide) { bmp.close?.(); throw new Error(`Too small: a sticker is at least ${L.minSide}x${L.minSide} pixels`); }
  if (big / small > L.maxRatio) { bmp.close?.(); throw new Error('A sticker should be roughly square (no wider or taller than 2:1)'); }
  if (file.type === 'image/gif') {
    bmp.close?.();
    if (big > L.maxSide) throw new Error(`An animated sticker is at most ${L.maxSide}x${L.maxSide} pixels. Resize the GIF first: the app cannot shrink an animation.`);
    if (file.size > L.maxBytes) throw new Error(`That GIF is too big (max ${L.maxBytes / 1024} KB)`);
    return file;
  }
  for (const f of [1, 0.75, 0.55]) { // a big, busy picture may need a smaller size to fit
    const scale = Math.min(1, (L.maxSide * f) / big);
    const w = Math.max(1, Math.round(bw * scale)), h = Math.max(1, Math.round(bh * scale));
    if (Math.min(w, h) < L.minSide) break;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    if (L.removeBg) removeBackground(canvas); // optional: cut out a plain background (does nothing for photos or pictures that are already see-through). GIFs are sent as they are.
    for (const [type, q] of [['image/png'], ['image/webp', 0.9], ['image/webp', 0.75]]) {
      const blob = await toBlob(canvas, type, q);
      if (blob && blob.type === type && blob.size <= L.maxBytes) { bmp.close?.(); return blob; }
    }
  }
  bmp.close?.();
  throw new Error('That picture is still too big after resizing, try a simpler one');
}

// Adds a sticker to a sticker pack (an item the artist made). Returns { item } with the pack's stickers.
export async function uploadSticker(itemId, name, blob) {
  const res = await fetch(`/api/artists/items/${itemId}/stickers?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

// A piece of art for an artist application: scaled down to fit inside maxSide x maxSide, NOT cropped (a reviewer needs to see all of it).
// WebP when the browser can make it, otherwise JPEG; re-encoding also strips EXIF data. Stays under the server's 1 MB upload limit.
export async function processPiece(file, maxSide = 1600) {
  if (!ACCEPT.includes(file.type)) throw new Error(tr('imgType'));
  if (file.size > MAX_INPUT) throw new Error(tr('imgBig'));
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch { throw new Error(tr('imgRead')); }
  for (const side of [maxSide, Math.round(maxSide * 0.75), Math.round(maxSide * 0.55)]) { // a big, busy picture may need a smaller size to fit
    const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    let blob = await toBlob(canvas, 'image/webp', 0.9);
    if (!blob || blob.type !== 'image/webp') {
      const flat = document.createElement('canvas');
      flat.width = w; flat.height = h;
      const fctx = flat.getContext('2d');
      fctx.fillStyle = '#fff'; fctx.fillRect(0, 0, w, h); fctx.drawImage(canvas, 0, 0);
      blob = await toBlob(flat, 'image/jpeg', 0.88);
    }
    if (blob && blob.size <= 1000 * 1024) { bmp.close?.(); return blob; }
  }
  bmp.close?.();
  throw new Error('That image is still too large after resizing, try a different one');
}

// Animated pictures: the cropped still above is what gets stored as the picture; when the chosen file is a GIF, the original and the crop window
// are sent as well, and the server cuts the same part out of every frame. The app shows the still one and plays the GIF on hover.
export const ANIM_MAX_BYTES = 8 * 1024 * 1024; // the server's limit for the GIF
export const canAnimate = (file) => !!file && file.type === 'image/gif' && file.size <= ANIM_MAX_BYTES;

export async function uploadAnimated(kind, file, crop, base = '/api/me') {
  const q = new URLSearchParams({ x: String(crop?.x ?? 0.5), y: String(crop?.y ?? 0.5), zoom: String(crop?.zoom ?? 1) });
  const res = await fetch(`${base}/${kind}/animated?${q}`, { method: 'PUT', headers: { 'Content-Type': 'image/gif' }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not save the animation');
  return data;
}

// Profile song: a short clip. The numbers are LIMITS in server/profile.js; the server checks the size and the audio signature again, but it can only
// measure the length of a WAV, so the browser measures the others here before anything is uploaded.
export const SONG = { secs: 30, bytes: 1024 * 1024 };
const SONG_TYPES = { mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm' };
const songType = (file) => SONG_TYPES[(file.name.split('.').pop() || '').toLowerCase()] || (/^audio\/(mpeg|mp3|ogg|wav|x-wav|wave|mp4|x-m4a|m4a|webm)$/.test(file.type) ? file.type : '');
export const songNameOf = (file) => file.name.replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 60) || 'My song';
function audioSeconds(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), a = new Audio();
    const done = (fn, v) => { a.onloadedmetadata = a.onerror = null; a.removeAttribute('src'); URL.revokeObjectURL(url); fn(v); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(resolve, a.duration);
    a.onerror = () => done(reject, new Error('That file could not be read as audio'));
    a.src = url;
  });
}
// Throws a message the person can read when the file cannot be a profile song.
export async function checkSongFile(file) {
  if (!songType(file)) throw new Error('Choose an MP3, M4A, OGG, WAV or WebM audio file');
  if (file.size > SONG.bytes) throw new Error(`That song is too big (max ${SONG.bytes / 1024} KB). Use a clip of up to ${SONG.secs} seconds.`);
  const secs = await audioSeconds(file);
  if (Number.isFinite(secs) && secs > SONG.secs + 1) throw new Error(`That song is too long (max ${SONG.secs} seconds)`);
}
export async function uploadSong(file, title) {
  const res = await fetch('/api/me/song?title=' + encodeURIComponent(title || ''), { method: 'PUT', headers: { 'Content-Type': songType(file) }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data; // { user }
}

// Soundboard sounds: much shorter than a profile song (SOUND in soundboard.js = LIMITS in server/soundboard.js). Same rule as the song: the server checks the size and
// the audio signature again, but it can only measure the length of a WAV, so the browser measures the others here before anything is uploaded.
export async function checkSoundFile(file) {
  if (!songType(file)) throw new Error('Choose an MP3, M4A, OGG, WAV or WebM audio file');
  if (file.size > SOUND.bytes) throw new Error(`That sound is too big (max ${SOUND.bytes / 1024} KB). Sounds are up to ${SOUND.secs} seconds long.`);
  const secs = await audioSeconds(file);
  if (Number.isFinite(secs) && secs > SOUND.secs + 0.5) throw new Error(`That sound is too long (max ${SOUND.secs} seconds)`);
}
export const soundNameOf = (file) => Array.from(songNameOf(file)).slice(0, SOUND.name).join('');
export async function uploadSound(serverId, file, name, emoji) {
  const q = new URLSearchParams({ name: name || '', emoji: emoji || '' });
  const res = await fetch(`/api/servers/${serverId}/sounds?${q}`, { method: 'POST', headers: { 'Content-Type': songType(file) }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data; // { server }
}

// `base` is '/api/me' for profile pictures, or `/api/servers/<id>` for a server's icon and banner.
export async function uploadImage(kind, blob, base = '/api/me') {
  const res = await fetch(`${base}/${kind}`, {
    method: 'PUT',
    headers: { 'Content-Type': blob.type },
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}
