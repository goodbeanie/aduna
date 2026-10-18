// Aduna desktop app: a window that opens https://aduna.onrender.com/app and nothing else.
// All secrets and settings live on the server, so nothing sensitive is stored in this app.
// Updates are fetched from https://aduna.onrender.com/updates/ (see the publish setting in package.json).
const { app, BrowserWindow, Menu, shell, session, screen, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

const ORIGIN = 'https://aduna.onrender.com';
const APP_URL = ORIGIN + '/app';
const iconPath = path.join(__dirname, 'build', 'icon.png');

let win = null, popup = null, readyVersion = null;

function openExternal(url) { try { if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url); } catch { /* ignore */ } }

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600, backgroundColor: '#141917', icon: iconPath, autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file://') || new URL(url).origin === ORIGIN) return;
    e.preventDefault(); openExternal(url);
  });
  // No connection: show a small page that keeps retrying.
  win.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) win.loadFile(path.join(__dirname, 'offline.html'));
  });
  win.loadURL(APP_URL);
}

// ----- updates (like Discord): the app checks quietly, downloads in the background, then shows a small popup in the
// corner of the window. "Restart & update" installs now; "Later" installs automatically the next time Aduna is closed.
const POPUP_W = 372, POPUP_H = 130;
function placePopup() {
  if (!popup || popup.isDestroyed() || !win) return;
  const b = win.isMinimized() || !win.isVisible() ? screen.getPrimaryDisplay().workArea : win.getBounds();
  popup.setPosition(Math.round(b.x + b.width - POPUP_W - 16), Math.round(b.y + b.height - POPUP_H - 16));
}
function showUpdatePopup(version) {
  if (!win) return;
  if (popup && !popup.isDestroyed()) popup.close();
  popup = new BrowserWindow({
    width: POPUP_W, height: POPUP_H, parent: win, frame: false, transparent: true, hasShadow: false, resizable: false,
    movable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'update-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  popup.setMenu(null);
  popup.loadFile(path.join(__dirname, 'update.html'), { query: { v: String(version || '') } });
  popup.once('ready-to-show', () => { placePopup(); popup.showInactive(); });
  popup.on('closed', () => { popup = null; });
}
ipcMain.on('update-action', (e, action) => {
  if (!popup || popup.isDestroyed() || e.sender !== popup.webContents) return; // only the popup may ask
  if (action === 'install') autoUpdater.quitAndInstall(true, true);
  else popup.close();
});
function setupUpdates() {
  if (!app.isPackaged) return; // updates only apply to the installed app
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => { readyVersion = info.version; showUpdatePopup(info.version); });
  autoUpdater.on('error', (err) => console.error('Update check failed:', err && err.message));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 10 * 1000);
  setInterval(check, 30 * 60 * 1000);
  for (const ev of ['move', 'resize', 'minimize', 'restore']) win.on(ev, placePopup);
}
async function manualUpdateCheck() {
  const info = (message, detail) => dialog.showMessageBox(win, { type: 'info', message, detail, buttons: ['OK'] });
  if (!app.isPackaged) return info('Updates only work in the installed app.');
  if (readyVersion) return showUpdatePopup(readyVersion);
  try {
    const r = await autoUpdater.checkForUpdates();
    if (r && r.isUpdateAvailable) info('An update was found.', 'It is downloading now. You will get a popup when it is ready to install.');
    else info('Aduna is up to date.', 'Version ' + app.getVersion());
  } catch { info('Could not check for updates.', 'Check your internet connection and try again.'); }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    // Calls need the microphone and camera; mentions need notifications. Allowed only for the Aduna server.
    const ok = (wc, perm) => ['media', 'notifications', 'fullscreen', 'clipboard-sanitized-write'].includes(perm) && !!wc && wc.getURL().startsWith(ORIGIN);
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(ok(wc, perm)));
    session.defaultSession.setPermissionCheckHandler((wc, perm) => ok(wc, perm));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Aduna', submenu: [{ label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win && win.loadURL(APP_URL) }, { label: 'Check for updates…', click: manualUpdateCheck }, { type: 'separator' }, { role: 'quit' }] },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }] },
    ]));
    createWindow();
    setupUpdates();
  });
  app.on('window-all-closed', () => app.quit());
}
