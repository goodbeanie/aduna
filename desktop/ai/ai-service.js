// The AI bot builder, running in the background of the desktop app. There is no window of its own: the panel lives in the Aduna page
// (Settings > Developer > bot editor), talks to this file over IPC, and can be closed or left at any time. A build keeps going while the
// person is somewhere else or Aduna is hidden in the tray, and a toast says when it ends.
//
// Everything here is injected (ipcMain, where to save, how to send to the page, how to show a toast), so it is tested without Electron:
//   const ai = create({ ipcMain, dataDir, ollama, send(channel, data), isTrusted(event), notify(toast), windowActive(), openExternal(url) })
// Nothing the AI writes runs on this PC: bot.js and test.js are only text handed to the QuickJS sandbox (qjs-host.js).
'use strict';
const os = require('os');
const path = require('path');
const core = require('./core');
const botMode = require('./bot-mode');
const { runBuild } = require('./loop');
const { createJobStore, ID_RE } = require('./jobs');
const { createLessons } = require('./lessons');

const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i;
const LOG_KEEP = 300;       // events kept so the panel can show what happened while it was closed
const STREAM_KEEP = 6000;   // characters of the model's reply kept for the same reason
const errMsg = (e) => String((e && e.message) || e || 'Something went wrong.');

function create(deps) {
  const ollama = deps.ollama;
  const send = deps.send || (() => {});
  const fsx = deps.fs || require('fs');
  const windowActive = deps.windowActive || (() => false);
  const jobs = createJobStore({ dir: path.join(deps.dataDir, 'ai-jobs'), fs: fsx });
  const lessons = createLessons({ file: path.join(deps.dataDir, 'ai-lessons.json'), fs: fsx });
  try { jobs.markInterrupted(); jobs.prune(); } catch { /* a bad folder must not stop the app from starting */ }

  let runner = null;
  const getRunner = () => runner || (runner = (deps.createRunner || require('./qjs-host').createRunner)());

  let current = null;            // the running build: { jobId, abort }
  let pulling = null;            // the running model download: { name, abort }
  let installing = null;         // the running Ollama install: AbortController
  let settingUp = false;
  let panelOpen = false;         // is the panel on screen right now (the page tells us)
  let log = [], stream = '';     // what the running (or last) build did, for a panel that opens late

  const sendEvent = (d) => { try { send('ai:event', d); } catch { /* the page is gone */ } };

  // ---------- events from the build ----------
  let tokBuf = '', tokTimer = null;
  function flushTokens() { clearTimeout(tokTimer); tokTimer = null; if (tokBuf) { sendEvent({ type: 'agent', jobId: current && current.jobId, kind: 'token', text: tokBuf }); tokBuf = ''; } }
  function agentEmit(jobId) {
    return (d) => {
      if (d.kind === 'token') {
        stream = (stream + d.text).slice(-STREAM_KEEP);
        tokBuf += d.text; if (!tokTimer) tokTimer = setTimeout(flushTokens, 80);
        return;
      }
      flushTokens();
      if (d.kind === 'attempt' || d.kind === 'reset') stream = '';
      if (d.kind === 'start') { log = []; stream = ''; }
      const e = Object.assign({ type: 'agent', jobId }, d);
      if (d.kind !== 'reset') { log.push(Object.assign({}, e, { at: Date.now() })); if (log.length > LOG_KEEP) log.shift(); }
      sendEvent(e);
    };
  }

  // ---------- Ollama and models ----------
  async function status() {
    const exe = await ollama.findExe();
    const running = await ollama.isRunning();
    let models = [];
    if (running) { try { models = await ollama.listModels(); } catch { /* shown as empty */ } }
    const gpu = await ollama.detectGpu();
    return {
      ok: true, platform: process.platform, ollama: { installed: !!exe || running, running }, models, gpu, ramGB: Math.round(os.totalmem() / 2 ** 30),
      catalog: core.MODELS, busy: !!current, jobId: current ? current.jobId : null, pulls: pulling ? [pulling.name] : [], installing: !!installing, settingUp,
      lessons: lessons.all().length, log: current ? log.slice() : [], stream: current ? stream : '',
    };
  }

  const startOllama = async () => ((await ollama.ensureServer()) ? { ok: true } : { ok: false, error: 'Ollama did not start. Open it from the Start menu, then press Refresh.' });

  async function installOllama() {
    if (installing) return { ok: false, error: 'Ollama is already installing.' };
    if (process.platform !== 'win32') { if (deps.openExternal) deps.openExternal('https://ollama.com/download'); return { ok: false, error: 'Opened the Ollama download page. Install it, then press Refresh.' }; }
    installing = new AbortController();
    try {
      await ollama.installOllama((p) => sendEvent({ type: 'ollama-install', status: p.status, pct: p.pct }), installing.signal);
      sendEvent({ type: 'ollama-install', status: 'Ollama is ready.', pct: 100, done: true });
      return { ok: true };
    } catch (e) { sendEvent({ type: 'ollama-install', status: errMsg(e), error: true, done: true }); return { ok: false, error: errMsg(e) }; }
    finally { installing = null; }
  }

  async function pull(name) {
    name = String(name || '').trim();
    if (!core.MODEL_NAME_RE.test(name)) return { ok: false, error: 'That model name is not valid.' };
    if (pulling) return { ok: false, error: 'Another download is already running.' };
    const mine = { name, abort: new AbortController() };
    pulling = mine;
    try {
      if (!(await ollama.ensureServer())) throw new Error('Ollama is not running. Install or start Ollama first.');
      await ollama.pull(name, (p) => sendEvent({ type: 'pull', name, status: p.status, pct: p.pct }), mine.abort.signal);
      sendEvent({ type: 'pull-done', name, ok: true });
      return { ok: true };
    } catch (e) {
      const error = mine.abort.signal.aborted ? 'Cancelled.' : errMsg(e);
      sendEvent({ type: 'pull-done', name, ok: false, error });
      return { ok: false, error };
    } finally { if (pulling === mine) pulling = null; }
  }

  // One click: install Ollama if it is missing, check the graphics card, then download the biggest coding model that fits it.
  async function autoSetup() {
    if (settingUp) return { ok: false, error: 'Setup is already running.' };
    if (installing || pulling || current) return { ok: false, error: 'Wait for the current install or build to finish first.' };
    settingUp = true;
    const say = (s) => sendEvent({ type: 'setup', status: s });
    try {
      if (!(await ollama.isRunning()) && !(await ollama.findExe())) {
        say('Installing Ollama\u2026');
        const r = await installOllama();
        if (!r.ok) return r;
      }
      say('Starting Ollama\u2026');
      if (!(await ollama.ensureServer())) return { ok: false, error: 'Ollama did not start. Open it from the Start menu, then try again.' };
      say('Checking your graphics card\u2026');
      const gpu = await ollama.detectGpu();
      const have = (await ollama.listModels()).map((m) => m.name);
      const pick = core.pickModel(gpu && gpu.vramGB, have);
      if (!pick.installed) {
        say('Downloading ' + pick.model.tag + ' (' + pick.model.sizeGB + ' GB)\u2026');
        const r = await pull(pick.model.tag);
        if (!r.ok) return r;
      }
      return { ok: true, model: pick.model.tag, downloaded: !pick.installed, gpu };
    } finally { settingUp = false; sendEvent({ type: 'setup', done: true }); }
  }

  async function removeModel(name) {
    name = String(name || '').trim();
    if (!core.MODEL_NAME_RE.test(name)) return { ok: false, error: 'That model name is not valid.' };
    if (current) return { ok: false, error: 'Wait for the build to finish first.' };
    await ollama.remove(name);
    return { ok: true };
  }

  // ---------- builds ----------
  const cleanHosts = (h) => (Array.isArray(h) ? h.map((x) => String(x).trim().toLowerCase()).filter((x) => HOST_RE.test(x)).slice(0, 20) : []);

  function toast(r, job) {
    if (!deps.notify || r.status === 'stopped') return;                 // the person pressed Stop themselves: no need to tell them
    if (panelOpen && windowActive()) return;                            // they are looking at the result right now
    const name = r.name || job.name || botMode.botNameFrom(job.request);
    try {
      deps.notify(r.ok
        ? { title: 'Your bot is ready', body: `\u201C${name}\u201D passed its test (${r.attempts} attempt${r.attempts === 1 ? '' : 's'}). Open Settings > Developer to use it.`, tag: 'ai-build', target: 'ai', kind: 'info' }
        : { title: 'The AI stopped', body: String(r.summary || 'The build did not finish.').slice(0, 160), tag: 'ai-build', target: 'ai', kind: 'info' });
    } catch { /* a toast is a bonus */ }
  }

  // Starts (or continues) a build in the background and returns at once.
  async function begin(job, model, claim) {
    try {
      if (!(await ollama.ensureServer())) { current = null; return { ok: false, error: 'Ollama is not running. Install or start it first.' }; }
      const gpu = await ollama.detectGpu();
      const c = core.ctxFor(gpu && gpu.vramGB);
      job.model = model; job.status = 'running'; job.error = null;
      jobs.save(job);
      claim.jobId = job.id;
      const signal = claim.abort.signal;
      runBuild({
        job, jobs, lessons, runner: getRunner(), signal, snapshotCap: c.snapshotCap, emit: agentEmit(job.id), ensureServer: () => ollama.ensureServer(), sleep: deps.sleep,
        chat: (messages, o) => ollama.chat({ model, messages, numCtx: c.numCtx, numPredict: Math.min(Math.floor(c.numCtx / 2), Math.round(c.numPredict * (1 + 0.5 * ((o && o.meta && o.meta.cutoffs) || 0)))), signal, onToken: o && o.onToken, meta: o && o.meta }),
      }).then((r) => r, (e) => ({ ok: false, status: 'error', summary: 'Something went wrong: ' + errMsg(e), attempts: job.attempts.length, name: job.name }))
        .then((r) => {
          flushTokens();
          sendEvent({ type: 'agent', jobId: job.id, kind: 'finished', ok: !!r.ok, status: r.status, summary: r.summary, name: r.name || job.name, attempts: r.attempts, learned: r.learned || 0 });
          log.push({ type: 'agent', jobId: job.id, kind: 'finished', ok: !!r.ok, status: r.status, summary: r.summary, name: r.name || job.name, attempts: r.attempts, at: Date.now() });
          if (current === claim) current = null;
          toast(r, job);
        });
      return { ok: true, jobId: job.id };
    } catch (e) { if (current === claim) current = null; return { ok: false, error: errMsg(e) }; }
  }

  async function run(o) {
    if (current) return { ok: false, error: 'A build is already running.' };
    const request = String((o && o.request) || '').trim();
    const model = String((o && o.model) || '').trim();
    if (!request || request.length > 4000) return { ok: false, error: 'Describe the bot you want (up to 4000 characters).' };
    if (!core.MODEL_NAME_RE.test(model)) return { ok: false, error: 'Pick a model first.' };
    const claim = { jobId: null, abort: new AbortController() };
    current = claim;                                         // claimed now so a double click cannot start two builds
    const job = jobs.newJob({ request, model, fetchHosts: cleanHosts(o.fetchHosts) });
    return begin(job, model, claim);
  }

  async function resume(o) {
    if (current) return { ok: false, error: 'A build is already running.' };
    const id = String((o && o.id) || '');
    const job = ID_RE.test(id) ? jobs.load(id) : null;
    if (!job) return { ok: false, error: 'That build was not found.' };
    if (job.status === 'done') return { ok: false, error: 'That bot is already finished.' };
    const model = String((o && o.model) || job.model || '').trim();
    if (!core.MODEL_NAME_RE.test(model)) return { ok: false, error: 'Pick a model first.' };
    const claim = { jobId: job.id, abort: new AbortController() };
    current = claim;
    if (o && Array.isArray(o.fetchHosts)) job.fetchHosts = cleanHosts(o.fetchHosts);
    return begin(job, model, claim);
  }

  function stop() { if (current) current.abort.abort(); return { ok: true }; }

  // ---------- saved builds ----------
  const historyOf = (job) => job.attempts.map((a) => ({
    n: a.n, outcome: a.outcome, problem: a.problem || '', gap: (a.gaps && a.gaps[0]) || '', wrote: a.wrote || [], botAdded: a.botAdded || 0, botRemoved: a.botRemoved || 0,
    testAdded: a.testAdded || 0, testRemoved: a.testRemoved || 0, testsPassed: a.testsPassed || 0, testsTotal: a.testsTotal || 0, notes: a.notes || [],
  }));
  function getJob(id) {
    id = String(id || '');
    const job = ID_RE.test(id) ? jobs.load(id) : null;
    if (!job) return { ok: false, error: 'That build was not found.' };
    const code = job.bot || '';
    const bad = code ? botMode.codeProblem(code) : 'There is no code yet.';
    return {
      ok: true, running: !!(current && current.jobId === job.id),
      job: { id: job.id, request: job.request, status: job.status, model: job.model, error: job.error, hiccups: job.hiccups || 0, updatedAt: job.updatedAt, history: historyOf(job), fetchHosts: job.fetchHosts },
      use: bad ? null : {
        name: botMode.clipText(job.name || botMode.botNameFrom(job.request), botMode.LIMITS.name),
        description: botMode.clipText(job.summary || job.request, botMode.LIMITS.description),
        code, finished: job.status === 'done',
      },
    };
  }
  const listJobs = () => ({ ok: true, jobs: jobs.list(), running: current ? current.jobId : null });
  function deleteJob(id) {
    id = String(id || '');
    if (current && current.jobId === id) return { ok: false, error: 'Stop the build before deleting it.' };
    return { ok: jobs.remove(id) };
  }

  const handlers = {
    'ai:status': status, 'ai:auto-setup': autoSetup, 'ai:start-ollama': startOllama, 'ai:install-ollama': installOllama, 'ai:pull': pull, 'ai:remove': removeModel,
    'ai:cancel-pull': () => { if (pulling) pulling.abort.abort(); return { ok: true }; },
    'ai:run': run, 'ai:resume': resume, 'ai:stop': stop, 'ai:jobs': listJobs, 'ai:job': getJob, 'ai:delete-job': deleteJob,
    'ai:panel': (open) => { panelOpen = !!open; return { ok: true }; },
  };
  for (const [ch, fn] of Object.entries(handlers)) {
    deps.ipcMain.handle(ch, async (e, ...args) => {
      if (!deps.isTrusted(e)) return { ok: false, error: 'Not allowed.' };
      try { return await fn(...args); } catch (err) { return { ok: false, error: errMsg(err) }; }
    });
  }

  // The app is closing: the build stops after its last saved attempt and picks up from there next time.
  async function shutdown() {
    if (current) current.abort.abort();
    if (pulling) pulling.abort.abort();
    if (installing) installing.abort();
    if (runner) { try { await runner.stop(); } catch { /* closing anyway */ } }
  }

  return { handlers, shutdown, isBusy: () => !!current, _test: { jobs, lessons, getRunner } };
}

module.exports = { create };
