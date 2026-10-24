// Runs a bot AND its test inside QuickJS, the same sandbox the Aduna server uses (sandbox-core.js), with the server's own rules for what a
// bot may do (botrun.js: channels, pings, reactions, fetches; botstate.js: storage and timers; botfetch.js: allowed addresses).
// Nothing the AI writes can touch this PC: bot.js and test.js are only text handed to QuickJS.
//
// This file runs INSIDE a worker thread (qjs-worker.js); the host (qjs-host.js) kills that thread if it overruns, because QuickJS cannot
// interrupt a regex bomb. runSuite() is synchronous: the test VM calls one host function (__host) and every call is answered at once.
//
//   test.js (VM 1)  --__host('bot', ...)-->  this file  --runCore()-->  bot.js (VM 2, a fresh runtime for every event, like the server)
'use strict';
const { runCore, LIMITS: CORE } = require('./sandbox-core');
const botstate = require('./botstate');
const botrun = require('./botrun');
const botfetch = require('./botfetch');

const LIMITS = { suiteMs: 10_000, memoryBytes: 32 * 1024 * 1024, stackBytes: 512 * 1024, consoleLines: 40, consoleChars: 300, activityKeep: 40, botsPerSuite: 8, codeBytes: 32 * 1024 };

// The made-up server every test runs in (one server, three channels, three people and the bot's own account).
const BOT_USER = 'bot1';
const PEOPLE = {
  u1: { id: 'u1', username: 'tester', displayName: 'Tester', bot: false },
  u2: { id: 'u2', username: 'sam', displayName: 'Sam', bot: false },
  u3: { id: 'u3', username: 'otherbot', displayName: 'Other Bot', bot: true },
};
const SERVER = {
  id: 's1', name: 'Test server', members: ['u1', 'u2', 'u3', BOT_USER],
  channels: [{ id: 'c1', name: 'general', type: 'text' }, { id: 'c2', name: 'random', type: 'text' }, { id: 'c3', name: 'Lounge', type: 'voice' }],
};
// The same rule as the server's emojiOk for ordinary emoji (server/index.js): short, and not a plain word.
const emojiOk = (e) => typeof e === 'string' && e.length > 0 && e.length <= 8 && !/^[\w$]+$/.test(e);

