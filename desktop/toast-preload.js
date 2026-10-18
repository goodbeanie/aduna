// Only the notification-card window (toast.html) uses this: it receives cards + theme colours and reports its size and clicks.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('adunaToast', {
  onAdd: (cb) => ipcRenderer.on('toast-add', (_e, t) => cb(t)),
  onRemove: (cb) => ipcRenderer.on('toast-remove', (_e, id) => cb(id)),
  onTheme: (cb) => ipcRenderer.on('toast-theme', (_e, vars) => cb(vars)),
  size: (w, h) => ipcRenderer.send('toast-size', w, h),
  open: (id) => ipcRenderer.send('toast-open', id),
  gone: (id) => ipcRenderer.send('toast-gone', id),
});
