// Notifications, in one place.
//   - Android app (Capacitor shell around this site): Web Push does not exist in an Android WebView, so the app registers a
//     Firebase (FCM) token with the server (/api/push/fcm) and the server pushes to it. Newer builds draw the notification
//     themselves as a card like the desktop one (mobile/scripts/prepare-android.mjs: AdunaCards); older builds let the system draw it.
//   - Desktop app (Electron): the page asks the app to show a native Windows notification (window.adunaDesktop).
//   - Phones / installed web app / browsers: shown through the service worker, which is also what receives Web Push
//     from the server while Aduna is closed. Phones only allow notifications that way.
// Which kinds you get (DMs, mentions, calls, ...) is stored on your account (me.notifPrefs) and applies to every device.
import { api } from './api.js';

const desktop = () => (typeof window !== 'undefined' ? window.adunaDesktop : undefined);
export const isDesktopApp = () => !!desktop();

// ---- Android app (native push through the Capacitor bridge the shell injects into the page) ----
const cap = () => (typeof window !== 'undefined' ? window.Capacitor : undefined);
export const isNativeApp = () => { try { return !!(cap()?.isNativePlatform?.() || /AdunaAndroid/.test(navigator.userAgent)); } catch { return false; } };
const PN = () => cap()?.Plugins?.PushNotifications;
const store = {
  get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* private mode */ } },
};
let nativePerm = store.get('aduna_native_perm') || 'default'; // 'granted' | 'denied' | 'default', refreshed from the system below
let fcmToken = store.get('aduna_fcm_token');                    // only kept once the server has accepted it
let pendingOpen = '';                                           // a notification tapped before the page was ready
export const takePendingOpen = () => { const t = pendingOpen; pendingOpen = ''; return t; };
export const hasNativeCards = () => isNativeApp() && !!cap()?.Plugins?.AdunaNotify; // this app build draws the same notification card as the desktop app
const setNativePerm = (r) => { nativePerm = r === 'granted' ? 'granted' : r === 'denied' ? 'denied' : 'default'; store.set('aduna_native_perm', nativePerm); };

let nativeReady = null;
function nativeInit() {
  if (nativeReady) return nativeReady;
  const pn = PN();
  if (!pn) return (nativeReady = Promise.resolve(false));
  nativeReady = (async () => {
    await pn.addListener('registration', async (t) => {
      // callUi: this app build has the native call screen (Answer / Decline buttons, ringtone), so the server may send it data-only call pushes
      // cardUi: this build draws its own notification card (like the desktop one), so the server sends it data-only pushes for everything
      try { await api('/push/fcm', { method: 'POST', body: { token: t.value, callUi: !!cap()?.Plugins?.AdunaCalls, cardUi: !!cap()?.Plugins?.AdunaNotify } }); fcmToken = t.value; store.set('aduna_fcm_token', t.value); lastError = ''; }
      catch (e) { lastError = e?.message || 'The server did not accept this device.'; }
    });
    await pn.addListener('registrationError', (e) => { lastError = (e && (e.error || e.message)) || 'Could not register with Firebase.'; });
    // The app is open: the system shows nothing, the page already shows its own toasts. A test push is acknowledged in Settings.
    // A card push is data-only, so its title and text arrive in data rather than in the notification part.
    await pn.addListener('pushNotificationReceived', (n) => window.dispatchEvent(new CustomEvent('aduna:push-received', { detail: { kind: n?.data?.kind || '', title: n?.title || n?.data?.title || '', body: n?.body || n?.data?.body || '' } })));
    await pn.addListener('pushNotificationActionPerformed', (a) => {
      let target = '';
      try { target = new URL(a?.notification?.data?.url || '/app', location.origin).searchParams.get('n') || ''; } catch { /* no target: just open the app */ }
      pendingOpen = target;
      if (target) window.dispatchEvent(new CustomEvent('aduna:open', { detail: target }));
    });
    try { // Android 8+ needs channels; the server names them in each message (see fcm.js)
      await pn.createChannel({ id: 'messages', name: 'Messages', description: 'DMs, mentions, announcements and friend requests', importance: 4, visibility: 0, vibration: true });
      await pn.createChannel({ id: 'calls', name: 'Calls', description: 'Incoming calls', importance: 5, visibility: 0, vibration: true });
    } catch { /* channels are a nicety */ }
    try { setNativePerm((await pn.checkPermissions()).receive); } catch { /* keep the cached value */ }
    // The app was opened from closed by tapping a notification card: the native side kept which chat it was for
    try { const o = await cap()?.Plugins?.AdunaNotify?.takeOpen?.(); if (o?.target && !pendingOpen) pendingOpen = o.target; } catch { /* older app build */ }
    return true;
  })().catch(() => false);
  return nativeReady;
}
if (isNativeApp()) nativeInit();

