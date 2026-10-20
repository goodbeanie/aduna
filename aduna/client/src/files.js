// Attachment helpers: upload (with progress), fetch + decrypt, and small formatting utilities.
import { encryptBytesFor, decryptBytesFrom } from './crypto.js';

export const MAX_FILE = 20 * 1024 * 1024;
// The server deletes attachments after FILE_DAYS days, or LARGE_FILE_DAYS for files over LARGE_FILE_BYTES (see server/index.js).
export const FILE_DAYS = 14;
export const LARGE_FILE_DAYS = 5;
export const LARGE_FILE_BYTES = 10 * 1024 * 1024;
export const keepDays = (size) => (size > LARGE_FILE_BYTES ? LARGE_FILE_DAYS : FILE_DAYS);
export const MAX_ATTACH = 4;
const INLINE = {
  image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'],
  video: ['video/mp4', 'video/webm'],
  audio: ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/webm'],
};
export const kindOf = (type) => Object.keys(INLINE).find((k) => INLINE[k].includes(type)) || 'file';

export const sizeLabel = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');

// Only GIFs from the GIF service are ever loaded from a third party.
export const safeGif = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && /^(media\d*|i)\.giphy\.com$/.test(x.hostname); } catch { return false; } };

// What a message looks like in a one-line preview (reply bars, delete dialog)
export const previewText = (m) => m.content || (m.attachments?.length ? (m.attachments[0].gif ? 'GIF' : m.attachments[0].name || 'Attachment') : '');

async function imageSize(file) {
  if (!file.type.startsWith('image/')) return {};
  try { const b = await createImageBitmap(file); const r = { w: b.width, h: b.height }; b.close?.(); return r; } catch { return {}; }
}

// scope: { kind: 'channel', target: channelId } or { kind: 'dm', target: userId, privKey, theirPublic }
export async function uploadFile(file, scope, onProgress) {
  if (file.size > MAX_FILE) throw new Error(`${file.name} is larger than 20 MB`);
  if (!file.size) throw new Error(`${file.name} is empty`);
  let body = await file.arrayBuffer();
  if (scope.kind === 'dm') body = await encryptBytesFor(scope.privKey, scope.theirPublic, body);
  const id = await new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api/files?kind=${scope.kind}&target=${encodeURIComponent(scope.target)}`);
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => {
      let d = {}; try { d = JSON.parse(x.responseText); } catch {}
      x.status >= 200 && x.status < 300 && d.id ? resolve(d.id) : reject(new Error(d.error || 'Upload failed'));
    };
    x.onerror = () => reject(new Error('Upload failed'));
    x.send(body);
  });
  return { id, name: file.name || 'file', type: file.type || 'application/octet-stream', size: file.size, ...(await imageSize(file)) };
}

export const discardUpload = (id) => fetch('/api/files/' + id, { method: 'DELETE' }).catch(() => {});

// Fetch an attachment as a Blob (decrypting DM files). Cached per file id.
const cache = new Map();
export function loadBlob(att, dm) {
  if (!cache.has(att.id)) {
    cache.set(att.id, (async () => {
      const res = await fetch('/api/files/' + att.id);
      if (res.status === 404) throw Object.assign(new Error('This file has expired'), { expired: true }); // removed by the cleanup
      if (!res.ok) throw new Error('Could not load file');
      let buf = await res.arrayBuffer();
      if (dm) buf = await decryptBytesFrom(dm.privKey, dm.theirPublic, buf);
      return new Blob([buf], { type: att.type });
    })().catch((e) => { cache.delete(att.id); throw e; }));
  }
  return cache.get(att.id);
}

export async function saveAttachment(att, dm) {
  const url = URL.createObjectURL(await loadBlob(att, dm));
  const a = document.createElement('a');
  a.href = url; a.download = att.name || 'file';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
