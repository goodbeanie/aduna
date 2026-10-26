
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

// Centre-crops the picture to the target aspect ratio, scales it down, and re-encodes it.
// This also strips EXIF data (e.g. GPS location) and keeps uploads small. Animated GIFs become
// still images (first frame).
async function drawCover(file, w, h) {
  if (!ACCEPT.includes(file.type)) throw new Error('Choose a PNG, JPEG, WebP or GIF image');
  if (file.size > MAX_INPUT) throw new Error('That image is too big (max 15 MB)');

  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch { throw new Error("Couldn't read that image"); }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';

  const scale = Math.max(w / bmp.width, h / bmp.height); // "cover"
  const sw = w / scale, sh = h / scale;
  ctx.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, w, h);
  bmp.close?.();
  return canvas;
}

export async function processImage(file, { w, h }) {
  const canvas = await drawCover(file, w, h);

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
  if (removed < gone.length * 0.005 || removed > gone.length * 0.92) return false; // nothing to cut, or nothing would be left

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
export const FRAME = { side: 512, hole: 384 };

// The template an artist downloads: the see-through square with guides. Draw the ring in the blue band, keep the circle in the middle empty,
// then hide or delete the guide layer in your art program and export a PNG. (The Settings page lets them check it before uploading.)
export async function makeFrameTemplate() {
  const S = FRAME.side, c = S / 2, r = FRAME.hole / 2;
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = 'rgba(70,140,255,0.28)'; // the ring band: from the avatar circle out to the edge of the square
  ctx.beginPath(); ctx.rect(0, 0, S, S); ctx.arc(c, c, r, 0, Math.PI * 2, true); ctx.fill('evenodd');
  ctx.strokeStyle = 'rgba(70,140,255,0.9)'; ctx.lineWidth = 2; ctx.setLineDash([]);
  ctx.strokeRect(1, 1, S - 2, S - 2);
  ctx.strokeStyle = 'rgba(235,60,60,0.95)'; ctx.setLineDash([10, 8]); ctx.lineWidth = 3; // the avatar circle: keep everything inside it empty
  ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]); ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(235,60,60,0.95)'; ctx.font = '600 20px sans-serif';
  ctx.fillText('Profile picture goes here', c, c - 4);
  ctx.font = '16px sans-serif'; ctx.fillText('keep this circle empty', c, c + 20);
  ctx.fillStyle = 'rgba(40,100,220,0.95)'; ctx.font = '600 15px sans-serif';
  ctx.fillText('Draw your ring in the blue band', c, 30);
  ctx.font = '13px sans-serif'; ctx.fillText('512 x 512 PNG. Hide or delete this guide layer before you export.', c, 50);
  const blob = await toBlob(canvas, 'image/png');
  if (!blob) throw new Error("Couldn't make the template");
  return blob;
}

// A frame picture from the artist's file: fitted (not cropped) into the 512px square, kept as a PNG so the see-through parts stay see-through.
// Refuses a picture whose middle is filled in, because it would cover the profile picture, and one that has no ring at all.
export async function processFrame(file) {
  if (!ACCEPT.includes(file.type)) throw new Error('Choose a PNG, JPEG, WebP or GIF image');
  if (file.size > MAX_INPUT) throw new Error('That image is too big (max 15 MB)');
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch { throw new Error("Couldn't read that image"); }
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
  const c = S / 2, rIn = (FRAME.hole / 2) * 0.96; // look at the avatar circle, a hair smaller so a ring that touches its edge is fine
  let inside = 0, filledIn = 0, ring = 0;
  for (let y = 0; y < S; y += 2) for (let x = 0; x < S; x += 2) {
    const a = d[(y * S + x) * 4 + 3], dist = Math.hypot(x + 0.5 - c, y + 0.5 - c);
    if (dist <= rIn) { inside++; if (a > 40) filledIn++; } else if (a > 40) ring++;
  }
  if (filledIn > inside * 0.04) throw new Error('The middle of a frame has to be see-through, so the profile picture shows. Download the template: the dashed circle is where the picture goes.');
  if (ring < 200) throw new Error('There is nothing drawn around the middle. Draw your ring in the blue band of the template.');
  const blob = await toBlob(canvas, 'image/png');
  if (!blob) throw new Error("Couldn't process that image");
  if (blob.size > 1024 * 1024) throw new Error('That image is still too large after resizing, try a simpler one');
  return blob;
}

// A piece of art for an artist application: scaled down to fit inside maxSide x maxSide, NOT cropped (a reviewer needs to see all of it).
// WebP when the browser can make it, otherwise JPEG; re-encoding also strips EXIF data. Stays under the server's 1 MB upload limit.
export async function processPiece(file, maxSide = 1600) {
  if (!ACCEPT.includes(file.type)) throw new Error('Choose a PNG, JPEG, WebP or GIF image');
  if (file.size > MAX_INPUT) throw new Error('That image is too big (max 15 MB)');
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch { throw new Error("Couldn't read that image"); }
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
