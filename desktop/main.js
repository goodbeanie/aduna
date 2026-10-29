// Aduna desktop app: a window that opens https://aduna.onrender.com/app and nothing else.
// All secrets and settings live on the server, so nothing sensitive is stored in this app.
// Updates are fetched from https://aduna.onrender.com/updates/ (see the publish setting in package.json).
const { app, BrowserWindow, WebContentsView, Menu, Tray, nativeImage, nativeTheme, screen, shell, session, ipcMain, Notification, desktopCapturer } = require('electron');
const { execFile } = require('child_process');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const games = require('./games');

const ORIGIN = 'https://aduna.onrender.com';
const APP_URL = ORIGIN + '/app';
// The logo is black, which disappears on a dark taskbar / tray. So the window (taskbar) icon, the tray icon and notification icon switch to
// the white logo when Windows is in dark mode, and back again live when the person changes it. (The .exe / pinned-shortcut icon is fixed by Windows.)
const ICON_BLACK = path.join(__dirname, 'build', 'icon.png');
const ICON_WHITE = path.join(__dirname, 'build', 'icon-white.png');
let iconPath = nativeTheme.shouldUseDarkColors ? ICON_WHITE : ICON_BLACK;
const BAR_H = 36; // height of the custom title bar

let win = null, page = null, bar = null, tray = null;
let quitting = false;                 // false: the window's X only hides Aduna to the tray so notifications keep coming
const startHidden = process.argv.includes('--hidden'); // started by Windows at login: go straight to the tray
const nativeToasts = new Map();       // fallback only: tag -> native Windows notification
let theme = {};                       // latest colours from the page, forwarded to the title bar
let upd = { phase: 'idle' };          // update status shown in the server bar: idle | checking | none | downloading | ready | installing | error
let ai = null;                        // the AI bot builder (ai/ai-service.js): runs in the background, its panel is in Settings > Developer

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
    frame: false, autoHideMenuBar: true, show: !startHidden,
  });
  page = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'page-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }, // no throttling: the page must keep its connection alive while hidden in the tray
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
  win.on('focus', () => { win.flashFrame(false); applyIcons(); });
  for (const ev of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore']) win.on(ev, sendPresence);
  // The X hides Aduna to the tray instead of quitting, so the page stays connected and keeps raising notifications.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    const p = readPrefs();
    if (!p.trayHintShown) { p.trayHintShown = true; writePrefs(p); showToast({ title: 'Aduna is still running', body: 'It stays in the tray so you keep getting notifications. Right-click the tray icon to quit.', tag: 'tray-hint', kind: 'info' }); }
  });
  // Windows logging off or shutting down must not be blocked by the hide-instead-of-close above.
  for (const ev of ['query-session-end', 'session-end']) { try { win.on(ev, () => { quitting = true; }); } catch { /* older Electron */ } }
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
  wc.on('did-finish-load', () => { pushUpd(); sendPresence(); });
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
  else if (action === 'ai') openAiPanel();
});

// ----- notifications: the page says what to show; the app draws it as a small card in the bottom-right corner of the screen,
// in the current Aduna theme (toast.html, its own transparent always-on-top window). Clicking a card brings the window forward and
// tells the page which chat to open. If that window ever fails, it falls back to a native Windows notification. -----
const THEME_KEYS = ['--bg', '--bg3', '--raised', '--text', '--line', '--head', '--muted', '--hover', '--danger', '--green', '--ink', '--on-ink'];
const TOAST_W = 388;                  // 360 card + 14px of room for its shadow on each side
let toastWin = null, toastReady = false;
const toastQueue = [];                // messages sent before toast.html finished loading
const toastTargets = new Map();       // toast id -> chat to open when it is clicked
const clean = (v, n) => String(v == null ? '' : v).slice(0, n);

// ---- small settings file (only remembers that the tray hint and the start-with-Windows default were handled) ----
const prefsFile = () => path.join(app.getPath('userData'), 'desktop-prefs.json');
function readPrefs() { try { return JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) || {}; } catch { return {}; } }
function writePrefs(p) { try { fs.writeFileSync(prefsFile(), JSON.stringify(p)); } catch { /* not critical */ } }

