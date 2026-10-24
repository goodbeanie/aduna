// The "AI Coder" window: install an Ollama coding model with one click, then describe what you want and the AI writes it, tests it
// and keeps fixing it until the test passes. Everything runs on this PC; nothing is sent to the Aduna server.
'use strict';
const { BrowserWindow, ipcMain, shell, app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const core = require('./core');
// ADUNA_AI_TEST lets ai-window-test.js point this at a fake Ollama; it has no effect in the real app.
const ollama = require('./ollama').create(process.env.ADUNA_AI_TEST === '1' && process.env.ADUNA_OLLAMA_BASE ? { base: process.env.ADUNA_OLLAMA_BASE } : undefined);
const { runAgent } = require('./agent');

const TEST_TIMEOUT_MS = 30 * 1000;      // a test run that takes longer than this is killed and counted as failed
const OUTPUT_CAP = 20000;
let win = null;
let job = null;                          // the running build: { abort }
let pulling = null;                      // the running model download: { name, abort }
let installing = null;                   // the running Ollama install: AbortController
let project = null;                      // folder name of the current project (follow-up requests keep editing it)
let pendingConfirm = null;

const alive = () => !!win && !win.isDestroyed() && !win.webContents.isDestroyed();
const send = (d) => { if (alive()) win.webContents.send('ai:event', d); };
const errMsg = (e) => String((e && e.message) || e || 'Something went wrong.');
const projectsRoot = () => path.join(app.getPath('documents'), 'Aduna AI Projects');

// Model tokens arrive many times a second; send them to the window in small batches.
let tokBuf = '', tokTimer = null;
function flushTokens() { clearTimeout(tokTimer); tokTimer = null; if (tokBuf) { send({ type: 'agent', kind: 'token', text: tokBuf }); tokBuf = ''; } }
function agentEmit(d) {
  if (d.kind === 'token') { tokBuf += d.text; if (!tokTimer) tokTimer = setTimeout(flushTokens, 80); }
  else { flushTokens(); send(Object.assign({ type: 'agent' }, d)); }
}

// Runs one allowed command (see core.parseCommand) inside the project folder. "node" uses Aduna's own built-in Node, so nothing needs installing.
function execCommand(cmd, cwd, signal) {
  return new Promise((resolve) => {
    const isNode = cmd.exe === 'node';
    const env = Object.assign({}, process.env, isNode ? { ELECTRON_RUN_AS_NODE: '1' } : {});
    let out = '', finished = false, timedOut = false, child;
    const kill = () => {
      try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); else child.kill('SIGKILL'); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, TEST_TIMEOUT_MS);
    const onAbort = () => kill();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const done = (code, extra) => {
      if (finished) return; finished = true; clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code: code == null ? -1 : code, output: out + (extra || ''), timedOut });
    };
    try { child = spawn(isNode ? process.execPath : cmd.exe, cmd.args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return done(-1, 'Could not start ' + cmd.exe + ': ' + errMsg(e)); }
    const take = (d) => { if (out.length < OUTPUT_CAP) out += d.toString(); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.on('error', (e) => done(-1, 'Could not start ' + cmd.exe + ': ' + errMsg(e) + (isNode ? '' : ' (is it installed?)')));
    child.on('close', (code) => done(code));
  });
}

function askConfirm(cmd) {
  return new Promise((resolve) => { pendingConfirm = { resolve }; send({ type: 'agent', kind: 'confirm', cmd }); });
}

async function status() {
  const exe = await ollama.findExe();
  const running = await ollama.isRunning();
  let models = [];
  if (running) { try { models = await ollama.listModels(); } catch { /* shown as empty */ } }
  const gpu = await ollama.detectGpu();
  return {
    ok: true, platform: process.platform, ollama: { installed: !!exe || running, running }, models, gpu,
    ramGB: Math.round(os.totalmem() / 2 ** 30), catalog: core.MODELS, projectsRoot: projectsRoot(), project, busy: !!job,
  };
}

async function startOllama() { return (await ollama.ensureServer()) ? { ok: true } : { ok: false, error: 'Ollama did not start. Open it from the Start menu, then press Refresh.' }; }

async function installOllama() {
  if (installing) return { ok: false, error: 'Ollama is already installing.' };
  if (process.platform !== 'win32') { shell.openExternal('https://ollama.com/download'); return { ok: false, error: 'Opened the Ollama download page. Install it, then press Refresh.' }; }
  installing = new AbortController();
  try {
    await ollama.installOllama((p) => send({ type: 'ollama-install', status: p.status, pct: p.pct }), installing.signal);
    send({ type: 'ollama-install', status: 'Ollama is ready.', pct: 100, done: true });
    return { ok: true };
  } catch (e) { send({ type: 'ollama-install', status: errMsg(e), error: true, done: true }); return { ok: false, error: errMsg(e) }; }
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
    await ollama.pull(name, (p) => send({ type: 'pull', name, status: p.status, pct: p.pct }), mine.abort.signal);
    send({ type: 'pull-done', name, ok: true });
    return { ok: true };
  } catch (e) {
    const error = mine.abort.signal.aborted ? 'Cancelled.' : errMsg(e);
    send({ type: 'pull-done', name, ok: false, error });
    return { ok: false, error };
  } finally { if (pulling === mine) pulling = null; }
}

