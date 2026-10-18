// Only the little update popup uses this.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('adunaUpdate', { act: (action) => ipcRenderer.send('update-action', action) });
