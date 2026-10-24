// What a bot can REMEMBER and what it can SCHEDULE. Pure functions (no Express, no database, no sandbox): tested by botstate-test.js.
//
// A bot's code starts from nothing for every event (see sandbox-core.js), so anything it wants to keep lives here, on its install record in a server:
//   inst.kv     = { key: '<json text>' }                      the bot's storage in THIS server (removing the bot from the server erases it)
//   inst.timers = [{ name, kind: 'after'|'every'|'daily', at, everySec, time, tz, data, since }]
// The sandbox is handed a snapshot of both before the event runs (snapshotFor) and hands back what the bot asked to change (store operations
// and timer requests). Nothing the bot asks for is trusted: applyStoreOps and applyTimers re-check every field and every limit.

const LIMITS = {
  keys: 64,              // keys per bot per server
  keyLen: 64,
  valueBytes: 4096,      // one stored value (as JSON text)
  totalBytes: 32 * 1024, // everything one bot stores in one server (keys + values)
  opsPerRun: 30,         // store operations one event may ask for (the sandbox stops collecting after this)
  timersPerInstall: 10,
  minAfterSec: 5,
  minEverySec: 60,
  maxSec: 30 * 86400,
  timerName: 32,
  timerDataBytes: 1024,
};

const KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
const TIMER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,31}$/;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const bytes = (s) => Buffer.byteLength(String(s));
const validKey = (k) => typeof k === 'string' && KEY.test(k) && k !== '__proto__';

// ---------- storage ----------
const sizeOf = (kv) => Object.entries(kv).reduce((n, [k, v]) => n + bytes(k) + bytes(v), 0);

// Applies what the sandbox collected to `kv` (mutates it). ops: [{ op: 'set'|'delete'|'incr', key, value?: '<json text>', by?: number }].
// Returns { dropped: [reason] }. An op that breaks a limit is dropped on its own; the others still apply.
function applyStoreOps(kv, ops, limits = {}) {
  const L = { ...LIMITS, ...limits };
  const dropped = [];
  for (const op of Array.isArray(ops) ? ops.slice(0, L.opsPerRun) : []) {
    if (!op || !validKey(op.key)) { dropped.push('store: bad key'); continue; }
    if (op.op === 'delete') { delete kv[op.key]; continue; }
    let json;
    if (op.op === 'incr') {
      const by = Number(op.by);
      if (!Number.isFinite(by)) { dropped.push(`store: incr "${op.key}" needs a number`); continue; }
      let cur = 0;
      if (own(kv, op.key)) { try { cur = JSON.parse(kv[op.key]); } catch { cur = NaN; } }
      if (typeof cur !== 'number' || !Number.isFinite(cur)) { dropped.push(`store: "${op.key}" is not a number`); continue; }
      const next = cur + by;
      if (!Number.isFinite(next) || Math.abs(next) > Number.MAX_SAFE_INTEGER) { dropped.push(`store: "${op.key}" would overflow`); continue; }
      json = JSON.stringify(next);
    } else if (op.op === 'set') {
      if (typeof op.value !== 'string') { dropped.push('store: bad value'); continue; }
      try { JSON.parse(op.value); } catch { dropped.push(`store: "${op.key}" is not JSON`); continue; }
      json = op.value;
    } else { dropped.push('store: unknown operation'); continue; }
    if (bytes(json) > L.valueBytes) { dropped.push(`store: "${op.key}" is over ${L.valueBytes} bytes`); continue; }
    const had = own(kv, op.key);
    if (!had && Object.keys(kv).length >= L.keys) { dropped.push(`store: more than ${L.keys} keys`); continue; }
    const before = had ? kv[op.key] : undefined;
    kv[op.key] = json;
    if (sizeOf(kv) > L.totalBytes) { // undo this one write
      if (had) kv[op.key] = before; else delete kv[op.key];
      dropped.push(`store: over ${L.totalBytes / 1024} KB in total`);
    }
  }
  return { dropped };
}

// ---------- time zones ----------
const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(tz, f);
  }
  return f;
}
function isTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try { formatter(tz); return true; } catch { return false; }
}
function localParts(ms, tz) {
  const p = {};
  for (const x of formatter(tz).formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return p;
}
// how far the zone is ahead of UTC at that moment, in ms
function offsetMs(ms, tz) {
  const p = localParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - (ms - (((ms % 1000) + 1000) % 1000));
}
// The next moment after `now` when the wall clock in `tz` shows HH:MM.
function nextDaily(now, time, tz = 'UTC') {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(time));
  if (!m || !isTimeZone(tz)) return null;
  const H = Number(m[1]), M = Number(m[2]);
  const today = localParts(now, tz);
  for (let shift = 0; shift <= 2; shift++) {
    const wall = Date.UTC(today.year, today.month - 1, today.day + shift, H, M, 0);
    const t = wall - offsetMs(wall - offsetMs(wall, tz), tz);
    if (t > now) return t;
  }
  return null;
}

// ---------- timers ----------
const cleanData = (v) => { // the bot sends JSON text (or nothing); keep it only if it parses and is small
  if (v === undefined || v === null) return { ok: true, data: null };
  if (typeof v !== 'string' || bytes(v) > LIMITS.timerDataBytes) return { ok: false };
  try { JSON.parse(v); } catch { return { ok: false }; }
  return { ok: true, data: v };
};