// Is the person looking at Aduna right now? The page asks this instead of guessing from document.hasFocus().
const isActive = () => !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused();
function sendPresence() { if (alive(page)) page.webContents.send('presence', isActive()); }
ipcMain.on('presence-get', (e) => { if (fromPage(e)) sendPresence(); });

function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

// The tray item, the title bar button and the menu all lead to the same place: Settings > Developer, where the AI panel is.
// The page does the navigating (it has the login and the settings screen); it hears this as a click on an "ai" notification.
function openAiPanel() {
  const fresh = !win;                                  // the window was closed to nothing: wait for the page to load first
  showWindow();
  const go = () => { if (alive(page)) page.webContents.send('notif-click', 'ai'); };
  if (fresh) setTimeout(go, 4000); else go();
}

// The AI builder is a bonus: if it cannot start, Aduna still opens.
function startAi() {
  try {
    const aiService = require('./ai/ai-service');
    ai = aiService.create({
      ipcMain, dataDir: app.getPath('userData'), ollama: require('./ai/ollama').create(),
      send: (ch, d) => { if (alive(page)) page.webContents.send(ch, d); },
      isTrusted: fromPage, notify: showToast, windowActive: isActive, openExternal,
    });
  } catch (e) { console.error('AI builder did not start:', e && e.message); }
}

