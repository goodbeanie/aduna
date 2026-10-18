// Aduna desktop app. It is a window onto your Aduna server: the server (on Render) keeps all secrets and settings,
// so nothing sensitive is stored in this app. It opens straight to the login / register screen.
const { app, BrowserWindow, Menu, shell, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');

const userCfg = () => path.join(app.getPath('userData'), 'server.json');
const bundledCfg = () => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch { return {}; } };

// https only (plain http is allowed for localhost while developing). Returns the origin, or null.
function cleanUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null;
    return u.origin;
  } catch { return null; }
}
function serverUrl() {
  try { const u = cleanUrl(JSON.parse(fs.readFileSync(userCfg(), 'utf8')).url); if (u) return u; } catch { /* none saved */ }
  return cleanUrl(bundledCfg().url);
}

let win = null, origin = null;
const iconPath = path.join(__dirname, 'build', 'icon.png');

function showSetup(error) {
  const query = { url: origin || '' };
  if (error) query.error = error;
  win.loadFile(path.join(__dirname, 'setup.html'), { query });
}
function openApp() {
  origin = serverUrl();
  if (!origin) return showSetup();
  win.loadURL(origin + '/app');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600, backgroundColor: '#141917', icon: iconPath, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file://') || (origin && new URL(url).origin === origin)) return;
    e.preventDefault(); openExternal(url);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) showSetup(`Could not reach ${origin || 'the server'} (${desc}). Check the address and your internet connection.`);
  });
  openApp();
}

function openExternal(url) { try { if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url); } catch { /* ignore */ } }

ipcMain.handle('set-server', (e, raw) => {
  if (!e.senderFrame.url.startsWith('file://')) return { error: 'Not allowed' }; // only the local setup page may change it
  const u = cleanUrl(raw);
  if (!u) return { error: 'Enter a valid https:// address' };
  fs.writeFileSync(userCfg(), JSON.stringify({ url: u }));
  openApp();
  return { ok: true };
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    // Calls need the microphone and camera; mentions need notifications. Allowed only for your own server.
    const ok = (wc, perm) => ['media', 'notifications', 'fullscreen', 'clipboard-sanitized-write'].includes(perm) && !!origin && wc && wc.getURL().startsWith(origin);
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(ok(wc, perm)));
    session.defaultSession.setPermissionCheckHandler((wc, perm) => ok(wc, perm));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Aduna', submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win && win.reload() },
        { label: 'Change server address…', click: () => win && showSetup() },
        { type: 'separator' }, { role: 'quit' },
      ] },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }] },
    ]));
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
