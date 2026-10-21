// Tests the notification buttons in client/public/sw.js with a stand-in for the service worker environment (no browser needed).
// The picture drawing itself needs a real canvas and was checked in Chromium; here: who gets told what when a button is tapped.
import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/sw.js'), 'utf8');

function boot({ ua = 'Mozilla/5.0 Android Chrome', fetchImpl, wins = [], maxActions = 2 } = {}) {
  const handlers = {}, shown = [], posts = [], opened = [];
  const fetchCalls = [];
  const self = {
    navigator: { userAgent: ua }, location: { origin: 'https://aduna.example' },
    Notification: { maxActions },
    addEventListener: (t, fn) => { handlers[t] = fn; },
    skipWaiting() {}, clients: {
      claim() {}, matchAll: async () => wins, openWindow: async (u) => { opened.push(u); },
    },
    registration: { showNotification: async (title, o) => { shown.push({ title, ...o }); }, getNotifications: async () => [] },
    fetch: async (u, o) => { fetchCalls.push({ u: String(u), body: o && o.body ? JSON.parse(o.body) : null }); return fetchImpl ? fetchImpl(u, o) : { ok: true, status: 200 }; },
  };
  self.self = self;
  vm.runInNewContext(src, { ...self, self, URL, URLSearchParams, JSON, Promise, setTimeout, Uint8Array, String, Array, Math, Error, console, encodeURIComponent, btoa: (s) => Buffer.from(s, 'binary').toString('base64') });
  const run = async (type, ev) => { let p; ev.waitUntil = (x) => { p = x; }; handlers[type](ev); await p; };
  return { run, shown, fetchCalls, opened, posts, wins };
}
const note = (data) => ({ tag: 't', icon: 'data:x', closed: false, data, close() { this.closed = true; } });
const win = () => { const w = { url: 'https://aduna.example/app', msgs: [], focused: 0, focus: async () => { w.focused++; }, postMessage: (m) => w.msgs.push(JSON.parse(JSON.stringify(m))), visibilityState: 'hidden', focused_: false }; return w; };