async function removeModel(name) {
  name = String(name || '').trim();
  if (!core.MODEL_NAME_RE.test(name)) return { ok: false, error: 'That model name is not valid.' };
  if (job) return { ok: false, error: 'Wait for the build to finish first.' };
  await ollama.remove(name);
  return { ok: true };
}

async function run(o) {
  if (job) return { ok: false, error: 'A build is already running.' };
  const request = String((o && o.request) || '').trim();
  const model = String((o && o.model) || '').trim();
  if (!request || request.length > 4000) return { ok: false, error: 'Describe what you want to build (up to 4000 characters).' };
  if (!core.MODEL_NAME_RE.test(model)) return { ok: false, error: 'Pick a model first.' };
  const mine = { abort: new AbortController() };
  job = mine;                                        // claimed now so a double-click can't start two builds
  const release = () => { if (job === mine) job = null; };
  try {
    if (!(await ollama.ensureServer())) { release(); return { ok: false, error: 'Ollama is not running. Install or start it on the Models tab.' }; }
    if (!project) project = core.projectName(request);
    const dir = path.join(projectsRoot(), project);
    const gpu = await ollama.detectGpu();
    const c = core.ctxFor(gpu && gpu.vramGB);
    send({ type: 'agent', kind: 'start', project, dir, model });
    runAgent({
      request, dir, maxIter: Number(o.maxIter) || 10, autoRun: o.autoRun !== false, signal: mine.abort.signal, snapshotCap: c.snapshotCap,
      chat: (messages, onToken) => ollama.chat({ model, messages, numCtx: c.numCtx, numPredict: c.numPredict, signal: mine.abort.signal, onToken }),
      exec: execCommand, emit: agentEmit, confirm: askConfirm,
    }).then((r) => { flushTokens(); send(Object.assign({ type: 'agent', kind: 'finished', project }, r)); })
      .catch((e) => { flushTokens(); send({ type: 'agent', kind: 'finished', ok: false, summary: 'Something went wrong: ' + errMsg(e), project }); })
      .finally(() => { release(); if (pendingConfirm) { pendingConfirm.resolve(false); pendingConfirm = null; } });
    return { ok: true, project };
  } catch (e) { release(); return { ok: false, error: errMsg(e) }; }
}

function stop() {
  if (job) job.abort.abort();
  if (pendingConfirm) { pendingConfirm.resolve(false); pendingConfirm = null; }
  return { ok: true };
}

async function openFolder() {
  const dir = project ? path.join(projectsRoot(), project) : projectsRoot();
  fs.mkdirSync(dir, { recursive: true });
  const err = await shell.openPath(dir);
  return err ? { ok: false, error: err } : { ok: true };
}

// Every call must come from the AI Coder window itself.
const guard = (fn) => async (e, ...args) => {
  if (!alive() || e.sender !== win.webContents) return { ok: false, error: 'Not allowed.' };
  try { return await fn(...args); } catch (err) { return { ok: false, error: errMsg(err) }; }
};
const handlers = {
  'ai:status': status, 'ai:start-ollama': startOllama, 'ai:install-ollama': installOllama, 'ai:pull': pull, 'ai:remove': removeModel,
  'ai:cancel-pull': () => { if (pulling) pulling.abort.abort(); return { ok: true }; },
  'ai:run': run, 'ai:stop': stop,
  'ai:confirm': (allow) => { if (pendingConfirm) { pendingConfirm.resolve(!!allow); pendingConfirm = null; } return { ok: true }; },
  'ai:new-project': () => { if (job) return { ok: false, error: 'Wait for the build to finish first.' }; project = null; return { ok: true }; },
  'ai:open-folder': openFolder,
};
for (const [ch, fn] of Object.entries(handlers)) ipcMain.handle(ch, guard(fn));

function openAiWindow(iconPath) {
  if (alive()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1000, height: 820, minWidth: 720, minHeight: 560, backgroundColor: '#ebe4d4', title: 'Aduna AI Coder', icon: iconPath, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'ai-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(({ url }) => { try { if (/^https:$/.test(new URL(url).protocol)) shell.openExternal(url); } catch { /* ignore */ } return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => {
    if (job) job.abort.abort();
    if (pulling) pulling.abort.abort();
    if (pendingConfirm) { pendingConfirm.resolve(false); pendingConfirm = null; }
    win = null;
  });
  win.loadFile(path.join(__dirname, 'ai.html'));
}

module.exports = { openAiWindow, _test: { execCommand, handlers } };
