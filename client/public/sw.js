// Service worker. Two jobs:
//  1. It exists so browsers treat Aduna as an installable app. It caches nothing, so the app and its encrypted data
//     are always fetched fresh from the server.
//  2. It shows notifications: pushes sent by the server while Aduna is closed, and the ones the open page asks for
//     (phones only allow notifications through a service worker). Each one shows who wrote it, their picture (or the server's) drawn
//     on a tile in the app theme (DMs) or the server theme, what was said, and Reply / Mark as read buttons. Tapping it opens the right chat.
//     The phone draws the notification itself (its background, fonts and buttons follow the phone's own light/dark setting): the picture
//     is the part Aduna can theme.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* network only */ });

const IOS = /iPhone|iPad|iPod/.test(self.navigator.userAgent);
const ICON = '/notif-icon-192.png'; // dark logo on parchment: readable on light and dark notification shades
const BADGE = '/icon-192.png';      // the small status-bar icon: Android only uses its shape (alpha), so the transparent logo is right

// ---------- the person's theme (the page keeps it in IndexedDB, see src/swstate.js) ----------
const DEFAULT_LOOK = { dark: false, bg: '#fbf8f1', accent: '#1c1812', serverThemes: true };
async function readLook() {
  try {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('aduna-sw', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const v = await new Promise((resolve, reject) => { const q = db.transaction('kv').objectStore('kv').get('look'); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
    db.close();
    return v && /^#[0-9a-fA-F]{6}$/.test(v.bg) && /^#[0-9a-fA-F]{6}$/.test(v.accent) ? { ...DEFAULT_LOOK, ...v } : DEFAULT_LOOK;
  } catch { return DEFAULT_LOOK; }
}

// ---------- the picture ----------
// A 192 px tile in the theme's background colour with a ring in its accent colour, and the profile picture (or server icon) as a circle on it.
// Without a picture the circle holds the first letter of the name. Any failure (no OffscreenCanvas, image blocked) falls back to the plain logo.
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
function toDataUrl(buf) {
  const bytes = new Uint8Array(buf); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return 'data:image/png;base64,' + btoa(bin);
}
function readableOn(hex) { // black or white, whichever reads better on this colour
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#111111' : '#ffffff';
}
async function makeIcon(d, look) {
  if (typeof OffscreenCanvas === 'undefined') return null;
  if (!d.icon && !d.sender) return null;
  const t = d.theme && look.serverThemes !== false ? d.theme : look; // a server notification wears the server's colours unless the person turned that off
  const S = 192, c = new OffscreenCanvas(S, S), g = c.getContext('2d');
  const r = 36;
  g.fillStyle = t.bg; g.beginPath();
  g.moveTo(r, 0); g.arcTo(S, 0, S, S, r); g.arcTo(S, S, 0, S, r); g.arcTo(0, S, 0, 0, r); g.arcTo(0, 0, S, 0, r); g.closePath(); g.fill();
  const cx = S / 2, rad = 76;
  g.fillStyle = t.accent; g.beginPath(); g.arc(cx, cx, rad + 6, 0, Math.PI * 2); g.fill(); // the ring
  let drawn = false;
  if (d.icon) {
    try {
      const res = await withTimeout(fetch(new URL(d.icon, self.location.origin), { credentials: 'same-origin' }), 4000);
      if (res.ok) {
        const bmp = await createImageBitmap(await res.blob());
        g.save(); g.beginPath(); g.arc(cx, cx, rad, 0, Math.PI * 2); g.clip();
        const side = Math.min(bmp.width, bmp.height); // centre-crop to a square
        g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, cx - rad, cx - rad, rad * 2, rad * 2);
        g.restore(); drawn = true;
      }
    } catch { /* draw the letter instead */ }
  }
  if (!drawn) {
    g.fillStyle = t.bg; g.beginPath(); g.arc(cx, cx, rad, 0, Math.PI * 2); g.fill();
    g.fillStyle = t.accent; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = '600 88px system-ui, sans-serif';
    g.fillText((Array.from(String(d.sender || '?'))[0] || '?').toUpperCase(), cx, cx + 4);
  }
  return toDataUrl(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

// ---------- showing one ----------
const maxActions = () => (self.Notification && self.Notification.maxActions) || 0; // Android Chrome: 2. iPhone / Firefox: none, then tapping is the only action
function actionsFor(d) {
  const list = [];
  if (d.reply === 'inline') list.push({ action: 'reply', title: 'Reply', type: 'text', placeholder: 'Write a reply\u2026' }); // browsers without text actions show a plain button
  else if (d.reply === 'open') list.push({ action: 'reply', title: 'Reply' });
  if (d.read) list.push({ action: 'read', title: 'Mark as read' });
  return list.slice(0, maxActions());
}
async function present(d) {
  let icon = ICON;
  try { icon = (await makeIcon(d, await readLook())) || ICON; } catch { /* the logo is fine */ }
  const actions = actionsFor(d);
  await self.registration.showNotification(d.title || 'Aduna', {
    body: d.body || '',
    tag: d.tag,
    icon,
    badge: BADGE,
    ...(actions.length ? { actions } : {}),
    data: { url: d.url || '/app', kind: d.kind || '', serverId: d.serverId || '', channelId: d.channelId || '', peerId: d.peerId || '', msgId: d.msgId || '', reply: d.reply || '', read: !!d.read },
    requireInteraction: d.kind === 'call',
    renotify: !!d.force,
    vibrate: d.kind === 'call' ? [300, 150, 300, 150, 300] : [120],
  });
}

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { /* not JSON: show the generic text */ }
  e.waitUntil((async () => {
    // Someone looking at Aduna right now already sees the message. (iOS insists that every push is shown, so it always is.)
    if (!IOS && !d.force) {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (wins.some((w) => w.visibilityState === 'visible' && w.focused)) return;
    }
    // The open page may already have shown this one, with the decrypted text of a DM: keep that version.
    if (d.tag) { const have = await self.registration.getNotifications({ tag: d.tag }); if (have.length) return; }
    await present(d);
  })());
});

// The open page asks for notifications through here too, so they look the same as pushed ones (the page knows the decrypted text of a DM).
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'aduna:show' && e.data.d && typeof e.data.d === 'object') e.waitUntil(present(e.data.d).catch(() => {}));
});

