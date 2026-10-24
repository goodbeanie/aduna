// Only the AI Coder window uses this. It exposes a small, fixed set of actions; the window can't reach Node or the file system itself.
const { contextBridge, ipcRenderer } = require('electron');
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('adunaAI', {
  status: call('ai:status'),
  startOllama: call('ai:start-ollama'),
  installOllama: call('ai:install-ollama'),
  pull: call('ai:pull'),
  cancelPull: call('ai:cancel-pull'),
  remove: call('ai:remove'),
  run: call('ai:run'),
  stop: call('ai:stop'),
  confirm: call('ai:confirm'),
  newProject: call('ai:new-project'),
  openFolder: call('ai:open-folder'),
  onEvent: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('ai:event', h); return () => ipcRenderer.removeListener('ai:event', h); },
});
