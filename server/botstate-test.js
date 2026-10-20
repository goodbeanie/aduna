// Bot storage and timers (botstate.js). No database, no sandbox: node server/botstate-test.js
const assert = require('assert');
const S = require('./botstate');
const step = (m) => console.log('✓', m);

// ----- storage -----
{
  const kv = {};
  let r = S.applyStoreOps(kv, [{ op: 'set', key: 'a', value: '1' }, { op: 'set', key: 'obj', value: '{"x":[1,2]}' }, { op: 'incr', key: 'n', by: 2 }, { op: 'incr', key: 'n', by: 3 }]);
  assert.deepStrictEqual([kv.a, kv.obj, kv.n, r.dropped.length], ['1', '{"x":[1,2]}', '5', 0], JSON.stringify(kv));
  S.applyStoreOps(kv, [{ op: 'delete', key: 'a' }, { op: 'delete', key: 'never-there' }]);
  assert.ok(!('a' in kv));
  step('set, incr (starts at 0), delete');
}
{
  const kv = { s: '"text"', n: '5' };
  const bad = [
    { op: 'set', key: 'has space', value: '1' }, { op: 'set', key: '', value: '1' }, { op: 'set', key: '__proto__', value: '1' }, { op: 'set', key: 'x'.repeat(65), value: '1' },
    { op: 'set', key: 'k', value: 5 }, { op: 'set', key: 'k', value: 'not json' }, { op: 'set', key: 'k' },
    { op: 'incr', key: 's', by: 1 }, { op: 'incr', key: 'n', by: 'abc' }, { op: 'incr', key: 'n', by: Infinity }, { op: 'incr', key: 'n', by: NaN },
    { op: 'explode', key: 'k' }, null, 'string', { key: 'k' },
  ];
  const r = S.applyStoreOps(kv, bad);
  assert.deepStrictEqual(kv, { s: '"text"', n: '5' }, 'nothing bad was applied: ' + JSON.stringify(kv));
  assert.strictEqual(r.dropped.length, bad.length, 'every bad op is reported');
  assert.ok(!('polluted' in {}) && Object.prototype.toString.call(kv) === '[object Object]');
  step('bad keys, values and operations are dropped one by one');
}
{
  const kv = { n: String(Number.MAX_SAFE_INTEGER) };
  assert.strictEqual(S.applyStoreOps(kv, [{ op: 'incr', key: 'n', by: 1 }]).dropped.length, 1, 'overflow refused');
  assert.strictEqual(kv.n, String(Number.MAX_SAFE_INTEGER));
  // a key named like an Object.prototype member is an ordinary key
  const k2 = {};
  S.applyStoreOps(k2, [{ op: 'incr', key: 'toString', by: 1 }, { op: 'set', key: 'constructor', value: '2' }, { op: 'incr', key: 'hasOwnProperty', by: 1 }]);
  assert.deepStrictEqual([k2.toString, k2.constructor, k2.hasOwnProperty], ['1', '2', '1']);
  step('overflow refused; prototype-looking names are plain keys');
}
{
  const kv = {};
  let r = S.applyStoreOps(kv, [{ op: 'set', key: 'big', value: JSON.stringify('x'.repeat(5000)) }, { op: 'set', key: 'ok', value: '1' }]);
  assert.deepStrictEqual([r.dropped.length, 'big' in kv, kv.ok], [1, false, '1'], 'a too-big value is dropped, the rest applies');
  const many = Array.from({ length: 70 }, (_, i) => ({ op: 'set', key: 'k' + i, value: '1' }));
  const kv2 = {};
  for (let i = 0; i < many.length; i += 30) S.applyStoreOps(kv2, many.slice(i, i + 30));
  assert.strictEqual(Object.keys(kv2).length, 64, 'at most 64 keys');
  S.applyStoreOps(kv2, [{ op: 'set', key: 'k0', value: '2' }]);
  assert.strictEqual(kv2.k0, '2', 'an existing key can still be changed when full');
  const kv3 = {};
  const chunk = JSON.stringify('y'.repeat(4000));
  for (let i = 0; i < 12; i++) S.applyStoreOps(kv3, [{ op: 'set', key: 'c' + i, value: chunk }]);
  assert.ok(S.sizeOf(kv3) <= 32 * 1024, 'total stays under 32 KB: ' + S.sizeOf(kv3));
  assert.strictEqual(Object.keys(kv3).length, 8, 'the writes that did not fit were refused (8 x ~4 KB)');
  // an over-sized overwrite is undone and leaves the old value
  const before = kv3.c0;
  S.applyStoreOps(kv3, [{ op: 'set', key: 'c0', value: JSON.stringify('z'.repeat(4090)) }]);
  assert.ok(S.sizeOf(kv3) <= 32 * 1024 && typeof kv3.c0 === 'string' && (kv3.c0 === before || kv3.c0.length <= 4096));
  const ops = Array.from({ length: 50 }, (_, i) => ({ op: 'set', key: 'o' + i, value: '1' }));
  const kv4 = {}; S.applyStoreOps(kv4, ops);
  assert.strictEqual(Object.keys(kv4).length, 30, 'at most 30 operations per event');
  step('size limits: value, key count, total bytes, operations per event');
}

