// Talks to Ollama on this PC (http://127.0.0.1:11434): find/install/start it, list/download/remove models, chat, detect the graphics card.
// No Electron in here so it can be tested against a fake server.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const DEFAULT_BASE = 'http://127.0.0.1:11434';
const INSTALLER_URL = 'https://ollama.com/download/OllamaSetup.exe'; // the official Windows installer

function create(opts) {
  const base = (opts && opts.base) || DEFAULT_BASE;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function getJson(p, ms) {
    const res = await fetch(base + p, { signal: AbortSignal.timeout(ms || 4000) });
    if (!res.ok) throw new Error(await errText(res));
    return res.json();
  }
  async function errText(res) {
    let t = ''; try { t = await res.text(); } catch { /* ignore */ }
    try { const j = JSON.parse(t); if (j && j.error) return String(j.error); } catch { /* not json */ }
    return t.slice(0, 300) || `Ollama answered ${res.status}`;
  }
  // Reads a newline-delimited JSON stream and calls onObj for each line.
  async function ndjson(res, onObj) {
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onObj(JSON.parse(line)); }
    }
    if (buf.trim()) onObj(JSON.parse(buf));
  }

  async function isRunning() { try { await getJson('/api/version', 1500); return true; } catch { return false; } }

  function findExe() {
    return new Promise((resolve) => {
      const c = [];
      if (process.env.LOCALAPPDATA) c.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'));
      if (process.env.ProgramFiles) c.push(path.join(process.env.ProgramFiles, 'Ollama', 'ollama.exe'));
      const hit = c.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
      if (hit) return resolve(hit);
      execFile(process.platform === 'win32' ? 'where' : 'which', ['ollama'], { windowsHide: true, timeout: 4000 }, (err, out) => {
        const first = !err && String(out || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
        resolve(first || null);
      });
    });
  }

  // Makes sure the Ollama server is answering; starts it if it is installed but not running.
  async function ensureServer(waitMs) {
    if (await isRunning()) return true;
    const exe = await findExe();
    if (!exe) return false;
    try { const c = spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }); c.on('error', () => {}); c.unref(); } catch { return false; }
    const until = Date.now() + (waitMs || 20000);
    while (Date.now() < until) { if (await isRunning()) return true; await sleep(500); }
    return false;
  }

  async function listModels() {
    const j = await getJson('/api/tags');
    return (j.models || []).map((m) => ({ name: m.name, sizeGB: Math.round((m.size || 0) / 1e8) / 10 }));
  }

  // Downloads a model. onProgress({status, pct}) with pct summed over every layer seen so far.
  async function pull(name, onProgress, signal) {
    const res = await fetch(base + '/api/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name, name, stream: true }), signal });
    if (!res.ok) throw new Error(await errText(res));
    const layers = new Map(); let ok = false;
    await ndjson(res, (o) => {
      if (o.error) throw new Error(String(o.error));
      if (o.digest && o.total) layers.set(o.digest, { total: o.total, completed: o.completed || 0 });
      let t = 0, c = 0; for (const l of layers.values()) { t += l.total; c += l.completed; }
      if (o.status === 'success') ok = true;
      onProgress({ status: String(o.status || ''), pct: t ? Math.min(100, (c / t) * 100) : null });
    });
    if (!ok) throw new Error('The download ended early. Try again.');
  }

  async function remove(name) {
    const res = await fetch(base + '/api/delete', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name, name }) });
    if (!res.ok) throw new Error(await errText(res));
  }

  // Streams a chat reply; returns the full text. When the reply stopped because it hit the length limit, meta.truncated is set to true
  // (Ollama says so with done_reason "length"), so the caller knows the last file may be unfinished.
  async function chat({ model, messages, numCtx, numPredict, signal, onToken, meta }) {
    const res = await fetch(base + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ model, messages, stream: true, options: { num_ctx: numCtx, num_predict: numPredict, temperature: 0.2 } }),
    });
    if (!res.ok) throw new Error(await errText(res));
    let full = '';
    await ndjson(res, (o) => {
      if (o.error) throw new Error(String(o.error));
      const t = o.message && o.message.content;
      if (t) { full += t; if (onToken) onToken(t); }
      if (meta && o.done && o.done_reason === 'length') meta.truncated = true;
    });
    return full;
  }

  // Downloads the official installer from ollama.com and runs it quietly, then starts the server. Windows only.
  async function installOllama(onProgress, signal) {
    if (process.platform !== 'win32') throw new Error('Automatic install is only available on Windows. Install Ollama from https://ollama.com/download');
    const dest = path.join(os.tmpdir(), 'OllamaSetup.exe');
    onProgress({ status: 'Downloading the Ollama installer\u2026', pct: 0 });
    const res = await fetch(INSTALLER_URL, { signal, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error('Could not download Ollama (' + res.status + '). Check your connection.');
    const total = Number(res.headers.get('content-length')) || 0;
    const ws = fs.createWriteStream(dest); let got = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        await new Promise((r, j) => ws.write(value, (e) => (e ? j(e) : r())));
        onProgress({ status: 'Downloading the Ollama installer\u2026', pct: total ? (got / total) * 100 : null });
      }
    } finally { await new Promise((r) => ws.end(r)); }
    if (total && got !== total) throw new Error('The installer download was incomplete. Try again.');
    onProgress({ status: 'Installing Ollama\u2026', pct: null });
    await new Promise((resolve, reject) => {
      const c = spawn(dest, ['/SILENT', '/NORESTART', '/SUPPRESSMSGBOXES'], { windowsHide: false });
      const onAbort = () => { try { c.kill(); } catch { /* gone */ } };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      c.on('error', reject);
      c.on('close', (code) => (code === 0 ? resolve() : reject(new Error('The Ollama installer stopped with code ' + code + '.'))));
    });
    onProgress({ status: 'Starting Ollama\u2026', pct: null });
    if (!(await ensureServer(30000))) throw new Error('Ollama installed but did not start. Open Ollama from the Start menu, then press Refresh.');
    try { fs.unlinkSync(dest); } catch { /* temp file, not critical */ }
  }

  // Video memory in GB, or null if it can't be read. NVIDIA first (exact), then the Windows registry (works for AMD / Intel Arc).
  let gpuCache; // undefined = not tried yet
  function detectGpu() {
    if (opts && opts.gpu !== undefined) return Promise.resolve(opts.gpu); // tests pass a fixed card
    if (gpuCache !== undefined) return Promise.resolve(gpuCache);
    const run = (file, args) => new Promise((res) => execFile(file, args, { windowsHide: true, timeout: 8000 }, (err, out) => res(err ? '' : String(out || ''))));
    return (async () => {
      let best = null;
      const consider = (name, mb) => { if (mb > 0 && (!best || mb > best.vramMB)) best = { name: String(name).trim(), vramMB: mb }; };
      for (const line of (await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'])).split(/\r?\n/)) {
        const m = /^(.+),\s*(\d+)\s*$/.exec(line.trim()); if (m) consider(m[1], Number(m[2]));
      }
      if (!best && process.platform === 'win32') {
        const ps = "Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | Where-Object { $_.'HardwareInformation.qwMemorySize' } | ForEach-Object { $_.DriverDesc + '|' + $_.'HardwareInformation.qwMemorySize' }";
        for (const line of (await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps])).split(/\r?\n/)) {
          const m = /^(.+)\|(\d+)\s*$/.exec(line.trim()); if (m) consider(m[1], Math.round(Number(m[2]) / 1048576));
        }
      }
      gpuCache = best ? { name: best.name, vramGB: Math.round((best.vramMB / 1024) * 10) / 10 } : null;
      return gpuCache;
    })();
  }

  return { base, isRunning, findExe, ensureServer, listModels, pull, remove, chat, installOllama, detectGpu, _ndjson: ndjson };
}

module.exports = { create };
