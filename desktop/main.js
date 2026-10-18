// Aduna desktop app: a window that opens https://aduna.onrender.com/app and nothing else.
// All secrets and settings live on the server, so nothing sensitive is stored in this app.
const { app, BrowserWindow, Menu, shell, session } = require('electron');
const path = require('path');

const ORIGIN = 'https://aduna.onrender.com';
const APP_URL = ORIGIN + '/app';
const iconPath = path.join(__dirname, 'build', 'icon.png');

let win = null;

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

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    // Calls need the microphone and camera; mentions need notifications. Allowed only for the Aduna server.
    const ok = (wc, perm) => ['media', 'notifications', 'fullscreen', 'clipboard-sanitized-write'].includes(perm) && !!wc && wc.getURL().startsWith(ORIGIN);
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(ok(wc, perm)));
    session.defaultSession.setPermissionCheckHandler((wc, perm) => ok(wc, perm));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Aduna', submenu: [{ label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win && win.loadURL(APP_URL) }, { type: 'separator' }, { role: 'quit' }] },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }] },
    ]));
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
