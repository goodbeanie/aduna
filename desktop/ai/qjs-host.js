// Host side of the bot test sandbox: one worker thread (qjs-worker.js) runs bot tests one at a time, so the app's main thread never runs
// code the AI wrote. A test gets a HARD deadline (the suite's own limit plus a grace period): QuickJS cannot interrupt a regex, so when the
// deadline passes, or the worker reports damage, the worker thread is killed and replaced.
//   const r = createRunner();  const result = await r.run({ botCode, testCode, fetchHosts });  await r.stop();
// A killed run reports { ok: false, timedOut: true }. The worker is started on the first run, so a problem loading it shows up as an error
// result in the panel instead of breaking app start.
'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const { LIMITS } = require('./suite');

const GRACE_MS = 4000;

// In the installed app the files live inside app.asar, and a worker thread needs a real file: the build unpacks ai/ next to it
// (asarUnpack in package.json), so use that copy when it exists.
function defaultWorkerFile() {
  const f = path.join(__dirname, 'qjs-worker.js');
  const unpacked = f.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  try { if (unpacked !== f && require('fs').existsSync(unpacked)) return unpacked; } catch { /* use the packed one */ }
  return f;
}

const failed = (error, extra) => ({
  ok: false, error, timedOut: false, retire: false, tests: [], failures: [], console: [], activity: [], registered: [], events: {}, assertions: 0, bots: 0, ms: 0,
  exitCode: 0, final: null, covered: false, coverage: { missing: [], silent: [], noHandlers: false, noAssertions: false }, ...extra,
});

function createRunner(opts = {}) {
  const file = opts.file || defaultWorkerFile();
  const hardMs = (opts.suiteMs || LIMITS.suiteMs) + GRACE_MS;
  let slot = null;      // { worker, ready, job, dead }
  let chain = Promise.resolve();
  let seq = 0, stopped = false;

  function spawn() {
    const s = { worker: null, ready: null, job: null, dead: false };
    s.worker = new Worker(file, { env: { NODE_PATH: process.env.NODE_PATH || '' }, stdout: false, stderr: false, resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 24 } });
    s.ready = new Promise((resolve, reject) => {
      s.worker.on('message', (m) => {
        if (m.ready) return resolve();
        if (m.fatal) return reject(Object.assign(new Error(m.fatal), { code: 'SANDBOX_MISSING' }));
        if (s.job && m.id === s.job.id) settle(s, m.result);
      });
      s.worker.on('error', (e) => { reject(e); crashed(s, e); });
      s.worker.on('exit', () => { if (!s.dead) crashed(s, new Error('worker exited')); resolve(); });
    });
    s.ready.catch(() => {});
    return s;
  }
  function discard(s) { s.dead = true; if (slot === s) slot = null; s.worker.terminate().catch(() => {}); }
  function settle(s, result) {
    const job = s.job; if (!job) return;
    s.job = null; clearTimeout(job.timer);
    const { retire, ...r } = result || {};
    job.resolve(r);
    if (retire) discard(s);
  }
  function crashed(s) {
    if (s.dead) return;
    const job = s.job; s.job = null;
    if (job) { clearTimeout(job.timer); job.resolve(failed('The bot sandbox crashed', { ms: Date.now() - job.started })); }
    discard(s);
  }

  // job: { botCode, testCode, fetchHosts }
  function runOne(job, limits) {
    return new Promise((resolve) => {
      if (stopped) return resolve(failed('The bot sandbox is shutting down'));
      if (!slot) { try { slot = spawn(); } catch (e) { return resolve(failed('The bot sandbox could not start: ' + String(e && e.message).slice(0, 200), { sandboxMissing: true })); } }
      const s = slot;
      const mine = { id: ++seq, resolve, started: Date.now(), timer: null };
      s.job = mine;
      s.ready.then(() => {
        if (s.dead || s.job !== mine) return;
        mine.timer = setTimeout(() => { // hard kill
          if (s.job !== mine) return;
          s.job = null;
          resolve(failed(`The test took longer than ${hardMs / 1000} seconds and was stopped (an endless loop or a regex that never ends?)`, { timedOut: true, ms: Date.now() - mine.started }));
          discard(s);
        }, hardMs);
        s.worker.postMessage({ id: mine.id, job, limits });
      }, (e) => {
        if (s.job === mine) { s.job = null; resolve(failed('The bot sandbox is not available: ' + String(e && e.message).slice(0, 200), { sandboxMissing: true })); discard(s); }
      });
    });
  }

  // Tests run one after the other.
  function run(job, limits) {
    const next = chain.then(() => runOne(job, limits));
    chain = next.catch(() => {});
    return next;
  }
  async function stop() {
    stopped = true;
    if (slot) { const s = slot; slot = null; s.dead = true; await s.worker.terminate().catch(() => {}); }
  }
  return { run, stop };
}

module.exports = { createRunner };
