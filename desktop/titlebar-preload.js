// Only the custom title bar uses this. It can send four window actions and receive theme colours + window state.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('adunaBar', {
  act: (name) => ipcRenderer.send('bar-action', name),
  onTheme: (cb) => ipcRenderer.on('bar-theme', (_e, vars) => cb(vars)),
  onState: (cb) => ipcRenderer.on('bar-state', (_e, s) => cb(s)),
});
