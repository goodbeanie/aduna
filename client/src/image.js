import { getToken } from './api.js';

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
export async function processImage(file, { w, h }) {
  if (!ACCEPT.includes(file.type)) throw new Error('Choose a PNG, JPEG, WebP or GIF image');
  if (file.size > MAX_INPUT) throw new Error('That image is too big (max 15 MB)');

  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch { throw new Error("Couldn't read that image"); }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';

  const scale = Math.max(w / bmp.width, h / bmp.height); // "cover"
  const sw = w / scale, sh = h / scale;
  ctx.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, w, h);
  bmp.close?.();

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

// `base` is '/api/me' for profile pictures, or `/api/servers/<id>` for a server's icon and banner.
export async function uploadImage(kind, blob, base = '/api/me') {
  const res = await fetch(`${base}/${kind}`, {
    method: 'PUT',
    headers: { 'Content-Type': blob.type, Authorization: 'Bearer ' + getToken() },
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}