function ensureToastWin() {
  if (alive(toastWin)) return toastWin;
  toastReady = false;
  toastWin = new BrowserWindow({
    width: TOAST_W, height: 10, show: false, frame: false, transparent: true, hasShadow: false, resizable: false, movable: false,
    focusable: false, skipTaskbar: true, alwaysOnTop: true, minimizable: false, maximizable: false, fullscreenable: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'toast-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  toastWin.setAlwaysOnTop(true, 'screen-saver'); // above full-screen windows too
  toastWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  toastWin.webContents.on('will-navigate', (e) => e.preventDefault());
  toastWin.webContents.on('did-finish-load', () => {
    toastReady = true;
    toastWin.webContents.send('toast-theme', theme);
    while (toastQueue.length) { const [ch, arg] = toastQueue.shift(); toastWin.webContents.send(ch, arg); }
  });
  toastWin.on('closed', () => { toastWin = null; toastReady = false; });
  toastWin.loadFile(path.join(__dirname, 'toast.html'));
  return toastWin;
}
function sendToast(channel, arg) {
  const w = ensureToastWin();
  if (toastReady) w.webContents.send(channel, arg); else toastQueue.push([channel, arg]);
}
// The card window tells us how tall its stack is; we pin it to the bottom-right corner of the work area (above the taskbar).
ipcMain.on('toast-size', (e, w, h) => {
  if (!alive(toastWin) || e.sender !== toastWin.webContents) return;
  h = Math.max(0, Math.min(1000, Math.round(Number(h) || 0)));
  if (h === 0) { toastWin.hide(); return; }
  const a = screen.getPrimaryDisplay().workArea;
  toastWin.setBounds({ x: a.x + a.width - TOAST_W, y: a.y + a.height - h, width: TOAST_W, height: h }, false);
  if (!toastWin.isVisible()) toastWin.showInactive();
});
ipcMain.on('toast-open', (e, id) => {
  if (!alive(toastWin) || e.sender !== toastWin.webContents) return;
  const target = toastTargets.get(clean(id, 80)) || '';
  showWindow();
  if (alive(page)) page.webContents.send('notif-click', target);
});
ipcMain.on('toast-gone', (e, id) => { if (alive(toastWin) && e.sender === toastWin.webContents) toastTargets.delete(clean(id, 80)); });

let toastSeq = 0;
function showToast(n) {
  const id = clean(n.tag, 80) || 'n' + (++toastSeq);
  try {
    toastTargets.set(id, clean(n.target, 80));
    sendToast('toast-add', { id, title: clean(n.title, 100) || 'Aduna', body: clean(n.body, 200), kind: clean(n.kind, 20), sticky: !!n.sticky });
  } catch (err) {
    console.error('Toast window failed, using a Windows notification:', err && err.message);
    nativeToast(n);
  }
  if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true); // flashes the taskbar button until the window is focused
}
function nativeToast(n) {
  if (!Notification.isSupported()) return;
  const tag = clean(n.tag, 80);
  if (tag && nativeToasts.has(tag)) { try { nativeToasts.get(tag).close(); } catch { /* already gone */ } }
  const t = new Notification({ title: clean(n.title, 100) || 'Aduna', body: clean(n.body, 200), icon: iconPath, silent: false });
  t.on('click', () => { showWindow(); if (alive(page)) page.webContents.send('notif-click', clean(n.target, 80)); });
  t.on('close', () => { if (tag && nativeToasts.get(tag) === t) nativeToasts.delete(tag); });
  if (tag) nativeToasts.set(tag, t);
  t.show();
}
ipcMain.on('notify', (e, n) => { if (fromPage(e) && n && typeof n === 'object') showToast(n); });
ipcMain.on('notify-dismiss', (e, tag) => {
  if (!fromPage(e)) return;
  const id = clean(tag, 80);
  if (alive(toastWin)) sendToast('toast-remove', id);
  const t = nativeToasts.get(id); if (t) { try { t.close(); } catch { /* ignore */ } nativeToasts.delete(id); }
});

ipcMain.on('theme-vars', (e, vars) => {
  if (!fromPage(e) || !vars || typeof vars !== 'object') return;
  const clean = {};
  for (const k of THEME_KEYS) {
    const v = vars[k];
    if (typeof v === 'string' && v.length < 200 && /^[#a-zA-Z0-9(),.%\s-]+$/.test(v)) clean[k] = v;
  }
  theme = clean;
  if (alive(bar)) bar.webContents.send('bar-theme', clean);
  if (alive(toastWin)) toastWin.webContents.send('toast-theme', clean);
  if (bar && clean['--bg3'] && /^#[0-9a-fA-F]{6}$/.test(clean['--bg3'])) { bar.setBackgroundColor(clean['--bg3']); page.setBackgroundColor(clean['--bg3']); }
});

// ----- updates: status lives on the right of the server bar. Scan -> "Checking for update…" -> "No update available" (10s, then
// fades) or an update that downloads by itself ("Downloading 40%") and then shows "New Update [Refresh]"; Refresh restarts into the new version. -----
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
  if (['downloading', 'ready', 'installing'].includes(upd.phase)) { pushUpd(); return; } // already know about one
  if (checking) return;
  showChecks = !!manual;
  if (!app.isPackaged) return fakeCheck();           // dev run: simulate so the UI can be tried (ADUNA_FAKE_UPDATE=available|none)
  checking = true;
  if (showChecks) setUpd({ phase: 'checking' });
  autoUpdater.checkForUpdates().catch(() => {}).finally(() => { checking = false; });
}
// Refresh: the update has already downloaded by itself, so this only restarts into it.
function startInstall() {
  if (upd.phase !== 'ready') return;
  if (!app.isPackaged) return fakeApply();
  setUpd({ phase: 'installing', version: upd.version });
  setTimeout(() => autoUpdater.quitAndInstall(true, true), 700);
}
function setupUpdates() {
  autoUpdater.autoDownload = true;           // new versions download in the background, no button
  autoUpdater.autoInstallOnAppQuit = true;   // if Refresh is never pressed, the downloaded update installs the next time Aduna quits
  autoUpdater.on('update-available', (info) => { downloading = true; setUpd({ phase: 'downloading', version: info && info.version, pct: 0 }); });
  autoUpdater.on('update-not-available', () => { if (showChecks) setUpd({ phase: 'none' }, 10 * 1000); });
  autoUpdater.on('download-progress', (p) => { upd = { phase: 'downloading', version: upd.version, pct: p.percent }; pushUpd(); });
  autoUpdater.on('update-downloaded', () => {
    downloading = false;
    setUpd({ phase: 'ready', version: upd.version }); // chip: "New Update [Refresh]"
  });
  autoUpdater.on('error', (err) => {
    console.error('Update error:', err && err.message);
    if (downloading) { downloading = false; setUpd({ phase: 'error', message: 'Update failed' }, 6000, { phase: 'idle' }); } // the next scan finds it again and retries
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
    if (process.env.ADUNA_FAKE_UPDATE === 'available') fakeDownload('9.9.9');
    else setUpd({ phase: 'none' }, 10 * 1000);
  }, 1800);
}
function fakeDownload(version) {
  let p = 0; setUpd({ phase: 'downloading', version, pct: 0 });
  const t = setInterval(() => {
    p += 12; if (p < 100) { upd = { phase: 'downloading', version, pct: p }; pushUpd(); return; }
    clearInterval(t); setUpd({ phase: 'ready', version });
  }, 250);
}
function fakeApply() { setUpd({ phase: 'installing', version: upd.version }); setTimeout(() => setUpd({ phase: 'idle' }), 1500); }

// ----- tray: Aduna keeps running here when the window is closed, so mentions / DMs / calls still pop up -----
function startsWithWindows() { try { return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin; } catch { return false; } }
function setStartsWithWindows(on) { try { app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] }); } catch { /* dev run */ } buildTray(); }
// The taskbar and tray follow Windows' *system* mode, which can differ from the *apps* mode that nativeTheme reports, so read it from the registry.
function taskbarIsDark(cb) {
  const fallback = () => cb(nativeTheme.shouldUseDarkColors);
  if (process.platform !== 'win32') return fallback();
  execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'SystemUsesLightTheme'], { windowsHide: true, timeout: 4000 }, (err, out) => {
    const m = !err && /SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(String(out || ''));
    if (m) cb(parseInt(m[1], 16) === 0); else fallback();
  });
}
function trayImage() { const img = nativeImage.createFromPath(iconPath); return img.isEmpty() ? img : img.resize({ width: 32, height: 32 }); }
function applyIcons() {
  taskbarIsDark((dark) => {
    const next = dark ? ICON_WHITE : ICON_BLACK;
    if (next === iconPath) return;
    iconPath = next;
    try { if (win && !win.isDestroyed()) win.setIcon(iconPath); } catch { /* window closing */ }
    try { if (tray && !tray.isDestroyed()) tray.setImage(trayImage()); } catch { /* tray gone */ }
  });
}
nativeTheme.on('updated', applyIcons);

