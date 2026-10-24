// The build loop: ask the model for bot.js + test.js, run them in the QuickJS sandbox, show the model exactly what the bot did, repeat.
//  - No attempt cap. It ends when the test passes AND the goal is covered (every bot.on handler was triggered and the test asserts something),
//    when the person stops it, or when the model cannot be used at all (it is not installed).
//  - If Ollama hiccups (not running, crashed, out of memory for a moment) it waits, restarts it, and tries again.
//  - Every attempt is saved to disk (jobs.js) before the next one starts, so a build can be resumed after the app was closed.
//  - The model sees what each attempt changed, how it failed, and a bigger nudge each time the same error comes back (memory.js).
'use strict';
const botMode = require('./bot-mode');
const core = require('./core');
const memory = require('./memory');
const { lineDiff } = require('./diff');

const STOPPED = Object.assign(new Error('Stopped.'), { stopped: true });
const FATAL_RE = /model\s+['"]?[^'"]*['"]?\s+not found|try pulling it first|unknown model|invalid model|no such model|pull model manifest/i;

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(STOPPED);
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(STOPPED); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

const friendly = (m) => {
  m = String(m || '');
  if (/ECONNREFUSED|fetch failed|ECONNRESET|socket|terminated/i.test(m)) return 'Ollama is not answering';
  if (/memory|alloc|CUDA|VRAM/i.test(m)) return 'Ollama ran out of memory';
  return m.slice(0, 120) || 'Ollama had a problem';
};

function filePart(name, text, cap) {
  if (!text) return `--- ${name} --- (does not exist yet)`;
  const per = Math.max(2000, Math.floor(cap / 2.2));
  return text.length > per ? `--- ${name} (TRUNCATED: rewrite this file completely if you change it) ---\n${text.slice(0, per)}` : `--- ${name} ---\n${text}`;
}

function hiddenPart(name) { return `--- ${name} --- (hidden on purpose: your last replies kept sending the same files back, which fixes nothing. Write a NEW, complete ${name} from the request and the failing result below. Do not try to remember the old one.)`; }

function buildPrompt({ job, cap, lessonsText, memoryText, lastDetail, hint, notes, mode, stuck = 0 }) {
  // After 2 identical replies in a row the model is not shown one of its files, so it cannot just copy it back.
  // It alternates: bot.js first, then test.js (the test may be the wrong one), then bot.js again...
  const hide = stuck >= 2 && mode === 'fix' ? (stuck % 2 === 0 ? 'bot.js' : 'test.js') : '';
  const part = (name, text) => (hide === name ? hiddenPart(name) : filePart(name, text, cap));
  const parts = ['REQUEST:\n' + job.request, '', 'YOUR CURRENT FILES:\n' + part('bot.js', job.bot) + '\n' + part('test.js', job.test)];
  if (lessonsText) parts.push('', lessonsText);
  if (memoryText) parts.push('', memoryText);
  if (lastDetail) parts.push('', 'RESULT OF YOUR LAST ATTEMPT:\n' + lastDetail);
  if (hint) parts.push('', 'HINT: ' + hint);
  if (notes.length) parts.push('', 'NOTES:\n- ' + notes.join('\n- '));
  parts.push('');
  parts.push(mode === 'first' ? 'Write bot.js and test.js for this request.'
    : mode === 'finish' ? 'The test passed and everything is covered. If the request is now fully satisfied, reply with only <name> and <done> blocks. If anything is missing, add it, extend the test, and reply with the files.'
      : mode === 'cover' ? 'The test passes, but it is not finished yet (see above). Extend test.js so every handler is triggered and checked, then reply with the files.'
        : hide ? `You sent the same files back ${stuck} times in a row, so nothing changed. Write a NEW complete ${hide} that is clearly different from before and fixes the failing result above. Reply with ${hide}.`
          : 'Fix the problem, then reply with the changed files.');
  return parts.join('\n');
}