(async () => {
  // Mark as read, channel: saved on the server, notification closed
  { const t = boot(); const n = note({ url: '/app?n=c:s1:c1', channelId: 'c1', serverId: 's1', read: true });
    await t.run('notificationclick', { notification: n, action: 'read' });
    assert.equal(t.fetchCalls.length, 1); assert.equal(t.fetchCalls[0].u, '/api/channels/c1/read'); assert.ok(n.closed); assert.equal(t.opened.length, 0, 'does not open the app'); }
  console.log('ok  mark as read (channel) is saved on the server');

  // Mark as read, DM: no server call (nothing to save), open pages clear their count
  { const w = win(); const t = boot({ wins: [w] }); const n = note({ url: '/app?n=d:u2', peerId: 'u2', read: true });
    await t.run('notificationclick', { notification: n, action: 'read' });
    assert.equal(t.fetchCalls.length, 0); assert.deepEqual(w.msgs, [{ type: 'aduna:read', target: 'd:u2' }]); assert.ok(n.closed); }
  console.log('ok  mark as read (DM) tells open pages, no server call');

  // Mark as read fails: shown again with a message, not lost silently
  { const t = boot({ fetchImpl: async () => ({ ok: false, status: 401 }) }); const n = note({ url: '/app?n=c:s1:c1', channelId: 'c1', read: true });
    await t.run('notificationclick', { notification: n, action: 'read' });
    assert.equal(t.shown.length, 1); assert.equal(t.shown[0].title, 'Could not mark as read'); assert.equal(t.shown[0].tag, 't'); }
  console.log('ok  failed mark as read is shown again');

  // Inline reply in a channel
  { const t = boot(); const n = note({ url: '/app?n=c:s1:c1', channelId: 'c1', msgId: 'm1', reply: 'inline' });
    await t.run('notificationclick', { notification: n, action: 'reply', reply: '  on my way  ' });
    assert.equal(t.fetchCalls[0].u, '/api/channels/c1/quick-reply'); assert.deepEqual(t.fetchCalls[0].body, { content: 'on my way', replyTo: 'm1' }); assert.ok(n.closed); assert.equal(t.opened.length, 0); }
  console.log('ok  inline reply is sent to the channel (trimmed, as a reply to that message)');

  // Inline reply fails
  { const t = boot({ fetchImpl: async () => ({ ok: false, status: 429 }) }); const n = note({ url: '/app?n=c:s1:c1', channelId: 'c1', reply: 'inline' });
    await t.run('notificationclick', { notification: n, action: 'reply', reply: 'hi' });
    assert.equal(t.shown[0].title, 'Reply not sent'); assert.equal(t.shown[0].data.reply, '', 'the retry notification has no reply box'); }
  console.log('ok  a reply that fails says so');

  // Reply with no text (button-only browsers) and DM replies open the chat with the cursor in the box
  { const w = win(); const t = boot({ wins: [w] }); const n = note({ url: '/app?n=c:s1:c1', channelId: 'c1', reply: 'inline' });
    await t.run('notificationclick', { notification: n, action: 'reply' });
    assert.equal(t.fetchCalls.length, 0); assert.deepEqual(w.msgs, [{ type: 'aduna:open', target: 'c:s1:c1', focus: true }]); assert.equal(w.focused, 1); }
  { const w = win(); const t = boot({ wins: [w] }); const n = note({ url: '/app?n=d:u2', peerId: 'u2', reply: 'open' });
    await t.run('notificationclick', { notification: n, action: 'reply', reply: 'typed text that cannot be encrypted here' });
    assert.equal(t.fetchCalls.length, 0, 'a DM is never sent from the worker'); assert.equal(w.msgs[0].focus, true); }
  { const t = boot(); const n = note({ url: '/app?n=d:u2', peerId: 'u2', reply: 'open' });
    await t.run('notificationclick', { notification: n, action: 'reply' });
    assert.deepEqual(t.opened, ['/app?n=d%3Au2&focus=1']); }
  console.log('ok  Reply without text, and every DM reply, open the chat with the box focused');

  // Plain tap, foreign URL
  { const w = win(); const t = boot({ wins: [w] }); const n = note({ url: '/app?n=d:u2' });
    await t.run('notificationclick', { notification: n, action: '' });
    assert.deepEqual(w.msgs, [{ type: 'aduna:open', target: 'd:u2', focus: false }]); }
  { const w = win(); const t = boot({ wins: [w] }); const n = note({ url: 'https://evil.example/x?n=c:a:b' });
    await t.run('notificationclick', { notification: n, action: '' });
    assert.equal(w.msgs.length, 0); assert.equal(t.opened.length, 0); }
  console.log('ok  a tap opens the chat; a foreign URL is ignored');

  // Buttons follow what the phone allows
  { const t = boot({ maxActions: 0 }); await t.run('push', { data: { json: () => ({ title: 'A', body: 'b', tag: 'x', reply: 'inline', read: true }) } });
    assert.equal(t.shown.length, 1); assert.equal(t.shown[0].actions, undefined, 'no buttons where the browser has none'); }
  { const t = boot({ maxActions: 1 }); await t.run('push', { data: { json: () => ({ title: 'A', body: 'b', tag: 'x', reply: 'inline', read: true }) } });
    assert.equal(t.shown[0].actions.length, 1); assert.equal(t.shown[0].actions[0].action, 'reply'); }
  { const t = boot(); await t.run('push', { data: { json: () => ({ title: 'Call', body: 'x', kind: 'call', tag: 'call' }) } });
    assert.equal(t.shown[0].actions, undefined, 'a call has no Reply / Mark as read'); }
  console.log('ok  buttons: as many as the browser allows, none on calls');

  // A visible, focused window already shows the message (except on iOS, which insists)
  { const w = win(); w.visibilityState = 'visible'; w.focused = true; const t = boot({ wins: [w] });
    await t.run('push', { data: { json: () => ({ title: 'A', body: 'b', tag: 'x' }) } }); assert.equal(t.shown.length, 0); }
  { const w = win(); w.visibilityState = 'visible'; w.focused = true; const t = boot({ wins: [w], ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' });
    await t.run('push', { data: { json: () => ({ title: 'A', body: 'b', tag: 'x' }) } }); assert.equal(t.shown.length, 1); }
  console.log('ok  no duplicate while the app is in front (iOS always shows)');

  // The page can ask the worker to show one (decrypted DM text)
  { const t = boot(); await t.run('message', { data: { type: 'aduna:show', d: { title: 'Bob', body: 'secret text', tag: 'm:1', peerId: 'u2', reply: 'open', read: true } } });
    assert.equal(t.shown[0].body, 'secret text'); assert.equal(t.shown[0].data.peerId, 'u2'); }
  console.log('ok  page-requested notifications look the same');
  console.log('\nsw-test: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