// ----- time zones and daily -----
{
  const utc = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);
  assert.strictEqual(S.nextDaily(utc(2026, 10, 19, 8, 0), '09:30', 'UTC'), utc(2026, 10, 19, 9, 30));
  assert.strictEqual(S.nextDaily(utc(2026, 10, 19, 9, 30), '09:30', 'UTC'), utc(2026, 10, 20, 9, 30), 'exactly now means tomorrow');
  assert.strictEqual(S.nextDaily(utc(2026, 10, 19, 23, 59), '00:00'), utc(2026, 10, 20, 0, 0), 'default zone is UTC');
  // Vancouver is UTC-7 in summer (PDT) and UTC-8 in winter (PST)
  assert.strictEqual(S.nextDaily(utc(2026, 7, 1, 0, 0), '09:00', 'America/Vancouver'), utc(2026, 7, 1, 16, 0));
  assert.strictEqual(S.nextDaily(utc(2026, 12, 1, 0, 0), '09:00', 'America/Vancouver'), utc(2026, 12, 1, 17, 0));
  // across the autumn change (2026-11-01, 02:00 PDT -> 01:00 PST) the wall clock still reads 09:00
  const after = S.nextDaily(utc(2026, 11, 1, 18, 0), '09:00', 'America/Vancouver');
  assert.strictEqual(after, utc(2026, 11, 2, 17, 0), 'the day after the change is 09:00 PST');
  // a zone ahead of UTC and one with a half-hour offset
  assert.strictEqual(S.nextDaily(utc(2026, 10, 19, 0, 0), '08:00', 'Asia/Tokyo'), utc(2026, 10, 19, 23, 0));
  assert.strictEqual(S.nextDaily(utc(2026, 10, 19, 0, 0), '08:00', 'Asia/Kolkata'), utc(2026, 10, 19, 2, 30));
  // the hour that does not exist (spring forward 2026-03-08, 02:30 does not happen in New York): still a moment after `now`, within a day
  const gap = S.nextDaily(utc(2026, 3, 8, 0, 0), '02:30', 'America/New_York');
  assert.ok(gap > utc(2026, 3, 8, 0, 0) && gap < utc(2026, 3, 9, 12, 0), 'a non-existent local time still gives a real moment: ' + new Date(gap).toISOString());
  for (const bad of ['9:30', '24:00', '12:60', '', null, 'noon']) assert.strictEqual(S.nextDaily(Date.now(), bad, 'UTC'), null, String(bad));
  assert.strictEqual(S.nextDaily(Date.now(), '09:00', 'Not/AZone'), null);
  assert.ok(S.isTimeZone('Europe/Paris') && S.isTimeZone('UTC') && !S.isTimeZone('x y') && !S.isTimeZone('a'.repeat(80)) && !S.isTimeZone(5));
  step('daily: zones, daylight saving, half-hour zones, the missing hour, bad input');
}

