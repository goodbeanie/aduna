// The part that runs INSIDE a worker thread (sandbox-worker.js): one bot event in QuickJS. Do not call it on the main thread: a regex
// bomb is not interruptible in QuickJS, so the host (sandbox.js) runs this in a worker and kills the worker if it overruns.
//
// How a bot stays contained:
//  - A fresh QuickJS runtime per event: nothing a bot does in one event is there in the next.
//  - Hard limits: memory (setMemoryLimit), stack depth, one wall-clock budget for the event (an interrupt handler stops `while (true) {}`),
//    at most maxActions messages, maxLogs log lines, clipped text.
//  - The only door out is ONE host function, __emit(kind, jsonString), which the shim captures and deletes from the global scope.
//    Everything crossing the border is a string we parse ourselves and re-validate; no live host objects ever enter the VM.
//  - The bot only gets bot.on / bot.send / bot.reply / bot.react / bot.log / bot.store / bot.timer / bot.fetch. Nothing in here DOES any of
//    them: the sandbox only COLLECTS requests (messages, reactions, store changes, timer requests, fetch requests). What each may do is
//    decided by the caller (installed in that server? limits?) in bothost.js, botstate.js, botrun.js and botfetch.js.
//  - bot.store reads come from a snapshot of the bot's saved data in this server, handed in with the event (`state`); writes inside one
//    event are visible to later reads in the same event, and are applied for real by the host afterwards.
const LIMITS = {
  memoryBytes: 16 * 1024 * 1024, stackBytes: 512 * 1024, ms: 100, maxActions: 5, maxText: 2000, maxLogs: 20, maxLogChars: 300, maxJobs: 2000, maxEventBytes: 64 * 1024,
  maxStoreOps: 30, maxTimers: 20, maxReactions: 5, maxFetches: 3, maxStateBytes: 96 * 1024, maxItemBytes: 8 * 1024,
};

// What every run returns, also when it fails early. The host reads all five lists, so none may ever be missing.
const emptyResult = () => ({ ok: true, actions: [], store: [], timers: [], reactions: [], fetches: [], logs: [], error: null, timedOut: false, ms: 0, retire: false });

function loadLib() {
  for (const name of ['quickjs-emscripten', '@tootallnate/quickjs-emscripten']) { try { return require(name); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; } }
  throw Object.assign(new Error('The bot sandbox is not installed (npm install quickjs-emscripten)'), { code: 'SANDBOX_MISSING' });
}

