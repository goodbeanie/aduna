// Aduna desktop app: a window that opens https://aduna.onrender.com/app and nothing else.
// All secrets and settings live on the server, so nothing sensitive is stored in this app.
// Updates are fetched from https://aduna.onrender.com/updates/ (see the publish setting in package.json).
const { app, BrowserWindow, WebContentsView, Menu, shell, session, ipcMain, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

const ORIGIN = 'https://aduna.onrender.com';
const APP_URL = ORIGIN + '/app';
const iconPath = path.join(__dirname, 'build', 'icon.png');
const BAR_H = 36; // height of the custom title bar

let win = null, page = null, bar = null;
const toasts = new Map();             // tag -> the Windows notification currently showing, so a newer one replaces it
let theme = {};                       // latest colours from the page, forwarded to the title bar
let upd = { phase: 'idle' };          // update status shown in the server bar: idle | checking | none | available | downloading | installing | error

function openExternal(url) { try { if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url); } catch { /* ignore */ } }
const alive = (v) => v && v.webContents && !v.webContents.isDestroyed();

// ----- window: frameless, with our own title bar (a small local page) stacked above the Aduna page -----
function layout() {
  if (!win || win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();
  const h = win.isFullScreen() ? 0 : BAR_H;
  bar.setVisible(h > 0);
  bar.setBounds({ x: 0, y: 0, width, height: h });
  page.setBounds({ x: 0, y: h, width, height: Math.max(0, height - h) });
}
function sendBarState() {
  if (alive(bar) && win && !win.isDestroyed()) bar.webContents.send('bar-state', { maximized: win.isMaximized(), focused: win.isFocused() });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600, backgroundColor: '#ebe4d4', icon: iconPath,
    frame: false, autoHideMenuBar: true,
  });
  page = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'page-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  bar = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'titlebar-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  page.setBackgroundColor('#ebe4d4');
  bar.setBackgroundColor('#ebe4d4');
  win.contentView.addChildView(page);
  win.contentView.addChildView(bar);
  layout();
  for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) win.on(ev, () => { layout(); sendBarState(); });
  for (const ev of ['focus', 'blur']) win.on(ev, sendBarState);
  win.on('focus', () => win.flashFrame(false));
  win.on('closed', () => { win = null; page = null; bar = null; });

  bar.webContents.on('will-navigate', (e) => e.preventDefault());
  bar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  bar.webContents.on('did-finish-load', () => { bar.webContents.send('bar-theme', theme); sendBarState(); });
  bar.webContents.loadFile(path.join(__dirname, 'titlebar.html'));

  const wc = page.webContents;
  wc.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => {
    if (url.startsWith('file://') || new URL(url).origin === ORIGIN) return;
    e.preventDefault(); openExternal(url);
  });
  // No connection: show a small page that keeps retrying.
  wc.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) wc.loadFile(path.join(__dirname, 'offline.html'));
  });
  wc.on('did-finish-load', pushUpd);
  wc.loadURL(APP_URL);
}

// Only the title bar may drive the window, only the Aduna page may talk about updates or send theme colours.
const fromBar = (e) => alive(bar) && e.sender === bar.webContents;
const fromPage = (e) => alive(page) && e.sender === page.webContents && !!e.senderFrame && String(e.senderFrame.url).startsWith(ORIGIN);

ipcMain.on('bar-action', (e, action) => {
  if (!fromBar(e) || !win) return;
  if (action === 'min') win.minimize();
  else if (action === 'max') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
  else if (action === 'close') win.close();
  else if (action === 'check') runCheck(true);
});

// ----- notifications: the page says what to show; the app shows it as a native Windows notification, and clicking it
// brings the window forward and tells the page which chat to open. -----
const clean = (v, n) => String(v == null ? '' : v).slice(0, n);
function showToast(n) {
  if (!Notification.isSupported()) return;
  const tag = clean(n.tag, 80);
  if (tag && toasts.has(tag)) { try { toasts.get(tag).close(); } catch { /* already gone */ } }
  const t = new Notification({ title: clean(n.title, 100) || 'Aduna', body: clean(n.body, 200), icon: iconPath, silent: false, timeoutType: n.sticky ? 'never' : 'default' });
  t.on('click', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    if (alive(page)) page.webContents.send('notif-click', clean(n.target, 80));
  });
  t.on('close', () => { if (tag && toasts.get(tag) === t) toasts.delete(tag); });
  if (tag) toasts.set(tag, t);
  t.show();
  if (win && !win.isFocused()) win.flashFrame(true); // flashes the taskbar button until the window is focused
}
ipcMain.on('notify', (e, n) => { if (fromPage(e) && n && typeof n === 'object') showToast(n); });
ipcMain.on('notify-dismiss', (e, tag) => { if (!fromPage(e)) return; const t = toasts.get(clean(tag, 80)); if (t) { try { t.close(); } catch { /* ignore */ } toasts.delete(clean(tag, 80)); } });

