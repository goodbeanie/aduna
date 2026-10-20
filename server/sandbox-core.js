// The part that runs INSIDE a worker thread (sandbox-worker.js): one bot event in QuickJS. Do not call it on the main thread: a regex
// bomb is not interruptible in QuickJS, so the host (sandbox.js) runs this in a worker and kills the worker if it overruns.
//
// How a bot stays contained:
//  - A fresh QuickJS runtime per event: nothing a bot does in one event is there in the next.
//  - Hard limits: memory (setMemoryLimit), stack depth, one wall-clock budget for the event (an interrupt handler stops `while (true) {}`),
//    at most maxActions messages, maxLogs log lines, clipped text.
//  - The only door out is ONE host function, __emit(kind, jsonString), which the shim captures and deletes from the global scope.
//    Everything crossing the border is a string we parse ourselves and re-validate; no live host objects ever enter the VM.
//  - The bot only gets bot.on / bot.send / bot.reply / bot.log. What an action may DO is decided by the caller (installed in that
//    server? rate limits?); this file only collects them.
const LIMITS = { memoryBytes: 16 * 1024 * 1024, stackBytes: 512 * 1024, ms: 100, maxActions: 5, maxText: 2000, maxLogs: 20, maxLogChars: 300, maxJobs: 2000, maxEventBytes: 64 * 1024 };

function loadLib() {
  for (const name of ['quickjs-emscripten', '@tootallnate/quickjs-emscripten']) { try { return require(name); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; } }
  throw Object.assign(new Error('The bot sandbox is not installed (npm install quickjs-emscripten)'), { code: 'SANDBOX_MISSING' });
}

// Runs inside the VM before the bot's code. `post` is the only host function; it is removed from the global scope straight away.
const SHIM = `(() => {
  const post = globalThis.__emit; delete globalThis.__emit;
  const handlers = Object.create(null);
  const str = (v) => { if (typeof v === 'string') return v; try { const j = JSON.stringify(v); return j === undefined ? String(v) : j; } catch (e) { return String(v); } };
  const bot = Object.freeze({
    on(event, fn) { if (typeof event !== 'string' || typeof fn !== 'function') throw new TypeError('bot.on(eventName, function)'); (handlers[event] = handlers[event] || []).push(fn); },
    send(channelId, text) { post('send', JSON.stringify({ channelId: str(channelId), text: str(text) })); },
    reply(message, text) { post('send', JSON.stringify({ channelId: str(message && message.channelId), text: str(text), replyTo: message && message.id ? str(message.id) : null })); },
    log() { post('log', Array.prototype.map.call(arguments, str).join(' ')); },
  });
  const fail = (e) => post('error', e && e.message !== undefined ? String(e.name || 'Error') + ': ' + String(e.message) : str(e));
  globalThis.__start = (fn) => { try { fn(bot); } catch (e) { fail(e); } };
  globalThis.__dispatch = (event, json) => {
    let payload; try { payload = JSON.parse(json); } catch (e) { return; }
    for (const h of (handlers[event] || []).slice()) {
      try { const r = h(payload); if (r && typeof r.then === 'function') r.then(undefined, fail); } catch (e) { fail(e); }
    }
  };
})();`;

const clip = (s, n) => String(s ?? '').slice(0, n);

// run(lib, q, { code, event, payload }, limits?) -> { ok, actions: [{ channelId, text, replyTo }], logs: [string], error, timedOut, ms, retire }
// `ok` is false when the code failed to load, threw, ran out of time or memory; actions sent before that moment are still returned.
// `retire` = the QuickJS module may be in a bad state (out of memory, failed cleanup): the worker must be replaced.
function runCore(lib, q, { code, event, payload }, limits = {}) {
  const L = { ...LIMITS, ...limits };
  const out = { ok: true, actions: [], logs: [], error: null, timedOut: false, ms: 0, retire: false };
  const json = JSON.stringify(payload === undefined ? null : payload);
  if (typeof event !== 'string' || !/^[a-z][a-z0-9:._-]{0,40}$/i.test(event)) return { ...out, ok: false, error: 'Bad event name' };
  if (Buffer.byteLength(json) > L.maxEventBytes) return { ...out, ok: false, error: 'Event too large' };

  const started = Date.now();
  const deadline = started + L.ms;
  const rt = q.newRuntime();
  let vm = null;
  try {
    rt.setMemoryLimit(L.memoryBytes);
    rt.setMaxStackSize(L.stackBytes);
    rt.setInterruptHandler(lib.shouldInterruptAfterDeadline(deadline));
    vm = rt.newContext();

    const emit = vm.newFunction('__emit', (kindH, textH) => {
      const kind = vm.getString(kindH), text = vm.getString(textH); // plain strings only
      if (kind === 'send') {
        if (out.actions.length >= L.maxActions) return;
        let a; try { a = JSON.parse(text); } catch { return; }
        if (!a || typeof a.channelId !== 'string' || typeof a.text !== 'string') return;
        const t = clip(a.text, L.maxText);
        if (!t.trim()) return;
        out.actions.push({ channelId: clip(a.channelId, 64), text: t, replyTo: typeof a.replyTo === 'string' ? clip(a.replyTo, 64) : null });
      } else if (kind === 'log') {
        if (out.logs.length < L.maxLogs) out.logs.push(clip(text, L.maxLogChars));
      } else if (kind === 'error') {
        if (!out.error) out.error = clip(text, 500);
      }
    });
    vm.setProp(vm.global, '__emit', emit);
    emit.dispose();

    const step = (src, name) => {
      const r = vm.evalCode(src, name);
      if (r.error) { const e = vm.dump(r.error); r.error.dispose(); return e || { message: 'error' }; }
      r.value.dispose();
      return null;
    };
    const problems = [];
    const note = (e) => { if (e && !out.error) problems.push(typeof e === 'string' ? e : e.message ? `${e.name || 'Error'}: ${e.message}` : 'error'); };

    note(step(SHIM, 'shim.js'));
    if (!problems.length) {
      // the bot's code is the body of a function that gets `bot` (the same shape bots.js compiles to check syntax)
      note(step(`__start(function (bot) {\n${code}\n});`, 'bot.js'));
      if (!problems.length) note(step(`__dispatch(${JSON.stringify(event)}, ${JSON.stringify(json)});`, 'event.js'));
    }
    // promises (async handlers): run their continuations, bounded
    for (let jobs = 0, left = L.maxJobs; !problems.length && left > 0; ) {
      const r = rt.executePendingJobs(Math.min(200, left));
      if (r.error) { note(vm.dump(r.error)); r.error.dispose(); break; }
      const n = r.value; if (!n) break;
      jobs += n; left -= n;
    }
    if (!problems.length && rt.hasPendingJob()) problems.push('The bot kept running after its handler finished and was stopped');
    if (problems.length) out.error = out.error || problems[0];
  } catch (e) {
    out.error = out.error || clip(e && e.message, 300);
  } finally {
    // After running out of memory QuickJS can fail its own cleanup check and abort the whole WebAssembly module; if so the worker is retired
    try { vm && vm.dispose(); } catch { out.retire = true; }
    try { rt.dispose(); } catch { out.retire = true; }
  }
  out.ms = Date.now() - started;
  if (out.error) {
    out.ok = false;
    if (/interrupted/i.test(out.error)) { out.timedOut = true; out.retire = true; out.error = `The bot took longer than ${L.ms} ms and was stopped`; }
    else if (/out of memory/i.test(out.error)) { out.error = 'The bot used too much memory and was stopped'; out.retire = true; }
  }
  return out;
}

module.exports = { runCore, loadLib, LIMITS };
