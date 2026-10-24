// The build loop: ask the model for code + a test, write the files, run the test, show the model the result, repeat until it passes.
'use strict';
const fs = require('fs');
const path = require('path');
const core = require('./core');

const OUTPUT_TAIL = 3000;

async function runAgent(o) {
  const fsx = o.fs || fs;
  const emit = o.emit || (() => {});
  const max = Math.min(Math.max(Number(o.maxIter) || 10, 1), 30);
  const aborted = () => !!(o.signal && o.signal.aborted);
  fsx.mkdirSync(o.dir, { recursive: true });

  let lastResult = '', lastPassed = null, passStreak = 0, empties = 0, attempts = 0;
  const end = (ok, summary) => ({ ok, summary, attempts });

  for (let i = 1; i <= max; i++) {
    if (aborted()) return end(false, 'Stopped.');
    attempts = i;
    emit({ kind: 'iter', n: i, max });
    const files = core.readProject(o.dir, fsx, o.snapshotCap || 12000);
    const messages = [
      { role: 'system', content: core.SYSTEM_PROMPT },
      { role: 'user', content: core.buildUserPrompt({ request: o.request, files, lastResult, passed: lastPassed, first: i === 1 }) },
    ];

    let text;
    try { text = await o.chat(messages, (t) => emit({ kind: 'token', text: t })); }
    catch (e) {
      if (aborted()) return end(false, 'Stopped.');
      return end(false, 'The model failed: ' + (e && e.message ? e.message : e));
    }
    if (aborted()) return end(false, 'Stopped.');

    const p = core.parseResponse(text);
    let wrote = 0;
    for (const f of p.files) {
      const abs = core.safeJoin(o.dir, f.path);
      if (!abs) { emit({ kind: 'note', text: 'Skipped a file with an unsafe path: ' + f.path }); continue; }
      fsx.mkdirSync(path.dirname(abs), { recursive: true });
      fsx.writeFileSync(abs, f.content);
      wrote++;
      emit({ kind: 'file', path: f.path, bytes: Buffer.byteLength(f.content) });
    }

    let ranOk = false;
    if (p.run) {
      const cmd = core.parseCommand(p.run);
      if (!cmd) {
        lastResult = `Command not allowed: ${p.run}\nUse a single "node <file>" (or "python <file>") command with no pipes, no && and no inline code.`;
        lastPassed = false;
        emit({ kind: 'note', text: 'Blocked a command: ' + p.run });
      } else {
        if (!o.autoRun && o.confirm && !(await o.confirm(p.run))) return end(false, 'Stopped: you declined to run the command.');
        if (aborted()) return end(false, 'Stopped.');
        emit({ kind: 'run', cmd: p.run });
        const r = await o.exec(cmd, o.dir, o.signal);
        if (aborted()) return end(false, 'Stopped.');
        ranOk = r.code === 0 && !r.timedOut;
        lastPassed = ranOk;
        lastResult = `$ ${p.run}\n` + (r.timedOut ? 'TIMED OUT (the program ran too long or waited for input)\n' : `exit code ${r.code}\n`) + core.tail(r.output, OUTPUT_TAIL);
        emit({ kind: 'result', ok: ranOk, code: r.code, timedOut: !!r.timedOut, output: core.tail(r.output, OUTPUT_TAIL) });
      }
    } else if (wrote) {
      lastPassed = null;
      lastResult = 'You changed files but did not run the tests. Include <run>node test.js</run>.';
    }

    if (p.done) {
      if (ranOk || (!wrote && !p.run && lastPassed === true)) return end(true, p.done);
      lastResult = (lastResult ? lastResult + '\n' : '') + 'You wrote <done> but the tests have not passed. Run them and fix any failure first.';
    }

    if (!wrote && !p.run && !p.done) {
      empties++;
      lastResult = 'Your reply did not follow the format. Reply only with <file path="...">...</file> blocks, one <run>...</run>, and <done>...</done> once tests pass.';
      if (empties >= 2) return end(false, 'The model is not following the build format. Try a larger model from the Models tab.');
    } else empties = 0;

    if (ranOk && !wrote) { if (++passStreak >= 2) return end(true, 'The tests pass.'); } else passStreak = 0;
  }
  return lastPassed === true
    ? end(true, 'The tests pass (stopped at the attempt limit before the AI confirmed it was finished).')
    : end(false, `Gave up after ${max} attempts and the last test still failed. Try a larger model, or make the request simpler.`);
}

module.exports = { runAgent };
