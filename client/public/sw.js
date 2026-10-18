// Minimal service worker. It exists so browsers treat Aduna as an installable app.
// It does not cache anything, so the app and its encrypted data are always fetched fresh from the server.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* network only */ });
