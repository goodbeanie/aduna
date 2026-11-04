// Photos are made smaller on the sender's device before they are encrypted and uploaded (the server cannot do it: direct messages and
// group files are end-to-end encrypted). A photo is scaled down to at most MAX_SIDE pixels on its long side and saved again at a lower quality.
// The smaller copy is only used when it really is smaller; GIFs (animated) and other types are never touched. The original file is not changed.
// Re-saving also drops the hidden camera data (location, device) that photos carry.

export const MAX_SIDE = 2048;
const QUALITY = 0.82;
const SKIP_UNDER = 250 * 1024; // a small photo that already fits is left alone
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Returns a smaller File, or the same file when it cannot or need not be made smaller. Never throws.
export async function shrinkImage(file) {
  const type = String(file?.type || '').toLowerCase();
  if (!TYPES.includes(type)) return file;
  let bmp = null;
  try {
    bmp = await createImageBitmap(file); // the camera's rotation is applied by the browser
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    if (k === 1 && file.size < SKIP_UNDER) return file;
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const outType = type === 'image/jpeg' ? 'image/jpeg' : 'image/webp'; // PNG and WebP keep any see-through parts as WebP
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, outType, QUALITY));
    if (!blob || blob.type !== outType) return file;  // this browser cannot save that type
    if (blob.size >= file.size * 0.9) return file;    // not worth it
    const name = (file.name || 'image').replace(/\.[^.]+$/, '') + (outType === 'image/jpeg' ? '.jpg' : '.webp');
    return new File([blob], name, { type: outType, lastModified: file.lastModified || Date.now() });
  } catch {
    return file;
  } finally {
    try { bmp?.close?.(); } catch { /* nothing to close */ }
  }
}