function buildTray() {
  if (!tray) {
    tray = new Tray(trayImage());
    tray.setToolTip('Aduna');
    tray.on('click', showWindow);
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Aduna', click: showWindow },
    { label: 'AI Coder\u2026', click: openAiPanel },
    { label: 'Check for updates\u2026', click: () => { showWindow(); runCheck(true); } },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: startsWithWindows(), enabled: app.isPackaged, click: (item) => setStartsWithWindows(item.checked) },
    { label: 'Show the game I’m playing', type: 'checkbox', checked: readPrefs().detectGames !== false, click: (item) => setDetectGames(item.checked) },
    { type: 'separator' },
    { label: 'Quit Aduna', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ----- "Playing ..." on the profile, found automatically (like Discord) -----
// Every 30 seconds the app reads the NAMES of the running programs, and only if one is on the fixed list in games.js does it tell the page
// which game it is. The page then reports it to Aduna (which refreshes it about once a minute and drops it a few minutes after the game
// closes). Nothing else is read or sent. Tray > "Show the game I'm playing" turns the looking off on this PC.
let gameNow = null, scanning = false;
function setGame(name) {
  if (name === gameNow) return;
  gameNow = name;
  if (alive(page)) page.webContents.send('game', gameNow);
}
function scanGames() {
  if (process.platform !== 'win32' || scanning) return;
  if (readPrefs().detectGames === false) { setGame(null); return; }
  scanning = true;
  execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
    scanning = false;
    if (err) return; // keep what we had; the next scan tries again
    setGame(games.pick(games.parseTasklist(String(out || '')), gameNow));
  });
}
ipcMain.on('game-get', (e) => { if (fromPage(e) && alive(page)) page.webContents.send('game', gameNow); });
function setDetectGames(on) { const p = readPrefs(); p.detectGames = !!on; writePrefs(p); if (on) scanGames(); else setGame(null); buildTray(); }

