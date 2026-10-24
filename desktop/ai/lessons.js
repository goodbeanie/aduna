// What the AI learned from its own mistakes, kept on disk between builds.
// When a bot finally passes, every earlier error of that build that was then fixed becomes a lesson: the error, and the change that fixed it.
// Lessons that fit a new request (or the error it is stuck on) are shown to the model before it starts.
// Pure logic with an injected `fs`, so it is tested without Electron.
'use strict';
const path = require('path');

const MAX_LESSONS = 200, PER_JOB = 6, FIX_CHARS = 520;
const clip = (s, n) => { s = String(s == null ? '' : s).trim(); return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; };
const STOP = new Set('that with from this have your what when then they them will would could should about into over such each also only more most make made want needs need like just does done than very some other which their there these those where while using used uses code'.split(' '));

function tokens(s) {
  const out = new Set();
  for (const w of String(s || '').toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 4 && !STOP.has(w)) out.add(w.length > 4 ? w.replace(/s$/, '') : w); // "votes" and "vote" are the same word
  return out;
}
const overlap = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };

function createLessons({ file, fs = require('fs'), now = Date.now }) {
  let list = null;
  function load() {
    if (list) return list;
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); list = Array.isArray(j.lessons) ? j.lessons.filter((l) => l && typeof l.sig === 'string' && typeof l.fix === 'string') : []; }
    catch { list = []; }
    return list;
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, lessons: load() }));
      fs.renameSync(tmp, file);
    } catch { /* lessons are a bonus: never break a build over them */ }
  }
  const all = () => load().slice();

  function add(l) {
    const items = load();
    const have = items.find((x) => x.sig === l.sig);
    const t = now();
    if (have) { have.seen = (have.seen || 1) + 1; have.fix = l.fix; have.problem = l.problem; have.tags = l.tags; have.lastAt = t; }
    else items.push({ sig: l.sig, problem: l.problem, fix: l.fix, stage: l.stage || '', tags: l.tags, seen: 1, createdAt: t, lastAt: t });
    if (items.length > MAX_LESSONS) { items.sort((a, b) => ((b.seen || 1) * 1e13 + b.lastAt) - ((a.seen || 1) * 1e13 + a.lastAt)); items.length = MAX_LESSONS; }
  }

  // Called once when a build has passed. Returns how many lessons it kept.
  function learnFromJob(job) {
    if (!job || job.status !== 'done') return 0;
    const at = job.attempts || [], found = new Map();
    for (let i = 0; i < at.length - 1; i++) {
      const a = at[i];
      if (!a.sig || a.outcome === 'passed' || a.outcome === 'format' || a.outcome === 'cutoff' || a.stage === 'sandbox') continue;
      // The fix is the next attempt that actually changed code: replies in the wrong format or cut off wrote nothing, so look past them.
      let j = i + 1;
      while (j < at.length - 1 && (at[j].outcome === 'format' || at[j].outcome === 'cutoff')) j++;
      const next = at[j];
      if (next.outcome === 'format' || next.outcome === 'cutoff' || next.sig === a.sig) continue; // not fixed yet
      const fix = next.botDiff ? next.botDiff : next.testDiff ? 'test.js:\n' + next.testDiff : '';
      if (!fix) continue;
      found.set(a.sig, { sig: a.sig, problem: clip(a.problem, 180), fix: clip(fix, FIX_CHARS), stage: a.stage });
    }
    const picked = [...found.values()].sort((x, y) => (y.stage === 'bot' || y.stage === 'assert' ? 1 : 0) - (x.stage === 'bot' || x.stage === 'assert' ? 1 : 0)).slice(0, PER_JOB);
    // the request's own words come first, so a later request that sounds like this one finds the lesson
    const asked = [...tokens(job.request)];
    for (const l of picked) add({ ...l, tags: [...new Set([...asked, ...tokens(l.problem), ...tokens(l.fix)])].slice(0, 16) });
    if (picked.length) save();
    return picked.length;
  }

  // The lessons that fit this request (and, when the build is stuck, this error).
  function relevant({ request, problem, limit = 3 }) {
    const req = tokens(request), prob = tokens(problem);
    const sig = problem ? require('./memory').signature(problem) : null;
    return load().map((l) => {
      const tags = new Set(l.tags || []);
      const score = overlap(req, tags) * 2 + overlap(prob, tags) * 3 + (sig && l.sig === sig ? 10 : 0) + (l.seen >= 3 ? 2 : 0) + Math.min(l.seen || 1, 5) * 0.2;
      return { l, score };
    }).filter((x) => x.score >= 3).sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.l);
  }

  function render(items) {
    if (!items.length) return '';
    return 'LESSONS FROM YOUR EARLIER BUILDS (mistakes you made before, and the change that fixed each):\n' + items.map((l) => `- Error: ${l.problem}\n  Fix:\n  ${String(l.fix).split('\n').join('\n  ')}`).join('\n');
  }

  return { all, add, save, learnFromJob, relevant, render };
}

module.exports = { createLessons, tokens };