// ---------- the buttons ----------
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r;
}
async function tell(msg) { for (const w of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) w.postMessage(msg); }

// Mark as read: a channel is saved on the server (open pages and other devices learn through the socket); a DM's unread count only exists in
// the page (DMs are end-to-end encrypted, the server keeps no read marker), so open pages are told directly.
async function markRead(n, d) {
  if (d.channelId) await post(`/api/channels/${encodeURIComponent(d.channelId)}/read`, {});
  if (d.peerId) await tell({ type: 'aduna:read', target: 'd:' + d.peerId });
  n.close();
}
// Reply typed into the notification: only channels (plain text through the server). A DM would have to be encrypted with a key this
// worker does not have, so a DM's Reply button opens the chat with the cursor in the box instead.
async function quickReply(n, d, text) {
  try {
    await post(`/api/channels/${encodeURIComponent(d.channelId)}/quick-reply`, { content: text, replyTo: d.msgId || undefined });
    n.close();
  } catch {
    await self.registration.showNotification('Reply not sent', { body: 'Tap to open the chat and send it there.', tag: n.tag, icon: n.icon, badge: BADGE, data: { ...d, reply: '', read: false } });
  }
}

async function openChat(url, focus) {
  const target = url.searchParams.get('n') || '';
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const open = wins.find((w) => new URL(w.url).origin === self.location.origin);
  if (open) {
    await open.focus();
    open.postMessage({ type: 'aduna:open', target, focus }); // the page switches to that chat
  } else {
    const q = new URLSearchParams(url.search); if (focus) q.set('focus', '1');
    await self.clients.openWindow(url.pathname + (q.toString() ? '?' + q : ''));
  }
}

self.addEventListener('notificationclick', (e) => {
  const n = e.notification, d = n.data || {};
  if (e.action === 'read') { // browsers close a notification when any button is tapped, so a failure (offline, signed out) shows it again
    e.waitUntil(markRead(n, d).catch(() => self.registration.showNotification('Could not mark as read', { body: 'Tap to open the chat.', tag: n.tag, icon: n.icon, badge: BADGE, data: { ...d, reply: '', read: false } })));
    return;
  }
  n.close();
  const url = new URL(d.url || '/app', self.location.origin);
  if (url.origin !== self.location.origin) return;
  const typed = typeof e.reply === 'string' ? e.reply.trim() : '';
  if (e.action === 'reply' && d.reply === 'inline' && d.channelId && typed) { e.waitUntil(quickReply(n, d, typed)); return; }
  e.waitUntil(openChat(url, e.action === 'reply')); // Reply without text (button-only browsers, DMs) opens the chat with the cursor in the box
});
