// Service worker. Two jobs:
//  1. It exists so browsers treat Aduna as an installable app. It caches nothing, so the app and its encrypted data
//     are always fetched fresh from the server.
//  2. It shows notifications: pushes sent by the server while Aduna is closed, and the ones the open page asks for
//     (phones only allow notifications through a service worker). Tapping one opens the right chat.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* network only */ });

const IOS = /iPhone|iPad|iPod/.test(self.navigator.userAgent);
const ICON = '/notif-icon-192.png'; // dark logo on parchment: readable on light and dark notification shades
const BADGE = '/icon-192.png';      // the small status-bar icon: Android only uses its shape (alpha), so the transparent logo is right

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
    await self.registration.showNotification(d.title || 'Aduna', {
      body: d.body || '',
      tag: d.tag,
      icon: ICON,
      badge: BADGE,
      data: { url: d.url || '/app' },
      requireInteraction: d.kind === 'call',
      renotify: !!d.force,
      vibrate: d.kind === 'call' ? [300, 150, 300, 150, 300] : [120],
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/app', self.location.origin);
  if (url.origin !== self.location.origin) return;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      open.postMessage({ type: 'aduna:open', target: url.searchParams.get('n') || '' }); // the page switches to that chat
    } else {
      await self.clients.openWindow(url.pathname + url.search);
    }
  })());
});