// Applies timer requests to inst.timers (mutates it). reqs: [{ kind: 'after'|'every'|'daily'|'cancel', name, seconds?, time?, tz?, data? }]
// Asking again for a timer with the same name and the same schedule keeps its next time (so a bot may "make sure" its timer exists on
// every event without ever pushing it back); a different schedule replaces it.
function applyTimers(inst, reqs, now, limits = {}) {
  const L = { ...LIMITS, ...limits };
  const dropped = [];
  const list = inst.timers = Array.isArray(inst.timers) ? inst.timers : [];
  for (const r of Array.isArray(reqs) ? reqs : []) {
    if (!r || typeof r.name !== 'string' || !TIMER_NAME.test(r.name)) { dropped.push('timer: bad name (1 to 32 letters, numbers, _ . : -)'); continue; }
    const i = list.findIndex((t) => t.name === r.name);
    if (r.kind === 'cancel') { if (i >= 0) list.splice(i, 1); continue; }
    const d = cleanData(r.data);
    if (!d.ok) { dropped.push(`timer "${r.name}": data must be JSON under ${L.timerDataBytes} bytes`); continue; }
    let t;
    if (r.kind === 'after' || r.kind === 'every') {
      const sec = Number(r.seconds), min = r.kind === 'after' ? L.minAfterSec : L.minEverySec;
      if (!Number.isFinite(sec) || sec < min || sec > L.maxSec) { dropped.push(`timer "${r.name}": ${r.kind} needs between ${min} seconds and ${L.maxSec / 86400} days`); continue; }
      t = { name: r.name, kind: r.kind, at: now + Math.round(sec * 1000), everySec: r.kind === 'every' ? Math.round(sec) : null, time: null, tz: null, data: d.data, since: now };
    } else if (r.kind === 'daily') {
      const tz = r.tz === undefined || r.tz === null || r.tz === '' ? 'UTC' : r.tz;
      const at = nextDaily(now, r.time, tz);
      if (at === null) { dropped.push(`timer "${r.name}": daily needs "HH:MM" (24 hour) and a time zone like "UTC" or "America/Vancouver"`); continue; }
      t = { name: r.name, kind: 'daily', at, everySec: null, time: String(r.time), tz, data: d.data, since: now };
    } else { dropped.push('timer: unknown kind'); continue; }
    if (i >= 0) {
      const o = list[i];
      if (o.kind === t.kind && o.everySec === t.everySec && o.time === t.time && o.tz === t.tz) { o.data = t.data; continue; } // same schedule: keep its next time
      list[i] = t;
    } else if (list.length >= L.timersPerInstall) { dropped.push(`timer "${r.name}": a bot can have ${L.timersPerInstall} timers in one server`); }
    else list.push(t);
  }
  return { dropped };
}

const dueTimers = (inst, now) => (Array.isArray(inst.timers) ? inst.timers.filter((t) => t.at <= now) : []);

// A due timer is about to run: set its next time (a repeating one skips the runs it missed while the server was off), or drop it (one-shot).
function advance(inst, timer, now) {
  if (timer.kind === 'after') { inst.timers = inst.timers.filter((t) => t !== timer); return; }
  if (timer.kind === 'every') { const step = timer.everySec * 1000; timer.at += step * Math.max(1, Math.ceil((now - timer.at + 1) / step)); return; }
  const next = nextDaily(now, timer.time, timer.tz);
  if (next === null) inst.timers = inst.timers.filter((t) => t !== timer); else timer.at = next;
}

// What the sandbox sees of this install's state at the start of an event.
function snapshotFor(inst) {
  return {
    kv: inst && inst.kv && typeof inst.kv === 'object' ? { ...inst.kv } : {},
    timers: (inst && Array.isArray(inst.timers) ? inst.timers : []).map((t) => ({ name: t.name, kind: t.kind, at: t.at, everySec: t.everySec, time: t.time, tz: t.tz })),
  };
}

// The developer's chat simulator carries the saved data and timers of one test run into the next one. They come from the browser, so
// they are rebuilt field by field under the same limits as real ones; whatever does not fit is simply left out.
// Returns { kv, timers } shaped like an install record (see the top of this file).
function cleanSimState(input, now = Date.now()) {
  const src = input && typeof input === 'object' ? input : {};
  const kv = {}, timers = [];
  if (src.kv && typeof src.kv === 'object' && !Array.isArray(src.kv)) {
    for (const k of Object.keys(src.kv)) {
      if (Object.keys(kv).length >= LIMITS.keys) break;
      const v = src.kv[k];
      if (!validKey(k) || typeof v !== 'string' || bytes(v) > LIMITS.valueBytes) continue;
      try { JSON.parse(v); } catch { continue; }
      kv[k] = v;
      if (sizeOf(kv) > LIMITS.totalBytes) delete kv[k];
    }
  }
  if (Array.isArray(src.timers)) {
    for (const t of src.timers) {
      if (timers.length >= LIMITS.timersPerInstall) break;
      if (!t || typeof t.name !== 'string' || !TIMER_NAME.test(t.name) || !['after', 'every', 'daily'].includes(t.kind)) continue;
      const everySec = t.kind === 'every' && Number.isFinite(Number(t.everySec)) && Number(t.everySec) >= 1 ? Math.round(Number(t.everySec)) : null;
      if (t.kind === 'every' && !everySec) continue;
      const time = t.kind === 'daily' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(t.time)) ? String(t.time) : null;
      if (t.kind === 'daily' && !time) continue;
      const tz = t.kind === 'daily' ? (t.tz && isTimeZone(t.tz) ? String(t.tz) : 'UTC') : null;
      const d = cleanData(typeof t.data === 'string' ? t.data : null);
      timers.push({ name: t.name, kind: t.kind, at: Number.isFinite(Number(t.at)) ? Number(t.at) : now, everySec, time, tz, data: d.ok ? d.data : null, since: now });
    }
  }
  return { kv, timers };
}

module.exports = { LIMITS, validKey, sizeOf, applyStoreOps, applyTimers, dueTimers, advance, snapshotFor, nextDaily, isTimeZone, cleanSimState };
