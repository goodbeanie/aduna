// Only the local setup page uses this. It lets that page hand the server address to the app.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('adunaDesktop', {
  setServer: (url) => ipcRenderer.invoke('set-server', url),
});