// ---- Android: the notification card wears the person's own Aduna colours (the native side saves them, so it also works while the app is closed) ----
// The page paints its theme as CSS variables; they are turned into plain #rrggbb here (a canvas understands every CSS colour, color-mix included).
let lastCardTheme = '';
function syncCardTheme() {
  try {
    const plugin = cap()?.Plugins?.AdunaNotify;
    const root = document.documentElement;
    if (!plugin?.setTheme || root.dataset.theme === 'server') return; // cards always wear the person's own theme, never a server's
    const cs = getComputedStyle(root);
    const v = (k) => cs.getPropertyValue(k).trim();
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    ctx.canvas.width = ctx.canvas.height = 1;
    const hex = (...layers) => { // each colour drawn over the one before it (some themes have see-through panels)
      ctx.clearRect(0, 0, 1, 1);
      for (const c of layers) if (c) { ctx.fillStyle = '#000000'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); }
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return '#' + [d[0], d[1], d[2]].map((n) => n.toString(16).padStart(2, '0')).join('');
    };
    const bg = v('--bg'), raised = v('--raised');
    const theme = {
      raised: hex(bg, raised), head: hex(bg, raised, v('--head')), muted: hex(bg, raised, v('--muted')),
      ink: hex(bg, v('--ink')), onInk: hex(bg, v('--on-ink')), green: hex(bg, v('--green')),
    };
    const json = JSON.stringify(theme);
    if (json === lastCardTheme) return;
    lastCardTheme = json;
    plugin.setTheme(theme);
  } catch { /* the card keeps its Parchment default */ }
}
// ---- Android: the app's icon on the home screen wears the person's theme (one icon per theme, built in mobile/scripts/prepare-android.mjs) ----
// The native side switches it when the app leaves the screen. A theme with no icon of its own (Custom, System, limited-time) gets Charcoal or Parchment by brightness.
let lastIcon = '';
function syncAppIcon() {
  try {
    const plugin = cap()?.Plugins?.AdunaIcon;
    const root = document.documentElement;
    if (!plugin?.setIcon || root.dataset.theme === 'server') return; // always the person's own theme, never a server's
    const msg = { theme: root.dataset.theme || '', dark: root.style.colorScheme === 'dark' };
    const key = JSON.stringify(msg);
    if (key === lastIcon) return;
    lastIcon = key;
    plugin.setIcon(msg);
  } catch { /* older app build, or no icon change: the icon stays as it is */ }
}

if (isNativeApp() && typeof document !== 'undefined') {
  let timer = 0;
  const later = () => { clearTimeout(timer); timer = setTimeout(() => { syncCardTheme(); syncAppIcon(); }, 900); }; // the page fades its theme over .6 s: read it once it has settled
  const start = () => { later(); new MutationObserver(later).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
}

export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// 'granted' | 'denied' | 'default' | 'unsupported' | 'needs-install' (iPhone / iPad only allow it from the home-screen app)
export function permission() {
  if (isDesktopApp()) return 'granted';
  if (isNativeApp()) return nativePerm;
  if (!('Notification' in window)) return isIos() && !isInstalled() ? 'needs-install' : 'unsupported';
  return Notification.permission;
}
export const pushSupported = () => !isDesktopApp() && (isNativeApp() ? !!PN() : 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);

let regPromise = null;
export function registration() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  return (regPromise ||= navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).catch(() => null));
}

// True when the person is not looking at Aduna (tab hidden, another window in front, phone locked).
// In the desktop app the window itself says whether it is visible and in front (it may be hidden in the tray, where the page is kept running).
export const away = () => { const d = desktop(); return d?.isActive ? !d.isActive() : document.hidden || !document.hasFocus(); };

// Show one notification. n: { title, body, tag, target ('c:<serverId>:<channelId>' | 'd:<userId>' | 'f'), kind ('dm' | 'mention' | 'announcement' | 'call' | 'friend'), sticky,
//   and for the look: sender (name), icon ('/api/images/<id>'), theme ({ dark, bg, accent } of a server), serverId, channelId, peerId, msgId, reply ('inline' | 'open'), read (true) }
// Safe to call whenever: does nothing unless notifications are allowed.
export async function show(n) {
  try {
    if (permission() !== 'granted') return;
    const url = '/app' + (n.target ? '?n=' + encodeURIComponent(n.target) : '');
    if (isNativeApp()) { // the server's push shows it (the app draws the card); from the page only Settings' test button draws one, with local: true
      if (n.local) await cap()?.Plugins?.AdunaNotify?.show?.({ kind: n.kind || 'test', title: n.title || 'Aduna', body: n.body || '', tag: n.tag || '', url });
      return;
    }
    const d = desktop();
    if (d) { d.notify({ title: n.title, body: n.body || '', tag: n.tag || '', target: n.target || '', kind: n.kind || '', sticky: !!n.sticky }); return; }
    const opts = { body: n.body || '', tag: n.tag, icon: '/notif-icon-192.png', badge: '/icon-192.png', data: { url }, requireInteraction: !!n.sticky };
    const reg = await registration();
    // The service worker draws it (picture on a themed tile, Reply / Mark as read buttons), the same way as a pushed one. See sw.js present().
    if (reg?.active) {
      reg.active.postMessage({ type: 'aduna:show', d: { kind: n.kind || '', title: n.title, body: n.body || '', tag: n.tag, url, sticky: !!n.sticky,
        sender: n.sender, icon: n.icon, theme: n.theme, serverId: n.serverId, channelId: n.channelId, peerId: n.peerId, msgId: n.msgId, reply: n.reply, read: n.read } });
      return;
    }
    if (reg) { await reg.showNotification(n.title, opts); return; }
    const x = new Notification(n.title, opts);
    x.onclick = () => { window.focus(); window.dispatchEvent(new CustomEvent('aduna:open', { detail: n.target || '' })); x.close(); };
  } catch { /* notifications are best effort */ }
}
export async function dismiss(tag) {
  try {
    if (isDesktopApp()) return void desktop().dismiss?.(tag);
    if (isNativeApp()) return void (await PN()?.removeAllDeliveredNotifications?.()); // e.g. the call banner once the call is answered
    const reg = await registration();
    (await reg?.getNotifications({ tag }))?.forEach((x) => x.close());
  } catch { /* already gone */ }
}