// ----- screen sharing -----
// Electron has no built-in screen picker: without a handler, getDisplayMedia() simply fails. So the page shows its own picker
// (client/src/ScreenShare.jsx), asks for the list here ('screen:sources'), and tells us which one was chosen ('screen:choose').
// The handler below then answers the page's getDisplayMedia() call with exactly that source, once, within a few seconds.
let pendingShare = null;
function setupScreenShare() {
  const fromAduna = (wc) => !!wc && !wc.isDestroyed() && wc.getURL().startsWith(ORIGIN);
  ipcMain.handle('screen:sources', async (e) => {
    if (!fromAduna(e.sender)) return [];
    try {
      const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 360, height: 220 }, fetchWindowIcons: true });
      return list.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumb: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : '',
      }));
    } catch { return []; }
  });
  ipcMain.handle('screen:choose', (e, id) => {
    if (!fromAduna(e.sender)) return false;
    pendingShare = typeof id === 'string' && /^(screen|window):[\w:.-]+$/.test(id) ? { id, at: Date.now() } : null;
    return !!pendingShare;
  });
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const pick = pendingShare; pendingShare = null;
    const deny = () => { try { callback({}); } catch { /* already answered */ } };
    if (!pick || Date.now() - pick.at > 15000 || !request.frame || !request.frame.url.startsWith(ORIGIN)) return deny();
    desktopCapturer.getSources({ types: ['screen', 'window'] })
      .then((list) => { const s = list.find((x) => x.id === pick.id); if (s) callback({ video: s }); else deny(); }) // video only: sharing system audio would feed the other person's voice back to them
      .catch(deny);
  }, { useSystemPicker: false });
}

app.setAppUserModelId('app.aduna.desktop'); // same as build.appId: Windows needs it to show notifications from the app
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => { quitting = true; if (ai) ai.shutdown().catch(() => {}); }); // lets the update installer and "Quit" really close the window; a running AI build stops after its last saved attempt
  app.whenReady().then(() => {
    // Calls need the microphone and camera; mentions need notifications. Allowed only for the Aduna server.
    const ok = (wc, perm) => ['media', 'notifications', 'fullscreen', 'clipboard-sanitized-write'].includes(perm) && !!wc && wc.getURL().startsWith(ORIGIN);
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(ok(wc, perm)));
    session.defaultSession.setPermissionCheckHandler((wc, perm) => ok(wc, perm));
    setupScreenShare();
    // No visible menu any more (the window is frameless), but the shortcuts still work.
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Aduna', submenu: [{ label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => page && page.webContents.loadURL(APP_URL) }, { label: 'Check for updates\u2026', accelerator: 'CmdOrCtrl+Shift+U', click: () => runCheck(true) }, { label: 'AI Coder\u2026', accelerator: 'CmdOrCtrl+Shift+A', click: openAiPanel }, { type: 'separator' }, { label: 'Quit', click: () => { quitting = true; app.quit(); } }] },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }] },
    ]));
    // First run of an installed copy: start with Windows (hidden in the tray) so notifications work after a reboot. The tray menu turns it off.
    const p = readPrefs();
    if (app.isPackaged && !p.autostartHandled) { p.autostartHandled = true; writePrefs(p); try { app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] }); } catch { /* ignore */ } }
    startAi();
    createWindow();
    buildTray();
    applyIcons(); // correct the first guess with the real taskbar mode
    setupUpdates();
    setTimeout(scanGames, 5000);
    setInterval(scanGames, 30 * 1000);
  });
  // No 'window-all-closed' quit: closing the window hides it to the tray (see createWindow). "Quit" in the tray really exits.
  app.on('window-all-closed', () => { /* keep running in the tray */ });
}
