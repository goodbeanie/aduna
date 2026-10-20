// Worker thread: loads QuickJS once, then runs one bot event per message. The host (sandbox.js) kills this thread if it overruns.
const { parentPort } = require('worker_threads');
const { runCore, loadLib } = require('./sandbox-core');
(async () => {
  const lib = loadLib();
  let q = await lib.getQuickJS();
  parentPort.postMessage({ ready: true });
  parentPort.on('message', async ({ id, job, limits }) => {
    let result;
    try { result = runCore(lib, q, job, limits); }
    catch (e) { result = { ok: false, actions: [], logs: [], error: 'The bot sandbox failed: ' + String(e && e.message).slice(0, 200), timedOut: false, ms: 0, retire: true }; }
    parentPort.postMessage({ id, result });
    if (result.retire) process.exit(0); // the host starts a fresh worker; this one may have a damaged WebAssembly module
  });
})().catch((e) => { parentPort.postMessage({ fatal: String(e && e.message) }); process.exit(1); });