ipcMain.on('theme-vars', (e, vars) => {
  if (!fromPage(e) || !vars || typeof vars !== 'object') return;
  const clean = {};
  for (const k of ['--bg3', '--line', '--head', '--muted', '--hover', '--danger', '--ink', '--on-ink']) {
    const v = vars[k];
    if (typeof v === 'string' && v.length < 200 && /^[#a-zA-Z0-9(),.%\s-]+$/.test(v)) clean[k] = v;
  }
  theme = clean;
  if (alive(bar)) bar.webContents.send('bar-theme', clean);
  if (bar && clean['--bg3'] && /^#[0-9a-fA-F]{6}$/.test(clean['--bg3'])) { bar.setBackgroundColor(clean['--bg3']); page.setBackgroundColor(clean['--bg3']); }
});

// ----- updates: status lives on the right of the server bar. Scan -> "Checking for update…" -> "No update available" (10s, then
// fades) or "Update available [Install]". Install downloads, then restarts into the new version. -----
function pushUpd() { if (alive(page)) page.webContents.send('upd-state', upd); }
let idleTimer = null;
function setUpd(next, autoMs, then) {
  upd = next; clearTimeout(idleTimer); pushUpd();
  if (autoMs) idleTimer = setTimeout(() => setUpd(then || { phase: 'idle' }), autoMs);
}
ipcMain.on('upd-get', (e) => { if (fromPage(e)) pushUpd(); });
ipcMain.on('upd-install', (e) => { if (fromPage(e)) startInstall(); });

let checking = false, showChecks = false, downloading = false;
function runCheck(manual) {
  if (['available', 'downloading', 'installing'].includes(upd.phase)) { pushUpd(); return; } // already know about one
  if (checking) return;
  showChecks = !!manual;
  if (!app.isPackaged) return fakeCheck();           // dev run: simulate so the UI can be tried (ADUNA_FAKE_UPDATE=available|none)
  checking = true;
  if (showChecks) setUpd({ phase: 'checking' });
  autoUpdater.checkForUpdates().catch(() => {}).finally(() => { checking = false; });
}
function startInstall() {
  if (upd.phase !== 'available') return;
  if (!app.isPackaged) return fakeInstall();
  downloading = true;
  setUpd({ phase: 'downloading', version: upd.version, pct: 0 });
  autoUpdater.downloadUpdate().catch(() => {});
}
function setupUpdates() {
  autoUpdater.autoDownload = false;          // the person presses Install
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('update-available', (info) => { setUpd({ phase: 'available', version: info && info.version }); });
  autoUpdater.on('update-not-available', () => { if (showChecks) setUpd({ phase: 'none' }, 10 * 1000); });
  autoUpdater.on('download-progress', (p) => { upd = { phase: 'downloading', version: upd.version, pct: p.percent }; pushUpd(); });
  autoUpdater.on('update-downloaded', () => {
    downloading = false;
    setUpd({ phase: 'installing', version: upd.version });
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 700);
  });
  autoUpdater.on('error', (err) => {
    console.error('Update error:', err && err.message);
    if (downloading) { downloading = false; setUpd({ phase: 'error', message: 'Update failed' }, 6000, { phase: 'available', version: upd.version }); }
    else if (showChecks) setUpd({ phase: 'error', message: 'Couldn\u2019t check for updates' }, 10 * 1000);
  });
  setTimeout(() => runCheck(true), 10 * 1000);            // startup scan is shown, like a manual one
  setInterval(() => runCheck(false), 30 * 60 * 1000);     // later scans stay quiet unless something is found
}
// Dev-only simulation so the chip can be seen without a packaged build.
function fakeCheck() {
  checking = true; setUpd({ phase: 'checking' });
  setTimeout(() => {
    checking = false;
    if (process.env.ADUNA_FAKE_UPDATE === 'available') setUpd({ phase: 'available', version: '9.9.9' });
    else setUpd({ phase: 'none' }, 10 * 1000);
  }, 1800);
}
function fakeInstall() {
  let p = 0; setUpd({ phase: 'downloading', version: upd.version, pct: 0 });
  const t = setInterval(() => {
    p += 12; if (p < 100) { upd = { phase: 'downloading', version: upd.version, pct: p }; pushUpd(); return; }
    clearInterval(t); setUpd({ phase: 'installing', version: upd.version }); setTimeout(() => setUpd({ phase: 'idle' }), 1500);
  }, 250);
}

app.setAppUserModelId('app.aduna.desktop'); // same as build.appId: Windows needs it to show notifications from the app
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    // Calls need the microphone and camera; mentions need notifications. Allowed only for the Aduna server.
    const ok = (wc, perm) => ['media', 'notifications', 'fullscreen', 'clipboard-sanitized-write'].includes(perm) && !!wc && wc.getURL().startsWith(ORIGIN);
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(ok(wc, perm)));
    session.defaultSession.setPermissionCheckHandler((wc, perm) => ok(wc, perm));
    // No visible menu any more (the window is frameless), but the shortcuts still work.
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Aduna', submenu: [{ label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => page && page.webContents.loadURL(APP_URL) }, { label: 'Check for updates\u2026', accelerator: 'CmdOrCtrl+Shift+U', click: () => runCheck(true) }, { type: 'separator' }, { role: 'quit' }] },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }] },
    ]));
    createWindow();
    setupUpdates();
  });
  app.on('window-all-closed', () => app.quit());
}
