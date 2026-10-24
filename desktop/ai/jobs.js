// Build jobs on disk: the request, the current bot.js and test.js, and EVERY attempt, saved after each attempt so a build can be resumed
// after the app was closed. One JSON file per job in `dir`, written atomically (write a temp file, then rename), so a crash never leaves half a file.
// Pure logic with an injected `fs`.
'use strict';
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^[a-z0-9]{6,40}$/;
const KEEP_FULL = 150;        // older attempts keep their one-line story but lose the long text
const KEEP_JOBS = 25;

function createJobStore({ dir, fs = require('fs'), now = Date.now }) {
  const fileOf = (id) => path.join(dir, id + '.json');

  function newJob({ request, model, fetchHosts }) {
    const t = now();
    return {
      v: 1, id: t.toString(36) + crypto.randomBytes(4).toString('hex'), createdAt: t, updatedAt: t,
      request: String(request || ''), model: String(model || ''), fetchHosts: Array.isArray(fetchHosts) ? fetchHosts.slice(0, 20) : [],
      status: 'running', summary: '', name: '', bot: '', test: '', attempts: [], hiccups: 0, error: null, learned: false,
    };
  }

  function save(job) {
    job.updatedAt = now();
    const att = job.attempts;
    if (att.length > KEEP_FULL) for (let i = 0; i < att.length - KEEP_FULL; i++) { const a = att[i]; if (a.detail || a.botDiff || a.testDiff) { a.detail = ''; a.botDiff = ''; a.testDiff = ''; } }
    fs.mkdirSync(dir, { recursive: true });
    const tmp = fileOf(job.id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(job));
    fs.renameSync(tmp, fileOf(job.id));
  }

  function load(id) {
    if (!ID_RE.test(String(id))) return null;
    try {
      const j = JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
      if (!j || j.id !== id || !Array.isArray(j.attempts)) return null;
      return j;
    } catch { return null; }
  }

  // Newest first. Corrupt files are skipped.
  function list() {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const j = load(n.slice(0, -5));
      if (j) out.push({ id: j.id, request: j.request, status: j.status, attempts: j.attempts.length, updatedAt: j.updatedAt, createdAt: j.createdAt, name: j.name, summary: j.summary, model: j.model, hasBot: !!j.bot });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function remove(id) { if (!ID_RE.test(String(id))) return false; try { fs.unlinkSync(fileOf(id)); return true; } catch { return false; } }

  // A job still marked "running" when the app starts was cut off by the app closing: make it resumable.
  function markInterrupted() {
    let n = 0;
    for (const s of list()) if (s.status === 'running') { const j = load(s.id); if (j) { j.status = 'stopped'; save(j); n++; } }
    return n;
  }

  // Keeps the newest jobs (the unfinished and the done alike); the rest go.
  function prune(max = KEEP_JOBS) { for (const s of list().slice(max)) remove(s.id); }

  return { newJob, save, load, list, remove, markInterrupted, prune, dir };
}

module.exports = { createJobStore, ID_RE };