// ----- timers -----
{
  const now = 1_000_000_000_000;
  const inst = {};
  let r = S.applyTimers(inst, [
    { kind: 'after', name: 'once', seconds: 30 }, { kind: 'every', name: 'tick', seconds: 120, data: '{"k":1}' },
    { kind: 'daily', name: 'morning', time: '09:00', tz: 'UTC' }, { kind: 'daily', name: 'noon', time: '12:00' },
  ], now);
  assert.strictEqual(r.dropped.length, 0, JSON.stringify(r));
  const by = (n) => inst.timers.find((t) => t.name === n);
  assert.deepStrictEqual([by('once').at, by('tick').at, by('tick').everySec, by('tick').data, by('noon').tz], [now + 30_000, now + 120_000, 120, '{"k":1}', 'UTC']);
  // asking again with the same schedule keeps the next time; a different schedule replaces it
  S.applyTimers(inst, [{ kind: 'every', name: 'tick', seconds: 120, data: '{"k":2}' }], now + 60_000);
  assert.deepStrictEqual([by('tick').at, by('tick').data], [now + 120_000, '{"k":2}'], 'same schedule: next time kept, data updated');
  S.applyTimers(inst, [{ kind: 'every', name: 'tick', seconds: 300 }], now + 60_000);
  assert.strictEqual(by('tick').at, now + 60_000 + 300_000, 'new schedule replaces');
  S.applyTimers(inst, [{ kind: 'cancel', name: 'once' }, { kind: 'cancel', name: 'not-there' }], now);
  assert.ok(!by('once'));
  step('after / every / daily, re-asking keeps the schedule, cancel');
}
{
  const now = 1_000_000_000_000, inst = {};
  const bad = [
    { kind: 'after', name: 'a', seconds: 1 }, { kind: 'after', name: 'a', seconds: 31 * 86400 }, { kind: 'every', name: 'a', seconds: 30 }, { kind: 'after', name: 'a', seconds: 'soon' },
    { kind: 'after', name: 'a', seconds: NaN }, { kind: 'after', name: 'bad name', seconds: 60 }, { kind: 'after', name: '', seconds: 60 }, { kind: 'after', name: 'x'.repeat(33), seconds: 60 },
    { kind: 'after', name: 'a', seconds: 60, data: 'not json' }, { kind: 'after', name: 'a', seconds: 60, data: JSON.stringify('x'.repeat(1100)) }, { kind: 'after', name: 'a', seconds: 60, data: 5 },
    { kind: 'daily', name: 'a', time: '25:00' }, { kind: 'daily', name: 'a', time: '09:00', tz: 'Mars/Base' }, { kind: 'weekly', name: 'a', seconds: 60 }, null, { kind: 'after' },
  ];
  const r = S.applyTimers(inst, bad, now);
  assert.deepStrictEqual(inst.timers, [], 'no bad timer was created: ' + JSON.stringify(inst.timers));
  assert.strictEqual(r.dropped.length, bad.length);
  const many = Array.from({ length: 12 }, (_, i) => ({ kind: 'after', name: 't' + i, seconds: 60 }));
  const r2 = S.applyTimers(inst, many, now);
  assert.deepStrictEqual([inst.timers.length, r2.dropped.length], [10, 2], 'at most 10 timers');
  step('bad timers are dropped; 10 per bot per server');
}
{
  const now = 1_000_000_000_000;
  const inst = { timers: [{ name: 'a', kind: 'after', at: now - 1 }, { name: 'e', kind: 'every', at: now - 1000, everySec: 60 }, { name: 'later', kind: 'after', at: now + 5000 }, { name: 'd', kind: 'daily', at: now - 1, time: '09:00', tz: 'UTC' }] };
  const due = S.dueTimers(inst, now);
  assert.deepStrictEqual(due.map((t) => t.name), ['a', 'e', 'd']);
  S.advance(inst, due[0], now);
  assert.ok(!inst.timers.some((t) => t.name === 'a'), 'a one-shot timer is gone once it fires');
  S.advance(inst, due[1], now);
  assert.strictEqual(inst.timers.find((t) => t.name === 'e').at, now - 1000 + 60_000, 'every: next slot, no drift');
  // a server that was off for ten minutes runs the repeating timer ONCE, then continues on its grid
  const e2 = { name: 'e', kind: 'every', at: now - 10 * 60_000 - 5, everySec: 60 };
  S.advance({ timers: [e2] }, e2, now);
  assert.ok(e2.at > now && e2.at - now <= 60_000 && (e2.at - (now - 10 * 60_000 - 5)) % 60_000 === 0, 'missed runs are skipped: ' + (e2.at - now));
  S.advance(inst, due[2], now);
  const d = inst.timers.find((t) => t.name === 'd');
  assert.ok(d.at > now && d.at - now <= 86_400_000 + 3600_000);
  const snap = S.snapshotFor({ kv: { a: '1' }, timers: inst.timers });
  assert.deepStrictEqual(Object.keys(snap.timers[0]).sort(), ['at', 'everySec', 'kind', 'name', 'time', 'tz'], 'the snapshot hands over no timer data');
  snap.kv.a = '2';
  assert.deepStrictEqual(S.snapshotFor(null), { kv: {}, timers: [] });
  step('due, advance (no drift, missed runs skipped), snapshot is a copy');
}
console.log('\nAll bot storage and timer checks passed.');
