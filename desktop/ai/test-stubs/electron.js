// Test stub of Electron (used only by ai-window-test.js): records IPC handlers and sent events.
const handlers = {}; const sent = [];
const docs = require('path').join(require('os').tmpdir(), 'aduna-docs-' + process.pid);
class BW { constructor(o) { this.o = o; this.webContents = { send: (ch, d) => sent.push([ch, d]), isDestroyed: () => false, setWindowOpenHandler() {}, on() {} }; BW.last = this; }
  isDestroyed() { return false; } setMenu() {} on() {} loadFile() {} isMinimized() { return false; } show() {} focus() {} }
module.exports = { BrowserWindow: BW, ipcMain: { handle: (c, f) => { handlers[c] = f; } }, shell: { openPath: async (p) => { module.exports._opened = p; return ''; }, openExternal() {} }, app: { getPath: () => docs }, _handlers: handlers, _sent: sent, _docs: docs };