// Runs inside the VM before the bot's code. `post` is the only host function; it is removed from the global scope straight away.
const SHIM = `(() => {
  const post = globalThis.__emit; delete globalThis.__emit;
  const handlers = Object.create(null);
  const str = (v) => { if (typeof v === 'string') return v; try { const j = JSON.stringify(v); return j === undefined ? String(v) : j; } catch (e) { return String(v); } };
  const json = (v, what) => { let j; try { j = JSON.stringify(v); } catch (e) { throw new TypeError(what + ': that value cannot be saved (' + e.message + ')'); } if (j === undefined) throw new TypeError(what + ': that value cannot be saved (functions and undefined are not data)'); return j; };
  // the bot's saved data in this server, as of the start of the event (plus whatever this event has changed so far)
  let kv = Object.create(null), timerList = [];
  globalThis.__init = (stateJson) => { try { const st = JSON.parse(stateJson); for (const k of Object.keys(st.kv || {})) kv[k] = String(st.kv[k]); timerList = Array.isArray(st.timers) ? st.timers : []; } catch (e) { /* no state */ } };
  const read = (k) => { if (!(k in kv)) return undefined; try { return JSON.parse(kv[k]); } catch (e) { return undefined; } };
  const store = Object.freeze({
    get(key) { return read(str(key)); },
    set(key, value) { key = str(key); const j = json(value, 'bot.store.set'); kv[key] = j; post('store', JSON.stringify({ op: 'set', key, value: j })); },
    delete(key) { key = str(key); delete kv[key]; post('store', JSON.stringify({ op: 'delete', key })); },
    incr(key, by) {
      key = str(key); by = by === undefined ? 1 : Number(by);
      if (!Number.isFinite(by)) throw new TypeError('bot.store.incr needs a number');
      const cur = key in kv ? read(key) : 0;
      if (typeof cur !== 'number' || !Number.isFinite(cur)) throw new TypeError('bot.store.incr: "' + key + '" does not hold a number');
      kv[key] = JSON.stringify(cur + by);
      post('store', JSON.stringify({ op: 'incr', key, by }));
      return cur + by;
    },
    keys() { return Object.keys(kv); },
  });
  const timer = Object.freeze({
    after(name, seconds, data) { post('timer', JSON.stringify({ kind: 'after', name: str(name), seconds: Number(seconds), data: data === undefined ? null : json(data, 'bot.timer.after') })); },
    every(name, seconds, data) { post('timer', JSON.stringify({ kind: 'every', name: str(name), seconds: Number(seconds), data: data === undefined ? null : json(data, 'bot.timer.every') })); },
    daily(name, time, tz, data) { post('timer', JSON.stringify({ kind: 'daily', name: str(name), time: str(time), tz: tz === undefined || tz === null ? null : str(tz), data: data === undefined ? null : json(data, 'bot.timer.daily') })); },
    cancel(name) { post('timer', JSON.stringify({ kind: 'cancel', name: str(name) })); },
    list() { return timerList.map((t) => Object.assign({}, t)); },
  });
  const bot = Object.freeze({
    on(event, fn) { if (typeof event !== 'string' || typeof fn !== 'function') throw new TypeError('bot.on(eventName, function)'); (handlers[event] = handlers[event] || []).push(fn); },
    send(channelId, text) { post('send', JSON.stringify({ channelId: str(channelId), text: str(text) })); },
    reply(message, text) { post('send', JSON.stringify({ channelId: str(message && message.channelId), text: str(text), replyTo: message && message.id ? str(message.id) : null })); },
    react(message, emoji) { post('react', JSON.stringify({ messageId: str(message && message.id !== undefined ? message.id : message), emoji: str(emoji) })); },
    fetch(url, name) { post('fetch', JSON.stringify({ url: str(url), name: name === undefined || name === null ? 'fetch' : str(name) })); },
    log() { post('log', Array.prototype.map.call(arguments, str).join(' ')); },
    store, timer,
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

// run(lib, q, { code, event, payload, state }, limits?) -> { ok, actions: [{ channelId, text, replyTo }], store: [{ op, key, value?, by? }],
//   timers: [{ kind, name, seconds?, time?, tz?, data? }], reactions: [{ messageId, emoji }], fetches: [{ url, name }], logs: [string], error, timedOut, ms, retire }
// `ok` is false when the code failed to load, threw, ran out of time or memory; actions sent before that moment are still returned.
// `retire` = the QuickJS module may be in a bad state (out of memory, failed cleanup): the worker must be replaced.
function runCore(lib, q, { code, event, payload, state }, limits = {}) {
  const L = { ...LIMITS, ...limits };
  const out = emptyResult();
  const json = JSON.stringify(payload === undefined ? null : payload);
  // the saved data: only plain strings for kv, a short list of plain fields for timers; anything else is left out (the host re-checks everything it applies)
  const st = { kv: {}, timers: [] };
  if (state && typeof state === 'object') {
    if (state.kv && typeof state.kv === 'object') for (const k of Object.keys(state.kv)) if (typeof state.kv[k] === 'string') st.kv[k] = state.kv[k];
    if (Array.isArray(state.timers)) st.timers = state.timers.slice(0, 10).map((t) => ({ name: clip(t && t.name, 32), kind: clip(t && t.kind, 8), at: Number(t && t.at) || 0, everySec: t && t.everySec ? Number(t.everySec) : null, time: t && t.time ? clip(t.time, 5) : null, tz: t && t.tz ? clip(t.tz, 64) : null }));
  }
  const stateJson = JSON.stringify(st);
  if (Buffer.byteLength(stateJson) > L.maxStateBytes) return { ...out, ok: false, error: 'The bot\'s saved data is too large to load' };
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
      } else if (kind === 'store' || kind === 'timer' || kind === 'react' || kind === 'fetch') {
        if (Buffer.byteLength(text) > L.maxItemBytes) return;
        let a; try { a = JSON.parse(text); } catch { return; }
        if (!a || typeof a !== 'object') return;
        if (kind === 'store') {
          if (out.store.length >= L.maxStoreOps || typeof a.key !== 'string' || typeof a.op !== 'string') return;
          out.store.push(a.op === 'set' ? { op: 'set', key: clip(a.key, 64), value: typeof a.value === 'string' ? a.value : '' } : a.op === 'incr' ? { op: 'incr', key: clip(a.key, 64), by: Number(a.by) } : { op: a.op === 'delete' ? 'delete' : 'unknown', key: clip(a.key, 64) });
        } else if (kind === 'timer') {
          if (out.timers.length >= L.maxTimers || typeof a.name !== 'string' || typeof a.kind !== 'string') return;
          out.timers.push({ kind: clip(a.kind, 8), name: clip(a.name, 64), seconds: Number(a.seconds), time: typeof a.time === 'string' ? clip(a.time, 8) : undefined, tz: typeof a.tz === 'string' ? clip(a.tz, 64) : undefined, data: typeof a.data === 'string' ? a.data : null });
        } else if (kind === 'react') {
          if (out.reactions.length >= L.maxReactions || typeof a.messageId !== 'string' || typeof a.emoji !== 'string') return;
          out.reactions.push({ messageId: clip(a.messageId, 64), emoji: clip(a.emoji, 40) });
        } else {
          if (out.fetches.length >= L.maxFetches || typeof a.url !== 'string') return;
          out.fetches.push({ url: clip(a.url, 400), name: typeof a.name === 'string' ? clip(a.name, 64) : 'fetch' });
        }
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
    if (!problems.length) note(step(`__init(${JSON.stringify(stateJson)}); delete globalThis.__init;`, 'state.js'));
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

module.exports = { runCore, loadLib, emptyResult, LIMITS };