async function runBuild(o) {
  const job = o.job, emit = o.emit || (() => {}), sleep = o.sleep || abortableSleep;
  const aborted = () => !!(o.signal && o.signal.aborted);
  const cap = o.snapshotCap || 12000;
  const system = botMode.systemPrompt({ fetchHosts: job.fetchHosts });
  const save = () => { try { o.jobs.save(job); } catch (e) { emit({ kind: 'note', text: 'Could not save progress to disk: ' + (e && e.message) }); } };
  const last = () => job.attempts[job.attempts.length - 1] || null;

  const stop = () => { job.status = 'stopped'; save(); return { ok: false, status: 'stopped', summary: 'Stopped. You can pick this build up again later.', attempts: job.attempts.length, name: job.name }; };
  const fail = (msg) => { job.status = 'error'; job.error = msg; save(); return { ok: false, status: 'error', summary: msg, attempts: job.attempts.length, name: job.name }; };

  async function chatRetry(messages, meta) {
    for (let tries = 0; ; tries++) {
      if (aborted()) throw STOPPED;
      try { return await o.chat(messages, { onToken: (t) => emit({ kind: 'token', text: t }), meta }); }
      catch (e) {
        if (aborted()) throw STOPPED;
        const msg = String((e && e.message) || e);
        if (FATAL_RE.test(msg)) throw Object.assign(new Error(msg), { fatal: true });
        job.hiccups = (job.hiccups || 0) + 1;
        const seconds = Math.min(60, 3 * 2 ** Math.min(tries, 5));
        emit({ kind: 'wait', reason: friendly(msg), seconds, tries: tries + 1 });
        if (o.ensureServer) { try { await o.ensureServer(); } catch { /* the next try finds out */ } }
        await sleep(seconds * 1000, o.signal);
        emit({ kind: 'reset' });
      }
    }
  }

  // The sandbox itself having a bad moment is not the model's fault: try again, a few times.
  async function testRun() {
    for (let tries = 0; ; tries++) {
      const r = await o.runner.run({ botCode: job.bot, testCode: job.test, fetchHosts: job.fetchHosts });
      if (r.sandboxMissing) throw Object.assign(new Error(r.error || 'The bot sandbox is not available.'), { fatal: true });
      if (r.error === 'The bot sandbox crashed' || /sandbox failed/.test(r.error || '')) {
        if (tries >= 2) throw Object.assign(new Error('The bot sandbox keeps crashing: ' + r.error), { fatal: true });
        await sleep(1000, o.signal); continue;
      }
      return r;
    }
  }

  emit({ kind: 'start', jobId: job.id, resumed: job.attempts.length > 0 });
  job.status = 'running'; job.error = null; save();

  let lastDetail = last() ? last().detail || '' : '';
  let lastHint = '';
  let lastProblem = last() && last().outcome !== 'passed' ? last().problem : '';
  let lastPassedCovered = !!(last() && last().outcome === 'passed');
  let carry = last() && last().notes ? [] : [];

  for (;;) {
    try {
      if (aborted()) return stop();
      const prev = last();
      const n = job.attempts.length + 1;
      const t0 = Date.now();
      emit({ kind: 'attempt', n });
      const lessons = o.lessons ? o.lessons.relevant({ request: job.request, problem: lastProblem, limit: 3 }) : [];
      const mode = !prev ? 'first' : lastPassedCovered ? 'finish' : prev.outcome === 'incomplete' ? 'cover' : 'fix';
      const stuck = memory.stuck(job.attempts);
      const messages = [
        { role: 'system', content: system },
        { role: 'user', content: buildPrompt({ job, cap, lessonsText: o.lessons ? o.lessons.render(lessons) : '', memoryText: memory.render(job.attempts), lastDetail, hint: lastHint, notes: carry, mode, stuck }) },
      ];
      carry = [];

      // after cut-off replies the model is allowed a longer reply next time (the service reads meta.cutoffs)
      // the more often it repeats itself, the more it is allowed to vary (the service passes meta.temperature to the model)
      const cold = Math.max(stuck, memory.repeats(job.attempts) - 2, 0);
      const meta = { cutoffs: job.attempts.slice(-3).filter((a) => a.outcome === 'cutoff' || (a.notes || []).includes('reply was cut off')).length, temperature: Math.min(0.9, 0.2 + 0.15 * cold) };
      const text = await chatRetry(messages, meta);
      if (aborted()) throw STOPPED;
      const p = botMode.parseReply(text, meta);
      const notes = [];
      const wrote = [];
      let botDiff = { text: '', added: 0, removed: 0 }, testDiff = { text: '', added: 0, removed: 0 }, changed = false;
      if (p.files['bot.js'] !== undefined) { wrote.push('bot.js'); botDiff = lineDiff(job.bot, p.files['bot.js']); if (!botDiff.same) changed = true; job.bot = p.files['bot.js']; }
      if (p.files['test.js'] !== undefined) { wrote.push('test.js'); testDiff = lineDiff(job.test, p.files['test.js']); if (!testDiff.same) changed = true; job.test = p.files['test.js']; }
      for (const f of p.ignored) emit({ kind: 'note', text: `Ignored a file called ${f}: only bot.js and test.js are used.` });
      if (p.cutOff) { notes.push('reply was cut off'); carry.push('Your last reply was cut off before it ended' + (wrote.length ? ', so one file may be missing.' : ', so nothing was saved.') + ' Write shorter, simpler code and leave out anything the request does not need.'); emit({ kind: 'note', text: 'The model\'s reply was cut off.' }); }
      if (wrote.length) emit({ kind: 'files', wrote, botAdded: botDiff.added, botRemoved: botDiff.removed, testAdded: testDiff.added, testRemoved: testDiff.removed });

      const base = { n, at: Date.now(), wrote, botDiff: botDiff.text, testDiff: testDiff.text, botAdded: botDiff.added, botRemoved: botDiff.removed, testAdded: testDiff.added, testRemoved: testDiff.removed, unchanged: !changed, notes, assertions: 0, testsTotal: 0, testsPassed: 0, covered: false, gaps: [] };
      const record = (extra) => { job.attempts.push({ ...base, ms: Date.now() - t0, ...extra }); save(); };

      // a reply with no files and no <done>, or files missing so nothing can run
      if (!wrote.length && !p.done) {
        const why = p.cutOff ? 'cutoff' : 'format';
        const problem = p.cutOff ? 'the reply was cut off before any file was complete' : 'the reply did not follow the required format';
        record({ outcome: why, stage: 'format', problem, sig: memory.signature(problem), detail: problem });
        if (!p.cutOff) carry.push('Your reply did not follow the format. Reply only with <file path="bot.js">...</file> and <file path="test.js">...</file> blocks (and <name> and <done> once the test passes).');
        lastProblem = lastProblem || problem; // keep showing the error that was being fixed: a cut-off or badly formatted reply did not change it
        const formats = job.attempts.slice(-3).filter((a) => a.outcome === 'format').length;
        if (formats >= 3) emit({ kind: 'hint', text: 'The model keeps ignoring the reply format. A larger model usually follows it better.' });
        emit({ kind: 'result', n, ok: false, passed: false, problem, gaps: [], eta: memory.estimate(job.attempts) });
        continue;
      }
      if (!job.bot.trim() || !job.test.trim()) {
        const need = !job.bot.trim() ? 'bot.js' : 'test.js';
        const problem = `${need} does not exist yet`;
        record({ outcome: 'format', stage: 'format', problem, sig: memory.signature(problem), detail: problem });
        carry.push(`${need} is missing. Write both bot.js and test.js.`);
        lastDetail = ''; lastHint = ''; lastProblem = problem; lastPassedCovered = false;
        emit({ kind: 'result', n, ok: false, passed: false, problem, gaps: [], eta: memory.estimate(job.attempts) });
        continue;
      }
      if (p.done && !wrote.length && last() && last().outcome === 'passed') {
        // the model confirms the files that already passed
        return finish(p, null);
      }

      emit({ kind: 'testing', n });
      const r = await testRun();
      if (aborted()) throw STOPPED;

      const passedTests = r.ok;
      const gaps = passedTests ? memory.gapsOf(r) : [];
      let codeBad = passedTests && !gaps.length ? botMode.codeProblem(job.bot) : null;
      const passed = passedTests && !gaps.length && !codeBad;
      const problem = passed ? '' : codeBad || memory.problemOf(r) || 'the test did not pass';
      const outcome = passed ? 'passed' : passedTests ? 'incomplete' : 'failed';
      const stage = passed ? '' : codeBad ? 'bot' : memory.stageOf(r);
      const tests = r.tests || [];
      const attempt = { outcome, stage, problem, sig: passed ? '' : memory.signature(problem), detail: memory.detailOf(r), assertions: r.assertions || 0, testsTotal: tests.length, testsPassed: tests.filter((t) => t.ok).length, covered: !!r.covered && passed, gaps: codeBad ? [codeBad] : gaps };
      const weak = memory.weakened(prev, attempt);
      if (weak) { notes.push('test made weaker'); carry.push(weak.text); emit({ kind: 'hint', text: weak.text }); }
      if (!changed && wrote.length && prev && prev.outcome !== 'passed') { notes.push('same code again'); carry.push('You sent exactly the same code as the attempt before, so nothing changed. Change something that addresses the problem.'); }
      record(attempt);

      lastDetail = attempt.detail; lastHint = passed ? '' : memory.diagnose(r); lastProblem = passed ? '' : problem; lastPassedCovered = passed;
      if (lastHint) emit({ kind: 'hint', text: lastHint });
      emit({ kind: 'result', n, ok: passedTests, passed, problem, gaps: attempt.gaps, testsPassed: attempt.testsPassed, testsTotal: attempt.testsTotal, assertions: attempt.assertions, detail: core.tail(attempt.detail, 1800), activity: (r.activity || []).slice(-6), eta: memory.estimate(job.attempts) });

      if (p.done) {
        if (passed) return finish(p, r);
        carry.push('You wrote <done> but the build is not finished: ' + (gaps[0] || codeBad || problem) + ' Fix that first.');
      } else if (passed && prev && prev.outcome === 'passed' && !changed) {
        return finish(p, r); // it passed twice in a row with nothing changed: nothing is left to do
      }
    } catch (e) {
      if (e === STOPPED || (e && e.stopped) || aborted()) return stop();
      if (e && e.fatal) return fail(e.message);
      return fail('Something went wrong: ' + String((e && e.message) || e));
    }
  }

  function finish(p) {
    job.status = 'done';
    job.name = botMode.clipText(p.name || job.name || botMode.botNameFrom(job.request), botMode.LIMITS.name);
    job.summary = botMode.clipText(p.done || job.summary || 'A bot built from your request.', botMode.LIMITS.description);
    let learned = 0;
    try { if (o.lessons && !job.learned) { learned = o.lessons.learnFromJob(job); job.learned = true; } } catch { /* lessons are a bonus */ }
    save();
    return { ok: true, status: 'done', summary: job.summary, name: job.name, attempts: job.attempts.length, learned };
  }
}

module.exports = { runBuild, buildPrompt, abortableSleep, STOPPED, FATAL_RE };
