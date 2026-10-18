// Notifications, in one place.
//   - Desktop app (Electron): the page asks the app to show a native Windows notification (window.adunaDesktop).
//   - Phones / installed web app / browsers: shown through the service worker, which is also what receives Web Push
//     from the server while Aduna is closed. Phones only allow notifications that way.
// Which kinds you get (DMs, mentions, calls, ...) is stored on your account (me.notifPrefs) and applies to every device.
import { api } from './api.js';

const desktop = () => (typeof window !== 'undefined' ? window.adunaDesktop : undefined);
export const isDesktopApp = () => !!desktop();
export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// 'granted' | 'denied' | 'default' | 'unsupported' | 'needs-install' (iPhone / iPad only allow it from the home-screen app)
export function permission() {
  if (isDesktopApp()) return 'granted';
  if (!('Notification' in window)) return isIos() && !isInstalled() ? 'needs-install' : 'unsupported';
  return Notification.permission;
}
export const pushSupported = () => !isDesktopApp() && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

let regPromise = null;
export function registration() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  return (regPromise ||= navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).catch(() => null));
}

// True when the person is not looking at Aduna (tab hidden, another window in front, phone locked).
// In the desktop app the window itself says whether it is visible and in front (it may be hidden in the tray, where the page is kept running).
export const away = () => { const d = desktop(); return d?.isActive ? !d.isActive() : document.hidden || !document.hasFocus(); };

// Show one notification. n: { title, body, tag, target ('c:<serverId>:<channelId>' | 'd:<userId>' | 'f'), kind ('dm' | 'mention' | 'announcement' | 'call' | 'friend'), sticky }
// Safe to call whenever: does nothing unless notifications are allowed.
export async function show(n) {
  try {
    if (permission() !== 'granted') return;
    const url = '/app' + (n.target ? '?n=' + encodeURIComponent(n.target) : '');
    const d = desktop();
    if (d) { d.notify({ title: n.title, body: n.body || '', tag: n.tag || '', target: n.target || '', kind: n.kind || '', sticky: !!n.sticky }); return; }
    const opts = { body: n.body || '', tag: n.tag, icon: '/notif-icon-192.png', badge: '/icon-192.png', data: { url }, requireInteraction: !!n.sticky };
    const reg = await registration();
    if (reg) { await reg.showNotification(n.title, opts); return; }
    const x = new Notification(n.title, opts);
    x.onclick = () => { window.focus(); window.dispatchEvent(new CustomEvent('aduna:open', { detail: n.target || '' })); x.close(); };
  } catch { /* notifications are best effort */ }
}
export async function dismiss(tag) {
  try {
    if (isDesktopApp()) return void desktop().dismiss?.(tag);
    const reg = await registration();
    (await reg?.getNotifications({ tag }))?.forEach((x) => x.close());
  } catch { /* already gone */ }
}

// Ask the browser for permission (must come from a tap / click), then subscribe this device to Web Push.
export async function enable() {
  if (isDesktopApp()) return 'granted';
  if (!('Notification' in window)) return permission();
  const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (p === 'granted') await subscribe().catch((e) => { lastError = e?.message || String(e); });
  return p;
}
let lastError = '';
export const subscribeError = () => lastError;

function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
export async function subscribe() {
  lastError = '';
  if (!pushSupported()) return false;
  const { enabled, publicKey } = await api('/push/key');
  if (!enabled || !publicKey) return false;
  const reg = await registration();
  if (!reg) return false;
  let sub = await reg.pushManager.getSubscription();
  if (sub) { // a subscription made with an older key can never receive anything: start over
    const have = sub.options?.applicationServerKey && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (have && have !== publicKey) { await sub.unsubscribe(); sub = null; }
  }
  sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  return true;
}
// Stop pushes to this device (turning off, or logging out so the next person on it doesn't get your messages).
export async function unsubscribe() {
  try {
    if (!pushSupported()) return;
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  } catch { /* nothing to undo */ }
}
export async function isSubscribed() {
  try { const reg = await navigator.serviceWorker.getRegistration('/'); return !!(await reg?.pushManager.getSubscription()); } catch { return false; }
}

// Number on the app icon (installed web app on Android / desktop Chrome / iOS 16.4+).
export function setBadge(n) {
  try { if (n > 0) navigator.setAppBadge?.(n); else navigator.clearAppBadge?.(); } catch { /* not supported */ }
}

// Step-by-step check of the whole path (permission > service worker > server > this device's subscription), for Settings > Notifications.
// Each step: { ok: true | false | null (info only), label, detail }
export async function diagnose() {
  const out = [];
  const perm = permission();
  out.push({ ok: perm === 'granted', label: 'Notifications allowed on this device', detail: perm === 'granted' ? '' : perm === 'denied' ? 'Blocked in the browser / phone settings.' : perm === 'needs-install' ? 'Add Aduna to the Home Screen first.' : perm === 'unsupported' ? 'This browser has no notifications.' : 'Not asked yet.' });
  if (!pushSupported()) { out.push({ ok: false, label: 'Closed-app notifications supported', detail: 'This browser cannot receive push messages.' }); return out; }
  let reg = null;
  try { reg = await Promise.race([registration(), new Promise((r) => setTimeout(() => r(null), 6000))]); } catch { /* below */ }
  out.push({ ok: !!reg, label: 'Background service is running', detail: reg ? '' : 'The service worker could not start. Reload the app.' });
  let key = null;
  try { key = await api('/push/key'); } catch (e) { out.push({ ok: false, label: 'Server reachable', detail: e.message || 'Could not reach the server.' }); return out; }
  out.push({ ok: !!(key.enabled && key.publicKey), label: 'Server can send push messages', detail: key.enabled ? '' : 'Push is switched off on the server (PUSH=off or no keys).' });
  let sub = null;
  try { sub = await reg?.pushManager.getSubscription(); } catch { /* none */ }
  let host = '';
  try { host = sub ? new URL(sub.endpoint).host : ''; } catch { /* ignore */ }
  out.push({ ok: !!sub, label: 'This device is registered', detail: sub ? host : (lastError || 'Not registered yet. Press \u201cEnable while closed\u201d.') });
  out.push({ ok: null, label: 'Installed as an app', detail: isInstalled() ? 'Yes' : 'No. Notifications while closed work best from the installed app.' });
  return out;
}
// Ask the server to push a test message to every device of this account. Resolves { devices, sent, failed: [{ status, message }] }.
export const pushTest = () => api('/push/test', { method: 'POST', body: {} });
