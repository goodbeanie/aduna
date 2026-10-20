// Runs a bot's JavaScript in QuickJS (WebAssembly) so it cannot touch the server: no files, no network, no `process`, no `require`,
// no timers. What happens inside is in sandbox-core.js; this file is the host side:
//  - a small pool of worker threads (default 2, SANDBOX_WORKERS) so the main thread never runs bot code and keeps serving people;
//  - one event per worker at a time, extra events wait in a queue (at most `queueMax`, then the event is dropped: a busy bot cannot
//    pile up work for everyone);
//  - a HARD deadline per event (limits.ms + a short grace). QuickJS's own interrupt stops loops, but it cannot interrupt a regex, and an
//    out-of-memory can wreck the module, so when the deadline passes (or the worker reports damage) the worker thread is killed and
//    replaced. A killed run reports { ok: false, timedOut: true }.
// run({ code, event, payload }, limits?) -> { ok, actions: [{ channelId, text, replyTo }], logs: [string], error, timedOut, ms }
const path = require('path');
const { Worker } = require('worker_threads');
const core = require('./sandbox-core');

const LIMITS = core.LIMITS;
const GRACE_MS = 300;
const POOL = Math.max(1, Math.min(8, Number(process.env.SANDBOX_WORKERS) || 2));
const QUEUE_MAX = 200;
const FILE = path.join(__dirname, 'sandbox-worker.js');

const available = () => { try { core.loadLib(); return true; } catch { return false; } };

const slots = [];          // { worker, busy: job|null, ready: Promise }
const queue = [];          // jobs waiting for a worker
let stopped = false;

function spawn() {
  const slot = { worker: null, job: null, ready: null, dead: false };
  slot.worker = new Worker(FILE, { env: { NODE_PATH: process.env.NODE_PATH || '' }, stdout: false, stderr: false, resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 } });
  slot.ready = new Promise((resolve, reject) => {
    slot.worker.on('message', (m) => {
      if (m.ready) return resolve();
      if (m.fatal) return reject(Object.assign(new Error(m.fatal), { code: 'SANDBOX_MISSING' }));
      if (slot.job && m.id === slot.job.id) finish(slot, m.result);
    });
    slot.worker.on('error', (e) => { reject(e); crashed(slot, e); });
    slot.worker.on('exit', () => { if (!slot.dead) crashed(slot, new Error('worker exited')); resolve(); });
  });
  slot.ready.catch(() => {});
  return slot;
}
function replace(slot) {
  slot.dead = true;
  const i = slots.indexOf(slot);
  slot.worker.terminate().catch(() => {});
  if (!stopped && i >= 0) { slots[i] = spawn(); pump(); }
}
function finish(slot, result) {
  const job = slot.job; if (!job) return;
  slot.job = null; clearTimeout(job.timer);
  const { retire, ...r } = result;
  job.resolve(r);
  if (retire) replace(slot); else pump();
}
function crashed(slot, e) {
  if (slot.dead) return;
  const job = slot.job; slot.job = null;
  if (job) { clearTimeout(job.timer); job.resolve({ ok: false, actions: [], logs: [], error: 'The bot sandbox crashed', timedOut: false, ms: Date.now() - job.started }); }
  replace(slot);
}
function pump() {
  for (const slot of slots) {
    if (!queue.length) return;
    if (slot.job || slot.dead) continue;
    const job = queue.shift();
    slot.job = job; job.started = Date.now();
    slot.ready.then(() => {
      if (slot.dead || slot.job !== job) return;
      job.timer = setTimeout(() => { // hard kill
        if (slot.job !== job) return;
        slot.job = null;
        job.resolve({ ok: false, actions: [], logs: [], error: `The bot took longer than ${job.limits.ms ?? LIMITS.ms} ms and was stopped`, timedOut: true, ms: Date.now() - job.started });
        replace(slot);
      }, (job.limits.ms ?? LIMITS.ms) + GRACE_MS);
      slot.worker.postMessage({ id: job.id, job: job.job, limits: job.limits });
    }, () => { if (slot.job === job) { slot.job = null; job.resolve({ ok: false, actions: [], logs: [], error: 'The bot sandbox is not available', timedOut: false, ms: 0 }); replace(slot); } });
  }
}

// Starts the workers (and loads QuickJS in each). Call it at startup; run() calls it anyway.
async function ready() {
  if (!available()) throw Object.assign(new Error('The bot sandbox is not installed (npm install quickjs-emscripten)'), { code: 'SANDBOX_MISSING' });
  stopped = false;
  while (slots.length < POOL) slots.push(spawn());
  await Promise.all(slots.map((s) => s.ready));
}
// Stops the workers (tests and shutdown).
async function stop() {
  stopped = true;
  for (const j of queue.splice(0)) j.resolve({ ok: false, actions: [], logs: [], error: 'The bot sandbox is shutting down', timedOut: false, ms: 0 });
  await Promise.all(slots.splice(0).map((s) => { s.dead = true; return s.worker.terminate(); }));
}

let seq = 0;
async function run(job, limits = {}) {
  await ready();
  return new Promise((resolve) => {
    if (queue.length >= QUEUE_MAX) return resolve({ ok: false, actions: [], logs: [], error: 'Too many bot events are waiting; this one was dropped', timedOut: false, ms: 0 });
    queue.push({ id: ++seq, job, limits, resolve, timer: null, started: 0 });
    pump();
  });
}

module.exports = { run, ready, stop, available, LIMITS };