// Ask the browser for permission (must come from a tap / click), then subscribe this device to Web Push.
export async function enable() {
  if (isDesktopApp()) return 'granted';
  if (isNativeApp()) {
    const pn = PN();
    if (!pn) return permission();
    await nativeInit();
    let r = (await pn.checkPermissions()).receive;
    if (r === 'prompt' || r === 'prompt-with-rationale') r = (await pn.requestPermissions()).receive;
    setNativePerm(r);
    if (nativePerm === 'granted') await subscribe().catch((e) => { lastError = e?.message || String(e); });
    return nativePerm;
  }
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
  if (isNativeApp()) {
    const k = await api('/push/key');
    if (!k.enabled || !k.fcm) { lastError = 'Android notifications are not set up on the server yet (FCM_SERVICE_ACCOUNT).'; return false; }
    await nativeInit();
    // An APK built without google-services.json would crash the whole app inside register(); ask first (old APKs have no pushReady and behave as before)
    const ready = await Promise.resolve(window.Capacitor?.Plugins?.AdunaUpdater?.pushReady?.()).catch(() => null);
    if (ready && ready.ready === false) { lastError = 'This app was built without google-services.json, so Android notifications are off. Put the file in the mobile folder and rebuild.'; return false; }
    await PN().register(); // the token arrives in the 'registration' listener, which sends it to the server
    for (let i = 0; i < 40 && !fcmToken && !lastError; i++) await new Promise((r) => setTimeout(r, 250)); // wait up to 10 s for it
    return !!fcmToken;
  }
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
    if (isNativeApp()) {
      if (fcmToken) await api('/push/unsubscribe', { method: 'POST', body: { endpoint: 'fcm:' + fcmToken } }).catch(() => {});
      fcmToken = ''; store.set('aduna_fcm_token', '');
      return;
    }
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  } catch { /* nothing to undo */ }
}
export async function isSubscribed() {
  if (isNativeApp()) return !!fcmToken && nativePerm === 'granted';
  try { const reg = await navigator.serviceWorker.getRegistration('/'); return !!(await reg?.pushManager.getSubscription()); } catch { return false; }
}

// Number on the app icon (installed web app on Android / desktop Chrome / iOS 16.4+).
export function setBadge(n) {
  if (isNativeApp()) return; // Android's launcher badge follows the notifications themselves
  try { if (n > 0) navigator.setAppBadge?.(n); else navigator.clearAppBadge?.(); } catch { /* not supported */ }
}

// Step-by-step check of the whole path (permission > service worker > server > this device's subscription), for Settings > Notifications.
// Each step: { ok: true | false | null (info only), label, detail }
export async function diagnose() {
  const out = [];
  const perm = permission();
  if (isNativeApp()) {
    await nativeInit();
    let k = null;
    try { k = await api('/push/key'); } catch (e) { out.push({ ok: false, label: 'Server reachable', detail: e.message || 'Could not reach the server.' }); }
    out.push({ ok: perm === 'granted', label: 'Notifications allowed for Aduna', detail: perm === 'granted' ? '' : perm === 'denied' ? 'Blocked. Open Android Settings > Apps > Aduna > Notifications.' : 'Not asked yet.' });
    if (k) out.push({ ok: !!(k.enabled && k.fcm), label: 'Server can send to Android', detail: k.enabled && k.fcm ? '' : 'The server has no Firebase key (FCM_SERVICE_ACCOUNT).' });
    out.push({ ok: !!fcmToken, label: 'This phone is registered', detail: fcmToken ? 'Firebase token accepted by the server' : (lastError || 'Not registered yet. Press \u201cEnable while closed\u201d.') });
    out.push({ ok: null, label: 'Battery', detail: 'If pushes arrive late, set Aduna to \u201cUnrestricted\u201d under Android Settings > Apps > Aduna > Battery.' });
    return out;
  }
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