// The events a bot registers with bot.on('name', ...): read from the code, so a handler the test never reaches can be pointed out.
function scanHandlers(code) {
  const out = [], re = /\bbot\s*\.\s*on\s*\(\s*(['"`])([^'"`\n]{1,41})\1/g;
  let m;
  while ((m = re.exec(String(code || '')))) if (!out.includes(m[2])) out.push(m[2]);
  return out;
}

// ---------- the test VM's own shim: assert, test, console, newBot ----------
const TEST_SHIM = `(() => {
  const host = globalThis.__host; delete globalThis.__host;
  const call = (kind, arg) => {
    const r = JSON.parse(host(kind, JSON.stringify(arg === undefined ? null : arg)));
    if (r && r.__throw) { const e = new Error(r.__throw); e.name = r.name || 'Error'; throw e; }
    return r;
  };
  const show = (v) => {
    let s;
    try { s = v === undefined ? 'undefined' : typeof v === 'function' ? '[Function]' : JSON.stringify(v, (k, x) => (x === undefined ? '__undef' : typeof x === 'function' ? '[Function]' : x)); } catch (e) { s = String(v); }
    if (s === undefined) s = String(v);
    s = s.split('"__undef"').join('undefined');
    return s.length > 300 ? s.slice(0, 299) + '\\u2026' : s;
  };
  const keyOf = (k, arr) => (arr ? '[' + k + ']' : /^[A-Za-z_$][\\w$]*$/.test(k) ? '.' + k : '[' + JSON.stringify(k) + ']');
  const diffAt = (a, b, strict, path) => {
    if (strict ? Object.is(a, b) : (a == b || (a !== a && b !== b))) return null;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      if (Array.isArray(a) !== Array.isArray(b)) return { path, a, b };
      if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime() ? null : { path, a, b };
      const arr = Array.isArray(a);
      if (arr && a.length !== b.length) return { path: path + '.length', a: a.length, b: b.length };
      const ka = Object.keys(a), kb = Object.keys(b);
      for (const k of ka) {
        if (!Object.prototype.hasOwnProperty.call(b, k)) return { path: path + keyOf(k, arr), a: a[k], b: undefined, note: 'the expected value has no such entry' };
        const d = diffAt(a[k], b[k], strict, path + keyOf(k, arr)); if (d) return d;
      }
      for (const k of kb) if (!Object.prototype.hasOwnProperty.call(a, k)) return { path: path + keyOf(k, arr), a: undefined, b: b[k], note: 'the actual value has no such entry' };
      return null;
    }
    return { path, a, b };
  };
  class AssertionError extends Error { constructor(message, actual, expected) { super(message); this.name = 'AssertionError'; this.code = 'ERR_ASSERTION'; this.actual = actual; this.expected = expected; } }
  const pass = () => { call('assertOk'); };
  const fail = (msg, actual, expected) => { call('assertFail', { message: msg }); throw new AssertionError(msg, actual, expected); };
  const withMsg = (custom, text) => (custom !== undefined && custom !== null ? (custom instanceof Error ? custom.message : String(custom)) + '\\n  (' + text.split('\\n')[0] + ')' : text);
  const assert = function (v, m) { return assert.ok(v, m); };
  Object.assign(assert, {
    AssertionError,
    ok(v, m) { if (!v) fail(withMsg(m, 'The value is not truthy: ' + show(v)), v, true); pass(); },
    fail(m) { fail(m === undefined ? 'Failed' : String(m)); },
    equal(a, b, m) { if (!(a == b || (a !== a && b !== b))) fail(withMsg(m, 'Expected values to be loosely equal:\\n  actual:   ' + show(a) + '\\n  expected: ' + show(b)), a, b); pass(); },
    notEqual(a, b, m) { if (a == b) fail(withMsg(m, 'Expected values to be different, both are ' + show(a)), a, b); pass(); },
    strictEqual(a, b, m) { if (!Object.is(a, b)) fail(withMsg(m, 'Expected values to be strictly equal:\\n  actual:   ' + show(a) + '\\n  expected: ' + show(b)), a, b); pass(); },
    notStrictEqual(a, b, m) { if (Object.is(a, b)) fail(withMsg(m, 'Expected values to be different, both are ' + show(a)), a, b); pass(); },
    deepEqual(a, b, m) { const d = diffAt(a, b, false, ''); if (d) fail(withMsg(m, 'Expected values to be loosely deep-equal.\\n  first difference at ' + (d.path || '(the top)') + ': actual ' + show(d.a) + ', expected ' + show(d.b) + (d.note ? ' (' + d.note + ')' : '') + '\\n  actual:   ' + show(a) + '\\n  expected: ' + show(b)), a, b); pass(); },
    deepStrictEqual(a, b, m) { const d = diffAt(a, b, true, ''); if (d) fail(withMsg(m, 'Expected values to be strictly deep-equal.\\n  first difference at ' + (d.path || '(the top)') + ': actual ' + show(d.a) + ', expected ' + show(d.b) + (d.note ? ' (' + d.note + ')' : '') + '\\n  actual:   ' + show(a) + '\\n  expected: ' + show(b)), a, b); pass(); },
    notDeepStrictEqual(a, b, m) { if (!diffAt(a, b, true, '')) fail(withMsg(m, 'Expected values not to be deep-equal, both are ' + show(a)), a, b); pass(); },
    notDeepEqual(a, b, m) { if (!diffAt(a, b, false, '')) fail(withMsg(m, 'Expected values not to be deep-equal, both are ' + show(a)), a, b); pass(); },
    match(s, re, m) { if (typeof s !== 'string' || !re.test(s)) fail(withMsg(m, 'The text does not match ' + String(re) + ': ' + show(s)), s, re); pass(); },
    doesNotMatch(s, re, m) { if (typeof s === 'string' && re.test(s)) fail(withMsg(m, 'The text should not match ' + String(re) + ': ' + show(s)), s, re); pass(); },
    throws(fn, expected, m) {
      let threw = false, err;
      try { fn(); } catch (e) { threw = true; err = e; }
      if (!threw) fail(withMsg(typeof expected === 'string' ? expected : m, 'Expected the function to throw, but it did not'));
      if (expected instanceof RegExp && !expected.test(String(err && err.message !== undefined ? err.message : err))) fail(withMsg(m, 'The error message ' + show(String(err && err.message)) + ' does not match ' + String(expected)));
      pass();
    },
    doesNotThrow(fn, m) { try { fn(); } catch (e) { fail(withMsg(m, 'Expected no error, but it threw: ' + String(e && e.message))); } pass(); },
  });
  assert.strict = assert;

  const fmtErr = (e) => {
    if (e && e.name === '__Exit') return null;
    let s = e && e.message !== undefined ? String(e.name || 'Error') + ': ' + String(e.message) : String(e);
    const at = String((e && e.stack) || '').split('\\n').filter((l) => /test\\.js:\\d+/.test(l)).slice(0, 2).map((l) => l.trim());
    if (at.length) s += '\\n  ' + at.join('\\n  ');
    return s;
  };

  globalThis.assert = assert;
  globalThis.require = (name) => {
    if (/^(node:)?assert(\\/strict)?$/.test(String(name))) return assert;
    throw new Error("Cannot find module '" + name + "'. The test runs in a sandbox with no modules; use the globals assert, test and newBot");
  };
  globalThis.module = { exports: {} }; globalThis.exports = globalThis.module.exports;
  const out = (kind) => (...a) => { call('console', { kind, text: a.map((x) => (typeof x === 'string' ? x : show(x))).join(' ') }); };
  globalThis.console = { log: out('log'), info: out('log'), debug: out('log'), warn: out('warn'), error: out('error') };
  globalThis.process = { argv: [], env: {}, platform: 'sandbox', exitCode: 0, exit(code) { call('exit', { code: Number(code) || 0 }); const e = new Error('exit'); e.name = '__Exit'; throw e; }, on() {}, nextTick(f) { Promise.resolve().then(f); } };

  // ----- tests -----
  globalThis.test = (name, fn) => {
    const i = call('testStart', { name: String(name) }).i;
    const bad = (e) => { const s = fmtErr(e); call('testEnd', { i, ok: false, error: s === null ? 'process.exit() was called' : s }); };
    try {
      const r = typeof fn === 'function' ? fn() : undefined;
      if (r && typeof r.then === 'function') r.then(() => call('testEnd', { i, ok: true }), bad);
      else call('testEnd', { i, ok: true });
    } catch (e) { bad(e); }
  };
  globalThis.it = globalThis.test;
  globalThis.describe = (name, fn) => { try { if (typeof fn === 'function') fn(); } catch (e) { call('testEnd', { i: call('testStart', { name: String(name) }).i, ok: false, error: fmtErr(e) || 'process.exit() was called' }); } };

  // ----- bots -----
  const makeBot = () => {
    const id = call('newBot').id;
    const op = (name, args) => call('bot', { id, op: name, args });
    const t = {
      emit: (event, payload) => op('emit', { event: String(event), payload }),
      say: (text, extra) => op('say', { text, extra }),
      edit: (text, extra) => op('edit', { text, extra }),
      join: (extra) => op('join', { extra }),
      leave: (extra) => op('leave', { extra }),
      install: (extra) => op('install', { extra }),
      message: (text, extra) => op('message', { text, extra }),
      edited: (text, extra) => op('edited', { text, extra }),
      joined: (extra) => op('joined', { extra }),
      left: (extra) => op('left', { extra }),
      installed: (extra) => op('installed', { extra }),
      fetchAnswer: (name, a) => op('fetchAnswer', { name, a }),
      timerFired: (name, data) => op('timerFired', { name, data }),
      advance: (seconds) => op('advance', { seconds }),
      setStore: (key, value) => op('setStore', { key, value }),
    };
    for (const k of ['sent', 'reactions', 'logs', 'fetches', 'timers', 'store', 'dropped', 'now']) Object.defineProperty(t, k, { get: () => op('read', { what: k }), enumerable: true });
    return t;
  };
  globalThis.newBot = makeBot;
  globalThis.loadBot = makeBot;

  globalThis.__run = (fn) => {
    let p;
    try { p = fn(); } catch (e) { const s = fmtErr(e); call('script', { ok: s === null, error: s }); return; }
    if (p && typeof p.then === 'function') p.then(() => call('script', { ok: true }), (e) => { const s = fmtErr(e); call('script', { ok: s === null, error: s }); });
    else call('script', { ok: true });
  };
})();`;

const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; };
const jsonOr = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

// runSuite(lib, q, { botCode, testCode, fetchHosts }) -> result (see the end of this function). Never throws.
function runSuite(lib, q, { botCode, testCode, fetchHosts }, opts = {}) {
  const L = { ...LIMITS, ...(opts.limits || {}) };
  const hosts = Array.isArray(fetchHosts) && fetchHosts.length ? fetchHosts : botfetch.DEFAULT_HOSTS;
  let clock = Number(opts.now) || Date.now();
  const guard = new botrun.Guard({ now: () => clock });
  const res = {
    ok: false, error: null, timedOut: false, retire: false, ms: 0, exitCode: 0,
    tests: [], assertions: 0, failures: [], console: [], activity: [], bots: 0,
    registered: scanHandlers(botCode), events: {}, final: null,
    coverage: { missing: [], silent: [], noHandlers: false, noAssertions: false }, covered: false,
  };
  const code = String(botCode == null ? '' : botCode);
  if (!code.trim()) return { ...res, error: 'bot.js is empty' };
  if (Buffer.byteLength(code) > L.codeBytes) return { ...res, error: `bot.js is over the ${L.codeBytes / 1024} KB limit for a bot` };

  const bots = [];
  const msgs = Object.create(null);
  let msgSeq = 0, scriptState = null, abort = null;

  const note = (e, input) => { res.activity.push({ ...e, input: clip(input, 120) }); if (res.activity.length > L.activityKeep) res.activity.shift(); };
  const cov = (event, effects) => { const c = res.events[event] || (res.events[event] = { emits: 0, effects: 0 }); c.emits++; if (effects) c.effects++; };

  // ----- one event, applied the way the server applies it -----
  function deliver(b, event, payload, trigger, mentionUserId) {
    const input = payload && typeof payload === 'object' ? (payload.text !== undefined ? payload.text : payload.user ? 'user ' + payload.user.id : payload.name ? payload.name : event) : event;
    // the server never shows a bot an event caused by a bot, or a message from a channel that is not plain text
    if (event === 'message' || event === 'messageEdit') {
      const ch = SERVER.channels.find((c) => c.id === (payload && payload.channelId));
      if (payload && payload.author && payload.author.bot) { note({ event, skipped: 'bots never receive messages from other bots' }, input); return { ok: true, skipped: 'bots never receive messages from other bots', sent: [], reactions: [], logs: [], fetches: [], dropped: [] }; }
      if (!ch || (ch.type || 'text') !== 'text') { note({ event, skipped: 'bots only see text channels' }, input); return { ok: true, skipped: 'bots only see text channels', sent: [], reactions: [], logs: [], fetches: [], dropped: [] }; }
    }
    if ((event === 'memberJoin' || event === 'memberLeave') && payload && payload.user && payload.user.bot) return { ok: true, skipped: 'bots never receive events caused by bots', sent: [], reactions: [], logs: [], fetches: [], dropped: [] };
    const adm = guard.admit(b.guardId, SERVER.id);
    if (!adm.ok) { const why = 'the server would skip this event: ' + adm.reason + ' (use t.advance(seconds) to let time pass)'; b.dropped.push(why); note({ event, skipped: why }, input); return { ok: true, skipped: why, sent: [], reactions: [], logs: [], fetches: [], dropped: [why] }; }

    const r = runCore(lib, q, { code, event, payload, state: botstate.snapshotFor(b.scratch) });
    guard.record(b.guardId, r);
    const dropped = [];
    const entry = { event, sent: [], reactions: [], logs: (r.logs || []).slice(), dropped, error: r.error || null };
    if (r.retire) res.retire = true;
    if (!r.ok) {
      note({ ...entry }, input);
      cov(event, true);
      if (r.timedOut || r.retire) abort = r.error || 'The bot sandbox stopped';
      return { __throw: `The bot failed while handling "${event}": ${r.error || 'unknown error'}`, name: 'BotError' };
    }
    const plan = botrun.planActions({ actions: r.actions, server: SERVER, install: {}, mentionUserId, maxText: CORE.maxText, replyOk: (cid, mid) => (msgs[mid] && msgs[mid].channelId === cid ? mid : null) });
    dropped.push(...plan.dropped);
    const room = guard.takeMessages(b.guardId, SERVER.id, plan.send.length);
    if (room < plan.send.length) dropped.push(`${plan.send.length - room} message(s) over the limit of ${botrun.LIMITS.messagesPerMin} per minute`);
    for (const a of plan.send.slice(0, room)) { const m = { channelId: a.channel.id, text: a.text, replyTo: a.replyTo }; b.sent.push(m); entry.sent.push(m); }
    dropped.push(...botstate.applyStoreOps(b.scratch.kv, r.store).dropped);
    dropped.push(...botstate.applyTimers(b.scratch, r.timers, clock).dropped);
    if (r.reactions.length) {
      const rp = botrun.planReactions({ actions: r.reactions, server: SERVER, install: {}, messageOf: (id) => msgs[id] || null, emojiOk });
      dropped.push(...rp.dropped);
      const rr = guard.takeReactions(b.guardId, SERVER.id, rp.react.length);
      if (rr < rp.react.length) dropped.push(`${rp.react.length - rr} reaction(s) over the limit of ${botrun.LIMITS.reactionsPerMin} per minute`);
      for (const x of rp.react.slice(0, rr)) { const o = { messageId: x.msg.id, emoji: x.emoji }; b.reactions.push(o); entry.reactions.push(o); }
    }
    let fetched = 0;
    if (r.fetches.length) {
      const fp = botrun.planFetches({ actions: r.fetches, check: (u) => botfetch.checkUrl(u, hosts) });
      dropped.push(...fp.dropped);
      const fr = guard.takeFetches(b.guardId, SERVER.id, fp.fetch.length);
      if (fr < fp.fetch.length) dropped.push(`${fp.fetch.length - fr} fetch(es) over the limit of ${botrun.LIMITS.fetchesPerMin} per minute`);
      for (const f of fp.fetch.slice(0, fr)) { b.fetches.push({ url: f.url, name: f.name }); fetched++; }
    }
    for (const l of r.logs || []) { if (b.logs.length < 200) b.logs.push(l); }
    if (trigger) b.trigger = trigger;
    b.dropped.push(...dropped);
    const effects = entry.sent.length + entry.reactions.length + r.store.length + r.timers.length + fetched + (r.logs || []).length;
    cov(event, effects > 0);
    note(entry, input);
    return { ok: true, skipped: null, ms: r.ms, sent: entry.sent, reactions: entry.reactions, logs: entry.logs, fetches: b.fetches.slice(-fetched || b.fetches.length), dropped };
  }

  // ----- payload builders (the same shapes as the server's real events) -----
  const person = (id) => (PEOPLE[id] || PEOPLE.u1);
  function build(b, kind, a) {
    const x = (a && a.extra) || {};
    if (kind === 'message' || kind === 'edited') {
      const author = person(x.author);
      const msg = { id: x.id ? String(x.id) : 'm' + (++msgSeq), channelId: String(x.channelId || 'c1'), serverId: SERVER.id, content: String(a.text == null ? '' : a.text), mentions: Array.isArray(x.mentions) ? x.mentions.map(String) : x.mentionsBot ? [BOT_USER] : [], attachments: Array.isArray(x.attachments) ? x.attachments : new Array(Math.max(0, Math.min(10, Number(x.attachments) || 0))).fill(0), replyTo: x.replyTo ? String(x.replyTo) : null, createdAt: clock, editedAt: kind === 'edited' ? clock : null };
      msgs[msg.id] = msg;
      return kind === 'edited' ? botrun.editPayload({ msg, author, botUserId: BOT_USER }) : botrun.messagePayload({ msg, author, botUserId: BOT_USER });
    }
    if (kind === 'joined') return botrun.joinPayload({ server: SERVER, user: person(x.user), install: {} });
    if (kind === 'left') return botrun.leavePayload({ server: SERVER, user: person(x.user), install: {}, reason: x.reason === 'kicked' ? 'kicked' : 'left' });
    if (kind === 'installed') return botrun.installPayload({ server: SERVER, install: {}, by: person(x.by) });
    return null;
  }
  const triggerOf = (event, p) => (event === 'message' || event === 'messageEdit' ? p.author && p.author.id : event === 'memberJoin' ? p.user && p.user.id : event === 'install' ? p.by && p.by.id : null);

  function botOp(b, op, a) {
    a = a || {};
    switch (op) {
      case 'message': case 'edited': case 'joined': case 'left': case 'installed': return build(b, op, a);
      case 'emit': {
        if (typeof a.event !== 'string') return { __throw: 't.emit(event, payload): the event name must be a string' };
        const p = a.payload === undefined ? null : a.payload;
        const who = triggerOf(a.event, p || {});
        return deliver(b, a.event, p, who, who);
      }
      case 'say': case 'edit': {
        const event = op === 'say' ? 'message' : 'messageEdit';
        const p = build(b, op === 'say' ? 'message' : 'edited', a);
        return deliver(b, event, p, p.author.id, p.author.id);
      }
      case 'join': case 'leave': case 'install': {
        const event = op === 'join' ? 'memberJoin' : op === 'leave' ? 'memberLeave' : 'install';
        const p = build(b, op === 'join' ? 'joined' : op === 'leave' ? 'left' : 'installed', a);
        const who = triggerOf(event, p);
        return deliver(b, event, p, who, event === 'memberLeave' ? null : who);
      }
      case 'fetchAnswer': {
        const name = String(a.name);
        const asked = b.fetches.slice().reverse().find((f) => f.name === name);
        if (!asked) return { __throw: `The bot never asked for a web page named "${name}"` + (b.fetches.length ? ' (it asked for: ' + b.fetches.map((f) => f.name).join(', ') + ')' : ' (it has not called bot.fetch at all, or the server refused it: see t.dropped)'), name: 'TestError' };
        const g = a.a || {};
        const json = g.json === undefined ? null : g.json;
        const result = { ok: true, status: 200, text: g.text !== undefined ? String(g.text) : json !== null ? JSON.stringify(json) : '', json, truncated: false, error: null };
        for (const k of ['ok', 'status', 'truncated', 'error']) if (g[k] !== undefined) result[k] = g[k];
        if (result.ok === false && result.error == null) result.error = 'The server answered ' + (result.status || 0);
        return deliver(b, 'fetch', botrun.fetchPayload({ server: SERVER, install: {}, request: asked, result }), null, b.trigger);
      }
      case 'timerFired': return deliver(b, 'timer', botrun.timerPayload({ server: SERVER, install: {}, timer: { name: String(a.name), kind: 'after', data: a.data === undefined ? null : JSON.stringify(a.data) }, firedAt: clock }), null, null);
      case 'advance': {
        const sec = Number(a.seconds);
        if (!Number.isFinite(sec) || sec < 0 || sec > 30 * 86400) return { __throw: 't.advance(seconds) needs a number between 0 and 30 days', name: 'TestError' };
        clock += Math.round(sec * 1000);
        const fired = [];
        for (let n = 0; n < 20; n++) {
          const due = botstate.dueTimers(b.scratch, clock)[0];
          if (!due) break;
          const payload = botrun.timerPayload({ server: SERVER, install: {}, timer: due, firedAt: clock });
          botstate.advance(b.scratch, due, clock);
          const r = deliver(b, 'timer', payload, null, null);
          if (r && r.__throw) return r;
          fired.push(due.name);
        }
        return { ok: true, fired, now: clock };
      }
      case 'setStore': {
        const j = JSON.stringify(a.value);
        if (j === undefined) return { __throw: 't.setStore: that value cannot be saved', name: 'TestError' };
        const d = botstate.applyStoreOps(b.scratch.kv, [{ op: 'set', key: String(a.key), value: j }]).dropped;
        if (d.length) return { __throw: 't.setStore: ' + d[0], name: 'TestError' };
        return { ok: true };
      }
      case 'read': {
        switch (a.what) {
          case 'sent': return b.sent.slice();
          case 'reactions': return b.reactions.slice();
          case 'logs': return b.logs.slice();
          case 'fetches': return b.fetches.slice();
          case 'dropped': return b.dropped.slice();
          case 'now': return clock;
          case 'timers': return b.scratch.timers.map((t) => ({ name: t.name, kind: t.kind, everySec: t.everySec, time: t.time, tz: t.tz, at: t.at, data: t.data === null ? null : jsonOr(t.data, null) }));
          case 'store': { const o = {}; for (const k of Object.keys(b.scratch.kv)) o[k] = jsonOr(b.scratch.kv[k], null); return o; }
          default: return null;
        }
      }
      default: return { __throw: 'unknown test helper ' + op, name: 'TestError' };
    }
  }

  // ----- the test VM -----
  const started = Date.now();
  const deadline = started + L.suiteMs;
  const rt = q.newRuntime();
  let vm = null;
  try {
    rt.setMemoryLimit(L.memoryBytes);
    rt.setMaxStackSize(L.stackBytes);
    rt.setInterruptHandler(lib.shouldInterruptAfterDeadline(deadline));
    vm = rt.newContext();

    const hostFn = vm.newFunction('__host', (kindH, argH) => {
      const kind = vm.getString(kindH), arg = jsonOr(vm.getString(argH), null) || {};
      let out;
      try {
        if (abort && (kind === 'bot' || kind === 'newBot')) out = { __throw: abort };
        else if (kind === 'assertOk') { res.assertions++; out = null; }
        else if (kind === 'assertFail') { res.assertions++; if (res.failures.length < 20) res.failures.push(clip(arg.message, 800)); out = null; }
        else if (kind === 'testStart') { res.tests.push({ name: clip(arg.name, 120), ok: null, error: null }); out = { i: res.tests.length - 1 }; }
        else if (kind === 'testEnd') { const t = res.tests[arg.i]; if (t) { t.ok = !!arg.ok; t.error = arg.ok ? null : clip(arg.error, 1200); } out = null; }
        else if (kind === 'console') { if (res.console.length < L.consoleLines) res.console.push((arg.kind === 'log' ? '' : arg.kind + ': ') + clip(arg.text, L.consoleChars)); out = null; }
        else if (kind === 'exit') { res.exitCode = arg.code; out = null; }
        else if (kind === 'script') { scriptState = { ok: !!arg.ok, error: arg.error || null }; out = null; }
        else if (kind === 'newBot') {
          if (bots.length >= L.botsPerSuite) out = { __throw: `A test can create at most ${L.botsPerSuite} bots with newBot()`, name: 'TestError' };
          else { const id = bots.length; bots.push({ id, guardId: 'bot' + id, scratch: { kv: {}, timers: [] }, sent: [], reactions: [], logs: [], fetches: [], dropped: [], trigger: null }); res.bots = bots.length; out = { id }; }
        } else if (kind === 'bot') {
          const b = bots[arg.id];
          out = b ? botOp(b, arg.op, arg.args) : { __throw: 'unknown bot', name: 'TestError' };
        } else out = { __throw: 'unknown host call ' + kind };
      } catch (e) { out = { __throw: 'The test harness failed: ' + clip(e && e.message, 200), name: 'HarnessError' }; }
      return vm.newString(JSON.stringify(out === undefined ? null : out));
    });
    vm.setProp(vm.global, '__host', hostFn);
    hostFn.dispose();

    const step = (src, name) => {
      const r = vm.evalCode(src, name);
      if (r.error) { const e = vm.dump(r.error); r.error.dispose(); return e || { message: 'error' }; }
      r.value.dispose();
      return null;
    };
    const text = (e) => (typeof e === 'string' ? e : e && e.message ? `${e.name || 'Error'}: ${e.message}` : 'error');
    let problem = text(step(TEST_SHIM, 'shim.js') || '') || null;
    if (problem === '') problem = null;
    if (!problem) {
      const e = step(`__run(async function () { ${testCode}\n});`, 'test.js');
      if (e) problem = text(e);
    }
    for (let left = 20000; !problem && left > 0; ) {
      const r = rt.executePendingJobs(Math.min(500, left));
      if (r.error) { problem = text(vm.dump(r.error)); r.error.dispose(); break; }
      if (!r.value) break;
      left -= r.value;
    }
    if (!problem && rt.hasPendingJob()) problem = 'The test kept running after it finished';
    if (!problem && scriptState && scriptState.error) problem = scriptState.error;
    if (!problem && !scriptState) problem = 'The test never finished: it is waiting for something that never happens (an await that does not resolve)';
    if (problem) res.error = problem;
  } catch (e) {
    res.error = res.error || clip(e && e.message, 300);
  } finally {
    try { vm && vm.dispose(); } catch { res.retire = true; }
    try { rt.dispose(); } catch { res.retire = true; }
  }
  res.ms = Date.now() - started;
  if (res.error && /interrupted/i.test(res.error)) { res.timedOut = true; res.retire = true; res.error = `The test took longer than ${L.suiteMs / 1000} seconds and was stopped (an endless loop?)`; }
  else if (res.error && /out of memory/i.test(res.error)) { res.retire = true; res.error = 'The test used too much memory and was stopped'; }
  if (abort && !res.error) res.error = abort;
  if (abort) res.timedOut = res.timedOut || /longer than/.test(abort);

  // tests that started but never ended
  for (const t of res.tests) if (t.ok === null) { t.ok = false; t.error = 'The test did not finish (an await that never resolves?)'; }
  const last = bots[bots.length - 1];
  if (last) res.final = { sent: last.sent.slice(-8), reactions: last.reactions.slice(-8), logs: last.logs.slice(-10), dropped: last.dropped.slice(-10), stored: Object.fromEntries(Object.keys(last.scratch.kv).slice(0, 20).map((k) => [k, jsonOr(last.scratch.kv[k], null)])), timers: last.scratch.timers.map((t) => `${t.name} (${t.kind})`) };
  const missing = res.registered.filter((e) => !(res.events[e] && res.events[e].emits));
  const silent = res.registered.filter((e) => res.events[e] && res.events[e].emits && !res.events[e].effects);
  res.coverage = { missing, silent, noHandlers: res.registered.length === 0, noAssertions: res.assertions === 0 };
  res.ok = !res.error && res.exitCode === 0 && !res.failures.length && !res.tests.some((t) => !t.ok);
  res.covered = res.ok && !res.coverage.noHandlers && !res.coverage.noAssertions && !missing.length && !silent.length;
  return res;
}

module.exports = { runSuite, scanHandlers, LIMITS, PEOPLE, SERVER, BOT_USER };
