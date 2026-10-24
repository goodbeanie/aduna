// Worker thread: loads QuickJS once, then runs one bot test (bot.js + test.js) per message. The host (qjs-host.js) kills this thread if it overruns.
'use strict';
const { parentPort } = require('worker_threads');
const { loadLib } = require('./sandbox-core');
const { runSuite } = require('./suite');

const failed = (msg) => ({ ok: false, error: msg, retire: true, timedOut: false, tests: [], failures: [], console: [], activity: [], registered: [], events: {}, assertions: 0, bots: 0, ms: 0, exitCode: 0, final: null, covered: false, coverage: { missing: [], silent: [], noHandlers: false, noAssertions: false } });

(async () => {
  const lib = loadLib();
  const q = await lib.getQuickJS();
  parentPort.postMessage({ ready: true });
  parentPort.on('message', ({ id, job, limits }) => {
    let result;
    try { result = runSuite(lib, q, job, { limits }); }
    catch (e) { result = failed('The bot sandbox failed: ' + String(e && e.message).slice(0, 200)); }
    parentPort.postMessage({ id, result });
    if (result.retire) process.exit(0); // the host starts a fresh worker; this one may have a damaged WebAssembly module
  });
})().catch((e) => { parentPort.postMessage({ fatal: String(e && e.message) }); process.exit(1); });
